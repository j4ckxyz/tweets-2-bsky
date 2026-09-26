#!/usr/bin/env bun
// Offline checks for the data-integrity fixes: config writes that no longer
// revert each other, history that follows a handle change (rehandle, dashboard
// edit, or a rename discovered at login), scoped deletion that cannot trigger
// a re-post, and the queue/stats queries. Throwaway data directory, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets2bsky-integrity-'));
process.env.TWEETS2BSKY_DATA_DIR = scratchDir;
process.env.EVENT_LOG_FLUSH_MS = '0';
const realLog = console.log;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;

const { getConfig, saveConfig, updateConfig, updateMappingById } = await import('../src/config-manager.js');
const { dbService, postQueueService, sourceActivityService, rawDb } = await import('../src/db.js');
const { getAgent, deletePosts, invalidateAgent, moveMappingToIdentifier } = await import('../src/bsky.js');
const profile = await import('../src/profile-mirror.js');
const { BskyAgent } = await import('@atproto/api');

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

const baseMapping = { bskyPassword: 'pw', bskyServiceUrl: 'https://bsky.social', enabled: true };
saveConfig({
  ...getConfig(),
  mappings: [
    { ...baseMapping, id: 'm1', twitterUsernames: ['alice'], bskyIdentifier: 'alice.old.test' },
    { ...baseMapping, id: 'm2', twitterUsernames: ['bob'], bskyIdentifier: 'bob.test' },
  ],
  groups: [{ name: 'News', emoji: '📰', listUri: 'at://did:plc:c/app.bsky.graph.list/l1' }],
});

realLog('Config writes\n');
{
  // A long-running handler holds a snapshot across an await while something
  // else saves: the pattern that used to revert everything written meanwhile.
  const stale = getConfig();
  updateMappingById('m2', (mapping) => {
    mapping.lastPinSyncAt = new Date().toISOString();
  });
  updateConfig((fresh) => {
    fresh.mappings.push({ ...baseMapping, id: 'm3', twitterUsernames: ['carol'], bskyIdentifier: 'carol.test' });
  });
  // The fixed handlers patch a fresh read instead of saving `stale`.
  updateMappingById('m1', (mapping) => {
    mapping.hasBotLabel = true;
  });
  const after = getConfig();
  assert(
    after.mappings.some((mapping) => mapping.id === 'm3'),
    'A mapping added during a slow operation survives it',
  );
  assert(Boolean(after.mappings.find((m) => m.id === 'm2')?.lastPinSyncAt), "The scheduler's own writes survive too");
  assert(after.mappings.find((m) => m.id === 'm1')?.hasBotLabel === true, 'The slow operation still lands its change');
  assert(stale.mappings.length === 2, '(the stale snapshot really was stale)');

  updateMappingById('m1', (mapping) => {
    mapping.bskyDid = 'did:plc:alice';
    mapping.sensitiveFallbackLabel = 'none';
    mapping.editMode = 'replace';
    mapping.mirrorRetweets = false;
    mapping.syncDeletes = true;
    mapping.mirrorFromMs = 1_700_000_000_000;
  });
  const m1 = getConfig().mappings.find((m) => m.id === 'm1');
  assert(
    m1?.bskyDid === 'did:plc:alice' &&
      m1.sensitiveFallbackLabel === 'none' &&
      m1.editMode === 'replace' &&
      m1.mirrorRetweets === false &&
      m1.syncDeletes === true &&
      m1.mirrorFromMs === 1_700_000_000_000,
    'New mapping settings survive config normalisation',
  );
  assert(
    getConfig().groups[0]?.listUri === 'at://did:plc:c/app.bsky.graph.list/l1',
    'Group starter-pack fields survive too',
  );
  updateMappingById('m1', (mapping) => {
    mapping.sensitiveFallbackLabel = undefined;
    mapping.editMode = undefined;
    mapping.mirrorRetweets = undefined;
    mapping.syncDeletes = undefined;
    mapping.mirrorFromMs = undefined;
  });
}

function seed(id: string, identifier: string, status: 'migrated' | 'skipped' = 'migrated') {
  dbService.saveTweet({
    twitter_id: id,
    twitter_username: 'alice',
    bsky_identifier: identifier,
    bsky_uri: status === 'migrated' ? `at://did:plc:alice/app.bsky.feed.post/${id}` : undefined,
    bsky_cid: status === 'migrated' ? `c${id}` : undefined,
    status,
  });
}

