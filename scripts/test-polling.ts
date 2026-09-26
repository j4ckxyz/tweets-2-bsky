#!/usr/bin/env bun
// Offline checks for adaptive polling: which source accounts a sweep should
// check, and which are still serving their tier's interval. Pure functions, no
// database and no network.
import { DEFAULT_POLLING_TIERS, activityFromRow, decideCheck, planSweep, tierForActivity } from '../src/polling.js';

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

console.log('\nManual runs\n');
{
  const accounts = [
    { name: 'dormant', activity: { lastFoundAt: now - 30 * DAY, lastCheckedAt: now - MINUTE } },
    { name: 'quiet', activity: { lastFoundAt: now - 3 * DAY, lastCheckedAt: now - MINUTE } },
  ];
  const normal = planSweep(accounts, (account) => account.activity, now);
  assert(normal.due.length === 0, 'Recently checked cold accounts are not due on a normal sweep');
  const forced = planSweep(
    accounts,
    (account) => account.activity,
    now,
    undefined,
    () => true,
  );
  assert(forced.due.length === 2, '"Run now" checks every account regardless of tier');
  const one = planSweep(
    accounts,
    (account) => account.activity,
    now,
    undefined,
    (account) => account.name === 'quiet',
  );
  assert(one.due.length === 1 && one.due[0]?.name === 'quiet', 'A per-account "Run now" forces only that account');
}

console.log('\nActivity bookkeeping\n');
{
  // The activity table drives tiering, so stale rows for removed mappings would
  // keep answering for accounts that are no longer mirrored.
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweets2bsky-polling-'));
  process.env.TWEETS2BSKY_DATA_DIR = scratchDir;
  const { sourceActivityService } = await import('../src/db.js');

  sourceActivityService.recordCheck('keeper', true);
  sourceActivityService.recordCheck('removed', false);
  assert(sourceActivityService.getAll().size === 2, 'Checks are recorded per source account');

  sourceActivityService.recordCheck('keeper', false);
  const keeper = sourceActivityService.getAll().get('keeper');
  assert(keeper?.last_found_at !== null, 'An empty check keeps the last time the account posted');
  assert(keeper?.empty_streak === 1, 'An empty check advances the streak');

  sourceActivityService.pruneMissing(['keeper']);
  const afterPrune = sourceActivityService.getAll();
  assert(afterPrune.has('keeper'), 'Pruning keeps accounts that are still mirrored');
  assert(!afterPrune.has('removed'), 'Pruning drops accounts that are no longer mirrored');

  // The sweep reads these rows back to plan the next sweep. They are
  // snake_case; handing them to the planner unmapped made every account look
  // never-checked, so adaptive polling silently checked everything, always.
  {
    const row = sourceActivityService.getAll().get('keeper');
    const activity = activityFromRow(row);
    assert(activity.lastCheckedAt === row?.last_checked_at, 'activityFromRow carries last_checked_at over');
    assert(
      !decideCheck(activity, Date.now()).check || activity.lastFoundAt !== undefined,
      'A just-checked account read back from the database is not treated as never checked',
    );
    const quietRow = { last_found_at: now - 3 * DAY, last_checked_at: now - MINUTE };
    const plan = planSweep([quietRow], (account) => activityFromRow(account), now);
    assert(plan.skipped.length === 1, 'A quiet account checked a minute ago is skipped when read from a DB row');
    const raw = planSweep([quietRow], (account) => account as never, now);
    assert(raw.due.length === 1, '(The old unmapped row made that same account look due — the regression)');
  }

  // Errors surface on the row and clear on the next good check.
  sourceActivityService.recordError('keeper', 'User not found.');
  assert(sourceActivityService.get('keeper')?.last_error === 'User not found.', 'A failed check records its error');
  assert((sourceActivityService.get('keeper')?.error_streak ?? 0) === 1, 'Failures count up');
  const streakBefore = sourceActivityService.get('keeper')?.empty_streak;
  sourceActivityService.recordError('keeper', 'User not found.');
  assert(
    sourceActivityService.get('keeper')?.empty_streak === streakBefore,
    'A failure does not cool the account down like an empty check would',
  );
  sourceActivityService.recordCheck('keeper', false);
  assert(sourceActivityService.get('keeper')?.last_error == null, 'A successful check clears the error');

  sourceActivityService.setUserId('keeper', '12345');
  assert(sourceActivityService.get('keeper')?.twitter_user_id === '12345', 'The numeric user id is remembered');

  // The case that regressed: with nothing mirrored, every row should go rather
  // than the table being left untouched.
  sourceActivityService.pruneMissing([]);
  assert(sourceActivityService.getAll().size === 0, 'Pruning with no mirrored accounts empties the table');

  fs.rmSync(scratchDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
