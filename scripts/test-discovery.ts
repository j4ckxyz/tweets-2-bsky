#!/usr/bin/env bun
// Offline checks for per-folder lists and starter packs, against an in-memory
// repo that behaves like a PDS for the four record calls discovery makes.
const { STARTER_PACK_RECOMMENDED_MIN, starterPackUrl, syncGroupDiscovery } = await import('../src/discovery.js');

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

function memoryRepo(did: string) {
  // biome-ignore lint/suspicious/noExplicitAny: record values are free-form
  const records = new Map<string, any>();
  let counter = 0;
  const uriFor = (collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`;
  const agent = {
    session: { did, handle: 'curator.test' },
    com: {
      atproto: {
        repo: {
          // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
          createRecord: async (input: any) => {
            counter += 1;
            const uri = uriFor(input.collection, `r${counter}`);
            records.set(uri, input.record);
            return { data: { uri, cid: `c${counter}` } };
          },
          // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
          deleteRecord: async (input: any) => {
            records.delete(uriFor(input.collection, input.rkey));
            return {};
          },
          // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
          getRecord: async (input: any) => {
            const uri = uriFor(input.collection, input.rkey);
            if (!records.has(uri)) throw Object.assign(new Error('Could not locate record'), { status: 400 });
            return { data: { uri, value: records.get(uri) } };
          },
          // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
          putRecord: async (input: any) => {
            records.set(uriFor(input.collection, input.rkey), input.record);
            return {};
          },
          // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
          listRecords: async (input: any) => ({
            data: {
              records: [...records.entries()]
                .filter(([uri]) => uri.includes(`/${input.collection}/`))
                .map(([uri, value]) => ({ uri, value })),
            },
          }),
        },
      },
    },
  };
  const of = (collection: string) =>
    [...records.entries()].filter(([uri]) => uri.includes(`/${collection}/`)).map(([uri, value]) => ({ uri, value }));
  return { agent, records, of };
}

console.log('Creating\n');
const repo = memoryRepo('did:plc:curator');
const first = await syncGroupDiscovery(repo.agent, { name: 'News', emoji: '📰' }, [
  'did:plc:a',
  'did:plc:b',
  'did:plc:c',
]);
{
  const lists = repo.of('app.bsky.graph.list');
  const packs = repo.of('app.bsky.graph.starterpack');
  assert(
    lists.length === 1 && lists[0]?.value.purpose === 'app.bsky.graph.defs#curatelist',
    'A curation list is created',
  );
  assert(lists[0]?.value.name === '📰 News', '…named after the folder');
  assert(repo.of('app.bsky.graph.listitem').length === 3, 'Every account in the folder is added');
  assert(
    packs.length === 1 && packs[0]?.value.list === first.listUri,
    'A starter pack pointing at the list is created',
  );
  assert(first.createdList && first.createdStarterPack && first.added === 3, 'The result reports what was created');
  assert(
    starterPackUrl(first.starterPackUri, 'curator.test').startsWith('https://bsky.app/starter-pack/curator.test/'),
    'The shareable bsky.app link is built from the record',
  );
}

console.log('\nKeeping it in step\n');
{
  const second = await syncGroupDiscovery(
    repo.agent,
    { name: 'News', emoji: '📰', listUri: first.listUri, starterPackUri: first.starterPackUri },
    ['did:plc:a', 'did:plc:b', 'did:plc:d'],
  );
  const subjects = repo
    .of('app.bsky.graph.listitem')
    .map((item) => item.value.subject)
    .sort();
  assert(!second.createdList && !second.createdStarterPack, 'An existing list and starter pack are reused');
  assert(second.added === 1 && second.removed === 1, 'Only the difference is written (one added, one removed)');
  assert(subjects.join(',') === 'did:plc:a,did:plc:b,did:plc:d', 'The list matches the folder exactly');

  const third = await syncGroupDiscovery(
    repo.agent,
    { name: 'News', listUri: first.listUri, starterPackUri: first.starterPackUri },
    ['did:plc:a', 'did:plc:b', 'did:plc:d'],
  );
  assert(third.added === 0 && third.removed === 0, 'Syncing again with no changes writes nothing');

  // Someone deleted the starter pack in the Bluesky app.
  repo.records.delete(first.starterPackUri);
  const fourth = await syncGroupDiscovery(
    repo.agent,
    { name: 'News', listUri: first.listUri, starterPackUri: first.starterPackUri },
    ['did:plc:a'],
  );
  assert(
    fourth.createdStarterPack && !fourth.createdList,
    'A starter pack deleted in the app is recreated on the same list',
  );

  // Another folder's list items are never touched.
  const other = await syncGroupDiscovery(repo.agent, { name: 'Sports' }, ['did:plc:z']);
  const afterOther = await syncGroupDiscovery(
    repo.agent,
    { name: 'News', listUri: first.listUri, starterPackUri: fourth.starterPackUri },
    ['did:plc:a'],
  );
  assert(other.listUri !== first.listUri && afterOther.removed === 0, "Folders never remove each other's members");
  assert(STARTER_PACK_RECOMMENDED_MIN === 7, 'Small folders are flagged against the app-recommended minimum of 7');
}

console.log('\nWhen things go wrong\n');
{
  const flaky = memoryRepo('did:plc:flaky');
  const base = await syncGroupDiscovery(flaky.agent, { name: 'NBA' }, ['did:plc:a', 'did:plc:b']);
  const realGet = flaky.agent.com.atproto.repo.getRecord;
  let failOnce = true;
  // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
  flaky.agent.com.atproto.repo.getRecord = async (input: any) => {
    if (failOnce && input.collection === 'app.bsky.graph.list') {
      failOnce = false;
      throw Object.assign(new Error('UpstreamTimeout'), { status: 504 });
    }
    return realGet(input);
  };
  let threw = false;
  try {
    await syncGroupDiscovery(flaky.agent, { name: 'NBA', listUri: base.listUri, starterPackUri: base.starterPackUri }, [
      'did:plc:a',
    ]);
  } catch {
    threw = true;
  }
  assert(threw, 'A failed lookup is an error, not a missing list');
  assert(flaky.of('app.bsky.graph.list').length === 1, '…so no second list is created');

  // The list was deleted in the app; the starter pack people share must follow
  // the replacement instead of pointing at nothing.
  flaky.records.delete(base.listUri);
  const rebuilt = await syncGroupDiscovery(
    flaky.agent,
    { name: 'NBA', listUri: base.listUri, starterPackUri: base.starterPackUri },
    ['did:plc:a'],
  );
  assert(
    rebuilt.createdList && rebuilt.starterPackUri === base.starterPackUri,
    'A deleted list is recreated, the pack kept',
  );
  assert(
    flaky.records.get(base.starterPackUri)?.list === rebuilt.listUri,
    'The starter pack is repointed at the recreated list',
  );

  // Adding members fails after the list was created: the caller must already
  // know the new list, or every retry creates another one.
  const partial = memoryRepo('did:plc:partial');
  const realCreate = partial.agent.com.atproto.repo.createRecord;
  // biome-ignore lint/suspicious/noExplicitAny: xrpc payloads
  partial.agent.com.atproto.repo.createRecord = async (input: any) => {
    if (input.collection === 'app.bsky.graph.listitem') throw new Error('RateLimitExceeded');
    return realCreate(input);
  };
  let savedListUri: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await syncGroupDiscovery(
        partial.agent,
        { name: 'F1', listUri: savedListUri },
        ['did:plc:a'],
        undefined,
        (uri) => {
          savedListUri = uri;
        },
      );
    } catch {
      // expected
    }
  }
  assert(
    partial.of('app.bsky.graph.list').length === 1 && savedListUri !== undefined,
    'A sync that fails after creating its list reuses that list on retry',
  );

  const long = memoryRepo('did:plc:long');
  await syncGroupDiscovery(long.agent, { name: 'プロ野球セ・リーグ公式アカウントまとめ一覧表', emoji: '⚾' }, [
    'did:plc:a',
  ]);
  const name = long.of('app.bsky.graph.list')[0]?.value.name as string;
  assert(
    Buffer.byteLength(name, 'utf8') <= 64,
    `A list name fits the 64-byte limit (${Buffer.byteLength(name, 'utf8')} bytes)`,
  );
  assert(
    long.of('app.bsky.graph.starterpack')[0]?.value.name.length > name.length,
    '…while the starter pack keeps its longer name',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
