#!/usr/bin/env bun
/**
 * Drives the wizard's real prompt definitions with scripted keystrokes.
 *
 *   bun scripts/test-wizard-prompts.ts
 *
 * inquirer is given injected streams instead of a terminal, so this exercises
 * the actual questions, validators and filters the wizard shows a user - not a
 * reimplementation of them. No network, no credentials, no writes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import inquirer from 'inquirer';
import type { AccountMapping } from '../src/config-manager.js';
import { type PromptFn, askAccounts, askConfirmApply, askDomain, askStopService, askToken } from './rehandle-wizard.js';

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

const ENTER = '\n';
const DOWN = '\x1b[B';
const SPACE = ' ';

/**
 * Build a prompt module backed by fake streams, and type the given keystrokes
 * into it one at a time. Every call gets a fresh module so state cannot leak
 * between cases.
 */
function scripted(keys: string[]): { ask: PromptFn; rendered: () => string; stop: () => void } {
  const input = new PassThrough();
  let rendered = '';

  // A fresh output stream per prompt: inquirer closes the output when a prompt
  // finishes, so reusing one would silently discard everything the second and
  // later prompts draw. The input stream is shared, since that is the single
  // keystroke queue the whole scenario types into.
  const ask: PromptFn = (questions) => {
    const output = new PassThrough();
    output.on('data', (chunk) => {
      rendered += chunk.toString();
    });
    const prompt = inquirer.createPromptModule({ input, output }) as unknown as PromptFn;
    return prompt(questions);
  };

  // One typist for the whole scenario, not one per prompt. A scenario can span
  // several prompts (pick a mode, then answer it); each consumes keys from this
  // single stream in turn. Scheduling per ask() would replay the whole script
  // into every prompt.
  let next = 0;
  const timer = setInterval(() => {
    if (next >= keys.length) return;
    input.write(keys[next++]);
  }, 140);

  return { ask, rendered: () => rendered, stop: () => clearInterval(timer) };
}

const SCENARIO_TIMEOUT_MS = 8000;

/**
 * Run one scenario and always stop its typist. A prompt that runs out of
 * scripted keys would otherwise wait forever, so every scenario is raced
 * against a timeout and reported as a failure instead of hanging the suite.
 */
async function scenario<T>(
  keys: string[],
  run: (ask: PromptFn) => Promise<T>,
): Promise<{ value: T | null; rendered: string; error: string | null }> {
  const script = scripted(keys);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      run(script.ask),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`prompt did not resolve within ${SCENARIO_TIMEOUT_MS}ms (ran out of keystrokes?)`)),
          SCENARIO_TIMEOUT_MS,
        );
      }),
    ]);
    return { value, rendered: script.rendered(), error: null };
  } catch (error) {
    return { value: null, rendered: script.rendered(), error: (error as Error).message };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    script.stop();
  }
}

const mappings: AccountMapping[] = ['alice', 'bob_smith', 'carol', 'dave'].map(
  (username, i) =>
    ({
      id: `id-${i}`,
      twitterUsernames: [username],
      bskyIdentifier: `${username.replace('_', '-')}.bsky.social`,
      bskyPassword: 'x',
      bskyServiceUrl: 'https://bsky.social',
      enabled: true,
      profileSyncSourceUsername: username,
    }) as AccountMapping,
);

const names = (picked: AccountMapping[] | null) => (picked ?? []).map((m) => m.twitterUsernames[0]);

console.log('\ntweets-2-bsky wizard - scripted prompt tests\n');

// ---------------------------------------------------------------------------
console.log('1. Domain prompt');
{
  equal((await scenario([ENTER], askDomain)).value, 'j4ck.xyz', 'Enter accepts the default');
  equal((await scenario(['xmirror.bot', ENTER], askDomain)).value, 'xmirror.bot', 'a typed domain is accepted');
  equal(
    (await scenario(['  XMIRROR.BOT  ', ENTER], askDomain)).value,
    'xmirror.bot',
    'the filter trims and lowercases what was typed',
  );

  // The validator must reject and re-ask rather than accept a bad domain.
  // On a validation failure inquirer keeps the typed text so it can be edited,
  // so clear it the way a user would before typing the correct answer.
  const BACKSPACE = '\x7f';
  const bad = await scenario(['localhost', ENTER, BACKSPACE.repeat('localhost'.length), 'j4ck.xyz', ENTER], askDomain);
  equal(bad.value, 'j4ck.xyz', 'a single-segment domain is rejected and the prompt re-asks');
  assert(/two parts|at least/i.test(bad.rendered), 'and the rejection message is shown to the user');
  console.log();
}

