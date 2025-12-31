import 'dotenv/config';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BskyAgent, RichText } from '@atproto/api';
import type { BlobRef } from '@atproto/api';
import { TwitterClient } from '@steipete/bird/dist/lib/twitter-client.js';
import axios from 'axios';
import { Command } from 'commander';
import * as francModule from 'franc-min';
import iso6391 from 'iso-639-1';
import os from 'node:os';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
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
  migrated?: boolean;
  skipped?: boolean;
}

interface ProcessedTweetsMap {
  [twitterId: string]: ProcessedTweetEntry;
}

interface UrlEntity {
  url?: string;
  expanded_url?: string;
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
  is_quote_status?: boolean;
  in_reply_to_status_id_str?: string;
  in_reply_to_status_id?: string;
  in_reply_to_user_id_str?: string;
  in_reply_to_user_id?: string;
}

interface TwitterSearchResult {
  success: boolean;
  tweets?: Tweet[];
  error?: Error | string;
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
  
  const files = fs.readdirSync(PROCESSED_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) return;

  console.log(`📦 Found ${files.length} legacy cache files. Migrating to SQLite...`);
  
  for (const file of files) {
    const username = file.replace('.json', '');
    try {
      const filePath = path.join(PROCESSED_DIR, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ProcessedTweetsMap;
      
      for (const [twitterId, entry] of Object.entries(data)) {
        dbService.saveTweet({
          twitter_id: twitterId,
          twitter_username: username,
          bsky_uri: entry.uri,
          bsky_cid: entry.cid,
          bsky_root_uri: entry.root?.uri,
          bsky_root_cid: entry.root?.cid,
          status: entry.migrated ? 'migrated' : (entry.skipped ? 'skipped' : 'failed')
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
  console.log('✅ Migration complete.');
}

function loadProcessedTweets(twitterUsername: string): ProcessedTweetsMap {
  return dbService.getTweetsByUsername(twitterUsername);
}

function saveProcessedTweet(twitterUsername: string, twitterId: string, entry: ProcessedTweetEntry): void {
  dbService.saveTweet({
    twitter_id: twitterId,
    twitter_username: twitterUsername.toLowerCase(),
    bsky_uri: entry.uri,
    bsky_cid: entry.cid,
    bsky_root_uri: entry.root?.uri,
    bsky_root_cid: entry.root?.cid,
    status: entry.migrated || (entry.uri && entry.cid) ? 'migrated' : (entry.skipped ? 'skipped' : 'failed')
  });
}

// ============================================================================
// Custom Twitter Client
// ============================================================================

interface TwitterLegacyResult {
  legacy?: {
    entities?: TweetEntities;
    extended_entities?: TweetEntities;
    quoted_status_id_str?: string;
    is_quote_status?: boolean;
    in_reply_to_status_id_str?: string;
    in_reply_to_user_id_str?: string;
  };
}

class CustomTwitterClient extends TwitterClient {
  mapTweetResult(result: TwitterLegacyResult): Tweet | null {
    // biome-ignore lint/suspicious/noExplicitAny: parent class is untyped
    const mapped = (super.mapTweetResult as any)(result) as Tweet | null;
    if (mapped && result.legacy) {
      mapped.entities = result.legacy.entities;
      mapped.extended_entities = result.legacy.extended_entities;
      mapped.quoted_status_id_str = result.legacy.quoted_status_id_str;
      mapped.is_quote_status = result.legacy.is_quote_status;
      mapped.in_reply_to_status_id_str = result.legacy.in_reply_to_status_id_str;
      mapped.in_reply_to_user_id_str = result.legacy.in_reply_to_user_id_str;
    }
    return mapped;
  }
}

let twitter: CustomTwitterClient;
let currentTwitterCookies = { authToken: '', ct0: '' };

function getTwitterClient() {
  const config = getConfig();
  if (!config.twitter.authToken || !config.twitter.ct0) return null;
  
  // Re-initialize if config changed or not yet initialized
  if (!twitter || 
      currentTwitterCookies.authToken !== config.twitter.authToken || 
      currentTwitterCookies.ct0 !== config.twitter.ct0) {
    twitter = new CustomTwitterClient({
      cookies: {
        authToken: config.twitter.authToken,
        ct0: config.twitter.ct0,
      },
    });
    currentTwitterCookies = { 
      authToken: config.twitter.authToken, 
      ct0: config.twitter.ct0 
    };
  }
  return twitter;
}

// ============================================================================
// Helper Functions
// ============================================================================

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
      maxRedirects: 10,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    // biome-ignore lint/suspicious/noExplicitAny: axios internal types
    return (response.request as any)?.res?.responseUrl || shortUrl;
  } catch {
    try {
      const response = await axios.get(shortUrl, {
        responseType: 'stream',
        maxRedirects: 10,
      });
      response.data.destroy();
      // biome-ignore lint/suspicious/noExplicitAny: axios internal types
      return (response.request as any)?.res?.responseUrl || shortUrl;
    } catch {
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
  });
  return {
    buffer: Buffer.from(response.data as ArrayBuffer),
    mimeType: (response.headers['content-type'] as string) || 'application/octet-stream',
  };
}

async function uploadToBluesky(agent: BskyAgent, buffer: Buffer, mimeType: string): Promise<BlobRef> {
  let finalBuffer = buffer;
  let finalMimeType = mimeType;
  const MAX_SIZE = 950 * 1024; // 950KB safety margin

  if (buffer.length > MAX_SIZE && (mimeType.startsWith('image/') || mimeType === 'application/octet-stream')) {
    console.log(`[UPLOAD] ⚖️ Image too large (${(buffer.length / 1024).toFixed(2)} KB). Compressing...`);
    try {
      const image = sharp(buffer);
      const metadata = await image.metadata();
      
      let pipeline = image;
      // If it's a very large resolution, downscale it slightly
      if (metadata.width && metadata.width > 2000) {
        pipeline = pipeline.resize(2000, undefined, { withoutEnlargement: true });
      }

      finalBuffer = await pipeline
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      finalMimeType = 'image/jpeg';
      
      console.log(`[UPLOAD] ✅ Compressed to ${(finalBuffer.length / 1024).toFixed(2)} KB`);
      
      // If still too large, aggressive compression
      if (finalBuffer.length > MAX_SIZE) {
        finalBuffer = await sharp(buffer)
          .resize(1200, undefined, { withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer();
        console.log(`[UPLOAD] ⚠️ Required aggressive compression: ${(finalBuffer.length / 1024).toFixed(2)} KB`);
      }
    } catch (err) {
      console.warn(`[UPLOAD] ⚠️ Compression failed, attempting original upload:`, (err as Error).message);
    }
  }

  const { data } = await agent.uploadBlob(finalBuffer, { encoding: finalMimeType });
  return data.blob;
}

async function captureTweetScreenshot(tweetUrl: string): Promise<Buffer | null> {
  const browserPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];

  const executablePath = browserPaths.find(p => fs.existsSync(p));
  
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
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.warn(`[SCREENSHOT] ⚠️ Timeout waiting for tweet iframe, taking screenshot anyway.`);
    }

    const element = await page.$('#container');
    if (element) {
      const buffer = await element.screenshot({ type: 'png', omitBackground: true });
      console.log(`[SCREENSHOT] ✅ Captured successfully (${(buffer.length / 1024).toFixed(2)} KB)`);
      return buffer as Buffer;
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
    const statusUrl = new URL("https://video.bsky.app/xrpc/app.bsky.video.getJobStatus");
    statusUrl.searchParams.append("jobId", jobId);

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
    } else if (state === "JOB_STATE_FAILED") {
      throw new Error(`Video processing failed: ${statusData.jobStatus.error || "Unknown error"}`);
    } else {
      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    if (attempts > 60) {
      // ~5 minute timeout
      throw new Error("Video processing timed out after 5 minutes.");
    }
  }
  return blob!;
}

async function uploadVideoToBluesky(agent: BskyAgent, buffer: Buffer, filename: string): Promise<BlobRef> {
  const sanitizedFilename = filename.split("?")[0] || "video.mp4";
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
      (s: any) => s.id === "#atproto_pds" || s.type === "AtProtoPds",
    );
    const pdsUrl = pdsService?.serviceEndpoint;
    const pdsHost = pdsUrl ? new URL(pdsUrl).host : "bsky.social";

    console.log(`[VIDEO] 🌐 PDS Host detected: ${pdsHost}`);
    console.log(`[VIDEO] 🔑 Requesting service auth token for audience: did:web:${pdsHost}...`);

    const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
      aud: `did:web:${pdsHost}`,
      lxm: "com.atproto.repo.uploadBlob",
      exp: Math.floor(Date.now() / 1000) + 60 * 30,
    });
    console.log(`[VIDEO] ✅ Service auth token obtained.`);

    const token = serviceAuth.token;

    // 2. Upload to Video Service
    const uploadUrl = new URL("https://video.bsky.app/xrpc/app.bsky.video.uploadVideo");
    uploadUrl.searchParams.append("did", agent.session!.did!);
    uploadUrl.searchParams.append("name", sanitizedFilename);

    console.log(`[VIDEO] 📤 Uploading to ${uploadUrl.href}...`);
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "video/mp4",
      },
      body: buffer,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error(`[VIDEO] ❌ Server responded with ${uploadResponse.status}: ${errorText}`);

      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error === "already_exists" && errorJson.jobId) {
          console.log(`[VIDEO] ♻️ Video already exists. Resuming with Job ID: ${errorJson.jobId}`);
          return await pollForVideoProcessing(agent, errorJson.jobId);
        }
      } catch (e) {
        // Not JSON or missing fields, proceed with throwing
      }

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

