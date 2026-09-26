#!/usr/bin/env bun
// Offline checks for delete sync. Deleting a post that should have stayed is
// far worse than keeping one that should have gone, so most of these check the
// cases where nothing must happen. No network: the syndication CDN is stubbed.
const axios = (await import('axios')).default;
const { DELETE_SYNC_MIN_MISSING_SPAN_MS, checkSourceTweet, mirroredUris, syncDeletesForAccount } = await import(
  '../src/delete-sync.js'
);
type Deps = Parameters<typeof syncDeletesForAccount>[1];
type State = Awaited<ReturnType<typeof checkSourceTweet>>;

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

console.log('Reading the syndication CDN\n');
{
  const responses: Record<string, { status: number; data: unknown } | 'throw'> = {
    '1': { status: 200, data: { __typename: 'Tweet', id_str: '1' } },
    '2': { status: 404, data: '<html>' },
    '3': { status: 200, data: { __typename: 'TweetTombstone' } },
    '4': { status: 429, data: {} },
    '5': 'throw',
  };
  // biome-ignore lint/suspicious/noExplicitAny: stubbing axios for offline tests
  (axios as any).get = async (_url: string, config: { params: { id: string } }) => {
    const response = responses[config.params.id];
    if (response === 'throw' || !response) throw new Error('network down');
    return response;
  };
  assert((await checkSourceTweet('1')) === 'present', 'A live tweet is present');
  assert((await checkSourceTweet('2')) === 'missing', 'A 404 means missing');
  assert((await checkSourceTweet('3')) === 'unknown', 'A tombstone (age-gated, withheld) is not proof of deletion');
  assert((await checkSourceTweet('4')) === 'unknown', 'Rate limiting is not proof of deletion');
  assert((await checkSourceTweet('5')) === 'unknown', 'A network error is not proof of deletion');
}

function harness(states: Record<string, State>, clock: { now: number }) {
  const misses = new Map<string, { misses: number; since: number }>();
  const deleted: string[] = [];
  const marked: string[] = [];
  const present: string[] = [];
  const inconclusive: string[] = [];
  const deps: Deps = {
    check: async (id) => states[id] ?? 'unknown',
    recordPresent: (id) => {
      present.push(id);
      misses.delete(id);
    },
    recordInconclusive: (id) => {
      inconclusive.push(id);
    },
    recordMissing: (id) => {
      const current = misses.get(id);
      const next = { misses: (current?.misses ?? 0) + 1, since: current?.since ?? clock.now };
      misses.set(id, next);
      return next;
    },
    deletePost: async (uri) => {
      deleted.push(uri);
    },
    markDeleted: (id) => {
      marked.push(id);
    },
    log: () => undefined,
    now: () => clock.now,
  };
  return { deps, deleted, marked, present, inconclusive };
}

const candidate = (id: string, chunks?: string[]) => ({
  twitter_id: id,
  bsky_uri: `at://did:plc:a/app.bsky.feed.post/${id}a`,
  bsky_tail_uri: `at://did:plc:a/app.bsky.feed.post/${id}${chunks ? 'c' : 'a'}`,
  bsky_chunk_uris: chunks ? JSON.stringify(chunks) : undefined,
});

console.log('\nDeciding to delete\n');
{
  const clock = { now: 1_000_000_000 };
  const chunks = [
    'at://did:plc:a/app.bsky.feed.post/10a',
    'at://did:plc:a/app.bsky.feed.post/10b',
    'at://did:plc:a/app.bsky.feed.post/10c',
  ];
  const states: Record<string, State> = { '10': 'missing', '11': 'present', '12': 'present', '13': 'present' };
  const run = harness(states, clock);
  const candidates = [candidate('10', chunks), candidate('11'), candidate('12'), candidate('13')];

  await syncDeletesForAccount(candidates, run.deps);
  assert(run.deleted.length === 0, 'One missing check is not enough to delete');

  clock.now += 60 * 60 * 1000;
  await syncDeletesForAccount(candidates, run.deps);
  assert(run.deleted.length === 0, 'Two misses an hour apart are not enough either');

  clock.now += DELETE_SYNC_MIN_MISSING_SPAN_MS;
  const result = await syncDeletesForAccount(candidates, run.deps);
  assert(result.deleted === 1, 'Missing on checks six hours apart: the mirror is deleted');
  assert(
    JSON.stringify([...run.deleted].sort()) === JSON.stringify([...chunks].sort()),
    'Every chunk of a split tweet is deleted',
  );
  assert(run.marked.join(',') === '10', '…and the history row is marked deleted');
  assert(run.present.includes('11'), 'Tweets that still exist are recorded as present');
}

console.log('\nStanding down\n');
{
  const clock = { now: 2_000_000_000 };
  // An account suspended overnight: every tweet 404s at once.
  const states: Record<string, State> = { '20': 'missing', '21': 'missing', '22': 'missing', '23': 'missing' };
  const run = harness(states, clock);
  const candidates = ['20', '21', '22', '23'].map((id) => candidate(id));
  for (let pass = 0; pass < 3; pass++) {
    const result = await syncDeletesForAccount(candidates, run.deps);
    assert(result.stoodDown, `Pass ${pass + 1}: most tweets vanishing at once stands the pass down`);
    clock.now += DELETE_SYNC_MIN_MISSING_SPAN_MS;
  }
  assert(run.deleted.length === 0, 'A suspended or protected account never has its mirror wiped');
  assert(run.inconclusive.length === 12, 'Stood-down checks are still recorded, so they are not retried every sweep');

  const unknownRun = harness({ '30': 'unknown' }, clock);
  await syncDeletesForAccount([candidate('30')], unknownRun.deps);
  clock.now += DELETE_SYNC_MIN_MISSING_SPAN_MS;
  await syncDeletesForAccount([candidate('30')], unknownRun.deps);
  assert(unknownRun.deleted.length === 0, 'Inconclusive checks never delete anything');
}

console.log('\nPost URIs\n');
assert(
  mirroredUris({
    twitter_id: '1',
    bsky_uri: 'at://a/app.bsky.feed.post/1',
    bsky_tail_uri: 'at://a/app.bsky.feed.post/1',
  }).length === 1,
  'A single post is deleted once',
);
assert(
  mirroredUris({ twitter_id: '1', bsky_uri: 'a', bsky_chunk_uris: 'not json' }).join(',') === 'a',
  'A corrupt chunk list falls back to the recorded post',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
