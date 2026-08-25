import { execSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { deleteAllPosts } from './bsky.js';
import {
  ADMIN_USER_PERMISSIONS,
  type AccountMapping,
  type AppConfig,
  type UserPermissions,
  type UserRole,
  type WebUser,
  getConfig,
  getDefaultUserPermissions,
  saveConfig,
} from './config-manager.js';
import { accountHealthService, dbService, postQueueService } from './db.js';
import type { ProcessedTweet } from './db.js';
import type { LogExportFormat, LogLevel, LogQueryFilters, LogStage } from './event-log.js';
import { eventLogService, exportLogs, logEvent } from './event-log.js';
import {
  applyProfileMirrorSyncState,
  bridgeBlueskyAccountToFediverse,
  ensureBlueskyBotSelfLabel,
  ensureBlueskyDisplayNameBotSuffix,
  fetchTwitterMirrorProfile,
  syncBlueskyProfileFromTwitter,
  validateBlueskyCredentials,
} from './profile-mirror.js';
import { JWT_SECRET_FILE_PATH, UPDATE_LOG_DIR } from './storage-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = (process.env.HOST || process.env.BIND_HOST || '0.0.0.0').trim() || '0.0.0.0';
const APP_ROOT_DIR = path.join(__dirname, '..');
const jwtSecretFromEnv = process.env.JWT_SECRET?.trim();
const JWT_EXPIRES_IN = ((process.env.JWT_EXPIRES_IN || '30d').trim() || '30d') as SignOptions['expiresIn'];
const WEB_DIST_DIR = path.join(APP_ROOT_DIR, 'web', 'dist');
const LEGACY_PUBLIC_DIR = path.join(APP_ROOT_DIR, 'public');
const PACKAGE_JSON_PATH = path.join(APP_ROOT_DIR, 'package.json');
const UPDATE_SCRIPT_PATH = path.join(APP_ROOT_DIR, 'update.sh');
const staticAssetsDir = fs.existsSync(path.join(WEB_DIST_DIR, 'index.html')) ? WEB_DIST_DIR : LEGACY_PUBLIC_DIR;
const BSKY_APPVIEW_URL = process.env.BSKY_APPVIEW_URL || 'https://public.api.bsky.app';
const POST_VIEW_CACHE_TTL_MS = 60_000;
const PROFILE_CACHE_TTL_MS = 5 * 60_000;
const RESERVED_UNGROUPED_KEY = 'ungrouped';
const SERVER_STARTED_AT = Date.now();
const PASSWORD_MIN_LENGTH = 8;
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_MAX_ATTEMPTS = 30;
const APPVIEW_POST_CHUNK_SIZE = 10;
const APPVIEW_PROFILE_CHUNK_SIZE = 25;
const APPVIEW_MAX_ATTEMPTS = 2;
const APPVIEW_RETRY_DELAY_MS = 700;
const FEDIVERSE_BRIDGE_STATUS_CHUNK_SIZE = 2;
const FEDIVERSE_BRIDGE_STATUS_CACHE_TTL_MS = 10 * 60_000;
const FEDIVERSE_BRIDGE_HANDLES = ['ap.brid.gy', 'bsky.brid.gy'];

function loadPersistedJwtSecret(): string | undefined {
  if (!fs.existsSync(JWT_SECRET_FILE_PATH)) {
    return undefined;
  }

  try {
    const secret = fs.readFileSync(JWT_SECRET_FILE_PATH, 'utf8').trim();
    if (secret.length >= 32) {
      return secret;
    }
    console.warn(`⚠️ Ignoring weak JWT secret in ${JWT_SECRET_FILE_PATH}. Regenerating.`);
    return undefined;
  } catch (error) {
    console.warn(
      `⚠️ Failed reading JWT secret file at ${JWT_SECRET_FILE_PATH}: ${(error as Error).message}. Regenerating.`,
    );
    return undefined;
  }
}

function persistJwtSecret(secret: string): void {
  fs.mkdirSync(path.dirname(JWT_SECRET_FILE_PATH), { recursive: true });
  fs.writeFileSync(JWT_SECRET_FILE_PATH, `${secret}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(JWT_SECRET_FILE_PATH, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

function resolveJwtSecret(): string {
  if (jwtSecretFromEnv) {
    if (jwtSecretFromEnv.length < 32) {
      console.warn('⚠️ JWT_SECRET is shorter than 32 characters. Use a longer value for stronger signing security.');
    }
    return jwtSecretFromEnv;
  }

  const persisted = loadPersistedJwtSecret();
  if (persisted) {
    return persisted;
  }

  const generated = randomBytes(48).toString('hex');
  persistJwtSecret(generated);
  console.warn(
    `⚠️ JWT_SECRET not set. Generated persistent signing secret at ${JWT_SECRET_FILE_PATH}. Keep this file private.`,
  );
  return generated;
}

const JWT_SECRET = resolveJwtSecret();

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface BskyProfileView {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
  description?: string;
  createdAt?: string;
}

interface FediverseBridgeStatusView {
  bridged: boolean;
  checkedAt: string;
  error?: string;
}

interface EnrichedPostMedia {
  type: 'image' | 'video' | 'external';
  url?: string;
  thumb?: string;
  alt?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
}

interface EnrichedPost {
  bskyUri: string;
  bskyCid?: string;
  bskyIdentifier: string;
  twitterId: string;
  twitterUsername: string;
  twitterUrl?: string;
  postUrl?: string;
  createdAt?: string;
  text: string;
  facets: unknown[];
  author: {
    did?: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  stats: {
    likes: number;
    reposts: number;
    replies: number;
    quotes: number;
    engagement: number;
  };
  media: EnrichedPostMedia[];
}

interface LocalPostSearchResult {
  twitterId: string;
  twitterUsername: string;
  bskyIdentifier: string;
  tweetText?: string;
  bskyUri?: string;
  bskyCid?: string;
  createdAt?: string;
  postUrl?: string;
  twitterUrl?: string;
  score: number;
}

interface RuntimeVersionInfo {
  version: string;
  commit?: string;
  branch?: string;
  startedAt: number;
}

interface UpdateJobState {
  running: boolean;
  pid?: number;
  startedAt?: number;
  startedBy?: string;
  finishedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logFile?: string;
}

interface UpdateStatusPayload {
  running: boolean;
  pid?: number;
  startedAt?: number;
  startedBy?: string;
  finishedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  logFile?: string;
  logTail: string[];
}

const postViewCache = new Map<string, CacheEntry<any>>();
const profileCache = new Map<string, CacheEntry<BskyProfileView>>();
const fediverseBridgeStatusCache = new Map<string, CacheEntry<FediverseBridgeStatusView>>();
let fediverseBridgeActorIdsCache: CacheEntry<Set<string>> | null = null;

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function nowMs() {
  return Date.now();
}

const parseAllowedOrigins = (): Set<string> => {
  const raw = process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGIN || '';
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(origins);
};

const allowedOrigins = parseAllowedOrigins();

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const authRateBuckets = new Map<string, RateLimitBucket>();

// Only honor X-Forwarded-For when explicitly running behind a trusted reverse
// proxy; otherwise clients could spoof the header to bypass auth rate limiting.
const TRUST_PROXY = ['1', 'true', 'yes'].includes((process.env.TRUST_PROXY || '').trim().toLowerCase());

const getRequestIp = (req: any): string => {
  if (TRUST_PROXY) {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
      const [first] = forwarded.split(',');
      if (first && first.trim().length > 0) {
        return first.trim();
      }
    }
  }
  if (typeof req.ip === 'string' && req.ip.length > 0) {
    return req.ip;
  }
  if (typeof req.socket?.remoteAddress === 'string' && req.socket.remoteAddress.length > 0) {
    return req.socket.remoteAddress;
  }
  return 'unknown';
};

const authRateLimiter = (req: any, res: any, next: any) => {
  const now = nowMs();
  if (authRateBuckets.size > 5000) {
    for (const [bucketKey, bucketValue] of authRateBuckets.entries()) {
      if (bucketValue.resetAt <= now) {
        authRateBuckets.delete(bucketKey);
      }
    }
  }

  const ip = getRequestIp(req);
  const key = `auth:${ip}`;
  const bucket = authRateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    authRateBuckets.set(key, {
      count: 1,
      resetAt: now + AUTH_RATE_WINDOW_MS,
    });
    next();
    return;
  }

  if (bucket.count >= AUTH_RATE_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      error: `Too many authentication attempts. Try again in about ${retryAfterSeconds} seconds.`,
    });
    return;
  }

  bucket.count += 1;
  authRateBuckets.set(key, bucket);
  next();
};

function buildPostUrl(identifier: string, uri?: string): string | undefined {
  if (!uri) return undefined;
  const rkey = uri.split('/').filter(Boolean).pop();
  if (!rkey) return undefined;
  return `https://bsky.app/profile/${identifier}/post/${rkey}`;
}

function buildTwitterPostUrl(username: string, twitterId: string): string | undefined {
  if (!username || !twitterId) return undefined;
  return `https://x.com/${normalizeActor(username)}/status/${twitterId}`;
}

function normalizeActor(actor: string): string {
  return actor.trim().replace(/^@/, '').toLowerCase();
}

function normalizeGroupName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeGroupEmoji(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getNormalizedGroupKey(value: unknown): string {
  return normalizeGroupName(value).toLowerCase();
}

function ensureGroupExists(config: AppConfig, name?: string, emoji?: string) {
  const normalizedName = normalizeGroupName(name);
  if (!normalizedName || getNormalizedGroupKey(normalizedName) === RESERVED_UNGROUPED_KEY) return;

  if (!Array.isArray(config.groups)) {
    config.groups = [];
  }

  const existingIndex = config.groups.findIndex(
    (group) => getNormalizedGroupKey(group.name) === getNormalizedGroupKey(normalizedName),
  );
  const normalizedEmoji = normalizeGroupEmoji(emoji);

  if (existingIndex === -1) {
    config.groups.push({
      name: normalizedName,
      ...(normalizedEmoji ? { emoji: normalizedEmoji } : {}),
    });
    return;
  }

  if (normalizedEmoji) {
    const existingGroupName = normalizeGroupName(config.groups[existingIndex]?.name) || normalizedName;
    config.groups[existingIndex] = {
      name: existingGroupName,
      emoji: normalizedEmoji,
    };
  }
}

function safeExec(command: string, cwd = APP_ROOT_DIR): string | undefined {
  try {
    return execSync(command, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

function getRuntimeVersionInfo(): RuntimeVersionInfo {
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.trim().length > 0) {
      version = pkg.version.trim();
    }
  } catch {
    // Ignore parse/read failures and keep fallback.
  }

  return {
    version,
    commit: safeExec('git rev-parse --short HEAD'),
    branch: safeExec('git rev-parse --abbrev-ref HEAD'),
    startedAt: SERVER_STARTED_AT,
  };
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLogTail(logFile?: string, maxLines = 30): string[] {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function extractMediaFromEmbed(embed: any): EnrichedPostMedia[] {
  if (!embed || typeof embed !== 'object') {
    return [];
  }

  const type = embed.$type;
  if (type === 'app.bsky.embed.images#view') {
    const images = Array.isArray(embed.images) ? embed.images : [];
    return images.map((image: any) => ({
      type: 'image' as const,
      url: typeof image.fullsize === 'string' ? image.fullsize : undefined,
      thumb: typeof image.thumb === 'string' ? image.thumb : undefined,
      alt: typeof image.alt === 'string' ? image.alt : undefined,
      width: typeof image.aspectRatio?.width === 'number' ? image.aspectRatio.width : undefined,
      height: typeof image.aspectRatio?.height === 'number' ? image.aspectRatio.height : undefined,
    }));
  }

  if (type === 'app.bsky.embed.video#view') {
    return [
      {
        type: 'video',
        url: typeof embed.playlist === 'string' ? embed.playlist : undefined,
        thumb: typeof embed.thumbnail === 'string' ? embed.thumbnail : undefined,
        alt: typeof embed.alt === 'string' ? embed.alt : undefined,
        width: typeof embed.aspectRatio?.width === 'number' ? embed.aspectRatio.width : undefined,
        height: typeof embed.aspectRatio?.height === 'number' ? embed.aspectRatio.height : undefined,
      },
    ];
  }

  if (type === 'app.bsky.embed.external#view') {
    const external = embed.external || {};
    return [
      {
        type: 'external',
        url: typeof external.uri === 'string' ? external.uri : undefined,
        thumb: typeof external.thumb === 'string' ? external.thumb : undefined,
        title: typeof external.title === 'string' ? external.title : undefined,
        description: typeof external.description === 'string' ? external.description : undefined,
      },
    ];
  }

  if (type === 'app.bsky.embed.recordWithMedia#view') {
    return extractMediaFromEmbed(embed.media);
  }

  return [];
}

const RETRYABLE_APPVIEW_CODES = new Set(['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']);

function describeAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const details = [error.message];
    const status = error.response?.status;
    const code = error.code;
    const causeCode =
      typeof (error as { cause?: { code?: unknown } }).cause?.code === 'string'
        ? (error as { cause?: { code?: string } }).cause?.code
        : undefined;

    if (typeof status === 'number') {
      details.push(`status=${status}`);
    }
    if (typeof code === 'string') {
      details.push(`code=${code}`);
    }
    if (typeof causeCode === 'string' && causeCode !== code) {
      details.push(`cause=${causeCode}`);
    }
    return details.join(', ');
  }

  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRetryableAppviewError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;
  if (typeof status === 'number' && (status >= 500 || status === 429)) {
    return true;
  }

  const code = error.code;
  if (typeof code === 'string' && RETRYABLE_APPVIEW_CODES.has(code)) {
    return true;
  }

  const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
  if (typeof causeCode === 'string' && RETRYABLE_APPVIEW_CODES.has(causeCode)) {
    return true;
  }

  return false;
}

const sleep = (durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs));

async function fetchAppview(pathname: string, params: URLSearchParams, context: string): Promise<any | null> {
  const url = `${BSKY_APPVIEW_URL}${pathname}?${params.toString()}`;
  for (let attempt = 1; attempt <= APPVIEW_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios.get(url, { timeout: 12_000 });
      return response.data;
    } catch (error) {
      const retryable = isRetryableAppviewError(error);
      const canRetry = retryable && attempt < APPVIEW_MAX_ATTEMPTS;
      console.warn(
        `[AppView] ${context} failed (attempt ${attempt}/${APPVIEW_MAX_ATTEMPTS}): ${describeAxiosError(error)}${canRetry ? '. Retrying...' : ''}`,
      );
      if (!canRetry) {
        return null;
      }
      await sleep(APPVIEW_RETRY_DELAY_MS * attempt);
    }
  }
  return null;
}

async function fetchPostViewsByUri(uris: string[]): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  const uniqueUris = [...new Set(uris.filter((uri) => typeof uri === 'string' && uri.length > 0))];
  const pendingUris: string[] = [];

  for (const uri of uniqueUris) {
    const cached = postViewCache.get(uri);
    if (cached && cached.expiresAt > nowMs()) {
      result.set(uri, cached.value);
      continue;
    }
    pendingUris.push(uri);
  }

  for (const chunk of chunkArray(pendingUris, APPVIEW_POST_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const params = new URLSearchParams();
    for (const uri of chunk) params.append('uris', uri);

    const responseData = await fetchAppview('/xrpc/app.bsky.feed.getPosts', params, `getPosts chunk=${chunk.length}`);
    if (!responseData) {
      continue;
    }

    const posts = Array.isArray(responseData.posts) ? responseData.posts : [];
    for (const post of posts) {
      const uri = typeof post?.uri === 'string' ? post.uri : undefined;
      if (!uri) continue;
      postViewCache.set(uri, {
        value: post,
        expiresAt: nowMs() + POST_VIEW_CACHE_TTL_MS,
      });
      result.set(uri, post);
    }
  }

  return result;
}

async function fetchProfilesByActor(actors: string[]): Promise<Record<string, BskyProfileView>> {
  const uniqueActors = [...new Set(actors.map(normalizeActor).filter((actor) => actor.length > 0))];
  const result: Record<string, BskyProfileView> = {};
  const pendingActors: string[] = [];

  for (const actor of uniqueActors) {
    const cached = profileCache.get(actor);
    if (cached && cached.expiresAt > nowMs()) {
      result[actor] = cached.value;
      continue;
    }
    pendingActors.push(actor);
  }

  for (const chunk of chunkArray(pendingActors, APPVIEW_PROFILE_CHUNK_SIZE)) {
    if (chunk.length === 0) continue;
    const params = new URLSearchParams();
    for (const actor of chunk) params.append('actors', actor);

    const responseData = await fetchAppview(
      '/xrpc/app.bsky.actor.getProfiles',
      params,
      `getProfiles chunk=${chunk.length}`,
    );
    if (!responseData) {
      continue;
    }

    const profiles = Array.isArray(responseData.profiles) ? responseData.profiles : [];
    for (const profile of profiles) {
      const view: BskyProfileView = {
        did: typeof profile?.did === 'string' ? profile.did : undefined,
        handle: typeof profile?.handle === 'string' ? profile.handle : undefined,
        displayName: typeof profile?.displayName === 'string' ? profile.displayName : undefined,
        avatar: typeof profile?.avatar === 'string' ? profile.avatar : undefined,
        description: typeof profile?.description === 'string' ? profile.description : undefined,
        createdAt: typeof profile?.createdAt === 'string' ? profile.createdAt : undefined,
      };

      const keys = [
        typeof view.handle === 'string' ? normalizeActor(view.handle) : '',
        typeof view.did === 'string' ? normalizeActor(view.did) : '',
      ].filter((key) => key.length > 0);

      for (const key of keys) {
        profileCache.set(key, { value: view, expiresAt: nowMs() + PROFILE_CACHE_TTL_MS });
        result[key] = view;
      }
    }
  }

  for (const actor of uniqueActors) {
    const cached = profileCache.get(actor);
    if (cached && cached.expiresAt > nowMs()) {
      result[actor] = cached.value;
    }
  }

  return result;
}

async function getFediverseBridgeActorIds(): Promise<Set<string>> {
  const cached = fediverseBridgeActorIdsCache;
  if (cached && cached.expiresAt > nowMs()) {
    return new Set(cached.value);
  }

  const ids = new Set<string>(FEDIVERSE_BRIDGE_HANDLES.map((handle) => normalizeActor(handle)));
  const profiles = await fetchProfilesByActor(FEDIVERSE_BRIDGE_HANDLES);
  for (const profile of Object.values(profiles)) {
    if (typeof profile?.handle === 'string' && profile.handle.length > 0) {
      ids.add(normalizeActor(profile.handle));
    }
    if (typeof profile?.did === 'string' && profile.did.length > 0) {
      ids.add(normalizeActor(profile.did));
    }
  }

  fediverseBridgeActorIdsCache = {
    value: ids,
    expiresAt: nowMs() + PROFILE_CACHE_TTL_MS,
  };

  return new Set(ids);
}

async function isActorFollowingFediverseBridge(actor: string): Promise<FediverseBridgeStatusView> {
  const normalizedActor = normalizeActor(actor);
  const checkedAt = new Date().toISOString();
  if (!normalizedActor) {
    return {
      bridged: false,
      checkedAt,
      error: 'Missing actor identifier.',
    };
  }

  const bridgeActorIds = await getFediverseBridgeActorIds();
  let cursor: string | undefined;
  let pageCount = 0;

  while (pageCount < 200) {
    pageCount += 1;
    const params = new URLSearchParams();
    params.set('actor', normalizedActor);
    params.set('limit', '100');
    if (cursor) {
      params.set('cursor', cursor);
    }

    const responseData = await fetchAppview(
      '/xrpc/app.bsky.graph.getFollows',
      params,
      `getFollows actor=${normalizedActor}`,
    );
    if (!responseData) {
      return {
        bridged: false,
        checkedAt,
        error: 'Failed to read follows from Bluesky AppView.',
      };
    }

    const follows = Array.isArray(responseData.follows) ? responseData.follows : [];
    for (const follow of follows) {
      const followedHandle = typeof follow?.handle === 'string' ? normalizeActor(follow.handle) : '';
      const followedDid = typeof follow?.did === 'string' ? normalizeActor(follow.did) : '';
      if ((followedHandle && bridgeActorIds.has(followedHandle)) || (followedDid && bridgeActorIds.has(followedDid))) {
        return {
          bridged: true,
          checkedAt,
        };
      }
    }

    cursor =
      typeof responseData.cursor === 'string' && responseData.cursor.length > 0 ? responseData.cursor : undefined;
    if (!cursor) {
      break;
    }
  }

  return {
    bridged: false,
    checkedAt,
  };
}

async function fetchFediverseBridgeStatusesByActor(
  actors: string[],
): Promise<Record<string, FediverseBridgeStatusView>> {
  const uniqueActors = [...new Set(actors.map(normalizeActor).filter((actor) => actor.length > 0))];
  const result: Record<string, FediverseBridgeStatusView> = {};
  const pendingActors: string[] = [];

  for (const actor of uniqueActors) {
    const cached = fediverseBridgeStatusCache.get(actor);
    if (cached && cached.expiresAt > nowMs()) {
      result[actor] = cached.value;
      continue;
    }
    pendingActors.push(actor);
  }

  for (const chunk of chunkArray(pendingActors, FEDIVERSE_BRIDGE_STATUS_CHUNK_SIZE)) {
    if (chunk.length === 0) {
      continue;
    }

    const chunkResults = await Promise.all(
      chunk.map(async (actor) => {
        try {
          const status = await isActorFollowingFediverseBridge(actor);
          return { actor, status };
        } catch (error) {
          return {
            actor,
            status: {
              bridged: false,
              checkedAt: new Date().toISOString(),
              error: getErrorMessage(error, 'Failed to check fediverse bridge status.'),
            } satisfies FediverseBridgeStatusView,
          };
        }
      }),
    );

    for (const item of chunkResults) {
      fediverseBridgeStatusCache.set(item.actor, {
        value: item.status,
        expiresAt: nowMs() + FEDIVERSE_BRIDGE_STATUS_CACHE_TTL_MS,
      });
      result[item.actor] = item.status;
    }
  }

  return result;
}

function buildEnrichedPost(activity: ProcessedTweet, postView: any): EnrichedPost {
  const record = postView?.record || {};
  const author = postView?.author || {};
  const likes = Number(postView?.likeCount) || 0;
  const reposts = Number(postView?.repostCount) || 0;
  const replies = Number(postView?.replyCount) || 0;
  const quotes = Number(postView?.quoteCount) || 0;

  const identifier =
    (typeof activity.bsky_identifier === 'string' && activity.bsky_identifier.length > 0
      ? activity.bsky_identifier
      : typeof author.handle === 'string'
        ? author.handle
        : 'unknown') || 'unknown';

  return {
    bskyUri: activity.bsky_uri || '',
    bskyCid: typeof postView?.cid === 'string' ? postView.cid : activity.bsky_cid,
    bskyIdentifier: identifier,
    twitterId: activity.twitter_id,
    twitterUsername: activity.twitter_username,
    twitterUrl: buildTwitterPostUrl(activity.twitter_username, activity.twitter_id),
    postUrl: buildPostUrl(identifier, activity.bsky_uri),
    createdAt:
      (typeof record.createdAt === 'string' ? record.createdAt : undefined) ||
      activity.created_at ||
      (typeof postView?.indexedAt === 'string' ? postView.indexedAt : undefined),
    text:
      (typeof record.text === 'string' ? record.text : undefined) ||
      activity.tweet_text ||
      `Tweet ID: ${activity.twitter_id}`,
    facets: Array.isArray(record.facets) ? record.facets : [],
    author: {
      did: typeof author.did === 'string' ? author.did : undefined,
      handle: typeof author.handle === 'string' && author.handle.length > 0 ? author.handle : activity.bsky_identifier,
      displayName: typeof author.displayName === 'string' ? author.displayName : undefined,
      avatar: typeof author.avatar === 'string' ? author.avatar : undefined,
    },
    stats: {
      likes,
      reposts,
      replies,
      quotes,
      engagement: likes + reposts + replies + quotes,
    },
    media: extractMediaFromEmbed(postView?.embed),
  };
}

// In-memory state for triggers and scheduling
let lastCheckTime = Date.now();
let nextCheckTime = Date.now() + (getConfig().checkIntervalMinutes || 5) * 60 * 1000;
export interface PendingBackfill {
  id: string;
  limit?: number;
  queuedAt: number;
  sequence: number;
  requestId: string;
}
let pendingBackfills: PendingBackfill[] = [];
let backfillSequence = 0;
let schedulerWakeSignal = 0; // Monotonic counter to wake scheduler loop immediately.

// Multiple subbranches work in parallel, so a single global status message
// gets clobbered constantly. Each unit of work registers its own job here and
// the dashboard renders the full list.
export type ActiveJobKind = 'checking' | 'mirroring' | 'backfilling' | 'profile-sync' | 'pin-sync';

export interface ActiveJob {
  id: string;
  kind: ActiveJobKind;
  account?: string;
  target?: string;
  mappingId?: string;
  message?: string;
  processedCount?: number;
  totalCount?: number;
  startedAt: number;
  updatedAt: number;
}

const activeJobs = new Map<string, ActiveJob>();
const JOB_STALE_MS = 30 * 60 * 1000;

export function updateJob(id: string, patch: Partial<Omit<ActiveJob, 'id' | 'startedAt' | 'updatedAt'>> | null): void {
  if (patch === null) {
    activeJobs.delete(id);
    return;
  }
  const existing = activeJobs.get(id);
  activeJobs.set(id, {
    kind: 'checking',
    ...existing,
    ...patch,
    id,
    startedAt: existing?.startedAt ?? Date.now(),
    updatedAt: Date.now(),
  });
}

function getActiveJobsSnapshot(): ActiveJob[] {
  const now = Date.now();
  for (const [id, job] of activeJobs) {
    // A crashed/abandoned task should not leave a ghost job on the dashboard.
    if (now - job.updatedAt > JOB_STALE_MS) activeJobs.delete(id);
  }
  return [...activeJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export interface PendingPinSync {
  id: string;
  queuedAt: number;
  requestId: string;
}
let pendingPinSyncs: PendingPinSync[] = [];

export const getPendingPinSyncs = (): PendingPinSync[] => [...pendingPinSyncs];

export const clearPinSync = (id: string): void => {
  pendingPinSyncs = pendingPinSyncs.filter((entry) => entry.id !== id);
};

interface AppStatus {
  state: 'idle' | 'checking' | 'backfilling' | 'pacing' | 'processing';
  currentAccount?: string;
  processedCount?: number;
  totalCount?: number;
  message?: string;
  backfillMappingId?: string;
  backfillRequestId?: string;
  lastUpdate: number;
}

let currentAppStatus: AppStatus = {
  state: 'idle',
  lastUpdate: Date.now(),
};

let updateJobState: UpdateJobState = {
  running: false,
};

function signalSchedulerWake(): void {
  schedulerWakeSignal += 1;
}

function requestImmediateSchedulerPass(): void {
  lastCheckTime = 0;
  nextCheckTime = Date.now() + 250;
  signalSchedulerWake();
}

if (allowedOrigins.size === 0) {
  app.use(cors());
} else {
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        callback(null, allowedOrigins.has(origin));
      },
    }),
  );
}
// Config imports with many mappings can exceed the 100kb express default.
app.use(express.json({ limit: '2mb' }));

