import { BskyAgent } from '@atproto/api';
import { getConfig } from './config-manager.js';
import type { AccountHealthState } from './db.js';
import { accountHealthService } from './db.js';
import { logEvent } from './event-log.js';

interface CachedAgent {
  agent: BskyAgent;
  loggedInAt: number;
}

const activeAgents = new Map<string, CachedAgent>();

// Sessions were previously cached for the lifetime of the process. The AT
// Protocol client refreshes its access token automatically, but once the
// refresh token itself expires the cached agent fails every single request
// until someone restarts the app — and each of those failures counted against
// a queued tweet's retry budget. Re-logging in periodically bounds that to one
// interval instead of "forever".
const AGENT_MAX_AGE_MS = 45 * 60 * 1000;

const cacheKeyFor = (identifier: string, serviceUrl: string) => `${identifier.toLowerCase()}-${serviceUrl}`;

/** Drops a cached session so the next call performs a fresh login. */
export function invalidateAgent(bskyIdentifier: string, bskyServiceUrl?: string): void {
  const serviceUrl = bskyServiceUrl || 'https://bsky.social';
  activeAgents.delete(cacheKeyFor(bskyIdentifier, serviceUrl));
}

// A suspended, taken-down or deactivated account rejects every login in exactly
// the same way, forever. Recognising that is what stops the workers from
// retrying several times a second — which on its own gets the handle rate
// limited on top of being down.
const DOWN_STATE_LABELS: Record<AccountHealthState, string> = {
  takendown: 'has been taken down by Bluesky',
  suspended: 'has been suspended by Bluesky',
  deactivated: 'has been deactivated',
  unknown: 'is no longer hosted by its PDS',
};

export function downStateFromStatus(status?: string): AccountHealthState | null {
  if (status === 'takendown' || status === 'suspended' || status === 'deactivated') return status;
  return status ? 'unknown' : null;
}

/** Classifies a failed login as an account-level outage, or null if it isn't one. */
export function downStateFromLoginError(error: Record<string, any>): AccountHealthState | null {
  const code = typeof error?.error === 'string' ? error.error : undefined;
  if (code === 'AccountTakedown') return 'takendown';
  if (code === 'AccountDeactivated') return 'deactivated';
  if (code === 'AccountSuspended') return 'suspended';
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  if (message.includes('taken down')) return 'takendown';
  if (message.includes('suspended')) return 'suspended';
  if (message.includes('deactivated')) return 'deactivated';
  return null;
}

function recordAccountDown(
  mapping: { bskyIdentifier: string },
  serviceUrl: string,
  state: AccountHealthState,
  status: string | undefined,
  detail: string,
): void {
  const reason = `${mapping.bskyIdentifier} ${DOWN_STATE_LABELS[state]}.`;
  const { firstDetection, row } = accountHealthService.markDown({
    bskyIdentifier: mapping.bskyIdentifier,
    serviceUrl,
    state,
    status,
    reason,
  });
  logEvent({
    // Only the first detection is loud. After that it is a known condition
    // being re-confirmed on a slow schedule, not news.
    level: firstDetection ? 'error' : 'warn',
    stage: 'bluesky',
    event: 'account.down',
    message:
      `${reason} Posting to it is paused until it works again; queued tweets stay queued. ` +
      `Next automatic check ${new Date(row.next_recheck_at).toISOString()}.`,
    bskyIdentifier: mapping.bskyIdentifier,
    detail: { state, status, serviceUrl, detail, checks: row.checks, nextRecheckAt: row.next_recheck_at },
    console: firstDetection,
  });
}