realLog('\nHandle changes keep history\n');
{
  for (const id of ['101', '102', '103']) seed(id, 'alice.old.test');
  postQueueService.enqueue([
    {
      twitter_id: '104',
      bsky_identifier: 'alice.old.test',
      mapping_id: 'm1',
      twitter_username: 'alice',
      kind: 'scheduled',
      tweet_json: '{}',
    },
  ]);
  postQueueService.claimNextBatch(new Set(), new Set(['m1']));

  // The service-side move (dashboard edit, handle change found at login). The
  // rehandle script has its own copy-based re-key, covered by test:rehandle.
  moveMappingToIdentifier('m1', 'alice.old.test', 'alice.new.test');
  assert(getConfig().mappings.find((m) => m.id === 'm1')?.bskyIdentifier === 'alice.new.test', '…and updates config');
  const seen = Object.keys(dbService.getTweetsByBskyIdentifier('alice.new.test'));
  assert(seen.length === 3, 'The next sweep sees the old tweets as already mirrored (no re-post)');
  assert(postQueueService.getQueuedIdSet('alice.new.test').has('104'), 'Queued tweets move with it');
  assert(
    postQueueService.listItems({ mappingIds: new Set(['m1']) }).every((item) => item.status === 'pending'),
    'A row a batch had claimed is re-armed under the new handle',
  );
  // A batch still holding the old handle reads and writes the new rows.
  assert(
    dbService.getTweet('101', 'alice.old.test')?.bsky_identifier === 'alice.new.test',
    'Old handle reads resolve to the new rows',
  );
  seed('105', 'alice.old.test');
  assert(Boolean(dbService.getTweet('105', 'alice.new.test')), 'Old handle writes land under the new handle');
  assert(Object.keys(dbService.getTweetsByBskyIdentifier('alice.old.test')).length === 4, '…so nothing is orphaned');
}

realLog('\nHandle changed on Bluesky, discovered at login\n');
{
  const proto = BskyAgent.prototype as unknown as Record<string, unknown>;
  const originalLogin = proto.login;
  const sessionDescriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(BskyAgent.prototype), 'session');
  const logins: string[] = [];
  proto.login = async function (this: { __session?: unknown }, input: { identifier: string }) {
    logins.push(input.identifier);
    if (input.identifier === 'alice.new.test') {
      throw Object.assign(new Error('Invalid identifier or password'), {
        status: 401,
        error: 'AuthenticationRequired',
      });
    }
    if (input.identifier === 'did:plc:alice') {
      this.__session = { did: 'did:plc:alice', handle: 'alice.renamed.test', active: true };
      return {};
    }
    throw new Error('unexpected login');
  };
  Object.defineProperty(BskyAgent.prototype, 'session', {
    configurable: true,
    get(this: { __session?: unknown }) {
      return this.__session;
    },
  });
  try {
    const mapping = getConfig().mappings.find((m) => m.id === 'm1');
    invalidateAgent('alice.new.test');
    const agent = await getAgent(mapping as NonNullable<typeof mapping>);
    assert(Boolean(agent), 'A handle that no longer resolves falls back to logging in by DID');
    assert(logins.join(',') === 'alice.new.test,did:plc:alice', '…after the handle login fails');
    assert(
      getConfig().mappings.find((m) => m.id === 'm1')?.bskyIdentifier === 'alice.renamed.test',
      'The mapping follows the new handle',
    );
    assert(
      Object.keys(dbService.getTweetsByBskyIdentifier('alice.renamed.test')).length === 4,
      '…and so does the history',
    );
  } finally {
    proto.login = originalLogin;
    if (sessionDescriptor) Object.defineProperty(BskyAgent.prototype, 'session', sessionDescriptor);
    else Reflect.deleteProperty(BskyAgent.prototype, 'session');
  }
}