app.use(
  express.static(staticAssetsDir, {
    index: false,
  }),
);

interface AuthenticatedUser {
  id: string;
  username?: string;
  email?: string;
  isAdmin: boolean;
  permissions: UserPermissions;
}

interface MappingResponse extends Omit<AccountMapping, 'bskyPassword'> {
  createdByLabel?: string;
  createdByUser?: {
    id: string;
    username?: string;
    email?: string;
    role: UserRole;
  };
}

interface UserSummaryResponse {
  id: string;
  username?: string;
  email?: string;
  role: UserRole;
  isAdmin: boolean;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
  mappingCount: number;
  activeMappingCount: number;
  mappings: MappingResponse[];
}

const normalizeEmail = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeUsername = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().replace(/^@/, '').toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const getErrorMessage = (error: unknown, fallback = 'Request failed.'): string => {
  if (axios.isAxiosError(error)) {
    const apiError = error.response?.data as { error?: unknown } | undefined;
    if (typeof apiError?.error === 'string' && apiError.error.length > 0) {
      return apiError.error;
    }
    if (typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return fallback;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
};

const EMAIL_LIKE_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i;

const getUserPublicLabel = (user: Pick<WebUser, 'id' | 'username'>): string =>
  user.username || `user-${user.id.slice(0, 8)}`;

const getUserDisplayLabel = (user: Pick<WebUser, 'id' | 'username' | 'email'>): string =>
  user.username || user.email || `user-${user.id.slice(0, 8)}`;

const getActorLabel = (actor: AuthenticatedUser): string =>
  actor.username || actor.email || `user-${actor.id.slice(0, 8)}`;

const getActorPublicLabel = (actor: AuthenticatedUser): string => actor.username || `user-${actor.id.slice(0, 8)}`;

const sanitizeLabelForRequester = (label: string | undefined, requester: AuthenticatedUser): string | undefined => {
  if (!label) {
    return undefined;
  }
  if (requester.isAdmin) {
    return label;
  }
  return EMAIL_LIKE_PATTERN.test(label) ? 'private-user' : label;
};

const createUserLookupById = (config: AppConfig): Map<string, WebUser> =>
  new Map(config.users.map((user) => [user.id, user]));

const toAuthenticatedUser = (user: WebUser): AuthenticatedUser => ({
  id: user.id,
  username: user.username,
  email: user.email,
  isAdmin: user.role === 'admin',
  permissions:
    user.role === 'admin'
      ? { ...ADMIN_USER_PERMISSIONS }
      : {
          ...getDefaultUserPermissions('user'),
          ...user.permissions,
        },
});

const serializeAuthenticatedUser = (user: AuthenticatedUser) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  isAdmin: user.isAdmin,
  permissions: user.permissions,
});

