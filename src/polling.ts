// Adaptive polling.
//
// Every source account used to be checked on every sweep, which spends the same
// budget on an account that posts hourly and one that has been silent since
// March. With ~90 accounts and a bounded fetch concurrency, that lengthens the
// sweep for everyone — including the accounts actually posting, which is where
// mirror lag comes from.
//
// So each account earns a minimum interval from how recently it last produced a
// tweet. A busy account is checked on every sweep; a long-dormant one is checked
// a few times an hour. Nothing is ever dropped: the coldest tier still has a
// ceiling, and an account that posts again is promoted back to the hot tier on
// its next check.

export interface PollingTier {
  /** Label used in logs and the dashboard. */
  name: string;
  /** Accounts whose last new tweet is younger than this belong to the tier. */
  maxIdleMs: number;
  /** Minimum wait between checks for accounts in this tier. */
  minIntervalMs: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Tiers are ordered hot to cold; the first one an account fits wins. The hot
// tier has a zero interval so an actively posting account is never held back:
// the 5-10 minute mirror target depends on checking those every sweep.
export const DEFAULT_POLLING_TIERS: PollingTier[] = [
  { name: 'active', maxIdleMs: 6 * HOUR, minIntervalMs: 0 },
  { name: 'recent', maxIdleMs: DAY, minIntervalMs: 10 * MINUTE },
  { name: 'quiet', maxIdleMs: 7 * DAY, minIntervalMs: 30 * MINUTE },
  { name: 'dormant', maxIdleMs: Number.POSITIVE_INFINITY, minIntervalMs: 60 * MINUTE },
];

export interface AccountActivity {
  /** Epoch ms when a check last found new tweets, if it ever has. */
  lastFoundAt?: number;
  /** Epoch ms when this account was last checked. */
  lastCheckedAt?: number;
}

export interface PollingDecision {
  /** Whether this sweep should check the account. */
  check: boolean;
  /** Which tier the account fell into. */
  tier: string;
  /** Milliseconds until the account is due, when it is being skipped. */
  dueInMs: number;
}

export function tierForActivity(activity: AccountActivity, now: number, tiers = DEFAULT_POLLING_TIERS): PollingTier {
  // An account we have never seen post is treated as active, not dormant: a
  // newly added mapping has no history, and starting it cold would delay its
  // first mirrored tweet by an hour.
  const idleMs = activity.lastFoundAt === undefined ? 0 : Math.max(0, now - activity.lastFoundAt);
  for (const tier of tiers) {
    if (idleMs <= tier.maxIdleMs) return tier;
  }
  return tiers[tiers.length - 1] as PollingTier;
}

export function decideCheck(
  activity: AccountActivity,
  now: number,
  tiers = DEFAULT_POLLING_TIERS,
): PollingDecision {
  const tier = tierForActivity(activity, now, tiers);
  // Never checked: always check, whatever the tier says.
  if (activity.lastCheckedAt === undefined) {
    return { check: true, tier: tier.name, dueInMs: 0 };
  }
  const waited = Math.max(0, now - activity.lastCheckedAt);
  const dueInMs = Math.max(0, tier.minIntervalMs - waited);
  return { check: dueInMs === 0, tier: tier.name, dueInMs };
}

export interface PollingPlan<T> {
  due: T[];
  skipped: { account: T; tier: string; dueInMs: number }[];
  /** How many accounts fell into each tier, for the sweep log line. */
  tierCounts: Record<string, number>;
}

/**
 * Split accounts into the ones this sweep should check and the ones still
 * serving their tier's interval.
 */
export function planSweep<T>(
  accounts: T[],
  getActivity: (account: T) => AccountActivity,
  now: number,
  tiers = DEFAULT_POLLING_TIERS,
): PollingPlan<T> {
  const due: T[] = [];
  const skipped: { account: T; tier: string; dueInMs: number }[] = [];
  const tierCounts: Record<string, number> = {};

  for (const account of accounts) {
    const decision = decideCheck(getActivity(account), now, tiers);
    tierCounts[decision.tier] = (tierCounts[decision.tier] ?? 0) + 1;
    if (decision.check) due.push(account);
    else skipped.push({ account, tier: decision.tier, dueInMs: decision.dueInMs });
  }

  return { due, skipped, tierCounts };
}
