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
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { generateAltText, isAltTextConfigured } from './ai-manager.js';

import {
  type FacetLike,
  type SensitiveFallbackLabel,
  addTwitterHandleFacets,
  bskyPostUrl,
  buildSensitiveLabels,
  decodeHtmlEntities,
  dropUnresolvedMentions,
  isTwitterUrl,
  parseTweetStatusUrl,
  resolvePostLangs,
} from './compose.js';
import { getConfig, saveConfig, updateConfig } from './config-manager.js';
import { DELETE_SYNC_MIN_MISSING_SPAN_MS, checkSourceTweet, syncDeletesForAccount } from './delete-sync.js';
import { refreshDiscoveryDaily } from './discovery-runner.js';
import type { ErrorDetail } from './event-log.js';
import { logEvent } from './event-log.js';
import { activityFromRow, planSweep } from './polling.js';
import type { PreviewRequest, PreviewResult, PreviewTweet } from './preview.js';
import { setPreviewRunner } from './preview.js';
import { applyProfileMirrorSyncState, syncBlueskyProfileFromTwitter } from './profile-mirror.js';
import {
  SCRAPER_JITTER_MS,
  SCRAPER_MIN_GAP_MS,
  acquireScraperSlot,
  createScraperFetch,
  isRetryableScraperError,
} from './scraper-fetch.js';
import { BSKY_POST_LIMIT, graphemeLength, splitText } from './text-split.js';
import {
  buildPollNote,
  detectCardMedia,
  detectCarouselLinks,
  ensureSponsoredLinks,
  recoverCardData,
} from './tweet-cards.js';
import type { MediaEntity, TweetCard, TweetEntities } from './tweet-cards.js';
import { MAX_VIDEO_DURATION_MS, MAX_VIDEO_UPLOAD_BYTES, selectVideoVariants } from './video-limits.js';

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
  /** Raw history status: migrated | skipped | reposted | deleted | failed. */
  status?: string;
  /** Every chunk's URI, first to last, for posts made since chunk tracking. */
  chunkUris?: string[];
  text?: string;
  /** Epoch ms of the source tweet, paired with postedAt to measure mirror lag. */
  tweetCreatedAt?: number;
  /** Epoch ms the mirrored post landed on Bluesky. */
  postedAt?: number;
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
  /** Twitter's own language verdict (BCP-47-ish, or und/zxx/q-codes). */
  lang?: string;
  /** Every id this tweet has had; more than one means it was edited. */
  versions?: string[];
  /** The quoted tweet as the timeline delivered it — no extra request needed. */
  quoted_status?: QuotedTweetInfo;
}

interface QuotedTweetInfo {
  id: string;
  username?: string;
  name?: string;
  text?: string;
  /** First photo, or a video's poster frame: the card's thumbnail. */
  imageUrl?: string;
  url?: string;
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

import { accountHealthService, dbService, postQueueService, sourceActivityService } from './db.js';
import type { ProcessedTweet, QueueBatch } from './db.js';

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
    status:
      (entry.status as ProcessedTweet['status'] | undefined) ??
      (entry.migrated || (entry.uri && entry.cid) ? 'migrated' : entry.skipped ? 'skipped' : 'failed'),
    tweet_created_at: entry.tweetCreatedAt,
    posted_at: entry.postedAt,
    bsky_chunk_uris: entry.chunkUris && entry.chunkUris.length > 0 ? JSON.stringify(entry.chunkUris) : undefined,
  });
}

/** A history row as the composer's in-memory map entry. */
function entryFromRecord(record: ProcessedTweet): ProcessedTweetEntry {
  const isPost = record.status === 'migrated';
  let chunkUris: string[] | undefined;
  if (record.bsky_chunk_uris) {
    try {
      const parsed = JSON.parse(record.bsky_chunk_uris);
      if (Array.isArray(parsed)) chunkUris = parsed.filter((uri): uri is string => typeof uri === 'string');
    } catch {
      chunkUris = undefined;
    }
  }
  return {
    uri: isPost ? record.bsky_uri : undefined,
    cid: isPost ? record.bsky_cid : undefined,
    root:
      isPost && record.bsky_root_uri && record.bsky_root_cid
        ? { uri: record.bsky_root_uri, cid: record.bsky_root_cid }
        : undefined,
    tail:
      isPost && record.bsky_tail_uri && record.bsky_tail_cid
        ? { uri: record.bsky_tail_uri, cid: record.bsky_tail_cid }
        : undefined,
    migrated: isPost,
    skipped: record.status === 'skipped',
    status: record.status,
    chunkUris,
  };
}

// ============================================================================
// Custom Twitter Client
// ============================================================================

const scraperSessions = new Map<string, Scraper>();
const sessionCookies = new Map<string, { authToken: string; ct0: string }>();
let useBackupCredentials = false;
// Recently used createdAt values per account. A thread's chunks are posted
// within milliseconds of each other, and two records with an identical
// createdAt and text collide; bumping a colliding timestamp by 1ms keeps them
// distinct. This used to force every timestamp to be later than the last one
// used, which silently re-dated any backfilled tweet that followed a live post
// to "now".
const usedCreatedAtByBsky = new Map<string, Set<number>>();
const SUBBRANCH_COUNT = 5;

// --- Pipeline tunables (env-overridable) ---
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (Number.isFinite(raw)) return Math.min(max, Math.max(min, Math.round(raw)));
  return fallback;
}

// How many timeline fetches run concurrently during a sweep. All sessions
// share one Twitter login, so the global scraper gap (scraper-fetch.ts) is
// what actually bounds the request rate — this only hides per-request latency.
const FETCH_CONCURRENCY = envInt('FETCH_CONCURRENCY', 4, 1, 16);
// How many Bluesky accounts post from the queue at once. Media downloads can
// buffer hundreds of MB each, so keep this aligned with available RAM.
const POST_WORKER_CONCURRENCY = envInt('POST_WORKER_CONCURRENCY', 5, 1, 16);
// Pause between posted tweets within one account. Bluesky's own rate limit is
// ~1,666 posts/hour per account, so this is cosmetic pacing, not protection —
// and since it now runs inside a per-account worker it never delays others.
const POST_PACING_MIN_MS = envInt('POST_PACING_MIN_MS', 3000, 0, 120_000);
const POST_PACING_MAX_MS = Math.max(envInt('POST_PACING_MAX_MS', 8000, 0, 300_000), POST_PACING_MIN_MS);
// Pause between the chunks of one split tweet.
const THREAD_CHUNK_GAP_MS = envInt('THREAD_CHUNK_GAP_MS', 3000, 0, 60_000);
// Retries per queued tweet before it is parked as failed (visible in the UI).
const QUEUE_MAX_ATTEMPTS = envInt('QUEUE_MAX_ATTEMPTS', 8, 1, 50);
// A live mirror is stamped with the time it reaches Bluesky, so it lands at
// the top of followers' feeds (the AppView sorts by the earlier of createdAt
// and indexedAt, which buried a post backdated to its tweet). Tweets older
// than this — and every backfill — keep their original time instead.
const LIVE_TIMESTAMP_MAX_AGE_MS = envInt('LIVE_TIMESTAMP_MAX_AGE_MS', 6 * 60 * 60 * 1000, 0, 7 * 24 * 60 * 60 * 1000);

const formatDurationMs = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
};

function getUniqueCreatedAtIso(bskyIdentifier: string, desiredMs: number): string {
  const key = bskyIdentifier.toLowerCase();
  let used = usedCreatedAtByBsky.get(key);
  if (!used) {
    used = new Set<number>();
    usedCreatedAtByBsky.set(key, used);
  }
  let nextMs = Math.round(desiredMs);
  while (used.has(nextMs)) nextMs += 1;
  used.add(nextMs);
  // Bounded memory: only recent values can collide in practice.
  if (used.size > 2000) {
    const oldest = [...used].sort((a, b) => a - b).slice(0, 1000);
    for (const value of oldest) used.delete(value);
  }
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

// Every scraper request goes through one fetch: a per-request deadline (so a
// hung socket fails fast and takes the retry path) behind the process-wide
// rate limiter (so the gap holds per request — a timeline fetch is a user-id
// lookup plus pages, and each is a separate hit on the account's limits).
const scraperFetch = createScraperFetch();

async function getTwitterScraper(sessionKey = 'default', forceReset = false): Promise<Scraper | null> {
  const credentials = getActiveTwitterCredentials();
  if (!credentials) return null;
  const { authToken, ct0 } = credentials;

  // Re-initialize if config changed, not yet initialized, or forced reset
  const existingScraper = scraperSessions.get(sessionKey);
  const existingCookies = sessionCookies.get(sessionKey);
  if (!existingScraper || forceReset || existingCookies?.authToken !== authToken || existingCookies?.ct0 !== ct0) {
    console.log(`🔄 Initializing Twitter scraper with ${useBackupCredentials ? 'BACKUP' : 'PRIMARY'} credentials...`);
    const scraper = new Scraper({ fetch: scraperFetch });
    await scraper.setCookies([`auth_token=${authToken}`, `ct0=${ct0}`]);
    scraperSessions.set(sessionKey, scraper);
    sessionCookies.set(sessionKey, {
      authToken: authToken,
      ct0: ct0,
    });
  }
  return scraperSessions.get(sessionKey) ?? null;
}

/**
 * Move off a credential set that just failed. Several fetches run at once, and
 * a plain toggle meant two of them failing on the primary set flipped to the
 * backup and straight back again. Each caller says which set it was using; if
 * another worker already moved off it, this one just retries on the current set.
 */
async function switchCredentials(failedOnBackup: boolean = useBackupCredentials): Promise<boolean> {
  const config = getConfig();
  if (useBackupCredentials !== failedOnBackup) {
    return true;
  }
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
      retweeted_status_id_str: scraperTweet.retweetedStatusId ?? scraperTweet.retweetedStatus?.id,
      versions: scraperTweet.versions,
      quoted_status: toQuotedTweetInfo(scraperTweet.quotedStatus),
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
    // New-style retweets only carry the original inside retweeted_status_result;
    // the scraper resolves the id either way.
    retweeted_status_id_str:
      raw.retweeted_status_id_str ?? scraperTweet.retweetedStatusId ?? scraperTweet.retweetedStatus?.id,
    is_quote_status: !!raw.quoted_status_id_str,
    in_reply_to_status_id_str: raw.in_reply_to_status_id_str,
    // biome-ignore lint/suspicious/noExplicitAny: missing in LegacyTweetRaw type
    in_reply_to_user_id_str: (raw as any).in_reply_to_user_id_str,
    // biome-ignore lint/suspicious/noExplicitAny: card comes from raw tweet
    card: (raw as any).card,
    permanentUrl: scraperTweet.permanentUrl,
    // biome-ignore lint/suspicious/noExplicitAny: missing in LegacyTweetRaw type
    lang: typeof (raw as any).lang === 'string' ? (raw as any).lang : undefined,
    versions: scraperTweet.versions,
    quoted_status: toQuotedTweetInfo(scraperTweet.quotedStatus),
    user: {
      screen_name: scraperTweet.username,
      id_str: scraperTweet.userId,
    },
  };
}

