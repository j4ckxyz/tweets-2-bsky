#!/usr/bin/env bun
// Offline end-to-end checks for the composer: real processTweets, a mock
// Bluesky agent that records every record it is asked to write, and stubbed
// HTTP. Nothing here touches Twitter or Bluesky, and the database is a
// throwaway directory.
//
//   bun scripts/test-compose.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets2bsky-compose-'));
process.env.TWEETS2BSKY_DATA_DIR = scratchDir;
process.env.TWEETS2BSKY_NO_AUTOSTART = '1';
process.env.EVENT_LOG_FLUSH_MS = '0';
// The speed check re-runs this file with real pacing to prove dry runs skip it.
const PREVIEW_SPEED_MODE = process.env.T2B_COMPOSE_MODE === 'preview-speed';
process.env.POST_PACING_MIN_MS = PREVIEW_SPEED_MODE ? '2000' : '0';
process.env.POST_PACING_MAX_MS = PREVIEW_SPEED_MODE ? '2000' : '0';
process.env.THREAD_CHUNK_GAP_MS = PREVIEW_SPEED_MODE ? '2000' : '0';
// Keep the whole run silent apart from results.
const realLog = console.log;
console.log = () => undefined;
console.warn = () => undefined;
console.debug = () => undefined;
console.info = () => undefined;
const realError = console.error;
// The event log mirrors pipeline errors to stderr; the tests provoke some on purpose.
console.error = (...args: unknown[]) => {
  if (process.env.T2B_TEST_VERBOSE) realError(...args);
};

const axios = (await import('axios')).default;
const sharp = (await import('sharp')).default;

// --- HTTP stubs -------------------------------------------------------------
// Tiny real images so the upload path (sharp included) runs for real.
const smallJpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
  .jpeg()
  .toBuffer();
const pageHtml = (title: string) =>
  `<html><head><meta property="og:title" content="${title}"><meta property="og:description" content="desc"></head></html>`;
const httpLog: string[] = [];
// biome-ignore lint/suspicious/noExplicitAny: stubbing axios for offline tests
(axios as any).get = async (url: string) => {
  httpLog.push(`GET ${url}`);
  if (url.includes('cdn.syndication.twimg.com')) return { data: {} };
  if (url.includes('netflix.com')) return { data: pageHtml('Netflix title'), headers: {} };
  if (url.includes('example.org')) return { data: pageHtml('Example title'), headers: {} };
  throw Object.assign(new Error(`unexpected GET ${url}`), { code: 'ENOTFOUND' });
};
// biome-ignore lint/suspicious/noExplicitAny: stubbing axios for offline tests
(axios as any).head = async (url: string) => {
  throw Object.assign(new Error(`unexpected HEAD ${url}`), { code: 'ENOTFOUND' });
};
// biome-ignore lint/suspicious/noExplicitAny: stubbing axios for offline tests
(axios as any).request = async (config: { url: string }) => {
  httpLog.push(`DOWNLOAD ${config.url}`);
  if (config.url.includes('.mp4')) {
    return { data: Buffer.from('fake-mp4-bytes'), headers: { 'content-type': 'video/mp4' } };
  }
  return { data: smallJpeg, headers: { 'content-type': 'image/jpeg' } };
};
// The video service is plain fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  if (url.includes('video.bsky.app/xrpc/app.bsky.video.uploadVideo')) {
    return new Response(
      JSON.stringify({
        jobId: 'job-1',
        state: 'JOB_STATE_COMPLETED',
        blob: { $type: 'blob', ref: { $link: 'bafyvideo' }, mimeType: 'video/mp4', size: 10 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return realFetch(input as string);
}) as typeof fetch;

// --- Modules under test -----------------------------------------------------
const { saveConfig, getConfig } = await import('../src/config-manager.js');
const { dbService, postQueueService } = await import('../src/db.js');
const index = await import('../src/index.js');
const { processTweets, resolveMirrorSettings, enqueueTweetsForMapping, uploadToBluesky, reconcilePostedButUnrecorded } =
  index;
const { getAppStatus } = await import('../src/server.js');
type Tweet = import('../src/index.js').Tweet;
type TweetOutcome = import('../src/index.js').TweetOutcome;

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    realLog(`  ✓ ${message}`);
    passed++;
  } else {
    realLog(`  ✗ ${message}`);
    failed++;
  }
}

