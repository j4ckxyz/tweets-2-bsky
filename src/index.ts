import 'dotenv/config';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BskyAgent, RichText } from '@atproto/api';
import type { BlobRef } from '@atproto/api';
import { Scraper } from '@the-convocation/twitter-scraper';
import type { Tweet as ScraperTweet } from '@the-convocation/twitter-scraper';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Command } from 'commander';
import * as francModule from 'franc-min';
import iso6391 from 'iso-639-1';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { generateAltText, isAltTextConfigured } from './ai-manager.js';

import { getConfig, saveConfig } from './config-manager.js';
import { applyProfileMirrorSyncState, syncBlueskyProfileFromTwitter } from './profile-mirror.js';
import {
  buildPollNote,
  detectCardMedia,
  detectCarouselLinks,
  ensureSponsoredLinks,
  recoverCardData,
} from './tweet-cards.js';
import type { MediaEntity, TweetCard, TweetEntities } from './tweet-cards.js';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Type Definitions
// ============================================================================

interface ProcessedTweetEntry {
  uri?: string;
  cid?: string;
  root?: { uri: string; cid: string };
  tail?: { uri: string; cid: string };
  migrated?: boolean;
  skipped?: boolean;
  text?: string;
}

interface ProcessedTweetsMap {
  [twitterId: string]: ProcessedTweetEntry;
}

interface Tweet {
  id?: string;
  id_str?: string;
  text?: string;
  full_text?: string;
  created_at?: string;
  entities?: TweetEntities;
  extended_entities?: TweetEntities;
  quoted_status_id_str?: string;
  retweeted_status_id_str?: string;
  is_quote_status?: boolean;
  in_reply_to_status_id_str?: string;
  in_reply_to_status_id?: string;
  in_reply_to_user_id_str?: string;
  in_reply_to_user_id?: string;
  isRetweet?: boolean;
  isPin?: boolean;
  possibly_sensitive?: boolean;
  user?: {
    screen_name?: string;
    id_str?: string;
  };
  card?: TweetCard | null;
  permanentUrl?: string;
}

interface AspectRatio {
  width: number;
  height: number;
}

interface ImageEmbed {
  alt: string;
  image: BlobRef;
  aspectRatio?: AspectRatio;
}

import { dbService, postQueueService } from './db.js';
import type { QueueBatch } from './db.js';

// ============================================================================
// State Management
// ============================================================================

const PROCESSED_DIR = path.join(__dirname, '..', 'processed');

