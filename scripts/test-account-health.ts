#!/usr/bin/env bun
// Offline checks for the account-outage gate: the state machine that stops the
// workers logging into a taken-down account, and the classification that feeds
// it. No network and no real database — the data dir is a throwaway.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets2bsky-account-health-'));
process.env.TWEETS2BSKY_DATA_DIR = scratchDir;

const { accountHealthService } = await import('../src/db.js');
const { downStateFromLoginError, downStateFromStatus } = await import('../src/bsky.js');

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

const HOUR = 60 * 60 * 1000;
const identifier = 'downaccount.bsky.social';
const markDown = (state: 'takendown' | 'deactivated' = 'takendown') =>
  accountHealthService.markDown({
    bskyIdentifier: identifier,
    serviceUrl: 'https://bsky.social',
    state,
    reason: `${identifier} is down.`,
  });

console.log('Login error classification\n');
assert(downStateFromLoginError({ error: 'AccountTakedown' }) === 'takendown', 'AccountTakedown maps to takendown');
assert(
  downStateFromLoginError({ message: 'Account has been suspended' }) === 'suspended',
  'Suspension message maps to suspended',
);
assert(
  downStateFromLoginError({ message: 'Account is deactivated' }) === 'deactivated',
  'Deactivation message maps to deactivated',
);
assert(downStateFromLoginError({ status: 401, message: 'Invalid identifier or password' }) === null, 'Wrong password is not an outage');
assert(downStateFromLoginError({ status: 429, message: 'Rate Limit Exceeded' }) === null, 'Rate limiting is not an outage');
assert(downStateFromStatus('deactivated') === 'deactivated', 'active:false status is carried through');
assert(downStateFromStatus(undefined) === null, 'No status means no outage');

console.log('\nOutage state');
{
  const first = markDown();
  assert(first.firstDetection, 'First detection is flagged');
  assert(accountHealthService.blockedIdentifiers().has(identifier), 'Down account is blocked from logging in');
  assert(
    first.row.next_recheck_at - Date.now() > 0.9 * HOUR && first.row.next_recheck_at - Date.now() <= HOUR,
    'First recheck is ~1 hour out',
  );

  const second = markDown();
  assert(!second.firstDetection, 'Repeat detection is not flagged as new');
  assert(second.row.detected_at === first.row.detected_at, 'Original detection time survives reconfirmation');
  assert(second.row.next_recheck_at - Date.now() > 5 * HOUR, 'Second confirmation backs off to ~6 hours');

  const third = markDown();
  assert(third.row.next_recheck_at - Date.now() > 20 * HOUR, 'Third confirmation backs off to ~24 hours');
  assert(third.row.checks === 3, 'Check count accumulates');
}

console.log('\nManual recheck and recovery');
{
  accountHealthService.recheckNow(identifier);
  assert(!accountHealthService.blockedIdentifiers().has(identifier), 'Manual recheck unblocks the next login attempt');
  assert(accountHealthService.get(identifier) !== null, 'Manual recheck keeps the alert until a login proves otherwise');

  const cleared = accountHealthService.markHealthy(identifier);
  assert(cleared?.state === 'takendown', 'Recovery reports the state it cleared');
  assert(accountHealthService.get(identifier) === null, 'Recovery removes the alert');
  assert(accountHealthService.markHealthy(identifier) === null, 'Clearing a healthy account is a no-op');
}

console.log('\nMultiple accounts');
{
  markDown();
  accountHealthService.markDown({
    bskyIdentifier: 'OtherAccount.bsky.social',
    serviceUrl: 'https://bsky.social',
    state: 'deactivated',
    reason: 'other is deactivated.',
  });
  const blocked = accountHealthService.blockedIdentifiers();
  assert(blocked.size === 2, 'Both down accounts are blocked');
  assert(blocked.has('otheraccount.bsky.social'), 'Identifiers are matched case-insensitively');
  assert(accountHealthService.list().length === 2, 'Dashboard listing shows both');
}

fs.rmSync(scratchDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