function toQuotedTweetInfo(quoted: ScraperTweet | undefined): QuotedTweetInfo | undefined {
  if (!quoted?.id) return undefined;
  const photo = quoted.photos?.[0]?.url;
  const poster = quoted.videos?.[0]?.preview;
  return {
    id: quoted.id,
    username: quoted.username,
    name: quoted.name,
    text: quoted.text,
    imageUrl: photo || poster || undefined,
    url: quoted.permanentUrl || (quoted.username ? `https://x.com/${quoted.username}/status/${quoted.id}` : undefined),
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

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

/** An abort signal that fires on either the deadline or the caller's own signal. */
function deadlineSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([deadline, signal]) : deadline;
}

async function downloadMedia(url: string, maxDurationMs = 120000, signal?: AbortSignal): Promise<DownloadedMedia> {
  const response = await axios.request({
    url,
    method: 'GET',
    responseType: 'arraybuffer',
    // axios `timeout` only fires on socket inactivity; the abort signal enforces
    // a hard deadline so a slow-trickling large download can't stall the
    // pipeline, and lets a cancelled batch stop mid-download.
    timeout: 30000,
    signal: deadlineSignal(maxDurationMs, signal),
    maxContentLength: MAX_MEDIA_DOWNLOAD_BYTES,
    maxBodyLength: MAX_MEDIA_DOWNLOAD_BYTES,
  });
  return {
    buffer: Buffer.from(response.data as ArrayBuffer),
    mimeType: (response.headers['content-type'] as string) || 'application/octet-stream',
  };
}

// Distinguishes "this variant could not be fetched" (retry a smaller one) from
// "Bluesky refused the video" (every variant fails the same way).
function isDownloadFailure(err: unknown): boolean {
  if (axios.isAxiosError(err)) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

const BLOB_UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;

// app.bsky.embed.images caps an image blob at 2,000,000 bytes; stay under it.
const DEFAULT_IMAGE_MAX_SIZE = 1900 * 1024;
// app.bsky.embed.external caps its thumb at 1,000,000 bytes — tighter than a
// post image, and the limit that was parking link-card tweets.
const EXTERNAL_THUMB_MAX_SIZE = 950 * 1024;

async function uploadToBluesky(
  agent: BskyAgent,
  buffer: Buffer,
  mimeType: string,
  maxSize = DEFAULT_IMAGE_MAX_SIZE,
): Promise<BlobRef> {
  let finalBuffer = buffer;
  let finalMimeType = mimeType;
  // Bluesky accepts image blobs up to 2MB; stay slightly under for safety.
  // Callers embedding the blob somewhere with a tighter limit (e.g. link card
  // thumbnails, capped at 1,000,000 bytes) pass a smaller maxSize. A larger one
  // is clamped rather than honoured: the record would be rejected at post time
  // and the tweet parked, which is exactly the failure this ceiling prevents.
  const MAX_SIZE = Math.min(maxSize, DEFAULT_IMAGE_MAX_SIZE);

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

          // JPEG has no alpha channel and sharp fills transparency with black
          // when it drops it, so a transparent PNG logo came out as a black
          // box. Flatten onto white first.
          image = sharp(buffer)
            .resize({ width, withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality, mozjpeg: true });

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

// 10-minute clips take Bluesky's transcoder far longer than the short ones this
// used to allow for, so give a job 20 minutes before calling it dead.
const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_PROCESSING_TIMEOUT_MS = 20 * 60 * 1000;
const VIDEO_POLL_MAX_ATTEMPTS = Math.ceil(VIDEO_PROCESSING_TIMEOUT_MS / VIDEO_POLL_INTERVAL_MS);
const VIDEO_UPLOAD_TIMEOUT_MS = 45 * 60 * 1000;
const videoProcessingTimeoutError = () =>
  new Error(`Video processing timed out after ${Math.round(VIDEO_PROCESSING_TIMEOUT_MS / 60000)} minutes.`);

async function pollForVideoProcessing(agent: BskyAgent, jobId: string, signal?: AbortSignal): Promise<BlobRef> {
  console.log('[VIDEO] ⏳ Polling for processing completion (this can take several minutes)...');
  let attempts = 0;
  let blob: BlobRef | undefined;

  while (!blob) {
    attempts++;
    signal?.throwIfAborted();
    const statusUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.getJobStatus');
    statusUrl.searchParams.append('jobId', jobId);

    let statusResponse: Response;
    try {
      statusResponse = await fetch(statusUrl, { signal: deadlineSignal(30000, signal) });
    } catch (err) {
      console.warn(`[VIDEO] ⚠️ Job status fetch errored (${(err as Error).message}), retrying...`);
      if (attempts > VIDEO_POLL_MAX_ATTEMPTS) throw videoProcessingTimeoutError();
      await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
      continue;
    }
    if (!statusResponse.ok) {
      console.warn(`[VIDEO] ⚠️ Job status fetch failed (${statusResponse.status}), retrying...`);
      if (attempts > VIDEO_POLL_MAX_ATTEMPTS) throw videoProcessingTimeoutError();
      await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
      continue;
    }

    const statusData = (await statusResponse.json()) as any;
    if (!statusData?.jobStatus) {
      console.warn('[VIDEO] ⚠️ Job status response had no jobStatus, retrying...');
      if (attempts > VIDEO_POLL_MAX_ATTEMPTS) throw videoProcessingTimeoutError();
      await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
      continue;
    }
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
      await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
    }

    if (attempts > VIDEO_POLL_MAX_ATTEMPTS) {
      throw videoProcessingTimeoutError();
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
        // The og:image URL can 404/redirect into an HTML error page instead of
        // an image (server still answers 200), and app.bsky.embed.external's
        // thumb caps at 1,000,000 bytes — tighter than the 2MB post-image
        // limit uploadToBluesky defaults to. Reject bad content types here and
        // pass the thumb's real ceiling so both failure modes get skipped
        // instead of reaching Bluesky as an InvalidRequest.
        if (!mimeType.startsWith('image/')) {
          throw new Error(`og:image was not an image (got ${mimeType})`);
        }
        thumbBlob = await uploadToBluesky(agent, buffer, mimeType, EXTERNAL_THUMB_MAX_SIZE);
      } catch (e) {
        // Silently fail thumbnail upload
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

async function uploadVideoToBluesky(
  agent: BskyAgent,
  buffer: Buffer,
  filename: string,
  signal?: AbortSignal,
): Promise<BlobRef> {
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
      signal: deadlineSignal(VIDEO_UPLOAD_TIMEOUT_MS, signal),
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
          return await pollForVideoProcessing(agent, errorJson.jobId, signal);
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
    return await pollForVideoProcessing(agent, jobStatus.jobId, signal);
  } catch (err) {
    console.error('[VIDEO] ❌ Error in uploadVideoToBluesky:', (err as Error).message);
    throw err;
  }
}

export interface FetchUserTweetsOptions {
  /**
   * The account's numeric id. Fetching by id survives renames, and skips the
   * screen-name lookup request.
   */
  userId?: string;
  /**
   * Throw once retries are exhausted instead of returning an empty list. The
   * sweep needs this: an empty list reads as "no new tweets", which is how a
   * renamed, suspended or protected source used to go quiet forever with no
   * error anywhere.
   */
  throwOnError?: boolean;
}

// Fetches a user's timeline. processedIds enables early stopping.
async function fetchUserTweets(
  username: string,
  limit: number,
  processedIds?: Set<string>,
  sessionKey = 'default',
  options: FetchUserTweetsOptions = {},
): Promise<Tweet[]> {
  const client = await getTwitterScraper(sessionKey);
  if (!client) {
    if (options.throwOnError) throw new Error('Twitter credentials are not configured.');
    return [];
  }

  let retries = 3;
  let lastError: unknown;
  while (retries > 0) {
    const usedBackup = useBackupCredentials;
    try {
      const scraper = (await getTwitterScraper(sessionKey)) ?? client;
      const tweets: Tweet[] = [];
      const generator = options.userId
        ? scraper.getTweetsByUserId(options.userId, limit)
        : scraper.getTweets(username, limit);
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
      lastError = e;
      retries--;
      // Shared with the fetch timeout that produces one of these, so a timed-out
      // request actually takes the retry/credential-switch path rather than
      // failing fast and reporting the account as having no new tweets.
      const isRetryable = isRetryableScraperError(e);

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
        if (retries > 0 && (await switchCredentials(usedBackup))) {
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
      if (options.throwOnError) throw e;
      return [];
    }
  }

  console.log(`[${username}] ⚠️ Scraper returned 0 tweets (or failed silently) after retries.`);
  if (options.throwOnError && lastError) throw lastError;
  return [];
}

// ============================================================================
// Main Processing Logic
// ============================================================================

// ============================================================================
// Main Processing Logic
// ============================================================================

// What happened to one tweet, from the point of view of whoever handed it over.
// Before this existed the queue could only ask "is there a processed_tweets row
// yet?" — so a tweet that was deliberately skipped, one that failed on its
// third chunk, and one the batch never even reached all looked identical, and
// all three ended up parked with the same "Tweet was not posted" placeholder.
//
// `deferred` means "not yet": the tweet depends on another tweet (a reply's
// parent, a retweet's original) that is still in the queue. It is retried
// later rather than posted without its context.
export type TweetOutcomeStatus = 'posted' | 'skipped' | 'failed' | 'deferred' | 'not-attempted';

export interface TweetOutcome {
  status: TweetOutcomeStatus;
  /** Where in the pipeline it ended up: 'filter' | 'media' | 'post' | 'record' | 'login' | … */
  stage: string;
  /** Human sentence explaining this specific tweet's fate. */
  reason: string;
  detail?: ErrorDetail;
  retryable?: boolean;
  uri?: string;
  cid?: string;
  chunks?: number;
  durationMs?: number;
}

/** Per-mapping mirroring behaviour, resolved from the mapping's settings. */
export interface MirrorSettings {
  sensitiveFallbackLabel: SensitiveFallbackLabel;
  editMode: 'skip' | 'replace';
  mirrorRetweets: boolean;
  mirrorRepliesToMirrors: boolean;
}

export function resolveMirrorSettings(mapping?: Partial<AccountMapping> | null): MirrorSettings {
  return {
    sensitiveFallbackLabel: mapping?.sensitiveFallbackLabel ?? 'sexual',
    editMode: mapping?.editMode ?? 'skip',
    mirrorRetweets: mapping?.mirrorRetweets !== false,
    mirrorRepliesToMirrors: mapping?.mirrorRepliesToMirrors !== false,
  };
}

/**
 * Optional per-run context threaded through processTweets so callers can learn
 * what happened to each individual tweet, and so a post can be recorded as
 * "already on Bluesky" the instant it lands rather than after all the
 * follow-up bookkeeping has succeeded.
 */
export interface ProcessContext {
  outcomes?: Map<string, TweetOutcome>;
  /** Fired as soon as the PDS accepts a tweet's first chunk. */
  onPosted?: (twitterId: string, uri: string, cid: string, root: { uri: string; cid: string }) => void;
  /** Fired as each later chunk (or follow-up media post) lands: the new tail. */
  onChunkPosted?: (twitterId: string, uri: string, cid: string) => void;
  /**
   * Fired once a tweet has been composed, before it is posted. The dry-run
   * preview reads this so what the dashboard shows is the real composer's
   * output rather than a second implementation of it.
   */
  onComposed?: (preview: ComposedTweet) => void;
  /**
   * Skip downloading media bytes, recording only what media the tweet has.
   * The preview needs to know a tweet carries a video, not to pull 300MB of it
   * on the way to a mock upload.
   */
  skipMediaDownload?: boolean;
  mappingId?: string;
  jobId?: string;
  /**
   * Cancels the run. Checked before every tweet and every chunk, and passed to
   * media downloads and uploads, so a batch the watchdog gives up on actually
   * stops instead of carrying on posting underneath the retry that replaces it.
   */
  signal?: AbortSignal;
  /** Leave the dashboard's global status and job list alone (the preview). */
  quiet?: boolean;
  /**
   * Whether a tweet is a live mirror (stamped with the posting time) rather
   * than history (stamped with the tweet's own time). Defaults to history.
   */
  isLive?: (twitterId: string) => boolean;
  /** Mapping behaviour; resolved from the mapping when omitted. */
  settings?: MirrorSettings;
}

/** A composed tweet as it would be posted: the thread's chunks and its embeds. */
export interface ComposedTweet {
  twitterId: string;
  chunks: string[];
  images: number;
  video: boolean;
  quote: boolean;
  linkCard: boolean;
  isReply: boolean;
  /** A retweet mirrored as a native repost of this post URI. */
  repostOf?: string;
  langs?: string[];
  /** Media that did not fit the first post and follows as replies. */
  extraMediaPosts?: number;
}

function recordOutcome(context: ProcessContext | undefined, twitterId: string, outcome: TweetOutcome): void {
  context?.outcomes?.set(twitterId, outcome);
}

const isLikelyHandle = (identifier: string): boolean =>
  identifier.includes('.') && !identifier.includes('@') && !identifier.startsWith('did:');

// Bluesky identifier -> DID for mirrors whose DID has not been captured yet.
const mirrorDidCache = new Map<string, string>();

/**
 * Which Twitter usernames in `text` are mirrored on this instance, and the DID
 * of each mirror. Captured DIDs are used as-is; a mirror that has not logged in
 * since DIDs were recorded is resolved once through the agent and cached.
 */
async function buildMirrorDidResolver(
  agent: BskyAgent,
  text: string,
): Promise<(username: string) => string | undefined> {
  const mentioned = new Set(
    [...text.matchAll(/@([A-Za-z0-9_]{1,15})/g)].map((match) => (match[1] ?? '').toLowerCase()),
  );
  const resolved = new Map<string, string>();
  if (mentioned.size === 0) return () => undefined;

  const byUsername = new Map<string, AccountMapping>();
  // Enabled mappings first so a duplicate username points at the live mirror.
  const mappings = [...getConfig().mappings].sort((a, b) => Number(b.enabled) - Number(a.enabled));
  for (const mapping of mappings) {
    for (const username of mapping.twitterUsernames) {
      const key = username.toLowerCase();
      if (!byUsername.has(key)) byUsername.set(key, mapping);
    }
  }

  for (const username of mentioned) {
    const mapping = byUsername.get(username);
    if (!mapping) continue;
    const identifier = mapping.bskyIdentifier.toLowerCase();
    let did =
      mapping.bskyDid ?? (identifier.startsWith('did:') ? identifier : undefined) ?? mirrorDidCache.get(identifier);
    // biome-ignore lint/suspicious/noExplicitAny: mock agents (preview, tests) may not implement resolveHandle
    const resolveHandle = (agent as any)?.resolveHandle;
    if (!did && typeof resolveHandle === 'function' && isLikelyHandle(identifier)) {
      try {
        const response = await withTimeout<{ data: { did: string } }>(
          resolveHandle.call(agent, { handle: identifier }),
          10_000,
          'Handle resolution timed out',
        );
        did = response.data.did;
        mirrorDidCache.set(identifier, did);
      } catch {
        did = undefined;
      }
    }
    if (did) resolved.set(username, did);
  }
  return (username: string) => resolved.get(username.toLowerCase());
}

/** at:// post URI -> bsky.app URL, using the handle when the identifier is one. */
function mirroredPostUrl(record: ProcessedTweet): string | null {
  if (!record.bsky_uri) return null;
  return bskyPostUrl(record.bsky_uri, isLikelyHandle(record.bsky_identifier) ? record.bsky_identifier : undefined);
}

function tweetIdLess(a: string, b: string): boolean {
  try {
    return BigInt(a) < BigInt(b);
  } catch {
    return a.length === b.length ? a < b : a.length < b.length;
  }
}

/** Trim to at most `limit` graphemes, adding an ellipsis when something was cut. */
function truncateText(text: string, limit: number): string {
  if (graphemeLength(text) <= limit) return text;
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
    (segment) => segment.segment,
  );
  return `${segments
    .slice(0, Math.max(0, limit - 1))
    .join('')
    .trimEnd()}…`;
}

/** Upload a remote image as a link-card thumbnail. Failure just means no thumbnail. */
async function uploadCardThumb(
  agent: BskyAgent,
  imageUrl: string | undefined,
  dryRun: boolean,
  context: ProcessContext | undefined,
): Promise<BlobRef | undefined> {
  if (!imageUrl) return undefined;
  if (dryRun || context?.skipMediaDownload) {
    return { ref: { toString: () => 'preview-thumb' }, mimeType: 'image/jpeg', size: 0 } as unknown as BlobRef;
  }
  try {
    const { buffer, mimeType } = await downloadMedia(imageUrl, 60_000, context?.signal);
    if (!mimeType.startsWith('image/')) return undefined;
    return await uploadToBluesky(agent, buffer, mimeType, EXTERNAL_THUMB_MAX_SIZE);
  } catch {
    return undefined;
  }
}

/**
 * Alt text for an image: the author's own, else an AI description when a
 * provider is configured, else nothing. "Image from Twitter" used to fill the
 * gap, which lit up Bluesky's ALT badge while describing nothing.
 */
async function resolveImageAlt(
  media: MediaEntity,
  buffer: Buffer,
  mimeType: string,
  describe: () => string,
  twitterUsername: string,
): Promise<string> {
  if (media.ext_alt_text) return media.ext_alt_text;
  if (!isAltTextConfigured()) return '';
  console.log(`[${twitterUsername}] 🤖 Generating alt text via AI provider...`);
  const generated = await generateAltText(buffer, mimeType, describe());
  if (generated) console.log(`[${twitterUsername}] ✅ Alt text generated: ${generated.substring(0, 50)}...`);
  return generated || '';
}

interface VideoUpload {
  blob: BlobRef;
  aspectRatio?: AspectRatio;
  alt?: string;
  /** Twitter "GIFs" are silent looping mp4s; Bluesky presents them the same way. */
  gif: boolean;
}

function buildVideoEmbed(video: VideoUpload) {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic record construction
  const embed: Record<string, any> = { $type: 'app.bsky.embed.video', video: video.blob };
  if (video.aspectRatio) embed.aspectRatio = video.aspectRatio;
  if (video.alt) embed.alt = truncateText(video.alt, 1000);
  if (video.gif) embed.presentation = 'gif';
  return embed;
}

export async function processTweets(
  agent: BskyAgent,
  twitterUsername: string,
  bskyIdentifier: string,
  tweets: Tweet[],
  dryRun = false,
  sharedProcessedMap?: ProcessedTweetsMap,
  sharedTweetMap?: Map<string, Tweet>,
  sessionKey = 'default',
  context?: ProcessContext,
): Promise<void> {
  const logScope = { twitterUsername, bskyIdentifier, mappingId: context?.mappingId, jobId: context?.jobId };
  const settings =
    context?.settings ??
    resolveMirrorSettings(
      getConfig().mappings.find(
        (mapping) =>
          (context?.mappingId && mapping.id === context.mappingId) ||
          mapping.bskyIdentifier.toLowerCase() === bskyIdentifier.toLowerCase(),
      ),
    );
  // The preview runs this same path; it must not repaint the dashboard's
  // global status or job list as if a real mapping were mirroring.
  const reportStatus = context?.quiet ? () => undefined : updateAppStatus;
  const reportJob = context?.quiet ? () => undefined : updateJob;

  // Filter tweets to ensure they're actually from this user
  const filteredTweets = tweets.filter((t) => {
    const authorScreenName = t.user?.screen_name?.toLowerCase();
    if (authorScreenName && authorScreenName !== twitterUsername.toLowerCase()) {
      const id = t.id_str || t.id || '';
      // Recorded as an outcome, not just a console line: otherwise the queue
      // row for this tweet never settles and retries until it is parked.
      recordOutcome(context, id, {
        status: 'skipped',
        stage: 'filter',
        reason: `Timeline entry is authored by @${t.user?.screen_name}, not @${twitterUsername}`,
      });
      logEvent({
        level: 'debug',
        stage: 'post',
        event: 'tweet.skipped.author-mismatch',
        message: `Skipped tweet ${id}: authored by @${t.user?.screen_name}, not @${twitterUsername}`,
        twitterId: id,
        ...logScope,
      });
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
    logEvent({
      level: 'debug',
      stage: 'post',
      event: 'batch.nothing-to-do',
      message: `Nothing new to post for ${bskyIdentifier}: all ${filteredTweets.length} tweet(s) already have a record.`,
      detail: { handedOver: tweets.length, afterAuthorFilter: filteredTweets.length },
      ...logScope,
    });
    return;
  }

  logEvent({
    level: 'info',
    stage: 'post',
    event: 'batch.start',
    message: `Processing ${toProcess.length} new tweet(s) for ${bskyIdentifier}.`,
    detail: { handedOver: tweets.length, afterAuthorFilter: filteredTweets.length, newTweets: toProcess.length },
    ...logScope,
  });

  const mirrorJobId = `mirror:${bskyIdentifier.toLowerCase()}:${twitterUsername.toLowerCase()}`;
  let mirroredCount = 0;

  const skip = (
    tweetId: string,
    stage: string,
    reason: string,
    text: string,
    level: 'debug' | 'info' | 'warn' = 'debug',
    event = `tweet.skipped.${stage}`,
    extra: Partial<TweetOutcome> = {},
  ) => {
    logEvent({
      level,
      stage: 'post',
      event,
      message: `Skipped tweet ${tweetId}: ${reason}`,
      twitterId: tweetId,
      error: extra.detail,
      ...logScope,
    });
    recordOutcome(context, tweetId, { status: 'skipped', stage, reason, ...extra });
    if (!dryRun) {
      saveProcessedTweet(twitterUsername, bskyIdentifier, tweetId, { skipped: true, text });
      localProcessedMap[tweetId] = { skipped: true, status: 'skipped', text };
    }
  };

  const defer = (tweetId: string, stage: string, reason: string) => {
    logEvent({
      level: 'info',
      stage: 'post',
      event: 'tweet.deferred',
      message: `Deferred tweet ${tweetId}: ${reason}`,
      twitterId: tweetId,
      ...logScope,
    });
    recordOutcome(context, tweetId, { status: 'deferred', stage, reason, retryable: true });
  };

  filteredTweets.reverse();
  let count = 0;
  for (const tweet of filteredTweets) {
    count++;
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;
    // A cancelled batch stops here; tweets not reached get no outcome, which
    // the queue treats as "not attempted" and re-arms without penalty.
    if (context?.signal?.aborted) break;

    const tweetStartedAt = Date.now();

    if (localProcessedMap[tweetId]) {
      const known = localProcessedMap[tweetId];
      recordOutcome(context, tweetId, {
        status: known?.skipped ? 'skipped' : 'posted',
        stage: 'already-known',
        reason: known?.skipped
          ? 'Already recorded as skipped in an earlier run.'
          : 'Already mirrored in an earlier run.',
        uri: known?.uri,
        cid: known?.cid,
      });
      continue;
    }

    // Fallback to DB in case a nested backfill already saved this tweet.
    const dbRecord = dbService.getTweet(tweetId, bskyIdentifier);
    if (dbRecord) {
      localProcessedMap[tweetId] = entryFromRecord(dbRecord);
      recordOutcome(context, tweetId, {
        status: dbRecord.status === 'skipped' ? 'skipped' : 'posted',
        stage: 'already-recorded',
        reason: `Already in the processed history as "${dbRecord.status}".`,
        uri: dbRecord.bsky_uri,
        cid: dbRecord.bsky_cid,
      });
      continue;
    }

    const tweetText = tweet.full_text || tweet.text || '';
    const isRetweet = Boolean(tweet.isRetweet || tweet.retweeted_status_id_str || tweetText.startsWith('RT @'));

    if (isRetweet) {
      // A retweet of a tweet this instance already mirrors becomes a native
      // Bluesky repost. Anything else still has nothing to point at.
      const originalId = tweet.retweeted_status_id_str;
      const original =
        settings.mirrorRetweets && originalId ? dbService.findMirroredPost(originalId, bskyIdentifier) : null;
      if (original?.bsky_uri && original.bsky_cid) {
        context?.onComposed?.({
          twitterId: tweetId,
          chunks: [],
          images: 0,
          video: false,
          quote: false,
          linkCard: false,
          isReply: false,
          repostOf: original.bsky_uri,
        });
        if (dryRun) {
          recordOutcome(context, tweetId, {
            status: 'posted',
            stage: 'repost',
            reason: `Would repost ${original.bsky_uri}.`,
          });
          continue;
        }
        try {
          const repost = await withTimeout(
            agent.repost(original.bsky_uri, original.bsky_cid),
            60_000,
            'Repost request timed out after 60s',
          );
          saveProcessedTweet(twitterUsername, bskyIdentifier, tweetId, {
            status: 'reposted',
            uri: repost.uri,
            cid: repost.cid,
            text: tweetText,
            postedAt: Date.now(),
          });
          localProcessedMap[tweetId] = { status: 'reposted', text: tweetText };
          mirroredCount++;
          logEvent({
            level: 'info',
            stage: 'post',
            event: 'tweet.reposted',
            message: `Mirrored retweet ${tweetId} as a repost of ${original.bsky_uri}.`,
            twitterId: tweetId,
            detail: { originalTweetId: originalId, originalUri: original.bsky_uri, repostUri: repost.uri },
            ...logScope,
          });
          recordOutcome(context, tweetId, {
            status: 'posted',
            stage: 'repost',
            reason: `Reposted ${original.bsky_uri}.`,
            uri: repost.uri,
            cid: repost.cid,
          });
        } catch (err) {
          const detail = toErrorDetail(err);
          logEvent({
            level: 'error',
            stage: 'bluesky',
            event: 'tweet.repost.failed',
            message: `Could not repost ${original.bsky_uri} for retweet ${tweetId}: ${describeErrorDetail(detail)}`,
            twitterId: tweetId,
            error: detail,
            ...logScope,
          });
          recordOutcome(context, tweetId, {
            status: 'failed',
            stage: 'repost',
            reason: `Repost failed: ${describeErrorDetail(detail)}`,
            detail,
            retryable: detail.retryable ?? true,
          });
        }
        continue;
      }
      if (settings.mirrorRetweets && originalId && postQueueService.isQueuedAnywhere(originalId)) {
        defer(tweetId, 'repost', `Waiting for retweeted tweet ${originalId} to be mirrored so it can be reposted.`);
        continue;
      }
      skip(
        tweetId,
        'filter',
        settings.mirrorRetweets
          ? 'Retweets are only mirrored as reposts of tweets this instance mirrors.'
          : 'Retweets are not mirrored for this account.',
        tweetText,
        'debug',
        'tweet.skipped.retweet',
      );
      continue;
    }

    // Edits: X gives an edited tweet a new id, and the timeline then carries
    // only the new version. Without this check both versions were mirrored.
    const earlierVersionId = (tweet.versions ?? [])
      .filter((versionId) => versionId !== tweetId && tweetIdLess(versionId, tweetId))
      .find((versionId) => {
        const entry =
          localProcessedMap[versionId] ??
          (() => {
            const record = dbService.getTweet(versionId, bskyIdentifier);
            return record ? entryFromRecord(record) : undefined;
          })();
        return Boolean(entry?.migrated && entry.uri);
      });
    if (earlierVersionId) {
      if (settings.editMode !== 'replace') {
        skip(
          tweetId,
          'edit',
          `Edited version of tweet ${earlierVersionId}, which is already mirrored (edit mode: skip).`,
          tweetText,
          'info',
          'tweet.skipped.edit',
        );
        continue;
      }
      const previous =
        localProcessedMap[earlierVersionId] ??
        entryFromRecord(dbService.getTweet(earlierVersionId, bskyIdentifier) as ProcessedTweet);
      const staleUris = [...new Set([...(previous.chunkUris ?? []), previous.uri, previous.tail?.uri])].filter(
        (uri): uri is string => Boolean(uri),
      );
      if (!dryRun) {
        for (const uri of staleUris) {
          try {
            await withTimeout(agent.deletePost(uri), 60_000, 'Delete request timed out after 60s');
          } catch (err) {
            logEvent({
              level: 'warn',
              stage: 'bluesky',
              event: 'tweet.edit.delete-failed',
              message: `Could not delete ${uri} while replacing edited tweet ${earlierVersionId}.`,
              twitterId: tweetId,
              error: toErrorDetail(err),
              ...logScope,
            });
          }
        }
        dbService.markDeleted(earlierVersionId, bskyIdentifier);
        localProcessedMap[earlierVersionId] = { status: 'deleted', text: previous.text };
      }
      logEvent({
        level: 'info',
        stage: 'post',
        event: 'tweet.edit.replacing',
        message: `Tweet ${tweetId} is an edit of ${earlierVersionId}; ${dryRun ? 'would replace' : 'replaced'} the earlier mirror (${staleUris.length} post(s)).`,
        twitterId: tweetId,
        detail: { earlierVersionId, deletedUris: staleUris },
        ...logScope,
      });
    }

    logEvent({
      level: 'debug',
      stage: 'post',
      event: 'tweet.inspect',
      message: `Inspecting tweet ${tweetId} (${count}/${filteredTweets.length}).`,
      twitterId: tweetId,
      ...logScope,
    });
    reportJob(mirrorJobId, {
      kind: 'mirroring',
      account: twitterUsername,
      target: bskyIdentifier,
      message: `Mirroring tweet ${tweetId}`,
      processedCount: mirroredCount,
      totalCount: toProcess.length,
    });
    reportStatus({
      state: 'processing',
      currentAccount: twitterUsername,
      processedCount: count,
      totalCount: filteredTweets.length,
      message: `Inspecting tweet ${tweetId}`,
    });

    const replyStatusId = tweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id;
    const replyUserId = tweet.in_reply_to_user_id_str || tweet.in_reply_to_user_id;
    // Reply fields only: a standalone tweet that merely starts with "@nasa" is
    // not a reply, and treating it as one silently dropped it.
    const isReply = Boolean(replyStatusId || replyUserId);

    let replyParentInfo: ProcessedTweetEntry | null = null;

    if (isReply) {
      const localParent = replyStatusId ? localProcessedMap[replyStatusId] : undefined;
      if (replyStatusId && localParent) {
        if (localParent.migrated && localParent.uri && localParent.cid) {
          console.log(`[${twitterUsername}] 🧵 Threading reply to post in ${bskyIdentifier}: ${replyStatusId}`);
          replyParentInfo = localParent;
        } else {
          // The parent is in the history but was not posted (a reply to someone
          // else, a retweet, an empty shell). Posting this reply anyway put it
          // on the timeline as a standalone post with no context.
          skip(
            tweetId,
            'thread',
            `Parent tweet ${replyStatusId} was not mirrored (${localParent.status ?? 'skipped'}), so this reply would appear without its context.`,
            tweetText,
            'debug',
            'tweet.skipped.unmirrored-parent',
          );
          continue;
        }
      } else if (replyStatusId) {
        // Another account on this instance may mirror the parent: then this is
        // a real conversation between two mirrors and threads natively.
        const mirroredParent = dbService.findMirroredPost(replyStatusId, bskyIdentifier);
        const isOwnParent = mirroredParent?.bsky_identifier === bskyIdentifier.toLowerCase();
        if (mirroredParent && (isOwnParent || settings.mirrorRepliesToMirrors)) {
          console.log(
            `[${twitterUsername}] 💬 Replying natively to ${mirroredParent.bsky_identifier}'s mirror of ${replyStatusId}`,
          );
          replyParentInfo = entryFromRecord(mirroredParent);
        } else if (
          postQueueService.isQueuedAnywhere(replyStatusId, settings.mirrorRepliesToMirrors ? undefined : bskyIdentifier)
        ) {
          // The parent is still waiting to post. Try again once it has, rather
          // than fetching it from Twitter or posting the reply out of order.
          defer(tweetId, 'thread', `Waiting for parent tweet ${replyStatusId} to be mirrored first.`);
          continue;
        } else {
          // Parent missing from local batch/DB. Attempt to fetch it if it's a self-thread.
          console.log(`[${twitterUsername}] 🕵️ Parent ${replyStatusId} missing. Checking if backfillable...`);

          let parentBackfilled = false;
          let parentLookupError: ErrorDetail | undefined;
          try {
            const scraper = await getTwitterScraper(sessionKey);
            if (scraper) {
              const parentRaw = await scraper.getTweet(replyStatusId);
              if (parentRaw) {
                const parentTweet = mapScraperTweetToLocalTweet(parentRaw);
                const parentAuthor = parentTweet.user?.screen_name;

                if (parentAuthor?.toLowerCase() === twitterUsername.toLowerCase()) {
                  console.log(`[${twitterUsername}] 🔄 Parent is ours (@${parentAuthor}). Backfilling parent first...`);
                  addTweetsToMap(tweetMap, [parentTweet]);
                  // Recursively process the parent. The nested run gets its own
                  // outcome map so a parent's fate never overwrites the child's
                  // entry in the caller's map.
                  await processTweets(
                    agent,
                    twitterUsername,
                    bskyIdentifier,
                    [parentTweet],
                    dryRun,
                    localProcessedMap,
                    tweetMap,
                    sessionKey,
                    { ...context, outcomes: new Map<string, TweetOutcome>() },
                  );

                  const savedParent = dbService.getTweet(replyStatusId, bskyIdentifier);
                  if (savedParent && savedParent.status === 'migrated') {
                    localProcessedMap[replyStatusId] = entryFromRecord(savedParent);
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
            parentLookupError = toErrorDetail(e);
            logEvent({
              level: 'warn',
              stage: 'twitter',
              event: 'thread.parent-lookup.failed',
              message: `Could not fetch parent tweet ${replyStatusId} while threading ${tweetId}.`,
              twitterId: tweetId,
              error: parentLookupError,
              detail: { parentTweetId: replyStatusId },
              ...logScope,
            });
          }

          if (!parentBackfilled) {
            // Distinguish "this reply is genuinely external" from "we could not
            // reach Twitter to find out" — the first is a permanent skip, the
            // second is a transient failure that shouldn't silently discard a
            // tweet that belongs in the thread.
            const reason = parentLookupError
              ? `Parent tweet ${replyStatusId} could not be fetched (${describeErrorDetail(parentLookupError)}); treated as an external reply.`
              : `Parent tweet ${replyStatusId} is not ours or no longer exists, so this reply is external.`;
            skip(
              tweetId,
              'thread',
              reason,
              tweetText,
              parentLookupError ? 'warn' : 'debug',
              'tweet.skipped.external-reply',
              {
                detail: parentLookupError,
              },
            );
            continue;
          }
        }
      } else {
        skip(
          tweetId,
          'thread',
          'Reply has no parent tweet id (reply to a user, not a specific post), so it is external.',
          tweetText,
          'debug',
          'tweet.skipped.external-reply',
        );
        continue;
      }
    }

    let text = decodeHtmlEntities(tweetText);

    // 1. Link Expansion
    console.log(`[${twitterUsername}] 🔗 Expanding links...`);
    const urls = tweet.entities?.urls || [];
    for (const urlEntity of urls) {
      const tco = urlEntity.url;
      const expanded = urlEntity.expanded_url;
      if (tco && expanded) text = text.split(tco).join(expanded);
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
    const videos: VideoUpload[] = [];
    // Set when a video could not be carried over: the post then links to the
    // tweet, as a card with the video's poster frame when nothing else claims
    // the embed, or as a plain link when something does.
    let videoFallback: { tweetUrl: string; posterUrl?: string } | null = null;
    const mediaEntities = tweet.extended_entities?.media || tweet.entities?.media || [];
    const mediaLinksToRemove: string[] = [];
    // Media that was present on the tweet but did not make it to Bluesky, with
    // the reason. Surfaces in the log line for the post so a mysteriously
    // text-only mirror can be traced back to the upload that failed.
    const droppedMedia: { type: string; url?: string; reason: string }[] = [];
    const describeForAlt = () => buildAltTextContext(tweet, tweetText, tweetMap);
    const tweetUrl = `https://x.com/${twitterUsername}/status/${tweetId}`;

    console.log(`[${twitterUsername}] 🖼️ Found ${mediaEntities.length} media entities.`);

    for (const media of mediaEntities) {
      if (context?.signal?.aborted) break;
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
      if (media.original_info?.width && media.original_info?.height) {
        aspectRatio = { width: media.original_info.width, height: media.original_info.height };
      } else if (media.sizes?.large) {
        aspectRatio = { width: media.sizes.large.w, height: media.sizes.large.h };
      }

      if (media.type === 'photo') {
        const url = media.media_url_https;
        if (!url) continue;
        if (images.length >= 4) {
          droppedMedia.push({ type: 'photo', url, reason: 'Bluesky posts carry at most four images.' });
          continue;
        }
        if (context?.skipMediaDownload) {
          images.push({
            alt: media.ext_alt_text || '',
            image: { ref: { toString: () => 'preview-blob' }, mimeType: 'image/jpeg', size: 0 } as any,
            aspectRatio,
          });
          continue;
        }
        try {
          const highQualityUrl = url.includes('?') ? url.replace('?', ':orig?') : `${url}:orig`;
          console.log(`[${twitterUsername}] 📥 Downloading image (high quality): ${path.basename(highQualityUrl)}`);
          reportStatus({ message: 'Downloading high quality image...' });
          const { buffer, mimeType } = await downloadMedia(highQualityUrl, 120000, context?.signal);

          let blob: BlobRef;
          if (dryRun) {
            console.log(
              `[${twitterUsername}] 🧪 [DRY RUN] Would upload image (${(buffer.length / 1024).toFixed(2)} KB)`,
            );
            blob = { ref: { toString: () => 'mock-blob' }, mimeType, size: buffer.length } as any;
          } else {
            console.log(`[${twitterUsername}] 📤 Uploading image to Bluesky...`);
            reportStatus({ message: 'Uploading image to Bluesky...' });
            blob = await uploadToBluesky(agent, buffer, mimeType);
          }

          const alt = await resolveImageAlt(media, buffer, mimeType, describeForAlt, twitterUsername);
          images.push({ alt, image: blob, aspectRatio });
          console.log(`[${twitterUsername}] ✅ Image uploaded.`);
        } catch (err) {
          const detail = toErrorDetail(err);
          logEvent({
            level: 'warn',
            stage: 'media',
            event: 'image.upload.failed',
            message: `Full-quality image upload failed for tweet ${tweetId}; falling back to standard quality.`,
            twitterId: tweetId,
            error: detail,
            detail: { mediaUrl: url },
            ...logScope,
          });
          try {
            console.log(`[${twitterUsername}] 🔄 Retrying with standard quality...`);
            reportStatus({ message: 'Retrying with standard quality...' });
            const { buffer, mimeType } = await downloadMedia(url, 120000, context?.signal);
            const blob = dryRun
              ? ({ ref: { toString: () => 'mock-blob' }, mimeType, size: buffer.length } as any)
              : await uploadToBluesky(agent, buffer, mimeType);
            // Same alt-text rules as the first attempt: the fallback used to
            // skip AI descriptions entirely.
            const alt = await resolveImageAlt(media, buffer, mimeType, describeForAlt, twitterUsername);
            images.push({ alt, image: blob, aspectRatio });
            console.log(`[${twitterUsername}] ✅ Image uploaded on retry.`);
          } catch (retryErr) {
            const retryDetail = toErrorDetail(retryErr);
            // The post still goes out; it just loses this image. Recorded as a
            // warning so a silently text-only post is explainable afterwards.
            logEvent({
              level: 'warn',
              stage: 'media',
              event: 'image.upload.dropped',
              message: `Image dropped from tweet ${tweetId}: both quality levels failed to upload.`,
              twitterId: tweetId,
              error: retryDetail,
              detail: { mediaUrl: url, firstAttempt: detail.message },
              ...logScope,
            });
            droppedMedia.push({ type: 'photo', url, reason: describeErrorDetail(retryDetail) });
          }
        }
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        const variants = media.video_info?.variants || [];
        const duration = media.video_info?.duration_millis || 0;
        const gif = media.type === 'animated_gif';
        const fallBack = () => {
          if (!videoFallback) videoFallback = { tweetUrl, posterUrl: media.media_url_https };
        };

        if (duration > MAX_VIDEO_DURATION_MS) {
          const limitSeconds = Math.round(MAX_VIDEO_DURATION_MS / 1000);
          const reason = `Video is ${(duration / 1000).toFixed(1)}s, over Bluesky's ${limitSeconds}s limit; linked back to the tweet instead.`;
          logEvent({
            level: 'info',
            stage: 'media',
            event: 'video.too-long',
            message: `Tweet ${tweetId}: ${reason}`,
            twitterId: tweetId,
            detail: { durationMs: duration, limitMs: MAX_VIDEO_DURATION_MS },
            ...logScope,
          });
          droppedMedia.push({ type: 'video', reason });
          fallBack();
          continue;
        }

        // Best-quality-first, minus the variants a 10-minute clip would blow the
        // size ceiling with. Each is tried in turn so an oversized download steps
        // down a rung instead of dropping the video entirely.
        const candidates = selectVideoVariants(variants, duration);

        if (candidates.length > 0 && context?.skipMediaDownload) {
          videos.push({
            blob: { ref: { toString: () => 'preview-blob' }, mimeType: 'video/mp4', size: 0 } as any,
            aspectRatio,
            alt: media.ext_alt_text,
            gif,
          });
          continue;
        }

        if (candidates.length > 0) {
          let uploaded = false;
          let lastFailure: { url: string; reason: string } | undefined;

          for (const [index, variant] of candidates.entries()) {
            const videoUrl = variant.url;
            const hasFallbackVariant = index < candidates.length - 1;
            try {
              console.log(`[${twitterUsername}] 📥 Downloading video: ${videoUrl}`);
              reportStatus({ message: `Downloading video: ${path.basename(videoUrl)}` });
              const { buffer } = await downloadMedia(videoUrl, 30 * 60 * 1000, context?.signal);

              if (buffer.length > MAX_VIDEO_UPLOAD_BYTES) {
                const limitMb = Math.round(MAX_VIDEO_UPLOAD_BYTES / 1024 / 1024);
                const sizeReason = `Video is ${(buffer.length / 1024 / 1024).toFixed(2)}MB, over the ${limitMb}MB upload ceiling.`;
                logEvent({
                  level: 'info',
                  stage: 'media',
                  event: 'video.too-large',
                  message: `Tweet ${tweetId}: ${sizeReason}${hasFallbackVariant ? ' Trying a lower-bitrate variant.' : ' Linked back to the tweet instead.'}`,
                  twitterId: tweetId,
                  detail: { bytes: buffer.length, limitBytes: MAX_VIDEO_UPLOAD_BYTES, videoUrl },
                  ...logScope,
                });
                lastFailure = {
                  url: videoUrl,
                  reason: `${sizeReason} Linked back to the tweet instead.`,
                };
                continue;
              }

              const filename = videoUrl.split('/').pop() || 'video.mp4';
              let blob: BlobRef;
              if (dryRun) {
                console.log(
                  `[${twitterUsername}] 🧪 [DRY RUN] Would upload video: ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`,
                );
                blob = {
                  ref: { toString: () => 'mock-video-blob' },
                  mimeType: 'video/mp4',
                  size: buffer.length,
                } as any;
              } else {
                reportStatus({ message: 'Uploading video to Bluesky...' });
                blob = await uploadVideoToBluesky(agent, buffer, filename, context?.signal);
              }
              videos.push({ blob, aspectRatio, alt: media.ext_alt_text, gif });
              uploaded = true;
              console.log(`[${twitterUsername}] ✅ Video upload process complete.`);
              break;
            } catch (err) {
              const videoDetail = toErrorDetail(err);
              // VIDEO_FALLBACK_503 is Bluesky's video service being busy — an
              // expected condition with a working fallback, so it stays at info.
              const expected = videoDetail.message === 'VIDEO_FALLBACK_503';
              const willRetry = isDownloadFailure(err) && hasFallbackVariant && !context?.signal?.aborted;
              const outcome = willRetry ? 'trying a lower-bitrate variant' : 'linked back to the tweet instead';
              logEvent({
                level: expected ? 'info' : 'warn',
                stage: 'media',
                event: expected ? 'video.service-unavailable' : 'video.upload.failed',
                message: expected
                  ? `Tweet ${tweetId}: Bluesky's video service was unavailable; ${outcome}.`
                  : `Tweet ${tweetId}: video upload failed; ${outcome}.`,
                twitterId: tweetId,
                error: expected ? undefined : videoDetail,
                detail: { videoUrl },
                ...logScope,
              });
              lastFailure = {
                url: videoUrl,
                reason: expected ? 'Bluesky video service unavailable' : describeErrorDetail(videoDetail),
              };
              // A download that never completed can still succeed at a lower
              // bitrate; anything past the download (upload, transcode, auth)
              // will fail the same way for every variant, so stop there.
              if (!willRetry) break;
            }
          }

          if (!uploaded) {
            if (lastFailure) {
              droppedMedia.push({ type: 'video', url: lastFailure.url, reason: lastFailure.reason });
            }
            fallBack();
          }
        }
      }
    }

    // The batch was cancelled while media was in flight: stop before posting.
    if (context?.signal?.aborted) break;

    // One Bluesky post holds either a video or up to four images. Mixed-media
    // tweets used to lose their photos silently; now the first video leads and
    // the rest follow as replies directly under it.
    const primaryVideo = videos[0];
    const primaryImages = primaryVideo ? [] : images;
    const extraImages = primaryVideo ? images : [];
    const extraVideos = videos.slice(1);

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

    const hasMedia = Boolean(primaryVideo) || primaryImages.length > 0;

    // 3. Quoting Logic
    let quoteEmbed: { $type: string; record: { uri: string; cid: string } } | null = null;
    let externalQuoteUrl: string | null = null;
    let quotedInfo: QuotedTweetInfo | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: app.bsky.embed.external payload
    let cardEmbed: any = null;
    const quoteId = tweet.is_quote_status ? tweet.quoted_status_id_str : undefined;

    const removeStatusLinks = (id: string) => {
      for (const urlEntity of urls) {
        const expanded = urlEntity.expanded_url;
        if (expanded && parseTweetStatusUrl(expanded)?.id === id) {
          text = text.split(expanded).join('').replace(/\s\s+/g, ' ').trim();
        }
      }
    };

    if (quoteId) {
      // Quoted tweet mirrored anywhere on this instance — by this account or
      // another — embeds natively.
      const localRef = localProcessedMap[quoteId];
      const ref =
        localRef?.migrated && localRef.uri && localRef.cid
          ? { uri: localRef.uri, cid: localRef.cid }
          : (() => {
              const row = dbService.findMirroredPost(quoteId, bskyIdentifier);
              return row?.bsky_uri && row.bsky_cid ? { uri: row.bsky_uri, cid: row.bsky_cid } : null;
            })();
      if (ref) {
        console.log(`[${twitterUsername}] 🔄 Quoted tweet is mirrored on this instance. Natively embedding.`);
        quoteEmbed = { $type: 'app.bsky.embed.record', record: ref };
        removeStatusLinks(quoteId);
      } else {
        const quoteUrlEntity = urls.find((u) => u.expanded_url && parseTweetStatusUrl(u.expanded_url)?.id === quoteId);
        quotedInfo = tweet.quoted_status?.id === quoteId ? tweet.quoted_status : undefined;
        externalQuoteUrl = (
          quoteUrlEntity?.expanded_url ||
          quotedInfo?.url ||
          `https://x.com/i/status/${quoteId}`
        ).replace(/^https?:\/\/(www\.|mobile\.)?twitter\.com\//, 'https://x.com/');
        console.log(`[${twitterUsername}] 🔗 Quoted tweet is not on Bluesky: ${externalQuoteUrl}`);
      }
    }

    // Links to tweets that are mirrored here point at the Bluesky copy instead
    // of sending readers back to X. A single such link, with nothing else to
    // embed, becomes a native quote.
    const statusLinkRewrites: { from: string; to: string; uri: string; cid: string }[] = [];
    for (const urlEntity of urls) {
      const expanded = urlEntity.expanded_url;
      if (!expanded) continue;
      const ref = parseTweetStatusUrl(expanded);
      if (!ref || ref.id === quoteId || ref.id === tweetId) continue;
      const row = dbService.findMirroredPost(ref.id, bskyIdentifier);
      const to = row ? mirroredPostUrl(row) : null;
      if (row?.bsky_uri && row.bsky_cid && to) {
        statusLinkRewrites.push({ from: expanded, to, uri: row.bsky_uri, cid: row.bsky_cid });
      }
    }
    if (!quoteEmbed && !externalQuoteUrl && !hasMedia && statusLinkRewrites.length === 1) {
      const only = statusLinkRewrites[0] as (typeof statusLinkRewrites)[number];
      quoteEmbed = { $type: 'app.bsky.embed.record', record: { uri: only.uri, cid: only.cid } };
      text = text.split(only.from).join('').replace(/\s\s+/g, ' ').trim();
    } else {
      for (const rewrite of statusLinkRewrites) text = text.split(rewrite.from).join(rewrite.to);
    }
    const rewrittenTargets = new Set(statusLinkRewrites.map((rewrite) => rewrite.from));

    if (externalQuoteUrl && hasMedia) {
      // The embed slot holds this tweet's own media, so the quote cannot be a
      // card. A screenshot rides along as an extra image when a browser exists.
      let screenshotAdded = false;
      if (primaryImages.length < 4 && !primaryVideo && !context?.skipMediaDownload) {
        const ssResult = await captureTweetScreenshot(externalQuoteUrl);
        if (ssResult) {
          try {
            const blob = dryRun
              ? ({
                  ref: { toString: () => 'mock-ss-blob' },
                  mimeType: 'image/png',
                  size: ssResult.buffer.length,
                } as any)
              : await uploadToBluesky(agent, ssResult.buffer, 'image/png');
            primaryImages.push({
              alt: quotedInfo?.text
                ? truncateText(
                    `Quoted post by @${quotedInfo.username ?? 'unknown'}: ${decodeHtmlEntities(quotedInfo.text)}`,
                    1000,
                  )
                : `Screenshot of the quoted post ${externalQuoteUrl}`,
              image: blob,
              aspectRatio: { width: ssResult.width, height: ssResult.height },
            });
            screenshotAdded = true;
          } catch {
            console.warn(`[${twitterUsername}] ⚠️ Failed to upload screenshot blob.`);
          }
        }
      }
      if (!screenshotAdded && !text.includes(externalQuoteUrl)) text += `\n\nQT: ${externalQuoteUrl}`;
    } else if (!quoteEmbed && videoFallback && !hasMedia) {
      // A video that could not be uploaded: a card with its poster frame reads
      // like media on Bluesky; a bare "Video: <url>" line did not.
      const fallback = videoFallback as { tweetUrl: string; posterUrl?: string };
      const thumb = await uploadCardThumb(agent, fallback.posterUrl, dryRun, context);
      cardEmbed = {
        $type: 'app.bsky.embed.external',
        external: {
          uri: fallback.tweetUrl,
          title: `Video from @${twitterUsername} on X`,
          description: 'This video could not be copied to Bluesky. Watch it on X.',
          ...(thumb ? { thumb } : {}),
        },
      };
    } else if (externalQuoteUrl && !quoteEmbed) {
      if (quotedInfo) {
        // The quoted tweet is not on Bluesky, but the timeline already told us
        // what it says: show it as a card rather than a bare "QT:" link.
        const thumb = await uploadCardThumb(agent, quotedInfo.imageUrl, dryRun, context);
        const author = quotedInfo.username ? `@${quotedInfo.username}` : 'a post';
        cardEmbed = {
          $type: 'app.bsky.embed.external',
          external: {
            uri: externalQuoteUrl,
            title: quotedInfo.name && quotedInfo.username ? `${quotedInfo.name} (${author}) on X` : `${author} on X`,
            description: truncateText(
              decodeHtmlEntities(quotedInfo.text ?? '')
                .replace(/https:\/\/t\.co\/\S+/g, '')
                .trim(),
              300,
            ),
            ...(thumb ? { thumb } : {}),
          },
        };
        removeStatusLinks(quoteId as string);
      } else if (!text.includes(externalQuoteUrl)) {
        text += `\n\nQT: ${externalQuoteUrl}`;
      }
    }

    if (videoFallback && !cardEmbed) {
      const fallback = videoFallback as { tweetUrl: string; posterUrl?: string };
      if (!text.includes(fallback.tweetUrl)) text += `\n\nVideo: ${fallback.tweetUrl}`;
    }

    // biome-ignore lint/suspicious/noExplicitAny: app.bsky.embed.external payload
    let linkCard: any = null;
    if (!quoteEmbed && !cardEmbed && !externalQuoteUrl && (!hasMedia || isSponsoredCard)) {
      // If no media and no quote, check for external links to embed
      // We prioritize the LAST link found as it's often the main content
      const potentialLinks = urls
        .map((u) => u.expanded_url)
        .filter((u): u is string => Boolean(u) && !isTwitterUrl(u as string) && !rewrittenTargets.has(u as string));

      const linkToEmbed = potentialLinks[potentialLinks.length - 1];
      if (linkToEmbed) {
        // Optimization: If text is too long, but removing the link makes it fit, do it!
        // The link will be present in the embed card anyway.
        if (graphemeLength(text) > BSKY_POST_LIMIT && text.includes(linkToEmbed)) {
          const withoutLink = text.replace(linkToEmbed, '').trim();
          if (graphemeLength(withoutLink) <= BSKY_POST_LIMIT) {
            console.log(
              `[${twitterUsername}] 📏 Optimizing: Removing link ${linkToEmbed} from text to avoid threading (Card will embed it).`,
            );
            // Clean up potential double punctuation/spaces left behind
            text = withoutLink.replace(/\s\.$/, '.').replace(/\s\s+/g, ' ');
          }
        }

        console.log(`[${twitterUsername}] 🃏 Fetching link card for: ${linkToEmbed}`);
        linkCard = await fetchEmbedUrlCard(agent, linkToEmbed);
      }
    }

    if (isSponsoredCard) {
      const hasCardImages = mediaEntities.some((media) => media.source === 'card');
      if (hasCardImages) {
        text = ensureSponsoredLinks(text, tweet);
      }
    }

    // Polls can't be mirrored on Bluesky — point readers at the original tweet.
    // If this pushes the text over the limit, splitText threads it automatically.
    const pollUrl = (tweet.permanentUrl || tweetUrl).replace('twitter.com', 'x.com');
    const pollNote = buildPollNote(tweet.card, pollUrl);
    if (pollNote && !text.includes(pollUrl)) {
      console.log(`[${twitterUsername}] 📊 Poll detected. Linking back to the original tweet.`);
      text = `${text}\n\n${pollNote}`.trim();
    }

    // 4. Threading and Posting
    const hasEmbed = hasMedia || Boolean(quoteEmbed) || Boolean(cardEmbed) || Boolean(linkCard);
    const extraMediaCount = (extraImages.length > 0 ? 1 : 0) + extraVideos.length;

    // A post with neither text nor an embed is rejected by every PDS, so it can
    // never succeed no matter how many times it is retried. This happens for
    // real: a media-only tweet whose t.co links get stripped during cleanup and
    // whose upload then fails leaves an empty record behind. Record it as a
    // skip with the actual reason instead of burning the retry budget.
    if (text.trim().length === 0 && !hasEmbed) {
      const reason =
        droppedMedia.length > 0
          ? `Nothing left to post: the tweet had no text and its media could not be uploaded (${droppedMedia
              .map((entry) => `${entry.type}: ${entry.reason}`)
              .join('; ')}).`
          : 'Nothing left to post: the tweet had no text and no embeddable media.';
      skip(tweetId, 'compose', reason, tweetText, 'warn', 'tweet.skipped.empty', {
        durationMs: Date.now() - tweetStartedAt,
      });
      continue;
    }

    // Twitter's own language verdict, once per tweet. Per-chunk trigram guesses
    // on 300 characters were wrong often enough to hide posts from readers.
    const langs = resolvePostLangs(tweet.lang, tweetText);
    const resolveMirrorDid = await buildMirrorDidResolver(agent, text);

    const chunks = splitText(text);
    context?.onComposed?.({
      twitterId: tweetId,
      chunks,
      images: primaryImages.length,
      video: Boolean(primaryVideo),
      quote: Boolean(quoteEmbed) || Boolean(externalQuoteUrl),
      linkCard: Boolean(linkCard) || Boolean(cardEmbed),
      isReply,
      langs,
      extraMediaPosts: extraMediaCount,
    });
    logEvent({
      level: 'debug',
      stage: 'post',
      event: 'tweet.compose',
      message: `Tweet ${tweetId} composed into ${chunks.length} chunk(s).`,
      twitterId: tweetId,
      detail: {
        chunks: chunks.length,
        textLength: graphemeLength(text),
        images: primaryImages.length,
        video: Boolean(primaryVideo),
        quote: Boolean(quoteEmbed),
        card: cardEmbed ? 'external' : linkCard ? 'link' : undefined,
        isReply,
        langs,
        extraMediaPosts: extraMediaCount,
        droppedMedia: droppedMedia.length > 0 ? droppedMedia : undefined,
      },
      ...logScope,
    });

    let lastPostInfo: ProcessedTweetEntry | null = replyParentInfo;
    // Filled in when a chunk fails, so the outcome below can explain exactly
    // which chunk broke and why rather than falling back to a placeholder.
    let postFailure: { detail: ErrorDetail; chunkIndex: number } | null = null;
    let cancelledBeforePosting = false;

    // We will save the first chunk as the "Root" of this tweet, and the last chunk as the "Tail".
    let firstChunkInfo: { uri: string; cid: string; root?: { uri: string; cid: string } } | null = null;
    let lastChunkInfo: { uri: string; cid: string; root?: { uri: string; cid: string } } | null = null;
    const chunkUris: string[] = [];

    // A live mirror carries the moment it reaches Bluesky; history (backfills,
    // and tweets that sat in the queue for hours) keeps the tweet's own time.
    const parsedCreatedAt = tweet.created_at ? Date.parse(tweet.created_at) : Number.NaN;
    const tweetAgeMs = Number.isFinite(parsedCreatedAt) ? Date.now() - parsedCreatedAt : Number.POSITIVE_INFINITY;
    const live = Boolean(context?.isLive?.(tweetId)) && tweetAgeMs <= LIVE_TIMESTAMP_MAX_AGE_MS;
    const baseCreatedAtMs = live || !Number.isFinite(parsedCreatedAt) ? Date.now() : parsedCreatedAt;

    // One post per chunk, then one per media item that did not fit the first.
    // biome-ignore lint/suspicious/noExplicitAny: embed payloads
    const posts: { text: string; embed?: any; label: string }[] = chunks.map((chunk, index) => ({
      text: chunk,
      label: `chunk ${index + 1}/${chunks.length}`,
    }));
    if (extraImages.length > 0) {
      posts.push({
        text: '',
        embed: { $type: 'app.bsky.embed.images', images: extraImages.slice(0, 4) },
        label: 'extra images',
      });
    }
    for (const [index, video] of extraVideos.entries()) {
      posts.push({ text: '', embed: buildVideoEmbed(video), label: `extra video ${index + 1}` });
    }

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i] as (typeof posts)[number];
      const chunk = post.text;
      const isChunk = i < chunks.length;

      if (context?.signal?.aborted) {
        if (i === 0) cancelledBeforePosting = true;
        else postFailure = { detail: { name: 'AbortError', message: 'Batch cancelled mid-thread.' }, chunkIndex: i };
        break;
      }

      console.log(`[${twitterUsername}] 📤 Posting ${post.label}...`);
      reportStatus({ message: `Posting ${post.label}...` });

      const rt = new RichText({ text: chunk });
      if (chunk.length > 0) {
        try {
          await withTimeout(rt.detectFacets(agent), 60000, 'Facet detection timed out');
        } catch (facetErr) {
          console.warn(
            `[${twitterUsername}] ⚠️ Facet detection failed, posting with basic text:`,
            (facetErr as Error).message,
          );
        }
        rt.facets = addTwitterHandleFacets(
          rt.text,
          dropUnresolvedMentions(rt.facets as FacetLike[] | undefined),
          resolveMirrorDid,
        ) as typeof rt.facets | undefined;
      }

      // biome-ignore lint/suspicious/noExplicitAny: dynamic record construction
      const postRecord: Record<string, any> = {
        text: rt.text,
        facets: rt.facets,
        // CID is generated by the PDS from record content; unique createdAt keeps
        // near-simultaneous self-thread posts from colliding on identical payloads.
        createdAt: getUniqueCreatedAtIso(bskyIdentifier, baseCreatedAtMs + i * 1000),
      };
      if (langs && chunk.length > 0) postRecord.langs = langs;
      if (post.embed) postRecord.embed = post.embed;

      if (i === 0) {
        // biome-ignore lint/suspicious/noExplicitAny: embed payloads
        let media: any = null;
        if (primaryVideo) media = buildVideoEmbed(primaryVideo);
        else if (primaryImages.length > 0) media = { $type: 'app.bsky.embed.images', images: primaryImages };

        if (media && quoteEmbed) {
          postRecord.embed = { $type: 'app.bsky.embed.recordWithMedia', media, record: quoteEmbed };
        } else if (media) {
          postRecord.embed = media;
        } else if (quoteEmbed) {
          postRecord.embed = quoteEmbed;
        } else if (cardEmbed) {
          postRecord.embed = cardEmbed;
        } else if (linkCard) {
          postRecord.embed = linkCard;
        }
      }

      if (postRecord.embed && (i === 0 ? hasMedia : !isChunk)) {
        const sensitiveLabels = buildSensitiveLabels(
          mediaEntities,
          tweet.possibly_sensitive,
          settings.sensitiveFallbackLabel,
        );
        if (sensitiveLabels.length > 0) {
          console.log(`[${twitterUsername}] 🔞 Applying self labels: ${sensitiveLabels.join(', ')}`);
          postRecord.labels = {
            $type: 'com.atproto.label.defs#selfLabels',
            values: sensitiveLabels.map((val) => ({ val })),
          };
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

      const chunkStartedAt = Date.now();
      try {
        let response: any;
        const maxAttempts = 3;

        if (dryRun) {
          console.log(`[${twitterUsername}] 🧪 [DRY RUN] Would post ${post.label}`);
          if (postRecord.embed) console.log(`   - With embed: ${postRecord.embed.$type}`);
          if (postRecord.reply) console.log(`   - As reply to: ${postRecord.reply.parent.uri}`);
          response = { uri: 'at://did:plc:mock/app.bsky.feed.post/mock', cid: 'mock-cid' };
        } else {
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
              response = await withTimeout(agent.post(postRecord), 120000, 'Post request timed out after 120s');
              break;
            } catch (err: unknown) {
              const attemptDetail = toErrorDetail(err);

              // The old loop retried everything three times. A rejected record
              // (400) or a deleted account (403) fails identically every time,
              // so those three attempts only delayed the real explanation.
              if (attempt === maxAttempts || attemptDetail.retryable === false || context?.signal?.aborted) {
                logEvent({
                  level: 'error',
                  stage: 'bluesky',
                  event: 'post.chunk.failed',
                  message:
                    attemptDetail.retryable === false
                      ? `Bluesky rejected ${post.label} of tweet ${tweetId}; retrying cannot help.`
                      : `${post.label} of tweet ${tweetId} failed after ${attempt} attempt(s).`,
                  twitterId: tweetId,
                  attempt,
                  durationMs: Date.now() - chunkStartedAt,
                  error: attemptDetail,
                  detail: {
                    chunkIndex: i,
                    chunkCount: chunks.length,
                    chunkLength: graphemeLength(chunk),
                    embedType: postRecord.embed?.$type,
                    isReply: Boolean(postRecord.reply),
                  },
                  ...logScope,
                });
                throw err;
              }

              // A timeout is ambiguous: the PDS may well have created the
              // record before the response was lost. Retrying is still the
              // right call (a genuinely dropped request must be resent), but
              // say so in the log, because this is the one path that can
              // produce a duplicate post.
              const ambiguous = /timed out|socket hang up|econnreset|aborted/i.test(
                `${attemptDetail.code || ''} ${attemptDetail.message || ''}`,
              );
              logEvent({
                level: 'warn',
                stage: 'bluesky',
                event: ambiguous ? 'post.chunk.retry-ambiguous' : 'post.chunk.retry',
                message: ambiguous
                  ? `${post.label} of tweet ${tweetId} timed out without a response; retrying in 5s (the first request may still have landed).`
                  : `${post.label} of tweet ${tweetId} failed; retrying in 5s.`,
                twitterId: tweetId,
                attempt,
                error: attemptDetail,
                detail: { chunkIndex: i, chunkCount: chunks.length, attemptsLeft: maxAttempts - attempt },
                ...logScope,
              });
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

        if (i === 0) {
          firstChunkInfo = currentPostInfo;
          // Tell the caller the post exists *now*, before alt text, threading
          // bookkeeping or the processed_tweets write get a chance to fail.
          // This is what stops a live Bluesky post from being re-queued and
          // eventually parked as "failed".
          if (!dryRun) {
            try {
              context?.onPosted?.(tweetId, response.uri, response.cid, currentPostInfo.root);
            } catch (hookErr) {
              logEvent({
                level: 'warn',
                stage: 'queue',
                event: 'post.stamp.failed',
                message: `Posted tweet ${tweetId} but could not stamp the queue row with its URI.`,
                twitterId: tweetId,
                error: toErrorDetail(hookErr),
                ...logScope,
              });
            }
          }
        } else if (!dryRun) {
          try {
            context?.onChunkPosted?.(tweetId, response.uri, response.cid);
          } catch {
            // The stamp is a repair aid; the post itself already landed.
          }
        }
        chunkUris.push(response.uri);
        lastChunkInfo = currentPostInfo;
        lastPostInfo = currentPostInfo; // Update for next iteration

        logEvent({
          level: 'info',
          stage: 'bluesky',
          event: 'post.chunk.ok',
          message: `Posted ${post.label} of tweet ${tweetId}.`,
          twitterId: tweetId,
          durationMs: Date.now() - chunkStartedAt,
          detail: { uri: response.uri, cid: response.cid, chunkIndex: i, chunkCount: chunks.length },
          ...logScope,
        });

        if (i < posts.length - 1 && !dryRun && THREAD_CHUNK_GAP_MS > 0) {
          await new Promise((r) => setTimeout(r, THREAD_CHUNK_GAP_MS));
        }
      } catch (err) {
        if (!isChunk) {
          // A follow-up media post failing leaves the tweet itself intact.
          droppedMedia.push({ type: post.label, reason: describeErrorDetail(toErrorDetail(err)) });
          continue;
        }
        postFailure = { detail: toErrorDetail(err), chunkIndex: i };
        break;
      }
    }

    if (cancelledBeforePosting) {
      // Nothing went out for this tweet; no outcome means "not attempted".
      break;
    }

    // Save to DB and Map
    if (firstChunkInfo && lastChunkInfo) {
      // Both timestamps are stored so the dashboard can report real mirror lag.
      // The tweet's own time is only recorded when Twitter gave us a parseable
      // one; a missing value stays undefined rather than defaulting to now,
      // which would report a zero delay that never happened.
      const entry: ProcessedTweetEntry = {
        uri: firstChunkInfo.uri,
        cid: firstChunkInfo.cid,
        root: firstChunkInfo.root,
        tail: { uri: lastChunkInfo.uri, cid: lastChunkInfo.cid }, // Save tail!
        text: tweetText,
        migrated: true,
        status: 'migrated',
        chunkUris,
        tweetCreatedAt: Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : undefined,
        postedAt: Date.now(),
      };

      if (!dryRun) {
        // The post is already live at this point. If this write fails the tweet
        // must NOT be retried, so surface it loudly rather than letting the
        // queue conclude the post never happened.
        try {
          saveProcessedTweet(twitterUsername, bskyIdentifier, tweetId, entry);
        } catch (saveErr) {
          logEvent({
            level: 'error',
            stage: 'queue',
            event: 'record.write.failed',
            message: `Tweet ${tweetId} was posted to Bluesky but its history record could not be written. It will be repaired from the queue's stamped URI rather than re-posted.`,
            twitterId: tweetId,
            error: toErrorDetail(saveErr),
            detail: { uri: entry.uri, cid: entry.cid },
            ...logScope,
          });
        }
        localProcessedMap[tweetId] = entry; // Update local map for subsequent replies in this batch
      }
      mirroredCount++;

      const partial = postFailure !== null;
      logEvent({
        level: partial ? 'warn' : 'info',
        stage: 'post',
        event: partial ? 'tweet.posted.partial' : 'tweet.posted',
        message: partial
          ? `Tweet ${tweetId} posted only ${postFailure?.chunkIndex ?? 0} of ${chunks.length} chunks; the thread is incomplete.`
          : `Mirrored tweet ${tweetId} to ${bskyIdentifier} as ${chunks.length} chunk(s).`,
        twitterId: tweetId,
        durationMs: Date.now() - tweetStartedAt,
        error: postFailure?.detail,
        detail: {
          uri: entry.uri,
          cid: entry.cid,
          chunks: chunks.length,
          images: images.length,
          video: Boolean(primaryVideo),
          extraMediaPosts: extraMediaCount,
          droppedMedia: droppedMedia.length > 0 ? droppedMedia : undefined,
        },
        ...logScope,
      });

      recordOutcome(context, tweetId, {
        status: 'posted',
        stage: partial ? 'post-partial' : 'post',
        reason: partial
          ? `Posted, but chunk ${(postFailure?.chunkIndex ?? 0) + 1} of ${chunks.length} failed: ${describeErrorDetail(
              postFailure?.detail ?? {},
            )}`
          : `Posted ${chunks.length} chunk(s) to ${bskyIdentifier}.`,
        uri: entry.uri,
        cid: entry.cid,
        chunks: chunks.length,
        detail: postFailure?.detail,
        durationMs: Date.now() - tweetStartedAt,
      });
    } else if (!dryRun) {
      // Nothing at all made it out for this tweet.
      const detail = postFailure?.detail;
      const reason = detail
        ? `First chunk was rejected by Bluesky: ${describeErrorDetail(detail)}`
        : 'No chunk was posted and no error was reported.';
      logEvent({
        level: 'error',
        stage: 'post',
        event: 'tweet.failed',
        message: `Tweet ${tweetId} was not posted to ${bskyIdentifier}. ${reason}`,
        twitterId: tweetId,
        durationMs: Date.now() - tweetStartedAt,
        error: detail,
        detail: {
          chunks: chunks.length,
          images: images.length,
          video: Boolean(primaryVideo),
          droppedMedia: droppedMedia.length > 0 ? droppedMedia : undefined,
          textPreview: text.slice(0, 200),
        },
        ...logScope,
      });
      recordOutcome(context, tweetId, {
        status: 'failed',
        stage: 'post',
        reason,
        detail,
        retryable: detail?.retryable ?? true,
        durationMs: Date.now() - tweetStartedAt,
      });
    }

    // Human-like pause between posts. This only delays the current account's
    // queue worker — other accounts keep posting in parallel. A dry run (the
    // preview included) posts nothing, so it has nothing to pace.
    if (!dryRun) {
      const wait = POST_PACING_MIN_MS + Math.floor(Math.random() * (POST_PACING_MAX_MS - POST_PACING_MIN_MS + 1));
      if (wait > 0) {
        console.log(`[${twitterUsername}] 😴 Pacing: Waiting ${wait / 1000}s before next tweet.`);
        reportJob(mirrorJobId, {
          message: `Mirrored tweet ${tweetId}. Pacing ${Math.round(wait / 1000)}s before the next one`,
          processedCount: mirroredCount,
        });
        reportStatus({ state: 'pacing', message: `Pacing: Waiting ${wait / 1000}s...` });
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  reportJob(mirrorJobId, null);
}

import { getAgent, invalidateAgent } from './bsky.js';

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
// Author-mismatch entries (stray timeline injections) are dropped. Retweets
// only take queue space when they can become a native repost — the original is
// already mirrored on this instance, or waiting in the queue to be — and are
// otherwise recorded as skipped on the spot.
function enqueueTweetsForMapping(
  mapping: AccountMapping,
  twitterUsername: string,
  tweets: Tweet[],
  kind: 'scheduled' | 'backfill',
  requestId?: string,
): number {
  const inputs = [];
  let historySkipped = 0;
  for (const tweet of tweets) {
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;
    const author = tweet.user?.screen_name?.toLowerCase();
    if (author && author !== twitterUsername.toLowerCase()) continue;

    // "Only new tweets" mappings (and accounts wiped with "delete all posts")
    // record what was already on the timeline as history instead of posting
    // it. The pinned tweet is exempt so pin sync still has something to pin;
    // explicit backfills ignore the cutoff entirely.
    const createdMs = tweet.created_at ? Date.parse(tweet.created_at) : Number.NaN;
    if (
      kind === 'scheduled' &&
      mapping.mirrorFromMs &&
      Number.isFinite(createdMs) &&
      createdMs < mapping.mirrorFromMs &&
      !tweet.isPin
    ) {
      saveProcessedTweet(twitterUsername, mapping.bskyIdentifier, tweetId, { skipped: true, text: tweet.text });
      historySkipped++;
      continue;
    }

    const isRetweet = tweet.isRetweet || tweet.retweeted_status_id_str || (tweet.text || '').startsWith('RT @');
    if (isRetweet) {
      const originalId = tweet.retweeted_status_id_str;
      const repostable =
        mapping.mirrorRetweets !== false &&
        Boolean(originalId) &&
        (Boolean(dbService.findMirroredPost(originalId as string)) ||
          postQueueService.isQueuedAnywhere(originalId as string));
      if (!repostable) {
        saveProcessedTweet(twitterUsername, mapping.bskyIdentifier, tweetId, { skipped: true, text: tweet.text });
        continue;
      }
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
  if (historySkipped > 0) {
    logEvent({
      level: 'info',
      stage: 'sweep',
      event: 'account.history-skipped',
      message: `Recorded ${historySkipped} tweet(s) from @${twitterUsername} as history: they predate this mirror's start point.`,
      mappingId: mapping.id,
      bskyIdentifier: mapping.bskyIdentifier,
      twitterUsername,
      detail: { historySkipped, mirrorFromMs: mapping.mirrorFromMs },
    });
  }
  return postQueueService.enqueue(inputs);
}

/**
 * A source account changed its @handle. Fetching by numeric id keeps working
 * through a rename, so the new name shows up on the account's own tweets for
 * free; follow it everywhere the old name is stored — config, history, queue,
 * polling state — so the mirror carries on instead of failing "user not found".
 */
function followSourceRename(mapping: AccountMapping, fromUsername: string, toUsername: string): void {
  const from = fromUsername.toLowerCase();
  const to = toUsername.toLowerCase();
  if (!to || from === to) return;
  updateConfig((config) => {
    let changed = false;
    for (const entry of config.mappings) {
      if (!entry.twitterUsernames.some((username) => username.toLowerCase() === from)) continue;
      entry.twitterUsernames = [...new Set(entry.twitterUsernames.map((u) => (u.toLowerCase() === from ? to : u)))];
      if (entry.profileSyncSourceUsername?.toLowerCase() === from) entry.profileSyncSourceUsername = to;
      changed = true;
    }
    return changed;
  });
  dbService.renameTwitterUsername(from, to);
  // Keep the in-memory copy the sweep is holding consistent too.
  mapping.twitterUsernames = [...new Set(mapping.twitterUsernames.map((u) => (u.toLowerCase() === from ? to : u)))];
  if (mapping.profileSyncSourceUsername?.toLowerCase() === from) mapping.profileSyncSourceUsername = to;
  logEvent({
    level: 'warn',
    stage: 'sweep',
    event: 'source.renamed',
    message: `@${from} is now @${to} on X. The mapping, its history and its queue were updated to follow the rename.`,
    mappingId: mapping.id,
    bskyIdentifier: mapping.bskyIdentifier,
    twitterUsername: to,
    detail: { from, to },
  });
}

// Fetch-only pass over one source account. Returns tweets that are neither in
// processed_tweets nor already sitting in the queue, and the account's current
// username (which differs from the configured one after a rename).
async function sweepAccountForNewTweets(
  mapping: AccountMapping,
  twitterUsername: string,
  sessionKey: string,
): Promise<{ tweets: Tweet[]; username: string }> {
  const seenIds = new Set(Object.keys(loadProcessedTweets(mapping.bskyIdentifier)));
  for (const id of postQueueService.getQueuedIdSet(mapping.bskyIdentifier)) {
    seenIds.add(id);
  }

  // The numeric id is learned from the account's own tweets (no extra
  // request). Once known, fetching by id survives renames and skips the
  // screen-name lookup the scraper would otherwise make.
  const knownUserId = sourceActivityService.get(twitterUsername)?.twitter_user_id ?? undefined;
  const tweets = await fetchUserTweets(twitterUsername, 50, seenIds, sessionKey, {
    userId: knownUserId,
    throwOnError: true,
  });

  let username = twitterUsername;
  const ownTweets = tweets.filter((tweet) => tweet.user?.screen_name && tweet.user.id_str);
  if (knownUserId) {
    const current = ownTweets.find((tweet) => tweet.user?.id_str === knownUserId)?.user?.screen_name;
    if (current && current.toLowerCase() !== twitterUsername.toLowerCase()) {
      followSourceRename(mapping, twitterUsername, current);
      username = current.toLowerCase();
    }
  } else {
    const userId = ownTweets.find((tweet) => tweet.user?.screen_name?.toLowerCase() === twitterUsername.toLowerCase())
      ?.user?.id_str;
    if (userId) sourceActivityService.setUserId(twitterUsername, userId);
  }

  if (tweets.length === 0) return { tweets: [], username };

  // The fetched window carries the isPin flag, so pin changes sync for free.
  await maybeSyncPinnedTweetFromTimeline(mapping, username, tweets, false, getMappingLogPrefix(mapping));

  return {
    tweets: tweets.filter((tweet) => {
      const tweetId = tweet.id_str || tweet.id;
      return Boolean(tweetId) && !seenIds.has(String(tweetId));
    }),
    username,
  };
}

// Sweep every enabled source account and enqueue whatever is new. Returns the
// number of tweets queued.
export interface SweepOptions {
  /** Check every account now, ignoring adaptive-polling intervals ("Run now"). */
  force?: boolean;
  /** Check just these mappings' accounts now, ignoring their intervals. */
  forceMappingIds?: Set<string>;
}

async function runFetchSweep(mappings: AccountMapping[], options: SweepOptions = {}): Promise<number> {
  const accounts: { mapping: AccountMapping; twitterUsername: string }[] = [];
  for (const mapping of mappings) {
    if (!mapping.enabled) continue;
    for (const twitterUsername of mapping.twitterUsernames) {
      if (twitterUsername) accounts.push({ mapping, twitterUsername });
    }
  }
  if (accounts.length === 0) {
    logEvent({
      level: 'info',
      stage: 'sweep',
      event: 'sweep.no-accounts',
      message: 'Sweep skipped: no enabled source accounts are configured.',
    });
    return 0;
  }

  const fetchTimeoutMs = envInt('SWEEP_FETCH_TIMEOUT_MS', 180_000, 30_000, 1_800_000);
  const startedAt = Date.now();

  // Adaptive polling: accounts that have been silent for a while earn a longer
  // minimum interval, so each sweep spends its fetch budget on the accounts
  // actually posting. Set ADAPTIVE_POLLING=0 to check everything every sweep.
  const adaptivePolling = process.env.ADAPTIVE_POLLING !== '0';
  // Mappings come and go; without this the activity table keeps a row for every
  // source account ever mirrored.
  sourceActivityService.pruneMissing(accounts.map((account) => account.twitterUsername));
  const activity = sourceActivityService.getAll();
  const isForced = (account: { mapping: AccountMapping }) =>
    Boolean(options.force) || Boolean(options.forceMappingIds?.has(account.mapping.id));
  // A manual "Run now" is a request to check now; adaptive tiers must not
  // quietly decide that an account which just tweeted is not due for an hour.
  const plan = adaptivePolling
    ? planSweep(
        accounts,
        (account) => activityFromRow(activity.get(account.twitterUsername.toLowerCase())),
        startedAt,
        undefined,
        isForced,
      )
    : { due: accounts, skipped: [], tierCounts: {} };
  const dueAccounts = plan.due;

  logEvent({
    level: 'info',
    stage: 'sweep',
    event: 'sweep.start',
    message: adaptivePolling
      ? `Checking ${dueAccounts.length} of ${accounts.length} source account(s) with a concurrency of ${FETCH_CONCURRENCY}; ${plan.skipped.length} not due yet.`
      : `Checking ${accounts.length} source account(s) with a concurrency of ${FETCH_CONCURRENCY}.`,
    detail: {
      forced: options.force ? 'all' : options.forceMappingIds ? [...options.forceMappingIds] : undefined,
      accounts: dueAccounts.length,
      totalAccounts: accounts.length,
      skipped: plan.skipped.length,
      tiers: plan.tierCounts,
      adaptivePolling,
      concurrency: FETCH_CONCURRENCY,
      fetchTimeoutMs,
    },
  });

  if (dueAccounts.length === 0) {
    logEvent({
      level: 'info',
      stage: 'sweep',
      event: 'sweep.completed',
      message: 'No source accounts were due for a check this sweep.',
      durationMs: Date.now() - startedAt,
      detail: { accountsChecked: 0, queued: 0, skipped: plan.skipped.length },
    });
    return 0;
  }

  let cursor = 0;
  let enqueuedTotal = 0;
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, dueAccounts.length) }, async (_, slot) => {
    const sessionKey = `sweep-${slot + 1}`;
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= dueAccounts.length) break;
      const ref = dueAccounts[index];
      if (!ref) continue;
      const { mapping, twitterUsername } = ref;
      const checkJobId = `check:${mapping.id}:${twitterUsername.toLowerCase()}`;
      const accountStartedAt = Date.now();
      const accountScope = {
        mappingId: mapping.id,
        bskyIdentifier: mapping.bskyIdentifier,
        twitterUsername,
        jobId: checkJobId,
      };
      try {
        updateJob(checkJobId, {
          kind: 'checking',
          account: twitterUsername,
          target: mapping.bskyIdentifier,
          mappingId: mapping.id,
          message: 'Checking for new tweets',
        });
        const swept = await withTimeout(
          sweepAccountForNewTweets(mapping, twitterUsername, sessionKey),
          fetchTimeoutMs,
          `Timeline fetch for @${twitterUsername} exceeded its ${Math.round(fetchTimeoutMs / 1000)}s watchdog`,
        );
        const fresh = swept.tweets;
        let inserted = 0;
        if (fresh.length > 0) {
          inserted = enqueueTweetsForMapping(mapping, swept.username, fresh, 'scheduled');
          enqueuedTotal += inserted;
        }
        // Drives the next sweep's tiering. `fresh` rather than `inserted`: a
        // tweet deduped against the queue still proves the account is posting.
        sourceActivityService.recordCheck(swept.username, fresh.length > 0);
        logEvent({
          level: 'info',
          stage: 'sweep',
          event: inserted > 0 ? 'account.queued' : 'account.checked',
          message:
            inserted > 0
              ? `Queued ${inserted} new tweet(s) from @${twitterUsername} for ${mapping.bskyIdentifier}.`
              : `No new tweets from @${twitterUsername} for ${mapping.bskyIdentifier}.`,
          durationMs: Date.now() - accountStartedAt,
          // `found` vs `queued` diverging means tweets were deduped against the
          // queue or history — worth being able to see rather than inferring.
          detail: { found: fresh.length, queued: inserted },
          ...accountScope,
        });
      } catch (err) {
        const detail = toErrorDetail(err);
        // Kept on the source row so the dashboard shows a renamed, suspended
        // or protected account as failing, not as one that went quiet.
        sourceActivityService.recordError(twitterUsername, describeErrorDetail(detail));
        logEvent({
          level: 'error',
          stage: 'sweep',
          event: 'account.check.failed',
          message: `Could not check @${twitterUsername} for ${mapping.bskyIdentifier}: ${describeErrorDetail(detail)}`,
          durationMs: Date.now() - accountStartedAt,
          error: detail,
          ...accountScope,
        });
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
  try {
    await runDeleteSyncPass(mappings);
    await refreshDiscoveryDaily();
  } catch (err) {
    console.error(`[Scheduler] ❌ Housekeeping failed: ${describeError(err)}`);
  }

  const counts = postQueueService.getCounts();
  logEvent({
    level: 'info',
    stage: 'sweep',
    event: 'sweep.completed',
    message:
      `Swept ${dueAccounts.length} of ${accounts.length} account(s) in ${formatDurationMs(Date.now() - startedAt)}; queued ${enqueuedTotal} new tweet(s). ` +
      `Queue now: ${counts.ready} ready, ${counts.backoff} waiting on retry backoff, ${counts.processing} posting, ${counts.failed} parked as failed.`,
    durationMs: Date.now() - startedAt,
    detail: {
      accountsChecked: dueAccounts.length,
      totalAccounts: accounts.length,
      skipped: plan.skipped.length,
      queued: enqueuedTotal,
      queue: {
        ready: counts.ready,
        backoff: counts.backoff,
        processing: counts.processing,
        failed: counts.failed,
      },
    },
  });
  return enqueuedTotal;
}

// Delete sync spends public-CDN requests only (never the scraper account), and
// still caps them per sweep so a large instance never floods the CDN.
const DELETE_SYNC_CHECKS_PER_SWEEP = envInt('DELETE_SYNC_CHECKS_PER_SWEEP', 20, 0, 200);
const DELETE_SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function runDeleteSyncPass(mappings: AccountMapping[]): Promise<void> {
  let budget = DELETE_SYNC_CHECKS_PER_SWEEP;
  for (const mapping of mappings) {
    if (budget <= 0) break;
    if (!mapping.enabled || !mapping.syncDeletes) continue;
    // A failing or protected source 404s on tweets that still exist; checking
    // it would only produce false "deleted" verdicts.
    const unhealthy = mapping.twitterUsernames.some((username) => {
      const row = sourceActivityService.get(username);
      return Boolean(row?.last_error || row?.protected_since);
    });
    if (unhealthy) continue;
    const candidates = dbService.listDeleteSyncCandidates(
      mapping.bskyIdentifier,
      DELETE_SYNC_WINDOW_MS,
      DELETE_SYNC_MIN_MISSING_SPAN_MS,
      Math.min(budget, 10),
    );
    if (candidates.length === 0) continue;
    budget -= candidates.length;
    const agent = await getAgent(mapping);
    if (!agent) continue;
    const identifier = mapping.bskyIdentifier;
    const result = await syncDeletesForAccount(candidates, {
      check: checkSourceTweet,
      recordPresent: (id) => dbService.recordSourcePresent(id, identifier),
      recordInconclusive: (id) => dbService.recordSourceChecked(id, identifier),
      recordMissing: (id) => dbService.recordSourceMissing(id, identifier),
      deletePost: async (uri) => {
        await agent.deletePost(uri);
      },
      markDeleted: (id) => dbService.markDeleted(id, identifier),
      log: (level, event, message, detail) =>
        logEvent({ level, stage: 'sweep', event, message, detail, mappingId: mapping.id, bskyIdentifier: identifier }),
      pauseMs: 500,
    });
    if (result.deleted > 0 || result.stoodDown) {
      logEvent({
        level: result.stoodDown ? 'warn' : 'info',
        stage: 'sweep',
        event: 'delete-sync.pass',
        message: `Delete sync for ${identifier}: checked ${result.checked}, removed ${result.deleted} mirror(s) of deleted tweets.`,
        detail: { ...result },
        mappingId: mapping.id,
        bskyIdentifier: identifier,
      });
    }
  }
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

// A video upload may legitimately take VIDEO_UPLOAD_TIMEOUT_MS plus
// VIDEO_PROCESSING_TIMEOUT_MS; a watchdog shorter than that cancelled healthy
// video batches and retried them from scratch.
const VIDEO_BATCH_FLOOR_MS = VIDEO_UPLOAD_TIMEOUT_MS + VIDEO_PROCESSING_TIMEOUT_MS + 5 * 60 * 1000;
// After the watchdog cancels a batch, how long to wait for it to actually stop
// (finish the request in flight, notice the abort) before settling its rows.
const BATCH_WIND_DOWN_MS = envInt('BATCH_WIND_DOWN_MS', 5 * 60 * 1000, 1000, 30 * 60 * 1000);

function batchHasVideo(batch: QueueBatch): boolean {
  return batch.items.some((item) => /"type":"(video|animated_gif)"/.test(item.tweet_json));
}

function queueBatchTimeoutMs(itemCount: number, hasVideo = false): number {
  // Pacing plus media work make big batches legitimately slow; scale the
  // watchdog with batch size so it only catches genuine hangs.
  return Math.max(resolveScheduledAccountTimeoutMs(), itemCount * 120_000, hasVideo ? VIDEO_BATCH_FLOOR_MS : 0);
}

/**
 * The history entry for a tweet the queue knows is live on Bluesky but that
 * never got a history row. Uses the thread position stamped at post time: the
 * old repair recorded the first chunk as its own root and tail, so any later
 * reply in that thread pointed at the wrong root and a split tweet's
 * continuation attached to its first chunk.
 */
function repairEntryFromStamp(item: {
  posted_uri?: string;
  posted_cid?: string;
  posted_root_uri?: string;
  posted_root_cid?: string;
  posted_tail_uri?: string;
  posted_tail_cid?: string;
  tweet_text?: string;
}): ProcessedTweetEntry {
  const uri = item.posted_uri as string;
  const cid = item.posted_cid as string;
  return {
    uri,
    cid,
    root:
      item.posted_root_uri && item.posted_root_cid
        ? { uri: item.posted_root_uri, cid: item.posted_root_cid }
        : { uri, cid },
    tail:
      item.posted_tail_uri && item.posted_tail_cid
        ? { uri: item.posted_tail_uri, cid: item.posted_tail_cid }
        : { uri, cid },
    text: item.tweet_text,
    migrated: true,
  };
}

/**
 * Finds queue rows that carry a stamped Bluesky URI but have no permanent
 * history record, and writes the record from the stamp.
 *
 * These are posts that are live on Bluesky while the dashboard still counts
 * them as pending or failed — the exact mismatch behind "it says failed but I
 * can see the post". Retrying them would publish duplicates, so they are
 * repaired rather than re-queued.
 */
function reconcilePostedButUnrecorded(): number {
  let repaired = 0;
  for (const item of postQueueService.listPostedButUnrecorded()) {
    if (!item.posted_uri || !item.posted_cid) continue;
    if (dbService.getTweet(item.twitter_id, item.bsky_identifier)) {
      // Already recorded; the queue row is just stale.
      postQueueService.markDone(item.twitter_id, item.bsky_identifier);
      continue;
    }
    try {
      saveProcessedTweet(item.twitter_username, item.bsky_identifier, item.twitter_id, repairEntryFromStamp(item));
      postQueueService.markDone(item.twitter_id, item.bsky_identifier);
      repaired += 1;
    } catch (err) {
      logEvent({
        level: 'error',
        stage: 'queue',
        event: 'reconcile.item.failed',
        message: `Could not repair the history record for tweet ${item.twitter_id}, which is already live on Bluesky.`,
        twitterId: item.twitter_id,
        bskyIdentifier: item.bsky_identifier,
        twitterUsername: item.twitter_username,
        mappingId: item.mapping_id,
        error: toErrorDetail(err),
      });
    }
  }

  if (repaired > 0) {
    logEvent({
      level: 'warn',
      stage: 'queue',
      event: 'reconcile.completed',
      message: `Repaired ${repaired} tweet(s) that were already live on Bluesky but missing from the history table. They were not re-posted.`,
      detail: { repaired },
    });
  }
  return repaired;
}

const FAILED_QUEUE_RETENTION_MS = (() => {
  const days = envInt('QUEUE_FAILED_RETENTION_DAYS', 14, 1, 365);
  return days * 24 * 60 * 60 * 1000;
})();

function purgeStaleFailedQueueRows(): number {
  const purged = postQueueService.purgeFailedOlderThan(FAILED_QUEUE_RETENTION_MS);
  if (purged > 0) {
    logEvent({
      level: 'info',
      stage: 'queue',
      event: 'queue.failed-purged',
      message: `Dropped ${purged} failed queue row(s) older than ${Math.round(FAILED_QUEUE_RETENTION_MS / (24 * 60 * 60 * 1000))} days.`,
      detail: { purged },
    });
  }
  return purged;
}

// How many batches in a row have failed outright for a mapping. A broken app
// password or a suspended account fails every batch identically; without this
// the worker would re-claim, re-fail and re-log every 30 seconds indefinitely.
const consecutiveBatchFailures = new Map<string, number>();

function unattemptedRetryDelayMs(failureStreak: number): number {
  // 30s, 1m, 2m, 4m, 8m, capped at 15m.
  return Math.min(30_000 * 2 ** Math.max(0, failureStreak - 1), 15 * 60 * 1000);
}

async function runPostBatch(mapping: AccountMapping, batch: QueueBatch, sessionKey: string): Promise<void> {
  const startedAt = Date.now();
  const oldestEnqueuedAt = Math.min(...batch.items.map((item) => item.enqueued_at));
  const jobId = `mirror:${batch.bsky_identifier}:${batch.twitter_username}`;
  const scope = {
    mappingId: mapping.id,
    bskyIdentifier: mapping.bskyIdentifier,
    twitterUsername: batch.twitter_username,
    jobId,
  };

  // Per-tweet verdicts filled in by processTweets. This is what replaced the
  // old single `batchError` string: one batch-wide message could not say why
  // any individual tweet failed, so every parked row ended up carrying the
  // same uninformative placeholder.
  const outcomes = new Map<string, TweetOutcome>();
  // Populated the moment Bluesky accepts a post, independent of any later
  // bookkeeping. Used below to tell "never posted" apart from "posted, but we
  // failed to write it down" — the two cases that used to be indistinguishable.
  const stampedUris = new Map<string, { uri: string; cid: string }>();

  let batchFailure: ErrorDetail | null = null;
  let batchStage = 'batch';
  // Cancels processTweets when the watchdog fires. Without it the timed-out
  // run kept posting in the background while its rows were released and
  // re-claimed by the next batch — two workers posting the same tweets.
  const controller = new AbortController();
  // Scheduled rows are live mirrors; backfill rows are history.
  const liveTweetIds = new Set(batch.items.filter((item) => item.kind === 'scheduled').map((item) => item.twitter_id));

  logEvent({
    level: 'info',
    stage: 'queue',
    event: 'batch.claimed',
    message:
      `Posting ${batch.items.length} queued tweet(s) from @${batch.twitter_username} to ${mapping.bskyIdentifier} ` +
      `(oldest waited ${formatDurationMs(startedAt - oldestEnqueuedAt)} in the queue).`,
    detail: {
      items: batch.items.length,
      oldestWaitedMs: startedAt - oldestEnqueuedAt,
      attemptsSoFar: batch.items.map((item) => item.attempts).reduce((a, b) => Math.max(a, b), 0),
    },
    ...scope,
  });

  try {
    const agent = await getAgent(mapping);
    // A login can discover that the account changed its handle on Bluesky and
    // migrate its history to the new identifier. This batch was claimed under
    // the old one; hand it back so it is re-claimed under the new key rather
    // than writing fresh history rows where nothing will ever look for them.
    const current = getConfig().mappings.find((entry) => entry.id === mapping.id);
    if (current && current.bskyIdentifier.toLowerCase() !== batch.bsky_identifier.toLowerCase()) {
      batchStage = 'identifier-changed';
      throw new Error(
        `${batch.bsky_identifier} is now ${current.bskyIdentifier}; the batch will be re-claimed under the new identifier.`,
      );
    }
    if (!agent) {
      batchStage = 'login';
      // "Check the app password" is wrong and misleading when the account is
      // taken down or deactivated — nothing in Settings fixes that.
      const health = accountHealthService.get(mapping.bskyIdentifier);
      throw new Error(
        health
          ? `${health.reason} Posting is paused for this account; every tweet for it stays queued until it works again.`
          : `Bluesky login failed for ${mapping.bskyIdentifier}. Check the app password in Settings — every tweet for this account stays queued until it works.`,
      );
    }

    const tweets: Tweet[] = [];
    for (const item of batch.items) {
      try {
        tweets.push(JSON.parse(item.tweet_json) as Tweet);
      } catch (parseErr) {
        // A payload that will not parse cannot ever post; park it now with a
        // real reason instead of retrying the same broken JSON eight times.
        const detail = toErrorDetail(parseErr);
        logEvent({
          level: 'error',
          stage: 'queue',
          event: 'item.payload.corrupt',
          message: `Queued payload for tweet ${item.twitter_id} is not valid JSON, so it can never be posted. Re-run a backfill for this account to fetch it again.`,
          twitterId: item.twitter_id,
          error: detail,
          ...scope,
        });
        outcomes.set(item.twitter_id, {
          status: 'failed',
          stage: 'payload',
          reason: 'The stored copy of this tweet is corrupt and cannot be decoded. Re-run a backfill to re-fetch it.',
          detail,
          retryable: false,
        });
      }
    }

    // Queue batches arrive oldest-first; processTweets expects timeline order
    // (newest first) and reverses internally.
    tweets.reverse();

    const watchdogMs = queueBatchTimeoutMs(batch.items.length, batchHasVideo(batch));
    const run = processTweets(
      agent,
      batch.twitter_username,
      batch.bsky_identifier,
      tweets,
      false,
      undefined,
      undefined,
      sessionKey,
      {
        outcomes,
        mappingId: mapping.id,
        jobId,
        signal: controller.signal,
        isLive: (twitterId) => liveTweetIds.has(twitterId),
        settings: resolveMirrorSettings(mapping),
        onPosted: (twitterId, uri, cid, root) => {
          stampedUris.set(twitterId, { uri, cid });
          postQueueService.markPosted(twitterId, batch.bsky_identifier, uri, cid, root);
        },
        onChunkPosted: (twitterId, uri, cid) => {
          postQueueService.markChunkPosted(twitterId, batch.bsky_identifier, uri, cid);
        },
      },
    );
    try {
      await withTimeout(
        run,
        watchdogMs,
        `Posting batch for @${batch.twitter_username} exceeded its ${formatDurationMs(watchdogMs)} watchdog`,
      );
    } catch (watchdogErr) {
      // Stop the run, then wait for it to actually stop before this batch's
      // rows are settled and become claimable again.
      controller.abort();
      await Promise.race([
        run.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, BATCH_WIND_DOWN_MS)),
      ]);
      throw watchdogErr;
    }
  } catch (err) {
    batchFailure = toErrorDetail(err);

    // An expired or rejected session poisons every subsequent post for this
    // account. Drop the cached agent so the next batch signs in again instead
    // of replaying the same auth failure until the tweets hit their retry cap.
    const authFailure =
      batchFailure.status === 401 ||
      batchFailure.status === 403 ||
      /expiredtoken|invalidtoken|authmissing|not authenticated|login failed/i.test(
        `${batchFailure.code || ''} ${batchFailure.message || ''}`,
      );
    if (authFailure) {
      invalidateAgent(mapping.bskyIdentifier, mapping.bskyServiceUrl);
      logEvent({
        level: 'warn',
        stage: 'bluesky',
        event: 'session.invalidated',
        message: `Dropped the cached Bluesky session for ${mapping.bskyIdentifier} after an authentication failure; the next batch will sign in again.`,
        error: batchFailure,
        ...scope,
      });
    }

    const streak = (consecutiveBatchFailures.get(mapping.id) ?? 0) + 1;
    consecutiveBatchFailures.set(mapping.id, streak);

    // A persistent misconfiguration would otherwise write the same error every
    // 30 seconds forever. Keep the first few at full volume, then thin out so
    // the log stays readable without ever going completely silent.
    const noisy = streak <= 3 || streak % 20 === 0;
    logEvent({
      level: 'error',
      stage: 'queue',
      event: 'batch.failed',
      message:
        `Post batch for @${batch.twitter_username} → ${mapping.bskyIdentifier} stopped early: ${describeErrorDetail(batchFailure)}` +
        (streak > 1 ? ` (${streak} consecutive failures for this account)` : ''),
      error: batchFailure,
      durationMs: Date.now() - startedAt,
      detail: {
        stage: batchStage,
        itemsInBatch: batch.items.length,
        outcomesRecorded: outcomes.size,
        consecutiveFailures: streak,
        nextAttemptIn: formatDurationMs(unattemptedRetryDelayMs(streak)),
      },
      console: noisy,
      ...scope,
    });
  } finally {
    if (!batchFailure) consecutiveBatchFailures.delete(mapping.id);
    let posted = 0;
    let skipped = 0;
    let repaired = 0;
    let retrying = 0;
    let parked = 0;
    let deferred = 0;

    for (const item of batch.items) {
      const outcome = outcomes.get(item.twitter_id);
      const record = dbService.getTweet(item.twitter_id, item.bsky_identifier);

      // 1. Recorded in the permanent history — the normal happy path.
      if (record) {
        postQueueService.markDone(item.twitter_id, item.bsky_identifier);
        if (record.status === 'migrated') posted += 1;
        else skipped += 1;
        continue;
      }

      // 2. Bluesky accepted the post but the history write never landed. This
      //    is the case that produced "it's failed in the dashboard but I can
      //    see it on Bluesky": retrying would publish a duplicate, so repair
      //    the record from the URI we stamped at post time instead.
      const stamped =
        stampedUris.get(item.twitter_id) ??
        (item.posted_uri && item.posted_cid ? { uri: item.posted_uri, cid: item.posted_cid } : undefined);
      if (stamped) {
        try {
          // Re-read the row: the stamps for root and tail are written during
          // the run, after this batch's copy of the row was taken.
          const freshRow = postQueueService
            .listPostedButUnrecorded(5000)
            .find((row) => row.twitter_id === item.twitter_id && row.bsky_identifier === item.bsky_identifier);
          saveProcessedTweet(
            batch.twitter_username,
            item.bsky_identifier,
            item.twitter_id,
            repairEntryFromStamp({ ...item, ...freshRow, posted_uri: stamped.uri, posted_cid: stamped.cid }),
          );
          postQueueService.markDone(item.twitter_id, item.bsky_identifier);
          repaired += 1;
          logEvent({
            level: 'warn',
            stage: 'queue',
            event: 'item.repaired',
            message: `Tweet ${item.twitter_id} was live on Bluesky but missing from the history table; recorded it from the stamped URI instead of re-posting.`,
            twitterId: item.twitter_id,
            detail: { uri: stamped.uri, cid: stamped.cid },
            ...scope,
          });
        } catch (repairErr) {
          logEvent({
            level: 'error',
            stage: 'queue',
            event: 'item.repair.failed',
            message: `Tweet ${item.twitter_id} is live on Bluesky but its record could not be repaired; it is held back rather than re-posted.`,
            twitterId: item.twitter_id,
            error: toErrorDetail(repairErr),
            ...scope,
          });
          postQueueService.releaseUnattempted(item, 'Posted to Bluesky; waiting to record it in the history table.');
          deferred += 1;
        }
        continue;
      }

      // 3. Deliberately skipped but the skip write did not land. Nothing is
      //    wrong and nothing needs posting.
      if (outcome?.status === 'skipped') {
        saveProcessedTweet(batch.twitter_username, item.bsky_identifier, item.twitter_id, {
          skipped: true,
          text: item.tweet_text,
        });
        postQueueService.markDone(item.twitter_id, item.bsky_identifier);
        skipped += 1;
        continue;
      }

      // 3b. Waiting on another tweet (a reply's parent, a retweet's original)
      //     that is still queued. Retried with the normal backoff, and parked
      //     with this explanation if it never becomes postable.
      if (outcome?.status === 'deferred') {
        const result = postQueueService.releaseForRetry(item, outcome.reason, QUEUE_MAX_ATTEMPTS, {
          stage: outcome.stage,
          retryable: true,
        });
        if (result.status === 'failed') parked += 1;
        else deferred += 1;
        continue;
      }

      // 4. The batch stopped before this tweet was ever attempted (login
      //    failure, or the watchdog firing on an earlier tweet). Charging an
      //    attempt here is how untouched tweets used to reach the retry cap and
      //    get parked as "failed" without anything having gone wrong with them.
      if (!outcome && batchFailure) {
        postQueueService.releaseUnattempted(
          item,
          `Not attempted: the batch stopped first (${describeErrorDetail(batchFailure)})`,
          unattemptedRetryDelayMs(consecutiveBatchFailures.get(mapping.id) ?? 1),
        );
        deferred += 1;
        continue;
      }

      // 5. A genuine failure. Carry the specific reason onto the row.
      const detail = outcome?.detail ?? batchFailure ?? undefined;
      const reason =
        outcome?.reason ??
        (batchFailure
          ? `Batch stopped before this tweet completed: ${describeErrorDetail(batchFailure)}`
          : 'The post did not complete and no error was reported. This usually means the run was interrupted.');
      const result = postQueueService.releaseForRetry(item, reason, QUEUE_MAX_ATTEMPTS, {
        stage: outcome?.stage ?? batchStage,
        detail,
        retryable: outcome?.retryable ?? detail?.retryable,
      });

      if (result.status === 'failed') {
        parked += 1;
        logEvent({
          level: 'error',
          stage: 'queue',
          event: 'item.parked',
          message: `Tweet ${item.twitter_id} parked as failed after ${result.attempts} attempt(s): ${reason}`,
          twitterId: item.twitter_id,
          attempt: result.attempts,
          error: detail,
          detail: { failureStage: outcome?.stage ?? batchStage, tweetText: item.tweet_text },
          ...scope,
        });
      } else {
        retrying += 1;
        logEvent({
          level: 'warn',
          stage: 'queue',
          event: 'item.retry-scheduled',
          message:
            `Tweet ${item.twitter_id} will retry (attempt ${result.attempts} of ${QUEUE_MAX_ATTEMPTS}) ` +
            `in ${formatDurationMs((result.retryAt ?? Date.now()) - Date.now())}: ${reason}`,
          twitterId: item.twitter_id,
          attempt: result.attempts,
          error: detail,
          detail: { retryAt: result.retryAt, failureStage: outcome?.stage ?? batchStage },
          ...scope,
        });
      }
    }

    const parts = [`${posted} posted`];
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (repaired > 0) parts.push(`${repaired} already live, record repaired`);
    if (deferred > 0) parts.push(`${deferred} deferred without penalty`);
    if (retrying > 0) parts.push(`${retrying} will retry`);
    if (parked > 0) parts.push(`${parked} parked as failed`);

    logEvent({
      level: parked > 0 ? 'error' : retrying + deferred > 0 ? 'warn' : 'info',
      stage: 'queue',
      event: 'batch.settled',
      message: `@${batch.twitter_username} → ${mapping.bskyIdentifier}: ${parts.join(', ')} in ${formatDurationMs(Date.now() - startedAt)}.`,
      durationMs: Date.now() - startedAt,
      detail: { posted, skipped, repaired, deferred, retrying, parked, items: batch.items.length },
      ...scope,
    });
  }
}

function startPostWorkers(): void {
  if (postWorkersStarted) return;
  postWorkersStarted = true;
  logEvent({
    level: 'info',
    stage: 'queue',
    event: 'workers.started',
    message: `Post workers started; up to ${POST_WORKER_CONCURRENCY} accounts post in parallel.`,
    detail: { concurrency: POST_WORKER_CONCURRENCY },
  });

  void (async () => {
    while (true) {
      let launched = false;
      try {
        const config = getConfig();
        // A mapping whose Bluesky account is down is not claimable at all:
        // without this the workers keep claiming its rows, failing at login and
        // re-deferring them several times a second.
        const blockedIdentifiers = accountHealthService.blockedIdentifiers();
        const allowedMappingIds = new Set(
          config.mappings
            .filter((m) => m.enabled && !blockedIdentifiers.has(m.bskyIdentifier.toLowerCase()))
            .map((m) => m.id),
        );

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
            .catch((err) =>
              // runPostBatch settles its own rows in a finally block, so reaching
              // here means the settling itself threw. The claimed rows stay
              // 'processing' and are re-armed by resetProcessing() on next boot.
              logEvent({
                level: 'error',
                stage: 'queue',
                event: 'worker.crashed',
                message: `Post worker for ${mapping.bskyIdentifier} crashed while settling its batch.`,
                mappingId: mapping.id,
                bskyIdentifier: mapping.bskyIdentifier,
                twitterUsername: batch.twitter_username,
                error: toErrorDetail(err),
              }),
            )
            .finally(() => {
              activePostMappings.delete(mapping.id);
              updateJob(jobId, null);
            });
        }
      } catch (err) {
        logEvent({
          level: 'error',
          stage: 'queue',
          event: 'worker.scheduler-error',
          message: 'The post-worker scheduler hit an error while claiming work; it will try again shortly.',
          error: toErrorDetail(err),
        });
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

// Errors reaching this pipeline come from four very different places — the AT
// Protocol client (XRPCError: status + error code + message), axios (response
// status and body), Node sockets (ECONNRESET/ETIMEDOUT via `code`) and our own
// thrown Errors. `error.message` alone flattens all of that into text like
// "Request failed", which is exactly why a parked tweet used to say nothing
// useful. This pulls out every field worth keeping.
function toErrorDetail(error: unknown): ErrorDetail {
  const detail: ErrorDetail = {};

  if (typeof error === 'string') {
    detail.name = 'Error';
    detail.message = error;
    detail.retryable = isRetryableFailure(detail);
    return detail;
  }

  if (!error || typeof error !== 'object') {
    detail.name = 'Error';
    detail.message = String(error);
    detail.retryable = isRetryableFailure(detail);
    return detail;
  }

  const anyError = error as Record<string, any>;
  detail.name = typeof anyError.name === 'string' ? anyError.name : 'Error';
  detail.message =
    typeof anyError.message === 'string' && anyError.message.length > 0 ? anyError.message : String(error);

  // XRPCError puts the HTTP status on `status`; axios nests it under `response`.
  const status = anyError.status ?? anyError.statusCode ?? anyError.response?.status;
  if (typeof status === 'number') detail.status = status;

  // `code` is ECONNRESET/ETIMEDOUT on sockets, and the XRPC error name
  // ("RateLimitExceeded", "InvalidRequest") on AT Protocol failures.
  const code = anyError.code ?? anyError.error;
  if (typeof code === 'string' && code.length > 0) detail.code = code;

  if (typeof anyError.stack === 'string') detail.stack = anyError.stack;

  // The server's own explanation is usually the most actionable part.
  const body = anyError.response?.data ?? anyError.data ?? anyError.body;
  if (body !== undefined && body !== null) {
    detail.response = typeof body === 'string' ? body.slice(0, 2_000) : body;
  }

  // Walk `cause` so a wrapped failure keeps the underlying reason.
  const causes: string[] = [];
  let cause = anyError.cause;
  let depth = 0;
  while (cause && depth < 5) {
    const causeAny = cause as Record<string, any>;
    const text = typeof causeAny.message === 'string' ? causeAny.message : String(cause);
    causes.push(causeAny.code ? `${causeAny.code}: ${text}` : text);
    cause = causeAny.cause;
    depth += 1;
  }
  if (causes.length > 0) detail.causes = causes;

  detail.retryable = isRetryableFailure(detail);
  return detail;
}

// Decides whether trying again could plausibly work. Getting this wrong in the
// permissive direction is what made a malformed post burn eight attempts and
// six hours of backoff before anyone could see why it was rejected.
function isRetryableFailure(detail: ErrorDetail): boolean {
  const status = detail.status;
  if (typeof status === 'number') {
    // 429 and 5xx are transient; other 4xx mean the request itself is wrong
    // and will be rejected identically forever.
    if (status === 429) return true;
    if (status >= 500) return true;
    if (status >= 400) return false;
  }

  const code = (detail.code || '').toLowerCase();
  const message = (detail.message || '').toLowerCase();
  const haystack = `${code} ${message}`;

  // Network-level problems are always worth another go.
  if (
    /econnreset|etimedout|econnrefused|enotfound|eai_again|epipe|socket hang up|network|timed? out|aborted/.test(
      haystack,
    )
  ) {
    return true;
  }
  if (/ratelimit|rate limit|too many requests|upstream|unavailable|502|503|504/.test(haystack)) {
    return true;
  }
  // Record-level rejections never change on retry.
  if (
    /invalidrequest|invalid request|record\/?key|malformed|badrequest|unsupported|blob.*too large|not a valid/.test(
      haystack,
    )
  ) {
    return false;
  }
  if (
    /auth|unauthorized|forbidden|expired token|invalid.*password|account.*(deactivated|suspended|takendown)/.test(
      haystack,
    )
  ) {
    // Credential problems need a human, but they resolve without code changes,
    // so keep retrying (with backoff) rather than parking the tweet forever.
    return true;
  }
  return true;
}

/** Compact one-line reason suitable for a queue row or a log message. */
function describeErrorDetail(detail: ErrorDetail): string {
  const bits: string[] = [];
  if (detail.name && detail.name !== 'Error') bits.push(detail.name);
  if (typeof detail.status === 'number') bits.push(`HTTP ${detail.status}`);
  if (detail.code && detail.code !== detail.name) bits.push(detail.code);
  const prefix = bits.length > 0 ? `${bits.join(' ')}: ` : '';
  const body = detail.message || 'Unknown error';
  const cause = detail.causes?.[0] ? ` (caused by ${detail.causes[0]})` : '';
  return `${prefix}${body}${cause}`;
}

const describeError = (error: unknown): string => {
  if (error instanceof Error || (error && typeof error === 'object')) {
    return describeErrorDetail(toErrorDetail(error));
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
  if (record && record.status !== 'migrated' && record.status !== 'failed') {
    // Pinned retweets/external replies are never mirrored — remember that so we
    // don't retry (and log) every cycle. The previous pin is now wrong too:
    // leaving it would keep advertising a tweet the account has since unpinned.
    console.log(
      `${logPrefix} 📌 Pinned tweet ${pinnedTweetId} was not mirrored (${record.status}). Clearing the Bluesky pin.`,
    );
    if (mapping.lastPinnedTweetId) {
      await setBlueskyPinnedPost(agent, null, dryRun, logPrefix);
    }
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
      // Bios now follow X automatically, except where someone has edited the
      // Bluesky bio by hand (see canOverwriteDescription).
      syncDescription: true,
      botDisplayNameSuffix: mapping.botDisplayNameSuffix !== false,
      previousSync: {
        sourceUsername: mapping.profileSyncSourceUsername,
        mirroredDisplayName: mapping.lastMirroredDisplayName,
        mirroredDescription: mapping.lastMirroredDescription,
        avatarUrl: mapping.lastMirroredAvatarUrl,
        bannerUrl: mapping.lastMirroredBannerUrl,
        website: mapping.lastMirroredWebsite,
      },
    });

    Object.assign(mapping, applyProfileMirrorSyncState(mapping, sourceTwitterUsername, result));
    await persistProfileSyncResult(mapping.id, sourceTwitterUsername, result);

    // The daily profile read is also the one place a protected account shows
    // itself: its timeline just comes back empty, which looks like silence.
    sourceActivityService.setProtected(sourceTwitterUsername, Boolean(result.twitterProfile.isPrivate));
    if (result.twitterProfile.userId && !sourceActivityService.get(sourceTwitterUsername)?.twitter_user_id) {
      sourceActivityService.setUserId(sourceTwitterUsername, result.twitterProfile.userId);
    }

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
    const message = describeError(error);
    console.error(`${logPrefix} ❌ Automatic profile sync failed: ${message}`);
    if (/suspended|does not exist|not found|private/i.test(message)) {
      sourceActivityService.recordError(sourceTwitterUsername, message);
    }
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
            // One-shot runs (--run-once) apply the same "only new tweets"
            // cutoff as the queue path, then post inline as live mirrors.
            const cutoff = mapping.mirrorFromMs;
            const postable = cutoff
              ? tweets.filter((tweet) => {
                  const createdMs = tweet.created_at ? Date.parse(tweet.created_at) : Number.NaN;
                  return tweet.isPin || !Number.isFinite(createdMs) || createdMs >= cutoff;
                })
              : tweets;
            await withTimeout(
              processTweets(
                agent,
                twitterUsername,
                mapping.bskyIdentifier,
                postable,
                dryRun,
                undefined,
                undefined,
                sessionKey,
                { mappingId: mapping.id, isLive: () => true, settings: resolveMirrorSettings(mapping) },
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
  takeForcedSweep,
  updateAppStatus,
  updateJob,
  updateLastCheckTime,
} from './server.js';
import type { PendingBackfill } from './server.js';

/**
 * Compose the most recent tweets for an account exactly as the mirror would,
 * without posting anything. Runs the real processTweets path with dryRun set,
 * against a mock agent so no blob is uploaded and no session is needed — the
 * point is to answer "what would this mirror look like?" before committing to
 * it, and a preview that used its own compose logic would eventually lie.
 */
async function previewTweetsForAccount(request: PreviewRequest): Promise<PreviewResult> {
  const { twitterUsername, mappingId, limit } = request;
  const config = getConfig();
  const mapping = mappingId ? config.mappings.find((entry) => entry.id === mappingId) : undefined;
  const bskyIdentifier = mapping?.bskyIdentifier ?? 'preview.invalid';

  const tweets = await fetchUserTweets(twitterUsername, limit, undefined, 'preview');
  if (tweets.length === 0) {
    return { twitterUsername, fetched: 0, tweets: [] };
  }

  // A mock agent keeps the preview read-only: uploads return a fake blob ref and
  // nothing is ever written to Bluesky. dryRun also stops processTweets touching
  // the processed-tweets table, so previewing does not mark anything as mirrored.
  // biome-ignore lint/suspicious/noExplicitAny: mock agent, same shape as the dry-run import path
  const mockAgent: any = {
    post: async () => ({ uri: 'at://did:plc:preview/app.bsky.feed.post/preview', cid: 'preview-cid' }),
    uploadBlob: async () => ({ data: { blob: { ref: { toString: () => 'preview-blob' } } } }),
    session: { did: 'did:plc:preview' },
    com: { atproto: { repo: { describeRepo: async () => ({ data: {} }) } } },
  };

  const composed = new Map<string, ComposedTweet>();
  const outcomes = new Map<string, TweetOutcome>();
  await processTweets(mockAgent, twitterUsername, bskyIdentifier, tweets, true, undefined, undefined, 'preview', {
    outcomes,
    onComposed: (preview) => composed.set(preview.twitterId, preview),
    skipMediaDownload: true,
    mappingId: mapping?.id,
    // The preview must not show up in the dashboard as a real mirror running.
    quiet: true,
    isLive: () => true,
    settings: resolveMirrorSettings(mapping),
  });

  const previews: PreviewTweet[] = tweets.map((tweet) => {
    const twitterId = String(tweet.id_str || tweet.id || '');
    const entry = composed.get(twitterId);
    const outcome = outcomes.get(twitterId);
    return {
      twitterId,
      originalText: tweet.text ?? '',
      createdAt: tweet.created_at,
      chunks: (entry?.chunks ?? []).map((text) => ({ text, length: graphemeLength(text) })),
      images: entry?.images ?? 0,
      video: entry?.video ?? false,
      quote: entry?.quote ?? false,
      linkCard: entry?.linkCard ?? false,
      isReply: entry?.isReply ?? false,
      repostOf: entry?.repostOf,
      langs: entry?.langs,
      extraMediaPosts: entry?.extraMediaPosts ?? 0,
      // A tweet with no composed output was filtered out — a retweet, a reply to
      // someone else, an empty shell. Saying which is more useful than omitting it.
      skipped: entry
        ? undefined
        : { stage: outcome?.stage ?? 'filter', reason: outcome?.reason ?? 'This tweet would not be mirrored.' },
    };
  });

  return { twitterUsername, fetched: tweets.length, tweets: previews };
}

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

  // The dashboard's preview runs the real composer through this, so what it
  // shows is what would actually be posted.
  setPreviewRunner(previewTweetsForAccount);

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

  logEvent({
    level: 'info',
    stage: 'system',
    event: 'daemon.start',
    message: `Scheduler started with a ${config.checkIntervalMinutes} minute base interval.`,
    detail: {
      checkIntervalMinutes: config.checkIntervalMinutes,
      fetchConcurrency: FETCH_CONCURRENCY,
      postWorkerConcurrency: POST_WORKER_CONCURRENCY,
      scraperGapMs: SCRAPER_MIN_GAP_MS,
      scraperJitterMs: SCRAPER_JITTER_MS,
      pacingMs: [POST_PACING_MIN_MS, POST_PACING_MAX_MS],
      queueMaxAttempts: QUEUE_MAX_ATTEMPTS,
      mappings: config.mappings.length,
      enabledMappings: config.mappings.filter((mapping) => mapping.enabled).length,
    },
  });

  // Durable queue startup: re-arm anything a previous run left mid-flight and
  // drop failed rows old enough that nobody is coming back for them.
  const recovered = postQueueService.resetProcessing();
  if (recovered > 0) {
    logEvent({
      level: 'info',
      stage: 'queue',
      event: 'queue.recovered',
      message: `Recovered ${recovered} in-flight tweet(s) left behind by a previous run.`,
      detail: { count: recovered },
    });
  }

  // Repair anything that reached Bluesky but never made it into the history
  // table — typically a crash between the post and the write. Doing this at
  // boot means a restart clears the backlog of phantom "failures" instead of
  // re-posting them as duplicates.
  reconcilePostedButUnrecorded();

  purgeStaleFailedQueueRows();
  // Drop rows whose mapping was deleted while the app was down — nothing can
  // ever claim them.
  const knownMappingIds = new Set(getConfig().mappings.map((mapping) => mapping.id));
  for (const entry of postQueueService.getCounts().perMapping) {
    if (!knownMappingIds.has(entry.mapping_id)) {
      const removed = postQueueService.deleteByMappingId(entry.mapping_id);
      logEvent({
        level: 'info',
        stage: 'queue',
        event: 'queue.orphans-removed',
        message: `Removed ${removed} queued tweet(s) for mapping ${entry.mapping_id}, which no longer exists in the config.`,
        mappingId: entry.mapping_id,
        detail: { removed },
      });
    }
  }
  const startupCounts = postQueueService.getCounts();
  if (startupCounts.pending + startupCounts.failed > 0) {
    logEvent({
      level: startupCounts.failed > 0 ? 'warn' : 'info',
      stage: 'queue',
      event: 'queue.startup-state',
      message:
        `Queue at startup: ${startupCounts.ready} ready to post, ${startupCounts.backoff} waiting on retry backoff, ` +
        `${startupCounts.failed} parked as failed.`,
      detail: {
        ready: startupCounts.ready,
        backoff: startupCounts.backoff,
        pending: startupCounts.pending,
        processing: startupCounts.processing,
        failed: startupCounts.failed,
      },
    });
  }
  startPostWorkers();

  // Housekeeping the boot-only version never did: failed rows used to
  // accumulate for the whole uptime of the process, which is how a long-running
  // instance ends up showing hundreds of stale failures at once.
  setInterval(
    () => {
      try {
        reconcilePostedButUnrecorded();
        purgeStaleFailedQueueRows();
      } catch (err) {
        logEvent({
          level: 'error',
          stage: 'system',
          event: 'housekeeping.failed',
          message: 'Queue housekeeping pass failed.',
          error: toErrorDetail(err),
        });
      }
    },
    6 * 60 * 60 * 1000,
  ).unref();

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
      const forced = takeForcedSweep();
      await runFetchSweep(config.mappings, {
        force: forced.all,
        forceMappingIds: forced.mappingIds.size > 0 ? forced.mappingIds : undefined,
      });

      updateAppStatus({ state: 'idle', message: 'Scheduled checks complete' });
    }

    // Sleep briefly between loop iterations, but wake early when UI actions request work.
    await sleepWithWake(5000);
  }
}

// The offline tests import this module for processTweets and set this so the
// scheduler, web server and CLI parser do not start. It is an explicit opt-out
// rather than an entry-point check on purpose: process managers that load the
// script through a wrapper (pm2 with a custom interpreter) would otherwise
// quietly never start the daemon.
if (process.env.TWEETS2BSKY_NO_AUTOSTART !== '1') {
  main();
}

export { enqueueTweetsForMapping, mapScraperTweetToLocalTweet, uploadToBluesky, reconcilePostedButUnrecorded };
export type { Tweet, QuotedTweetInfo };