async function migrateJsonToSqlite() {
  if (!fs.existsSync(PROCESSED_DIR)) return;

  const files = fs.readdirSync(PROCESSED_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return;

  console.log(`📦 Found ${files.length} legacy cache files. Migrating to SQLite...`);
  const config = getConfig();

  for (const file of files) {
    const username = file.replace('.json', '').toLowerCase();
    // Try to find a matching bskyIdentifier from config
    const mapping = config.mappings.find((m) => m.twitterUsernames.map((u) => u.toLowerCase()).includes(username));
    const bskyIdentifier = mapping?.bskyIdentifier || 'unknown';

    try {
      const filePath = path.join(PROCESSED_DIR, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ProcessedTweetsMap;

      for (const [twitterId, entry] of Object.entries(data)) {
        dbService.saveTweet({
          twitter_id: twitterId,
          twitter_username: username,
          bsky_identifier: bskyIdentifier,
          bsky_uri: entry.uri,
          bsky_cid: entry.cid,
          bsky_root_uri: entry.root?.uri,
          bsky_root_cid: entry.root?.cid,
          status: entry.migrated ? 'migrated' : entry.skipped ? 'skipped' : 'failed',
        });
      }
      // Move file to backup
      const backupDir = path.join(PROCESSED_DIR, 'backup');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
      fs.renameSync(filePath, path.join(backupDir, file));
    } catch (err) {
      console.error(`❌ Failed to migrate ${file}:`, err);
    }
  }

  // REPAIR STEP: Fix any 'unknown' records in SQLite that came from the broken schema migration
  for (const mapping of config.mappings) {
    for (const username of mapping.twitterUsernames) {
      dbService.repairUnknownIdentifiers(username, mapping.bskyIdentifier);
    }
  }

  console.log('✅ Migration complete.');
}

function loadProcessedTweets(bskyIdentifier: string): ProcessedTweetsMap {
  return dbService.getTweetsByBskyIdentifier(bskyIdentifier);
}

function saveProcessedTweet(
  twitterUsername: string,
  bskyIdentifier: string,
  twitterId: string,
  entry: ProcessedTweetEntry,
): void {
  dbService.saveTweet({
    twitter_id: twitterId,
    twitter_username: twitterUsername.toLowerCase(),
    bsky_identifier: bskyIdentifier.toLowerCase(),
    tweet_text: entry.text,
    bsky_uri: entry.uri,
    bsky_cid: entry.cid,
    bsky_root_uri: entry.root?.uri,
    bsky_root_cid: entry.root?.cid,
    bsky_tail_uri: entry.tail?.uri,
    bsky_tail_cid: entry.tail?.cid,
    status: entry.migrated || (entry.uri && entry.cid) ? 'migrated' : entry.skipped ? 'skipped' : 'failed',
  });
}

// ============================================================================
// Custom Twitter Client
// ============================================================================

const scraperSessions = new Map<string, Scraper>();
const sessionCookies = new Map<string, { authToken: string; ct0: string }>();
let useBackupCredentials = false;
const lastCreatedAtByBsky = new Map<string, number>();
const SUBBRANCH_COUNT = 5;

// --- Pipeline tunables (env-overridable) ---
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (Number.isFinite(raw)) return Math.min(max, Math.max(min, Math.round(raw)));
  return fallback;
}

// How many timeline fetches run concurrently during a sweep. All sessions
// share one Twitter login, so the global scraper gap below is what actually
// bounds the request rate — this only hides per-request latency.
const FETCH_CONCURRENCY = envInt('FETCH_CONCURRENCY', 4, 1, 16);
// How many Bluesky accounts post from the queue at once. Media downloads can
// buffer hundreds of MB each, so keep this aligned with available RAM.
const POST_WORKER_CONCURRENCY = envInt('POST_WORKER_CONCURRENCY', 5, 1, 16);
// Pause between posted tweets within one account. Bluesky's own rate limit is
// ~1,666 posts/hour per account, so this is cosmetic pacing, not protection —
// and since it now runs inside a per-account worker it never delays others.
const POST_PACING_MIN_MS = envInt('POST_PACING_MIN_MS', 3000, 0, 120_000);
const POST_PACING_MAX_MS = Math.max(envInt('POST_PACING_MAX_MS', 8000, 0, 300_000), POST_PACING_MIN_MS);
// Retries per queued tweet before it is parked as failed (visible in the UI).
const QUEUE_MAX_ATTEMPTS = envInt('QUEUE_MAX_ATTEMPTS', 8, 1, 50);
// Minimum spacing between Twitter API calls across the whole process, plus
// random jitter. This is the single knob that controls scraper-account risk:
// every timeline fetch and tweet lookup waits for a slot here.
const SCRAPER_MIN_GAP_MS = envInt('SCRAPER_MIN_GAP_MS', 800, 0, 60_000);
const SCRAPER_JITTER_MS = envInt('SCRAPER_JITTER_MS', 400, 0, 60_000);

// Timestamped logging for the pipeline halves, so sweep cadence and queue
// latency can be read straight off the logs (PM2/Docker don't always add
// their own timestamps).
const logPipeline = (tag: 'Sweep' | 'Queue', message: string, isError = false): void => {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${stamp}] [${tag}] ${message}`;
  if (isError) console.error(line);
  else console.log(line);
};

const formatDurationMs = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
};

let scraperNextSlotMs = 0;
async function acquireScraperSlot(): Promise<void> {
  const gap = SCRAPER_MIN_GAP_MS + Math.floor(Math.random() * (SCRAPER_JITTER_MS + 1));
  const now = Date.now();
  const slot = Math.max(now, scraperNextSlotMs);
  scraperNextSlotMs = slot + gap;
  if (slot > now) {
    await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

function getUniqueCreatedAtIso(bskyIdentifier: string, desiredMs: number): string {
  const key = bskyIdentifier.toLowerCase();
  const lastMs = lastCreatedAtByBsky.get(key) ?? Number.MIN_SAFE_INTEGER;
  const nextMs = Math.max(desiredMs, lastMs + 1);
  lastCreatedAtByBsky.set(key, nextMs);
  return new Date(nextMs).toISOString();
}

function getActiveTwitterCredentials(): { authToken: string; ct0: string } | null {
  const config = getConfig();
  let authToken = config.twitter.authToken;
  let ct0 = config.twitter.ct0;

  // Use backup if toggled
  if (useBackupCredentials && config.twitter.backupAuthToken && config.twitter.backupCt0) {
    authToken = config.twitter.backupAuthToken;
    ct0 = config.twitter.backupCt0;
  }

  if (!authToken || !ct0) return null;
  return { authToken, ct0 };
}

async function getTwitterScraper(sessionKey = 'default', forceReset = false): Promise<Scraper | null> {
  const credentials = getActiveTwitterCredentials();
  if (!credentials) return null;
  const { authToken, ct0 } = credentials;

  // Re-initialize if config changed, not yet initialized, or forced reset
  const existingScraper = scraperSessions.get(sessionKey);
  const existingCookies = sessionCookies.get(sessionKey);
  if (!existingScraper || forceReset || existingCookies?.authToken !== authToken || existingCookies?.ct0 !== ct0) {
    console.log(`🔄 Initializing Twitter scraper with ${useBackupCredentials ? 'BACKUP' : 'PRIMARY'} credentials...`);
    const scraper = new Scraper();
    await scraper.setCookies([`auth_token=${authToken}`, `ct0=${ct0}`]);
    scraperSessions.set(sessionKey, scraper);
    sessionCookies.set(sessionKey, {
      authToken: authToken,
      ct0: ct0,
    });
  }
  return scraperSessions.get(sessionKey) ?? null;
}

async function switchCredentials() {
  const config = getConfig();
  if (config.twitter.backupAuthToken && config.twitter.backupCt0) {
    useBackupCredentials = !useBackupCredentials;
    console.log(`⚠️ Switching to ${useBackupCredentials ? 'BACKUP' : 'PRIMARY'} Twitter credentials...`);
    scraperSessions.clear();
    sessionCookies.clear();
    return true;
  }
  console.log('⚠️ No backup credentials available to switch to.');
  return false;
}

// Public web bearer token (stable since 2018), used by every browser session.
const TWITTER_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

let cachedUserTweetsUrlTemplate: string | null | undefined;

// X dropped pinned_tweet_ids_str from the profile endpoint, so the only place
// the pinned tweet id still appears is the UserTweets timeline payload — which
// the scraper parses but does not expose. Read the request URL template from
// the installed scraper bundle (keeps queryId/features in sync with the
// package) so we can make the same call and extract the pin ourselves.
function getUserTweetsUrlTemplate(): string | null {
  if (cachedUserTweetsUrlTemplate !== undefined) return cachedUserTweetsUrlTemplate;
  cachedUserTweetsUrlTemplate = null;
  try {
    const require = createRequire(import.meta.url);
    const entryPath = require.resolve('@the-convocation/twitter-scraper');
    const candidates = [entryPath, path.join(path.dirname(entryPath), '..', 'esm', 'index.mjs')];
    for (const candidate of candidates) {
      try {
        const source = fs.readFileSync(candidate, 'utf8');
        const match = source.match(/UserTweets:\s*["'](https:\/\/[^"']+)["']/);
        if (match?.[1]) {
          cachedUserTweetsUrlTemplate = match[1];
          break;
        }
      } catch {
        // try next candidate
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not read UserTweets endpoint from scraper bundle:', (err as Error).message);
  }
  return cachedUserTweetsUrlTemplate;
}

type PinnedTweetLookup = { ok: true; pinnedTweetId?: string } | { ok: false };

async function fetchPinnedTweetId(scraper: Scraper, username: string): Promise<PinnedTweetLookup> {
  // Preferred path, in case the scraper exposes it again in a future version
  try {
    await acquireScraperSlot();
    const profile = await scraper.getProfile(username);
    if (profile.pinnedTweetIds && profile.pinnedTweetIds.length > 0) {
      return { ok: true, pinnedTweetId: profile.pinnedTweetIds[0] };
    }
  } catch (err) {
    console.warn(`[${username}] ⚠️ Profile lookup failed during pin sync:`, (err as Error).message);
  }

  const urlTemplate = getUserTweetsUrlTemplate();
  const credentials = getActiveTwitterCredentials();
  if (!urlTemplate || !credentials) return { ok: false };

  try {
    await acquireScraperSlot();
    const userId = await scraper.getUserIdByScreenName(username);
    const url = urlTemplate.replace(/%22userId%22%3A%22\d+%22/, `%22userId%22%3A%22${userId}%22`);
    await acquireScraperSlot();
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        authorization: `Bearer ${TWITTER_WEB_BEARER}`,
        cookie: `auth_token=${credentials.authToken}; ct0=${credentials.ct0}`,
        'x-csrf-token': credentials.ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: raw GraphQL payload
    const instructions: any[] = res.data?.data?.user?.result?.timeline?.timeline?.instructions ?? [];
    for (const instruction of instructions) {
      if (instruction?.type === 'TimelinePinEntry') {
        const match = String(instruction.entry?.entryId ?? '').match(/tweet-(\d+)/);
        if (match?.[1]) return { ok: true, pinnedTweetId: match[1] };
      }
    }

    // Fallback: the author's user object inside any tweet still carries the field
    // biome-ignore lint/suspicious/noExplicitAny: raw GraphQL payload
    const findAuthorPin = (node: any): string | undefined | null => {
      if (!node || typeof node !== 'object') return undefined;
      if (node.rest_id === userId && node.legacy && Array.isArray(node.legacy.pinned_tweet_ids_str)) {
        return node.legacy.pinned_tweet_ids_str[0] ?? null; // null = author found, no pin
      }
      for (const value of Object.values(node)) {
        const found = findAuthorPin(value);
        if (found !== undefined) return found;
      }
      return undefined;
    };

    const found = findAuthorPin(res.data);
    if (found !== undefined) {
      return { ok: true, pinnedTweetId: found ?? undefined };
    }
    return { ok: false };
  } catch (err) {
    console.warn(`[${username}] ⚠️ Raw pinned-tweet lookup failed:`, (err as Error).message);
    return { ok: false };
  }
}

function mapScraperTweetToLocalTweet(scraperTweet: ScraperTweet): Tweet {
  const raw = scraperTweet.__raw_UNSTABLE;
  if (!raw) {
    // Fallback if raw data is missing (shouldn't happen for timeline tweets usually)
    return {
      id: scraperTweet.id,
      id_str: scraperTweet.id,
      text: scraperTweet.text,
      full_text: scraperTweet.text,
      isRetweet: scraperTweet.isRetweet,
      // Construct minimal entities from parsed data
      entities: {
        urls: scraperTweet.urls.map((url: string) => ({ url, expanded_url: url })),
        media: scraperTweet.photos.map((p: any) => ({
          url: p.url,
          expanded_url: p.url,
          media_url_https: p.url,
          type: 'photo',
          ext_alt_text: p.alt_text,
        })),
      },
      created_at: scraperTweet.timeParsed?.toUTCString(),
      permanentUrl: scraperTweet.permanentUrl,
      isPin: scraperTweet.isPin,
      possibly_sensitive: scraperTweet.sensitiveContent,
    };
  }

  return {
    id: raw.id_str,
    id_str: raw.id_str,
    text: raw.full_text,
    full_text: raw.full_text,
    created_at: raw.created_at,
    isRetweet: scraperTweet.isRetweet,
    isPin: scraperTweet.isPin,
    // biome-ignore lint/suspicious/noExplicitAny: missing in LegacyTweetRaw type
    possibly_sensitive: Boolean((raw as any).possibly_sensitive) || scraperTweet.sensitiveContent,
    // biome-ignore lint/suspicious/noExplicitAny: raw types match compatible structure
    entities: raw.entities as any,
    // biome-ignore lint/suspicious/noExplicitAny: raw types match compatible structure
    extended_entities: raw.extended_entities as any,
    quoted_status_id_str: raw.quoted_status_id_str,
    retweeted_status_id_str: raw.retweeted_status_id_str,
    is_quote_status: !!raw.quoted_status_id_str,
    in_reply_to_status_id_str: raw.in_reply_to_status_id_str,
    // biome-ignore lint/suspicious/noExplicitAny: missing in LegacyTweetRaw type
    in_reply_to_user_id_str: (raw as any).in_reply_to_user_id_str,
    // biome-ignore lint/suspicious/noExplicitAny: card comes from raw tweet
    card: (raw as any).card,
    permanentUrl: scraperTweet.permanentUrl,
    user: {
      screen_name: scraperTweet.username,
      id_str: scraperTweet.userId,
    },
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

// Mirror Twitter's sensitive-media flags as Bluesky self labels. Per-media
// warnings map to specific labels; the tweet-level possibly_sensitive flag has
// no category, so it maps to the mildest adult label.
function buildSensitiveLabels(tweet: Tweet, mediaEntities: MediaEntity[]): string[] {
  const values = new Set<string>();
  for (const media of mediaEntities) {
    const warning = media.ext_sensitive_media_warning;
    if (!warning) continue;
    if (warning.adult_content) values.add('porn');
    if (warning.graphic_violence) values.add('graphic-media');
    if (warning.other) values.add('graphic-media');
  }
  if (values.size === 0 && tweet.possibly_sensitive) {
    values.add('sexual');
  }
  return [...values];
}

function addTextFallbacks(text: string): string {
  return text.replace(/\s+$/g, '').trim();
}

function getTweetText(tweet: Tweet): string {
  return tweet.full_text || tweet.text || '';
}

function normalizeContextText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function addTweetsToMap(tweetMap: Map<string, Tweet>, tweets: Tweet[]): void {
  for (const tweet of tweets) {
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;
    tweetMap.set(String(tweetId), tweet);
  }
}

function buildThreadContext(tweet: Tweet, tweetMap: Map<string, Tweet>, maxHops = 8): string {
  const parts: string[] = [];
  const visited = new Set<string>();
  let current: Tweet | undefined = tweet;

  for (let hops = 0; hops < maxHops; hops++) {
    const parentId = current?.in_reply_to_status_id_str || current?.in_reply_to_status_id;
    if (!parentId) break;
    const parentKey = String(parentId);
    if (visited.has(parentKey)) break;
    visited.add(parentKey);

    const parentTweet = tweetMap.get(parentKey);
    if (!parentTweet) break;

    const parentText = normalizeContextText(getTweetText(parentTweet));
    if (parentText) parts.push(parentText);

    current = parentTweet;
  }

  if (parts.length === 0) return '';
  return parts.reverse().join(' | ');
}

function buildAltTextContext(tweet: Tweet, tweetText: string, tweetMap: Map<string, Tweet>): string {
  const threadContext = buildThreadContext(tweet, tweetMap);
  const currentText = normalizeContextText(tweetText);

  if (threadContext && currentText) {
    return `Thread above: ${threadContext}. Current tweet: ${currentText}`;
  }

  if (threadContext) return `Thread above: ${threadContext}.`;
  return currentText;
}

function detectLanguage(text: string): string[] {
  if (!text || text.trim().length === 0) return ['en'];
  try {
    const code3 = (francModule as unknown as (text: string) => string)(text);
    if (code3 === 'und') return ['en'];
    const code2 = iso6391.getCode(code3);
    return code2 ? [code2] : ['en'];
  } catch {
    return ['en'];
  }
}

async function expandUrl(shortUrl: string): Promise<string> {
  try {
    const response = await axios.head(shortUrl, {
      maxRedirects: 5,
      timeout: 10000,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    // biome-ignore lint/suspicious/noExplicitAny: axios internal types
    return (response.request as any)?.res?.responseUrl || shortUrl;
  } catch {
    try {
      const response = await axios.get(shortUrl, {
        responseType: 'stream',
        maxRedirects: 5,
        timeout: 10000,
      });
      response.data.destroy();
      // biome-ignore lint/suspicious/noExplicitAny: axios internal types
      return (response.request as any)?.res?.responseUrl || shortUrl;
    } catch (e: any) {
      if (e.code === 'ERR_FR_TOO_MANY_REDIRECTS' || e.response?.status === 403 || e.response?.status === 401) {
        // Silent fallback for common expansion issues (redirect loops, login walls)
        return shortUrl;
      }
      return shortUrl;
    }
  }
}

interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
}

// Hard cap on media downloads. Bluesky rejects videos over 300MB anyway, so
// anything larger aborts early (→ link fallback) instead of buffering gigabytes
// of RAM — with 5 subbranches downloading in parallel that risks OOM.
const MAX_MEDIA_DOWNLOAD_BYTES = 320 * 1024 * 1024;

async function downloadMedia(url: string, maxDurationMs = 120000): Promise<DownloadedMedia> {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'arraybuffer',
    // axios `timeout` only fires on socket inactivity; the abort signal enforces
    // a hard deadline so a slow-trickling large download can't stall the pipeline.
    timeout: 30000,
    signal: AbortSignal.timeout(maxDurationMs),
    maxContentLength: MAX_MEDIA_DOWNLOAD_BYTES,
    maxBodyLength: MAX_MEDIA_DOWNLOAD_BYTES,
  });
  return {
    buffer: Buffer.from(response.data as ArrayBuffer),
    mimeType: (response.headers['content-type'] as string) || 'application/octet-stream',
  };
}

const BLOB_UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;

async function uploadToBluesky(agent: BskyAgent, buffer: Buffer, mimeType: string): Promise<BlobRef> {
  let finalBuffer = buffer;
  let finalMimeType = mimeType;
  // Bluesky accepts image blobs up to 2MB; stay slightly under for safety.
  const MAX_SIZE = 1900 * 1024;

  const isPng = mimeType === 'image/png';
  const isJpeg = mimeType === 'image/jpeg' || mimeType === 'image/jpg';
  const isWebp = mimeType === 'image/webp';
  const isGif = mimeType === 'image/gif';
  const isAnimation = isGif || isWebp;

  if (
    (buffer.length > MAX_SIZE && (mimeType.startsWith('image/') || mimeType === 'application/octet-stream')) ||
    (isPng && buffer.length > MAX_SIZE)
  ) {
    console.log(`[UPLOAD] ⚖️ Image too large (${(buffer.length / 1024).toFixed(2)} KB). Optimizing...`);
    try {
      let image = sharp(buffer);
      const metadata = await image.metadata();
      let currentBuffer = buffer;
      let width = metadata.width || 2000;
      let quality = 95;

      // Iterative compression loop. With the 2MB ceiling we can afford to keep
      // media crisp: large dimensions, gentle quality steps, high quality floor.
      let attempts = 0;
      while (currentBuffer.length > MAX_SIZE && attempts < 5) {
        attempts++;
        console.log(`[UPLOAD] 📉 Compression attempt ${attempts}: Width ${width}, Quality ${quality}...`);

        let attemptMimeType: string;
        if (isAnimation) {
          // For animations (GIF/WebP), we can only do so much without losing frames.
          // Convert GIF to WebP for better compression, or re-encode WebP.
          image = sharp(buffer, { animated: true });
          // Resize if really big
          if (metadata.width && metadata.width > 1280) {
            image = image.resize({ width: 1280, withoutEnlargement: true });
          }
          image = image.webp({ quality, effort: 6 });
          attemptMimeType = 'image/webp';
          quality = Math.max(60, quality - 10);
        } else {
          // Static images
          if (width > 2560) width = 2560;
          else if (attempts > 1) width = Math.floor(width * 0.85);

          quality = Math.max(70, quality - 5);

          image = sharp(buffer).resize({ width, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true });

          attemptMimeType = 'image/jpeg';
        }

        currentBuffer = await image.toBuffer();
        // Keep the smallest result so far, even if still above the limit.
        if (currentBuffer.length < finalBuffer.length) {
          finalBuffer = currentBuffer;
          finalMimeType = attemptMimeType;
        }
        if (currentBuffer.length <= MAX_SIZE) {
          console.log(`[UPLOAD] ✅ Optimized to ${(currentBuffer.length / 1024).toFixed(2)} KB`);
          break;
        }
      }
    } catch (err) {
      console.warn('[UPLOAD] ⚠️ Optimization failed:', (err as Error).message);
    }

    // Bluesky rejects image blobs over the embed size limit at post time; uploading
    // an oversized blob "succeeds" but leaves the tweet permanently failing. Bail out
    // instead so callers can fall back to the standard-quality image or skip this one.
    if (finalBuffer.length > MAX_SIZE) {
      throw new Error(
        `Image still ${(finalBuffer.length / 1024).toFixed(2)} KB after optimization (limit ${(MAX_SIZE / 1024).toFixed(0)} KB)`,
      );
    }
  }

  const { data } = await withTimeout(
    agent.uploadBlob(finalBuffer, { encoding: finalMimeType }),
    BLOB_UPLOAD_TIMEOUT_MS,
    `Blob upload timed out after ${Math.round(BLOB_UPLOAD_TIMEOUT_MS / 1000)}s`,
  );
  return data.blob;
}

interface ScreenshotResult {
  buffer: Buffer;
  width: number;
  height: number;
}

async function captureTweetScreenshot(tweetUrl: string): Promise<ScreenshotResult | null> {
  const browserPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  const executablePath = browserPaths.find((p) => fs.existsSync(p));

  if (!executablePath) {
    console.warn('[SCREENSHOT] ⏩ Skipping screenshot (no Chrome/Chromium found at common paths).');
    return null;
  }

  console.log(`[SCREENSHOT] 📸 Capturing screenshot for: ${tweetUrl} using ${executablePath}`);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    browser = await puppeteer.launch({
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 1200, deviceScaleFactor: 2 });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { 
            margin: 0; 
            padding: 20px; 
            background: #ffffff; 
            display: flex; 
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          }
          #container { width: 550px; }
        </style>
      </head>
      <body>
        <div id="container">
          <blockquote class="twitter-tweet" data-dnt="true">
            <a href="${tweetUrl}"></a>
          </blockquote>
          <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>
        </div>
      </body>
      </html>
    `;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Wait for the twitter iframe to load and render
    try {
      await page.waitForSelector('iframe', { timeout: 10000 });
      // Small extra wait for images inside iframe
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.warn('[SCREENSHOT] ⚠️ Timeout waiting for tweet iframe, taking screenshot anyway.');
    }

    const element = await page.$('#container');
    if (element) {
      const box = await element.boundingBox();
      const buffer = await element.screenshot({ type: 'png', omitBackground: true });
      if (box) {
        console.log(
          `[SCREENSHOT] ✅ Captured successfully (${(buffer.length / 1024).toFixed(2)} KB) - ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
        return { buffer: buffer as Buffer, width: Math.round(box.width), height: Math.round(box.height) };
      }
    }
  } catch (err) {
    console.error('[SCREENSHOT] ❌ Error capturing tweet:', (err as Error).message);
  } finally {
    if (browser) await browser.close();
  }
  return null;
}

async function pollForVideoProcessing(agent: BskyAgent, jobId: string): Promise<BlobRef> {
  console.log('[VIDEO] ⏳ Polling for processing completion (this can take a minute)...');
  let attempts = 0;
  let blob: BlobRef | undefined;

  while (!blob) {
    attempts++;
    const statusUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.getJobStatus');
    statusUrl.searchParams.append('jobId', jobId);

    let statusResponse: Response;
    try {
      statusResponse = await fetch(statusUrl, { signal: AbortSignal.timeout(30000) });
    } catch (err) {
      console.warn(`[VIDEO] ⚠️ Job status fetch errored (${(err as Error).message}), retrying...`);
      if (attempts > 60) throw new Error('Video processing timed out after 5 minutes.');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    if (!statusResponse.ok) {
      console.warn(`[VIDEO] ⚠️ Job status fetch failed (${statusResponse.status}), retrying...`);
      if (attempts > 60) throw new Error('Video processing timed out after 5 minutes.');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    const statusData = (await statusResponse.json()) as any;
    const state = statusData.jobStatus.state;
    const progress = statusData.jobStatus.progress || 0;

    console.log(`[VIDEO] 🔄 Job ${jobId}: ${state} (${progress}%)`);

    if (statusData.jobStatus.blob) {
      blob = statusData.jobStatus.blob;
      console.log('[VIDEO] 🎉 Video processing complete! Blob ref obtained.');
    } else if (state === 'JOB_STATE_FAILED') {
      throw new Error(`Video processing failed: ${statusData.jobStatus.error || 'Unknown error'}`);
    } else {
      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    if (attempts > 60) {
      // ~5 minute timeout
      throw new Error('Video processing timed out after 5 minutes.');
    }
  }
  return blob!;
}

async function fetchEmbedUrlCard(agent: BskyAgent, url: string): Promise<any> {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    const $ = cheerio.load(response.data);
    const title = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
    const description =
      $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
    let thumbBlob: BlobRef | undefined;

    let imageUrl = $('meta[property="og:image"]').attr('content');
    if (imageUrl) {
      if (!imageUrl.startsWith('http')) {
        const baseUrl = new URL(url);
        imageUrl = new URL(imageUrl, baseUrl.origin).toString();
      }
      try {
        const { buffer, mimeType } = await downloadMedia(imageUrl);
        thumbBlob = await uploadToBluesky(agent, buffer, mimeType);
      } catch (e) {
        // SIlently fail thumbnail upload
      }
    }

    if (!title && !description) return null;

    const external: any = {
      uri: url,
      title: title || url,
      description: description,
    };

    if (thumbBlob) {
      external.thumb = thumbBlob;
    }

    return {
      $type: 'app.bsky.embed.external',
      external,
    };
  } catch (err: any) {
    if (err.code === 'ERR_FR_TOO_MANY_REDIRECTS') {
      // Ignore redirect loops
      return null;
    }
    console.warn(`Failed to fetch embed card for ${url}:`, err.message || err);
    return null;
  }
}

async function uploadVideoToBluesky(agent: BskyAgent, buffer: Buffer, filename: string): Promise<BlobRef> {
  const sanitizedFilename = filename.split('?')[0] || 'video.mp4';
  console.log(
    `[VIDEO] 🟢 Starting upload process for ${sanitizedFilename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
  );

  try {
    // 1. Get Service Auth
    // We need to resolve the actual PDS host for this DID
    console.log(`[VIDEO] 🔍 Resolving PDS host for DID: ${agent.session!.did}...`);
    const { data: repoDesc } = await agent.com.atproto.repo.describeRepo({ repo: agent.session!.did! });

    // didDoc might be present in repoDesc
    const pdsService = (repoDesc as any).didDoc?.service?.find(
      (s: any) => s.id === '#atproto_pds' || s.type === 'AtProtoPds',
    );
    const pdsUrl = pdsService?.serviceEndpoint;
    const pdsHost = pdsUrl ? new URL(pdsUrl).host : 'bsky.social';

    console.log(`[VIDEO] 🌐 PDS Host detected: ${pdsHost}`);
    console.log(`[VIDEO] 🔑 Requesting service auth token for audience: did:web:${pdsHost}...`);

    const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
      aud: `did:web:${pdsHost}`,
      lxm: 'com.atproto.repo.uploadBlob',
      exp: Math.floor(Date.now() / 1000) + 60 * 30,
    });
    console.log('[VIDEO] ✅ Service auth token obtained.');

    const token = serviceAuth.token;

    // 2. Upload to Video Service
    const uploadUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.uploadVideo');
    uploadUrl.searchParams.append('did', agent.session!.did!);
    uploadUrl.searchParams.append('name', sanitizedFilename);

    console.log(`[VIDEO] 📤 Uploading to ${uploadUrl.href}...`);
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'video/mp4',
      },
      body: new Blob([new Uint8Array(buffer)]),
      // Videos can be up to ~300MB; allow a generous window but never hang forever.
      signal: AbortSignal.timeout(45 * 60 * 1000),
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();

      // Handle specific error cases
      try {
        const errorJson = JSON.parse(errorText);

        // Handle server overload gracefully
        if (
          uploadResponse.status === 503 ||
          errorJson.error === 'Server does not have enough capacity to handle uploads'
        ) {
          console.warn('[VIDEO] ⚠️ Server overloaded (503). Skipping video upload and falling back to link.');
          throw new Error('VIDEO_FALLBACK_503');
        }

        if (errorJson.error === 'already_exists' && errorJson.jobId) {
          console.log(`[VIDEO] ♻️ Video already exists. Resuming with Job ID: ${errorJson.jobId}`);
          return await pollForVideoProcessing(agent, errorJson.jobId);
        }
        if (
          errorJson.error === 'unconfirmed_email' ||
          (errorJson.jobStatus && errorJson.jobStatus.error === 'unconfirmed_email')
        ) {
          console.error(
            '[VIDEO] 🛑 BLUESKY ERROR: Your email is unconfirmed. You MUST verify your email on Bluesky to upload videos.',
          );
          throw new Error('Bluesky Email Unconfirmed - Video Upload Rejected');
        }
      } catch (e) {
        if ((e as Error).message === 'VIDEO_FALLBACK_503') throw e;
        // Not JSON or missing fields, proceed with throwing original error
      }

      console.error(`[VIDEO] ❌ Server responded with ${uploadResponse.status}: ${errorText}`);
      throw new Error(`Video upload failed: ${uploadResponse.status} ${errorText}`);
    }

    const jobStatus = (await uploadResponse.json()) as any;
    console.log(`[VIDEO] 📦 Upload accepted. Job ID: ${jobStatus.jobId}, State: ${jobStatus.state}`);

    if (jobStatus.blob) {
      return jobStatus.blob;
    }

    // 3. Poll for processing status
    return await pollForVideoProcessing(agent, jobStatus.jobId);
  } catch (err) {
    console.error('[VIDEO] ❌ Error in uploadVideoToBluesky:', (err as Error).message);
    throw err;
  }
}

