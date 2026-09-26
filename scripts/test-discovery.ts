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
          putRecord: async () => ({}),
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