export async function getAgent(mapping: {
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
}): Promise<BskyAgent | null> {
  const serviceUrl = mapping.bskyServiceUrl || 'https://bsky.social';
  const cacheKey = cacheKeyFor(mapping.bskyIdentifier, serviceUrl);
  const existing = activeAgents.get(cacheKey);
  if (existing && Date.now() - existing.loggedInAt < AGENT_MAX_AGE_MS) {
    return existing.agent;
  }

  // Known-down account, not yet due for its next check: fail without touching
  // the network. Every caller already handles a null agent by leaving its work
  // queued, so this pauses posting rather than losing anything.
  const health = accountHealthService.get(mapping.bskyIdentifier);
  if (health && health.next_recheck_at > Date.now()) {
    logEvent({
      level: 'debug',
      stage: 'bluesky',
      event: 'login.skipped',
      message: `Skipped signing in to ${mapping.bskyIdentifier}: ${health.reason}`,
      bskyIdentifier: mapping.bskyIdentifier,
      detail: { state: health.state, nextRecheckAt: health.next_recheck_at, detectedAt: health.detected_at },
      console: false,
    });
    return null;
  }

  const startedAt = Date.now();
  const agent = new BskyAgent({ service: serviceUrl });
  try {
    await agent.login({ identifier: mapping.bskyIdentifier, password: mapping.bskyPassword });

    // A deactivated (and sometimes a suspended) account still hands out a
    // session — it just refuses every write. `active: false` is the only signal
    // that separates it from a healthy login.
    if (agent.session && agent.session.active === false) {
      const state = downStateFromStatus(agent.session.status) ?? 'unknown';
      activeAgents.delete(cacheKey);
      recordAccountDown(mapping, serviceUrl, state, agent.session.status, 'createSession returned active: false');
      return null;
    }

    activeAgents.set(cacheKey, { agent, loggedInAt: Date.now() });
    if (health) {
      accountHealthService.markHealthy(mapping.bskyIdentifier);
      logEvent({
        level: 'info',
        stage: 'bluesky',
        event: 'account.recovered',
        message:
          `${mapping.bskyIdentifier} is usable again after ${health.state}; ` +
          'posting resumes with everything that stayed queued.',
        bskyIdentifier: mapping.bskyIdentifier,
        detail: { previousState: health.state, downSinceMs: Date.now() - health.detected_at },
      });
    }
    logEvent({
      level: 'info',
      stage: 'bluesky',
      event: 'login.ok',
      message: `Signed in to ${mapping.bskyIdentifier}${existing ? ' (session refreshed)' : ''}.`,
      bskyIdentifier: mapping.bskyIdentifier,
      durationMs: Date.now() - startedAt,
      detail: { serviceUrl, refreshed: Boolean(existing) },
      console: false,
    });
    return agent;
  } catch (err) {
    const error = err as Record<string, any>;
    const status = error?.status ?? error?.response?.status;

    // An account-level outage is not a login problem to retry — it is a state
    // to record, so the workers stop and the dashboard can say why.
    const downState = downStateFromLoginError(error);
    if (downState) {
      activeAgents.delete(cacheKey);
      recordAccountDown(
        mapping,
        serviceUrl,
        downState,
        undefined,
        typeof error?.message === 'string' ? error.message : String(err),
      );
      return null;
    }

    // Bluesky returns 401 for a wrong app password and 400 with
    // AuthFactorTokenRequired when 2FA is on — very different fixes, so name
    // them rather than logging one generic "login failed".
    const hint =
      status === 401
        ? 'The app password is wrong or has been revoked. Generate a new one in Bluesky settings and update it here.'
        : error?.error === 'AuthFactorTokenRequired'
          ? 'This account has two-factor authentication enabled; use an app password rather than the account password.'
          : status === 429
            ? 'Bluesky is rate limiting sign-in attempts for this account. It will recover on its own.'
            : 'Check the handle, app password and service URL for this mapping.';

    logEvent({
      level: 'error',
      stage: 'bluesky',
      event: 'login.failed',
      message: `Could not sign in to ${mapping.bskyIdentifier}. ${hint}`,
      bskyIdentifier: mapping.bskyIdentifier,
      durationMs: Date.now() - startedAt,
      error: {
        name: typeof error?.name === 'string' ? error.name : 'Error',
        message: typeof error?.message === 'string' ? error.message : String(err),
        status: typeof status === 'number' ? status : undefined,
        code: typeof error?.error === 'string' ? error.error : undefined,
      },
      detail: { serviceUrl, hint },
    });
    // Never keep a broken session around.
    activeAgents.delete(cacheKey);
    return null;
  }
}

export async function deleteAllPosts(mappingId: string): Promise<number> {
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === mappingId);
  if (!mapping) throw new Error('Mapping not found');

  const agent = await getAgent(mapping);
  if (!agent) throw new Error('Failed to authenticate with Bluesky');

  let cursor: string | undefined;
  let deletedCount = 0;

  console.log(`[${mapping.bskyIdentifier}] 🗑️ Starting deletion of all posts...`);

  // Safety loop limit to prevent infinite loops
  let loops = 0;
  while (loops < 1000) {
    loops++;
    try {
      const { data } = await agent.com.atproto.repo.listRecords({
        repo: agent.session!.did,
        collection: 'app.bsky.feed.post',
        limit: 50, // Keep batch size reasonable
        cursor,
      });

      if (data.records.length === 0) break;

      console.log(`[${mapping.bskyIdentifier}] 🗑️ Deleting batch of ${data.records.length} posts...`);

      // Use p-limit like approach or just Promise.all since 50 is manageable
      await Promise.all(
        data.records.map((r) =>
          agent.com.atproto.repo
            .deleteRecord({
              repo: agent.session!.did,
              collection: 'app.bsky.feed.post',
              rkey: r.uri.split('/').pop()!,
            })
            .catch((e) => console.warn(`Failed to delete record ${r.uri}:`, e)),
        ),
      );

      deletedCount += data.records.length;
      cursor = data.cursor;

      if (!cursor) break;

      // Small delay to be nice to the server
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`[${mapping.bskyIdentifier}] ❌ Error during deletion loop:`, err);
      throw err;
    }
  }

  console.log(`[${mapping.bskyIdentifier}] ✅ Deleted ${deletedCount} posts.`);
  return deletedCount;
}
