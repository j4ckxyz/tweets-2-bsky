import 'dotenv/config';
import fs from 'node:fs';
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
import { generateAltText } from './ai-manager.js';

import { getConfig } from './config-manager.js';

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

interface UrlEntity {
  url?: string;
  expanded_url?: string;
}

interface CardImageValue {
  url?: string;
  width?: number;
  height?: number;
  alt?: string;
}

interface CardBindingValue {
  type?: string;
  string_value?: string;
  image_value?: CardImageValue;
}

interface CardBindingEntry {
  key?: string;
  value?: CardBindingValue;
}

type CardBindingValues = Record<string, CardBindingValue> | CardBindingEntry[];

interface TweetCard {
  name?: string;
  binding_values?: CardBindingValues;
  url?: string;
}

interface MediaSize {
  w: number;
  h: number;
}

interface MediaSizes {
  large?: MediaSize;
}

interface OriginalInfo {
  width: number;
  height: number;
}

interface VideoVariant {
  content_type: string;
  url: string;
  bitrate?: number;
}

interface VideoInfo {
  variants?: VideoVariant[];
  duration_millis?: number;
}

interface MediaEntity {
  url?: string;
  expanded_url?: string;
  media_url_https?: string;
  type?: 'photo' | 'video' | 'animated_gif';
  ext_alt_text?: string;
  sizes?: MediaSizes;
  original_info?: OriginalInfo;
  video_info?: VideoInfo;
  source?: 'tweet' | 'card';
}