function getRandomDelay(min = 1000, max = 4000): number {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function splitText(text: string, limit = 300): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to split by paragraph
    let splitIndex = remaining.lastIndexOf('\n\n', limit);
    if (splitIndex === -1) {
      // Try to split by sentence
      splitIndex = remaining.lastIndexOf('. ', limit);
      if (splitIndex === -1) {
        // Try to split by space
        splitIndex = remaining.lastIndexOf(' ', limit);
        if (splitIndex === -1) {
          // Force split
          splitIndex = limit;
        }
      } else {
        splitIndex += 1; // Include the period
      }
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

function refreshQueryIds(): Promise<void> {
  return new Promise((resolve) => {
    console.log("⚠️  Attempting to refresh Twitter Query IDs via 'bird' CLI...");
    exec('./node_modules/.bin/bird query-ids --fresh', (error, _stdout, stderr) => {
      if (error) {
        console.error(`Error refreshing IDs: ${error.message}`);
        console.error(`Stderr: ${stderr}`);
      } else {
        console.log('✅ Query IDs refreshed successfully.');
      }
      resolve();
    });
  });
}

async function safeSearch(query: string, limit: number): Promise<TwitterSearchResult> {
  const client = getTwitterClient();
  if (!client) return { success: false, error: 'Twitter client not configured' };

  try {
    const result = (await client.search(query, limit)) as TwitterSearchResult;
    if (!result.success && result.error) {
      const errorStr = result.error.toString();
      if (errorStr.includes('GraphQL') || errorStr.includes('404')) {
        throw new Error(errorStr);
      }
    }
    return result;
  } catch (err) {
    const error = err as Error;
    console.warn(`Search encountered an error: ${error.message || err}`);
    if (
      error.message &&
      (error.message.includes('GraphQL') || error.message.includes('404') || error.message.includes('Bad Guest Token'))
    ) {
      await refreshQueryIds();
      console.log('Retrying search...');
      return (await client.search(query, limit)) as TwitterSearchResult;
    }
    return { success: false, error };
  }
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
  tweets: Tweet[],
  dryRun = false,
): Promise<void> {
  const processedTweets = loadProcessedTweets(twitterUsername);
  const toProcess = tweets.filter(t => !processedTweets[t.id_str || t.id || '']);
  
  if (toProcess.length === 0) {
    console.log(`[${twitterUsername}] ✅ No new tweets to process.`);
    return;
  }

  console.log(`[${twitterUsername}] 🚀 Processing ${toProcess.length} new tweets...`);
  
  tweets.reverse();
  let count = 0;
  for (const tweet of tweets) {
    count++;
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;

    if (processedTweets[tweetId]) continue;

    console.log(`\n[${twitterUsername}] 🕒 Processing tweet: ${tweetId}`);
    updateAppStatus({
      state: 'processing',
      currentAccount: twitterUsername,
      processedCount: count,
      totalCount: tweets.length,
      message: `Processing tweet ${tweetId}`,
    });

    const replyStatusId = tweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id;
    const replyUserId = tweet.in_reply_to_user_id_str || tweet.in_reply_to_user_id;
    const tweetText = tweet.full_text || tweet.text || '';
    const isReply = !!replyStatusId || !!replyUserId || tweetText.trim().startsWith('@');

    let replyParentInfo: ProcessedTweetEntry | null = null;

    if (isReply) {
      if (replyStatusId && processedTweets[replyStatusId] && !processedTweets[replyStatusId]?.migrated) {
        console.log(`[${twitterUsername}] 🧵 Threading reply to local post: ${replyStatusId}`);
        replyParentInfo = processedTweets[replyStatusId] ?? null;
      } else {
        console.log(`[${twitterUsername}] ⏩ Skipping external/unknown reply.`);
        if (!dryRun) {
          saveProcessedTweet(twitterUsername, tweetId, { skipped: true });
        }
        continue;
      }
    }

    if (dryRun) {
      console.log(`[${twitterUsername}] 🧪 [DRY RUN] Content: ${tweetText.substring(0, 100)}...`);
      continue;
    }

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

    const tcoRegex = /https:\/\/t\.co\/[a-zA-Z0-9]+/g;
    const matches = text.match(tcoRegex) || [];
    for (const tco of matches) {
      const resolved = await expandUrl(tco);
      if (resolved !== tco) text = text.replace(tco, resolved);
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
          console.log(`[${twitterUsername}] 📥 Downloading image: ${url}`);
          updateAppStatus({ message: `Downloading image: ${path.basename(url)}` });
          const { buffer, mimeType } = await downloadMedia(url);
          console.log(`[${twitterUsername}] 📤 Uploading image to Bluesky...`);
          updateAppStatus({ message: `Uploading image to Bluesky...` });
          const blob = await uploadToBluesky(agent, buffer, mimeType);
          images.push({ alt: media.ext_alt_text || 'Image from Twitter', image: blob, aspectRatio });
          console.log(`[${twitterUsername}] ✅ Image uploaded.`);
        } catch (err) {
          console.error(`[${twitterUsername}] ❌ Failed to upload image ${url}:`, (err as Error).message);
        }
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        const variants = media.video_info?.variants || [];
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
              
              if (buffer.length <= 100 * 1024 * 1024) {
                const filename = videoUrl.split('/').pop() || 'video.mp4';
                updateAppStatus({ message: `Uploading video to Bluesky...` });
                videoBlob = await uploadVideoToBluesky(agent, buffer, filename);
                videoAspectRatio = aspectRatio;
                console.log(`[${twitterUsername}] ✅ Video upload process complete.`);
                break; // Prioritize first video
              }
              
              console.warn(`[${twitterUsername}] ⚠️ Video too large (${(buffer.length / 1024 / 1024).toFixed(2)}MB). Fallback to link.`);
              const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
              if (!text.includes(tweetUrl)) text += `\n\nVideo: ${tweetUrl}`;
            } catch (err) {
              console.error(`[${twitterUsername}] ❌ Failed video upload flow:`, (err as Error).message);
              const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
              if (!text.includes(tweetUrl)) text += `\n\nVideo: ${tweetUrl}`;
            }
          }
        }
      }
    }

    // Cleanup text
    for (const link of mediaLinksToRemove) text = text.split(link).join('').trim();
    text = text.replace(/\n\s*\n/g, '\n\n').trim();

    // 3. Quoting Logic
    let quoteEmbed: { $type: string; record: { uri: string; cid: string } } | null = null;
    let externalQuoteUrl: string | null = null;

    if (tweet.is_quote_status && tweet.quoted_status_id_str) {
      const quoteId = tweet.quoted_status_id_str;
      const quoteRef = processedTweets[quoteId];
      if (quoteRef && !quoteRef.migrated && quoteRef.uri && quoteRef.cid) {
        console.log(`[${twitterUsername}] 🔄 Found quoted tweet in local history. Natively embedding.`);
        quoteEmbed = { $type: 'app.bsky.embed.record', record: { uri: quoteRef.uri, cid: quoteRef.cid } };
      } else {
        const quoteUrlEntity = urls.find((u) => u.expanded_url?.includes(quoteId));
        const qUrl = quoteUrlEntity?.expanded_url || `https://twitter.com/i/status/${quoteId}`;
        
        // Check if it's a self-quote (same user)
        const isSelfQuote = qUrl.toLowerCase().includes(`twitter.com/${twitterUsername.toLowerCase()}/`) || 
                           qUrl.toLowerCase().includes(`x.com/${twitterUsername.toLowerCase()}/`);
        
        if (!isSelfQuote) {
          externalQuoteUrl = qUrl;
          console.log(`[${twitterUsername}] 🔗 Quoted tweet is external: ${externalQuoteUrl}`);
          
          // Try to capture screenshot for external QTs if we have space for images
          if (images.length < 4 && !videoBlob) {
            const ssBuffer = await captureTweetScreenshot(externalQuoteUrl);
            if (ssBuffer) {
              try {
                const blob = await uploadToBluesky(agent, ssBuffer, 'image/png');
                images.push({ alt: `Quote Tweet: ${externalQuoteUrl}`, image: blob });
              } catch (e) {
                console.warn(`[${twitterUsername}] ⚠️ Failed to upload screenshot blob.`);
              }
            }
          }
        } else {
          console.log(`[${twitterUsername}] 🔁 Quoted tweet is a self-quote, skipping link.`);
        }
      }
    }

    // Only append link for external quotes IF we couldn't natively embed it OR screenshot it
    const hasScreenshot = images.some(img => img.alt.startsWith('Quote Tweet:'));
    if (externalQuoteUrl && !quoteEmbed && !hasScreenshot && !text.includes(externalQuoteUrl)) {
      text += `\n\nQT: ${externalQuoteUrl}`;
    }

    // 4. Threading and Posting
    const chunks = splitText(text);
    console.log(`[${twitterUsername}] 📝 Splitting text into ${chunks.length} chunks.`);
    
    let lastPostInfo: ProcessedTweetEntry | null = replyParentInfo;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as string;
      console.log(`[${twitterUsername}] 📤 Posting chunk ${i + 1}/${chunks.length}...`);
      updateAppStatus({ message: `Posting chunk ${i + 1}/${chunks.length}...` });
      
      const rt = new RichText({ text: chunk });
      await rt.detectFacets(agent);
      const detectedLangs = detectLanguage(chunk);

      // biome-ignore lint/suspicious/noExplicitAny: dynamic record construction
      const postRecord: Record<string, any> = {
        text: rt.text,
        facets: rt.facets,
        langs: detectedLangs,
        createdAt: tweet.created_at ? new Date(tweet.created_at).toISOString() : new Date().toISOString(),
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
        }
      }

      if (lastPostInfo?.uri && lastPostInfo?.cid) {
        postRecord.reply = {
          root: lastPostInfo.root || { uri: lastPostInfo.uri, cid: lastPostInfo.cid },
          parent: { uri: lastPostInfo.uri, cid: lastPostInfo.cid },
        };
      }

      try {
        const response = await agent.post(postRecord);
        const currentPostInfo = {
          uri: response.uri,
          cid: response.cid,
          root: postRecord.reply ? postRecord.reply.root : { uri: response.uri, cid: response.cid },
        };

        if (i === 0) {
          saveProcessedTweet(twitterUsername, tweetId, currentPostInfo);
        }
        
        lastPostInfo = currentPostInfo;
        console.log(`[${twitterUsername}] ✅ Chunk ${i + 1} posted successfully.`);
        
        if (chunks.length > 1) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err) {
        console.error(`[${twitterUsername}] ❌ Failed to post ${tweetId} (chunk ${i + 1}):`, err);
        break;
      }
    }
    
    const wait = getRandomDelay(2000, 5000);
    console.log(`[${twitterUsername}] 😴 Pacing: Waiting ${wait}ms before next tweet.`);
    updateAppStatus({ state: 'pacing', message: `Pacing: Waiting ${Math.round(wait/1000)}s...` });
    await new Promise((r) => setTimeout(r, wait));
  }
}

