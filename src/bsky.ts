import { BskyAgent } from '@atproto/api';
import { getConfig, updateConfig, updateMappingById } from './config-manager.js';
import type { AccountHealthState } from './db.js';
import { accountHealthService, dbService, postQueueService } from './db.js';
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

interface AgentMapping {
  id?: string;
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
  bskyDid?: string;
}

/**
 * Point a mapping (and everything keyed by its identifier) at a new handle.
 * Used when the account's handle changed underneath the mirror — renamed on
 * Bluesky, or moved by the rehandle script. Without the history move, the next
 * sweep would find no history under the new handle and re-post the account's
 * recent tweets.
 */
export function moveMappingToIdentifier(mappingId: string | undefined, fromIdentifier: string, toIdentifier: string) {
  const from = fromIdentifier.toLowerCase();
  const to = toIdentifier.toLowerCase();
  if (from === to) return;
  const moved = dbService.migrateBskyIdentifier(from, to);
  updateConfig((config) => {
    let changed = false;
    for (const mapping of config.mappings) {
      if (mapping.bskyIdentifier.toLowerCase() === from && (!mappingId || mapping.id === mappingId)) {
        mapping.bskyIdentifier = to;
        changed = true;
      }
    }
    return changed;
  });
  invalidateAgent(from);
  logEvent({
    level: 'warn',
    stage: 'bluesky',
    event: 'account.identifier-moved',
    message: `${from} is now ${to}. Moved ${moved.history} history record(s) and ${moved.queue} queued tweet(s) to the new handle.`,
    bskyIdentifier: to,
    mappingId,
    detail: { from, to, ...moved },
  });
}

async function loginAgent(serviceUrl: string, identifier: string, password: string): Promise<BskyAgent> {
  const agent = new BskyAgent({ service: serviceUrl });
  await agent.login({ identifier, password });
  return agent;
}