interface TweetEntities {
  urls?: UrlEntity[];
  media?: MediaEntity[];
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

import { dbService } from './db.js';

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

let scraper: Scraper | null = null;
let currentTwitterCookies = { authToken: '', ct0: '' };
let useBackupCredentials = false;
const lastCreatedAtByBsky = new Map<string, number>();

function getUniqueCreatedAtIso(bskyIdentifier: string, desiredMs: number): string {
  const key = bskyIdentifier.toLowerCase();
  const lastMs = lastCreatedAtByBsky.get(key) ?? Number.MIN_SAFE_INTEGER;
  const nextMs = Math.max(desiredMs, lastMs + 1);
  lastCreatedAtByBsky.set(key, nextMs);
  return new Date(nextMs).toISOString();
}

async function getTwitterScraper(forceReset = false): Promise<Scraper | null> {
  const config = getConfig();
  let authToken = config.twitter.authToken;
  let ct0 = config.twitter.ct0;

  // Use backup if toggled
  if (useBackupCredentials && config.twitter.backupAuthToken && config.twitter.backupCt0) {
    authToken = config.twitter.backupAuthToken;
    ct0 = config.twitter.backupCt0;
  }

  if (!authToken || !ct0) return null;

  // Re-initialize if config changed, not yet initialized, or forced reset
  if (!scraper || forceReset || currentTwitterCookies.authToken !== authToken || currentTwitterCookies.ct0 !== ct0) {
    console.log(`🔄 Initializing Twitter scraper with ${useBackupCredentials ? 'BACKUP' : 'PRIMARY'} credentials...`);
    scraper = new Scraper();
    await scraper.setCookies([`auth_token=${authToken}`, `ct0=${ct0}`]);

    currentTwitterCookies = {
      authToken: authToken,
      ct0: ct0,
    };
  }
  return scraper;
}

async function switchCredentials() {
  const config = getConfig();
  if (config.twitter.backupAuthToken && config.twitter.backupCt0) {
    useBackupCredentials = !useBackupCredentials;
    console.log(`⚠️ Switching to ${useBackupCredentials ? 'BACKUP' : 'PRIMARY'} Twitter credentials...`);
    await getTwitterScraper(true);
    return true;
  }
  console.log('⚠️ No backup credentials available to switch to.');
  return false;
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
    };
  }

  return {
    id: raw.id_str,
    id_str: raw.id_str,
    text: raw.full_text,
    full_text: raw.full_text,
    created_at: raw.created_at,
    isRetweet: scraperTweet.isRetweet,
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

function normalizeCardBindings(bindingValues?: CardBindingValues): Record<string, CardBindingValue> {
  if (!bindingValues) return {};
  if (Array.isArray(bindingValues)) {
    return bindingValues.reduce(
      (acc, entry) => {
        if (entry?.key && entry.value) acc[entry.key] = entry.value;
        return acc;
      },
      {} as Record<string, CardBindingValue>,
    );
  }
  return bindingValues as Record<string, CardBindingValue>;
}

function isLikelyUrl(value?: string): value is string {
  if (!value) return false;
  return /^https?:\/\//i.test(value);
}

function extractCardImageUrl(bindingValues: CardBindingValues, preferredKeys: string[]): string | undefined {
  const normalized = normalizeCardBindings(bindingValues);
  for (const key of preferredKeys) {
    const value = normalized[key];
    const imageUrl = value?.image_value?.url;
    if (imageUrl) return imageUrl;
  }
  const fallbackValue = Object.values(normalized).find((value) => value?.image_value?.url);
  return fallbackValue?.image_value?.url;
}

function extractCardLink(bindingValues: CardBindingValues, preferredKeys: string[]): string | undefined {
  const normalized = normalizeCardBindings(bindingValues);
  for (const key of preferredKeys) {
    const value = normalized[key];
    const link = value?.string_value;
    if (isLikelyUrl(link)) return link;
  }
  const fallbackValue = Object.values(normalized).find((value) => isLikelyUrl(value?.string_value));
  return fallbackValue?.string_value;
}

function extractCardTitle(bindingValues: CardBindingValues, preferredKeys: string[]): string | undefined {
  const normalized = normalizeCardBindings(bindingValues);
  for (const key of preferredKeys) {
    const value = normalized[key];
    const title = value?.string_value;
    if (title && !isLikelyUrl(title)) return title;
  }
  const fallbackValue = Object.values(normalized).find(
    (value) => value?.string_value && !isLikelyUrl(value?.string_value),
  );
  return fallbackValue?.string_value;
}

function extractCardAlt(bindingValues: CardBindingValues): string | undefined {
  const normalized = normalizeCardBindings(bindingValues);
  const altValue = Object.values(normalized).find((value) => value?.image_value?.alt);
  return altValue?.image_value?.alt;
}

function appendCallToAction(text: string, link?: string, label = 'Sponsored') {
  if (!link) return text;
  if (text.includes(link)) return text;
  return `${text}\n\n${label}: ${link}`.trim();
}

function detectCardMedia(tweet: Tweet): { imageUrls: string[]; link?: string; title?: string; alt?: string } {
  if (!tweet.card?.binding_values) return { imageUrls: [] };
  const bindings = tweet.card.binding_values;

  const imageUrls: string[] = [];
  const preferredImageKeys = [
    'photo_image_full_size',
    'photo_image_full_size_original',
    'thumbnail_image',
    'image',
    'thumbnail',
    'summary_photo_image',
    'player_image',
  ];
  const preferredLinkKeys = ['site', 'destination', 'landing_url', 'cta_link', 'card_url', 'url'];
  const preferredTitleKeys = ['title', 'summary', 'card_title'];

  const primaryImage = extractCardImageUrl(bindings, preferredImageKeys);
  if (primaryImage) imageUrls.push(primaryImage);

  const imageKeys = normalizeCardBindings(bindings);
  Object.values(imageKeys).forEach((value) => {
    const url = value?.image_value?.url;
    if (url && !imageUrls.includes(url)) imageUrls.push(url);
  });

  const link = extractCardLink(bindings, preferredLinkKeys);
  const title = extractCardTitle(bindings, preferredTitleKeys);
  const alt = extractCardAlt(bindings);

  return { imageUrls, link, title, alt };
}

function buildCardMediaEntities(tweet: Tweet): { media: MediaEntity[]; link?: string } {
  const cardData = detectCardMedia(tweet);
  if (cardData.imageUrls.length === 0) return { media: [] };

  const media = cardData.imageUrls.slice(0, 4).map((url) => ({
    media_url_https: url,
    type: 'photo' as const,
    ext_alt_text: cardData.alt || cardData.title || 'Sponsored image',
    source: 'card' as const,
  }));

  return { media, link: cardData.link };
}

function ensureUrlEntity(entities: TweetEntities | undefined, link?: string) {
  if (!link) return;
  if (!entities) return;
  const urls = entities.urls || [];
  if (!urls.some((url) => url.expanded_url === link || url.url === link)) {
    urls.push({ url: link, expanded_url: link });
    entities.urls = urls;
  }
}

function detectSponsoredCard(tweet: Tweet): boolean {
  if (!tweet.card?.binding_values) return false;
  const cardName = tweet.card.name?.toLowerCase() || '';
  const cardMedia = detectCardMedia(tweet);
  const hasMultipleImages = cardMedia.imageUrls.length > 1;
  const promoKeywords = ['promo', 'unified', 'carousel', 'collection', 'amplify'];
  const hasPromoName = promoKeywords.some((keyword) => cardName.includes(keyword));
  return hasMultipleImages || hasPromoName;
}

function mergeMediaEntities(primary: MediaEntity[], secondary: MediaEntity[], limit = 4): MediaEntity[] {
  const merged: MediaEntity[] = [];
  const seen = new Set<string>();
  const ordered = [
    ...primary.filter((media) => media?.source !== 'card'),
    ...primary.filter((media) => media?.source === 'card'),
    ...secondary.filter((media) => media?.source !== 'card'),
    ...secondary.filter((media) => media?.source === 'card'),
  ];

  for (const media of ordered) {
    if (!media?.media_url_https) continue;
    if (seen.has(media.media_url_https)) continue;
    merged.push(media);
    seen.add(media.media_url_https);
    if (merged.length >= limit) break;
  }

  return merged;
}

function detectCarouselLinks(tweet: Tweet): string[] {
  if (!tweet.card?.binding_values) return [];
  const bindings = normalizeCardBindings(tweet.card.binding_values);
  const links = Object.values(bindings)
    .map((value) => value?.string_value)
    .filter((value): value is string => isLikelyUrl(value));
  return [...new Set(links)];
}

function mergeUrlEntities(entities: TweetEntities | undefined, links: string[]) {
  if (!entities || links.length === 0) return;
  const urls = entities.urls || [];
  links.forEach((link) => {
    if (!urls.some((url) => url.expanded_url === link || url.url === link)) {
      urls.push({ url: link, expanded_url: link });
    }
  });
  entities.urls = urls;
}

function injectCardMedia(tweet: Tweet) {
  if (!tweet.card?.binding_values) return;
  const cardMedia = buildCardMediaEntities(tweet);
  if (cardMedia.media.length === 0) return;

  const existingMedia = tweet.extended_entities?.media || tweet.entities?.media || [];
  const mergedMedia = mergeMediaEntities(existingMedia, cardMedia.media);

  if (!tweet.extended_entities) tweet.extended_entities = {};
  tweet.extended_entities.media = mergedMedia;
  if (!tweet.entities) tweet.entities = {};
  if (!tweet.entities.media) tweet.entities.media = mergedMedia;

  if (cardMedia.link) {
    ensureUrlEntity(tweet.entities, cardMedia.link);
  }

  const carouselLinks = detectCarouselLinks(tweet);
  mergeUrlEntities(tweet.entities, carouselLinks);
}

function ensureSponsoredLinks(text: string, tweet: Tweet): string {
  if (!tweet.card?.binding_values) return text;
  const carouselLinks = detectCarouselLinks(tweet);
  const cardLink = detectCardMedia(tweet).link;
  const links = [...new Set([cardLink, ...carouselLinks].filter(Boolean))] as string[];
  if (links.length === 0) return text;

  const appendedLinks = links.slice(0, 2).map((link) => `Link: ${link}`);
  const updatedText = `${text}\n\n${appendedLinks.join('\n')}`.trim();
  return updatedText;
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

async function fetchSyndicationMedia(tweetUrl: string): Promise<{ images: string[] }> {
  try {
    const normalized = tweetUrl.replace('twitter.com', 'x.com');
    const res = await axios.get('https://publish.twitter.com/oembed', {
      params: { url: normalized },
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = res.data?.html as string | undefined;
    if (!html) return { images: [] };

    const match = html.match(/status\/(\d+)/);
    const tweetId = match?.[1];
    if (!tweetId) return { images: [] };

    const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}`;
    const syndication = await axios.get(syndicationUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    const data = syndication.data as Record<string, unknown>;
    const images = (data?.photos as { url?: string }[] | undefined)
      ?.map((photo) => photo.url)
      .filter(Boolean) as string[];
    return { images: images || [] };
  } catch (err) {
    return { images: [] };
  }
}

function injectSyndicationMedia(tweet: Tweet, syndication: { images: string[] }) {
  if (syndication.images.length === 0) return;
  const media = syndication.images.slice(0, 4).map((url) => ({
    media_url_https: url,
    type: 'photo' as const,
    ext_alt_text: 'Image from Twitter',
    source: 'card' as const,
  }));

  const existingMedia = tweet.extended_entities?.media || tweet.entities?.media || [];
  const mergedMedia = mergeMediaEntities(existingMedia, media);

  if (!tweet.extended_entities) tweet.extended_entities = {};
  tweet.extended_entities.media = mergedMedia;
  if (!tweet.entities) tweet.entities = {};
  if (!tweet.entities.media) tweet.entities.media = mergedMedia;
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
      validateStatus: (status) => status >= 200 && status < 400,
    });
    // biome-ignore lint/suspicious/noExplicitAny: axios internal types
    return (response.request as any)?.res?.responseUrl || shortUrl;
  } catch {
    try {
      const response = await axios.get(shortUrl, {
        responseType: 'stream',
        maxRedirects: 5,
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

async function downloadMedia(url: string): Promise<DownloadedMedia> {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'arraybuffer',
    timeout: 30000,
  });
  return {
    buffer: Buffer.from(response.data as ArrayBuffer),
    mimeType: (response.headers['content-type'] as string) || 'application/octet-stream',
  };
}

async function uploadToBluesky(agent: BskyAgent, buffer: Buffer, mimeType: string): Promise<BlobRef> {
  let finalBuffer = buffer;
  let finalMimeType = mimeType;
  const MAX_SIZE = 950 * 1024;

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
      let quality = 90;

      // Iterative compression loop
      let attempts = 0;
      while (currentBuffer.length > MAX_SIZE && attempts < 5) {
        attempts++;
        console.log(`[UPLOAD] 📉 Compression attempt ${attempts}: Width ${width}, Quality ${quality}...`);

        if (isAnimation) {
          // For animations (GIF/WebP), we can only do so much without losing frames
          // Try to convert to WebP if it's a GIF, or optimize WebP
          image = sharp(buffer, { animated: true });
          if (isGif) {
            // Convert GIF to WebP for better compression
            image = image.webp({ quality: Math.max(quality, 50), effort: 6 });
            finalMimeType = 'image/webp';
          } else {
            image = image.webp({ quality: Math.max(quality, 50), effort: 6 });
          }
          // Resize if really big
          if (metadata.width && metadata.width > 800) {
            image = image.resize({ width: 800, withoutEnlargement: true });
          }
        } else {
          // Static images
          if (width > 1600) width = 1600;
          else if (attempts > 1) width = Math.floor(width * 0.8);

          quality = Math.max(50, quality - 10);

          image = sharp(buffer).resize({ width, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true });

          finalMimeType = 'image/jpeg';
        }

        currentBuffer = await image.toBuffer();
        if (currentBuffer.length <= MAX_SIZE) {
          finalBuffer = currentBuffer;
          console.log(`[UPLOAD] ✅ Optimized to ${(finalBuffer.length / 1024).toFixed(2)} KB`);
          break;
        }
      }

      if (finalBuffer.length > MAX_SIZE) {
        console.warn(
          `[UPLOAD] ⚠️ Could not compress below limit. Current: ${(finalBuffer.length / 1024).toFixed(2)} KB. Upload might fail.`,
        );
      }
    } catch (err) {
      console.warn(`[UPLOAD] ⚠️ Optimization failed, attempting original upload:`, (err as Error).message);
      finalBuffer = buffer;
      finalMimeType = mimeType;
    }
  }

  const { data } = await agent.uploadBlob(finalBuffer, { encoding: finalMimeType });
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
    console.warn(`[SCREENSHOT] ⏩ Skipping screenshot (no Chrome/Chromium found at common paths).`);
    return null;
  }

  console.log(`[SCREENSHOT] 📸 Capturing screenshot for: ${tweetUrl} using ${executablePath}`);
  let browser;
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
      console.warn(`[SCREENSHOT] ⚠️ Timeout waiting for tweet iframe, taking screenshot anyway.`);
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
    console.error(`[SCREENSHOT] ❌ Error capturing tweet:`, (err as Error).message);
  } finally {
    if (browser) await browser.close();
  }
  return null;
}

async function pollForVideoProcessing(agent: BskyAgent, jobId: string): Promise<BlobRef> {
  console.log(`[VIDEO] ⏳ Polling for processing completion (this can take a minute)...`);
  let attempts = 0;
  let blob: BlobRef | undefined;

  while (!blob) {
    attempts++;
    const statusUrl = new URL('https://video.bsky.app/xrpc/app.bsky.video.getJobStatus');
    statusUrl.searchParams.append('jobId', jobId);

    const statusResponse = await fetch(statusUrl);
    if (!statusResponse.ok) {
      console.warn(`[VIDEO] ⚠️ Job status fetch failed (${statusResponse.status}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }

    const statusData = (await statusResponse.json()) as any;
    const state = statusData.jobStatus.state;
    const progress = statusData.jobStatus.progress || 0;

    console.log(`[VIDEO] 🔄 Job ${jobId}: ${state} (${progress}%)`);

    if (statusData.jobStatus.blob) {
      blob = statusData.jobStatus.blob;
      console.log(`[VIDEO] 🎉 Video processing complete! Blob ref obtained.`);
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
    console.log(`[VIDEO] ✅ Service auth token obtained.`);

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
          console.warn(`[VIDEO] ⚠️ Server overloaded (503). Skipping video upload and falling back to link.`);
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
            `[VIDEO] 🛑 BLUESKY ERROR: Your email is unconfirmed. You MUST verify your email on Bluesky to upload videos.`,
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
    console.error(`[VIDEO] ❌ Error in uploadVideoToBluesky:`, (err as Error).message);
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
    if (remaining.length <= limit) {
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
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text))) {
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

// Simple p-limit implementation for concurrency control
const pLimit = (concurrency: number) => {
  const queue: (() => Promise<void>)[] = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()!();
    }
  };

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        activeCount++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          next();
        }
      };

      if (activeCount < concurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
};

// Replaced safeSearch with fetchUserTweets to use UserTweets endpoint instead of Search
// Added processedIds for early stopping optimization
type FetchUserTweetsResult = {
  tweets: Tweet[];
  failed: boolean;
  error?: string;
};

async function fetchUserTweets(
  username: string,
  limit: number,
  processedIds?: Set<string>,
): Promise<FetchUserTweetsResult> {
  const client = await getTwitterScraper();
  if (!client) {
    return { tweets: [], failed: true, error: 'Twitter credentials not set (missing auth_token/ct0).' };
  }

  let retries = 3;
  while (retries > 0) {
    try {
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
      return { tweets, failed: false };
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
          console.log(`🔄 Retrying with new credentials...`);
          continue; // Retry loop with new credentials
        }

        if (retries > 0) {
          console.log(`Waiting 5s before retry...`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
      }

      const reason = e?.message ? String(e.message) : String(e);
      console.warn(`Error fetching tweets for ${username}:`, reason);
      return { tweets: [], failed: true, error: reason };
    }
  }

  console.log(`[${username}] ⚠️ Scraper returned 0 tweets (or failed silently) after retries.`);
  return { tweets: [], failed: true, error: 'Scraper returned 0 tweets (or failed silently) after retries.' };
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
  const localProcessedMap: ProcessedTweetsMap =
    sharedProcessedMap ?? { ...loadProcessedTweets(bskyIdentifier) };

  const toProcess = filteredTweets.filter((t) => !localProcessedMap[t.id_str || t.id || '']);

  if (toProcess.length === 0) {
    console.log(`[${twitterUsername}] ✅ No new tweets to process for ${bskyIdentifier}.`);
    return;
  }

  console.log(`[${twitterUsername}] 🚀 Processing ${toProcess.length} new tweets for ${bskyIdentifier}...`);

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
          const scraper = await getTwitterScraper();
          if (scraper) {
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
    for (const tco of matches) {
      // Avoid re-resolving if we already handled it via entities
      if (urls.some((u) => u.url === tco)) continue;

      console.log(`[${twitterUsername}] 🔍 Resolving fallback link: ${tco}`);
      const resolved = await expandUrl(tco);
      if (resolved !== tco) {
        text = text.replace(tco, resolved);
        // Add to urls array so it can be used for card embedding later
        urls.push({ url: tco, expanded_url: resolved });
      }
    }

    const isSponsoredCard = detectSponsoredCard(tweet);
    if (isSponsoredCard) {
      console.log(`[${twitterUsername}] 🧩 Sponsored/card payload detected. Extracting carousel media...`);
      injectCardMedia(tweet);
    } else if (tweet.permanentUrl) {
      const syndication = await fetchSyndicationMedia(tweet.permanentUrl);
      if (syndication.images.length > 0) {
        console.log(`[${twitterUsername}] 🧩 Syndication carousel detected. Extracting media...`);
        injectSyndicationMedia(tweet, syndication);
      }
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
        if (media.expanded_url) mediaLinksToRemove.push(media.expanded_url);
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
          const highQualityUrl = url.includes('?') ? url.replace('?', ':orig?') : url + ':orig';
          console.log(`[${twitterUsername}] 📥 Downloading image (high quality): ${path.basename(highQualityUrl)}`);
          updateAppStatus({ message: `Downloading high quality image...` });
          const { buffer, mimeType } = await downloadMedia(highQualityUrl);

          let blob: BlobRef;
          if (dryRun) {
            console.log(
              `[${twitterUsername}] 🧪 [DRY RUN] Would upload image (${(buffer.length / 1024).toFixed(2)} KB)`,
            );
            blob = { ref: { toString: () => 'mock-blob' }, mimeType, size: buffer.length } as any;
          } else {
            console.log(`[${twitterUsername}] 📤 Uploading image to Bluesky...`);
            updateAppStatus({ message: `Uploading image to Bluesky...` });
            blob = await uploadToBluesky(agent, buffer, mimeType);
          }

          let altText = media.ext_alt_text;
          if (!altText) {
            console.log(`[${twitterUsername}] 🤖 Generating alt text via Gemini...`);
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
            updateAppStatus({ message: `Retrying with standard quality...` });
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
              const { buffer, mimeType } = await downloadMedia(videoUrl);

              if (buffer.length <= 90 * 1024 * 1024) {
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
                  updateAppStatus({ message: `Uploading video to Bluesky...` });
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
      requestedLinks.forEach((link) => {
        if (!urls.some((u) => u.expanded_url === link || u.url === link)) {
          urls.push({ url: link, expanded_url: link });
        }
      });
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
      if (quoteRef && !quoteRef.migrated && quoteRef.uri && quoteRef.cid) {
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
      await rt.detectFacets(agent);
      rt.facets = addTwitterHandleLinkFacets(rt.text, rt.facets);
      const detectedLangs = detectLanguage(chunk);

      // Preserve original timing when available, but enforce monotonic per-account
      // timestamps to avoid equal-createdAt collisions in fast self-thread replies.
      const parsedCreatedAt = tweet.created_at ? Date.parse(tweet.created_at) : NaN;
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
          postRecord.embed = videoEmbed;
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
              response = await agent.post(postRecord);
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
    }

    // Add a random delay between 5s and 15s to be more human-like
    const wait = Math.floor(Math.random() * 10000) + 5000;
    console.log(`[${twitterUsername}] 😴 Pacing: Waiting ${wait / 1000}s before next tweet.`);
    updateAppStatus({ state: 'pacing', message: `Pacing: Waiting ${wait / 1000}s...` });
    await new Promise((r) => setTimeout(r, wait));
  }
}

import { getAgent } from './bsky.js';

async function importHistory(
  twitterUsername: string,
  bskyIdentifier: string,
  limit = 15,
  dryRun = false,
  ignoreCancellation = false,
  requestId?: string,
): Promise<void> {
  const config = getConfig();
  const mapping = config.mappings.find((m) =>
    m.twitterUsernames.map((u) => u.toLowerCase()).includes(twitterUsername.toLowerCase()),
  );
  if (!mapping) {
    console.error(`No mapping found for twitter username: ${twitterUsername}`);
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
  updateAppStatus({ message: `Fetching tweets...` });

  const client = await getTwitterScraper();
  if (client) {
    try {
      // Use getTweets which reliably fetches user timeline
      // limit defaults to 15 in function signature, but for history import we might want more.
      // However, the generator will fetch as much as we ask.
      const fetchLimit = limit || 100;
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
    await processTweets(agent as BskyAgent, twitterUsername, bskyIdentifier, allFoundTweets, dryRun);
    console.log('History import complete.');
  }
}

// Task management
const activeTasks = new Map<string, Promise<void>>();
const DEFAULT_BACKFILL_ACCOUNT_TIMEOUT_MS = 2 * 60 * 1000;

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

async function runAccountTask(mapping: AccountMapping, backfillRequest?: PendingBackfill, dryRun = false) {
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
    console.log(
      `${logPrefix} ▶️ Starting ${taskMode} task for ${mapping.twitterUsernames.length} source account(s).`,
    );

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
              importHistory(twitterUsername, mapping.bskyIdentifier, limit, dryRun, false, backfillReq.requestId),
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
            console.error(
              `${logPrefix} ❌ Error backfilling @${twitterUsername}: ${describeError(err)}`,
            );
          }
        }
        clearBackfill(mapping.id, backfillReq.requestId);
        updateAppStatus({
          state: 'idle',
          processedCount: accountCount,
          totalCount: accountCount,
          message: `Backfill complete for ${mapping.bskyIdentifier}`,
          backfillMappingId: undefined,
          backfillRequestId: undefined,
        });
        console.log(`${logPrefix} Backfill complete.`);
      } else {
        updateAppStatus({ backfillMappingId: undefined, backfillRequestId: undefined });

        // Pre-load processed IDs for optimization
        const processedMap = loadProcessedTweets(mapping.bskyIdentifier);
        const processedIds = new Set(Object.keys(processedMap));

        for (const twitterUsername of mapping.twitterUsernames) {
          try {
            checkedSources += 1;
            console.log(`[${twitterUsername}] 🏁 Starting check for new tweets...`);
            updateAppStatus({
              state: 'checking',
              currentAccount: twitterUsername,
              message: 'Fetching latest tweets...',
              backfillMappingId: undefined,
              backfillRequestId: undefined,
            });

            // Use fetchUserTweets with early stopping optimization
            // Increase limit slightly since we have early stopping now
            const fetchResult = await fetchUserTweets(twitterUsername, 50, processedIds);

            if (fetchResult.failed) {
              console.warn(
                `[${twitterUsername}] ⚠️ Tweet fetch failed: ${fetchResult.error || 'unknown reason'}`,
              );
              continue;
            }

            const tweets = fetchResult.tweets;
            if (tweets.length === 0) {
              console.log(`[${twitterUsername}] ℹ️ No new tweets found.`);
              continue;
            }

            console.log(`[${twitterUsername}] 📥 Fetched ${tweets.length} tweets.`);
            await processTweets(agent, twitterUsername, mapping.bskyIdentifier, tweets, dryRun);
          } catch (err) {
            sourceErrors += 1;
            console.error(`${logPrefix} ❌ Error checking @${twitterUsername}: ${describeError(err)}`);
          }
        }
      }
    } catch (err) {
      sourceErrors += 1;
      console.error(`${logPrefix} ❌ Mapping task failed: ${describeError(err)}`);
    } finally {
      activeTasks.delete(mapping.id);
      console.log(
        `${logPrefix} ✅ Task finished. Sources checked=${checkedSources}, source errors=${sourceErrors}.`,
      );
    }
  })();

  activeTasks.set(mapping.id, task);
  return task; // Return task promise for await in main loop
}

import type { AccountMapping } from './config-manager.js';
import {
  clearBackfill,
  getNextCheckTime,
  getPendingBackfills,
  getSchedulerWakeSignal,
  startServer,
  updateAppStatus,
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

  const runSingleCycle = async (cycleConfig: ReturnType<typeof getConfig>) => {
    const runLimit = pLimit(3);
    const tasks: Promise<void>[] = [];

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
      await runAccountTask(mapping, backfillRequest, options.dryRun);
      updateAppStatus({ state: 'idle', message: `Backfill complete for ${mapping.bskyIdentifier}` });
      return;
    }

    for (const mapping of cycleConfig.mappings) {
      if (!mapping.enabled) continue;
      tasks.push(
        runLimit(async () => {
          await runAccountTask(mapping, undefined, options.dryRun);
        }),
      );
    }

    if (tasks.length === 0) {
      console.log('[CLI] No enabled mappings found.');
      updateAppStatus({ state: 'idle', message: 'No enabled mappings found' });
      return;
    }

    await Promise.all(tasks);
    updateAppStatus({ state: 'idle', message: options.dryRun ? 'Dry run cycle complete' : 'Run-once cycle complete' });
  };

  if (options.runOnce || options.backfillMapping || options.dryRun) {
    await runSingleCycle(getConfig());
    console.log(options.dryRun ? 'Dry run cycle complete. Exiting.' : 'Run-once cycle complete. Exiting.');
    process.exit(0);
  }

  console.log(`Scheduler started. Base interval: ${config.checkIntervalMinutes} minutes.`);
  updateLastCheckTime(); // Initialize next time

  // Concurrency limit for processing accounts
  const runLimit = pLimit(3);
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

      const [nextBackfill] = pendingBackfills;
      if (nextBackfill) {
        const mapping = findMappingById(config.mappings, nextBackfill.id);
        if (mapping && mapping.enabled) {
          const limit = nextBackfill.limit || 15;
          console.log(
            `[Scheduler] 🚧 Backfill priority 1/${pendingBackfills.length}: ${mapping.bskyIdentifier} (limit ${limit})`,
          );
          await runAccountTask(mapping, nextBackfill, options.dryRun);
        } else {
          clearBackfill(nextBackfill.id, nextBackfill.requestId);
        }
      }

      const remainingBackfills = getPendingBackfills();
      if (remainingBackfills.length === 0) {
        updateAppStatus({
          state: 'idle',
          message: deferredScheduledRun || isScheduledRunDue ? 'Backfill queue complete. Scheduled checks next.' : 'Backfill queue empty',
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

      const tasks: Promise<void>[] = [];
      for (const mapping of config.mappings) {
        if (!mapping.enabled) continue;

        tasks.push(
          runLimit(async () => {
            await runAccountTask(mapping, undefined, options.dryRun);
          }),
        );
      }

      if (tasks.length > 0) {
        await Promise.all(tasks);
        console.log(`[Scheduler] ✅ All tasks for this cycle complete.`);
      } else {
        console.log('[Scheduler] ℹ️ No enabled mappings found for scheduled cycle.');
      }

      updateAppStatus({ state: 'idle', message: 'Scheduled checks complete' });
    }

    // Sleep briefly between loop iterations, but wake early when UI actions request work.
    await sleepWithWake(5000);
  }
}

main();
