#!/usr/bin/env bun
/**
 * Plan and preflight decisions against a scripted fake network.
 *
 *   bun scripts/test-rehandle-network.ts
 *
 * `fetch` is replaced with a router that answers the Bluesky, Cloudflare and
 * DNS-over-HTTPS calls the real code makes, so each status decision is tested
 * against the exact responses that produce it. Nothing leaves the machine and
 * nothing is written to config.json.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AccountMapping, getConfig } from '../src/config-manager.js';
import { DATA_DIR } from '../src/storage-paths.js';
import { isCloudflareDelegation, waitForTxt } from './lib/cloudflare.js';
import { type Options, applyPlan, buildPlan, checkCloudflare, isActionable, parseArgs } from './rehandle.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
    passed++;
  } else {
    console.log(`  FAIL ${message}`);
    failed++;
  }
}

const equal = (actual: unknown, expected: unknown, message: string) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) === JSON.stringify(expected)
      ? message
      : `${message}  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );

// ---------------------------------------------------------------------------
// Fake network
// ---------------------------------------------------------------------------

interface World {
  /** handle -> DID, as com.atproto.identity.resolveHandle would answer. */
  handles: Record<string, string>;
  /** DID -> handle, as com.atproto.repo.describeRepo would answer. 'ERROR' simulates an outage. */
  repos: Record<string, string>;
  zoneStatus?: string;
  nameservers?: string[];
  /** Which identifiers createSession accepts, and optionally a different DID to hand back. */
  logins?: { identifiers: string[]; password: string; sessionDid?: string };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const realFetch = globalThis.fetch;

function install(world: World): void {
  const txt = new Map<string, string>();
  let nextId = 1;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    // AtpAgent sends bodies as bytes, the Cloudflare client as strings.
    const bodyText = () =>
      typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body as Uint8Array);

    if (url.pathname.endsWith('/com.atproto.identity.resolveHandle')) {
      const did = world.handles[url.searchParams.get('handle') ?? ''];
      return did ? json({ did }) : json({ error: 'InvalidRequest', message: 'Unable to resolve handle' }, 400);
    }
    if (url.pathname.endsWith('/com.atproto.server.createSession')) {
      const { identifier, password } = JSON.parse(bodyText());
      const did = identifier.startsWith('did:') ? identifier : world.handles[identifier];
      if (!world.logins || password !== world.logins.password || !world.logins.identifiers.includes(identifier)) {
        return json({ error: 'AuthenticationRequired', message: 'Invalid identifier or password' }, 401);
      }
      const sessionDid = world.logins.sessionDid ?? did;
      return json({
        did: sessionDid,
        handle: world.repos[sessionDid] ?? 'handle.invalid',
        accessJwt: 'header.e30.sig',
        refreshJwt: 'header.e30.sig',
        active: true,
      });
    }
    if (url.pathname.endsWith('/com.atproto.repo.describeRepo')) {
      const handle = world.repos[url.searchParams.get('repo') ?? ''];
      if (handle === 'ERROR') return json({ message: 'Upstream failure' }, 502);
      return handle ? json({ handle }) : json({ message: 'Could not find repo' }, 400);
    }

    if (url.hostname === 'api.cloudflare.com') {
      const path = url.pathname.replace('/client/v4', '');
      if (path === '/user/tokens/verify')
        return json({ success: true, result: { id: 'tok12345678', status: 'active' } });
      if (path === '/zones') {
        return json({
          success: true,
          result: [{ id: 'zone12345678', name: url.searchParams.get('name'), status: world.zoneStatus ?? 'active' }],
        });
      }
      if (path.endsWith('/dns_records') && method === 'GET') return json({ success: true, result: [] });
      if (path.endsWith('/dns_records') && method === 'POST') {
        const body = JSON.parse(bodyText());
        txt.set(body.name, body.content);
        return json({ success: true, result: { id: `rec${nextId++}0000000`, ...body } });
      }
      if (method === 'DELETE') return json({ success: true, result: {} });
    }

    if (url.hostname === 'cloudflare-dns.com' || url.hostname === 'dns.google') {
      const name = url.searchParams.get('name') ?? '';
      if (url.searchParams.get('type') === 'NS') {
        return json({ Answer: (world.nameservers ?? []).map((data) => ({ type: 2, data: `${data}.` })) });
      }
      const value = txt.get(name);
      return json({ Answer: value ? [{ type: 16, data: `"${value}"` }] : [] });
    }

    throw new Error(`Unexpected request in test: ${method} ${url.href}`);
  }) as typeof fetch;
}