const issueTokenForUser = (user: WebUser): string =>
  jwt.sign(
    {
      userId: user.id,
      email: user.email,
      username: user.username,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );

const findUserByIdentifier = (config: AppConfig, identifier: string): WebUser | undefined => {
  const normalizedEmail = normalizeEmail(identifier);
  if (normalizedEmail) {
    const foundByEmail = config.users.find((user) => normalizeEmail(user.email) === normalizedEmail);
    if (foundByEmail) {
      return foundByEmail;
    }
  }

  const normalizedUsername = normalizeUsername(identifier);
  if (!normalizedUsername) {
    return undefined;
  }
  return config.users.find((user) => normalizeUsername(user.username) === normalizedUsername);
};

const findUserFromTokenPayload = (config: AppConfig, payload: Record<string, unknown>): WebUser | undefined => {
  const tokenUserId = normalizeOptionalString(payload.userId) ?? normalizeOptionalString(payload.id);
  if (tokenUserId) {
    const byId = config.users.find((user) => user.id === tokenUserId);
    if (byId) {
      return byId;
    }
  }

  const tokenEmail = normalizeEmail(payload.email);
  if (tokenEmail) {
    const byEmail = config.users.find((user) => normalizeEmail(user.email) === tokenEmail);
    if (byEmail) {
      return byEmail;
    }
  }

  const tokenUsername = normalizeUsername(payload.username);
  if (tokenUsername) {
    const byUsername = config.users.find((user) => normalizeUsername(user.username) === tokenUsername);
    if (byUsername) {
      return byUsername;
    }
  }

  return undefined;
};

const isActorAdmin = (user: AuthenticatedUser): boolean => user.isAdmin;

const canViewAllMappings = (user: AuthenticatedUser): boolean =>
  isActorAdmin(user) || user.permissions.viewAllMappings || user.permissions.manageAllMappings;

const canManageAllMappings = (user: AuthenticatedUser): boolean =>
  isActorAdmin(user) || user.permissions.manageAllMappings;

const canManageOwnMappings = (user: AuthenticatedUser): boolean =>
  isActorAdmin(user) || user.permissions.manageOwnMappings;

const canManageGroups = (user: AuthenticatedUser): boolean => isActorAdmin(user) || user.permissions.manageGroups;

const canQueueBackfills = (user: AuthenticatedUser): boolean => isActorAdmin(user) || user.permissions.queueBackfills;

const canRunNow = (user: AuthenticatedUser): boolean => isActorAdmin(user) || user.permissions.runNow;

const canManageMapping = (user: AuthenticatedUser, mapping: AccountMapping): boolean => {
  if (canManageAllMappings(user)) {
    return true;
  }
  if (!canManageOwnMappings(user)) {
    return false;
  }
  return mapping.createdByUserId === user.id;
};

const getVisibleMappings = (config: AppConfig, user: AuthenticatedUser): AccountMapping[] => {
  if (canViewAllMappings(user)) {
    return config.mappings;
  }

  return config.mappings.filter((mapping) => mapping.createdByUserId === user.id);
};

const getVisibleMappingIdSet = (config: AppConfig, user: AuthenticatedUser): Set<string> =>
  new Set(getVisibleMappings(config, user).map((mapping) => mapping.id));

const getVisibleMappingIdentitySets = (config: AppConfig, user: AuthenticatedUser) => {
  const visible = getVisibleMappings(config, user);
  const twitterUsernames = new Set<string>();
  const bskyIdentifiers = new Set<string>();

  for (const mapping of visible) {
    for (const username of mapping.twitterUsernames) {
      twitterUsernames.add(normalizeActor(username));
    }
    bskyIdentifiers.add(normalizeActor(mapping.bskyIdentifier));
  }

  return {
    twitterUsernames,
    bskyIdentifiers,
  };
};

const sanitizeMapping = (
  mapping: AccountMapping,
  usersById: Map<string, WebUser>,
  requester: AuthenticatedUser,
): MappingResponse => {
  const { bskyPassword: _password, ...rest } = mapping;
  const createdBy = mapping.createdByUserId ? usersById.get(mapping.createdByUserId) : undefined;
  const ownerLabel = sanitizeLabelForRequester(mapping.owner, requester);

  const response: MappingResponse = {
    ...rest,
    owner: ownerLabel,
    createdByLabel: createdBy
      ? requester.isAdmin
        ? getUserDisplayLabel(createdBy)
        : getUserPublicLabel(createdBy)
      : ownerLabel,
  };

  if (requester.isAdmin && createdBy) {
    response.createdByUser = {
      id: createdBy.id,
      username: createdBy.username,
      email: createdBy.email,
      role: createdBy.role,
    };
  }

  return response;
};

const parseTwitterUsernames = (value: unknown): string[] => {
  const seen = new Set<string>();
  const usernames: string[] = [];
  const add = (candidate: unknown) => {
    if (typeof candidate !== 'string') {
      return;
    }
    const normalized = normalizeActor(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    usernames.push(normalized);
  };

  if (Array.isArray(value)) {
    for (const candidate of value) {
      add(candidate);
    }
  } else if (typeof value === 'string') {
    for (const candidate of value.split(',')) {
      add(candidate);
    }
  }

  return usernames;
};

const parseMappingIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ids.push(normalized);
  }

  return ids;
};

const resolveProfileSyncSourceUsername = (args: {
  twitterUsernames: string[];
  requestedSource?: unknown;
  fallbackSource?: string;
}): string | undefined => {
  const twitterUsernames = args.twitterUsernames.map(normalizeActor).filter((username) => username.length > 0);
  if (twitterUsernames.length === 0) {
    return undefined;
  }

  const normalizedRequested =
    args.requestedSource !== undefined ? normalizeActor(String(args.requestedSource || '')) : undefined;
  const normalizedFallback = normalizeActor(args.fallbackSource || '');

  let resolved = normalizedRequested;
  if (!resolved && normalizedFallback && twitterUsernames.includes(normalizedFallback)) {
    resolved = normalizedFallback;
  }

  if (resolved && twitterUsernames.includes(resolved)) {
    return resolved;
  }

  return twitterUsernames[0];
};

const getMappingMirrorSyncState = (mapping: AccountMapping) => ({
  sourceUsername: mapping.profileSyncSourceUsername,
  mirroredDisplayName: mapping.lastMirroredDisplayName,
  mirroredDescription: mapping.lastMirroredDescription,
  avatarUrl: mapping.lastMirroredAvatarUrl,
  bannerUrl: mapping.lastMirroredBannerUrl,
});

const getAccessibleGroups = (config: AppConfig, user: AuthenticatedUser) => {
  const allGroups = Array.isArray(config.groups)
    ? config.groups.filter((group) => getNormalizedGroupKey(group.name) !== RESERVED_UNGROUPED_KEY)
    : [];

  if (canViewAllMappings(user)) {
    return allGroups;
  }

  const visibleMappings = getVisibleMappings(config, user);
  const allowedKeys = new Set<string>();
  for (const mapping of visibleMappings) {
    const key = getNormalizedGroupKey(mapping.groupName);
    if (key && key !== RESERVED_UNGROUPED_KEY) {
      allowedKeys.add(key);
    }
  }

  const merged = new Map<string, { name: string; emoji?: string }>();
  for (const group of allGroups) {
    const key = getNormalizedGroupKey(group.name);
    if (!allowedKeys.has(key)) {
      continue;
    }
    merged.set(key, group);
  }

  for (const mapping of visibleMappings) {
    const groupName = normalizeGroupName(mapping.groupName);
    if (!groupName || getNormalizedGroupKey(groupName) === RESERVED_UNGROUPED_KEY) {
      continue;
    }
    const key = getNormalizedGroupKey(groupName);
    if (!merged.has(key)) {
      merged.set(key, {
        name: groupName,
        ...(mapping.groupEmoji ? { emoji: mapping.groupEmoji } : {}),
      });
    }
  }

  return [...merged.values()];
};

const parsePermissionsInput = (rawPermissions: unknown, role: UserRole): UserPermissions => {
  if (role === 'admin') {
    return { ...ADMIN_USER_PERMISSIONS };
  }

  const defaults = getDefaultUserPermissions(role);
  if (!rawPermissions || typeof rawPermissions !== 'object') {
    return defaults;
  }

  const record = rawPermissions as Record<string, unknown>;
  return {
    viewAllMappings: normalizeBoolean(record.viewAllMappings, defaults.viewAllMappings),
    manageOwnMappings: normalizeBoolean(record.manageOwnMappings, defaults.manageOwnMappings),
    manageAllMappings: normalizeBoolean(record.manageAllMappings, defaults.manageAllMappings),
    manageGroups: normalizeBoolean(record.manageGroups, defaults.manageGroups),
    queueBackfills: normalizeBoolean(record.queueBackfills, defaults.queueBackfills),
    runNow: normalizeBoolean(record.runNow, defaults.runNow),
  };
};

const validatePassword = (password: unknown): string | undefined => {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return undefined;
};

