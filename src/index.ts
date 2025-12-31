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

// ============================================================================
// State Management
// ============================================================================

const PROCESSED_DIR = path.join(__dirname, '..', 'processed');
if (!fs.existsSync(PROCESSED_DIR)) {
  fs.mkdirSync(PROCESSED_DIR);
}

function getProcessedFilePath(twitterUsername: string): string {
  return path.join(PROCESSED_DIR, `${twitterUsername.toLowerCase()}.json`);
}

function loadProcessedTweets(twitterUsername: string): ProcessedTweetsMap {
  const filePath = getProcessedFilePath(twitterUsername);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`Error loading processed tweets for ${twitterUsername}:`, err);
  }
  return {};
}

function saveProcessedTweets(twitterUsername: string, data: ProcessedTweetsMap): void {
  const filePath = getProcessedFilePath(twitterUsername);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error saving processed tweets for ${twitterUsername}:`, err);
  }
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
  const { data } = await agent.uploadBlob(buffer, { encoding: mimeType });
  return data.blob;
}

async function uploadVideoToBluesky(agent: BskyAgent, buffer: Buffer, filename: string): Promise<BlobRef> {
  console.log(`[VIDEO] 🟢 Starting upload process for ${filename} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  
  try {
    // 1. Get Service Auth
    console.log(`[VIDEO] 🔑 Requesting service auth token for video.bsky.app...`);
    const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
        aud: `did:web:video.bsky.app`,
        lxm: "com.atproto.repo.uploadBlob",
        exp: Math.floor(Date.now() / 1000) + 60 * 30,
    });
    console.log(`[VIDEO] ✅ Service auth token obtained.`);

    const token = serviceAuth.token;

    // 2. Upload to Video Service
    const uploadUrl = new URL("https://video.bsky.app/xrpc/app.bsky.video.uploadVideo");
    uploadUrl.searchParams.append("did", agent.session!.did!);
    uploadUrl.searchParams.append("name", filename);

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
        const errText = await uploadResponse.text();
        throw new Error(`Video upload failed: ${uploadResponse.status} ${errText}`);
    }

    const jobStatus = (await uploadResponse.json()) as any;
    console.log(`[VIDEO] 📦 Upload accepted. Job ID: ${jobStatus.jobId}, Initial State: ${jobStatus.state}`);
    
    let blob: BlobRef | undefined = jobStatus.blob;

    // 3. Poll for processing status
    if (!blob) {
        console.log(`[VIDEO] ⏳ Polling for processing completion...`);
        let attempts = 0;
        while (!blob) {
            attempts++;
            const statusUrl = new URL("https://video.bsky.app/xrpc/app.bsky.video.getJobStatus");
            statusUrl.searchParams.append("jobId", jobStatus.jobId);
            
            const statusResponse = await fetch(statusUrl);
            if (!statusResponse.ok) {
                console.warn(`[VIDEO] ⚠️ Job status fetch failed (${statusResponse.status}), retrying...`);
                await new Promise((resolve) => setTimeout(resolve, 3000));
                continue;
            }

            const statusData = await statusResponse.json() as any;
            const state = statusData.jobStatus.state;
            const progress = statusData.jobStatus.progress || 0;
            
            console.log(`[VIDEO] 🔄 Job ${jobStatus.jobId}: ${state} (${progress}%)`);
            
            if (statusData.jobStatus.blob) {
                blob = statusData.jobStatus.blob;
                console.log(`[VIDEO] 🎉 Video processing complete! Blob ref obtained.`);
            } else if (state === 'JOB_STATE_FAILED') {
                throw new Error(`Video processing failed: ${statusData.jobStatus.error || 'Unknown error'}`);
            } else {
                // Wait before next poll
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
            
            if (attempts > 100) { // ~5 minute timeout
                throw new Error("Video processing timed out after 5 minutes.");
            }
        }
    }

    return blob!;
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
  tweets.reverse();

  for (const tweet of tweets) {
    const tweetId = tweet.id_str || tweet.id;
    if (!tweetId) continue;

    if (processedTweets[tweetId]) continue;

    console.log(`\n[${twitterUsername}] 🕒 Processing tweet: ${tweetId}`);

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
          processedTweets[tweetId] = { skipped: true };
          saveProcessedTweets(twitterUsername, processedTweets);
        }
        continue;
      }
    }

    if (dryRun) {
      console.log(`[${twitterUsername}] 🧪 [DRY RUN] Content: ${tweetText.substring(0, 100)}...`);
      continue;
    }

    let text = tweetText;
    
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
          const { buffer, mimeType } = await downloadMedia(url);
          console.log(`[${twitterUsername}] 📤 Uploading image to Bluesky...`);
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
              const { buffer, mimeType } = await downloadMedia(videoUrl);
              
              if (buffer.length <= 100 * 1024 * 1024) {
                const filename = videoUrl.split('/').pop() || 'video.mp4';
                videoBlob = await uploadVideoToBluesky(agent, buffer, filename);
                videoAspectRatio = aspectRatio;
                console.log(`[${twitterUsername}] ✅ Video upload process complete.`);
                break; // Prioritize first video
              }
              
              console.warn(`[${twitterUsername}] ⚠️ Video too large (${(buffer.length / 1024 / 1024).toFixed(2)}MB). Fallback to link.`);
              const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
              if (!text.includes(tweetUrl)) text += `\n\nOriginal Tweet: ${tweetUrl}`;
            } catch (err) {
              console.error(`[${twitterUsername}] ❌ Failed video upload flow:`, (err as Error).message);
              const tweetUrl = `https://twitter.com/${twitterUsername}/status/${tweetId}`;
              if (!text.includes(tweetUrl)) text += `\n\nOriginal Tweet: ${tweetUrl}`;
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
        console.log(`[${twitterUsername}] 🔄 Found quoted tweet in local history.`);
        quoteEmbed = { $type: 'app.bsky.embed.record', record: { uri: quoteRef.uri, cid: quoteRef.cid } };
      } else {
        const quoteUrlEntity = urls.find((u) => u.expanded_url?.includes(quoteId));
        externalQuoteUrl = quoteUrlEntity?.expanded_url || `https://twitter.com/i/status/${quoteId}`;
        console.log(`[${twitterUsername}] 🔗 Quoted tweet is external: ${externalQuoteUrl}`);
      }
    }

    if (externalQuoteUrl && !text.includes(externalQuoteUrl)) {
      text += `\n\nQT: ${externalQuoteUrl}`;
    }

    // 4. Threading and Posting
    const chunks = splitText(text);
    console.log(`[${twitterUsername}] 📝 Splitting text into ${chunks.length} chunks.`);
    
    let lastPostInfo: ProcessedTweetEntry | null = replyParentInfo;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i] as string;
      console.log(`[${twitterUsername}] 📤 Posting chunk ${i + 1}/${chunks.length}...`);
      
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
          processedTweets[tweetId] = currentPostInfo;
          saveProcessedTweets(twitterUsername, processedTweets);
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

  const pendingBackfills = getPendingBackfills();

  console.log(`[${new Date().toISOString()}] Checking all accounts...`);

  for (const mapping of config.mappings) {
    if (!mapping.enabled) continue;
    try {
      const agent = await getAgent(mapping);
      if (!agent) continue;

      const backfillReq = pendingBackfills.find(b => b.id === mapping.id);
      if (forceBackfill || backfillReq) {
        const limit = backfillReq?.limit || 100;
        console.log(`[${mapping.twitterUsername}] Running backfill (limit ${limit})...`);
        await importHistory(mapping.twitterUsername, limit, dryRun);
        clearBackfill(mapping.id);
        console.log(`[${mapping.twitterUsername}] Backfill complete.`);
      } else {
        const result = await safeSearch(`from:${mapping.twitterUsername}`, 30);
        if (!result.success || !result.tweets) continue;
        await processTweets(agent, mapping.twitterUsername, result.tweets, dryRun);
      }
    } catch (err) {
      console.error(`Error processing mapping ${mapping.twitterUsername}:`, err);
    }
  }

  if (!dryRun) {
    updateLastCheckTime();
  }
}

async function importHistory(twitterUsername: string, limit = 100, dryRun = false): Promise<void> {
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
    let query = `from:${twitterUsername}`;
    if (maxId) query += ` max_id:${maxId}`;

    console.log(`Fetching batch... (Collected: ${allFoundTweets.length})`);
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

import { startServer, updateLastCheckTime, getPendingBackfills, clearBackfill, getNextCheckTime } from './server.js';

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
