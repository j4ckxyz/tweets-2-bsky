#!/usr/bin/env bun
/**
 * Interactive front end for the handle migration.
 *
 *   bun run wizard
 *
 * Walks through the domain, the Cloudflare token, which accounts to move, and a
 * full preview, before anything is changed. Everything it does is also
 * reachable through scripts/rehandle.ts flags; this just removes the need to
 * remember them.
 *
 * The prompt-free helpers below are exported so scripts/test-rehandle.ts can
 * cover them without driving a terminal.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import inquirer from 'inquirer';
import { type AccountMapping, getConfig } from '../src/config-manager.js';
import type { CloudflareClient } from './lib/cloudflare.js';
import { type HandleConversion, convertHandle, findCollisions, validateHandle } from './lib/handle-map.js';
import {
  type JournalEntry,
  type Options,
  type Plan,
  applyPlan,
  backupConfig,
  bold,
  buildPlan,
  checkCloudflare,
  cyan,
  dim,
  findDuplicateTwitterSources,
  findExternalClashes,
  green,
  heading,
  loadEnvFile,
  log,
  parseArgs,
  printPlan,
  red,
  sourceUsernameFor,
  writeJournal,
  yellow,
} from './rehandle.js';

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal structural type for inquirer.prompt. Each step takes one of these so
 * scripts/test-wizard-prompts.ts can drive the real prompt definitions through
 * injected streams instead of a terminal.
 */
export type PromptFn = (questions: readonly object[]) => Promise<Record<string, unknown>>;
export const defaultPrompt = inquirer.prompt as unknown as PromptFn;
const ENV_PATH = path.join(APP_ROOT, '.env');

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/** Validate a base domain the way the handle spec will. Returns true or a message. */
export function validateDomainInput(value: string): true | string {
  const domain = value.trim().toLowerCase();
  if (!domain) return 'Enter a domain, e.g. j4ck.xyz';
  if (domain.split('.').length < 2) return 'A domain needs at least two parts, e.g. j4ck.xyz';
  // Probe it the same way a real handle would be built, so the rules match exactly.
  const errors = validateHandle(`probe.${domain}`);
  return errors.length === 0 ? true : (errors[0] ?? 'That is not a usable handle domain.');
}

/** Show enough of a token to recognise it, never enough to use it. */
export function maskToken(token: string): string {
  if (token.length <= 8) return '*'.repeat(token.length);
  return `${'*'.repeat(token.length - 4)}${token.slice(-4)}`;
}

/**
 * Set KEY=value in .env text, replacing an existing (possibly empty or
 * commented) entry rather than appending a duplicate.
 */
export function upsertEnvVar(contents: string, key: string, value: string): string {
  const lines = contents.split('\n');
  const pattern = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  const index = lines.findIndex((line) => pattern.test(line));

  if (index === -1) {
    const body = contents.length > 0 && !contents.endsWith('\n') ? `${contents}\n` : contents;
    return `${body}${key}=${value}\n`;
  }

  lines[index] = `${key}=${value}`;
  return lines.join('\n');
}

export interface PlanSummary {
  ready: number;
  alreadyCorrect: number;
  blocked: number;
}

export function summarize(plans: Plan[]): PlanSummary {
  return {
    ready: plans.filter((p) => p.status === 'ready').length,
    alreadyCorrect: plans.filter((p) => p.status === 'already-correct').length,
    blocked: plans.filter((p) => p.status === 'blocked').length,
  };
}

/** One-line label for an account in the picker. */
export function describeChoice(mapping: AccountMapping, domain: string): string {
  const username = sourceUsernameFor(mapping);
  const target = username ? convertHandle(username, domain).handle : null;
  const arrow = target ? `-> ${target}` : '-> (cannot convert)';
  return `@${username ?? '?'}  ${mapping.bskyIdentifier} ${arrow}`;
}

/** Pick n items without replacement. */
export function sampleRandom<T>(items: T[], n: number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy.slice(0, n);
}