function splitText(text: string, limit = 300): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  // Reserve space for numbering like " (1/3)" -> approx 7 chars
  // We apply this reservation to the limit check
  const effectiveLimit = limit - 8;

  while (remaining.length > 0) {
    // Every chunk gets a " (i/n)" suffix appended later, so the final chunk
    // must also respect the reserved-space limit or it would exceed 300 chars.
    if (remaining.length <= effectiveLimit) {
      chunks.push(remaining);
      break;
    }

    // Smart splitting priority:
    // 1. Double newline (paragraph)
    // 2. Sentence end (.!?)
    // 3. Space
    // 4. Force split

    let splitIndex = -1;

    // Check paragraphs
    let checkIndex = remaining.lastIndexOf('\n\n', effectiveLimit);
    if (checkIndex !== -1) splitIndex = checkIndex;

    // Check sentences
    if (splitIndex === -1) {
      // Look for punctuation followed by space
      const sentenceMatches = Array.from(remaining.substring(0, effectiveLimit).matchAll(/[.!?]\s/g));
      if (sentenceMatches.length > 0) {
        const lastMatch = sentenceMatches[sentenceMatches.length - 1];
        if (lastMatch && lastMatch.index !== undefined) {
          splitIndex = lastMatch.index + 1; // Include punctuation
        }
      }
    }

    // Check spaces
    if (splitIndex === -1) {
      checkIndex = remaining.lastIndexOf(' ', effectiveLimit);
      if (checkIndex !== -1) splitIndex = checkIndex;
    }

    // Force split if no good break point found
    if (splitIndex === -1) {
      splitIndex = effectiveLimit;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

function utf16IndexToUtf8Index(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

function addTwitterHandleLinkFacets(text: string, facets?: any[]): any[] | undefined {
  const existingFacets = facets ?? [];
  const newFacets: any[] = [];
  const regex = /@([A-Za-z0-9_]{1,15})/g;

  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    const handle = match[1];
    if (!handle) continue;

    const atIndex = match.index;
    const prevChar = atIndex > 0 ? text[atIndex - 1] : '';
    if (prevChar && /[A-Za-z0-9_]/.test(prevChar)) continue;

    const endIndex = atIndex + handle.length + 1;
    const trailing = text.slice(endIndex);
    if (trailing.startsWith('.') && /^\.[A-Za-z0-9-]+/.test(trailing)) continue;

    const nextChar = endIndex < text.length ? text[endIndex] : '';
    if (nextChar && /[A-Za-z0-9_]/.test(nextChar)) continue;

    const byteStart = utf16IndexToUtf8Index(text, atIndex);
    const byteEnd = utf16IndexToUtf8Index(text, endIndex);

    const overlaps = existingFacets.some((facet) =>
      rangesOverlap(byteStart, byteEnd, facet.index.byteStart, facet.index.byteEnd),
    );
    if (overlaps) continue;

    newFacets.push({
      index: { byteStart, byteEnd },
      features: [
        {
          $type: 'app.bsky.richtext.facet#link',
          uri: `https://twitter.com/${handle}`,
        },
      ],
    });
  }

  if (newFacets.length === 0) return facets;
  return [...existingFacets, ...newFacets].sort((a, b) => a.index.byteStart - b.index.byteStart);
}

// Replaced safeSearch with fetchUserTweets to use UserTweets endpoint instead of Search
// Added processedIds for early stopping optimization
async function fetchUserTweets(
  username: string,
  limit: number,
  processedIds?: Set<string>,
  sessionKey = 'default',
): Promise<Tweet[]> {
  const client = await getTwitterScraper(sessionKey);
  if (!client) return [];

  let retries = 3;
  while (retries > 0) {
    try {
      await acquireScraperSlot();
      const tweets: Tweet[] = [];
      const generator = client.getTweets(username, limit);
      let consecutiveProcessedCount = 0;

      for await (const t of generator) {
        const tweet = mapScraperTweetToLocalTweet(t);
        const tweetId = tweet.id_str || tweet.id;

        // Early stopping logic: if we see 3 consecutive tweets we've already processed, stop.
        // This assumes timeline order (mostly true).
        if (processedIds && tweetId && processedIds.has(tweetId)) {
          consecutiveProcessedCount++;
          if (consecutiveProcessedCount >= 3) {
            console.log(`[${username}] 🛑 Found 3 consecutive processed tweets. Stopping fetch early.`);
            break;
          }
        } else {
          consecutiveProcessedCount = 0;
        }

        tweets.push(tweet);
        if (tweets.length >= limit) break;
      }
      return tweets;
    } catch (e: any) {
      retries--;
      const isRetryable =
        e.message?.includes('ServiceUnavailable') ||
        e.message?.includes('Timeout') ||
        e.message?.includes('429') ||
        e.message?.includes('401');

      // Check for Twitter Internal Server Error (often returns 400 with specific body)
      if (e?.response?.status === 400 && JSON.stringify(e?.response?.data || {}).includes('InternalServerError')) {
        console.warn(`⚠️ Twitter Internal Server Error (Transient) for ${username}.`);
        // Treat as retryable
        if (retries > 0) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
      }

      if (isRetryable) {
        console.warn(`⚠️ Error fetching tweets for ${username} (${e.message}).`);

        // Attempt credential switch if we have backups
        if (await switchCredentials()) {
          console.log('🔄 Retrying with new credentials...');
          continue; // Retry loop with new credentials
        }

        if (retries > 0) {
          console.log('Waiting 5s before retry...');
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
      }

      console.warn(`Error fetching tweets for ${username}:`, e.message || e);
      return [];
    }
  }

  console.log(`[${username}] ⚠️ Scraper returned 0 tweets (or failed silently) after retries.`);
  return [];
}

// ============================================================================
// Main Processing Logic
// ============================================================================

// ============================================================================
// Main Processing Logic
// ============================================================================

async function processTweets(
  agent: BskyAgent,
  twitterUsername: string,
  bskyIdentifier: string,
  tweets: Tweet[],
  dryRun = false,
  sharedProcessedMap?: ProcessedTweetsMap,
  sharedTweetMap?: Map<string, Tweet>,
  sessionKey = 'default',
): Promise<void> {
  // Filter tweets to ensure they're actually from this user
  const filteredTweets = tweets.filter((t) => {
    const authorScreenName = t.user?.screen_name?.toLowerCase();
    if (authorScreenName && authorScreenName !== twitterUsername.toLowerCase()) {
      console.log(
        `[${twitterUsername}] ⏩ Skipping tweet ${t.id_str || t.id} - author is @${t.user?.screen_name}, not @${twitterUsername}`,
      );
      return false;
    }
    return true;
  });

  const tweetMap = sharedTweetMap ?? new Map<string, Tweet>();
  addTweetsToMap(tweetMap, filteredTweets);

  // Maintain a local map that updates in real-time for intra-batch replies
  const localProcessedMap: ProcessedTweetsMap = sharedProcessedMap ?? { ...loadProcessedTweets(bskyIdentifier) };

  const toProcess = filteredTweets.filter((t) => !localProcessedMap[t.id_str || t.id || '']);

  if (toProcess.length === 0) {
    console.log(`[${twitterUsername}] ✅ No new tweets to process for ${bskyIdentifier}.`);
    return;
  }

  console.log(`[${twitterUsername}] 🚀 Processing ${toProcess.length} new tweets for ${bskyIdentifier}...`);

  const mirrorJobId = `mirror:${bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`;
  let mirroredCount = 0;

  filteredTweets.reverse();
  let count = 0;
  for (const tweet of filteredTweets) {
    count++;
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;

    if (localProcessedMap[tweetId]) continue;

    // Fallback to DB in case a nested backfill already saved this tweet.
    const dbRecord = dbService.getTweet(tweetId, bskyIdentifier);
    if (dbRecord) {
      localProcessedMap[tweetId] = {
        uri: dbRecord.bsky_uri,
        cid: dbRecord.bsky_cid,
        root:
          dbRecord.bsky_root_uri && dbRecord.bsky_root_cid
            ? { uri: dbRecord.bsky_root_uri, cid: dbRecord.bsky_root_cid }
            : undefined,
        tail:
          dbRecord.bsky_tail_uri && dbRecord.bsky_tail_cid
            ? { uri: dbRecord.bsky_tail_uri, cid: dbRecord.bsky_tail_cid }
            : undefined,
        migrated: dbRecord.status === 'migrated',
        skipped: dbRecord.status === 'skipped',
      };
      continue;
    }

    const isRetweet = tweet.isRetweet || tweet.retweeted_status_id_str || tweet.text?.startsWith('RT @');

    if (isRetweet) {
      console.log(`[${twitterUsername}] ⏩ Skipping retweet ${tweetId}.`);
      if (!dryRun) {
        // Save as skipped so we don't check it again
        saveProcessedTweet(twitterUsername, bskyIdentifier, tweetId, { skipped: true, text: tweet.text });
        localProcessedMap[tweetId] = { skipped: true, text: tweet.text };
      }
      continue;
    }

    console.log(`\n[${twitterUsername}] 🔍 Inspecting tweet: ${tweetId}`);
    updateJob(mirrorJobId, {
      kind: 'mirroring',
      account: twitterUsername,
      target: bskyIdentifier,
      message: `Mirroring tweet ${tweetId}`,
      processedCount: mirroredCount,
      totalCount: toProcess.length,
    });
    updateAppStatus({
      state: 'processing',
      currentAccount: twitterUsername,
      processedCount: count,
      totalCount: filteredTweets.length,
      message: `Inspecting tweet ${tweetId}`,
    });

    const replyStatusId = tweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id;
    const replyUserId = tweet.in_reply_to_user_id_str || tweet.in_reply_to_user_id;
    const tweetText = tweet.full_text || tweet.text || '';
    const isReply = !!replyStatusId || !!replyUserId || tweetText.trim().startsWith('@');

    let replyParentInfo: ProcessedTweetEntry | null = null;

    if (isReply) {
      if (replyStatusId && localProcessedMap[replyStatusId]) {
        console.log(`[${twitterUsername}] 🧵 Threading reply to post in ${bskyIdentifier}: ${replyStatusId}`);
        replyParentInfo = localProcessedMap[replyStatusId] ?? null;
      } else if (replyStatusId) {
        // Parent missing from local batch/DB. Attempt to fetch it if it's a self-thread.
        // We assume it's a self-thread if we don't have it, but we'll verify author after fetch.
        console.log(`[${twitterUsername}] 🕵️ Parent ${replyStatusId} missing. Checking if backfillable...`);

        let parentBackfilled = false;
        try {
          const scraper = await getTwitterScraper(sessionKey);
          if (scraper) {
            await acquireScraperSlot();
            const parentRaw = await scraper.getTweet(replyStatusId);
            if (parentRaw) {
              const parentTweet = mapScraperTweetToLocalTweet(parentRaw);
              const parentAuthor = parentTweet.user?.screen_name;

              if (parentAuthor?.toLowerCase() === twitterUsername.toLowerCase()) {
                console.log(`[${twitterUsername}] 🔄 Parent is ours (@${parentAuthor}). Backfilling parent first...`);
                addTweetsToMap(tweetMap, [parentTweet]);
                // Recursively process the parent
                await processTweets(
                  agent,
                  twitterUsername,
                  bskyIdentifier,
                  [parentTweet],
                  dryRun,
                  localProcessedMap,
                  tweetMap,
                  sessionKey,
                );

                // Check if it was saved
                const savedParent = dbService.getTweet(replyStatusId, bskyIdentifier);
                if (savedParent && savedParent.status === 'migrated') {
                  // Update local map
                  localProcessedMap[replyStatusId] = {
                    uri: savedParent.bsky_uri,
                    cid: savedParent.bsky_cid,
                    root:
                      savedParent.bsky_root_uri && savedParent.bsky_root_cid
                        ? { uri: savedParent.bsky_root_uri, cid: savedParent.bsky_root_cid }
                        : undefined,
                    tail:
                      savedParent.bsky_tail_uri && savedParent.bsky_tail_cid
                        ? { uri: savedParent.bsky_tail_uri, cid: savedParent.bsky_tail_cid }
                        : undefined,
                    migrated: true,
                  };
                  replyParentInfo = localProcessedMap[replyStatusId] ?? null;
                  parentBackfilled = true;
                  console.log(`[${twitterUsername}] ✅ Parent backfilled. Resuming thread.`);
                }
              } else {
                console.log(`[${twitterUsername}] ⏩ Parent is by @${parentAuthor}. Skipping external reply.`);
              }
            }
          }
        } catch (e) {
          console.warn(`[${twitterUsername}] ⚠️ Failed to fetch/backfill parent ${replyStatusId}:`, e);
        }

        if (!parentBackfilled) {
          console.log(`[${twitterUsername}] ⏩ Skipping external/unknown reply (Parent not found or external).`);
          if (!dryRun) {
            saveProcessedTweet(twitterUsername, bskyIdentifier, tweetId, { skipped: true, text: tweetText });
            localProcessedMap[tweetId] = { skipped: true, text: tweetText };
          }
          continue;
        }
      } else {
        console.log(`[${twitterUsername}] ⏩ Skipping external/unknown reply.`);
        if (!dryRun) {
          saveProcessedTweet(twitterUsername, bskyIdentifier, tweetId, { skipped: true, text: tweetText });
          localProcessedMap[tweetId] = { skipped: true, text: tweetText };
        }
        continue;
      }
    }

    // Removed early dryRun continue to allow verifying logic

    let text = tweetText
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // 1. Link Expansion
    console.log(`[${twitterUsername}] 🔗 Expanding links...`);
    const urls = tweet.entities?.urls || [];
    for (const urlEntity of urls) {
      const tco = urlEntity.url;
      const expanded = urlEntity.expanded_url;
      if (tco && expanded) text = text.replace(tco, expanded);
    }

    // Fallback: Regex for t.co links (if entities failed or missed one)
    const tcoRegex = /https:\/\/t\.co\/[a-zA-Z0-9]+/g;
    const matches = text.match(tcoRegex) || [];
    // Media t.co links (photos/videos) live in entities.media, not entities.urls.
    // They must NOT be expanded here: the media is crossposted natively and the
    // cleanup below only knows the t.co form, so expanding would leave a stray
    // twitter.com/…/photo/1 link in the post text.
    const mediaTcoLinks = new Set(
      (tweet.extended_entities?.media || tweet.entities?.media || [])
        .map((media) => media.url)
        .filter(Boolean) as string[],
    );
    for (const tco of matches) {
      // Avoid re-resolving if we already handled it via entities
      if (urls.some((u) => u.url === tco)) continue;
      if (mediaTcoLinks.has(tco)) continue;

      console.log(`[${twitterUsername}] 🔍 Resolving fallback link: ${tco}`);
      const resolved = await expandUrl(tco);
      if (resolved !== tco) {
        text = text.replace(tco, resolved);
        // Add to urls array so it can be used for card embedding later
        urls.push({ url: tco, expanded_url: resolved });
      }
    }

    // Card check stage: recover card data (ads/branded media, polls) the scraper drops
    const { isSponsoredCard } = await recoverCardData(tweet);
    if (isSponsoredCard) {
      console.log(`[${twitterUsername}] 🧩 Sponsored/card payload detected. Card media injected.`);
    }

    // 2. Media Handling
    const images: ImageEmbed[] = [];
    let videoBlob: BlobRef | null = null;
    let videoAspectRatio: AspectRatio | undefined;
    const mediaEntities = tweet.extended_entities?.media || tweet.entities?.media || [];
    const mediaLinksToRemove: string[] = [];

    console.log(`[${twitterUsername}] 🖼️ Found ${mediaEntities.length} media entities.`);

    for (const media of mediaEntities) {
      if (media.url) {
        mediaLinksToRemove.push(media.url);
        if (media.expanded_url) {
          mediaLinksToRemove.push(media.expanded_url);
          mediaLinksToRemove.push(media.expanded_url.replace('twitter.com', 'x.com'));
        }
      }
      if (media.source === 'card' && media.media_url_https) {
        mediaLinksToRemove.push(media.media_url_https);
      }

      let aspectRatio: AspectRatio | undefined;
      if (media.sizes?.large) {
        aspectRatio = { width: media.sizes.large.w, height: media.sizes.large.h };
      } else if (media.original_info) {
        aspectRatio = { width: media.original_info.width, height: media.original_info.height };
      }

      if (media.type === 'photo') {
        const url = media.media_url_https;
        if (!url) continue;
        try {
          const highQualityUrl = url.includes('?') ? url.replace('?', ':orig?') : `${url}:orig`;
          console.log(`[${twitterUsername}] 📥 Downloading image (high quality): ${path.basename(highQualityUrl)}`);
          updateAppStatus({ message: 'Downloading high quality image...' });
          const { buffer, mimeType } = await downloadMedia(highQualityUrl);

          let blob: BlobRef;
          if (dryRun) {
            console.log(
              `[${twitterUsername}] 🧪 [DRY RUN] Would upload image (${(buffer.length / 1024).toFixed(2)} KB)`,
            );
            blob = { ref: { toString: () => 'mock-blob' }, mimeType, size: buffer.length } as any;
          } else {
            console.log(`[${twitterUsername}] 📤 Uploading image to Bluesky...`);
            updateAppStatus({ message: 'Uploading image to Bluesky...' });
            blob = await uploadToBluesky(agent, buffer, mimeType);
          }

          let altText = media.ext_alt_text;
          if (!altText && isAltTextConfigured()) {
            console.log(`[${twitterUsername}] 🤖 Generating alt text via AI provider...`);
            // Use original tweet text for context, not the modified/cleaned one
            const altTextContext = buildAltTextContext(tweet, tweetText, tweetMap);
            altText = await generateAltText(buffer, mimeType, altTextContext);
            if (altText) console.log(`[${twitterUsername}] ✅ Alt text generated: ${altText.substring(0, 50)}...`);
          }

          images.push({ alt: altText || 'Image from Twitter', image: blob, aspectRatio });
          console.log(`[${twitterUsername}] ✅ Image uploaded.`);
        } catch (err) {
          console.error(`[${twitterUsername}] ❌ High quality upload failed:`, (err as Error).message);
          try {
            console.log(`[${twitterUsername}] 🔄 Retrying with standard quality...`);
            updateAppStatus({ message: 'Retrying with standard quality...' });
            const { buffer, mimeType } = await downloadMedia(url);
            const blob = await uploadToBluesky(agent, buffer, mimeType);
            images.push({ alt: media.ext_alt_text || 'Image from Twitter', image: blob, aspectRatio });
            console.log(`[${twitterUsername}] ✅ Image uploaded on retry.`);
          } catch (retryErr) {
            console.error(`[${twitterUsername}] ❌ Retry also failed:`, (retryErr as Error).message);
          }
        }
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        const variants = media.video_info?.variants || [];
        const duration = media.video_info?.duration_millis || 0;

        if (duration > 180000) {
          // 3 minutes
          console.warn(`[${twitterUsername}] ⚠️ Video too long (${(duration / 1000).toFixed(1)}s). Fallback to link.`);
          const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
          if (!text.includes(tweetUrl)) text += `\n\nVideo: ${tweetUrl}`;
          continue;
        }

        const mp4s = variants
          .filter((v) => v.content_type === 'video/mp4')
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (mp4s.length > 0) {
          const firstVariant = mp4s[0];
          if (firstVariant) {
            const videoUrl = firstVariant.url;
            try {
              console.log(`[${twitterUsername}] 📥 Downloading video: ${videoUrl}`);
              updateAppStatus({ message: `Downloading video: ${path.basename(videoUrl)}` });
              const { buffer, mimeType } = await downloadMedia(videoUrl, 30 * 60 * 1000);

              // Bluesky accepts videos up to 300MB; stay slightly under for safety
              // (280MiB = ~293.6M bytes, under the limit on either MB interpretation).
              if (buffer.length <= 280 * 1024 * 1024) {
                const filename = videoUrl.split('/').pop() || 'video.mp4';
                if (dryRun) {
                  console.log(
                    `[${twitterUsername}] 🧪 [DRY RUN] Would upload video: ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
                  );
                  videoBlob = {
                    ref: { toString: () => 'mock-video-blob' },
                    mimeType: 'video/mp4',
                    size: buffer.length,
                  } as any;
                } else {
                  updateAppStatus({ message: 'Uploading video to Bluesky...' });
                  videoBlob = await uploadVideoToBluesky(agent, buffer, filename);
                }
                videoAspectRatio = aspectRatio;
                console.log(`[${twitterUsername}] ✅ Video upload process complete.`);
                break; // Prioritize first video
              }

              console.warn(
                `[${twitterUsername}] ⚠️ Video too large (${(buffer.length / 1024 / 1024).toFixed(2)}MB). Fallback to link.`,
              );
              const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
              if (!text.includes(tweetUrl)) text += `\n\nVideo: ${tweetUrl}`;
            } catch (err) {
              const errMsg = (err as Error).message;
              if (errMsg !== 'VIDEO_FALLBACK_503') {
                console.error(`[${twitterUsername}] ❌ Failed video upload flow:`, errMsg);
              }
              const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
              if (!text.includes(tweetUrl)) text += `\n\nVideo: ${tweetUrl}`;
            }
          }
        }
      }
    }

    // Cleanup text
    for (const link of mediaLinksToRemove) text = text.split(link).join('').trim();
    if (isSponsoredCard) {
      const cardLinks = detectCarouselLinks(tweet);
      const cardPrimaryLink = detectCardMedia(tweet).link;
      const requestedLinks = [cardPrimaryLink, ...cardLinks].filter(Boolean) as string[];
      for (const link of requestedLinks) {
        if (!urls.some((u) => u.expanded_url === link || u.url === link)) {
          urls.push({ url: link, expanded_url: link });
        }
      }
    }
    text = text.replace(/\n\s*\n/g, '\n\n').trim();
    text = addTextFallbacks(text);

    // 3. Quoting Logic
    let quoteEmbed: { $type: string; record: { uri: string; cid: string } } | null = null;
    let externalQuoteUrl: string | null = null;
    let linkCard: any = null;

    if (tweet.is_quote_status && tweet.quoted_status_id_str) {
      const quoteId = tweet.quoted_status_id_str;
      const quoteRef = localProcessedMap[quoteId];
      if (quoteRef?.uri && quoteRef.cid) {
        console.log(`[${twitterUsername}] 🔄 Found quoted tweet in local history. Natively embedding.`);
        quoteEmbed = { $type: 'app.bsky.embed.record', record: { uri: quoteRef.uri, cid: quoteRef.cid } };
      } else {
        const quoteUrlEntity = urls.find((u) => u.expanded_url?.includes(quoteId));
        const qUrl = quoteUrlEntity?.expanded_url || `https://twitter.com/i/status/${quoteId}`;

        // Check if it's a self-quote (same user)
        const isSelfQuote =
          qUrl.toLowerCase().includes(`twitter.com/${twitterUsername.toLowerCase()}/`) ||
          qUrl.toLowerCase().includes(`x.com/${twitterUsername.toLowerCase()}/`);

        if (!isSelfQuote) {
          externalQuoteUrl = qUrl;
          console.log(`[${twitterUsername}] 🔗 Quoted tweet is external: ${externalQuoteUrl}`);

          // Try to capture screenshot for external QTs if we have space for images
          if (images.length < 4 && !videoBlob) {
            const ssResult = await captureTweetScreenshot(externalQuoteUrl);
            if (ssResult) {
              try {
                let blob: BlobRef;
                if (dryRun) {
                  console.log(
                    `[${twitterUsername}] 🧪 [DRY RUN] Would upload screenshot for quote (${(ssResult.buffer.length / 1024).toFixed(2)} KB)`,
                  );
                  blob = {
                    ref: { toString: () => 'mock-ss-blob' },
                    mimeType: 'image/png',
                    size: ssResult.buffer.length,
                  } as any;
                } else {
                  blob = await uploadToBluesky(agent, ssResult.buffer, 'image/png');
                }
                images.push({
                  alt: `Quote Tweet: ${externalQuoteUrl}`,
                  image: blob,
                  aspectRatio: { width: ssResult.width, height: ssResult.height },
                });
              } catch (e) {
                console.warn(`[${twitterUsername}] ⚠️ Failed to upload screenshot blob.`);
              }
            }
          }
        } else {
          console.log(`[${twitterUsername}] 🔁 Quoted tweet is a self-quote, skipping link.`);
        }
      }
    } else if ((images.length === 0 && !videoBlob) || isSponsoredCard) {
      // If no media and no quote, check for external links to embed
      // We prioritize the LAST link found as it's often the main content
      const potentialLinks = urls
        .map((u) => u.expanded_url)
        .filter((u) => u && !u.includes('twitter.com') && !u.includes('x.com')) as string[];

      if (potentialLinks.length > 0) {
        const linkToEmbed = potentialLinks[potentialLinks.length - 1];
        if (linkToEmbed) {
          // Optimization: If text is too long, but removing the link makes it fit, do it!
          // The link will be present in the embed card anyway.
          if (text.length > 300 && text.includes(linkToEmbed)) {
            const lengthWithoutLink = text.length - linkToEmbed.length;
            // Allow some buffer (e.g. whitespace cleanup might save 1-2 chars)
            if (lengthWithoutLink <= 300) {
              console.log(
                `[${twitterUsername}] 📏 Optimizing: Removing link ${linkToEmbed} from text to avoid threading (Card will embed it).`,
              );
              text = text.replace(linkToEmbed, '').trim();
              // Clean up potential double punctuation/spaces left behind
              text = text.replace(/\s\.$/, '.').replace(/\s\s+/g, ' ');
            }
          }

          console.log(`[${twitterUsername}] 🃏 Fetching link card for: ${linkToEmbed}`);
          linkCard = await fetchEmbedUrlCard(agent, linkToEmbed);
        }
      }
    }

    // Only append link for external quotes IF we couldn't natively embed it OR screenshot it
    const hasScreenshot = images.some((img) => img.alt.startsWith('Quote Tweet:'));
    if (externalQuoteUrl && !quoteEmbed && !hasScreenshot && !text.includes(externalQuoteUrl)) {
      text += `\n\nQT: ${externalQuoteUrl}`;
    }

    if (isSponsoredCard) {
      const hasCardImages = mediaEntities.some((media) => media.source === 'card');
      if (hasCardImages) {
        text = ensureSponsoredLinks(text, tweet);
      }
    }

    // Polls can't be mirrored on Bluesky — point readers at the original tweet.
    // If this pushes the text over the limit, splitText threads it automatically.
    const pollUrl = (tweet.permanentUrl || `https://x.com/${twitterUsername}/status/${tweetId}`).replace(
      'twitter.com',
      'x.com',
    );
    const pollNote = buildPollNote(tweet.card, pollUrl);
    if (pollNote && !text.includes(pollUrl)) {
      console.log(`[${twitterUsername}] 📊 Poll detected. Linking back to the original tweet.`);
      text = `${text}\n\n${pollNote}`.trim();
    }

    // 4. Threading and Posting
    const chunks = splitText(text);
    console.log(`[${twitterUsername}] 📝 Splitting text into ${chunks.length} chunks.`);

    let lastPostInfo: ProcessedTweetEntry | null = replyParentInfo;

    // We will save the first chunk as the "Root" of this tweet, and the last chunk as the "Tail".
    let firstChunkInfo: { uri: string; cid: string; root?: { uri: string; cid: string } } | null = null;
    let lastChunkInfo: { uri: string; cid: string; root?: { uri: string; cid: string } } | null = null;

    for (let i = 0; i < chunks.length; i++) {
      let chunk = chunks[i] as string;

      // Add (i/n) if split
      if (chunks.length > 1) {
        chunk += ` (${i + 1}/${chunks.length})`;
      }

      console.log(`[${twitterUsername}] 📤 Posting chunk ${i + 1}/${chunks.length}...`);
      updateAppStatus({ message: `Posting chunk ${i + 1}/${chunks.length}...` });

      const rt = new RichText({ text: chunk });
      try {
        await withTimeout(rt.detectFacets(agent), 60000, 'Facet detection timed out');
      } catch (facetErr) {
        console.warn(
          `[${twitterUsername}] ⚠️ Facet detection failed, posting with basic text:`,
          (facetErr as Error).message,
        );
      }
      rt.facets = addTwitterHandleLinkFacets(rt.text, rt.facets);
      const detectedLangs = detectLanguage(chunk);

      // Preserve original timing when available, but enforce monotonic per-account
      // timestamps to avoid equal-createdAt collisions in fast self-thread replies.
      const parsedCreatedAt = tweet.created_at ? Date.parse(tweet.created_at) : Number.NaN;
      const baseCreatedAtMs = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now();
      const chunkCreatedAtMs = baseCreatedAtMs + i * 1000;

      // biome-ignore lint/suspicious/noExplicitAny: dynamic record construction
      const postRecord: Record<string, any> = {
        text: rt.text,
        facets: rt.facets,
        langs: detectedLangs,
        // CID is generated by the PDS from record content; unique createdAt keeps
        // near-simultaneous self-thread posts from colliding on identical payloads.
        createdAt: getUniqueCreatedAtIso(bskyIdentifier, chunkCreatedAtMs),
      };

      if (i === 0) {
        if (videoBlob) {
          const videoEmbed: any = {
            $type: 'app.bsky.embed.video',
            video: videoBlob,
          };
          if (videoAspectRatio) videoEmbed.aspectRatio = videoAspectRatio;
          if (quoteEmbed) {
            postRecord.embed = { $type: 'app.bsky.embed.recordWithMedia', media: videoEmbed, record: quoteEmbed };
          } else {
            postRecord.embed = videoEmbed;
          }
        } else if (images.length > 0) {
          const imagesEmbed = { $type: 'app.bsky.embed.images', images };
          if (quoteEmbed) {
            postRecord.embed = { $type: 'app.bsky.embed.recordWithMedia', media: imagesEmbed, record: quoteEmbed };
          } else {
            postRecord.embed = imagesEmbed;
          }
        } else if (quoteEmbed) {
          postRecord.embed = quoteEmbed;
        } else if (linkCard) {
          postRecord.embed = linkCard;
        }

        if (videoBlob || images.length > 0) {
          const sensitiveLabels = buildSensitiveLabels(tweet, mediaEntities);
          if (sensitiveLabels.length > 0) {
            console.log(`[${twitterUsername}] 🔞 Applying self labels: ${sensitiveLabels.join(', ')}`);
            postRecord.labels = {
              $type: 'com.atproto.label.defs#selfLabels',
              values: sensitiveLabels.map((val) => ({ val })),
            };
          }
        }
      }

      // Threading logic
      // Determine actual parent URI/CID to reply to
      let parentRef: { uri: string; cid: string } | null = null;
      let rootRef: { uri: string; cid: string } | null = null;

      if (lastPostInfo?.uri && lastPostInfo?.cid) {
        // If this is the start of a new tweet (i=0), check if parent has a tail
        if (i === 0 && lastPostInfo.tail) {
          parentRef = lastPostInfo.tail;
        } else {
          // Otherwise (intra-tweet or parent has no tail), use the main uri/cid (which is the previous post/chunk)
          parentRef = { uri: lastPostInfo.uri, cid: lastPostInfo.cid };
        }

        rootRef = lastPostInfo.root || { uri: lastPostInfo.uri, cid: lastPostInfo.cid };
      }

      if (parentRef && rootRef) {
        postRecord.reply = {
          root: rootRef,
          parent: parentRef,
        };
      }

      try {
        // Retry logic for network/socket errors
        let response: any;
        let retries = 3;

        if (dryRun) {
          console.log(`[${twitterUsername}] 🧪 [DRY RUN] Would post chunk ${i + 1}/${chunks.length}`);
          if (postRecord.embed) console.log(`   - With embed: ${postRecord.embed.$type}`);
          if (postRecord.reply) console.log(`   - As reply to: ${postRecord.reply.parent.uri}`);
          response = { uri: 'at://did:plc:mock/app.bsky.feed.post/mock', cid: 'mock-cid' };
        } else {
          while (retries > 0) {
            try {
              response = await withTimeout(agent.post(postRecord), 120000, 'Post request timed out after 120s');
              break;
            } catch (err: any) {
              retries--;
              if (retries === 0) throw err;
              console.warn(
                `[${twitterUsername}] ⚠️ Post failed (Socket/Network), retrying in 5s... (${retries} retries left)`,
              );
              await new Promise((r) => setTimeout(r, 5000));
            }
          }
        }

        const currentPostInfo = {
          uri: response.uri,
          cid: response.cid,
          root: postRecord.reply ? postRecord.reply.root : { uri: response.uri, cid: response.cid },
          // Text is just the current chunk text
          text: chunk,
        };

        if (i === 0) firstChunkInfo = currentPostInfo;
        lastChunkInfo = currentPostInfo;
        lastPostInfo = currentPostInfo; // Update for next iteration

        console.log(`[${twitterUsername}] ✅ Chunk ${i + 1} posted successfully.`);

        if (chunks.length > 1) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      } catch (err) {
        console.error(`[${twitterUsername}] ❌ Failed to post ${tweetId} (chunk ${i + 1}):`, err);
        break;
      }
    }

    // Save to DB and Map
    if (firstChunkInfo && lastChunkInfo) {
      const entry: ProcessedTweetEntry = {
        uri: firstChunkInfo.uri,
        cid: firstChunkInfo.cid,
        root: firstChunkInfo.root,
        tail: { uri: lastChunkInfo.uri, cid: lastChunkInfo.cid }, // Save tail!
        text: tweetText,
      };

      if (!dryRun) {
        saveProcessedTweet(twitterUsername, bskyIdentifier, tweetId, entry);
        localProcessedMap[tweetId] = entry; // Update local map for subsequent replies in this batch
      }
      mirroredCount++;
    }

    // Human-like pause between posts. This only delays the current account's
    // queue worker — other accounts keep posting in parallel.
    const wait = POST_PACING_MIN_MS + Math.floor(Math.random() * (POST_PACING_MAX_MS - POST_PACING_MIN_MS + 1));
    console.log(`[${twitterUsername}] 😴 Pacing: Waiting ${wait / 1000}s before next tweet.`);
    updateJob(mirrorJobId, {
      message: `Mirrored tweet ${tweetId}. Pacing ${Math.round(wait / 1000)}s before the next one`,
      processedCount: mirroredCount,
    });
    updateAppStatus({ state: 'pacing', message: `Pacing: Waiting ${wait / 1000}s...` });
    await new Promise((r) => setTimeout(r, wait));
  }

  updateJob(mirrorJobId, null);
}

import { getAgent } from './bsky.js';

// ============================================================================
// Fetch Sweep + Post Queue Workers (daemon mode)
//
// The daemon splits work into two independent halves:
//   1. Fetch sweep — Twitter-side only. Checks every source account's
//      timeline (rate-limited by acquireScraperSlot) and drops new tweets
//      into the durable post_queue table. Fast and cheap, so the configured
//      check interval actually holds regardless of how much is being posted.
//   2. Post workers — Bluesky-side only. Drain the queue with one worker per
//      mapping (threads stay ordered) and several mappings in parallel, so a
//      slow video upload or a long thread never delays other accounts.
// One-shot CLI modes (--run-once, --dry-run, --backfill-mapping,
// --import-history) keep the original inline fetch→post path.
// ============================================================================

// Filters a fetched timeline down to enqueueable tweets and inserts them.
// Retweets are recorded as skipped immediately so they never occupy queue
// space; author-mismatch entries (stray timeline injections) are dropped.
function enqueueTweetsForMapping(
  mapping: AccountMapping,
  twitterUsername: string,
  tweets: Tweet[],
  kind: 'scheduled' | 'backfill',
  requestId?: string,
): number {
  const inputs = [];
  for (const tweet of tweets) {
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;
    const author = tweet.user?.screen_name?.toLowerCase();
    if (author && author !== twitterUsername.toLowerCase()) continue;
    const isRetweet = tweet.isRetweet || tweet.retweeted_status_id_str || (tweet.text || '').startsWith('RT @');
    if (isRetweet) {
      saveProcessedTweet(twitterUsername, mapping.bskyIdentifier, tweetId, { skipped: true, text: tweet.text });
      continue;
    }
    inputs.push({
      twitter_id: tweetId,
      bsky_identifier: mapping.bskyIdentifier,
      mapping_id: mapping.id,
      twitter_username: twitterUsername,
      kind,
      request_id: requestId,
      tweet_json: JSON.stringify(tweet),
      tweet_text: (tweet.full_text || tweet.text || '').slice(0, 300),
    });
  }
  return postQueueService.enqueue(inputs);
}

// Fetch-only pass over one source account. Returns tweets that are neither in
// processed_tweets nor already sitting in the queue.
async function sweepAccountForNewTweets(
  mapping: AccountMapping,
  twitterUsername: string,
  sessionKey: string,
): Promise<Tweet[]> {
  const seenIds = new Set(Object.keys(loadProcessedTweets(mapping.bskyIdentifier)));
  for (const id of postQueueService.getQueuedIdSet(mapping.bskyIdentifier)) {
    seenIds.add(id);
  }

  const tweets = await fetchUserTweets(twitterUsername, 50, seenIds, sessionKey);
  if (tweets.length === 0) return [];

  // The fetched window carries the isPin flag, so pin changes sync for free.
  await maybeSyncPinnedTweetFromTimeline(mapping, twitterUsername, tweets, false, getMappingLogPrefix(mapping));

  return tweets.filter((tweet) => {
    const tweetId = tweet.id_str || tweet.id;
    return Boolean(tweetId) && !seenIds.has(String(tweetId));
  });
}

// Sweep every enabled source account and enqueue whatever is new. Returns the
// number of tweets queued.
async function runFetchSweep(mappings: AccountMapping[]): Promise<number> {
  const accounts: { mapping: AccountMapping; twitterUsername: string }[] = [];
  for (const mapping of mappings) {
    if (!mapping.enabled) continue;
    for (const twitterUsername of mapping.twitterUsernames) {
      if (twitterUsername) accounts.push({ mapping, twitterUsername });
    }
  }
  if (accounts.length === 0) {
    logPipeline('Sweep', 'ℹ️ No enabled source accounts to check.');
    return 0;
  }

  const fetchTimeoutMs = envInt('SWEEP_FETCH_TIMEOUT_MS', 180_000, 30_000, 1_800_000);
  const startedAt = Date.now();
  logPipeline('Sweep', `🔎 Checking ${accounts.length} source account(s) (concurrency ${FETCH_CONCURRENCY}).`);

  let cursor = 0;
  let enqueuedTotal = 0;
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, accounts.length) }, async (_, slot) => {
    const sessionKey = `sweep-${slot + 1}`;
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= accounts.length) break;
      const ref = accounts[index];
      if (!ref) continue;
      const { mapping, twitterUsername } = ref;
      const checkJobId = `check:${mapping.id}:${twitterUsername.toLowerCase()}`;
      try {
        updateJob(checkJobId, {
          kind: 'checking',
          account: twitterUsername,
          target: mapping.bskyIdentifier,
          mappingId: mapping.id,
          message: 'Checking for new tweets',
        });
        const fresh = await withTimeout(
          sweepAccountForNewTweets(mapping, twitterUsername, sessionKey),
          fetchTimeoutMs,
          `[${twitterUsername}] Sweep fetch timed out after ${Math.round(fetchTimeoutMs / 1000)}s`,
        );
        if (fresh.length > 0) {
          const inserted = enqueueTweetsForMapping(mapping, twitterUsername, fresh, 'scheduled');
          enqueuedTotal += inserted;
          if (inserted > 0) {
            logPipeline(
              'Sweep',
              `📬 @${twitterUsername} → ${mapping.bskyIdentifier}: queued ${inserted} new tweet(s).`,
            );
          }
        }
      } catch (err) {
        logPipeline('Sweep', `❌ @${twitterUsername} → ${mapping.bskyIdentifier}: ${describeError(err)}`, true);
      } finally {
        updateJob(checkJobId, null);
      }
    }
  });
  await Promise.all(workers);

  // Daily housekeeping self-gates on 24h timestamps, so this is a cheap no-op
  // on almost every sweep.
  for (const mapping of mappings) {
    if (!mapping.enabled) continue;
    const logPrefix = getMappingLogPrefix(mapping);
    try {
      await maybeSyncMappingProfileInBackground(mapping, false, logPrefix);
      await maybeSyncPinnedTweetDaily(mapping, false, 'sweep-1', logPrefix);
    } catch (err) {
      console.error(`${logPrefix} ❌ Daily sync failed: ${describeError(err)}`);
    }
  }

  const counts = postQueueService.getCounts();
  logPipeline(
    'Sweep',
    `✅ Swept ${accounts.length} account(s) in ${formatDurationMs(Date.now() - startedAt)}; ` +
      `queued ${enqueuedTotal} new tweet(s). Queue now: ${counts.pending} pending, ${counts.processing} posting, ${counts.failed} failed.`,
  );
  return enqueuedTotal;
}

// Fetch phase of a queued backfill: pull history for one source account and
// hand it to the post queue instead of posting inline.
async function fetchAndEnqueueBackfill(
  mapping: AccountMapping,
  twitterUsername: string,
  limit: number,
  ignoreCancellation: boolean,
  requestId: string | undefined,
  sessionKey: string,
): Promise<void> {
  const backfillJobId = `backfill:${mapping.bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`;
  updateJob(backfillJobId, {
    kind: 'backfilling',
    account: twitterUsername,
    target: mapping.bskyIdentifier,
    mappingId: mapping.id,
    message: `Fetching up to ${limit || 100} tweets from the timeline`,
  });

  try {
    const client = await getTwitterScraper(sessionKey);
    if (!client) {
      console.error(`[${twitterUsername}] Twitter credentials not set. Cannot backfill.`);
      return;
    }

    const seenIds = new Set(Object.keys(loadProcessedTweets(mapping.bskyIdentifier)));
    for (const id of postQueueService.getQueuedIdSet(mapping.bskyIdentifier)) {
      seenIds.add(id);
    }

    const fetchLimit = limit || 100;
    const found: Tweet[] = [];
    await acquireScraperSlot();
    const generator = client.getTweets(twitterUsername, fetchLimit);
    for await (const scraperTweet of generator) {
      if (!ignoreCancellation) {
        const stillPending = getPendingBackfills().some(
          (b) => b.id === mapping.id && (!requestId || b.requestId === requestId),
        );
        if (!stillPending) {
          console.log(`[${twitterUsername}] 🛑 Backfill cancelled.`);
          return;
        }
      }
      const tweet = mapScraperTweetToLocalTweet(scraperTweet);
      const tweetId = tweet.id_str || tweet.id;
      if (!tweetId || seenIds.has(tweetId)) continue;
      seenIds.add(tweetId);
      found.push(tweet);
      if (found.length >= fetchLimit) break;
    }

    const queued = enqueueTweetsForMapping(mapping, twitterUsername, found, 'backfill', requestId);
    console.log(`[${twitterUsername}] 📬 Backfill queued ${queued} tweet(s) for ${mapping.bskyIdentifier}.`);
  } catch (err) {
    console.error(`[${twitterUsername}] ❌ Backfill fetch failed: ${describeError(err)}`);
  } finally {
    updateJob(backfillJobId, null);
  }
}

// --- Post workers ---

const activePostMappings = new Set<string>();
let postWorkersStarted = false;

function queueBatchTimeoutMs(itemCount: number): number {
  // Pacing plus media work make big batches legitimately slow; scale the
  // watchdog with batch size so it only catches genuine hangs.
  return Math.max(resolveScheduledAccountTimeoutMs(), itemCount * 120_000);
}

async function runPostBatch(mapping: AccountMapping, batch: QueueBatch, sessionKey: string): Promise<void> {
  const logPrefix = getMappingLogPrefix(mapping);
  let batchError = 'Tweet was not posted (see logs for details)';
  const startedAt = Date.now();
  const oldestEnqueuedAt = Math.min(...batch.items.map((item) => item.enqueued_at));
  logPipeline(
    'Queue',
    `▶️ @${batch.twitter_username} → ${mapping.bskyIdentifier}: posting ${batch.items.length} tweet(s) ` +
      `(oldest waited ${formatDurationMs(startedAt - oldestEnqueuedAt)} in queue).`,
  );

  try {
    const agent = await getAgent(mapping);
    if (!agent) {
      throw new Error('Bluesky login failed');
    }

    const tweets: Tweet[] = [];
    for (const item of batch.items) {
      try {
        tweets.push(JSON.parse(item.tweet_json) as Tweet);
      } catch {
        console.error(`${logPrefix} ⚠️ Corrupt queued payload for tweet ${item.twitter_id}; it will be retried out.`);
      }
    }

    // Queue batches arrive oldest-first; processTweets expects timeline order
    // (newest first) and reverses internally.
    tweets.reverse();

    await withTimeout(
      processTweets(
        agent,
        batch.twitter_username,
        batch.bsky_identifier,
        tweets,
        false,
        undefined,
        undefined,
        sessionKey,
      ),
      queueBatchTimeoutMs(batch.items.length),
      `[${batch.twitter_username}] Posting batch timed out`,
    );
  } catch (err) {
    batchError = describeError(err);
    console.error(`${logPrefix} ❌ Post batch failed: ${batchError}`);
  } finally {
    // Settle every claimed row. processed_tweets is the source of truth:
    // whatever landed there is done, everything else retries with backoff.
    let posted = 0;
    let skipped = 0;
    let retrying = 0;
    let parked = 0;
    for (const item of batch.items) {
      const record = dbService.getTweet(item.twitter_id, item.bsky_identifier);
      if (record) {
        postQueueService.markDone(item.twitter_id, item.bsky_identifier);
        if (record.status === 'migrated') posted += 1;
        else skipped += 1;
      } else {
        postQueueService.releaseForRetry(item, batchError, QUEUE_MAX_ATTEMPTS);
        if (item.attempts + 1 >= QUEUE_MAX_ATTEMPTS) parked += 1;
        else retrying += 1;
      }
    }
    const parts = [`${posted} posted`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (retrying > 0) parts.push(`${retrying} will retry`);
    if (parked > 0) parts.push(`${parked} parked as failed`);
    logPipeline(
      'Queue',
      `${retrying + parked > 0 ? '⚠️' : '✅'} @${batch.twitter_username} → ${mapping.bskyIdentifier}: ` +
        `${parts.join(', ')} in ${formatDurationMs(Date.now() - startedAt)}.`,
      retrying + parked > 0,
    );
  }
}

function startPostWorkers(): void {
  if (postWorkersStarted) return;
  postWorkersStarted = true;
  logPipeline('Queue', `🚚 Post workers started (up to ${POST_WORKER_CONCURRENCY} accounts posting in parallel).`);

  void (async () => {
    while (true) {
      let launched = false;
      try {
        const config = getConfig();
        const allowedMappingIds = new Set(config.mappings.filter((m) => m.enabled).map((m) => m.id));

        while (activePostMappings.size < POST_WORKER_CONCURRENCY) {
          const batch = postQueueService.claimNextBatch(activePostMappings, allowedMappingIds);
          if (!batch) break;
          const mapping = config.mappings.find((m) => m.id === batch.mapping_id);
          if (!mapping) {
            // Mapping was deleted while its tweets sat in the queue.
            postQueueService.deleteByMappingId(batch.mapping_id);
            continue;
          }

          activePostMappings.add(mapping.id);
          launched = true;
          // Same job id processTweets uses, so its progress updates land here.
          const jobId = `mirror:${batch.bsky_identifier}:${batch.twitter_username}`;
          updateJob(jobId, {
            kind: 'mirroring',
            account: batch.twitter_username,
            target: mapping.bskyIdentifier,
            mappingId: mapping.id,
            message: `Posting ${batch.items.length} queued tweet(s)`,
            processedCount: 0,
            totalCount: batch.items.length,
          });

          void runPostBatch(mapping, batch, 'post-worker')
            .catch((err) => logPipeline('Queue', `❌ Post worker crashed: ${describeError(err)}`, true))
            .finally(() => {
              activePostMappings.delete(mapping.id);
              updateJob(jobId, null);
            });
        }
      } catch (err) {
        logPipeline('Queue', `❌ Worker scheduler error: ${describeError(err)}`, true);
      }
      await new Promise((resolve) => setTimeout(resolve, launched ? 250 : 1000));
    }
  })();
}

async function importHistory(
  twitterUsername: string,
  bskyIdentifier: string,
  limit = 15,
  dryRun = false,
  ignoreCancellation = false,
  requestId?: string,
  sessionKey = 'default',
  // 'queue' hands the fetched tweets to the durable post queue (daemon mode);
  // 'inline' posts them before returning (CLI one-shots and dry runs).
  delivery: 'inline' | 'queue' = 'inline',
): Promise<void> {
  const config = getConfig();
  const mapping = config.mappings.find((m) =>
    m.twitterUsernames.map((u) => u.toLowerCase()).includes(twitterUsername.toLowerCase()),
  );
  if (!mapping) {
    console.error(`No mapping found for twitter username: ${twitterUsername}`);
    return;
  }

  if (delivery === 'queue' && !dryRun) {
    await fetchAndEnqueueBackfill(mapping, twitterUsername, limit, ignoreCancellation, requestId, sessionKey);
    return;
  }

  let agent = await getAgent(mapping);
  if (!agent) {
    if (dryRun) {
      console.log('⚠️  Could not login to Bluesky, but proceeding with MOCK AGENT for Dry Run.');
      // biome-ignore lint/suspicious/noExplicitAny: mock agent
      agent = {
        post: async (record: any) => ({ uri: 'at://did:plc:mock/app.bsky.feed.post/mock', cid: 'mock-cid' }),
        uploadBlob: async (data: any) => ({ data: { blob: { ref: { toString: () => 'mock-blob' } } } }),
        // Add other necessary methods if they are called outside of the already mocked dryRun blocks
        // But since we mocked the calls inside processTweets for dryRun, we just need the object to exist.
        session: { did: 'did:plc:mock' },
        com: { atproto: { repo: { describeRepo: async () => ({ data: {} }) } } },
      } as any;
    } else {
      return;
    }
  }

  console.log(`Starting full history import for ${twitterUsername} -> ${mapping.bskyIdentifier}...`);

  const allFoundTweets: Tweet[] = [];
  const seenIds = new Set<string>();
  const processedTweets = loadProcessedTweets(bskyIdentifier);

  console.log(`Fetching tweets for ${twitterUsername}...`);
  updateAppStatus({ message: 'Fetching tweets...' });
  const backfillJobId = `backfill:${bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`;
  updateJob(backfillJobId, {
    kind: 'backfilling',
    account: twitterUsername,
    target: bskyIdentifier,
    mappingId: mapping.id,
    message: `Fetching up to ${limit || 100} tweets from the timeline`,
  });

  try {
    const client = await getTwitterScraper(sessionKey);
    if (client) {
      try {
        // Use getTweets which reliably fetches user timeline
        // limit defaults to 15 in function signature, but for history import we might want more.
        // However, the generator will fetch as much as we ask.
        const fetchLimit = limit || 100;
        await acquireScraperSlot();
        const generator = client.getTweets(twitterUsername, fetchLimit);

        for await (const scraperTweet of generator) {
          if (!ignoreCancellation) {
            const stillPending = getPendingBackfills().some(
              (b) => b.id === mapping.id && (!requestId || b.requestId === requestId),
            );
            if (!stillPending) {
              console.log(`[${twitterUsername}] 🛑 Backfill cancelled.`);
              break;
            }
          }

          const t = mapScraperTweetToLocalTweet(scraperTweet);
          const tid = t.id_str || t.id;
          if (!tid) continue;

          if (!processedTweets[tid] && !seenIds.has(tid)) {
            allFoundTweets.push(t);
            seenIds.add(tid);
          }

          if (allFoundTweets.length >= fetchLimit) break;
        }
      } catch (e) {
        console.warn('Error during history fetch:', e);
      }
    }

    console.log(`Fetch complete. Found ${allFoundTweets.length} new tweets to import.`);
    if (allFoundTweets.length > 0) {
      updateJob(backfillJobId, { message: `Backfilling ${allFoundTweets.length} tweet(s)` });
      await processTweets(
        agent as BskyAgent,
        twitterUsername,
        bskyIdentifier,
        allFoundTweets,
        dryRun,
        undefined,
        undefined,
        sessionKey,
      );
      console.log('History import complete.');
    }
  } finally {
    updateJob(backfillJobId, null);
    updateJob(`mirror:${bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`, null);
  }
}

// Task management
const activeTasks = new Map<string, Promise<void>>();
// These must comfortably exceed normal processing time: the pipeline paces
// 5-15s between tweets on purpose, so a 15-tweet backfill alone takes ~2.5-4
// minutes. A too-short watchdog abandons runs that are still posting in the
// background, which risks duplicate posts when the next cycle overlaps them.
const DEFAULT_BACKFILL_ACCOUNT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SCHEDULED_ACCOUNT_TIMEOUT_MS = 20 * 60 * 1000;
const PROFILE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
let profileSyncStateWriteQueue: Promise<void> = Promise.resolve();

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const getMappingLogPrefix = (mapping: AccountMapping): string => {
  const owner = mapping.owner?.trim() || 'unknown-owner';
  const creator = mapping.createdByUserId || 'unknown-user';
  return `[mapping:${mapping.id}] [owner:${owner}] [creator:${creator}] [target:${mapping.bskyIdentifier}]`;
};

const resolveBackfillAccountTimeoutMs = (): number => {
  const raw = Number(process.env.BACKFILL_ACCOUNT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 15_000) {
    return raw;
  }
  return DEFAULT_BACKFILL_ACCOUNT_TIMEOUT_MS;
};

const resolveScheduledAccountTimeoutMs = (): number => {
  const raw = Number(process.env.SCHEDULED_ACCOUNT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 30_000) {
    return raw;
  }
  return DEFAULT_SCHEDULED_ACCOUNT_TIMEOUT_MS;
};

const normalizeMappingHandle = (value: string): string => value.trim().replace(/^@/, '').toLowerCase();

const parseIsoTimestampMs = (value?: string): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isProfileSyncDue = (mapping: AccountMapping): boolean => {
  const lastSyncMs = parseIsoTimestampMs(mapping.lastProfileSyncAt);
  if (!lastSyncMs) {
    return true;
  }
  return Date.now() - lastSyncMs >= PROFILE_SYNC_INTERVAL_MS;
};

const resolveProfileSyncSourceForMapping = (mapping: AccountMapping): string | null => {
  const candidates = mapping.twitterUsernames.map(normalizeMappingHandle).filter((username) => username.length > 0);
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0] || null;
  }

  const selected = normalizeMappingHandle(mapping.profileSyncSourceUsername || '');
  if (selected && candidates.includes(selected)) {
    return selected;
  }

  return null;
};

const persistProfileSyncResult = (
  mappingId: string,
  sourceTwitterUsername: string,
  updateResult: Awaited<ReturnType<typeof syncBlueskyProfileFromTwitter>>,
) => {
  profileSyncStateWriteQueue = profileSyncStateWriteQueue
    .then(() => {
      const config = getConfig();
      const index = config.mappings.findIndex((entry) => entry.id === mappingId);
      const mapping = config.mappings[index];
      if (index === -1 || !mapping) {
        return;
      }

      config.mappings[index] = applyProfileMirrorSyncState(mapping, sourceTwitterUsername, updateResult);
      saveConfig(config);
    })
    .catch((error) => {
      console.error(`[Scheduler] Failed persisting profile sync metadata for mapping ${mappingId}:`, error);
    });

  return profileSyncStateWriteQueue;
};

const persistPinnedTweetState = (mappingId: string, pinnedTweetId: string | undefined) => {
  profileSyncStateWriteQueue = profileSyncStateWriteQueue
    .then(() => {
      const config = getConfig();
      const mapping = config.mappings.find((entry) => entry.id === mappingId);
      if (!mapping) {
        return;
      }
      mapping.lastPinnedTweetId = pinnedTweetId;
      saveConfig(config);
    })
    .catch((error) => {
      console.error(`[Scheduler] Failed persisting pinned tweet state for mapping ${mappingId}:`, error);
    });

  return profileSyncStateWriteQueue;
};

const persistPinSyncTimestamp = (mappingId: string, lastPinSyncAt: string) => {
  profileSyncStateWriteQueue = profileSyncStateWriteQueue
    .then(() => {
      const config = getConfig();
      const mapping = config.mappings.find((entry) => entry.id === mappingId);
      if (!mapping) {
        return;
      }
      mapping.lastPinSyncAt = lastPinSyncAt;
      saveConfig(config);
    })
    .catch((error) => {
      console.error(`[Scheduler] Failed persisting pin sync timestamp for mapping ${mappingId}:`, error);
    });

  return profileSyncStateWriteQueue;
};

const PIN_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Authoritative pin check at least once every 24h per mapping (the timeline
// isPin path only catches pins that are inside the fetched window). Unchanged
// pins are a cheap no-op: two API reads, no backfill, no profile write.
async function maybeSyncPinnedTweetDaily(
  mapping: AccountMapping,
  dryRun: boolean,
  sessionKey: string,
  logPrefix: string,
): Promise<void> {
  if (dryRun) {
    return;
  }

  const lastMs = parseIsoTimestampMs(mapping.lastPinSyncAt);
  if (!lastMs) {
    // First run after upgrade: spread mappings across the 24h window so a
    // large instance (100 mappings) doesn't burst the Twitter API in one cycle.
    const staggered = new Date(Date.now() - Math.floor(Math.random() * PIN_SYNC_INTERVAL_MS)).toISOString();
    mapping.lastPinSyncAt = staggered;
    await persistPinSyncTimestamp(mapping.id, staggered);
    return;
  }
  if (Date.now() - lastMs < PIN_SYNC_INTERVAL_MS) {
    return;
  }

  // Bump the timestamp before running so failures retry in 24h, not every cycle.
  const stamp = new Date().toISOString();
  mapping.lastPinSyncAt = stamp;
  await persistPinSyncTimestamp(mapping.id, stamp);

  try {
    const message = await syncPinnedTweetViaProfile(mapping, dryRun, sessionKey);
    console.log(`${logPrefix} 📌 Daily pin check: ${message}`);
  } catch (error) {
    console.error(`${logPrefix} ❌ Daily pin check failed: ${describeError(error)}`);
  }
}

// Pins always come from the same account the bio/avatar are mirrored from.
// For multi-source mappings that means the designated profileSyncSourceUsername;
// without a valid selection we skip pin sync, exactly like profile sync does.
const resolvePinSourceForMapping = (mapping: AccountMapping): string | null => {
  return resolveProfileSyncSourceForMapping(mapping);
};

async function setBlueskyPinnedPost(
  agent: BskyAgent,
  ref: { uri: string; cid: string } | null,
  dryRun: boolean,
  logPrefix: string,
): Promise<void> {
  if (dryRun) {
    console.log(`${logPrefix} 🧪 [DRY RUN] Would ${ref ? `pin ${ref.uri}` : 'clear pinned post'} on Bluesky.`);
    return;
  }
  await agent.upsertProfile((existing) => {
    const profile = { ...(existing ?? {}) };
    if (ref) {
      profile.pinnedPost = { uri: ref.uri, cid: ref.cid };
    } else {
      // biome-ignore lint/performance/noDelete: the key must be absent from the atproto record; an explicit undefined could still trip lexicon validation
      delete profile.pinnedPost;
    }
    return profile;
  });
}

// Apply a pinned tweet to the Bluesky profile once the tweet is mirrored.
// Returns true when the Bluesky pin state now matches `pinnedTweetId`.
async function applyPinnedTweet(
  agent: BskyAgent,
  mapping: AccountMapping,
  pinnedTweetId: string | undefined,
  dryRun: boolean,
  logPrefix: string,
): Promise<boolean> {
  if (!pinnedTweetId) {
    if (!mapping.lastPinnedTweetId) {
      return true;
    }
    console.log(`${logPrefix} 📌 Tweet unpinned on Twitter. Clearing Bluesky pinned post.`);
    await setBlueskyPinnedPost(agent, null, dryRun, logPrefix);
    if (!dryRun) {
      mapping.lastPinnedTweetId = undefined;
      await persistPinnedTweetState(mapping.id, undefined);
    }
    return true;
  }

  if (pinnedTweetId === mapping.lastPinnedTweetId) {
    return true;
  }

  const record = dbService.getTweet(pinnedTweetId, mapping.bskyIdentifier);
  if (record && record.status === 'skipped') {
    // Pinned retweets/external replies are never mirrored — remember that so we
    // don't retry (and log) every cycle.
    console.log(`${logPrefix} 📌 Pinned tweet ${pinnedTweetId} was skipped (retweet/external reply). Not pinning.`);
    if (!dryRun) {
      mapping.lastPinnedTweetId = pinnedTweetId;
      await persistPinnedTweetState(mapping.id, pinnedTweetId);
    }
    return true;
  }
  if (!record || record.status !== 'migrated' || !record.bsky_uri || !record.bsky_cid) {
    console.log(`${logPrefix} 📌 Pinned tweet ${pinnedTweetId} is not mirrored yet. Pin sync deferred.`);
    return false;
  }

  console.log(`${logPrefix} 📌 Pinning mirrored post for tweet ${pinnedTweetId} on Bluesky.`);
  await setBlueskyPinnedPost(agent, { uri: record.bsky_uri, cid: record.bsky_cid }, dryRun, logPrefix);
  if (!dryRun) {
    mapping.lastPinnedTweetId = pinnedTweetId;
    await persistPinnedTweetState(mapping.id, pinnedTweetId);
  }
  return true;
}

// Zero-extra-request pin sync: the timeline fetch already marks the pinned
// tweet (isPin), so scheduled cycles can mirror pin changes for free.
async function maybeSyncPinnedTweetFromTimeline(
  mapping: AccountMapping,
  twitterUsername: string,
  tweets: Tweet[],
  dryRun: boolean,
  logPrefix: string,
): Promise<void> {
  const pinSource = resolvePinSourceForMapping(mapping);
  if (!pinSource || pinSource.toLowerCase() !== twitterUsername.toLowerCase()) {
    return;
  }

  const pinnedTweet = tweets.find((tweet) => tweet.isPin);
  const pinnedTweetId = pinnedTweet ? pinnedTweet.id_str || pinnedTweet.id : undefined;

  // isPin only fires when the pinned tweet is inside the fetched window, so its
  // absence is NOT proof of an unpin (old pins never appear here). Never unpin
  // from this path — the explicit pin-sync button does an authoritative check.
  if (!pinnedTweetId) {
    return;
  }
  if (pinnedTweetId === mapping.lastPinnedTweetId) {
    return;
  }

  // Only log in to Bluesky once we know the pin actually changed.
  const agent = await getAgent(mapping);
  if (!agent) {
    return;
  }

  try {
    await applyPinnedTweet(agent, mapping, pinnedTweetId, dryRun, logPrefix);
  } catch (error) {
    console.error(`${logPrefix} ❌ Pin sync failed: ${describeError(error)}`);
  }
}

// Explicit "backfill pins" path (web button): fetch the profile's pinned tweet,
// mirror it first if needed, then pin the mirrored post on Bluesky.
async function syncPinnedTweetViaProfile(
  mapping: AccountMapping,
  dryRun: boolean,
  sessionKey: string,
): Promise<string> {
  const logPrefix = getMappingLogPrefix(mapping);
  const pinSource = resolvePinSourceForMapping(mapping);
  if (!pinSource) {
    return mapping.twitterUsernames.length > 1
      ? 'No profile-sync source account selected for this multi-account mapping. Pick which account to pull the bio/avatar (and pin) from first.'
      : 'No Twitter source account configured.';
  }

  const pinJobId = `pin:${mapping.id}`;
  updateJob(pinJobId, {
    kind: 'pin-sync',
    account: pinSource,
    target: mapping.bskyIdentifier,
    mappingId: mapping.id,
    message: `Checking @${pinSource}'s pinned tweet`,
  });
  try {
    const scraper = await getTwitterScraper(sessionKey);
    if (!scraper) {
      return 'Twitter credentials are not configured.';
    }

    const agent = await getAgent(mapping);
    if (!agent) {
      return 'Bluesky login failed.';
    }

    const lookup = await fetchPinnedTweetId(scraper, pinSource);
    if (!lookup.ok) {
      return `Could not determine @${pinSource}'s pinned tweet (Twitter API lookup failed). Nothing changed.`;
    }
    const pinnedTweetId = lookup.pinnedTweetId;

    if (!pinnedTweetId) {
      await applyPinnedTweet(agent, mapping, undefined, dryRun, logPrefix);
      return `@${pinSource} has no pinned tweet. Bluesky pin cleared if one was set.`;
    }

    if (pinnedTweetId === mapping.lastPinnedTweetId) {
      return `Pinned tweet unchanged (${pinnedTweetId}). Nothing to do.`;
    }

    let record = dbService.getTweet(pinnedTweetId, mapping.bskyIdentifier);
    if (!record || record.status !== 'migrated') {
      console.log(`${logPrefix} 📌 Pinned tweet ${pinnedTweetId} not mirrored yet. Backfilling it now...`);
      await acquireScraperSlot();
      const rawPinned = await scraper.getTweet(pinnedTweetId);
      if (rawPinned) {
        // getTweet resolves the whole self-thread; mirror all of it so the pinned
        // post threads on Bluesky exactly like a live thread would.
        const seenIds = new Set<string>();
        const threadTweets = [rawPinned, ...(rawPinned.thread ?? [])]
          .map(mapScraperTweetToLocalTweet)
          .filter((threadTweet) => {
            const threadId = threadTweet.id_str || threadTweet.id;
            if (!threadId || seenIds.has(threadId)) return false;
            seenIds.add(threadId);
            return true;
          })
          // processTweets expects timeline order (newest first) and reverses internally
          .sort((a, b) => (BigInt(b.id_str || b.id || '0') < BigInt(a.id_str || a.id || '0') ? -1 : 1));
        if (threadTweets.length > 1) {
          console.log(
            `${logPrefix} 📌 Pinned tweet is part of a thread (${threadTweets.length} tweets). Mirroring the whole thread.`,
          );
        }
        await processTweets(
          agent,
          pinSource,
          mapping.bskyIdentifier,
          threadTweets,
          dryRun,
          undefined,
          undefined,
          sessionKey,
        );
        record = dbService.getTweet(pinnedTweetId, mapping.bskyIdentifier);
      }
    }

    if (!dryRun && (!record || record.status !== 'migrated')) {
      return `Pinned tweet ${pinnedTweetId} could not be mirrored (it may be a retweet or an external reply).`;
    }

    const synced = await applyPinnedTweet(agent, mapping, pinnedTweetId, dryRun, logPrefix);
    return synced
      ? `Pinned tweet synced for ${mapping.bskyIdentifier}.`
      : `Pinned tweet ${pinnedTweetId} is not mirrored yet; try a backfill first.`;
  } finally {
    updateJob(pinJobId, null);
    updateJob(`mirror:${mapping.bskyIdentifier.toLowerCase()}:${pinSource.toLowerCase()}`, null);
  }
}

async function maybeSyncMappingProfileInBackground(
  mapping: AccountMapping,
  dryRun: boolean,
  logPrefix: string,
): Promise<void> {
  if (dryRun) {
    return;
  }
  if (!isProfileSyncDue(mapping)) {
    return;
  }

  const sourceTwitterUsername = resolveProfileSyncSourceForMapping(mapping);
  if (!sourceTwitterUsername) {
    if (mapping.twitterUsernames.length > 1) {
      console.warn(
        `${logPrefix} ⚠️ Skipping automatic profile sync: multi-source mapping requires profileSyncSourceUsername selection.`,
      );
    }
    return;
  }

  const profileJobId = `profile:${mapping.id}`;
  updateJob(profileJobId, {
    kind: 'profile-sync',
    account: sourceTwitterUsername,
    target: mapping.bskyIdentifier,
    mappingId: mapping.id,
    message: `Pulling bio/avatar from @${sourceTwitterUsername}`,
  });
  try {
    console.log(`${logPrefix} 🪞 Running automatic profile sync from @${sourceTwitterUsername}.`);
    const result = await syncBlueskyProfileFromTwitter({
      twitterUsername: sourceTwitterUsername,
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: mapping.bskyPassword,
      bskyServiceUrl: mapping.bskyServiceUrl,
      syncDescription: false,
      previousSync: {
        sourceUsername: mapping.profileSyncSourceUsername,
        mirroredDisplayName: mapping.lastMirroredDisplayName,
        mirroredDescription: mapping.lastMirroredDescription,
        avatarUrl: mapping.lastMirroredAvatarUrl,
        bannerUrl: mapping.lastMirroredBannerUrl,
      },
    });

    Object.assign(mapping, applyProfileMirrorSyncState(mapping, sourceTwitterUsername, result));
    await persistProfileSyncResult(mapping.id, sourceTwitterUsername, result);

    if (result.skipped) {
      console.log(`${logPrefix} 🪞 Profile sync skipped (no Twitter profile changes).`);
      return;
    }

    if (result.warnings.length > 0) {
      console.warn(`${logPrefix} ⚠️ Profile sync completed with ${result.warnings.length} warning(s).`);
      return;
    }

    console.log(`${logPrefix} ✅ Profile sync completed.`);
  } catch (error) {
    console.error(`${logPrefix} ❌ Automatic profile sync failed: ${describeError(error)}`);
  } finally {
    updateJob(profileJobId, null);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function runAccountTask(
  mapping: AccountMapping,
  backfillRequest?: PendingBackfill,
  dryRun = false,
  sessionKey = 'default',
  backfillDelivery: 'inline' | 'queue' = 'inline',
) {
  const logPrefix = getMappingLogPrefix(mapping);
  const existingTask = activeTasks.get(mapping.id);
  if (existingTask) {
    console.log(`${logPrefix} ⏳ Task already in progress. Reusing active run.`);
    return existingTask;
  }

  const task = (async () => {
    let checkedSources = 0;
    let sourceErrors = 0;
    const taskMode = backfillRequest ? 'backfill' : 'scheduled';
    console.log(`${logPrefix} ▶️ Starting ${taskMode} task for ${mapping.twitterUsernames.length} source account(s).`);

    try {
      const backfillReq = backfillRequest ?? getPendingBackfills().find((b) => b.id === mapping.id);

      if (mapping.twitterUsernames.length === 0) {
        console.warn(`${logPrefix} ⚠️ No Twitter usernames configured. Skipping mapping.`);
        if (backfillReq) {
          clearBackfill(mapping.id, backfillReq.requestId);
          updateAppStatus({
            state: 'idle',
            currentAccount: undefined,
            processedCount: 0,
            totalCount: 0,
            message: `Backfill skipped for ${mapping.bskyIdentifier}: no source accounts configured`,
            backfillMappingId: undefined,
            backfillRequestId: undefined,
          });
        }
        return;
      }

      const agent = await getAgent(mapping);
      if (!agent) {
        console.warn(`${logPrefix} ⚠️ Unable to authenticate Bluesky account. Skipping task.`);
        if (backfillReq) {
          clearBackfill(mapping.id, backfillReq.requestId);
          updateAppStatus({
            state: 'idle',
            currentAccount: undefined,
            processedCount: 0,
            totalCount: mapping.twitterUsernames.length,
            message: `Backfill skipped for ${mapping.bskyIdentifier}: Bluesky login failed`,
            backfillMappingId: undefined,
            backfillRequestId: undefined,
          });
        }
        return;
      }

      const explicitBackfill = Boolean(backfillRequest);

      if (backfillReq) {
        const limit = backfillReq.limit || 15;
        const backfillAccountTimeoutMs = resolveBackfillAccountTimeoutMs();
        const accountCount = mapping.twitterUsernames.length;
        const estimatedTotalTweets = accountCount * limit;
        console.log(
          `${logPrefix} Running backfill for ${mapping.twitterUsernames.length} accounts (limit ${limit})...`,
        );
        updateAppStatus({
          state: 'backfilling',
          currentAccount: mapping.twitterUsernames[0],
          processedCount: 0,
          totalCount: accountCount,
          message: `Backfill queued for ${accountCount} account(s), up to ${estimatedTotalTweets} tweets`,
          backfillMappingId: mapping.id,
          backfillRequestId: backfillReq.requestId,
        });

        for (let i = 0; i < mapping.twitterUsernames.length; i += 1) {
          const twitterUsername = mapping.twitterUsernames[i];
          if (!twitterUsername) {
            continue;
          }
          const stillPending = explicitBackfill
            ? true
            : getPendingBackfills().some((b) => b.id === mapping.id && b.requestId === backfillReq.requestId);
          if (!stillPending) {
            console.log(`${logPrefix} 🛑 Backfill request replaced; stopping.`);
            break;
          }

          try {
            checkedSources += 1;
            updateAppStatus({
              state: 'backfilling',
              currentAccount: twitterUsername,
              processedCount: i,
              totalCount: accountCount,
              message: `Backfill ${i + 1}/${accountCount}: @${twitterUsername} (limit ${limit})`,
              backfillMappingId: mapping.id,
              backfillRequestId: backfillReq.requestId,
            });
            await withTimeout(
              importHistory(
                twitterUsername,
                mapping.bskyIdentifier,
                limit,
                dryRun,
                false,
                backfillReq.requestId,
                sessionKey,
                backfillDelivery,
              ),
              backfillAccountTimeoutMs,
              `[${twitterUsername}] Backfill timed out after ${Math.round(backfillAccountTimeoutMs / 1000)}s`,
            );
            updateAppStatus({
              state: 'backfilling',
              currentAccount: twitterUsername,
              processedCount: i + 1,
              totalCount: accountCount,
              message: `Completed ${i + 1}/${accountCount} for ${mapping.bskyIdentifier}`,
              backfillMappingId: mapping.id,
              backfillRequestId: backfillReq.requestId,
            });
          } catch (err) {
            sourceErrors += 1;
            console.error(`${logPrefix} ❌ Error backfilling @${twitterUsername}: ${describeError(err)}`);
          }
        }
        clearBackfill(mapping.id, backfillReq.requestId);
        updateAppStatus({
          state: 'idle',
          processedCount: accountCount,
          totalCount: accountCount,
          message:
            backfillDelivery === 'queue'
              ? `Backfill queued for ${mapping.bskyIdentifier}; posting continues in the background`
              : `Backfill complete for ${mapping.bskyIdentifier}`,
          backfillMappingId: undefined,
          backfillRequestId: undefined,
        });
        console.log(`${logPrefix} Backfill ${backfillDelivery === 'queue' ? 'fetch queued' : 'complete'}.`);
      } else {
        updateAppStatus({ backfillMappingId: undefined, backfillRequestId: undefined });
        const scheduledAccountTimeoutMs = resolveScheduledAccountTimeoutMs();

        // Pre-load processed IDs for optimization
        const processedMap = loadProcessedTweets(mapping.bskyIdentifier);
        const processedIds = new Set(Object.keys(processedMap));

        for (const twitterUsername of mapping.twitterUsernames) {
          const checkJobId = `check:${mapping.id}:${twitterUsername.toLowerCase()}`;
          try {
            checkedSources += 1;
            console.log(`[${twitterUsername}] 🏁 Starting check for new tweets...`);
            updateJob(checkJobId, {
              kind: 'checking',
              account: twitterUsername,
              target: mapping.bskyIdentifier,
              mappingId: mapping.id,
              message: 'Checking for new tweets',
            });
            updateAppStatus({
              state: 'checking',
              currentAccount: twitterUsername,
              message: 'Fetching latest tweets...',
              backfillMappingId: undefined,
              backfillRequestId: undefined,
            });

            // Use fetchUserTweets with early stopping optimization
            // Increase limit slightly since we have early stopping now
            const tweets = await withTimeout(
              fetchUserTweets(twitterUsername, 50, processedIds, sessionKey),
              scheduledAccountTimeoutMs,
              `[${twitterUsername}] Scheduled fetch timed out after ${Math.round(scheduledAccountTimeoutMs / 1000)}s`,
            );

            if (!tweets || tweets.length === 0) {
              console.log(`[${twitterUsername}] ℹ️ No tweets found (or fetch failed).`);
              continue;
            }

            console.log(`[${twitterUsername}] 📥 Fetched ${tweets.length} tweets.`);
            await withTimeout(
              processTweets(
                agent,
                twitterUsername,
                mapping.bskyIdentifier,
                tweets,
                dryRun,
                undefined,
                undefined,
                sessionKey,
              ),
              scheduledAccountTimeoutMs,
              `[${twitterUsername}] Scheduled processing timed out after ${Math.round(scheduledAccountTimeoutMs / 1000)}s`,
            );

            await maybeSyncPinnedTweetFromTimeline(mapping, twitterUsername, tweets, dryRun, logPrefix);
          } catch (err) {
            sourceErrors += 1;
            console.error(`${logPrefix} ❌ Error checking @${twitterUsername}: ${describeError(err)}`);
          } finally {
            updateJob(checkJobId, null);
            // Clear the mirror job too in case processing threw mid-tweet
            updateJob(`mirror:${mapping.bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`, null);
          }
        }

        await maybeSyncMappingProfileInBackground(mapping, dryRun, logPrefix);
        await maybeSyncPinnedTweetDaily(mapping, dryRun, sessionKey, logPrefix);
      }
    } catch (err) {
      sourceErrors += 1;
      console.error(`${logPrefix} ❌ Mapping task failed: ${describeError(err)}`);
    } finally {
      activeTasks.delete(mapping.id);
      console.log(`${logPrefix} ✅ Task finished. Sources checked=${checkedSources}, source errors=${sourceErrors}.`);
    }
  })();

  activeTasks.set(mapping.id, task);
  return task; // Return task promise for await in main loop
}

import type { AccountMapping } from './config-manager.js';
import {
  clearBackfill,
  clearPinSync,
  getNextCheckTime,
  getPendingBackfills,
  getPendingPinSyncs,
  getSchedulerWakeSignal,
  startServer,
  updateAppStatus,
  updateJob,
  updateLastCheckTime,
} from './server.js';
import type { PendingBackfill } from './server.js';

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('tweets-2-bsky')
    // ... existing options ...
    .description('Crosspost tweets to Bluesky')
    .option('--dry-run', 'Fetch tweets but do not post to Bluesky', false)
    .option('--no-web', 'Disable the web interface')
    .option('--run-once', 'Run one check cycle immediately and exit', false)
    .option('--backfill-mapping <mapping>', 'Run backfill now for a mapping id/handle/twitter username')
    .option('--backfill-limit <number>', 'Limit for --backfill-mapping', (val) => Number.parseInt(val, 10))
    .option('--import-history', 'Run in history import mode')
    .option('--username <username>', 'Twitter username for history import')
    .option('--limit <number>', 'Limit the number of tweets to import', (val) => Number.parseInt(val, 10))
    .parse(process.argv);

  const options = program.opts();

  const config = getConfig();

  await migrateJsonToSqlite();

  if (config.pds?.enabled) {
    const { startPds, isPdsHealthy } = await import('./pds-manager.js');
    const localUrl = `http://127.0.0.1:${config.pds.port}`;
    if (await isPdsHealthy(localUrl)) {
      console.log(`🛰️ Built-in PDS already running at ${localUrl}; using it.`);
    } else {
      console.log(`🛰️ Starting built-in PDS for ${config.pds.hostname}...`);
      // Long-running process: keep the PDS alive across crashes, otherwise every
      // subsequent post fails against a dead loopback URL.
      const pdsHandle = await startPds(config.pds, { superviseOnCrash: true });
      console.log(`🛰️ Built-in PDS ready at ${pdsHandle.localUrl} (handles: *.${config.pds.hostname}).`);
      // In-flight queue items are safe to abandon: startup calls
      // postQueueService.resetProcessing() to reclaim anything left mid-flight.
      let shuttingDown = false;
      const stopPds = async (signal: string) => {
        if (shuttingDown) {
          console.log('🛰️ Second signal received — exiting immediately.');
          process.exit(130);
        }
        shuttingDown = true;
        console.log(`\n🛰️ ${signal} received — stopping the built-in PDS...`);
        await pdsHandle.stop().catch(() => {});
        process.exit(0);
      };
      process.on('SIGINT', () => void stopPds('SIGINT'));
      process.on('SIGTERM', () => void stopPds('SIGTERM'));
    }
  }

  if (!options.web) {
    console.log('🌐 Web interface is disabled.');
  } else {
    startServer();
    if (config.users.length === 0) {
      console.log('ℹ️  No users found. Please register on the web interface to get started.');
    }
  }

  if (options.importHistory) {
    // ... existing import history logic ...
    if (!options.username) {
      console.error('Please specify a username with --username <username>');
      process.exit(1);
    }
    const client = await getTwitterScraper();
    if (!client) {
      console.error('Twitter credentials not set. Cannot import history.');
      process.exit(1);
    }
    const mapping = config.mappings.find((m) =>
      m.twitterUsernames.map((u) => u.toLowerCase()).includes(options.username.toLowerCase()),
    );
    if (!mapping) {
      console.error(`No mapping found for ${options.username}`);
      process.exit(1);
    }
    await importHistory(options.username, mapping.bskyIdentifier, options.limit, options.dryRun, true);
    process.exit(0);
  }

  const findMappingById = (mappings: AccountMapping[], id: string) => mappings.find((mapping) => mapping.id === id);
  const normalizeHandle = (value: string) => value.trim().replace(/^@/, '').toLowerCase();
  const findMappingByRef = (mappings: AccountMapping[], ref: string) => {
    const needle = normalizeHandle(ref);
    return mappings.find(
      (mapping) =>
        mapping.id === ref ||
        normalizeHandle(mapping.bskyIdentifier) === needle ||
        mapping.twitterUsernames.some((username) => normalizeHandle(username) === needle),
    );
  };

  const createSubbranches = <T>(items: T[], branchCount = SUBBRANCH_COUNT): T[][] => {
    const branches = Array.from({ length: Math.max(1, branchCount) }, () => [] as T[]);
    for (let index = 0; index < items.length; index += 1) {
      branches[index % branches.length]?.push(items[index] as T);
    }
    return branches;
  };

  const runMappingsWithSubbranches = async (
    mappings: AccountMapping[],
    dryRun: boolean,
    modeLabel: 'scheduled' | 'run-once',
  ) => {
    const enabledMappings = mappings.filter((mapping) => mapping.enabled);
    if (enabledMappings.length === 0) {
      const logPrefix = modeLabel === 'run-once' ? '[CLI]' : '[Scheduler]';
      console.log(`${logPrefix} ℹ️ No enabled mappings found for ${modeLabel} cycle.`);
      return;
    }

    const branches = createSubbranches(enabledMappings);
    const tasks = branches.map(async (branchMappings, branchIndex) => {
      const sessionKey = `subbranch-${branchIndex + 1}`;
      if (branchMappings.length === 0) return;
      console.log(
        `[${modeLabel}] 🌿 Subbranch ${branchIndex + 1}/${branches.length} processing ${branchMappings.length} mapping(s).`,
      );
      for (const mapping of branchMappings) {
        await runAccountTask(mapping, undefined, dryRun, sessionKey);
      }
    });

    await Promise.all(tasks);
  };

  const runSingleCycle = async (cycleConfig: ReturnType<typeof getConfig>) => {
    if (options.backfillMapping) {
      const mapping = findMappingByRef(cycleConfig.mappings, options.backfillMapping);
      if (!mapping) {
        console.error(`No mapping found for '${options.backfillMapping}'.`);
        process.exit(1);
      }
      if (!mapping.enabled) {
        console.error(`Mapping '${mapping.bskyIdentifier}' is disabled.`);
        process.exit(1);
      }

      const requestId = `cli-${Date.now()}`;
      const backfillRequest: PendingBackfill = {
        id: mapping.id,
        limit: options.backfillLimit || options.limit || 15,
        queuedAt: Date.now(),
        sequence: 0,
        requestId,
      };

      console.log(`[CLI] 🚧 Running backfill for ${mapping.bskyIdentifier}...`);
      await runAccountTask(mapping, backfillRequest, options.dryRun, 'subbranch-1');
      updateAppStatus({ state: 'idle', message: `Backfill complete for ${mapping.bskyIdentifier}` });
      return;
    }

    await runMappingsWithSubbranches(cycleConfig.mappings, options.dryRun, 'run-once');
    updateAppStatus({ state: 'idle', message: options.dryRun ? 'Dry run cycle complete' : 'Run-once cycle complete' });
  };

  if (options.runOnce || options.backfillMapping || options.dryRun) {
    await runSingleCycle(getConfig());
    console.log(options.dryRun ? 'Dry run cycle complete. Exiting.' : 'Run-once cycle complete. Exiting.');
    process.exit(0);
  }

  console.log(`Scheduler started. Base interval: ${config.checkIntervalMinutes} minutes.`);
  console.log(
    `Pipeline config: fetch concurrency ${FETCH_CONCURRENCY}, scraper gap ${SCRAPER_MIN_GAP_MS}+${SCRAPER_JITTER_MS}ms jitter, ` +
      `post workers ${POST_WORKER_CONCURRENCY}, pacing ${POST_PACING_MIN_MS}-${POST_PACING_MAX_MS}ms, max attempts ${QUEUE_MAX_ATTEMPTS}.`,
  );
  updateLastCheckTime(); // Initialize next time

  // Durable queue startup: re-arm anything a previous run left mid-flight and
  // drop failed rows old enough that nobody is coming back for them.
  const recovered = postQueueService.resetProcessing();
  if (recovered > 0) {
    logPipeline('Queue', `♻️ Recovered ${recovered} in-flight tweet(s) from a previous run.`);
  }
  postQueueService.purgeFailedOlderThan(14 * 24 * 60 * 60 * 1000);
  // Drop rows whose mapping was deleted while the app was down — nothing can
  // ever claim them.
  const knownMappingIds = new Set(getConfig().mappings.map((mapping) => mapping.id));
  for (const entry of postQueueService.getCounts().perMapping) {
    if (!knownMappingIds.has(entry.mapping_id)) {
      postQueueService.deleteByMappingId(entry.mapping_id);
    }
  }
  const startupCounts = postQueueService.getCounts();
  if (startupCounts.pending > 0) {
    logPipeline('Queue', `📬 ${startupCounts.pending} tweet(s) already queued; post workers will resume.`);
  }
  startPostWorkers();

  let deferredScheduledRun = false;
  let lastWakeSignal = getSchedulerWakeSignal();

  const sleepWithWake = async (durationMs: number) => {
    const intervalMs = 250;
    const end = Date.now() + durationMs;

    while (Date.now() < end) {
      const wakeSignal = getSchedulerWakeSignal();
      if (wakeSignal > lastWakeSignal) {
        lastWakeSignal = wakeSignal;
        return;
      }

      const remainingMs = Math.max(0, end - Date.now());
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
    }
  };

  // Main loop
  while (true) {
    const now = Date.now();
    const config = getConfig(); // Reload config to get new mappings/settings
    const nextTime = getNextCheckTime();

    const isScheduledRunDue = now >= nextTime;

    // Pin syncs are quick one-shot jobs queued from the web UI; run them first.
    // Cap per iteration so a bulk "sync all pins" on a large instance doesn't
    // starve scheduled checks and backfills.
    const pendingPinSyncs = getPendingPinSyncs().slice(0, SUBBRANCH_COUNT);
    for (const pinSync of pendingPinSyncs) {
      const mapping = findMappingById(config.mappings, pinSync.id);
      clearPinSync(pinSync.id);
      if (!mapping || !mapping.enabled) continue;
      const logPrefix = getMappingLogPrefix(mapping);
      try {
        updateAppStatus({ state: 'processing', message: `Syncing pinned tweet for ${mapping.bskyIdentifier}...` });
        const message = await syncPinnedTweetViaProfile(mapping, options.dryRun, 'subbranch-1');
        console.log(`${logPrefix} 📌 ${message}`);
        updateAppStatus({ state: 'idle', message });
      } catch (err) {
        console.error(`${logPrefix} ❌ Pin sync failed: ${describeError(err)}`);
        updateAppStatus({ state: 'idle', message: `Pin sync failed for ${mapping.bskyIdentifier}` });
      }
    }

    const pendingBackfills = getPendingBackfills();
    const wakeSignal = getSchedulerWakeSignal();
    const wakeRequested = wakeSignal > lastWakeSignal;
    if (wakeRequested) {
      lastWakeSignal = wakeSignal;
    }

    const shouldRunScheduledCycle =
      isScheduledRunDue ||
      (deferredScheduledRun && pendingBackfills.length === 0) ||
      (wakeRequested && pendingBackfills.length === 0);

    if (isScheduledRunDue && pendingBackfills.length > 0) {
      deferredScheduledRun = true;
    }

    if (pendingBackfills.length > 0) {
      const estimatedPendingTweets = pendingBackfills.reduce((total, backfill) => {
        const mapping = findMappingById(config.mappings, backfill.id);
        const accountCount = mapping ? Math.max(1, mapping.twitterUsernames.length) : 1;
        const limit = backfill.limit || 15;
        return total + accountCount * limit;
      }, 0);

      updateAppStatus({
        state: 'backfilling',
        message: `Backfill queue priority: ${pendingBackfills.length} job(s), ~${estimatedPendingTweets} tweets pending`,
      });

      const selectedBackfills: PendingBackfill[] = [];
      const mappingIds = new Set<string>();
      for (const backfill of pendingBackfills) {
        if (mappingIds.has(backfill.id)) continue;
        mappingIds.add(backfill.id);
        selectedBackfills.push(backfill);
        if (selectedBackfills.length >= SUBBRANCH_COUNT) break;
      }

      const backfillTasks = selectedBackfills.map(async (backfill, branchIndex) => {
        const mapping = findMappingById(config.mappings, backfill.id);
        if (mapping?.enabled) {
          const limit = backfill.limit || 15;
          console.log(
            `[Scheduler] 🚧 Backfill subbranch ${branchIndex + 1}/${SUBBRANCH_COUNT}: ${mapping.bskyIdentifier} (limit ${limit})`,
          );
          await runAccountTask(mapping, backfill, options.dryRun, `subbranch-${branchIndex + 1}`, 'queue');
        } else {
          clearBackfill(backfill.id, backfill.requestId);
        }
      });
      await Promise.all(backfillTasks);

      const remainingBackfills = getPendingBackfills();
      if (remainingBackfills.length === 0) {
        updateAppStatus({
          state: 'idle',
          message:
            deferredScheduledRun || isScheduledRunDue
              ? 'Backfill queue complete. Scheduled checks next.'
              : 'Backfill queue empty',
          backfillMappingId: undefined,
          backfillRequestId: undefined,
        });
      }

      await sleepWithWake(2000);
    } else if (shouldRunScheduledCycle) {
      console.log(
        deferredScheduledRun && !isScheduledRunDue
          ? `[${new Date().toISOString()}] ⏰ Running deferred scheduled checks after backfill queue.`
          : `[${new Date().toISOString()}] ⏰ Scheduled check triggered.`,
      );

      deferredScheduledRun = false;
      updateLastCheckTime();

      // Fetch-only sweep: new tweets land in the post queue and the workers
      // post them in parallel, so the next check is never blocked by posting.
      await runFetchSweep(config.mappings);

      updateAppStatus({ state: 'idle', message: 'Scheduled checks complete' });
    }

    // Sleep briefly between loop iterations, but wake early when UI actions request work.
    await sleepWithWake(5000);
  }
}

main();