const activeAgents = new Map<string, BskyAgent>();

async function getAgent(mapping: {
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
}): Promise<BskyAgent | null> {
  const serviceUrl = mapping.bskyServiceUrl || 'https://bsky.social';
  const cacheKey = `${mapping.bskyIdentifier}-${serviceUrl}`;
  const existing = activeAgents.get(cacheKey);
  if (existing) return existing;

  const agent = new BskyAgent({ service: serviceUrl });
  try {
    await agent.login({ identifier: mapping.bskyIdentifier, password: mapping.bskyPassword });
    activeAgents.set(cacheKey, agent);
    return agent;
  } catch (err) {
    console.error(`Failed to login to Bluesky for ${mapping.bskyIdentifier} on ${serviceUrl}:`, err);
    return null;
  }
}

async function checkAndPost(dryRun = false, forceBackfill = false): Promise<void> {
  const config = getConfig();
  if (config.mappings.length === 0) return;

  updateAppStatus({ state: 'checking', message: 'Starting account check...' });

  const pendingBackfills = getPendingBackfills();

  console.log(`[${new Date().toISOString()}] Checking all accounts...`);

  for (const mapping of config.mappings) {
    if (!mapping.enabled) continue;
    try {
      const agent = await getAgent(mapping);
      if (!agent) continue;

      const backfillReq = getPendingBackfills().find(b => b.id === mapping.id);
      if (forceBackfill || backfillReq) {
        const limit = backfillReq?.limit || 15;
        console.log(`[${mapping.twitterUsername}] Running backfill (limit ${limit})...`);
        updateAppStatus({ state: 'backfilling', currentAccount: mapping.twitterUsername, message: `Starting backfill (limit ${limit})...` });
        await importHistory(mapping.twitterUsername, limit, dryRun);
        clearBackfill(mapping.id);
        console.log(`[${mapping.twitterUsername}] Backfill complete.`);
      } else {
        updateAppStatus({ state: 'checking', currentAccount: mapping.twitterUsername, message: 'Fetching latest tweets...' });
        const result = await safeSearch(`from:${mapping.twitterUsername}`, 30);
        if (!result.success || !result.tweets) continue;
        await processTweets(agent, mapping.twitterUsername, result.tweets, dryRun);
      }
    } catch (err) {
      console.error(`Error processing mapping ${mapping.twitterUsername}:`, err);
    }
  }

  updateAppStatus({ state: 'idle', currentAccount: undefined, message: 'Check complete.' });
  console.log(`[${new Date().toISOString()}] ✅ Check cycle complete. Waiting for next interval...`);
  if (!dryRun) {
    updateLastCheckTime();
  }
}