/** Parse a comma/space separated list of handles or usernames. */
export function parseIdentifierList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((value) => value.trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean),
    ),
  ];
}

// ---------------------------------------------------------------------------
// pm2
// ---------------------------------------------------------------------------

export interface Pm2Process {
  name: string;
  online: boolean;
}

/** Best-effort pm2 lookup. Returns null when pm2 is absent or unreadable. */
export function findPm2Process(name = 'tweets-2-bsky'): Pm2Process | null {
  try {
    const raw = execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const entries = JSON.parse(raw) as { name?: string; pm2_env?: { status?: string } }[];
    const match = entries.find((entry) => entry.name === name);
    if (!match) return null;
    return { name, online: match.pm2_env?.status === 'online' };
  } catch {
    return null;
  }
}

function pm2(action: 'stop' | 'start', name: string): boolean {
  try {
    execFileSync('pm2', [action, name], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

const rule = (width = 60) => dim('-'.repeat(width));

export async function askDomain(ask: PromptFn = defaultPrompt): Promise<string> {
  const stored = process.env.REHANDLE_DOMAIN?.trim();
  const { domain } = (await ask([
    {
      type: 'input',
      name: 'domain',
      message: 'Which domain should the new handles sit under?',
      default: stored || 'j4ck.xyz',
      validate: validateDomainInput,
      filter: (value: string) => value.trim().toLowerCase(),
    },
  ])) as { domain: string };
  return domain;
}

export async function askToken(ask: PromptFn = defaultPrompt, envPath: string = ENV_PATH): Promise<string | null> {
  const existing = (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '').trim();

  if (existing) {
    const { reuse } = (await ask([
      {
        type: 'confirm',
        name: 'reuse',
        message: `Use the Cloudflare token already in .env (${maskToken(existing)})?`,
        default: true,
      },
    ])) as { reuse: boolean };
    if (reuse) return existing;
  }

  log();
  log(dim('  Create one at https://dash.cloudflare.com/profile/api-tokens'));
  log(dim('  Permissions: Zone > DNS > Edit, and Zone > Zone > Read'));
  log(dim('  Zone Resources: Include > Specific zone > your domain'));
  log();

  const { token } = (await ask([
    {
      type: 'password',
      name: 'token',
      message: 'Paste your Cloudflare API token:',
      mask: '*',
      validate: (value: string) => (value.trim().length > 0 ? true : 'The token cannot be empty.'),
    },
  ])) as { token: string };

  const trimmed = token.trim();

  const { save } = (await ask([
    { type: 'confirm', name: 'save', message: 'Save it to .env so you do not have to paste it again?', default: true },
  ])) as { save: boolean };

  if (save) {
    try {
      const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      fs.writeFileSync(envPath, upsertEnvVar(current, 'CLOUDFLARE_API_TOKEN', trimmed), { mode: 0o600 });
      log(`  ${green('OK')} Saved to .env (permissions set to owner-only)`);
    } catch (error) {
      log(`  ${yellow('!')}  Could not write .env: ${(error as Error).message}`);
    }
  }

  return trimmed;
}

export async function askAccounts(
  mappings: AccountMapping[],
  domain: string,
  ask: PromptFn = defaultPrompt,
): Promise<AccountMapping[]> {
  const enabled = mappings.filter((m) => m.enabled);

  const { mode } = (await ask([
    {
      // 'select', not the legacy 'list': inquirer 13 silently resolves a 'list'
      // prompt to an empty string instead of the chosen value.
      type: 'select',
      name: 'mode',
      message: `Which accounts do you want to migrate? (${enabled.length} enabled, ${mappings.length} total)`,
      choices: [
        { name: 'Pick them from a list', value: 'pick' },
        { name: 'A random sample (good for a first test)', value: 'random' },
        { name: 'Type the handles or usernames', value: 'type' },
        { name: `Everything (all ${enabled.length} enabled accounts)`, value: 'all' },
      ],
    },
  ])) as { mode: string };

  if (mode === 'all') return enabled;

  if (mode === 'random') {
    const { count } = (await ask([
      {
        type: 'number',
        name: 'count',
        message: 'How many?',
        default: 3,
        validate: (value?: number) =>
          value !== undefined && Number.isFinite(value) && value >= 1 && value <= enabled.length
            ? true
            : `Enter a number between 1 and ${enabled.length}.`,
      },
    ])) as { count: number };
    return sampleRandom(enabled, count);
  }

  if (mode === 'type') {
    const { raw } = (await ask([
      {
        type: 'input',
        name: 'raw',
        message: 'Handles or Twitter usernames, separated by spaces or commas:',
        validate: (value: string) => (parseIdentifierList(value).length > 0 ? true : 'Enter at least one.'),
      },
    ])) as { raw: string };
    const wanted = new Set(parseIdentifierList(raw));
    const matched = enabled.filter(
      (m) => wanted.has(m.bskyIdentifier.toLowerCase()) || m.twitterUsernames.some((u) => wanted.has(u)),
    );
    if (matched.length === 0) log(`  ${yellow('!')}  Nothing matched.`);
    return matched;
  }

  const { picked } = (await ask([
    {
      type: 'checkbox',
      name: 'picked',
      message: 'Space to select, enter to confirm:',
      pageSize: 15,
      loop: false,
      choices: enabled.map((mapping) => ({ name: describeChoice(mapping, domain), value: mapping })),
    },
  ])) as { picked: AccountMapping[] };
  return picked;
}

export async function askStopService(name: string, ask: PromptFn = defaultPrompt): Promise<boolean> {
  const { stopIt } = (await ask([
    {
      type: 'confirm',
      name: 'stopIt',
      message: `${name} is running and writes config.json. Stop it while the handles change?`,
      default: true,
    },
  ])) as { stopIt: boolean };
  return stopIt;
}

export async function askConfirmApply(ask: PromptFn = defaultPrompt): Promise<boolean> {
  const { go } = (await ask([{ type: 'confirm', name: 'go', message: 'Go ahead?', default: false }])) as {
    go: boolean;
  };
  return go;
}

async function main(): Promise<number> {
  loadEnvFile();

  log();
  log(bold('  tweets-2-bsky handle migration'));
  log(rule());
  log(dim('  Moves accounts onto <twitter-handle>.<your-domain>.'));
  log(dim('  Nothing changes until you confirm at the end.'));
  log();

  // --- Domain -------------------------------------------------------------
  const domain = await askDomain();

  // --- Cloudflare ---------------------------------------------------------
  const token = await askToken();
  if (!token) {
    log(`\n${red('A Cloudflare token is required.')}`);
    return 1;
  }

  const options: Options = { ...parseArgs([]), domain, apply: true, yes: true };

  let cloudflare: { client: CloudflareClient; zoneId: string };
  try {
    cloudflare = await checkCloudflare(options, token);
  } catch (error) {
    log(`  ${red(`x  ${(error as Error).message}`)}`);
    log(`\n${red('Cloudflare check failed.')} Fix the token or its permissions and run the wizard again.`);
    return 1;
  }

  // --- Accounts -----------------------------------------------------------
  const config = getConfig();
  if (config.mappings.length === 0) {
    log(`\n${red('No mappings found in config.json.')}`);
    return 1;
  }

  heading('Accounts');
  const selected = await askAccounts(config.mappings, domain);
  if (selected.length === 0) {
    log(`\n${yellow('Nothing selected.')} Run the wizard again when you know which accounts you want.`);
    return 0;
  }

  // --- Preview ------------------------------------------------------------
  heading(`Preview (${selected.length} account${selected.length === 1 ? '' : 's'})`);
  log(dim('  Resolving DIDs and checking existing DNS records...'));
  const plans: Plan[] = [];
  for (const mapping of selected) {
    plans.push(await buildPlan(mapping, options, cloudflare));
  }
  plans.forEach((plan, i) => printPlan(plan, i, plans.length));

  // --- Blockers -----------------------------------------------------------
  const collisions = findCollisions(plans.map((p) => p.conversion).filter((c): c is HandleConversion => c !== null));
  const clashes = findExternalClashes(plans, config.mappings);

  if (collisions.length > 0 || clashes.length > 0) {
    heading('Handle collisions');
    for (const collision of collisions) {
      log(
        `  ${red('x')}  ${collision.handle} would be claimed by: ${collision.sources.map((s) => `@${s}`).join(', ')}`,
      );
    }
    for (const clash of clashes) {
      log(`  ${red('x')}  ${clash} is already used by a different mapping`);
    }
    log(`\n  ${red('Cannot continue.')} Two accounts cannot share a handle. Fix this and run the wizard again.`);
    return 1;
  }

  const duplicates = findDuplicateTwitterSources(config.mappings);
  if (duplicates.length > 0) {
    heading('Heads up: duplicate Twitter sources');
    for (const duplicate of duplicates) {
      log(`  ${yellow('!')}  @${duplicate.twitterUsername} is mirrored by ${duplicate.bskyIdentifiers.join(' and ')}`);
    }
    log(`  ${dim('Both accounts post the same tweets. Not a handle problem, but worth fixing in the dashboard.')}`);
  }

  const summary = summarize(plans);
  heading('Summary');
  log(
    `  ${green(`${summary.ready} ready`)}   ${cyan(`${summary.alreadyCorrect} already correct`)}   ${
      summary.blocked > 0 ? red(`${summary.blocked} blocked`) : '0 blocked'
    }`,
  );

  if (summary.ready === 0) {
    log(`\n${yellow('Nothing to do.')}`);
    return 0;
  }

  // --- Service ------------------------------------------------------------
  const service = findPm2Process();
  let shouldRestart = false;
  if (service?.online) {
    const stopIt = await askStopService(service.name);
    if (stopIt) {
      shouldRestart = pm2('stop', service.name);
      log(
        shouldRestart ? `  ${green('OK')} Stopped ${service.name}` : `  ${yellow('!')}  Could not stop ${service.name}`,
      );
    }
  }

  // --- Confirm ------------------------------------------------------------
  log();
  log(yellow(`  About to change ${summary.ready} live Bluesky handle(s) and write ${summary.ready} DNS record(s).`));
  const go = await askConfirmApply();

  if (!go) {
    if (shouldRestart) pm2('start', 'tweets-2-bsky');
    log('\nNothing was changed.');
    return 0;
  }

  // --- Apply --------------------------------------------------------------
  heading('Applying');
  log(`  ${green('OK')} config.json backed up to ${backupConfig()}`);

  const journal: JournalEntry[] = [];
  const ready = plans.filter((p) => p.status === 'ready');
  for (const plan of ready) {
    try {
      const entry = await applyPlan(plan, options, cloudflare);
      if (entry) journal.push(entry);
    } catch (error) {
      log(`  ${red(`x  Unhandled error for @${plan.sourceUsername}: ${(error as Error).message}`)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const journalPath = writeJournal(journal);

  heading('Done');
  log(`  ${journal.length}/${ready.length} account(s) migrated.`);
  log(`  Journal: ${journalPath}`);
  if (journal.length < ready.length) {
    log(`  ${yellow('!')}  Some accounts did not complete. Re-run the wizard and pick just those.`);
  }
  if (journal.length > 0) {
    log(`\n  ${yellow('Note:')} the old handles are released and could be claimed by someone else.`);
  }

  if (shouldRestart) {
    log(
      pm2('start', 'tweets-2-bsky')
        ? `  ${green('OK')} Restarted tweets-2-bsky`
        : `  ${yellow('!')}  Could not restart tweets-2-bsky - start it yourself.`,
    );
  }

  return journal.length === ready.length ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      // Ctrl-C inside a prompt surfaces as an ExitPromptError; treat it as a clean abort.
      if ((error as Error)?.name === 'ExitPromptError') {
        console.log('\nCancelled. Nothing was changed.');
        process.exit(0);
      }
      console.error(red(`\nFatal: ${(error as Error).stack ?? error}`));
      process.exit(1);
    });
}