// --- Instance: two mirrored accounts ------------------------------------------
const baseMapping = {
  bskyPassword: 'app-password',
  bskyServiceUrl: 'https://bsky.social',
  enabled: true,
};
saveConfig({
  ...getConfig(),
  mappings: [
    {
      ...baseMapping,
      id: 'map-alice',
      twitterUsernames: ['alice'],
      bskyIdentifier: 'alice.test',
      bskyDid: 'did:plc:alice',
    },
    { ...baseMapping, id: 'map-bob', twitterUsernames: ['bob'], bskyIdentifier: 'bob.test', bskyDid: 'did:plc:bob' },
  ],
});

// --- Mock Bluesky agent -------------------------------------------------------
interface Captured {
  // biome-ignore lint/suspicious/noExplicitAny: records are free-form
  posts: any[];
  reposts: { uri: string; cid: string }[];
  deleted: string[];
  uploads: { buffer: Buffer; encoding?: string }[];
}
function mockAgent(did: string) {
  const captured: Captured = { posts: [], reposts: [], deleted: [], uploads: [] };
  let n = 0;
  const agent = {
    session: { did },
    // biome-ignore lint/suspicious/noExplicitAny: records are free-form
    post: async (record: any) => {
      captured.posts.push(record);
      n++;
      return { uri: `at://${did}/app.bsky.feed.post/p${n}`, cid: `cid-${did}-${n}` };
    },
    repost: async (uri: string, cid: string) => {
      captured.reposts.push({ uri, cid });
      n++;
      return { uri: `at://${did}/app.bsky.feed.repost/r${n}`, cid: `rcid-${n}` };
    },
    deletePost: async (uri: string) => {
      captured.deleted.push(uri);
    },
    uploadBlob: async (buffer: Buffer, options?: { encoding?: string }) => {
      captured.uploads.push({ buffer, encoding: options?.encoding });
      return {
        data: {
          blob: {
            $type: 'blob',
            ref: { $link: `bafy${captured.uploads.length}` },
            mimeType: options?.encoding,
            size: buffer.length,
          },
        },
      };
    },
    com: {
      atproto: {
        identity: {
          resolveHandle: async () => {
            throw new Error('not resolvable offline');
          },
        },
        repo: {
          describeRepo: async () => ({
            data: { didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example' }] } },
          }),
        },
        server: { getServiceAuth: async () => ({ data: { token: 'service-token' } }) },
      },
    },
  };
  return { agent, captured };
}

let nextId = 1_800_000_000_000_000_000n;
const newId = () => String(nextId++);
function tweet(overrides: Partial<Tweet> & { text?: string; user?: string }): Tweet {
  const id = overrides.id_str ?? newId();
  const { user, ...rest } = overrides;
  return {
    id,
    id_str: id,
    full_text: overrides.text ?? 'hello world',
    text: overrides.text ?? 'hello world',
    created_at: new Date(Date.now() - 60_000).toUTCString(),
    lang: 'en',
    entities: { urls: [] },
    user: { screen_name: user ?? 'alice', id_str: user === 'bob' ? '2' : '1' },
    ...rest,
  } as Tweet;
}

async function run(
  tweets: Tweet[],
  options: {
    user?: string;
    identifier?: string;
    settings?: Partial<ReturnType<typeof resolveMirrorSettings>>;
    live?: boolean;
    dryRun?: boolean;
    signal?: AbortSignal;
    quiet?: boolean;
  } = {},
) {
  const user = options.user ?? 'alice';
  const identifier = options.identifier ?? 'alice.test';
  const { agent, captured } = mockAgent(user === 'bob' ? 'did:plc:bob' : 'did:plc:alice');
  const outcomes = new Map<string, TweetOutcome>();
  await processTweets(
    // biome-ignore lint/suspicious/noExplicitAny: mock agent
    agent as any,
    user,
    identifier,
    // processTweets takes timeline order (newest first)
    [...tweets].reverse(),
    options.dryRun ?? false,
    undefined,
    undefined,
    'test',
    {
      outcomes,
      signal: options.signal,
      quiet: options.quiet,
      isLive: () => options.live ?? false,
      settings: { ...resolveMirrorSettings(), ...options.settings },
    },
  );
  return { captured, outcomes };
}

// Seed a mirrored post for an account, as if an earlier run had posted it.
function seedMirrored(twitterId: string, username: string, identifier: string, did: string, rkey: string) {
  dbService.saveTweet({
    twitter_id: twitterId,
    twitter_username: username,
    bsky_identifier: identifier,
    bsky_uri: `at://${did}/app.bsky.feed.post/${rkey}`,
    bsky_cid: `cid-${rkey}`,
    bsky_root_uri: `at://${did}/app.bsky.feed.post/${rkey}`,
    bsky_root_cid: `cid-${rkey}`,
    bsky_tail_uri: `at://${did}/app.bsky.feed.post/${rkey}`,
    bsky_tail_cid: `cid-${rkey}`,
    status: 'migrated',
  });
}

if (PREVIEW_SPEED_MODE) {
  const statusBefore = getAppStatus().lastUpdate;
  const started = Date.now();
  await run(
    [tweet({ text: 'one' }), tweet({ text: 'two' }), tweet({ text: `three ${'long sentence here. '.repeat(30)}` })],
    { dryRun: true, quiet: true },
  );
  const elapsed = Date.now() - started;
  assert(elapsed < 1500, `A 3-tweet dry run with 2s pacing and 2s chunk gaps finishes in ${elapsed}ms (no sleeps)`);
  assert(getAppStatus().lastUpdate === statusBefore, 'A quiet (preview) run leaves the global dashboard status alone');
  realLog(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

realLog('Languages\n');
{
  const { captured } = await run([
    tweet({ text: '今日はいい天気ですね', lang: 'ja' }),
    tweet({ text: '🔥🔥', lang: 'und' }),
    tweet({ text: 'Selamat pagi semuanya, apa kabar hari ini?', lang: 'in' }),
    tweet({ text: 'Bonjour à tous, nous sommes ravis de vous annoncer la sortie de notre produit', lang: undefined }),
  ]);
  assert(JSON.stringify(captured.posts[0]?.langs) === '["ja"]', "Twitter's own lang is used (ja)");
  assert(captured.posts[1]?.langs === undefined, 'An undetermined tweet carries no langs rather than a wrong "en"');
  assert(JSON.stringify(captured.posts[2]?.langs) === '["id"]', "Twitter's legacy 'in' becomes BCP-47 'id'");
  assert(JSON.stringify(captured.posts[3]?.langs) === '["fr"]', 'Without a Twitter verdict the text is detected (fr)');
}

realLog('\nLink cards\n');
{
  const netflix = tweet({
    text: 'New season https://t.co/aaa',
    entities: { urls: [{ url: 'https://t.co/aaa', expanded_url: 'https://www.netflix.com/title/123' }] },
  });
  const onX = tweet({
    text: 'See https://t.co/bbb',
    entities: { urls: [{ url: 'https://t.co/bbb', expanded_url: 'https://x.com/someone' }] },
  });
  const { captured } = await run([netflix, onX]);
  assert(
    captured.posts[0]?.embed?.external?.uri === 'https://www.netflix.com/title/123',
    'netflix.com gets a link card (it contains "x.com" as a substring)',
  );
  assert(captured.posts[1]?.embed === undefined, 'A link to X itself does not become a card');
}

realLog('\nReplies\n');
{
  // Parent recorded as skipped (a reply to someone else).
  const parentId = newId();
  dbService.saveTweet({
    twitter_id: parentId,
    twitter_username: 'alice',
    bsky_identifier: 'alice.test',
    status: 'skipped',
  });
  const child = tweet({ text: 'and another thing', in_reply_to_status_id_str: parentId, in_reply_to_user_id_str: '1' });
  const { captured, outcomes } = await run([child]);
  assert(captured.posts.length === 0, 'A self-reply under a skipped parent is not posted as a standalone post');
  assert(outcomes.get(child.id_str as string)?.status === 'skipped', '…and is recorded as skipped');

  // Reply to a tweet another mirror on this instance already posted.
  const bobTweet = newId();
  seedMirrored(bobTweet, 'bob', 'bob.test', 'did:plc:bob', 'bobpost');
  const reply = tweet({ text: 'great point', in_reply_to_status_id_str: bobTweet, in_reply_to_user_id_str: '2' });
  const second = await run([reply]);
  assert(
    second.captured.posts[0]?.reply?.parent?.uri === 'at://did:plc:bob/app.bsky.feed.post/bobpost',
    "A reply to another mirrored account becomes a native reply to that account's post",
  );
  const third = await run([tweet({ text: 'nope', in_reply_to_status_id_str: newId() })], {
    settings: { mirrorRepliesToMirrors: false },
  });
  assert(third.captured.posts.length === 0, 'Cross-mirror replies can be switched off per mapping');

  // Parent still in the queue: wait for it rather than post out of order.
  const queuedParent = newId();
  postQueueService.enqueue([
    {
      twitter_id: queuedParent,
      bsky_identifier: 'bob.test',
      mapping_id: 'map-bob',
      twitter_username: 'bob',
      kind: 'scheduled',
      tweet_json: '{}',
    },
  ]);
  const waiting = tweet({ text: 'replying', in_reply_to_status_id_str: queuedParent, in_reply_to_user_id_str: '2' });
  const fourth = await run([waiting]);
  assert(fourth.captured.posts.length === 0, 'A reply whose parent is still queued is not posted yet');
  assert(fourth.outcomes.get(waiting.id_str as string)?.status === 'deferred', '…it is deferred for a retry');

  // A standalone tweet that merely starts with a mention.
  const mentionStart = tweet({ text: '@nasa just launched something big' });
  const fifth = await run([mentionStart]);
  assert(fifth.captured.posts.length === 1, 'A tweet starting with "@" but not a reply is mirrored');
}

realLog('\nRetweets\n');
{
  const original = newId();
  seedMirrored(original, 'bob', 'bob.test', 'did:plc:bob', 'orig');
  const rt = tweet({ text: 'RT @bob: original text', isRetweet: true, retweeted_status_id_str: original });
  const { captured, outcomes } = await run([rt]);
  assert(
    captured.reposts[0]?.uri === 'at://did:plc:bob/app.bsky.feed.post/orig',
    'A retweet of a mirrored tweet becomes a native repost',
  );
  assert(captured.posts.length === 0, '…without posting a copy');
  assert(
    dbService.getTweet(rt.id_str as string, 'alice.test')?.status === 'reposted',
    "…and is recorded as 'reposted'",
  );
  assert(outcomes.get(rt.id_str as string)?.status === 'posted', '…with a posted outcome');

  const stranger = tweet({ text: 'RT @stranger: hi', isRetweet: true, retweeted_status_id_str: newId() });
  const second = await run([stranger]);
  assert(
    second.captured.reposts.length === 0 && second.captured.posts.length === 0,
    'A retweet of an unmirrored tweet is skipped',
  );

  const off = tweet({ text: 'RT @bob: x', isRetweet: true, retweeted_status_id_str: original });
  const third = await run([off], { settings: { mirrorRetweets: false } });
  assert(third.captured.reposts.length === 0, 'Reposting retweets can be switched off per mapping');
}

realLog('\nMentions and tweet links\n');
{
  const { captured } = await run([tweet({ text: 'thanks @bob and @stranger!' })]);
  const features = (captured.posts[0]?.facets ?? []).flatMap((facet: { features: unknown[] }) => facet.features);
  assert(
    features.some(
      (f: { $type: string; did?: string }) => f.$type === 'app.bsky.richtext.facet#mention' && f.did === 'did:plc:bob',
    ),
    '@bob (mirrored here) becomes a real Bluesky mention',
  );
  assert(
    features.some(
      (f: { $type: string; uri?: string }) =>
        f.$type === 'app.bsky.richtext.facet#link' && f.uri === 'https://x.com/stranger',
    ),
    '@stranger links to their X profile',
  );

  const linked = newId();
  seedMirrored(linked, 'bob', 'bob.test', 'did:plc:bob', 'linked');
  const onlyLink = tweet({
    text: 'look at this https://t.co/ccc',
    entities: { urls: [{ url: 'https://t.co/ccc', expanded_url: `https://x.com/bob/status/${linked}` }] },
  });
  const second = await run([onlyLink]);
  assert(
    second.captured.posts[0]?.embed?.$type === 'app.bsky.embed.record' &&
      second.captured.posts[0]?.embed?.record?.uri === 'at://did:plc:bob/app.bsky.feed.post/linked',
    'A lone link to a mirrored tweet becomes a native quote',
  );
  assert(!second.captured.posts[0]?.text.includes('x.com'), '…and the X link is removed from the text');

  const unresolvable = tweet({ text: 'contact @nytimes.com today' });
  const third = await run([unresolvable]);
  const badMentions = (third.captured.posts[0]?.facets ?? [])
    .flatMap((facet: { features: { $type: string; did?: string }[] }) => facet.features)
    .filter((feature: { $type: string; did?: string }) => feature.$type.endsWith('#mention') && !feature.did);
  assert(
    badMentions.length === 0,
    'An unresolvable dotted mention does not leave an empty-DID facet (PDS would reject)',
  );
}

realLog('\nQuotes\n');
{
  const quotedMirrored = newId();
  seedMirrored(quotedMirrored, 'bob', 'bob.test', 'did:plc:bob', 'quoted');
  const q1 = tweet({ text: 'this', is_quote_status: true, quoted_status_id_str: quotedMirrored });
  const notMirrored = newId();
  const q2 = tweet({
    text: 'wow',
    is_quote_status: true,
    quoted_status_id_str: notMirrored,
    quoted_status: {
      id: notMirrored,
      username: 'someone',
      name: 'Some One',
      text: 'The &amp; quoted text',
      imageUrl: 'https://pbs.twimg.com/media/q.jpg',
      url: `https://x.com/someone/status/${notMirrored}`,
    },
  });
  const oldSelf = newId();
  const q3 = tweet({
    text: 'as I said years ago',
    is_quote_status: true,
    quoted_status_id_str: oldSelf,
    quoted_status: {
      id: oldSelf,
      username: 'alice',
      name: 'Alice',
      text: 'old take',
      url: `https://x.com/alice/status/${oldSelf}`,
    },
  });
  const { captured } = await run([q1, q2, q3]);
  assert(
    captured.posts[0]?.embed?.record?.uri === 'at://did:plc:bob/app.bsky.feed.post/quoted',
    "Quoting another mirror's tweet embeds its Bluesky post natively",
  );
  const card = captured.posts[1]?.embed?.external;
  assert(card?.title === 'Some One (@someone) on X', 'An unmirrored quote becomes a card titled with the author');
  assert(card?.description === 'The & quoted text', '…showing the quoted text (entities decoded)');
  assert(Boolean(card?.thumb), '…with the quoted image as thumbnail');
  assert(!captured.posts[1]?.text.includes('QT:'), '…instead of a bare "QT:" link');
  assert(
    captured.posts[2]?.embed?.external?.uri === `https://x.com/alice/status/${oldSelf}`,
    'A self-quote of a pre-mirror tweet keeps its context instead of vanishing',
  );
}

realLog('\nMedia\n');
{
  const photoNoAlt = tweet({
    text: 'pic',
    extended_entities: {
      media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg', url: 'https://t.co/m1' }],
    },
  });
  const gif = tweet({
    text: 'gif',
    extended_entities: {
      media: [
        {
          type: 'animated_gif',
          media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/g.jpg',
          ext_alt_text: 'A cat spinning',
          original_info: { width: 480, height: 270 },
          video_info: {
            variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/g.mp4', bitrate: 0 }],
            duration_millis: 0,
          },
        },
      ],
    },
  });
  const mixed = tweet({
    text: 'video and photo',
    extended_entities: {
      media: [
        {
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/v.jpg',
          video_info: {
            variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/v.mp4', bitrate: 832000 }],
            duration_millis: 5000,
          },
        },
        { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/b.jpg', ext_alt_text: 'A chart' },
      ],
    },
  });
  const tooLong = tweet({
    text: 'long video',
    extended_entities: {
      media: [
        {
          type: 'video',
          media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/long.jpg',
          video_info: {
            variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/long.mp4', bitrate: 832000 }],
            duration_millis: 45 * 60 * 1000,
          },
        },
      ],
    },
  });
  const { captured } = await run([photoNoAlt, gif, mixed, tooLong]);
  const [p1, p2, p3, p4, p5] = captured.posts;
  assert(p1?.embed?.images?.[0]?.alt === '', 'An image without alt text gets empty alt, not "Image from Twitter"');
  assert(p2?.embed?.presentation === 'gif', 'A Twitter GIF is posted with presentation "gif"');
  assert(p2?.embed?.alt === 'A cat spinning', "…and keeps the author's alt text");
  assert(p3?.embed?.$type === 'app.bsky.embed.video', 'Mixed media: the video leads the post');
  assert(
    p4?.embed?.$type === 'app.bsky.embed.images' &&
      // The mock numbers posts p1, p2, …; the video post is the third.
      p4?.reply?.parent?.uri === `at://did:plc:alice/app.bsky.feed.post/p${captured.posts.indexOf(p3) + 1}`,
    '…and its photo follows as a reply instead of being dropped',
  );
  assert(p4?.embed?.images?.[0]?.alt === 'A chart', '…with its alt text');
  assert(
    p5?.embed?.$type === 'app.bsky.embed.external' && p5.embed.external.uri.includes('/status/'),
    'A video too long for Bluesky becomes a card linking to the tweet',
  );
  assert(Boolean(p5?.embed?.external?.thumb), "…with the video's poster frame as thumbnail");
  assert(!p5?.text.includes('Video:'), '…instead of a bare "Video:" link');
}

realLog('\nLabels\n');
{
  const flagged = () =>
    tweet({
      text: 'spicy',
      possibly_sensitive: true,
      extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/s.jpg' }] },
    });
  const byDefault = await run([flagged()]);
  assert(
    byDefault.captured.posts[0]?.labels?.values?.[0]?.val === 'sexual',
    'A tweet flagged sensitive without a category keeps the default label',
  );
  const none = await run([flagged()], { settings: { sensitiveFallbackLabel: 'none' } });
  assert(none.captured.posts[0]?.labels === undefined, 'A mapping can opt out of the uncategorised label');
  const graphic = await run([flagged()], { settings: { sensitiveFallbackLabel: 'graphic-media' } });
  assert(graphic.captured.posts[0]?.labels?.values?.[0]?.val === 'graphic-media', '…or pick a different one');
}

realLog('\nTimestamps and text\n');
{
  const tweetTime = Date.now() - 20 * 60_000;
  const live = await run([tweet({ text: 'live one', created_at: new Date(tweetTime).toUTCString() })], { live: true });
  const liveAt = Date.parse(live.captured.posts[0]?.createdAt);
  assert(
    Math.abs(liveAt - Date.now()) < 10_000,
    'A live mirror is stamped with the posting time (lands at the top of feeds)',
  );
  const history = await run([tweet({ text: 'history one', created_at: new Date(tweetTime).toUTCString() })], {
    live: false,
  });
  const historyAt = Date.parse(history.captured.posts[0]?.createdAt);
  assert(Math.abs(historyAt - tweetTime) < 5_000, 'A backfilled tweet keeps its original time');
  const old = await run(
    [tweet({ text: 'stale', created_at: new Date(Date.now() - 2 * 24 * 3600_000).toUTCString() })],
    { live: true },
  );
  assert(
    Date.now() - Date.parse(old.captured.posts[0]?.createdAt) > 24 * 3600_000,
    'A tweet that sat in the queue for days keeps its original time even when live',
  );

  const entities = await run([tweet({ text: 'a &amp;lt; b &amp;&amp; c' })]);
  assert(entities.captured.posts[0]?.text === 'a &lt; b && c', 'HTML entities decode once (&amp;lt; stays "&lt;")');
}

realLog('\nEdits\n');
{
  const originalId = newId();
  const original = tweet({ id_str: originalId, text: 'typo here' });
  const first = await run([original]);
  assert(first.captured.posts.length === 1, 'The original tweet is mirrored');
  const editId = newId();
  const edited = tweet({ id_str: editId, text: 'no typo here', versions: [originalId, editId] });
  const skipMode = await run([edited]);
  assert(skipMode.captured.posts.length === 0, 'By default an edit of a mirrored tweet is not posted again');

  const originalB = newId();
  await run([tweet({ id_str: originalB, text: 'first version' })]);
  const editB = newId();
  const replace = await run([tweet({ id_str: editB, text: 'second version', versions: [originalB, editB] })], {
    settings: { editMode: 'replace' },
  });
  assert(replace.captured.deleted.length >= 1, 'Replace mode deletes the earlier mirror');
  assert(replace.captured.posts[0]?.text === 'second version', '…and posts the edited text');
  assert(dbService.getTweet(originalB, 'alice.test')?.status === 'deleted', "…recording the earlier one as 'deleted'");
}

realLog('\nCancellation\n');
{
  const controller = new AbortController();
  const tweets = [tweet({ text: 'first of two' }), tweet({ text: 'second of two' })];
  const { agent, captured } = mockAgent('did:plc:alice');
  const originalPost = agent.post;
  // biome-ignore lint/suspicious/noExplicitAny: records are free-form
  agent.post = async (record: any) => {
    const result = await originalPost(record);
    controller.abort();
    return result;
  };
  const outcomes = new Map<string, TweetOutcome>();
  // biome-ignore lint/suspicious/noExplicitAny: mock agent
  await processTweets(agent as any, 'alice', 'alice.test', [...tweets].reverse(), false, undefined, undefined, 'test', {
    outcomes,
    signal: controller.signal,
    settings: resolveMirrorSettings(),
  });
  assert(captured.posts.length === 1, 'After the watchdog aborts, no further tweet is posted');
  assert(
    !outcomes.has(tweets[1]?.id_str as string),
    '…and the untouched tweet has no outcome (re-armed without penalty)',
  );
}

realLog('\nQueue intake\n');
{
  const mapping = { ...getConfig().mappings[0], mirrorFromMs: Date.now() - 60_000 } as Parameters<
    typeof enqueueTweetsForMapping
  >[0];
  const oldTweet = tweet({
    text: 'before the mirror existed',
    created_at: new Date(Date.now() - 3600_000).toUTCString(),
  });
  const pinnedOld = tweet({ text: 'pinned', created_at: new Date(Date.now() - 3600_000).toUTCString(), isPin: true });
  const newTweet = tweet({ text: 'after', created_at: new Date().toUTCString() });
  const queued = enqueueTweetsForMapping(mapping, 'alice', [oldTweet, pinnedOld, newTweet], 'scheduled');
  assert(queued === 2, '"Only new tweets": older tweets are not queued (the pinned one is)');
  assert(
    dbService.getTweet(oldTweet.id_str as string, 'alice.test')?.status === 'skipped',
    '…they are recorded as history',
  );
  const backfill = tweet({ text: 'old but asked for', created_at: new Date(Date.now() - 3600_000).toUTCString() });
  assert(
    enqueueTweetsForMapping(mapping, 'alice', [backfill], 'backfill') === 1,
    'An explicit backfill ignores the cutoff',
  );

  const bobOriginal = newId();
  seedMirrored(bobOriginal, 'bob', 'bob.test', 'did:plc:bob', 'rtsource');
  const repostable = tweet({ text: 'RT @bob: x', isRetweet: true, retweeted_status_id_str: bobOriginal });
  const pointless = tweet({ text: 'RT @stranger: y', isRetweet: true, retweeted_status_id_str: newId() });
  const plain = { ...getConfig().mappings[0] } as Parameters<typeof enqueueTweetsForMapping>[0];
  assert(
    enqueueTweetsForMapping(plain, 'alice', [repostable, pointless], 'scheduled') === 1,
    'Only repostable retweets take queue space',
  );
  assert(
    dbService.getTweet(pointless.id_str as string, 'alice.test')?.status === 'skipped',
    '…the rest are recorded as skipped',
  );
}

realLog('\nRepairs\n');
{
  const id = newId();
  postQueueService.enqueue([
    {
      twitter_id: id,
      bsky_identifier: 'alice.test',
      mapping_id: 'map-alice',
      twitter_username: 'alice',
      kind: 'scheduled',
      tweet_json: '{}',
    },
  ]);
  postQueueService.markPosted(id, 'alice.test', 'at://did:plc:alice/app.bsky.feed.post/first', 'c1', {
    uri: 'at://did:plc:alice/app.bsky.feed.post/threadroot',
    cid: 'croot',
  });
  postQueueService.markChunkPosted(id, 'alice.test', 'at://did:plc:alice/app.bsky.feed.post/last', 'c3');
  reconcilePostedButUnrecorded();
  const repaired = dbService.getTweet(id, 'alice.test');
  assert(
    repaired?.bsky_root_uri === 'at://did:plc:alice/app.bsky.feed.post/threadroot',
    'A repaired record keeps the real thread root',
  );
  assert(repaired?.bsky_tail_uri === 'at://did:plc:alice/app.bsky.feed.post/last', '…and the last chunk as its tail');
}

realLog('\nImages\n');
{
  // Transparent PNG over the 1.9MB image ceiling: random noise will not compress.
  const width = 1200;
  const height = 1200;
  const raw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = Math.floor(Math.random() * 256);
    raw[i + 1] = Math.floor(Math.random() * 256);
    raw[i + 2] = Math.floor(Math.random() * 256);
    raw[i + 3] = i < width * 4 * 100 ? 0 : 255; // top 100 rows fully transparent
  }
  const png = await sharp(raw, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  const { agent, captured } = mockAgent('did:plc:alice');
  // biome-ignore lint/suspicious/noExplicitAny: mock agent
  await uploadToBluesky(agent as any, png, 'image/png');
  const uploaded = captured.uploads[0];
  assert(
    uploaded?.encoding === 'image/jpeg',
    `An oversized PNG (${(png.length / 1024 / 1024).toFixed(1)}MB) is re-encoded`,
  );
  const { data } = await sharp(uploaded?.buffer).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
  assert(r > 200 && g > 200 && b > 200, `Transparent areas become white, not black (got rgb ${r},${g},${b})`);
}

realLog('\nPreview speed (child process with real pacing)\n');
{
  const child = Bun.spawnSync([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      T2B_COMPOSE_MODE: 'preview-speed',
      TWEETS2BSKY_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tweets2bsky-compose-preview-')),
    },
  });
  const output = child.stdout.toString();
  for (const line of output.split('\n').filter((l) => l.trim().startsWith('✓') || l.trim().startsWith('✗'))) {
    realLog(line);
    if (line.trim().startsWith('✓')) passed++;
    else failed++;
  }
  if (child.exitCode !== 0 && !output.includes('✗')) {
    realLog(`  ✗ preview-speed child failed: ${child.stderr.toString().slice(0, 400)}`);
    failed++;
  }
}

assert(
  !httpLog.some((entry) => /twitter\.com|x\.com\/i\/api|api\.x\.com/.test(entry)),
  'No request ever went to the Twitter API',
);

realLog(`\n${passed} passed, ${failed} failed`);
fs.rmSync(scratchDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
