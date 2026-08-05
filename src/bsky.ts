import { BskyAgent } from '@atproto/api';
import { getConfig } from './config-manager.js';
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

  const startedAt = Date.now();
  const agent = new BskyAgent({ service: serviceUrl });
  try {
    await agent.login({ identifier: mapping.bskyIdentifier, password: mapping.bskyPassword });
    activeAgents.set(cacheKey, { agent, loggedInAt: Date.now() });
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
