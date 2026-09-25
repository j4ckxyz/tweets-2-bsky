#!/usr/bin/env bun
// Dashboard API flows against a live server on a throwaway data dir. Bluesky
// is stubbed at the XRPC layer and the public API at axios, so nothing leaves
// the machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets2bsky-server-flows-'));
process.env.TWEETS2BSKY_DATA_DIR = scratch;
process.env.EVENT_LOG_FLUSH_MS = '0';
const port = process.env.TEST_PORT ?? '8902';
process.env.PORT = port;
process.env.HOST = '127.0.0.1';
const realLog = console.log;
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;

// --- Stubs ---------------------------------------------------------------------
const axios = (await import('axios')).default;
const didByHandle: Record<string, string> = {};
// biome-ignore lint/suspicious/noExplicitAny: stubbing axios for offline tests
(axios as any).get = async (url: string, config?: { params?: { handle?: string } }) => {
  if (url.endsWith('/xrpc/com.atproto.identity.resolveHandle')) {
    const did = didByHandle[config?.params?.handle ?? ''];
    if (!did) throw Object.assign(new Error('Unable to resolve handle'), { response: { status: 400 } });
    return { data: { did } };
  }
  throw new Error(`unexpected GET ${url}`);
};

const { BskyAgent } = await import('@atproto/api');
const LOGIN_DELAY_MS = 400;
const proto = BskyAgent.prototype as unknown as Record<string, unknown>;
proto.login = async function (this: { __session?: unknown }, input: { identifier: string }) {
  await new Promise((resolve) => setTimeout(resolve, LOGIN_DELAY_MS));
  this.__session = { did: `did:plc:${input.identifier.split('.')[0]}`, handle: input.identifier, active: true };
  return {};
};
Object.defineProperty(BskyAgent.prototype, 'session', {
  configurable: true,
  get(this: { __session?: unknown }) {
    return this.__session;
  },
});
// Every generated namespace method ends in agent.call(nsid, …).
proto.call = async function (this: { __session?: { did: string; handle: string } }, nsid: string) {
  switch (nsid) {
    case 'com.atproto.server.getSession':
      return { data: { did: this.__session?.did, handle: this.__session?.handle, emailConfirmed: true } };
    case 'com.atproto.repo.getRecord':
      return { data: { value: { $type: 'app.bsky.actor.profile' } } };
    case 'com.atproto.repo.putRecord':
      return { data: { uri: 'at://x', cid: 'c' } };
    default:
      throw new Error(`unexpected XRPC ${nsid}`);
  }
};

const { startServer, takeForcedSweep } = await import('../src/server.js');
const { getConfig } = await import('../src/config-manager.js');
const { dbService } = await import('../src/db.js');
startServer();
await new Promise((resolve) => setTimeout(resolve, 800));

const base = `http://127.0.0.1:${port}`;
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