/** Run with console output swallowed, so the suite's own output stays readable. */
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  const write = process.stdout.write.bind(process.stdout);
  console.log = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
}

const DID = 'did:plc:a3hn34ggnipqjmglkehg33y4';
const options: Options = { ...parseArgs([]), domain: 'xmirror.bot' };

const mapping = (bskyIdentifier: string, overrides: Partial<AccountMapping> = {}): AccountMapping =>
  ({
    id: 'm1',
    twitterUsernames: ['jersey_met'],
    bskyIdentifier,
    bskyPassword: 'app-pass',
    bskyServiceUrl: 'https://bsky.social',
    enabled: true,
    profileSyncSourceUsername: 'jersey_met',
    ...overrides,
  }) as AccountMapping;

async function plan(world: World, identifier: string, overrides: Partial<AccountMapping> = {}) {
  install(world);
  try {
    return await buildPlan(mapping(identifier, overrides), options, null);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * Apply scenarios write config.json, and the data directory is fixed when
 * config-manager is first imported. So they run in a child process whose
 * TWEETS2BSKY_DATA_DIR is a throwaway directory, and report back as JSON.
 */
if (process.env.REHANDLE_TEST_CHILD === 'apply') {
  const cloudflare = { client: {} as never, zoneId: 'zone' };
  const results: Record<string, unknown> = { dataDir: DATA_DIR };

  const seed = (identifier: string) =>
    fs.writeFileSync(
      path.join(DATA_DIR, 'config.json'),
      JSON.stringify({
        twitter: { authToken: '', ct0: '' },
        mappings: [mapping(identifier)],
        groups: [],
        users: [],
        checkIntervalMinutes: 5,
      }),
    );

  const run = async (label: string, world: World, identifier: string) => {
    seed(identifier);
    install(world);
    try {
      const p = await buildPlan(mapping(identifier), options, null);
      const entry = await quietly(() => applyPlan(p, options, cloudflare));
      results[label] = {
        status: p.status,
        entry: entry?.kind ?? null,
        identifier: getConfig().mappings[0]?.bskyIdentifier,
      };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const moved = { handles: { 'jersey-met.xmirror.bot': DID }, repos: { [DID]: 'jersey-met.xmirror.bot' } };

  // Old handle rejected by the PDS; the DID is accepted.
  await run('byDid', { ...moved, logins: { identifiers: [DID], password: 'app-pass' } }, 'jersey-met.bsky.social');
  // Password no longer valid anywhere.
  await run('badPassword', { ...moved, logins: { identifiers: [DID], password: 'rotated' } }, 'jersey-met.bsky.social');
  // Login succeeds but as a different account.
  await run(
    'wrongAccount',
    {
      ...moved,
      repos: { ...moved.repos, 'did:plc:other': 'other.bsky.social' },
      logins: { identifiers: [DID], password: 'app-pass', sessionDid: 'did:plc:other' },
    },
    'jersey-met.bsky.social',
  );

  console.log(`CHILD_RESULT=${JSON.stringify(results)}`);
  process.exit(0);
}

console.log('\ntweets-2-bsky handle migration - fake-network tests\n');

// ---------------------------------------------------------------------------
console.log('1. Moving an account that already went through j4ck.xyz');
{
  const p = await plan(
    { handles: { 'jersey-met.j4ck.xyz': DID }, repos: { [DID]: 'jersey-met.j4ck.xyz' } },
    'jersey-met.j4ck.xyz',
  );
  equal(p.status, 'ready', 'a j4ck.xyz account is ready to move again');
  equal(p.newHandle, 'jersey-met.xmirror.bot', 'the underscore rule still applies on the new domain');
  equal(p.txtName, '_atproto.jersey-met.xmirror.bot', 'the TXT record goes under xmirror.bot');
  equal(p.did, DID, 'the DID comes from the current j4ck.xyz handle');
  assert(isActionable(p), 'and it is acted on');
  console.log();
}

// ---------------------------------------------------------------------------
console.log('2. Recovering from an interrupted run');
{
  // Handle changed on Bluesky, config.json never saved, old bsky.social handle released.
  const gone = await plan(
    { handles: { 'jersey-met.xmirror.bot': DID }, repos: { [DID]: 'jersey-met.xmirror.bot' } },
    'jersey-met.bsky.social',
  );
  equal(gone.status, 'config-catch-up', 'old handle gone but Bluesky already on the target: config catch-up');
  equal(gone.did, DID, 'the DID is recovered through the new handle');
  equal(gone.blockers, [], 'and nothing blocks it');
  assert(isActionable(gone), 'and it is acted on');

  // Same, but the old j4ck.xyz TXT record still resolves.
  const stale = await plan(
    {
      handles: { 'jersey-met.j4ck.xyz': DID, 'jersey-met.xmirror.bot': DID },
      repos: { [DID]: 'jersey-met.xmirror.bot' },
    },
    'jersey-met.j4ck.xyz',
  );
  equal(
    stale.status,
    'config-catch-up',
    'old handle still resolves but Bluesky moved on: config catch-up, not a second change',
  );
  equal(stale.blueskyHandle, 'jersey-met.xmirror.bot', 'the plan records what Bluesky actually reports');

  // The target handle resolves, but the account there does not claim it.
  const unclaimed = await plan(
    {
      handles: { 'jersey-met.xmirror.bot': 'did:plc:someoneelse' },
      repos: { 'did:plc:someoneelse': 'other.bsky.social' },
    },
    'jersey-met.bsky.social',
  );
  equal(unclaimed.status, 'blocked', 'a target handle not claimed by its DID is never adopted');

  const lost = await plan({ handles: {}, repos: {} }, 'jersey-met.bsky.social');
  equal(lost.status, 'blocked', 'nothing resolves: blocked');
  assert(/Could not resolve the current handle/.test(lost.blockers.join()), 'with the original resolution error');
  console.log();
}

// ---------------------------------------------------------------------------
console.log('3. Already done, and when Bluesky cannot be read');
{
  const done = await plan(
    { handles: { 'jersey-met.xmirror.bot': DID }, repos: { [DID]: 'jersey-met.xmirror.bot' } },
    'jersey-met.xmirror.bot',
  );
  equal(done.status, 'already-correct', 'config and Bluesky both on the target: already correct');
  assert(!isActionable(done), 'and it is skipped, so re-running after an interruption is safe');

  const outageDone = await plan(
    { handles: { 'jersey-met.xmirror.bot': DID }, repos: { [DID]: 'ERROR' } },
    'jersey-met.xmirror.bot',
  );
  equal(outageDone.status, 'already-correct', 'describeRepo outage falls back to trusting config.json');

  const outageReady = await plan(
    { handles: { 'jersey-met.bsky.social': DID }, repos: { [DID]: 'ERROR' } },
    'jersey-met.bsky.social',
  );
  equal(outageReady.status, 'ready', 'and still plans the change when config.json is not on the target');

  const noPassword = await plan(
    { handles: { 'jersey-met.bsky.social': DID }, repos: { [DID]: 'jersey-met.bsky.social' } },
    'jersey-met.bsky.social',
    { bskyPassword: '' },
  );
  equal(noPassword.status, 'blocked', 'a mapping without an app password is still blocked');
  console.log();
}

// ---------------------------------------------------------------------------
console.log('4. Nameserver delegation');
assert(isCloudflareDelegation(['daisy.ns.cloudflare.com', 'jarred.ns.cloudflare.com']), 'Cloudflare nameservers pass');
assert(
  !isCloudflareDelegation(['curitiba.ns.porkbun.com', 'fortaleza.ns.porkbun.com']),
  "Porkbun's defaults (xmirror.bot today) fail",
);
assert(
  !isCloudflareDelegation(['daisy.ns.cloudflare.com', 'maceio.ns.porkbun.com']),
  'a half-finished change fails: some resolvers would still ask Porkbun',
);
assert(!isCloudflareDelegation([]), 'no delegation at all fails');
assert(!isCloudflareDelegation(['ns.cloudflare.com.evil.example']), 'a lookalike hostname fails');
console.log();

// ---------------------------------------------------------------------------
console.log('5. Cloudflare preflight refuses before DNS works');
{
  const preflight = async (world: World) => {
    install(world);
    try {
      await quietly(() => checkCloudflare(options, 'fake-token'));
      return null;
    } catch (error) {
      return (error as Error).message;
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const cf = ['daisy.ns.cloudflare.com', 'jarred.ns.cloudflare.com'];

  const pending = await preflight({ handles: {}, repos: {}, zoneStatus: 'pending', nameservers: cf });
  assert(pending !== null && /pending/.test(pending), 'a pending zone stops the run');

  const porkbun = await preflight({
    handles: {},
    repos: {},
    zoneStatus: 'active',
    nameservers: ['curitiba.ns.porkbun.com', 'fortaleza.ns.porkbun.com'],
  });
  assert(porkbun !== null && /porkbun/.test(porkbun), 'registrar nameservers stop the run, naming what DNS sees');

  const ready = await preflight({ handles: {}, repos: {}, zoneStatus: 'active', nameservers: cf });
  equal(ready, null, 'an active zone delegated to Cloudflare, with a visible test record, passes');
  console.log();
}

// ---------------------------------------------------------------------------
console.log('6. Config catch-up at apply time (isolated child process)');
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehandle-apply-'));
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, REHANDLE_TEST_CHILD: 'apply', TWEETS2BSKY_DATA_DIR: dataDir, NO_COLOR: '1' },
    encoding: 'utf8',
  });
  const line = (child.stdout ?? '').split('\n').find((l: string) => l.startsWith('CHILD_RESULT='));
  fs.rmSync(dataDir, { recursive: true, force: true });

  if (!line) {
    assert(false, `child process reported results  (exit ${child.status}: ${(child.stderr ?? '').slice(0, 300)})`);
  } else {
    const r = JSON.parse(line.slice('CHILD_RESULT='.length));
    assert(r.dataDir === dataDir, 'the child wrote only to its throwaway data directory');
    equal(
      r.byDid,
      { status: 'config-catch-up', entry: 'config-catch-up', identifier: 'jersey-met.xmirror.bot' },
      'old handle refused, DID login accepted: config.json catches up to the new handle',
    );
    equal(
      r.badPassword,
      { status: 'config-catch-up', entry: null, identifier: 'jersey-met.bsky.social' },
      'a password that no longer works leaves config.json untouched',
    );
    equal(
      r.wrongAccount,
      { status: 'config-catch-up', entry: null, identifier: 'jersey-met.bsky.social' },
      'logging in as a different account leaves config.json untouched',
    );
  }
  console.log();
}

// ---------------------------------------------------------------------------
console.log('7. Waiting for a new record (the jersey_metci failure)');
{
  const NAME = '_atproto.jersey-metci.xmirror.bot';
  const VALUE = 'did=did:plc:pqruslbj2g557pydocutd4xs';

  /** DoH fake: each resolver either has the record or answers empty. Logs query times. */
  const doh = (sees: { cloudflare: boolean; google: boolean }) => {
    const queries: number[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      queries.push(Date.now());
      const has = url.hostname === 'cloudflare-dns.com' ? sees.cloudflare : sees.google;
      return json({ Answer: has ? [{ type: 16, data: `"${VALUE}"` }] : [] });
    }) as typeof fetch;
    return queries;
  };
  const fast = { intervalMs: 40, timeoutMs: 500 };

  try {
    // Google stuck on a cached "does not exist", Cloudflare and Bluesky already see it.
    doh({ cloudflare: true, google: false });
    let confirmCalls = 0;
    const rescued = await waitForTxt(NAME, VALUE, {
      ...fast,
      confirm: { name: 'bluesky', check: async () => ++confirmCalls > 0 },
    });
    assert(rescued.resolved, 'a lagging Google no longer fails the account when Bluesky confirms');
    equal(rescued.resolversAgreeing, ['cloudflare', 'bluesky'], 'and reports who actually verified it');

    doh({ cloudflare: true, google: false });
    const unconfirmed = await waitForTxt(NAME, VALUE, {
      ...fast,
      confirm: { name: 'bluesky', check: async () => false },
    });
    assert(!unconfirmed.resolved, 'if Bluesky does not see it either, it still waits and times out');

    doh({ cloudflare: true, google: false });
    assert(
      !(await waitForTxt(NAME, VALUE, fast)).resolved,
      'without a confirm check, both resolvers are still required',
    );

    // Nothing sees the record yet: Bluesky must not be asked, or it could cache the miss.
    doh({ cloudflare: false, google: false });
    let askedEarly = false;
    await waitForTxt(NAME, VALUE, {
      ...fast,
      confirm: {
        name: 'bluesky',
        check: async () => {
          askedEarly = true;
          return true;
        },
      },
    });
    assert(!askedEarly, 'Bluesky is never asked before a public resolver sees the record');

    doh({ cloudflare: true, google: true });
    let confirmUsed = false;
    const both = await waitForTxt(NAME, VALUE, {
      ...fast,
      confirm: {
        name: 'bluesky',
        check: async () => {
          confirmUsed = true;
          return true;
        },
      },
    });
    assert(both.resolved && !confirmUsed, 'when both resolvers agree, no extra Bluesky lookup is made');

    // The settle delay: no query at all before it elapses.
    const queries = doh({ cloudflare: true, google: true });
    const startedAt = Date.now();
    await waitForTxt(NAME, VALUE, { ...fast, initialDelayMs: 250 });
    assert(
      queries.length > 0 && (queries[0] ?? 0) - startedAt >= 240,
      'nothing is queried until the settle delay has passed',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log();
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