// ---------------------------------------------------------------------------
console.log('2. Account selection');
{
  const pick = (keys: string[], list: AccountMapping[] = mappings) =>
    scenario(keys, (ask) => askAccounts(list, 'j4ck.xyz', ask));

  // Choice order: pick / random / type / all
  equal(
    names((await pick([ENTER, SPACE, DOWN, SPACE, ENTER])).value),
    ['alice', 'bob_smith'],
    'the checkbox picker returns exactly the accounts toggled',
  );
  equal(
    names((await pick([DOWN, DOWN, DOWN, ENTER])).value),
    ['alice', 'bob_smith', 'carol', 'dave'],
    '"Everything" selects all enabled accounts',
  );
  equal((await pick([DOWN, ENTER, '2', ENTER])).value?.length, 2, 'the random sample returns the requested count');
  equal(
    names((await pick([DOWN, DOWN, ENTER, '@alice, bob_smith', ENTER])).value),
    ['alice', 'bob_smith'],
    'typed identifiers match by Twitter username, @ and commas tolerated',
  );
  equal(
    names((await pick([DOWN, DOWN, ENTER, 'carol.bsky.social', ENTER])).value),
    ['carol'],
    'typed identifiers also match by current Bluesky handle',
  );
  equal(
    (await pick([DOWN, DOWN, ENTER, 'nobody', ENTER])).value?.length,
    0,
    'an identifier matching nothing selects nothing rather than erroring',
  );

  const withDisabled = [...mappings, { ...(mappings[0] as AccountMapping), id: 'off', enabled: false }];
  equal(
    (await pick([DOWN, DOWN, DOWN, ENTER], withDisabled)).value?.length,
    4,
    'disabled mappings are never offered or selected',
  );

  // The picker line is what the user reads before committing.
  const listing = await pick([ENTER, ENTER]);
  assert(listing.rendered.includes('bob-smith.bsky.social'), 'the picker shows the current handle');
  assert(listing.rendered.includes('bob-smith.j4ck.xyz'), 'and the handle it would become');
  console.log();
}

// ---------------------------------------------------------------------------
console.log('3. Token prompt');
{
  // Never let these tests reach the real .env.
  const tmpEnv = path.join(os.tmpdir(), `rehandle-test-env-${process.pid}`);
  const token = (keys: string[]) => scenario(keys, (ask) => askToken(ask, tmpEnv));

  process.env.CLOUDFLARE_API_TOKEN = '';
  process.env.CF_API_TOKEN = '';

  const fresh = await token(['cf-token-value', ENTER, 'n', ENTER]);
  equal(fresh.value, 'cf-token-value', 'a pasted token is returned');
  assert(!fresh.rendered.includes('cf-token-value'), 'the token is masked on screen, never echoed');
  assert(!fs.existsSync(tmpEnv), 'declining to save writes no file');

  const saved = await token(['cf-saved-token', ENTER, 'y', ENTER]);
  equal(saved.value, 'cf-saved-token', 'accepting the save still returns the token');
  assert(
    fs.existsSync(tmpEnv) && fs.readFileSync(tmpEnv, 'utf8').includes('CLOUDFLARE_API_TOKEN=cf-saved-token'),
    'accepting the save writes the token to the env file',
  );
  equal((fs.statSync(tmpEnv).mode & 0o777).toString(8), '600', 'the env file is written owner-only');
  fs.rmSync(tmpEnv, { force: true });

  // An existing token is offered for reuse and masked in the question.
  process.env.CLOUDFLARE_API_TOKEN = 'existing-token-abcd';
  const reuse = await token([ENTER]);
  equal(reuse.value, 'existing-token-abcd', 'Enter reuses the token already in .env');
  assert(reuse.rendered.includes('abcd'), 'the reuse prompt shows the last four characters');
  assert(!reuse.rendered.includes('existing-token-abcd'), 'but never the whole token');

  const replace = await token(['n', ENTER, 'brand-new-token', ENTER, 'n', ENTER]);
  equal(replace.value, 'brand-new-token', 'declining reuse prompts for a replacement');
  process.env.CLOUDFLARE_API_TOKEN = '';
  fs.rmSync(tmpEnv, { force: true });
  console.log();
}

// ---------------------------------------------------------------------------
console.log('4. Confirmations');
equal((await scenario([ENTER], askConfirmApply)).value, false, 'the apply confirmation defaults to NO');
equal((await scenario(['y', ENTER], askConfirmApply)).value, true, 'typing y confirms');
equal(
  (await scenario([ENTER], (ask) => askStopService('tweets-2-bsky', ask))).value,
  true,
  'stopping the service defaults to yes',
);
equal(
  (await scenario(['n', ENTER], (ask) => askStopService('tweets-2-bsky', ask))).value,
  false,
  'but it can be declined',
);
console.log();

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
