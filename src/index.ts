import 'dotenv/config';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BskyAgent, RichText } from '@atproto/api';
import type { BlobRef } from '@atproto/api';
import { TwitterClient } from '@steipete/bird/dist/lib/twitter-client.js';
import axios from 'axios';
import * as francModule from 'franc-min';
import iso6391 from 'iso-639-1';
import cron from 'node-cron';

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

interface TwitterUserResult {
    success: boolean;
    user?: { username: string };
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

// PostRecord is built dynamically for agent.post()

// ============================================================================
// Configuration
// ============================================================================

const TWITTER_AUTH_TOKEN = process.env.TWITTER_AUTH_TOKEN;
const TWITTER_CT0 = process.env.TWITTER_CT0;
const TWITTER_TARGET_USERNAME = process.env.TWITTER_TARGET_USERNAME;
const BLUESKY_IDENTIFIER = process.env.BLUESKY_IDENTIFIER;
const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD;
const BLUESKY_SERVICE_URL = process.env.BLUESKY_SERVICE_URL || 'https://bsky.social';
const CHECK_INTERVAL_MINUTES = Number(process.env.CHECK_INTERVAL_MINUTES) || 5;
const PROCESSED_TWEETS_FILE = path.join(__dirname, '..', 'processed_tweets.json');

// ============================================================================
// State Management
// ============================================================================

let processedTweets: ProcessedTweetsMap = {};

function loadProcessedTweets(): void {
    try {
        if (fs.existsSync(PROCESSED_TWEETS_FILE)) {
            const raw: unknown = JSON.parse(fs.readFileSync(PROCESSED_TWEETS_FILE, 'utf8'));
            if (Array.isArray(raw)) {
                // Migration from v1 (Array of IDs) to v2 (Object map)
                console.log('Migrating processed_tweets.json from v1 to v2...');
                processedTweets = (raw as string[]).reduce<ProcessedTweetsMap>((acc, id) => {
                    acc[id] = { migrated: true };
                    return acc;
                }, {});
                saveProcessedTweets();
            } else if (typeof raw === 'object' && raw !== null) {
                processedTweets = raw as ProcessedTweetsMap;
            }
        }
    } catch (err) {
        console.error('Error loading processed tweets:', err);
    }
}

function saveProcessedTweets(): void {
    try {
        fs.writeFileSync(PROCESSED_TWEETS_FILE, JSON.stringify(processedTweets, null, 2));
    } catch (err) {
        console.error('Error saving processed tweets:', err);
    }
}

loadProcessedTweets();

// ============================================================================
// Bluesky Agent
// ============================================================================

const agent = new BskyAgent({
    service: BLUESKY_SERVICE_URL,
});

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

const twitter = new CustomTwitterClient({
    cookies: {
        authToken: TWITTER_AUTH_TOKEN ?? '',
        ct0: TWITTER_CT0 ?? '',
    },
});

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

async function uploadToBluesky(buffer: Buffer, mimeType: string): Promise<BlobRef> {
    const { data } = await agent.uploadBlob(buffer, { encoding: mimeType });
    return data.blob;
}

async function getUsername(): Promise<string> {
    if (TWITTER_TARGET_USERNAME) return TWITTER_TARGET_USERNAME;
    try {
        const res = (await twitter.getCurrentUser()) as TwitterUserResult;
        if (res.success && res.user) {
            return res.user.username;
        }
    } catch (e) {
        console.warn("Failed to get 'whoami'. defaulting to 'me'.", (e as Error).message);
    }
    return 'me';
}

function getRandomDelay(min = 1000, max = 4000): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
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

/**
 * Wraps twitter.search with auto-recovery for stale Query IDs
 */
async function safeSearch(query: string, limit: number): Promise<TwitterSearchResult> {
    try {
        const result = (await twitter.search(query, limit)) as TwitterSearchResult;
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
            return (await twitter.search(query, limit)) as TwitterSearchResult;
        }
        return { success: false, error };
    }
}

// ============================================================================
// Main Processing Logic
// ============================================================================