async function importHistory(twitterUsername: string, limit = 15, dryRun = false): Promise<void> {
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.twitterUsername.toLowerCase() === twitterUsername.toLowerCase());
  if (!mapping) {
    console.error(`No mapping found for twitter username: ${twitterUsername}`);
    return;
  }

  const agent = await getAgent(mapping);
  if (!agent) return;

  console.log(`Starting full history import for ${twitterUsername} -> ${mapping.bskyIdentifier}...`);

  let maxId: string | null = null;
  const batchSize = 100;
  const allFoundTweets: Tweet[] = [];
  const seenIds = new Set<string>();
  const processedTweets = loadProcessedTweets(twitterUsername);

  while (true) {
    // Check if this backfill request was cancelled
    const stillPending = getPendingBackfills().some(b => b.id === mapping.id);
    if (!stillPending) {
      console.log(`[${twitterUsername}] 🛑 Backfill cancelled by user.`);
      return;
    }

    let query = `from:${twitterUsername}`;
    if (maxId) query += ` max_id:${maxId}`;

    console.log(`Fetching batch... (Collected: ${allFoundTweets.length})`);
    updateAppStatus({ message: `Fetching batch... (Collected: ${allFoundTweets.length})` });
    const result = await safeSearch(query, batchSize);

    if (!result.success || !result.tweets || result.tweets.length === 0) break;

    let newOnes = 0;
    for (const t of result.tweets) {
      const tid = t.id_str || t.id;
      if (!tid) continue;
      if (!processedTweets[tid] && !seenIds.has(tid)) {
        allFoundTweets.push(t);
        seenIds.add(tid);
        newOnes++;

        if (limit && allFoundTweets.length >= limit) break;
      }
    }

    if (newOnes === 0 || (limit && allFoundTweets.length >= limit)) break;

    const lastTweet = result.tweets[result.tweets.length - 1];
    maxId = lastTweet?.id_str || lastTweet?.id || null;
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`Fetch complete. Found ${allFoundTweets.length} new tweets to import.`);
  if (allFoundTweets.length > 0) {
    await processTweets(agent, twitterUsername, allFoundTweets, dryRun);
    console.log('History import complete.');
  }
}