export async function getAgent(mapping: AgentMapping): Promise<BskyAgent | null> {
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
  let agent: BskyAgent;
  try {
    try {
      agent = await loginAgent(serviceUrl, mapping.bskyIdentifier, mapping.bskyPassword);
    } catch (loginErr) {
      // A handle that no longer resolves fails exactly like a wrong password.
      // If the account's DID is known, try that: it never changes, and a
      // success means the handle moved — follow it rather than stop posting.
      const status = (loginErr as { status?: number })?.status;
      const canTryDid = status === 401 && mapping.bskyDid && mapping.bskyDid !== mapping.bskyIdentifier.toLowerCase();
      if (!canTryDid) throw loginErr;
      agent = await loginAgent(serviceUrl, mapping.bskyDid as string, mapping.bskyPassword);
      const newHandle = agent.session?.handle?.toLowerCase();
      if (newHandle && newHandle !== 'handle.invalid' && newHandle !== mapping.bskyIdentifier.toLowerCase()) {
        moveMappingToIdentifier(mapping.id, mapping.bskyIdentifier, newHandle);
        mapping.bskyIdentifier = newHandle;
      }
    }

    // A deactivated (and sometimes a suspended) account still hands out a
    // session — it just refuses every write. `active: false` is the only signal
    // that separates it from a healthy login.
    if (agent.session && agent.session.active === false) {
      const state = downStateFromStatus(agent.session.status) ?? 'unknown';
      activeAgents.delete(cacheKey);
      recordAccountDown(mapping, serviceUrl, state, agent.session.status, 'createSession returned active: false');
      return null;
    }

    activeAgents.set(cacheKeyFor(mapping.bskyIdentifier, serviceUrl), { agent, loggedInAt: Date.now() });

    // Remember the DID: it is how a later handle change is recognised, and
    // how other mirrors mention this one.
    const did = agent.session?.did;
    if (mapping.id && did && did !== mapping.bskyDid) {
      updateMappingById(mapping.id, (entry) => {
        if (entry.bskyDid === did) return false;
        entry.bskyDid = did;
        return true;
      });
      mapping.bskyDid = did;
    }
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

export type DeletePostsScope = 'mirrored' | 'all';

export interface DeletePostsResult {
  deleted: number;
  scope: DeletePostsScope;
}

/**
 * Delete an account's posts and leave the mirror in a sane state afterwards.
 *
 * `mirrored` (the default) removes only what the mirror posted: every recorded
 * post, each chunk of a split tweet, follow-up media posts and reposts.
 * Anything written on the account by hand stays. `all` empties the repo.
 *
 * Either way the history is kept — rows are marked deleted rather than wiped —
 * and scheduled checks restart from now. Wiping the history used to make the
 * very next sweep re-post the account's latest 50 tweets.
 */
export async function deleteAllPosts(mappingId: string, scope: DeletePostsScope = 'mirrored'): Promise<number> {
  return (await deletePosts(mappingId, scope)).deleted;
}

export async function deletePosts(
  mappingId: string,
  scope: DeletePostsScope = 'mirrored',
  // Tests pass a mock agent; everything else signs in normally.
  agentOverride?: Pick<BskyAgent, 'session' | 'com'>,
): Promise<DeletePostsResult> {
  const config = getConfig();
  const mapping = config.mappings.find((m) => m.id === mappingId);
  if (!mapping) throw new Error('Mapping not found');

  const agent = agentOverride ?? (await getAgent(mapping));
  if (!agent) throw new Error('Failed to authenticate with Bluesky');
  const repo = agent.session?.did as string;

  console.log(`[${mapping.bskyIdentifier}] 🗑️ Deleting ${scope === 'all' ? 'ALL posts' : 'mirrored posts'}...`);

  // Everything the mirror recorded posting.
  const history = dbService.getTweetsForIdentifierWithUris(mapping.bskyIdentifier);
  const mirroredUris = new Set<string>();
  const tails: { root: string; tail: string }[] = [];
  const repostUris = new Set<string>();
  for (const row of history) {
    if (row.status === 'reposted' && row.bsky_uri) {
      repostUris.add(row.bsky_uri);
      continue;
    }
    if (!row.bsky_uri) continue;
    mirroredUris.add(row.bsky_uri);
    if (row.bsky_tail_uri) mirroredUris.add(row.bsky_tail_uri);
    if (row.bsky_chunk_uris) {
      try {
        for (const uri of JSON.parse(row.bsky_chunk_uris) as string[]) mirroredUris.add(uri);
      } catch {
        // fall back to the chain walk below
      }
    } else if (row.bsky_tail_uri && row.bsky_tail_uri !== row.bsky_uri) {
      tails.push({ root: row.bsky_uri, tail: row.bsky_tail_uri });
    }
  }

  // Read the whole repo once: needed for `all`, and to find the middle chunks
  // of split tweets recorded before chunk tracking existed (each chunk replies
  // to the one before it, so walking parents from the tail finds them all).
  const posts = new Map<string, { parent?: string }>();
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const { data } = await agent.com.atproto.repo.listRecords({
      repo,
      collection: 'app.bsky.feed.post',
      limit: 100,
      cursor,
    });
    for (const record of data.records) {
      const value = record.value as { reply?: { parent?: { uri?: string } } };
      posts.set(record.uri, { parent: value.reply?.parent?.uri });
    }
    cursor = data.cursor;
    if (!cursor || data.records.length === 0) break;
  }
  for (const { root, tail } of tails) {
    let current: string | undefined = tail;
    for (let hops = 0; current && current !== root && hops < 200; hops++) {
      mirroredUris.add(current);
      current = posts.get(current)?.parent;
    }
  }

  const targets = scope === 'all' ? [...posts.keys()] : [...mirroredUris].filter((uri) => posts.has(uri));
  let deleted = 0;
  const deleteRecord = async (uri: string, collection: string) => {
    try {
      await agent.com.atproto.repo.deleteRecord({ repo, collection, rkey: uri.split('/').pop() as string });
      deleted += 1;
    } catch (e) {
      console.warn(`Failed to delete record ${uri}:`, (e as Error).message);
    }
  };
  for (let i = 0; i < targets.length; i += 25) {
    await Promise.all(targets.slice(i, i + 25).map((uri) => deleteRecord(uri, 'app.bsky.feed.post')));
    if (!agentOverride) await new Promise((r) => setTimeout(r, 300));
  }
  for (const uri of repostUris) await deleteRecord(uri, 'app.bsky.feed.repost');

  // Keep the history so nothing is re-mirrored; mark it deleted.
  dbService.markAllDeleted(mapping.bskyIdentifier);
  postQueueService.deleteByMappingId(mapping.id);
  updateMappingById(mapping.id, (entry) => {
    entry.mirrorFromMs = Date.now();
    entry.lastPinnedTweetId = undefined;
    return true;
  });

  console.log(`[${mapping.bskyIdentifier}] ✅ Deleted ${deleted} record(s).`);
  return { deleted, scope };
}