async function processTweets(tweets: Tweet[]): Promise<void> {
    // Ensure chronological order
    tweets.reverse();

    for (const tweet of tweets) {
        const tweetId = tweet.id_str || tweet.id;
        if (!tweetId) continue;

        if (processedTweets[tweetId]) {
            continue;
        }

        // --- Filter Replies (unless we are maintaining a thread) ---
        const replyStatusId = tweet.in_reply_to_status_id_str || tweet.in_reply_to_status_id;
        const replyUserId = tweet.in_reply_to_user_id_str || tweet.in_reply_to_user_id;
        const tweetText = tweet.full_text || tweet.text || '';
        const isReply = !!replyStatusId || !!replyUserId || tweetText.trim().startsWith('@');

        let replyParentInfo: ProcessedTweetEntry | null = null;

        if (isReply) {
            if (replyStatusId && processedTweets[replyStatusId] && !processedTweets[replyStatusId]?.migrated) {
                console.log(`Threading reply to ${replyStatusId}`);
                replyParentInfo = processedTweets[replyStatusId] ?? null;
            } else {
                console.log(`Skipping reply: ${tweetId}`);
                processedTweets[tweetId] = { skipped: true };
                saveProcessedTweets();
                continue;
            }
        }

        console.log(`Processing tweet: ${tweetId}`);

        let text = tweetText;

        // --- 1. Link Expansion ---
        const urls = tweet.entities?.urls || [];
        for (const urlEntity of urls) {
            const tco = urlEntity.url;
            const expanded = urlEntity.expanded_url;
            if (tco && expanded) {
                text = text.replace(tco, expanded);
            }
        }

        // Manual cleanup of remaining t.co
        const tcoRegex = /https:\/\/t\.co\/[a-zA-Z0-9]+/g;
        const matches = text.match(tcoRegex) || [];
        for (const tco of matches) {
            const resolved = await expandUrl(tco);
            if (resolved !== tco) {
                text = text.replace(tco, resolved);
            }
        }

        // --- 2. Media Handling ---
        const images: ImageEmbed[] = [];
        let videoBlob: BlobRef | null = null;
        let videoAspectRatio: AspectRatio | undefined;

        const mediaEntities = tweet.extended_entities?.media || tweet.entities?.media || [];
        const mediaLinksToRemove: string[] = [];

        for (const media of mediaEntities) {
            if (media.url) {
                mediaLinksToRemove.push(media.url);
                if (media.expanded_url) mediaLinksToRemove.push(media.expanded_url);
            }

            // Aspect Ratio Extraction
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
                    const { buffer, mimeType } = await downloadMedia(url);
                    const blob = await uploadToBluesky(buffer, mimeType);
                    images.push({
                        alt: media.ext_alt_text || 'Image from Twitter',
                        image: blob,
                        aspectRatio,
                    });
                } catch (err) {
                    console.error(`Failed to upload image ${url}:`, (err as Error).message);
                }
            } else if (media.type === 'video' || media.type === 'animated_gif') {
                const variants = media.video_info?.variants || [];
                const mp4s = variants
                    .filter((v) => v.content_type === 'video/mp4')
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

                if (mp4s.length > 0 && mp4s[0]) {
                    const videoUrl = mp4s[0].url;
                    try {
                        const { buffer, mimeType } = await downloadMedia(videoUrl);

                        if (buffer.length > 95 * 1024 * 1024) {
                            console.warn('Video too large (>95MB). Linking instead.');
                            text += `\n[Video: ${media.media_url_https}]`;
                            continue;
                        }

                        const blob = await uploadToBluesky(buffer, mimeType);
                        videoBlob = blob;
                        videoAspectRatio = aspectRatio;
                        break;
                    } catch (err) {
                        console.error(`Failed to upload video ${videoUrl}:`, (err as Error).message);
                        text += `\n${media.media_url_https}`;
                    }
                }
            }
        }

        // Remove media links from text
        for (const link of mediaLinksToRemove) {
            text = text.split(link).join('').trim();
        }
        text = text.replace(/\n\s*\n/g, '\n\n').trim();

        // --- 3. Quoting Logic ---
        let quoteEmbed: { $type: string; record: { uri: string; cid: string } } | null = null;
        if (tweet.is_quote_status && tweet.quoted_status_id_str) {
            const quoteId = tweet.quoted_status_id_str;
            const quoteRef = processedTweets[quoteId];
            if (quoteRef && !quoteRef.migrated && quoteRef.uri && quoteRef.cid) {
                quoteEmbed = {
                    $type: 'app.bsky.embed.record',
                    record: {
                        uri: quoteRef.uri,
                        cid: quoteRef.cid,
                    },
                };
            }
        }

        // --- 4. Construct Post ---
        const rt = new RichText({ text });
        await rt.detectFacets(agent);
        const detectedLangs = detectLanguage(text);

        // biome-ignore lint/suspicious/noExplicitAny: dynamic record construction
        const postRecord: Record<string, any> = {
            text: rt.text,
            facets: rt.facets,
            langs: detectedLangs,
            createdAt: tweet.created_at ? new Date(tweet.created_at).toISOString() : new Date().toISOString(),
        };

        // Attach Embeds
        if (videoBlob) {
            postRecord.embed = {
                $type: 'app.bsky.embed.video',
                video: videoBlob,
                aspectRatio: videoAspectRatio,
            };
        } else if (images.length > 0) {
            const imagesEmbed = {
                $type: 'app.bsky.embed.images',
                images,
            };

            if (quoteEmbed) {
                postRecord.embed = {
                    $type: 'app.bsky.embed.recordWithMedia',
                    media: imagesEmbed,
                    record: quoteEmbed,
                };
            } else {
                postRecord.embed = imagesEmbed;
            }
        } else if (quoteEmbed) {
            postRecord.embed = quoteEmbed;
        }

        // Attach Reply info
        if (replyParentInfo?.uri && replyParentInfo?.cid) {
            postRecord.reply = {
                root: replyParentInfo.root || { uri: replyParentInfo.uri, cid: replyParentInfo.cid },
                parent: { uri: replyParentInfo.uri, cid: replyParentInfo.cid },
            };
        }

        // --- 5. Post & Save ---
        try {
            const response = await agent.post(postRecord);

            const newEntry: ProcessedTweetEntry = {
                uri: response.uri,
                cid: response.cid,
                root: postRecord.reply ? postRecord.reply.root : { uri: response.uri, cid: response.cid },
            };

            processedTweets[tweetId] = newEntry;
            saveProcessedTweets();

            // Random Pacing (1s - 4s)
            const sleepTime = getRandomDelay(1000, 4000);
            await new Promise((r) => setTimeout(r, sleepTime));
        } catch (err) {
            console.error(`Failed to post ${tweetId}:`, err);
        }
    }
}