await fetch(`${base}/api/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin-password-123' }),
});
const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: 'admin', password: 'admin-password-123' }),
});
const token = ((await login.json()) as { token: string }).token;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const api = (method: string, url: string, body?: unknown) =>
  fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

async function createMapping(twitter: string, handle: string, extra: Record<string, unknown> = {}) {
  const response = await api('POST', '/api/mappings', {
    twitterUsernames: [twitter],
    bskyIdentifier: handle,
    bskyPassword: 'app-password',
    ...extra,
  });
  return (await response.json()) as { id: string; mirrorFromMs?: number; hasBotLabel?: boolean; bskyDid?: string };
}

realLog('Creating accounts\n');
const alice = await createMapping('alice', 'alice.test', { startFrom: 'now', editMode: 'replace', syncDeletes: true });
const bob = await createMapping('bob', 'bob.test');
{
  assert(typeof alice.mirrorFromMs === 'number', '"Only new tweets" records a start point');
  assert(bob.mirrorFromMs === undefined, '…and the other choice does not');
  const stored = getConfig().mappings.find((mapping) => mapping.id === alice.id);
  assert(stored?.editMode === 'replace' && stored.syncDeletes === true, 'Mirroring options are saved at creation');
  assert(
    stored?.hasBotLabel === true && stored.bskyDid === 'did:plc:alice',
    'The bot label and DID are recorded after login',
  );
}

realLog('\nSlow bulk actions do not revert other changes\n');
{
  // bot-label-all signs in to every account in turn (400ms each here). A
  // mapping created while it runs used to vanish when it saved its snapshot.
  // Clear the flags first so the bulk action really has something to save.
  const { updateConfig } = await import('../src/config-manager.js');
  updateConfig((config) => {
    for (const mapping of config.mappings) mapping.hasBotLabel = false;
  });
  const bulk = api('POST', '/api/mappings/bot-label-all', {});
  await new Promise((resolve) => setTimeout(resolve, 150));
  const carol = await createMapping('carol', 'carol.test');
  const bulkResponse = await bulk;
  assert(bulkResponse.ok, 'The bulk action completes');
  assert(
    getConfig().mappings.some((mapping) => mapping.id === carol.id),
    'An account created while the bulk action ran is still there afterwards',
  );
  assert(
    getConfig()
      .mappings.filter((mapping) => mapping.id !== carol.id)
      .every((mapping) => mapping.hasBotLabel),
    '…and the bulk action still saved its own change',
  );
}

realLog('\nChanging the Bluesky handle\n');
{
  for (const id of ['1001', '1002']) {
    dbService.saveTweet({
      twitter_id: id,
      twitter_username: 'bob',
      bsky_identifier: 'bob.test',
      bsky_uri: `at://did:plc:bob/app.bsky.feed.post/${id}`,
      bsky_cid: 'c',
      status: 'migrated',
    });
  }
  didByHandle['bob.test'] = 'did:plc:bob';
  didByHandle['bob-renamed.test'] = 'did:plc:bob';
  const renamed = await api('PUT', `/api/mappings/${bob.id}`, { bskyIdentifier: 'bob-renamed.test' });
  assert(renamed.ok, 'The handle can be edited');
  assert(
    Object.keys(dbService.getTweetsByBskyIdentifier('bob-renamed.test')).length === 2,
    'Same account (same DID): its history moves to the new handle, so nothing is re-posted',
  );

  didByHandle['someone-else.test'] = 'did:plc:someoneelse';
  await api('PUT', `/api/mappings/${bob.id}`, { bskyIdentifier: 'someone-else.test' });
  assert(
    Object.keys(dbService.getTweetsByBskyIdentifier('someone-else.test')).length === 0,
    'A different account (different DID) starts with its own, empty history',
  );
  assert(
    getConfig().mappings.find((mapping) => mapping.id === bob.id)?.bskyDid === 'did:plc:someoneelse',
    "…and the mapping records the new account's DID",
  );
}

realLog('\nRun now\n');
{
  takeForcedSweep();
  const one = (await (await api('POST', '/api/run-now', { mappingId: alice.id })).json()) as { forced: string };
  assert(one.forced === 'mapping', 'Checking one account forces just that account');
  const all = (await (await api('POST', '/api/run-now', {})).json()) as { forced: string };
  assert(all.forced === 'all', '"Run now" forces a full check');
  const again = (await (await api('POST', '/api/run-now', {})).json()) as { forced: string };
  assert(again.forced === 'none', 'A second full force within minutes runs a normal sweep (protects the X account)');
  const taken = takeForcedSweep();
  assert(taken.all && taken.mappingIds.has(alice.id), 'The scheduler receives what to force');
  const hidden = await api('POST', '/api/run-now', { mappingId: 'nope' });
  assert(hidden.status === 404, 'Forcing an unknown account is refused');
}

realLog('\nStarter pack settings\n');
{
  const bad = await api('PUT', '/api/discovery', { curatorMappingId: 'missing' });
  assert(bad.status === 400, 'An unknown curator account is rejected');
  const good = await api('PUT', '/api/discovery', { curatorMappingId: alice.id });
  assert(good.ok, 'A curator account can be chosen');
  const state = (await (await api('GET', '/api/discovery')).json()) as { curatorMappingId: string };
  assert(state.curatorMappingId === alice.id, '…and is returned');
  const noFolder = await api('POST', '/api/groups/Nope/discovery-sync', {});
  assert(noFolder.status === 400, 'Syncing a folder that does not exist explains itself');
}

realLog('\nAccount page\n');
{
  const detail = (await (await api('GET', `/api/accounts/${alice.id}`)).json()) as {
    mapping: { editMode: string; syncDeletes: boolean; mirrorRetweets: boolean };
    sources: { lastError: string | null; protectedSince: number | null }[];
  };
  assert(detail.mapping.editMode === 'replace' && detail.mapping.syncDeletes, 'Settings are shown with the account');
  assert(detail.mapping.mirrorRetweets === true, 'Unset settings report their defaults');
  assert(
    'lastError' in (detail.sources[0] ?? {}) && 'protectedSince' in (detail.sources[0] ?? {}),
    'Sources report errors and protected state',
  );
}

realLog(`\n${passed} passed, ${failed} failed`);
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