const buildUserSummary = (config: AppConfig, requester: AuthenticatedUser): UserSummaryResponse[] => {
  const usersById = createUserLookupById(config);
  return config.users
    .map((user) => {
      const ownedMappings = config.mappings.filter((mapping) => mapping.createdByUserId === user.id);
      const activeMappings = ownedMappings.filter((mapping) => mapping.enabled);
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        isAdmin: user.role === 'admin',
        permissions: user.permissions,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        mappingCount: ownedMappings.length,
        activeMappingCount: activeMappings.length,
        mappings: ownedMappings.map((mapping) => sanitizeMapping(mapping, usersById, requester)),
      };
    })
    .sort((a, b) => {
      if (a.isAdmin && !b.isAdmin) {
        return -1;
      }
      if (!a.isAdmin && b.isAdmin) {
        return 1;
      }

      const aLabel = (a.username || a.email || '').toLowerCase();
      const bLabel = (b.username || b.email || '').toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
};

const ensureUniqueIdentity = (
  config: AppConfig,
  userId: string | undefined,
  username?: string,
  email?: string,
): string | null => {
  if (username) {
    const usernameTaken = config.users.some(
      (user) => user.id !== userId && normalizeUsername(user.username) === username,
    );
    if (usernameTaken) {
      return 'Username already exists.';
    }
  }
  if (email) {
    const emailTaken = config.users.some((user) => user.id !== userId && normalizeEmail(user.email) === email);
    if (emailTaken) {
      return 'Email already exists.';
    }
  }
  return null;
};

const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  if (!token) {
    res.sendStatus(401);
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || typeof decoded !== 'object') {
      res.sendStatus(403);
      return;
    }

    const config = getConfig();
    const user = findUserFromTokenPayload(config, decoded as Record<string, unknown>);
    if (!user) {
      res.sendStatus(401);
      return;
    }

    req.user = toAuthenticatedUser(user);
    next();
  } catch {
    res.sendStatus(403);
  }
};

const requireAdmin = (req: any, res: any, next: any) => {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
};

function reconcileUpdateJobState() {
  if (!updateJobState.running) {
    return;
  }

  if (isProcessAlive(updateJobState.pid)) {
    return;
  }

  updateJobState = {
    ...updateJobState,
    running: false,
    finishedAt: updateJobState.finishedAt || Date.now(),
    exitCode: updateJobState.exitCode ?? null,
    signal: updateJobState.signal ?? null,
  };
}

function getUpdateStatusPayload(): UpdateStatusPayload {
  reconcileUpdateJobState();
  return {
    ...updateJobState,
    logTail: readLogTail(updateJobState.logFile),
  };
}