realLog('\nDeleting posts\n');
{
  // History: one single-chunk post, one split tweet recorded before chunk
  // tracking (root + tail only), one reposted retweet, one skipped tweet.
  const did = 'did:plc:bob';
  const uri = (rkey: string) => `at://${did}/app.bsky.feed.post/${rkey}`;
  dbService.saveTweet({
    twitter_id: '201',
    twitter_username: 'bob',
    bsky_identifier: 'bob.test',
    bsky_uri: uri('single'),
    bsky_cid: 'c',
    bsky_tail_uri: uri('single'),
    bsky_tail_cid: 'c',
    status: 'migrated',
  });
  dbService.saveTweet({
    twitter_id: '202',
    twitter_username: 'bob',
    bsky_identifier: 'bob.test',
    bsky_uri: uri('t1'),
    bsky_cid: 'c',
    bsky_tail_uri: uri('t3'),
    bsky_tail_cid: 'c',
    status: 'migrated',
  });
  dbService.saveTweet({
    twitter_id: '203',
    twitter_username: 'bob',
    bsky_identifier: 'bob.test',
    bsky_uri: `at://${did}/app.bsky.feed.repost/rp`,
    bsky_cid: 'c',
    status: 'reposted',
  });
  dbService.saveTweet({ twitter_id: '204', twitter_username: 'bob', bsky_identifier: 'bob.test', status: 'skipped' });
  postQueueService.enqueue([
    {
      twitter_id: '205',
      bsky_identifier: 'bob.test',
      mapping_id: 'm2',
      twitter_username: 'bob',
      kind: 'scheduled',
      tweet_json: '{}',
    },
  ]);
  const repo = [
    { uri: uri('single'), value: {} },
    { uri: uri('t1'), value: {} },
    { uri: uri('t2'), value: { reply: { parent: { uri: uri('t1') } } } },
    { uri: uri('t3'), value: { reply: { parent: { uri: uri('t2') } } } },
    { uri: uri('handwritten'), value: {} },
    { uri: uri('handreply'), value: { reply: { parent: { uri: uri('single') } } } },
  ];
  const deleted: string[] = [];
  const agent = {
    session: { did },
    com: {
      atproto: {
        repo: {
          listRecords: async () => ({ data: { records: repo, cursor: undefined } }),
          deleteRecord: async (input: { collection: string; rkey: string }) => {
            deleted.push(`${input.collection}/${input.rkey}`);
          },
        },
      },
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: mock agent
  const result = await deletePosts('m2', 'mirrored', agent as any);
  const posts = deleted
    .filter((entry) => entry.startsWith('app.bsky.feed.post/'))
    .map((entry) => entry.split('/')[1])
    .sort();
  assert(
    posts.join(',') === 'single,t1,t2,t3',
    `Only mirrored posts are deleted, middle chunks included (${posts.join(',')})`,
  );
  assert(deleted.includes('app.bsky.feed.repost/rp'), 'Mirrored reposts are removed too');
  assert(!posts.includes('handwritten') && !posts.includes('handreply'), 'Posts written by hand are kept');
  assert(result.deleted === 5, `The count covers everything removed (${result.deleted})`);
  assert(dbService.getTweet('201', 'bob.test')?.status === 'deleted', 'History is kept and marked deleted, not wiped');
  assert(
    Object.keys(dbService.getTweetsByBskyIdentifier('bob.test')).includes('202'),
    '…so the next sweep still treats those tweets as seen',
  );
  assert(Boolean(getConfig().mappings.find((m) => m.id === 'm2')?.mirrorFromMs), 'Scheduled checks restart from now');
  assert(postQueueService.getQueuedIdSet('bob.test').size === 0, 'Pending queue rows for the account are cleared');

  deleted.length = 0;
  // biome-ignore lint/suspicious/noExplicitAny: mock agent
  await deletePosts('m2', 'all', agent as any);
  assert(
    deleted.filter((entry) => entry.startsWith('app.bsky.feed.post/')).length === repo.length,
    '"all" removes every post',
  );
}

realLog('\nQueue and stats queries\n');
{
  const many = Array.from({ length: 300 }, (_, index) => ({
    twitter_id: String(9000 + index),
    bsky_identifier: 'carol.test',
    mapping_id: 'm3',
    twitter_username: 'carol',
    kind: 'backfill' as const,
    tweet_json: '{}',
  }));
  postQueueService.enqueue(many);
  postQueueService.enqueue([
    {
      twitter_id: '9999',
      bsky_identifier: 'bob.test',
      mapping_id: 'm2',
      twitter_username: 'bob',
      kind: 'scheduled',
      tweet_json: '{}',
    },
  ]);
  const bobItems = postQueueService.listItems({ mappingIds: new Set(['m2']), limit: 50 });
  assert(bobItems.length === 1, "An account's queue rows show up even behind another account's 300-row backfill");

  // A row written 6 days and 23 hours ago is inside a 7-day window.
  dbService.saveTweet({
    twitter_id: '301',
    twitter_username: 'carol',
    bsky_identifier: 'carol.test',
    bsky_uri: 'at://x/app.bsky.feed.post/1',
    bsky_cid: 'c',
    status: 'migrated',
  });
  const insideWindow = new Date(Date.now() - (7 * 24 - 1) * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  rawDb.prepare('UPDATE processed_tweets SET created_at = ? WHERE twitter_id = ?').run(insideWindow, '301');
  const stats = dbService.getPostStatsForIdentifier('carol.test', 7 * 24 * 3600_000);
  assert(stats.posted === 1, 'A post from the first day of the window is counted (text-vs-ISO date comparison fixed)');

  dbService.saveTweet({
    twitter_id: '401',
    twitter_username: 'shared',
    bsky_identifier: 'bob.test',
    status: 'skipped',
  });
  dbService.saveTweet({
    twitter_id: '401',
    twitter_username: 'shared',
    bsky_identifier: 'carol.test',
    status: 'skipped',
  });
  dbService.deleteTweetsForMapping('bob.test', ['shared']);
  assert(
    !dbService.getTweet('401', 'bob.test') && Boolean(dbService.getTweet('401', 'carol.test')),
    "Clearing one mirror's cache leaves other mirrors of the same source alone",
  );

  sourceActivityService.recordCheck('oldname', true);
  dbService.saveTweet({
    twitter_id: '501',
    twitter_username: 'oldname',
    bsky_identifier: 'carol.test',
    status: 'skipped',
  });
  dbService.renameTwitterUsername('oldname', 'newname');
  assert(
    dbService.getTweet('501', 'carol.test')?.twitter_username === 'newname',
    'A source rename carries its history',
  );
  assert(
    Boolean(sourceActivityService.get('newname')) && !sourceActivityService.get('oldname'),
    '…and its polling state',
  );

  seed('601', 'bob.test');
  dbService.saveTweet({
    twitter_id: '601',
    twitter_username: 'alice',
    bsky_identifier: 'carol.test',
    bsky_uri: 'at://did:plc:carol/app.bsky.feed.post/601',
    bsky_cid: 'c',
    status: 'migrated',
  });
  assert(
    dbService.findMirroredPost('601', 'carol.test')?.bsky_identifier === 'carol.test',
    "Instance-wide lookup prefers the account's own copy",
  );
  assert(Boolean(dbService.findMirroredPost('601')), '…and finds a copy from any account');
}

realLog('\nProfile helpers\n');
{
  assert(profile.buildMirroredDisplayName('NASA', 'nasa') === 'NASA {bot}', 'The {bot} suffix is added by default');
  assert(profile.buildMirroredDisplayName('NASA', 'nasa', false) === 'NASA', '…and can be switched off');
  const longName = 'A'.repeat(70);
  const longResult = profile.buildMirroredDisplayName(longName, 'x');
  assert(longResult.endsWith('{bot}') && [...longResult].length <= 64, 'A long name is truncated, never the suffix');
  assert(
    profile.buildMirroredWebsite('https://www.nasa.gov/', 'nasa') === 'https://www.nasa.gov/',
    "Their own site goes in Bluesky's website field",
  );
  assert(profile.buildMirroredWebsite(undefined, 'NASA') === 'https://x.com/nasa', '…otherwise the X profile');
  assert(
    profile.buildMirroredWebsite('javascript:alert(1)', 'nasa') === 'https://x.com/nasa',
    'Only http(s) links are accepted',
  );
  assert(
    profile.canOverwriteDescription('Mirror of X\n\nold bio', 'Mirror of X\n\nold bio'),
    'An untouched mirrored bio is updated',
  );
  assert(profile.canOverwriteDescription('', 'anything'), 'An empty bio is filled in');
  assert(
    !profile.canOverwriteDescription('Written by hand', 'Mirror of X\n\nold bio'),
    'A bio edited by hand on Bluesky is left alone',
  );
  assert(!profile.canOverwriteDescription('Written by hand', undefined), '…including when nothing was mirrored before');
  const changes = profile.hasMirrorStateChanges({ website: undefined }, { website: 'https://x.com/nasa' });
  assert(changes.website, 'A new website value counts as a profile change');
}

realLog(`\n${passed} passed, ${failed} failed`);
fs.rmSync(scratchDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
