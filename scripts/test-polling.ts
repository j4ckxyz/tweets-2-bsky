#!/usr/bin/env bun
// Offline checks for adaptive polling: which source accounts a sweep should
// check, and which are still serving their tier's interval. Pure functions, no
// database and no network.
import { DEFAULT_POLLING_TIERS, decideCheck, planSweep, tierForActivity } from '../src/polling.js';

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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();

console.log('Tier assignment\n');
{
  assert(tierForActivity({ lastFoundAt: now - MINUTE }, now).name === 'active', 'Just posted is active');
  assert(tierForActivity({ lastFoundAt: now - 5 * HOUR }, now).name === 'active', 'Posted 5h ago is still active');
  assert(tierForActivity({ lastFoundAt: now - 12 * HOUR }, now).name === 'recent', 'Posted 12h ago is recent');
  assert(tierForActivity({ lastFoundAt: now - 3 * DAY }, now).name === 'quiet', 'Posted 3 days ago is quiet');
  assert(tierForActivity({ lastFoundAt: now - 30 * DAY }, now).name === 'dormant', 'Posted a month ago is dormant');
  assert(tierForActivity({}, now).name === 'active', 'An account with no history starts active, not dormant');
}

console.log('\nCheck decisions\n');
{
  assert(decideCheck({}, now).check, 'A never-checked account is always due');
  assert(
    decideCheck({ lastFoundAt: now - MINUTE, lastCheckedAt: now - 1000 }, now).check,
    'An active account is due on every sweep',
  );
  assert(
    !decideCheck({ lastFoundAt: now - 12 * HOUR, lastCheckedAt: now - MINUTE }, now).check,
    'A recent-tier account checked a minute ago is not due',
  );
  assert(
    decideCheck({ lastFoundAt: now - 12 * HOUR, lastCheckedAt: now - 11 * MINUTE }, now).check,
    'A recent-tier account is due once its 10 minute interval elapses',
  );
  assert(
    !decideCheck({ lastFoundAt: now - 30 * DAY, lastCheckedAt: now - 30 * MINUTE }, now).check,
    'A dormant account checked 30 minutes ago waits for its hour',
  );
  assert(
    decideCheck({ lastFoundAt: now - 30 * DAY, lastCheckedAt: now - 2 * HOUR }, now).check,
    'A dormant account is still checked at least hourly',
  );
}

console.log('\nDue countdown\n');
{
  const decision = decideCheck({ lastFoundAt: now - 12 * HOUR, lastCheckedAt: now - 4 * MINUTE }, now);
  assert(decision.dueInMs === 6 * MINUTE, `Reports time remaining until due (got ${decision.dueInMs})`);
  assert(decision.tier === 'recent', 'Reports the tier it was judged against');
}

console.log('\nSweep planning\n');
{
  const accounts = [
    { name: 'hot', activity: { lastFoundAt: now - MINUTE, lastCheckedAt: now - MINUTE } },
    { name: 'warm', activity: { lastFoundAt: now - 12 * HOUR, lastCheckedAt: now - 30 * MINUTE } },
    { name: 'cold', activity: { lastFoundAt: now - 30 * DAY, lastCheckedAt: now - MINUTE } },
    { name: 'new', activity: {} },
  ];
  const plan = planSweep(accounts, (account) => account.activity, now);

  const dueNames = plan.due.map((account) => account.name).sort();
  assert(dueNames.join(',') === 'hot,new,warm', `Checks the accounts that are due (got ${dueNames.join(',')})`);
  assert(plan.skipped.length === 1 && plan.skipped[0]?.account.name === 'cold', 'Holds back the dormant account');
  assert(plan.tierCounts.active === 2, 'Counts accounts per tier for the sweep log');
  assert(plan.due.length + plan.skipped.length === accounts.length, 'Every account is accounted for');
}

console.log('\nNothing is starved\n');
{
  // Whatever the tier, no account can go unchecked indefinitely.
  const coldestInterval = Math.max(...DEFAULT_POLLING_TIERS.map((tier) => tier.minIntervalMs));
  assert(Number.isFinite(coldestInterval), 'The coldest tier has a finite interval');
  assert(coldestInterval <= 60 * MINUTE, 'Even a dormant account is checked at least hourly');
  const overdue = { lastFoundAt: now - 365 * DAY, lastCheckedAt: now - coldestInterval - 1 };
  assert(decideCheck(overdue, now).check, 'An account past its interval is checked no matter how dormant');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