function startUpdateJob(startedBy: string): { ok: true; state: UpdateStatusPayload } | { ok: false; message: string } {
  reconcileUpdateJobState();

  if (updateJobState.running) {
    return { ok: false, message: 'Update already running.' };
  }

  if (!fs.existsSync(UPDATE_SCRIPT_PATH)) {
    return { ok: false, message: 'update.sh not found in app root.' };
  }

  fs.mkdirSync(UPDATE_LOG_DIR, { recursive: true });
  const logFile = path.join(UPDATE_LOG_DIR, `update-${Date.now()}.log`);
  const logFd = fs.openSync(logFile, 'a');
  fs.writeSync(logFd, `[${new Date().toISOString()}] Update requested by ${startedBy}\n`);

  try {
    const child = spawn('bash', [UPDATE_SCRIPT_PATH], {
      cwd: APP_ROOT_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });

    updateJobState = {
      running: true,
      pid: child.pid,
      startedAt: Date.now(),
      startedBy,
      logFile,
      finishedAt: undefined,
      exitCode: undefined,
      signal: undefined,
    };

    child.on('error', (error) => {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Failed to launch updater: ${error.message}\n`);
      updateJobState = {
        ...updateJobState,
        running: false,
        finishedAt: Date.now(),
        exitCode: 1,
      };
    });

    child.on('exit', (code, signal) => {
      const success = code === 0;
      fs.appendFileSync(
        logFile,
        `[${new Date().toISOString()}] Updater exited (${success ? 'success' : 'failure'}) code=${code ?? 'null'} signal=${signal ?? 'null'}\n`,
      );
      updateJobState = {
        ...updateJobState,
        running: false,
        finishedAt: Date.now(),
        exitCode: code ?? null,
        signal: signal ?? null,
      };
    });

    child.unref();
    return { ok: true, state: getUpdateStatusPayload() };
  } catch (error) {
    return { ok: false, message: `Failed to start update process: ${(error as Error).message}` };
  } finally {
    fs.closeSync(logFd);
  }
}

// --- Auth Routes ---

app.get('/api/auth/bootstrap-status', (_req, res) => {
  const config = getConfig();
  res.json({ bootstrapOpen: config.users.length === 0 });
});

app.post('/api/register', authRateLimiter, async (req, res) => {
  const config = getConfig();
  if (config.users.length > 0) {
    res.status(403).json({ error: 'Registration is disabled. Ask an admin to create your account.' });
    return;
  }

  const email = normalizeEmail(req.body?.email);
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;

  if (!email && !username) {
    res.status(400).json({ error: 'Username or email is required.' });
    return;
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const uniqueIdentityError = ensureUniqueIdentity(config, undefined, username, email);
  if (uniqueIdentityError) {
    res.status(400).json({ error: uniqueIdentityError });
    return;
  }

  const nowIso = new Date().toISOString();
  const newUser: WebUser = {
    id: randomUUID(),
    username,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    role: 'admin',
    permissions: { ...ADMIN_USER_PERMISSIONS },
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  config.users.push(newUser);

  if (config.mappings.length > 0) {
    config.mappings = config.mappings.map((mapping) => ({
      ...mapping,
      createdByUserId: mapping.createdByUserId || newUser.id,
      owner: mapping.owner || getUserPublicLabel(newUser),
    }));
  }

  saveConfig(config);

  res.json({ success: true });
});

app.post('/api/login', authRateLimiter, async (req, res) => {
  const password = req.body?.password;
  const identifier = normalizeOptionalString(req.body?.identifier) ?? normalizeOptionalString(req.body?.email);
  if (!identifier || typeof password !== 'string') {
    res.status(400).json({ error: 'Username/email and password are required.' });
    return;
  }

  const config = getConfig();
  const user = findUserByIdentifier(config, identifier);

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = issueTokenForUser(user);
  res.json({ token, isAdmin: user.role === 'admin' });
});

app.get('/api/me', authenticateToken, (req: any, res) => {
  res.json(serializeAuthenticatedUser(req.user));
});

app.post('/api/me/change-email', authenticateToken, async (req: any, res) => {
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === req.user.id);
  const user = config.users[userIndex];
  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const currentEmail = normalizeEmail(req.body?.currentEmail);
  const newEmail = normalizeEmail(req.body?.newEmail);
  const password = req.body?.password;
  if (!newEmail) {
    res.status(400).json({ error: 'A new email is required.' });
    return;
  }
  if (typeof password !== 'string') {
    res.status(400).json({ error: 'Password is required.' });
    return;
  }

  const existingEmail = normalizeEmail(user.email);
  if (existingEmail && currentEmail !== existingEmail) {
    res.status(400).json({ error: 'Current email does not match.' });
    return;
  }

  if (!(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: 'Password verification failed.' });
    return;
  }

  const uniqueIdentityError = ensureUniqueIdentity(config, user.id, normalizeUsername(user.username), newEmail);
  if (uniqueIdentityError) {
    res.status(400).json({ error: uniqueIdentityError });
    return;
  }

  const updatedUser: WebUser = {
    ...user,
    email: newEmail,
    updatedAt: new Date().toISOString(),
  };
  config.users[userIndex] = updatedUser;
  saveConfig(config);

  const token = issueTokenForUser(updatedUser);
  res.json({
    success: true,
    token,
    me: serializeAuthenticatedUser(toAuthenticatedUser(updatedUser)),
  });
});

app.post('/api/me/change-password', authenticateToken, async (req: any, res) => {
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === req.user.id);
  const user = config.users[userIndex];
  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const currentPassword = req.body?.currentPassword;
  const newPassword = req.body?.newPassword;
  if (typeof currentPassword !== 'string') {
    res.status(400).json({ error: 'Current password is required.' });
    return;
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    res.status(401).json({ error: 'Current password is incorrect.' });
    return;
  }

  config.users[userIndex] = {
    ...user,
    passwordHash: await bcrypt.hash(newPassword, 10),
    updatedAt: new Date().toISOString(),
  };
  saveConfig(config);
  res.json({ success: true });
});

app.get('/api/admin/users', authenticateToken, requireAdmin, (req: any, res) => {
  const config = getConfig();
  res.json(buildUserSummary(config, req.user));
});

app.post('/api/admin/users', authenticateToken, requireAdmin, async (req: any, res) => {
  const config = getConfig();
  const username = normalizeUsername(req.body?.username);
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  const role: UserRole = req.body?.isAdmin ? 'admin' : 'user';
  const permissions = parsePermissionsInput(req.body?.permissions, role);

  if (!username && !email) {
    res.status(400).json({ error: 'Username or email is required.' });
    return;
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const uniqueIdentityError = ensureUniqueIdentity(config, undefined, username, email);
  if (uniqueIdentityError) {
    res.status(400).json({ error: uniqueIdentityError });
    return;
  }

  const nowIso = new Date().toISOString();
  const newUser: WebUser = {
    id: randomUUID(),
    username,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    role,
    permissions,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  config.users.push(newUser);
  saveConfig(config);

  const summary = buildUserSummary(config, req.user).find((user) => user.id === newUser.id);
  res.json(summary || null);
});

app.put('/api/admin/users/:id', authenticateToken, requireAdmin, (req: any, res) => {
  const { id } = req.params;
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === id);
  const user = config.users[userIndex];
  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const requestedRole: UserRole =
    req.body?.isAdmin === true ? 'admin' : req.body?.isAdmin === false ? 'user' : user.role;

  if (user.id === req.user.id && requestedRole !== 'admin') {
    res.status(400).json({ error: 'You cannot remove your own admin access.' });
    return;
  }

  if (user.role === 'admin' && requestedRole !== 'admin') {
    const adminCount = config.users.filter((entry) => entry.role === 'admin').length;
    if (adminCount <= 1) {
      res.status(400).json({ error: 'At least one admin must remain.' });
      return;
    }
  }

  const username =
    req.body?.username !== undefined ? normalizeUsername(req.body?.username) : normalizeUsername(user.username);
  const email = req.body?.email !== undefined ? normalizeEmail(req.body?.email) : normalizeEmail(user.email);

  if (!username && !email) {
    res.status(400).json({ error: 'User must keep at least a username or email.' });
    return;
  }

  const uniqueIdentityError = ensureUniqueIdentity(config, user.id, username, email);
  if (uniqueIdentityError) {
    res.status(400).json({ error: uniqueIdentityError });
    return;
  }

  const permissions =
    req.body?.permissions !== undefined || req.body?.isAdmin !== undefined
      ? parsePermissionsInput(req.body?.permissions, requestedRole)
      : requestedRole === 'admin'
        ? { ...ADMIN_USER_PERMISSIONS }
        : user.permissions;

  config.users[userIndex] = {
    ...user,
    username,
    email,
    role: requestedRole,
    permissions,
    updatedAt: new Date().toISOString(),
  };

  saveConfig(config);
  const summary = buildUserSummary(config, req.user).find((entry) => entry.id === id);
  res.json(summary || null);
});

app.post('/api/admin/users/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === id);
  const user = config.users[userIndex];
  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const newPassword = req.body?.newPassword;
  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  config.users[userIndex] = {
    ...user,
    passwordHash: await bcrypt.hash(newPassword, 10),
    updatedAt: new Date().toISOString(),
  };
  saveConfig(config);
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, (req: any, res) => {
  const { id } = req.params;
  const config = getConfig();
  const userIndex = config.users.findIndex((user) => user.id === id);
  const user = config.users[userIndex];

  if (userIndex === -1 || !user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  if (user.id === req.user.id) {
    res.status(400).json({ error: 'You cannot delete your own account.' });
    return;
  }

  if (user.role === 'admin') {
    const adminCount = config.users.filter((entry) => entry.role === 'admin').length;
    if (adminCount <= 1) {
      res.status(400).json({ error: 'At least one admin must remain.' });
      return;
    }
  }

  const ownedMappings = config.mappings.filter((mapping) => mapping.createdByUserId === user.id);
  const ownedMappingIds = new Set(ownedMappings.map((mapping) => mapping.id));
  config.mappings = config.mappings.map((mapping) =>
    mapping.createdByUserId === user.id
      ? {
          ...mapping,
          enabled: false,
        }
      : mapping,
  );

  config.users.splice(userIndex, 1);
  pendingBackfills = pendingBackfills.filter((backfill) => !ownedMappingIds.has(backfill.id));
  saveConfig(config);

  res.json({
    success: true,
    disabledMappings: ownedMappings.length,
  });
});

// --- Mapping Routes ---

app.get('/api/mappings', authenticateToken, (req: any, res) => {
  const config = getConfig();
  const usersById = createUserLookupById(config);
  const visibleMappings = getVisibleMappings(config, req.user);
  res.json(visibleMappings.map((mapping) => sanitizeMapping(mapping, usersById, req.user)));
});

app.get('/api/groups', authenticateToken, (req: any, res) => {
  const config = getConfig();
  res.json(getAccessibleGroups(config, req.user));
});

app.post('/api/groups', authenticateToken, (req: any, res) => {
  if (!canManageGroups(req.user)) {
    res.status(403).json({ error: 'You do not have permission to manage groups.' });
    return;
  }

  const config = getConfig();
  const normalizedName = normalizeGroupName(req.body?.name);
  const normalizedEmoji = normalizeGroupEmoji(req.body?.emoji);

  if (!normalizedName) {
    res.status(400).json({ error: 'Group name is required.' });
    return;
  }

  if (getNormalizedGroupKey(normalizedName) === RESERVED_UNGROUPED_KEY) {
    res.status(400).json({ error: '"Ungrouped" is reserved for default behavior.' });
    return;
  }

  ensureGroupExists(config, normalizedName, normalizedEmoji);
  saveConfig(config);

  const group = config.groups.find(
    (entry) => getNormalizedGroupKey(entry.name) === getNormalizedGroupKey(normalizedName),
  );
  res.json(group || { name: normalizedName, ...(normalizedEmoji ? { emoji: normalizedEmoji } : {}) });
});

app.put('/api/groups/:groupKey', authenticateToken, (req: any, res) => {
  if (!canManageGroups(req.user)) {
    res.status(403).json({ error: 'You do not have permission to manage groups.' });
    return;
  }

  const currentGroupKey = getNormalizedGroupKey(req.params.groupKey);
  if (!currentGroupKey || currentGroupKey === RESERVED_UNGROUPED_KEY) {
    res.status(400).json({ error: 'Invalid group key.' });
    return;
  }

  const requestedName = normalizeGroupName(req.body?.name);
  const requestedEmoji = normalizeGroupEmoji(req.body?.emoji);
  if (!requestedName) {
    res.status(400).json({ error: 'Group name is required.' });
    return;
  }

  const requestedGroupKey = getNormalizedGroupKey(requestedName);
  if (requestedGroupKey === RESERVED_UNGROUPED_KEY) {
    res.status(400).json({ error: '"Ungrouped" is reserved and cannot be edited.' });
    return;
  }

  const config = getConfig();
  if (!Array.isArray(config.groups)) {
    config.groups = [];
  }

  const groupIndex = config.groups.findIndex((group) => getNormalizedGroupKey(group.name) === currentGroupKey);
  if (groupIndex === -1) {
    res.status(404).json({ error: 'Group not found.' });
    return;
  }

  const mergeIndex = config.groups.findIndex(
    (group, index) => index !== groupIndex && getNormalizedGroupKey(group.name) === requestedGroupKey,
  );

  let finalName = requestedName;
  let finalEmoji = requestedEmoji || normalizeGroupEmoji(config.groups[groupIndex]?.emoji);
  if (mergeIndex !== -1) {
    finalName = normalizeGroupName(config.groups[mergeIndex]?.name) || requestedName;
    finalEmoji = requestedEmoji || normalizeGroupEmoji(config.groups[mergeIndex]?.emoji) || finalEmoji;

    config.groups[mergeIndex] = {
      name: finalName,
      ...(finalEmoji ? { emoji: finalEmoji } : {}),
    };
    config.groups.splice(groupIndex, 1);
  } else {
    config.groups[groupIndex] = {
      name: finalName,
      ...(finalEmoji ? { emoji: finalEmoji } : {}),
    };
  }

  const keysToRewrite = new Set([currentGroupKey, requestedGroupKey]);
  config.mappings = config.mappings.map((mapping) => {
    const mappingGroupKey = getNormalizedGroupKey(mapping.groupName);
    if (!keysToRewrite.has(mappingGroupKey)) {
      return mapping;
    }
    return {
      ...mapping,
      groupName: finalName,
      groupEmoji: finalEmoji || undefined,
    };
  });

  saveConfig(config);
  res.json({
    name: finalName,
    ...(finalEmoji ? { emoji: finalEmoji } : {}),
  });
});

app.delete('/api/groups/:groupKey', authenticateToken, (req: any, res) => {
  if (!canManageGroups(req.user)) {
    res.status(403).json({ error: 'You do not have permission to manage groups.' });
    return;
  }

  const groupKey = getNormalizedGroupKey(req.params.groupKey);
  if (!groupKey || groupKey === RESERVED_UNGROUPED_KEY) {
    res.status(400).json({ error: 'Invalid group key.' });
    return;
  }

  const config = getConfig();
  if (!Array.isArray(config.groups)) {
    config.groups = [];
  }

  const beforeCount = config.groups.length;
  config.groups = config.groups.filter((group) => getNormalizedGroupKey(group.name) !== groupKey);
  if (config.groups.length === beforeCount) {
    res.status(404).json({ error: 'Group not found.' });
    return;
  }

  let reassigned = 0;
  config.mappings = config.mappings.map((mapping) => {
    if (getNormalizedGroupKey(mapping.groupName) !== groupKey) {
      return mapping;
    }
    reassigned += 1;
    return {
      ...mapping,
      groupName: undefined,
      groupEmoji: undefined,
    };
  });

  saveConfig(config);
  res.json({ success: true, reassignedCount: reassigned });
});

app.post('/api/onboarding/twitter-profile', authenticateToken, async (req: any, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to create mappings.' });
    return;
  }

  const twitterUsername = normalizeActor(req.body?.twitterUsername || '');
  if (!twitterUsername) {
    res.status(400).json({ error: 'Twitter username is required.' });
    return;
  }

  try {
    const profile = await fetchTwitterMirrorProfile(twitterUsername);
    res.json(profile);
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to fetch Twitter profile metadata.') });
  }
});

app.post('/api/onboarding/bsky-credentials', authenticateToken, async (req: any, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to create mappings.' });
    return;
  }

  const bskyIdentifier = normalizeOptionalString(req.body?.bskyIdentifier);
  const bskyPassword = normalizeOptionalString(req.body?.bskyPassword);
  const bskyServiceUrl = normalizeOptionalString(req.body?.bskyServiceUrl);

  if (!bskyIdentifier || !bskyPassword) {
    res.status(400).json({ error: 'Bluesky identifier and app password are required.' });
    return;
  }

  try {
    const validation = await validateBlueskyCredentials({
      bskyIdentifier,
      bskyPassword,
      bskyServiceUrl,
    });
    res.json(validation);
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to validate Bluesky credentials.') });
  }
});

app.post('/api/mappings', authenticateToken, async (req: any, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to create mappings.' });
    return;
  }

  const config = getConfig();
  const usersById = createUserLookupById(config);
  const twitterUsernames = parseTwitterUsernames(req.body?.twitterUsernames);
  if (twitterUsernames.length === 0) {
    res.status(400).json({ error: 'At least one Twitter username is required.' });
    return;
  }

  const bskyIdentifier = normalizeActor(req.body?.bskyIdentifier || '');
  const bskyPassword = normalizeOptionalString(req.body?.bskyPassword);
  if (!bskyIdentifier || !bskyPassword) {
    res.status(400).json({ error: 'Bluesky identifier and app password are required.' });
    return;
  }

  let createdByUserId = req.user.id;
  const requestedCreatorId = normalizeOptionalString(req.body?.createdByUserId);
  if (requestedCreatorId && requestedCreatorId !== req.user.id) {
    if (!canManageAllMappings(req.user)) {
      res.status(403).json({ error: 'You cannot assign mappings to another user.' });
      return;
    }
    if (!usersById.has(requestedCreatorId)) {
      res.status(400).json({ error: 'Selected account owner does not exist.' });
      return;
    }
    createdByUserId = requestedCreatorId;
  }

  const ownerUser = usersById.get(createdByUserId);
  const owner =
    normalizeOptionalString(req.body?.owner) ||
    (ownerUser ? getUserPublicLabel(ownerUser) : getActorPublicLabel(req.user));
  const normalizedGroupName = normalizeGroupName(req.body?.groupName);
  const normalizedGroupEmoji = normalizeGroupEmoji(req.body?.groupEmoji);
  const profileSyncSourceUsername = resolveProfileSyncSourceUsername({
    twitterUsernames,
    requestedSource: req.body?.profileSyncSourceUsername,
  });

  const newMapping: AccountMapping = {
    id: randomUUID(),
    twitterUsernames,
    bskyIdentifier,
    bskyPassword,
    bskyServiceUrl: normalizeOptionalString(req.body?.bskyServiceUrl) || 'https://bsky.social',
    enabled: true,
    owner,
    groupName: normalizedGroupName || undefined,
    groupEmoji: normalizedGroupEmoji || undefined,
    createdByUserId,
    profileSyncSourceUsername,
    hasBotLabel: false,
  };

  ensureGroupExists(config, normalizedGroupName, normalizedGroupEmoji);
  config.mappings.push(newMapping);
  saveConfig(config);

  try {
    const labelResult = await ensureBlueskyBotSelfLabel({
      bskyIdentifier: newMapping.bskyIdentifier,
      bskyPassword: newMapping.bskyPassword,
      bskyServiceUrl: newMapping.bskyServiceUrl,
    });

    if (labelResult.hasBotLabel && !newMapping.hasBotLabel) {
      newMapping.hasBotLabel = true;
      saveConfig(config);
    }

    for (const key of [
      normalizeActor(newMapping.bskyIdentifier),
      normalizeActor(labelResult.bsky.handle),
      normalizeActor(labelResult.bsky.did),
    ]) {
      if (key) {
        profileCache.delete(key);
      }
    }
  } catch (error) {
    console.warn(
      `[mapping:${newMapping.id}] Failed to apply Bluesky bot self-label during mapping creation: ${getErrorMessage(error)}`,
    );
  }

  res.json(sanitizeMapping(newMapping, createUserLookupById(config), req.user));
});

app.put('/api/mappings/:id', authenticateToken, (req: any, res) => {
  const { id } = req.params;
  const config = getConfig();
  const usersById = createUserLookupById(config);
  const index = config.mappings.findIndex((mapping) => mapping.id === id);
  const existingMapping = config.mappings[index];

  if (index === -1 || !existingMapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, existingMapping)) {
    res.status(403).json({ error: 'You do not have permission to update this mapping.' });
    return;
  }

  let twitterUsernames: string[] = existingMapping.twitterUsernames;
  if (req.body?.twitterUsernames !== undefined) {
    twitterUsernames = parseTwitterUsernames(req.body.twitterUsernames);
    if (twitterUsernames.length === 0) {
      res.status(400).json({ error: 'At least one Twitter username is required.' });
      return;
    }
  }

  let bskyIdentifier = existingMapping.bskyIdentifier;
  if (req.body?.bskyIdentifier !== undefined) {
    const normalizedIdentifier = normalizeActor(req.body?.bskyIdentifier);
    if (!normalizedIdentifier) {
      res.status(400).json({ error: 'Invalid Bluesky identifier.' });
      return;
    }
    bskyIdentifier = normalizedIdentifier;
  }

  let createdByUserId = existingMapping.createdByUserId || req.user.id;
  if (req.body?.createdByUserId !== undefined) {
    if (!canManageAllMappings(req.user)) {
      res.status(403).json({ error: 'You cannot reassign mapping ownership.' });
      return;
    }

    const requestedCreatorId = normalizeOptionalString(req.body?.createdByUserId);
    if (!requestedCreatorId || !usersById.has(requestedCreatorId)) {
      res.status(400).json({ error: 'Selected account owner does not exist.' });
      return;
    }
    createdByUserId = requestedCreatorId;
  }

  let nextGroupName = existingMapping.groupName;
  if (req.body?.groupName !== undefined) {
    const normalizedName = normalizeGroupName(req.body?.groupName);
    nextGroupName = normalizedName || undefined;
  }

  let nextGroupEmoji = existingMapping.groupEmoji;
  if (req.body?.groupEmoji !== undefined) {
    const normalizedEmoji = normalizeGroupEmoji(req.body?.groupEmoji);
    nextGroupEmoji = normalizedEmoji || undefined;
  }

  const ownerUser = usersById.get(createdByUserId);
  const owner =
    req.body?.owner !== undefined
      ? normalizeOptionalString(req.body?.owner) || existingMapping.owner
      : existingMapping.owner || (ownerUser ? getUserPublicLabel(ownerUser) : undefined);

  const profileSyncSourceUsername = resolveProfileSyncSourceUsername({
    twitterUsernames,
    requestedSource: req.body?.profileSyncSourceUsername,
    fallbackSource: existingMapping.profileSyncSourceUsername,
  });

  const updatedMapping: AccountMapping = {
    ...existingMapping,
    twitterUsernames,
    bskyIdentifier,
    bskyPassword: normalizeOptionalString(req.body?.bskyPassword) || existingMapping.bskyPassword,
    bskyServiceUrl: normalizeOptionalString(req.body?.bskyServiceUrl) || existingMapping.bskyServiceUrl,
    enabled: normalizeBoolean(req.body?.enabled, existingMapping.enabled),
    owner,
    groupName: nextGroupName,
    groupEmoji: nextGroupEmoji,
    createdByUserId,
    profileSyncSourceUsername,
  };

  ensureGroupExists(config, nextGroupName, nextGroupEmoji);
  config.mappings[index] = updatedMapping;
  saveConfig(config);
  res.json(sanitizeMapping(updatedMapping, createUserLookupById(config), req.user));
});

// Forces the next login attempt for a down account to happen immediately,
// instead of waiting out the escalating recheck schedule. This is the
// dashboard's "Check again" button: the only thing to do after reactivating an
// account or winning a takedown appeal.
app.post('/api/mappings/:id/recheck-account', authenticateToken, (req: any, res) => {
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === req.params.id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }
  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this mapping.' });
    return;
  }

  const health = accountHealthService.get(mapping.bskyIdentifier);
  if (!health) {
    res.json({ ok: true, cleared: false, message: `${mapping.bskyIdentifier} is not currently flagged as down.` });
    return;
  }

  accountHealthService.recheckNow(mapping.bskyIdentifier);
  logEvent({
    level: 'info',
    stage: 'bluesky',
    event: 'account.recheck-requested',
    message: `Manual recheck requested for ${mapping.bskyIdentifier}; the next post batch will attempt a fresh sign-in.`,
    mappingId: mapping.id,
    bskyIdentifier: mapping.bskyIdentifier,
    detail: { state: health.state, detectedAt: health.detected_at },
  });

  res.json({
    ok: true,
    cleared: true,
    message: `Will retry ${mapping.bskyIdentifier} on the next post batch.`,
  });
});

app.post('/api/mappings/:id/sync-profile-from-twitter', authenticateToken, async (req: any, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mappingIndex = config.mappings.findIndex((entry) => entry.id === id);
  const mapping = config.mappings[mappingIndex];

  if (mappingIndex === -1 || !mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this mapping.' });
    return;
  }

  const sourceTwitterUsername = resolveProfileSyncSourceUsername({
    twitterUsernames: mapping.twitterUsernames,
    requestedSource: req.body?.sourceTwitterUsername,
    fallbackSource: mapping.profileSyncSourceUsername,
  });

  if (!sourceTwitterUsername) {
    res.status(400).json({ error: 'Mapping has no Twitter source usernames.' });
    return;
  }

  try {
    const result = await syncBlueskyProfileFromTwitter({
      twitterUsername: sourceTwitterUsername,
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
      previousSync: getMappingMirrorSyncState(mapping),
    });

    const updatedMapping = applyProfileMirrorSyncState(mapping, sourceTwitterUsername, result);
    config.mappings[mappingIndex] = updatedMapping;
    saveConfig(config);

    for (const key of [
      normalizeActor(updatedMapping.bskyIdentifier),
      normalizeActor(result.bsky.handle),
      normalizeActor(result.bsky.did),
    ]) {
      if (key) {
        profileCache.delete(key);
      }
    }

    res.json({
      success: true,
      sourceTwitterUsername,
      mapping: sanitizeMapping(updatedMapping, createUserLookupById(config), req.user),
      ...result,
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to sync Bluesky profile from Twitter.') });
  }
});

app.post('/api/mappings/:id/pull-twitter-bio', authenticateToken, async (req: any, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mappingIndex = config.mappings.findIndex((entry) => entry.id === id);
  const mapping = config.mappings[mappingIndex];

  if (mappingIndex === -1 || !mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this mapping.' });
    return;
  }

  const sourceTwitterUsername = resolveProfileSyncSourceUsername({
    twitterUsernames: mapping.twitterUsernames,
    requestedSource: req.body?.sourceTwitterUsername,
    fallbackSource: mapping.profileSyncSourceUsername,
  });

  if (!sourceTwitterUsername) {
    res.status(400).json({ error: 'Mapping has no Twitter source usernames.' });
    return;
  }

  try {
    const result = await syncBlueskyProfileFromTwitter({
      twitterUsername: sourceTwitterUsername,
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
      previousSync: getMappingMirrorSyncState(mapping),
      syncDisplayName: false,
      syncDescription: true,
      syncAvatar: false,
      syncBanner: false,
    });

    const updatedMapping = applyProfileMirrorSyncState(mapping, sourceTwitterUsername, result);
    config.mappings[mappingIndex] = updatedMapping;
    saveConfig(config);

    for (const key of [
      normalizeActor(updatedMapping.bskyIdentifier),
      normalizeActor(result.bsky.handle),
      normalizeActor(result.bsky.did),
    ]) {
      if (key) {
        profileCache.delete(key);
      }
    }

    res.json({
      success: true,
      sourceTwitterUsername,
      mapping: sanitizeMapping(updatedMapping, createUserLookupById(config), req.user),
      ...result,
    });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to pull Twitter bio.') });
  }
});

app.post('/api/mappings/bot-label-all', authenticateToken, async (req: any, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to update mappings.' });
    return;
  }

  const config = getConfig();
  const usersById = createUserLookupById(config);
  const manageableMappings = getVisibleMappings(config, req.user).filter((mapping) =>
    canManageMapping(req.user, mapping),
  );
  const requestedIds = parseMappingIds(req.body?.mappingIds);
  const requestedIdSet = requestedIds.length > 0 ? new Set(requestedIds) : null;
  const targets = requestedIdSet
    ? manageableMappings.filter((mapping) => requestedIdSet.has(mapping.id))
    : manageableMappings;

  if (targets.length === 0) {
    res.status(400).json({ error: 'No manageable mappings available for bot label update.' });
    return;
  }

  let labeled = 0;
  let alreadyLabeled = 0;
  let failed = 0;
  let changed = false;
  const failedMappings: Array<{ id: string; bskyIdentifier: string; error: string }> = [];

  for (const mapping of targets) {
    try {
      const result = await ensureBlueskyBotSelfLabel({
        bskyIdentifier: mapping.bskyIdentifier,
        bskyPassword: mapping.bskyPassword,
        bskyServiceUrl: mapping.bskyServiceUrl,
      });

      if (result.updated) {
        labeled += 1;
      } else {
        alreadyLabeled += 1;
      }

      if (!mapping.hasBotLabel) {
        mapping.hasBotLabel = true;
        changed = true;
      }

      for (const key of [
        normalizeActor(mapping.bskyIdentifier),
        normalizeActor(result.bsky.handle),
        normalizeActor(result.bsky.did),
      ]) {
        if (key) {
          profileCache.delete(key);
        }
      }
    } catch (error) {
      failed += 1;
      failedMappings.push({
        id: mapping.id,
        bskyIdentifier: mapping.bskyIdentifier,
        error: getErrorMessage(error, 'Failed to update bot label.'),
      });
    }
  }

  if (changed) {
    saveConfig(config);
  }

  res.json({
    success: true,
    total: targets.length,
    labeled,
    alreadyLabeled,
    failed,
    failedMappings,
    mappings: targets.map((mapping) => sanitizeMapping(mapping, usersById, req.user)),
  });
});

app.post('/api/mappings/append-bot-name-all', authenticateToken, async (req: any, res) => {
  if (!canManageOwnMappings(req.user) && !canManageAllMappings(req.user)) {
    res.status(403).json({ error: 'You do not have permission to update mappings.' });
    return;
  }

  const config = getConfig();
  const usersById = createUserLookupById(config);
  const manageableMappings = getVisibleMappings(config, req.user).filter((mapping) =>
    canManageMapping(req.user, mapping),
  );
  const requestedIds = parseMappingIds(req.body?.mappingIds);
  const requestedIdSet = requestedIds.length > 0 ? new Set(requestedIds) : null;
  const targets = requestedIdSet
    ? manageableMappings.filter((mapping) => requestedIdSet.has(mapping.id))
    : manageableMappings;

  if (targets.length === 0) {
    res.status(400).json({ error: 'No manageable mappings available for display-name update.' });
    return;
  }

  let appended = 0;
  let alreadyAppended = 0;
  let failed = 0;
  let changed = false;
  const failedMappings: Array<{ id: string; bskyIdentifier: string; error: string }> = [];

  for (const mapping of targets) {
    try {
      const sourceTwitterUsername = resolveProfileSyncSourceUsername({
        twitterUsernames: mapping.twitterUsernames,
        fallbackSource: mapping.profileSyncSourceUsername,
      });
      if (!sourceTwitterUsername) {
        failed += 1;
        failedMappings.push({
          id: mapping.id,
          bskyIdentifier: mapping.bskyIdentifier,
          error: 'Mapping has no Twitter source usernames.',
        });
        continue;
      }

      const result = await ensureBlueskyDisplayNameBotSuffix({
        bskyIdentifier: mapping.bskyIdentifier,
        bskyPassword: mapping.bskyPassword,
        bskyServiceUrl: mapping.bskyServiceUrl,
        twitterUsername: sourceTwitterUsername,
      });

      if (result.updated) {
        appended += 1;
      } else {
        alreadyAppended += 1;
      }

      if (mapping.profileSyncSourceUsername !== sourceTwitterUsername) {
        mapping.profileSyncSourceUsername = sourceTwitterUsername;
        changed = true;
      }

      if (mapping.lastMirroredDisplayName !== result.displayName) {
        mapping.lastMirroredDisplayName = result.displayName;
        changed = true;
      }

      for (const key of [
        normalizeActor(mapping.bskyIdentifier),
        normalizeActor(result.bsky.handle),
        normalizeActor(result.bsky.did),
      ]) {
        if (key) {
          profileCache.delete(key);
        }
      }
    } catch (error) {
      failed += 1;
      failedMappings.push({
        id: mapping.id,
        bskyIdentifier: mapping.bskyIdentifier,
        error: getErrorMessage(error, 'Failed to append display-name suffix.'),
      });
    }
  }

  if (changed) {
    saveConfig(config);
  }

  res.json({
    success: true,
    total: targets.length,
    appended,
    alreadyAppended,
    failed,
    failedMappings,
    mappings: targets.map((mapping) => sanitizeMapping(mapping, usersById, req.user)),
  });
});

app.post('/api/mappings/:id/bridge-to-fediverse', authenticateToken, async (req: any, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to bridge this mapping.' });
    return;
  }

  try {
    const result = await bridgeBlueskyAccountToFediverse({
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
    });

    fediverseBridgeStatusCache.set(normalizeActor(mapping.bskyIdentifier), {
      value: {
        bridged: true,
        checkedAt: new Date().toISOString(),
      },
      expiresAt: nowMs() + FEDIVERSE_BRIDGE_STATUS_CACHE_TTL_MS,
    });

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ error: getErrorMessage(error, 'Failed to bridge account to the fediverse.') });
  }
});

app.post('/api/mappings/fediverse-bridge-status', authenticateToken, async (req: any, res) => {
  const config = getConfig();
  const visibleMappings = getVisibleMappings(config, req.user);
  const visibleMappingsById = new Map(visibleMappings.map((mapping) => [mapping.id, mapping] as const));

  const requestedIds = parseMappingIds(req.body?.mappingIds);
  const idsToCheck = (requestedIds.length > 0 ? requestedIds : visibleMappings.map((mapping) => mapping.id))
    .filter((id) => visibleMappingsById.has(id))
    .slice(0, 200);

  if (idsToCheck.length === 0) {
    res.json({});
    return;
  }

  const actorByMappingId = new Map<string, string>();
  const actorsToCheck: string[] = [];
  const statuses: Record<string, FediverseBridgeStatusView> = {};

  for (const id of idsToCheck) {
    const mapping = visibleMappingsById.get(id);
    if (!mapping) {
      statuses[id] = {
        bridged: false,
        checkedAt: new Date().toISOString(),
        error: 'Mapping not visible to current user.',
      };
      continue;
    }

    const actor = normalizeActor(mapping.bskyIdentifier);
    if (!actor) {
      statuses[id] = {
        bridged: false,
        checkedAt: new Date().toISOString(),
        error: 'Missing Bluesky identifier for mapping.',
      };
      continue;
    }

    actorByMappingId.set(id, actor);
    actorsToCheck.push(actor);
  }

  const actorStatuses = await fetchFediverseBridgeStatusesByActor(actorsToCheck);

  for (const [mappingId, actor] of actorByMappingId.entries()) {
    const actorStatus = actorStatuses[actor];
    if (actorStatus) {
      statuses[mappingId] = actorStatus;
      continue;
    }

    statuses[mappingId] = {
      bridged: false,
      checkedAt: new Date().toISOString(),
      error: 'Bridge status could not be determined for this account.',
    };
  }

  res.json(statuses);
});

app.delete('/api/mappings/:id', authenticateToken, (req: any, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to delete this mapping.' });
    return;
  }

  config.mappings = config.mappings.filter((entry) => entry.id !== id);
  pendingBackfills = pendingBackfills.filter((entry) => entry.id !== id);
  postQueueService.deleteByMappingId(id);
  saveConfig(config);
  res.json({ success: true });
});

app.delete('/api/mappings/:id/cache', authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === id);
  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  for (const username of mapping.twitterUsernames) {
    dbService.deleteTweetsByUsername(username);
  }

  res.json({ success: true, message: 'Cache cleared for all associated accounts' });
});

app.post('/api/mappings/:id/delete-all-posts', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === id);
  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  try {
    const deletedCount = await deleteAllPosts(id);

    dbService.deleteTweetsByBskyIdentifier(mapping.bskyIdentifier);

    res.json({
      success: true,
      message: `Deleted ${deletedCount} posts from ${mapping.bskyIdentifier} and cleared local cache.`,
    });
  } catch (err) {
    console.error('Failed to delete all posts:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- Twitter Config Routes (Admin Only) ---

app.get('/api/twitter-config', authenticateToken, requireAdmin, (_req, res) => {
  const config = getConfig();
  res.json(config.twitter);
});

app.post('/api/twitter-config', authenticateToken, requireAdmin, (req, res) => {
  const { authToken, ct0, backupAuthToken, backupCt0 } = req.body;
  const config = getConfig();
  config.twitter = { authToken, ct0, backupAuthToken, backupCt0 };
  saveConfig(config);
  res.json({ success: true });
});

app.get('/api/ai-config', authenticateToken, requireAdmin, (_req, res) => {
  const config = getConfig();
  const aiConfig = config.ai || {
    provider: 'gemini',
    apiKey: config.geminiApiKey || '',
  };
  res.json(aiConfig);
});

app.post('/api/ai-config', authenticateToken, requireAdmin, (req, res) => {
  const { provider, apiKey, model, baseUrl } = req.body;
  const config = getConfig();

  config.ai = {
    provider,
    apiKey,
    model: model || undefined,
    baseUrl: baseUrl || undefined,
  };

  config.geminiApiKey = undefined; // legacy field; dropped from config.json on save

  saveConfig(config);
  res.json({ success: true });
});

// --- Status & Actions Routes ---

app.get('/api/status', authenticateToken, (req: any, res) => {
  const config = getConfig();
  const now = Date.now();
  const nextRunMs = Math.max(0, nextCheckTime - now);
  const visibleMappingIds = getVisibleMappingIdSet(config, req.user);
  const scopedPendingBackfills = pendingBackfills
    .filter((backfill) => visibleMappingIds.has(backfill.id))
    .sort((a, b) => a.sequence - b.sequence);

  const scopedStatus =
    currentAppStatus.state === 'backfilling' &&
    currentAppStatus.backfillMappingId &&
    !visibleMappingIds.has(currentAppStatus.backfillMappingId)
      ? {
          state: 'idle',
          message: 'Idle',
          lastUpdate: currentAppStatus.lastUpdate,
        }
      : currentAppStatus;

  // Jobs are scoped like backfills: by mapping id when set, otherwise by the
  // Bluesky target of a mapping the user can see.
  const visibleBskyIdentifiers = new Set(
    config.mappings
      .filter((mapping) => visibleMappingIds.has(mapping.id))
      .map((mapping) => mapping.bskyIdentifier.toLowerCase()),
  );
  const scopedJobs = getActiveJobsSnapshot().filter((job) => {
    if (job.mappingId) return visibleMappingIds.has(job.mappingId);
    if (job.target) return visibleBskyIdentifiers.has(job.target.toLowerCase());
    return true;
  });

  // Post-queue state comes straight from SQLite, so what the dashboard shows
  // is exactly what the workers will post — no in-memory drift.
  const queueCounts = postQueueService.getCounts();
  const scopedQueueMappings = queueCounts.perMapping.filter(
    (entry) => visibleMappingIds.has(entry.mapping_id) && entry.pending + entry.processing + entry.failed > 0,
  );
  const queueSummary = {
    pending: scopedQueueMappings.reduce((total, entry) => total + entry.pending, 0),
    processing: scopedQueueMappings.reduce((total, entry) => total + entry.processing, 0),
    failed: scopedQueueMappings.reduce((total, entry) => total + entry.failed, 0),
    // `pending` split into what can post now and what is serving retry backoff,
    // so a stuck-looking number is self-explanatory in the UI.
    ready: scopedQueueMappings.reduce((total, entry) => total + (entry.ready ?? 0), 0),
    backoff: scopedQueueMappings.reduce((total, entry) => total + (entry.backoff ?? 0), 0),
    nextRetryAt: scopedQueueMappings.reduce<number | null>(
      (soonest, entry) =>
        entry.next_retry_at !== null &&
        entry.next_retry_at !== undefined &&
        (soonest === null || entry.next_retry_at < soonest)
          ? entry.next_retry_at
          : soonest,
      null,
    ),
    oldestEnqueuedAt: scopedQueueMappings.reduce<number | null>(
      (oldest, entry) =>
        entry.oldest_enqueued_at !== null && (oldest === null || entry.oldest_enqueued_at < oldest)
          ? entry.oldest_enqueued_at
          : oldest,
      null,
    ),
    perMapping: scopedQueueMappings,
  };

  // Accounts that cannot be posted to at all (taken down, suspended,
  // deactivated). Surfaced here rather than only in the log because otherwise
  // the queue just looks stuck for no visible reason.
  const downAccounts = accountHealthService.list();
  const accountAlerts = config.mappings
    .filter((mapping) => visibleMappingIds.has(mapping.id))
    .flatMap((mapping) => {
      const health = downAccounts.find((row) => row.bsky_identifier === mapping.bskyIdentifier.toLowerCase());
      if (!health) return [];
      const queued = queueCounts.perMapping.find((entry) => entry.mapping_id === mapping.id);
      return [
        {
          mappingId: mapping.id,
          bskyIdentifier: mapping.bskyIdentifier,
          twitterUsernames: mapping.twitterUsernames,
          state: health.state,
          status: health.status,
          reason: health.reason,
          detectedAt: health.detected_at,
          lastCheckedAt: health.last_checked_at,
          nextRecheckAt: health.next_recheck_at,
          queuedTweets: (queued?.pending ?? 0) + (queued?.processing ?? 0),
        },
      ];
    });

  res.json({
    lastCheckTime,
    nextCheckTime,
    nextCheckMinutes: Math.ceil(nextRunMs / 60000),
    checkIntervalMinutes: config.checkIntervalMinutes,
    accountAlerts,
    pendingBackfills: scopedPendingBackfills.map((backfill, index) => ({
      ...backfill,
      position: index + 1,
    })),
    currentStatus: scopedStatus,
    activeJobs: scopedJobs,
    queue: queueSummary,
  });
});

// Detailed post-queue listing, scoped to the mappings the caller can see.
app.get('/api/queue', authenticateToken, (req: any, res) => {
  const config = getConfig();
  const visibleMappingIds = getVisibleMappingIdSet(config, req.user);
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 200;

  res.json({
    counts: postQueueService.getCounts().perMapping.filter((entry) => visibleMappingIds.has(entry.mapping_id)),
    items: postQueueService.listItems({ mappingIds: visibleMappingIds, limit }),
  });
});

// Why the failures happened, grouped by reason. This is the answer to "323
// failed" that the counter alone can never give.
app.get('/api/queue/failures', authenticateToken, (req: any, res) => {
  const config = getConfig();
  const visibleMappingIds = getVisibleMappingIdSet(config, req.user);
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 500)) : 100;

  res.json({
    summary: postQueueService.summarizeFailures(visibleMappingIds),
    items: postQueueService.listItems({ mappingIds: visibleMappingIds, limit, status: 'failed' }),
  });
});

app.post('/api/queue/retry-failed', authenticateToken, requireAdmin, (req: any, res) => {
  const retried = postQueueService.retryFailed();
  logEvent({
    level: 'info',
    stage: 'queue',
    event: 'queue.retry-failed',
    message: `${getActorLabel(req.user)} requeued ${retried} failed tweet(s).`,
    detail: { retried, actor: getActorLabel(req.user) },
  });
  res.json({ success: true, message: `${retried} failed tweet(s) requeued.` });
});

app.delete('/api/queue/failed', authenticateToken, requireAdmin, (req: any, res) => {
  const cleared = postQueueService.clearFailed();
  logEvent({
    level: 'warn',
    stage: 'queue',
    event: 'queue.clear-failed',
    message: `${getActorLabel(req.user)} discarded ${cleared} failed tweet(s) from the queue. They will not be retried.`,
    detail: { cleared, actor: getActorLabel(req.user) },
  });
  res.json({ success: true, message: `${cleared} failed tweet(s) removed from the queue.` });
});

// ============================================================================
// Structured log access
//
// Non-admins only ever see entries attributable to a mapping they can view.
// System-level entries (boot, scheduler, housekeeping) carry no account, so
// they are admin-only rather than leaking cross-tenant activity.
// ============================================================================

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);

function parseListParam(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.slice(0, 50) : undefined;
}

function parseTimestampParam(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Turns query params into a filter set, then narrows it to what this user is
 * allowed to see. Returns null when the user can see nothing at all.
 */
function buildScopedLogFilters(req: any): LogQueryFilters | null {
  const config = getConfig();
  const filters: LogQueryFilters = {};

  const levels = parseListParam(req.query.level)?.filter((level): level is LogLevel =>
    LOG_LEVELS.has(level as LogLevel),
  );
  if (levels && levels.length > 0) filters.levels = levels;

  const stages = parseListParam(req.query.stage) as LogStage[] | undefined;
  if (stages && stages.length > 0) filters.stages = stages;

  const events = parseListParam(req.query.event);
  if (events) filters.events = events;

  if (typeof req.query.q === 'string' && req.query.q.trim().length > 0) {
    filters.search = req.query.q.trim().slice(0, 200);
  }
  if (typeof req.query.tweetId === 'string' && req.query.tweetId.trim().length > 0) {
    filters.twitterId = req.query.tweetId.trim();
  }
  if (typeof req.query.jobId === 'string' && req.query.jobId.trim().length > 0) {
    filters.jobId = req.query.jobId.trim();
  }

  const since = parseTimestampParam(req.query.since);
  if (since !== undefined) filters.since = since;
  const until = parseTimestampParam(req.query.until);
  if (until !== undefined) filters.until = until;

  const beforeId = Number(req.query.beforeId);
  if (Number.isFinite(beforeId) && beforeId > 0) filters.beforeId = beforeId;

  // Explicit account narrowing requested by the caller.
  const requestedMappings = parseListParam(req.query.mappingId);
  const requestedAccounts = parseListParam(req.query.account)?.map(normalizeActor);

  if (canViewAllMappings(req.user)) {
    if (requestedMappings) filters.mappingIds = requestedMappings;
    if (requestedAccounts) filters.twitterUsernames = requestedAccounts;
    return filters;
  }

  // Scoped users: intersect any request with what they own.
  const visibleMappingIds = [...getVisibleMappingIdSet(config, req.user)];
  if (visibleMappingIds.length === 0) return null;
  filters.mappingIds = requestedMappings
    ? requestedMappings.filter((id) => visibleMappingIds.includes(id))
    : visibleMappingIds;
  if (filters.mappingIds.length === 0) return null;

  if (requestedAccounts) {
    const visibleSets = getVisibleMappingIdentitySets(config, req.user);
    const allowed = requestedAccounts.filter((account) => visibleSets.twitterUsernames.has(account));
    if (allowed.length === 0) return null;
    filters.twitterUsernames = allowed;
  }

  return filters;
}

app.get('/api/logs', authenticateToken, (req: any, res) => {
  const filters = buildScopedLogFilters(req);
  if (!filters) {
    res.json({ entries: [], hasMore: false, retention: eventLogService.retention() });
    return;
  }

  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 1000)) : 200;
  // Ask for one extra row so the client knows whether to offer "load more"
  // without a second count query.
  const entries = eventLogService.query({ ...filters, limit: limit + 1 });
  const hasMore = entries.length > limit;

  res.json({
    entries: hasMore ? entries.slice(0, limit) : entries,
    hasMore,
    retention: eventLogService.retention(),
  });
});

app.get('/api/logs/stats', authenticateToken, (req: any, res) => {
  const filters = buildScopedLogFilters(req);
  if (!filters) {
    res.json({ total: 0, byLevel: {}, byStage: {}, topEvents: [], oldestTs: null, newestTs: null });
    return;
  }
  res.json(eventLogService.stats(filters));
});

// Everything recorded about one tweet, in order. Answers "what actually
// happened to this post" in a single request.
app.get('/api/logs/tweet/:twitterId', authenticateToken, (req: any, res) => {
  const twitterId = String(req.params.twitterId || '').trim();
  if (!twitterId) {
    res.status(400).json({ error: 'A tweet id is required.' });
    return;
  }

  const config = getConfig();
  const entries = eventLogService.timelineForTweet(twitterId);
  if (canViewAllMappings(req.user)) {
    res.json({ twitterId, entries });
    return;
  }

  const visibleSets = getVisibleMappingIdentitySets(config, req.user);
  const visibleMappingIds = getVisibleMappingIdSet(config, req.user);
  res.json({
    twitterId,
    entries: entries.filter(
      (entry) =>
        (entry.mappingId && visibleMappingIds.has(entry.mappingId)) ||
        (entry.twitterUsername && visibleSets.twitterUsernames.has(normalizeActor(entry.twitterUsername))) ||
        (entry.bskyIdentifier && visibleSets.bskyIdentifiers.has(normalizeActor(entry.bskyIdentifier))),
    ),
  });
});

// Downloadable export. `format` decides the rendering; every filter accepted by
// /api/logs works here too, so what you are looking at is what you download.
app.get('/api/logs/export', authenticateToken, (req: any, res) => {
  const filters = buildScopedLogFilters(req);
  const requestedFormat = String(req.query.format || 'txt').toLowerCase();
  const format: LogExportFormat = (['json', 'ndjson', 'csv', 'txt'] as const).includes(requestedFormat as any)
    ? (requestedFormat as LogExportFormat)
    : 'txt';

  const limitRaw = Number(req.query.limit);
  const hardLimit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 200_000)) : 50_000;

  const meta = {
    generatedAt: new Date().toISOString(),
    filters: filters ?? {},
    appVersion: getRuntimeVersionInfo().version,
    exportedBy: getActorLabel(req.user),
  };

  const { body, contentType, filename } = filters
    ? exportLogs(format, filters, meta, hardLimit)
    : exportLogs(format, { beforeId: 0 }, meta, 0);

  logEvent({
    level: 'info',
    stage: 'http',
    event: 'logs.exported',
    message: `${getActorLabel(req.user)} exported logs as ${format}.`,
    detail: { format, bytes: body.length, filters: filters ?? {} },
    console: false,
  });

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
});

// One file with everything a bug report needs: recent logs, the current queue
// state, failure groupings and a redacted config summary.
app.get('/api/logs/diagnostics', authenticateToken, requireAdmin, (req: any, res) => {
  const config = getConfig();
  const queueCounts = postQueueService.getCounts();
  const stats = eventLogService.stats({ since: Date.now() - 24 * 60 * 60 * 1000 });
  const entries = eventLogService.query({ limit: 2_000 });

  const bundle = {
    meta: {
      generatedAt: new Date().toISOString(),
      generatedBy: getActorLabel(req.user),
      appVersion: getRuntimeVersionInfo().version,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeSeconds: Math.round(process.uptime()),
      logRetention: eventLogService.retention(),
    },
    // Shape only — no cookies, passwords or tokens.
    configuration: {
      checkIntervalMinutes: config.checkIntervalMinutes,
      mappingCount: config.mappings.length,
      enabledMappingCount: config.mappings.filter((mapping) => mapping.enabled).length,
      twitterCookiesConfigured: Boolean(config.twitter?.authToken && config.twitter?.ct0),
      backupCookiesConfigured: Boolean(config.twitter?.backupAuthToken && config.twitter?.backupCt0),
      mappings: config.mappings.map((mapping) => ({
        id: mapping.id,
        bskyIdentifier: mapping.bskyIdentifier,
        twitterUsernames: mapping.twitterUsernames,
        enabled: mapping.enabled,
      })),
    },
    queue: {
      counts: queueCounts,
      failureSummary: postQueueService.summarizeFailures(),
      failedItems: postQueueService.listItems({ limit: 500, status: 'failed' }),
    },
    logStatsLast24h: stats,
    recentEntries: entries,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tweets-2-bsky-diagnostics-${stamp}.json"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(`${JSON.stringify(bundle, null, 2)}\n`);
});

app.delete('/api/logs', authenticateToken, requireAdmin, (req: any, res) => {
  const cleared = eventLogService.clear();
  logEvent({
    level: 'warn',
    stage: 'system',
    event: 'logs.cleared',
    message: `${getActorLabel(req.user)} cleared the event log (${cleared} entries removed).`,
    detail: { cleared },
  });
  res.json({ success: true, message: `Cleared ${cleared} log entr${cleared === 1 ? 'y' : 'ies'}.` });
});

app.get('/api/version', authenticateToken, (_req, res) => {
  res.json(getRuntimeVersionInfo());
});

app.get('/api/update-status', authenticateToken, requireAdmin, (_req, res) => {
  res.json(getUpdateStatusPayload());
});

app.post('/api/update', authenticateToken, requireAdmin, (req: any, res) => {
  const startedBy = getActorLabel(req.user);
  const result = startUpdateJob(startedBy);
  if (!result.ok) {
    const message = result.message;
    const statusCode = message === 'Update already running.' ? 409 : 500;
    res.status(statusCode).json({ error: message });
    return;
  }

  res.json({
    success: true,
    message: 'Update started. Service may restart automatically.',
    status: result.state,
    version: getRuntimeVersionInfo(),
  });
});

app.post('/api/run-now', authenticateToken, (req: any, res) => {
  if (!canRunNow(req.user)) {
    res.status(403).json({ error: 'You do not have permission to run checks manually.' });
    return;
  }

  requestImmediateSchedulerPass();
  res.json({ success: true, message: 'Check triggered' });
});

app.post('/api/backfill/clear-all', authenticateToken, requireAdmin, (_req, res) => {
  pendingBackfills = [];
  postQueueService.cancelPendingBackfills();
  updateAppStatus({
    state: 'idle',
    message: 'All backfills cleared',
    backfillMappingId: undefined,
    backfillRequestId: undefined,
  });
  signalSchedulerWake();
  res.json({ success: true, message: 'All backfills cleared' });
});

app.post('/api/backfill/:id', authenticateToken, (req: any, res) => {
  if (!canQueueBackfills(req.user)) {
    res.status(403).json({ error: 'You do not have permission to queue backfills.' });
    return;
  }

  const { id } = req.params;
  const { limit } = req.body;
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have access to this mapping.' });
    return;
  }

  if (!Array.isArray(mapping.twitterUsernames) || mapping.twitterUsernames.length === 0) {
    res.status(400).json({ error: 'Mapping has no Twitter source accounts configured.' });
    return;
  }

  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 200)) : undefined;
  const queuedAt = Date.now();
  const sequence = backfillSequence++;
  const requestId = randomUUID();
  pendingBackfills = pendingBackfills.filter((entry) => entry.id !== id);
  pendingBackfills.push({
    id,
    limit: safeLimit,
    queuedAt,
    sequence,
    requestId,
  });
  pendingBackfills.sort((a, b) => a.sequence - b.sequence);
  signalSchedulerWake();

  res.json({
    success: true,
    message: `Backfill queued for @${mapping.twitterUsernames.join(', ')}`,
    requestId,
  });
});

app.post('/api/pin-sync/:id', authenticateToken, (req: any, res) => {
  if (!canQueueBackfills(req.user)) {
    res.status(403).json({ error: 'You do not have permission to sync pinned tweets.' });
    return;
  }

  const { id } = req.params;
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have access to this mapping.' });
    return;
  }

  if (!Array.isArray(mapping.twitterUsernames) || mapping.twitterUsernames.length === 0) {
    res.status(400).json({ error: 'Mapping has no Twitter source accounts configured.' });
    return;
  }

  pendingPinSyncs = pendingPinSyncs.filter((entry) => entry.id !== id);
  pendingPinSyncs.push({ id, queuedAt: Date.now(), requestId: randomUUID() });
  signalSchedulerWake();

  res.json({
    success: true,
    message: `Pin sync queued for ${mapping.bskyIdentifier}`,
  });
});

app.delete('/api/backfill/:id', authenticateToken, (req: any, res) => {
  const { id } = req.params;
  const config = getConfig();
  const mapping = config.mappings.find((entry) => entry.id === id);

  if (!mapping) {
    res.status(404).json({ error: 'Mapping not found' });
    return;
  }

  if (!canManageMapping(req.user, mapping)) {
    res.status(403).json({ error: 'You do not have permission to update this queue entry.' });
    return;
  }

  pendingBackfills = pendingBackfills.filter((entry) => entry.id !== id);
  postQueueService.cancelPendingBackfills(id);
  signalSchedulerWake();
  res.json({ success: true });
});

// --- Config Management Routes ---

app.get('/api/config/export', authenticateToken, requireAdmin, (_req, res) => {
  const config = getConfig();
  const { users, ...cleanConfig } = config;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=tweets-2-bsky-config.json');
  res.json(cleanConfig);
});

app.post('/api/config/import', authenticateToken, requireAdmin, (req, res) => {
  try {
    const importData = req.body;
    const currentConfig = getConfig();

    if (!importData.mappings || !Array.isArray(importData.mappings)) {
      res.status(400).json({ error: 'Invalid config format: missing mappings array' });
      return;
    }

    const newConfig = {
      ...currentConfig,
      mappings: importData.mappings,
      groups: Array.isArray(importData.groups) ? importData.groups : currentConfig.groups,
      twitter: importData.twitter || currentConfig.twitter,
      ai: importData.ai || currentConfig.ai,
      checkIntervalMinutes: importData.checkIntervalMinutes || currentConfig.checkIntervalMinutes,
    };

    saveConfig(newConfig);
    res.json({ success: true, message: 'Configuration imported successfully' });
  } catch (err) {
    console.error('Import failed:', err);
    res.status(500).json({ error: 'Failed to process import file' });
  }
});

app.get('/api/recent-activity', authenticateToken, (req: any, res) => {
  const limitCandidate = req.query.limit ? Number(req.query.limit) : 50;
  const limit = Number.isFinite(limitCandidate) ? Math.max(1, Math.min(limitCandidate, 200)) : 50;
  const config = getConfig();
  const visibleSets = getVisibleMappingIdentitySets(config, req.user);
  const scanLimit = canViewAllMappings(req.user) ? limit : Math.max(limit * 6, 150);

  const tweets = dbService.getRecentProcessedTweets(scanLimit);
  const filtered = canViewAllMappings(req.user)
    ? tweets
    : tweets.filter(
        (tweet) =>
          visibleSets.twitterUsernames.has(normalizeActor(tweet.twitter_username)) ||
          visibleSets.bskyIdentifiers.has(normalizeActor(tweet.bsky_identifier)),
      );

  res.json(filtered.slice(0, limit));
});

app.post('/api/bsky/profiles', authenticateToken, async (req, res) => {
  const actors = Array.isArray(req.body?.actors)
    ? req.body.actors.filter((actor: unknown) => typeof actor === 'string')
    : [];

  if (actors.length === 0) {
    res.json({});
    return;
  }

  const limitedActors = actors.slice(0, 200);
  const profiles = await fetchProfilesByActor(limitedActors);
  res.json(profiles);
});

app.get('/api/posts/search', authenticateToken, (req: any, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  if (!query.trim()) {
    res.json([]);
    return;
  }

  const requestedLimit = req.query.limit ? Number(req.query.limit) : 80;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 80;
  const searchLimit = Math.min(200, Math.max(80, limit * 4));
  const config = getConfig();
  const visibleSets = getVisibleMappingIdentitySets(config, req.user);

  const scopedRows = dbService
    .searchMigratedTweets(query, searchLimit)
    .filter(
      (row) =>
        canViewAllMappings(req.user) ||
        visibleSets.twitterUsernames.has(normalizeActor(row.twitter_username)) ||
        visibleSets.bskyIdentifiers.has(normalizeActor(row.bsky_identifier)),
    )
    .slice(0, limit);

  const results = scopedRows.map<LocalPostSearchResult>((row) => ({
    twitterId: row.twitter_id,
    twitterUsername: row.twitter_username,
    bskyIdentifier: row.bsky_identifier,
    tweetText: row.tweet_text,
    bskyUri: row.bsky_uri,
    bskyCid: row.bsky_cid,
    createdAt: row.created_at,
    postUrl: buildPostUrl(row.bsky_identifier, row.bsky_uri),
    twitterUrl: buildTwitterPostUrl(row.twitter_username, row.twitter_id),
    score: Number(row.score.toFixed(2)),
  }));

  res.json(results);
});

app.get('/api/posts/enriched', authenticateToken, async (req: any, res) => {
  const requestedLimit = req.query.limit ? Number(req.query.limit) : 24;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 80)) : 24;
  const config = getConfig();
  const visibleSets = getVisibleMappingIdentitySets(config, req.user);

  const recent = dbService.getRecentProcessedTweets(limit * 8);
  const migratedWithUri = recent.filter(
    (row) =>
      row.status === 'migrated' &&
      row.bsky_uri &&
      (canViewAllMappings(req.user) ||
        visibleSets.twitterUsernames.has(normalizeActor(row.twitter_username)) ||
        visibleSets.bskyIdentifiers.has(normalizeActor(row.bsky_identifier))),
  );

  const deduped: ProcessedTweet[] = [];
  const seenUris = new Set<string>();
  for (const row of migratedWithUri) {
    const uri = row.bsky_uri;
    if (!uri || seenUris.has(uri)) continue;
    seenUris.add(uri);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }

  const uris = deduped.map((row) => row.bsky_uri).filter((uri): uri is string => typeof uri === 'string');
  const postViewsByUri = await fetchPostViewsByUri(uris);
  const enriched = deduped.map((row) => buildEnrichedPost(row, row.bsky_uri ? postViewsByUri.get(row.bsky_uri) : null));

  res.json(enriched);
});
// Export for use by index.ts
export function updateLastCheckTime() {
  const config = getConfig();
  lastCheckTime = Date.now();
  nextCheckTime = lastCheckTime + (config.checkIntervalMinutes || 5) * 60 * 1000;
}

export function updateAppStatus(status: Partial<AppStatus>) {
  currentAppStatus = {
    ...currentAppStatus,
    ...status,
    lastUpdate: Date.now(),
  };
}

export function getPendingBackfills(): PendingBackfill[] {
  return [...pendingBackfills].sort((a, b) => a.sequence - b.sequence);
}

export function getNextCheckTime(): number {
  return nextCheckTime;
}

export function getSchedulerWakeSignal(): number {
  return schedulerWakeSignal;
}

export function triggerImmediateRun(): void {
  requestImmediateSchedulerPass();
}

export function clearBackfill(id: string, requestId?: string) {
  if (requestId) {
    pendingBackfills = pendingBackfills.filter((bid) => !(bid.id === id && bid.requestId === requestId));
    return;
  }
  pendingBackfills = pendingBackfills.filter((bid) => bid.id !== id);
}

// Serve the frontend for any other route (middleware approach for Express 5)
app.use((_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(staticAssetsDir, 'index.html'));
});

export function startServer() {
  app.listen(PORT, HOST as any, () => {
    console.log(`🚀 Web interface running at http://localhost:${PORT}`);
    if (HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost') {
      console.log(`🔒 Bound to ${HOST} (local-only). Use Tailscale Serve or a reverse proxy for remote access.`);
      return;
    }
    console.log('📡 Accessible on your local network/Tailscale via your IP.');
  });
}
