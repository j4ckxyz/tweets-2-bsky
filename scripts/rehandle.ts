#!/usr/bin/env bun
/**
 * Bulk-migrate tweets-2-bsky mappings onto `<twitter-handle>.<domain>` handles.
 *
 * Dry run is the default. Nothing is written to Cloudflare, Bluesky or
 * config.json unless you pass --apply.
 *
 * Usage (from the tweets-2-bsky directory):
 *   bun scripts/rehandle.ts --check-cloudflare
 *   bun scripts/rehandle.ts                       # dry run, 3 random accounts
 *   bun scripts/rehandle.ts --all                 # dry run, every account
 *   bun scripts/rehandle.ts --apply --limit 3     # do it, 3 random accounts
 *   bun scripts/rehandle.ts --apply --only alice --only bob
 *
 * Requires CLOUDFLARE_API_TOKEN (in .env or the environment) with
 * Zone -> DNS -> Edit on the target zone.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtpAgent } from '@atproto/api';
import { type AccountMapping, getConfig, saveConfig } from '../src/config-manager.js';
import { DATA_DIR } from '../src/storage-paths.js';
import {
  CloudflareClient,
  type DnsRecord,
  isCloudflareDelegation,
  resolveNs,
  unquoteTxt,
  upsertTxtRecord,
  waitForTxt,
} from './lib/cloudflare.js';
import { type HandleConversion, convertHandle, findCollisions } from './lib/handle-map.js';

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DOMAIN = 'xmirror.bot';

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const cyan = paint('36');

export const log = (message = '') => console.log(message);
export const heading = (message: string) => log(`\n${bold(message)}\n${dim('-'.repeat(message.length))}`);

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface Options {
  domain: string;
  zoneId: string | null;
  limit: number;
  all: boolean;
  only: string[];
  apply: boolean;
  yes: boolean;
  checkCloudflare: boolean;
  writeTest: boolean;
  ttl: number;
  seed: string | null;
  includeDisabled: boolean;
  dnsTimeoutMs: number;
  help: boolean;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    domain: DEFAULT_DOMAIN,
    zoneId: null,
    limit: 3,
    all: false,
    only: [],
    apply: false,
    yes: false,
    checkCloudflare: false,
    writeTest: true,
    ttl: 60,
    seed: null,
    includeDisabled: false,
    dnsTimeoutMs: 180_000,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value.`);
      return value;
    };

    switch (arg) {
      case '--domain':
        options.domain = next();
        break;
      case '--limit':
        options.limit = Number.parseInt(next(), 10);
        break;
      case '--all':
        options.all = true;
        break;
      case '--only':
        options.only.push(next());
        break;
      case '--apply':
        options.apply = true;
        break;
      case '--yes':
      case '-y':
        options.yes = true;
        break;
      case '--check-cloudflare':
        options.checkCloudflare = true;
        break;
      case '--no-write-test':
        options.writeTest = false;
        break;
      case '--ttl':
        options.ttl = Number.parseInt(next(), 10);
        break;
      case '--seed':
        options.seed = next();
        break;
      case '--include-disabled':
        options.includeDisabled = true;
        break;
      case '--dns-timeout':
        options.dnsTimeoutMs = Number.parseInt(next(), 10) * 1000;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(options.limit) || options.limit < 1) throw new Error('--limit must be a positive integer.');
  if (!Number.isFinite(options.ttl) || options.ttl < 60) throw new Error('--ttl must be at least 60 seconds.');
  return options;
}

const HELP = `
${bold('rehandle')} - migrate tweets-2-bsky accounts to <twitter-handle>.<domain>

  ${bold('Dry run is the default.')} Add --apply to make real changes.

  --check-cloudflare    Verify the Cloudflare token, zone and DNS write access, then exit
  --domain <name>       Base domain for the new handles (default: xmirror.bot)
  --zone-id <id>        Cloudflare zone id, to skip the zone lookup (or set CLOUDFLARE_ZONE_ID).
                        Lets the token get by with only Zone -> DNS -> Edit.
  --limit <n>           How many accounts to act on (default: 3)
  --all                 Act on every mapping instead of a random sample
  --only <handle>       Target a specific account by Bluesky handle or Twitter username (repeatable)
  --seed <string>       Make the random sample reproducible
  --include-disabled    Include mappings with enabled: false
  --apply               Actually write DNS, change handles and update config.json
  --yes, -y             Skip the confirmation prompt when applying
  --ttl <seconds>       TTL for the created TXT records (default: 60)
  --dns-timeout <secs>  How long to wait for DNS propagation (default: 180)
  --no-write-test       During --check-cloudflare, skip the temporary record write/delete
  --help, -h            Show this message

  Set CLOUDFLARE_API_TOKEN in .env or the environment.
  Token needs Zone -> DNS -> Edit, plus Zone -> Zone -> Read unless you supply
  CLOUDFLARE_ZONE_ID (copy it from the domain's Overview page in the dashboard).
`;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Bun auto-loads .env, but read it explicitly so tsx/node runs behave the same. */
export function loadEnvFile(): void {
  const envPath = path.join(APP_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;

  for (const rawLine of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function getCloudflareToken(): string | null {
  const token = (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '').trim();
  return token || null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Deterministic PRNG so --seed produces a repeatable sample. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/** The Twitter username a mapping's handle should be derived from. */
export function sourceUsernameFor(mapping: AccountMapping): string | null {
  return mapping.profileSyncSourceUsername ?? mapping.twitterUsernames[0] ?? null;
}

export function selectMappings(mappings: AccountMapping[], options: Options): AccountMapping[] {
  let pool = mappings;
  if (!options.includeDisabled) pool = pool.filter((m) => m.enabled);

  if (options.only.length > 0) {
    const wanted = new Set(options.only.map((value) => value.trim().replace(/^@/, '').toLowerCase()));
    return pool.filter(
      (m) => wanted.has(m.bskyIdentifier.toLowerCase()) || m.twitterUsernames.some((u) => wanted.has(u.toLowerCase())),
    );
  }

  if (options.all) return pool;

  const random = options.seed ? seededRandom(options.seed) : Math.random;
  return shuffle(pool, random).slice(0, options.limit);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * - ready:           needs DNS + a handle change
 * - config-catch-up: Bluesky already has the new handle but config.json does not
 *                    (a previous run was interrupted after the change landed)
 * - already-correct: nothing to do
 * - blocked:         cannot proceed; see blockers
 */
export type PlanStatus = 'ready' | 'config-catch-up' | 'already-correct' | 'blocked';

/** Plans the apply step should act on. */
export const isActionable = (plan: Plan): boolean => plan.status === 'ready' || plan.status === 'config-catch-up';

export interface Plan {
  mapping: AccountMapping;
  sourceUsername: string | null;
  conversion: HandleConversion | null;
  currentHandle: string;
  newHandle: string | null;
  txtName: string | null;
  did: string | null;
  didError: string | null;
  /** The handle Bluesky itself reports for the DID, or null if it could not be read. */
  blueskyHandle: string | null;
  existingRecord: DnsRecord | null;
  status: PlanStatus;
  blockers: string[];
}

async function resolveDid(handle: string, serviceUrl: string): Promise<string> {
  const url = `${serviceUrl.replace(/\/+$/, '')}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  const response = await fetch(url);
  const body = (await response.json()) as { did?: string; message?: string };
  if (!response.ok || !body.did) {
    throw new Error(body.message || `resolveHandle failed with HTTP ${response.status}`);
  }
  return body.did;
}

async function describeRepoHandle(did: string, serviceUrl: string): Promise<string> {
  const url = `${serviceUrl.replace(/\/+$/, '')}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(did)}`;
  const response = await fetch(url);
  const body = (await response.json()) as { handle?: string; message?: string };
  if (!response.ok || !body.handle) {
    throw new Error(body.message || `describeRepo failed with HTTP ${response.status}`);
  }
  return body.handle;
}

export async function buildPlan(
  mapping: AccountMapping,
  options: Options,
  cloudflare: { client: CloudflareClient; zoneId: string } | null,
): Promise<Plan> {
  const sourceUsername = sourceUsernameFor(mapping);
  const currentHandle = mapping.bskyIdentifier;
  const serviceUrl = mapping.bskyServiceUrl ?? 'https://bsky.social';
  const blockers: string[] = [];

  if (!sourceUsername) {
    return {
      mapping,
      sourceUsername: null,
      conversion: null,
      currentHandle,
      newHandle: null,
      txtName: null,
      did: null,
      didError: null,
      blueskyHandle: null,
      existingRecord: null,
      status: 'blocked',
      blockers: ['Mapping has no Twitter username to derive a handle from.'],
    };
  }

  const conversion = convertHandle(sourceUsername, options.domain);
  blockers.push(...conversion.errors);

  // The DID is resolvable without credentials, so a dry run can show the exact
  // TXT record it would write.
  let did: string | null = null;
  let didError: string | null = null;
  try {
    did = await resolveDid(currentHandle, serviceUrl);
  } catch (error) {
    didError = (error as Error).message;
  }

  // If the handle in config.json no longer resolves, a previous run may have
  // changed the handle on Bluesky and been interrupted before saving config.
  // Check whether the target handle already points at an account that claims it.
  // Ownership is proven later, at apply time, by logging in with the stored password.
  if (!did && conversion.handle) {
    try {
      const candidate = await resolveDid(conversion.handle, serviceUrl);
      if ((await describeRepoHandle(candidate, serviceUrl)) === conversion.handle) {
        did = candidate;
        didError = null;
      }
    } catch {
      // Not migrated either; report the original resolution error below.
    }
  }

  if (!did) {
    blockers.push(`Could not resolve the current handle "${currentHandle}": ${didError}`);
  }

  let blueskyHandle: string | null = null;
  if (did) {
    try {
      blueskyHandle = await describeRepoHandle(did, serviceUrl);
    } catch {
      // Fall back to trusting config.json below.
    }
  }

  const txtName = conversion.handle ? `_atproto.${conversion.handle}` : null;

  let existingRecord: DnsRecord | null = null;
  if (cloudflare && txtName) {
    try {
      existingRecord = await cloudflare.client.findTxtRecord(cloudflare.zoneId, txtName);
    } catch (error) {
      blockers.push(`Could not read existing DNS records: ${(error as Error).message}`);
    }
  }

  if (!mapping.bskyPassword) {
    blockers.push('Mapping has no Bluesky app password stored; the handle change cannot be authenticated.');
  }

  const configMatches = conversion.handle !== null && currentHandle.toLowerCase() === conversion.handle;
  // Prefer what Bluesky reports; only trust config.json when Bluesky could not be read.
  const blueskyMatches = blueskyHandle === null ? configMatches : blueskyHandle === conversion.handle;

  const status: PlanStatus =
    blockers.length > 0
      ? 'blocked'
      : blueskyMatches && configMatches
        ? 'already-correct'
        : blueskyMatches
          ? 'config-catch-up'
          : 'ready';

  return {
    mapping,
    sourceUsername,
    conversion,
    currentHandle,
    newHandle: conversion.handle,
    txtName,
    did,
    didError,
    blueskyHandle,
    existingRecord,
    status,
    blockers,
  };
}

export interface DuplicateSource {
  twitterUsername: string;
  bskyIdentifiers: string[];
}

/**
 * The same Twitter account listed under two mappings means two Bluesky accounts
 * mirror the same tweets. It does not block a handle change, but it is almost
 * always a config mistake worth surfacing.
 */
export function findDuplicateTwitterSources(mappings: AccountMapping[]): DuplicateSource[] {
  const holders = new Map<string, string[]>();
  for (const mapping of mappings) {
    for (const username of mapping.twitterUsernames) {
      const list = holders.get(username) ?? [];
      list.push(mapping.bskyIdentifier);
      holders.set(username, list);
    }
  }
  return [...holders.entries()]
    .filter(([, identifiers]) => identifiers.length > 1)
    .map(([twitterUsername, bskyIdentifiers]) => ({ twitterUsername, bskyIdentifiers }));
}

/**
 * A generated handle may already be held by a *different* mapping in the config.
 * Two accounts cannot share a handle, so this has to block the run.
 */
export function findExternalClashes(plans: Plan[], allMappings: AccountMapping[]): string[] {
  const claimedBy = new Map<string, string>();
  for (const plan of plans) {
    if (plan.newHandle) claimedBy.set(plan.newHandle, plan.mapping.id);
  }
  return allMappings
    .filter((m) => {
      const claimant = claimedBy.get(m.bskyIdentifier.toLowerCase());
      return claimant !== undefined && claimant !== m.id;
    })
    .map((m) => m.bskyIdentifier);
}

export function printPlan(plan: Plan, index: number, total: number): void {
  const label =
    plan.status === 'ready'
      ? green('READY')
      : plan.status === 'config-catch-up'
        ? yellow('CONFIG CATCH-UP')
        : plan.status === 'already-correct'
          ? cyan('ALREADY CORRECT')
          : red('BLOCKED');

  log(`\n${bold(`[${index + 1}/${total}]`)} ${label}`);
  log(`  Twitter username : @${plan.sourceUsername ?? dim('(none)')}`);
  if (plan.mapping.twitterUsernames.length > 1) {
    const others = plan.mapping.twitterUsernames
      .filter((u) => u !== plan.sourceUsername)
      .map((u) => `@${u}`)
      .join(', ');
    log(`  ${dim(`(mapping also covers: ${others})`)}`);
  }
  log(`  Current handle   : ${plan.currentHandle}`);
  if (plan.blueskyHandle && plan.blueskyHandle !== plan.currentHandle.toLowerCase()) {
    log(`  On Bluesky       : ${yellow(plan.blueskyHandle)} ${dim('(config.json is behind)')}`);
  }
  log(`  New handle       : ${plan.newHandle ? bold(green(plan.newHandle)) : red('n/a')}`);
  log(`  DID              : ${plan.did ?? red(plan.didError ?? 'unresolved')}`);

  if (plan.txtName && plan.did) {
    log(`  DNS record       : ${bold('TXT')} ${plan.txtName}`);
    log(`                     "did=${plan.did}"`);
    if (plan.existingRecord) {
      const matches = unquoteTxt(plan.existingRecord.content) === `did=${plan.did}`;
      log(
        `  Existing record  : ${matches ? green('present and correct (will skip)') : yellow(`present but differs: "${plan.existingRecord.content}" (will update)`)}`,
      );
    } else {
      log(`  Existing record  : ${dim('none (will create)')}`);
    }
  }

  for (const note of plan.conversion?.notes ?? []) {
    log(`  ${note.level === 'warn' ? yellow(`! ${note.message}`) : dim(`. ${note.message}`)}`);
  }
  for (const blocker of plan.blockers) {
    log(`  ${red(`x ${blocker}`)}`);
  }
}

// ---------------------------------------------------------------------------
// Cloudflare preflight
// ---------------------------------------------------------------------------

const WRITE_TEST_TIMEOUT_MS = 90_000;

export async function checkCloudflare(
  options: Options,
  token: string,
): Promise<{ client: CloudflareClient; zoneId: string }> {
  heading(`Cloudflare preflight (${options.domain})`);

  const client = new CloudflareClient(token);

  const status = await client.verifyToken();
  log(`  ${green('OK')} Token is valid (id ${status.id.slice(0, 8)}..., status: ${status.status})`);
  if (status.expires_on) log(`  ${yellow('!')}  Token expires on ${status.expires_on}`);

  // Looking a zone up by name needs Zone -> Zone -> Read. When the zone id is
  // supplied we skip that call entirely, so the token only needs DNS -> Edit.
  const suppliedZoneId = options.zoneId ?? process.env.CLOUDFLARE_ZONE_ID?.trim() ?? null;
  let zoneId: string;
  if (suppliedZoneId) {
    zoneId = suppliedZoneId;
    log(`  ${green('OK')} Using the zone id you supplied (${zoneId.slice(0, 8)}...); skipping the zone lookup`);
  } else {
    const zone = await client.getZone(options.domain);
    log(`  ${green('OK')} Zone found: ${zone.name} (id ${zone.id.slice(0, 8)}..., status: ${zone.status})`);
    if (zone.status !== 'active') {
      throw new Error(
        `The ${zone.name} zone is "${zone.status}", not "active": Cloudflare has not seen the nameserver change yet. Records written now would be invisible to Bluesky. Wait for the zone to turn active, then run this again.`,
      );
    }
    zoneId = zone.id;
  }

  // What actually decides whether Bluesky can see our records is the public
  // delegation, not the Cloudflare API. This also covers the --zone-id path,
  // which skips the zone lookup and so never sees its status.
  const nameservers = await resolveNs(options.domain);
  if (!isCloudflareDelegation(nameservers)) {
    throw new Error(
      `Public DNS delegates ${options.domain} to ${nameservers.join(', ') || 'nothing'}, not Cloudflare. Set the nameservers at your registrar to the two Cloudflare gives you, then run this again.`,
    );
  }
  log(`  ${green('OK')} Public DNS delegates ${options.domain} to Cloudflare (${nameservers.join(', ')})`);

  if (!options.writeTest) {
    log(`  ${dim('.  Write test skipped (--no-write-test). Read access confirmed only.')}`);
    return { client, zoneId };
  }

  // Read access does not prove Zone:DNS:Edit, and a successful API write does not
  // prove the record is publicly visible. Write a scratch record and wait for it
  // to resolve. The name is unique per run so a negative answer cached from an
  // earlier check cannot make this one fail.
  const testName = `_rehandle-check-${Date.now().toString(36)}.${options.domain}`;
  const testValue = `rehandle-check=${Date.now()}`;
  log(`  ${dim(`.  Write test: creating temporary TXT ${testName}`)}`);

  const record = await client.createTxtRecord(zoneId, testName, testValue, 60, 'temporary rehandle.ts check');
  log(`  ${green('OK')} DNS write succeeded (record id ${record.id.slice(0, 8)}...)`);

  let visible: Awaited<ReturnType<typeof waitForTxt>>;
  try {
    process.stdout.write(`  ${dim('.  waiting for it to appear in public DNS')}`);
    visible = await waitForTxt(testName, testValue, {
      timeoutMs: WRITE_TEST_TIMEOUT_MS,
      intervalMs: 3_000,
      onAttempt: () => process.stdout.write(dim('.')),
    });
    log('');
    if (visible.resolved) {
      log(
        `  ${green('OK')} Visible to ${visible.resolversAgreeing.join(' + ')} after ${Math.round(visible.elapsedMs / 1000)}s`,
      );
    }
  } finally {
    await client.deleteRecord(zoneId, record.id);
    log(`  ${green('OK')} Temporary record deleted`);
  }

  if (!visible.resolved) {
    throw new Error(
      `The test record was written but was not publicly visible within ${WRITE_TEST_TIMEOUT_MS / 1000}s. Bluesky would not see handle records either. Check the zone is active and the nameservers have propagated.`,
    );
  }

  return { client, zoneId };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface JournalEntry {
  kind: 'handle-change' | 'config-catch-up';
  mappingId: string;
  twitterUsername: string;
  did: string;
  oldHandle: string;
  newHandle: string;
  dnsRecordId: string | null;
  dnsAction: string;
  changedAt: string;
  configUpdated: boolean;
}

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Snapshot config.json before any handle is touched. Returns the backup path. */
export function backupConfig(): string {
  const backupPath = path.join(DATA_DIR, `config.rehandle-backup-${timestamp()}.json`);
  fs.writeFileSync(backupPath, `${JSON.stringify(getConfig(), null, 2)}\n`, { mode: 0o600 });
  return backupPath;
}

/** Record what actually changed. Returns the journal path. */
export function writeJournal(entries: JournalEntry[]): string {
  const journalPath = path.join(DATA_DIR, `rehandle-journal-${timestamp()}.json`);
  fs.writeFileSync(journalPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  return journalPath;
}

/**
 * Re-read config immediately before writing and mutate only this one mapping,
 * so a concurrently running tweets-2-bsky service cannot have its own writes
 * clobbered by a stale in-memory copy.
 */
function persistNewHandle(mappingId: string, newHandle: string): boolean {
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === mappingId);
  if (!mapping) return false;
  mapping.bskyIdentifier = newHandle;
  saveConfig(config);
  return true;
}

/**
 * Log in with the identifier from config.json, falling back to the DID. The
 * PDS accepts a DID as a login identifier, so this still works when config.json
 * holds a handle Bluesky no longer recognises.
 */
async function login(serviceUrl: string, identifiers: string[], password: string): Promise<AtpAgent> {
  let lastError: unknown;
  for (const identifier of [...new Set(identifiers)]) {
    const agent = new AtpAgent({ service: serviceUrl });
    try {
      await agent.login({ identifier, password });
      return agent;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function applyPlan(
  plan: Plan,
  options: Options,
  cloudflare: { client: CloudflareClient; zoneId: string },
): Promise<JournalEntry | null> {
  const { mapping, newHandle, txtName, did } = plan;
  if (!newHandle || !txtName || !did) return null;

  const serviceUrl = mapping.bskyServiceUrl ?? 'https://bsky.social';
  const content = `did=${did}`;

  log(`\n${bold(`@${plan.sourceUsername}`)}  ${plan.currentHandle} ${dim('->')} ${bold(newHandle)}`);

  const entry = (kind: JournalEntry['kind'], dnsAction: string, dnsRecordId: string | null): JournalEntry => ({
    kind,
    mappingId: mapping.id,
    twitterUsername: plan.sourceUsername ?? '',
    did,
    oldHandle: plan.currentHandle,
    newHandle,
    dnsRecordId,
    dnsAction,
    changedAt: new Date().toISOString(),
    configUpdated: true,
  });

  // Bluesky already has the new handle; only config.json is behind.
  if (plan.status === 'config-catch-up') {
    let agent: AtpAgent;
    try {
      agent = await login(serviceUrl, [mapping.bskyIdentifier, newHandle, did], mapping.bskyPassword);
    } catch (error) {
      log(`  ${red('x')}  Could not log in to confirm ownership: ${(error as Error).message}`);
      return null;
    }
    if (agent.session?.did !== did) {
      log(`  ${red('x')}  Logged in as ${agent.session?.did}, expected ${did}. Leaving config.json alone.`);
      return null;
    }
    if (!persistNewHandle(mapping.id, newHandle)) {
      log(`  ${red('x')}  config.json NOT updated - mapping ${mapping.id} disappeared. Fix this by hand.`);
      return null;
    }
    log(`  ${green('OK')} Bluesky already had ${newHandle}; config.json caught up`);
    return entry('config-catch-up', 'not-needed', null);
  }

  // 1. DNS
  const upsert = await upsertTxtRecord(
    cloudflare.client,
    cloudflare.zoneId,
    txtName,
    content,
    options.ttl,
    `atproto handle for @${plan.sourceUsername} (tweets-2-bsky)`,
  );
  log(`  ${green('OK')} DNS TXT ${upsert.action}: ${txtName} = "${content}"`);

  // 2. Wait for the record to be publicly visible before asking the PDS to verify it.
  process.stdout.write(`  ${dim('.  waiting for DNS propagation')}`);
  const propagation = await waitForTxt(txtName, content, {
    timeoutMs: options.dnsTimeoutMs,
    onAttempt: () => process.stdout.write(dim('.')),
  });
  log('');
  if (!propagation.resolved) {
    log(
      `  ${red('x')}  TXT record did not propagate within ${Math.round(options.dnsTimeoutMs / 1000)}s. Saw: ${JSON.stringify(propagation.seenValues)}`,
    );
    log(`  ${dim('   The DNS record is in place; re-run for this account once it propagates.')}`);
    return null;
  }
  log(
    `  ${green('OK')} DNS verified by ${propagation.resolversAgreeing.join(' + ')} after ${Math.round(propagation.elapsedMs / 1000)}s`,
  );

  // 3. Log in and change the handle.
  let agent: AtpAgent;
  try {
    agent = await login(serviceUrl, [mapping.bskyIdentifier, did], mapping.bskyPassword);
  } catch (error) {
    log(`  ${red('x')}  Bluesky login failed for ${mapping.bskyIdentifier}: ${(error as Error).message}`);
    return null;
  }

  const sessionDid = agent.session?.did;
  if (sessionDid !== did) {
    log(
      `  ${red('x')}  DID mismatch: DNS record was written for ${did} but the session is ${sessionDid}. Aborting this account.`,
    );
    return null;
  }

  try {
    await agent.com.atproto.identity.updateHandle({ handle: newHandle });
  } catch (error) {
    const message = (error as Error).message;
    log(`  ${red('x')}  updateHandle failed: ${message}`);
    if (/auth|scope|password|privileged/i.test(message)) {
      log(`  ${dim("   If this is an app-password restriction, retry with the account's main password.")}`);
    }
    return null;
  }
  log(`  ${green('OK')} Handle changed on ${serviceUrl}`);

  // 4. Save config.json straight away. The longer this waits after the handle
  //    change, the wider the window in which an interruption leaves the service
  //    logging in with a handle Bluesky no longer knows.
  const configUpdated = persistNewHandle(mapping.id, newHandle);
  log(
    configUpdated
      ? `  ${green('OK')} config.json updated (bskyIdentifier -> ${newHandle})`
      : `  ${red('x')}  config.json NOT updated - mapping ${mapping.id} disappeared. Fix this by hand.`,
  );

  // 5. Confirm from the PDS itself (not DNS, which may still be cached).
  try {
    const confirmed = await describeRepoHandle(did, serviceUrl);
    log(
      confirmed === newHandle
        ? `  ${green('OK')} PDS confirms handle is now ${confirmed}`
        : `  ${yellow('!')}  PDS reports handle as "${confirmed}", expected "${newHandle}"`,
    );
  } catch (error) {
    log(`  ${yellow('!')}  Could not confirm the new handle: ${(error as Error).message}`);
  }

  return { ...entry('handle-change', upsert.action, upsert.record.id ?? null), configUpdated };
}

function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} `);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.pause();
      resolve(data.toString().trim().toLowerCase() === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    log(red((error as Error).message));
    log(HELP);
    return 2;
  }

  if (options.help) {
    log(HELP);
    return 0;
  }

  loadEnvFile();

  log(bold('\ntweets-2-bsky handle migration'));
  log(dim(options.apply ? 'MODE: APPLY - real changes will be made' : 'MODE: DRY RUN - nothing will be changed'));

  const token = getCloudflareToken();

  // --- Cloudflare -----------------------------------------------------------
  let cloudflare: { client: CloudflareClient; zoneId: string } | null = null;
  if (token) {
    try {
      cloudflare = await checkCloudflare(options, token);
    } catch (error) {
      log(`  ${red(`x  ${(error as Error).message}`)}`);
      if (options.apply) return 1;
      log(`  ${yellow('!')}  Continuing the dry run without Cloudflare; existing-record checks are skipped.`);
    }
  } else {
    heading('Cloudflare preflight');
    log(`  ${yellow('!')}  CLOUDFLARE_API_TOKEN is not set. Add it to .env to enable DNS checks.`);
    if (options.apply) {
      log(`  ${red('x')}  --apply requires a Cloudflare token.`);
      return 1;
    }
  }

  if (options.checkCloudflare) {
    log(`\n${cloudflare ? green('Cloudflare check complete.') : red('Cloudflare check failed.')}`);
    return cloudflare ? 0 : 1;
  }

  // --- Load and select ------------------------------------------------------
  const config = getConfig();
  if (config.mappings.length === 0) {
    log(`\n${red('No mappings found in config.json.')} Nothing to do.`);
    return 1;
  }

  const selected = selectMappings(config.mappings, options);
  heading('Accounts');
  const scope =
    options.only.length > 0 ? '--only filter' : options.all ? 'all mappings' : `random sample of ${options.limit}`;
  log(`  ${config.mappings.length} mapping(s) in config.json; selected ${selected.length} (${scope}).`);
  if (options.seed) log(`  ${dim(`Sample seed: ${options.seed}`)}`);

  if (selected.length === 0) {
    log(`\n${red('Nothing selected.')} Check --only / --include-disabled.`);
    return 1;
  }

  // --- Plan -----------------------------------------------------------------
  heading('Planned changes');
  const plans: Plan[] = [];
  for (const mapping of selected) {
    plans.push(await buildPlan(mapping, options, cloudflare));
  }
  plans.forEach((plan, i) => printPlan(plan, i, plans.length));

  const collisions = findCollisions(plans.map((p) => p.conversion).filter((c): c is HandleConversion => c !== null));
  const externalClashes = findExternalClashes(plans, config.mappings);

  if (collisions.length > 0 || externalClashes.length > 0) {
    heading('Handle collisions');
    for (const collision of collisions) {
      log(
        `  ${red('x')}  ${collision.handle} would be claimed by: ${collision.sources.map((s) => `@${s}`).join(', ')}`,
      );
    }
    for (const clash of externalClashes) {
      log(`  ${red('x')}  ${clash} is already used by a different mapping in config.json`);
    }
    log(
      `\n  ${red('Refusing to continue.')} Resolve these by hand (e.g. give one account a different handle) and re-run.`,
    );
    return 1;
  }

  const duplicates = findDuplicateTwitterSources(config.mappings);
  if (duplicates.length > 0) {
    heading('Duplicate Twitter sources');
    for (const duplicate of duplicates) {
      log(`  ${yellow('!')}  @${duplicate.twitterUsername} is mirrored by ${duplicate.bskyIdentifiers.join(' and ')}`);
    }
    log(`  ${dim('Not a handle problem - both accounts post the same tweets. Worth fixing in the dashboard.')}`);
  }

  const ready = plans.filter(isActionable);
  const catchUp = plans.filter((p) => p.status === 'config-catch-up');
  const blocked = plans.filter((p) => p.status === 'blocked');
  const alreadyCorrect = plans.filter((p) => p.status === 'already-correct');

  heading('Summary');
  log(
    `  ${green(`${ready.length - catchUp.length} ready`)}   ${catchUp.length > 0 ? `${yellow(`${catchUp.length} config catch-up`)}   ` : ''}${cyan(`${alreadyCorrect.length} already correct`)}   ${blocked.length > 0 ? red(`${blocked.length} blocked`) : '0 blocked'}`,
  );

  if (!options.apply) {
    log(`\n${dim('Dry run complete. No DNS records, handles or config entries were changed.')}`);
    log(dim(`Re-run with --apply to perform ${ready.length} change(s).`));
    return blocked.length > 0 ? 1 : 0;
  }

  if (ready.length === 0) {
    log(`\n${yellow('Nothing to apply.')}`);
    return blocked.length > 0 ? 1 : 0;
  }

  // --- Apply ----------------------------------------------------------------
  if (!options.yes) {
    log(`\n${yellow('This will change live Bluesky handles and DNS records.')}`);
    log(
      dim(
        'Stop the tweets-2-bsky service first (e.g. `pm2 stop tweets-2-bsky`) so it cannot write config.json underneath this script.',
      ),
    );
    if (!(await confirm(`Type ${bold('yes')} to apply ${ready.length} handle change(s):`))) {
      log('\nAborted. Nothing was changed.');
      return 0;
    }
  }

  heading('Applying');
  const backupPath = backupConfig();
  log(`  ${green('OK')} config.json backed up to ${backupPath}`);

  const journal: JournalEntry[] = [];
  for (const plan of ready) {
    try {
      const entry = await applyPlan(plan, options, cloudflare as { client: CloudflareClient; zoneId: string });
      if (entry) journal.push(entry);
    } catch (error) {
      log(`  ${red(`x  Unhandled error for @${plan.sourceUsername}: ${(error as Error).message}`)}`);
    }
    // updateHandle is rate limited to 10 per 5 minutes per account; a small
    // pause also keeps us well clear of Cloudflare's limits.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const journalPath = writeJournal(journal);

  heading('Done');
  log(`  ${journal.length}/${ready.length} account(s) migrated.`);
  log(`  Journal: ${journalPath}`);
  if (journal.length > 0) {
    log(
      `\n  ${yellow('Note:')} the old handles (${journal.map((e) => e.oldHandle).join(', ')}) are now released and could be claimed by someone else.`,
    );
    log(`  ${dim('Restart the service when you are happy: `pm2 start tweets-2-bsky`')}`);
  }

  return journal.length === ready.length ? 0 : 1;
}

// Only run when invoked directly, so the test suite can import the helpers above.
if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(red(`\nFatal: ${(error as Error).stack ?? error}`));
      process.exit(1);
    });
}