async function checkAndPost(): Promise<void> {
    console.log(`[${new Date().toISOString()}] Checking...`);

    try {
        const username = await getUsername();

        const query = `from:${username}`;
        const result = await safeSearch(query, 30);

        if (!result.success) {
            console.error('Failed to fetch tweets:', result.error);
            return;
        }

        const tweets = result.tweets || [];
        if (tweets.length === 0) return;

        await processTweets(tweets);
    } catch (err) {
        console.error('Error in checkAndPost:', err);
    }
}

async function importHistory(): Promise<void> {
    console.log('Starting full history import...');
    const username = await getUsername();
    console.log(`Importing history for: ${username}`);

    let maxId: string | null = null;
    const keepGoing = true;
    const count = 100;
    const allFoundTweets: Tweet[] = [];
    const seenIds = new Set<string>();

    while (keepGoing) {
        let query = `from:${username}`;
        if (maxId) {
            query += ` max_id:${maxId}`;
        }

        console.log(`Fetching batch... (Collected: ${allFoundTweets.length})`);

        const result = await safeSearch(query, count);

        if (!result.success) {
            console.error('Fetch failed:', result.error);
            break;
        }

        const tweets = result.tweets || [];
        if (tweets.length === 0) break;

        let newOnes = 0;
        for (const t of tweets) {
            const tid = t.id_str || t.id;
            if (!tid) continue;
            if (!processedTweets[tid] && !seenIds.has(tid)) {
                allFoundTweets.push(t);
                seenIds.add(tid);
                newOnes++;
            }
        }

        if (newOnes === 0 && tweets.length > 0) {
            const lastTweet = tweets[tweets.length - 1];
            const lastId = lastTweet?.id_str || lastTweet?.id;
            if (lastId === maxId) break;
        }

        const lastTweet = tweets[tweets.length - 1];
        maxId = lastTweet?.id_str || lastTweet?.id || null;

        // Rate limit protection
        await new Promise((r) => setTimeout(r, 2000));
    }

    console.log(`Fetch complete. Found ${allFoundTweets.length} new tweets to import.`);

    if (allFoundTweets.length > 0) {
        console.log('Starting processing (Oldest -> Newest) with random pacing...');
        await processTweets(allFoundTweets);
        console.log('History import complete.');
    } else {
        console.log('Nothing new to import.');
    }
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
    if (!TWITTER_AUTH_TOKEN || !TWITTER_CT0 || !BLUESKY_IDENTIFIER || !BLUESKY_PASSWORD) {
        console.error('Missing credentials in .env file.');
        process.exit(1);
    }

    try {
        await agent.login({ identifier: BLUESKY_IDENTIFIER, password: BLUESKY_PASSWORD });
        console.log('Logged in to Bluesky.');
    } catch (err) {
        console.error('Failed to login to Bluesky:', err);
        process.exit(1);
    }

    if (process.argv.includes('--import-history')) {
        await importHistory();
        process.exit(0);
    }

    await checkAndPost();

    console.log(`Scheduling check every ${CHECK_INTERVAL_MINUTES} minutes.`);
    cron.schedule(`*/${CHECK_INTERVAL_MINUTES} * * * *`, () => {
        checkAndPost();
    });
}

main();