import {
  startServer,
  updateLastCheckTime,
  getPendingBackfills,
  clearBackfill,
  getNextCheckTime,
  updateAppStatus,
} from './server.js';

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('tweets-2-bsky')
    .description('Crosspost tweets to Bluesky')
    .option('--dry-run', 'Fetch tweets but do not post to Bluesky', false)
    .option('--no-web', 'Disable the web interface')
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
    if (!options.username) {
      console.error('Please specify a username with --username <username>');
      process.exit(1);
    }
    const client = getTwitterClient();
    if (!client) {
      console.error('Twitter credentials not set. Cannot import history.');
      process.exit(1);
    }
    await importHistory(options.username, options.limit, options.dryRun);
    process.exit(0);
  }

  if (options.dryRun) {
    console.log('Dry run complete. Exiting.');
    process.exit(0);
  }

  console.log(`Scheduler started. Base interval: ${config.checkIntervalMinutes} minutes.`);
  
  // Main loop to handle both scheduled runs and immediate triggers
  while (true) {
    const now = Date.now();
    const nextTime = getNextCheckTime();
    
    if (now >= nextTime) {
      const client = getTwitterClient();
      const pendingBackfills = getPendingBackfills();
      const forceBackfill = pendingBackfills.length > 0;
      
      if (client || forceBackfill) {
        try {
          await checkAndPost(options.dryRun, forceBackfill);
        } catch (err) {
          console.error('Error during scheduled check:', err);
        }
      }
    }
    
    // Sleep for 10 seconds before checking again
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
}

main();
