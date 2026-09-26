// Delete sync: when a tweet is deleted on X, delete its mirror.
//
// Opt-in per mapping, and deliberately hard to trigger by accident — deleting
// a post that should have stayed is far worse than keeping one that should
// have gone:
//
//   * Only the public syndication CDN is asked, never the logged-in scraper,
//     so this spends none of the scraper account's rate limit.
//   * Only an explicit 404 counts as "gone". A tombstone (age-gated, withheld)
//     or any error means "unknown" and changes nothing.
//   * A tweet must be found missing on two checks at least six hours apart.
//   * If most of an account's checked tweets vanish at once, that is the
//     account being suspended or protected, not a string of deletions: the
//     whole pass for that account stands down.
//   * Checks are capped per sweep and paced.
import axios from 'axios';

export type SourceTweetState = 'present' | 'missing' | 'unknown';

function syndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** Ask the public syndication CDN whether a tweet still exists. */
export async function checkSourceTweet(tweetId: string): Promise<SourceTweetState> {
  try {
    const response = await axios.get('https://cdn.syndication.twimg.com/tweet-result', {
      params: { id: tweetId, token: syndicationToken(tweetId) },
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      timeout: 10_000,
      validateStatus: () => true,
    });
    if (response.status === 404) return 'missing';
    if (response.status !== 200) return 'unknown';
    const typename = (response.data as { __typename?: string } | null)?.__typename;
    if (typename === 'Tweet') return 'present';
    // TweetTombstone and anything unexpected: not proof of deletion.
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface DeleteSyncCandidate {
  twitter_id: string;
  bsky_uri?: string;
  bsky_tail_uri?: string;
  bsky_chunk_uris?: string;
}

export interface DeleteSyncDeps {
  check: (tweetId: string) => Promise<SourceTweetState>;
  recordPresent: (tweetId: string) => void;
  /** A check that proved nothing (tombstone, error, or the pass stood down). */
  recordInconclusive: (tweetId: string) => void;
  /** Returns consecutive misses so far and when the first one was seen. */
  recordMissing: (tweetId: string) => { misses: number; since: number };
  deletePost: (uri: string) => Promise<void>;
  markDeleted: (tweetId: string) => void;
  log: (level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>) => void;
  now?: () => number;
  pauseMs?: number;
}

export const DELETE_SYNC_MIN_MISSES = 2;
export const DELETE_SYNC_MIN_MISSING_SPAN_MS = 6 * 60 * 60 * 1000;

/** Every Bluesky post a mirrored tweet produced, first to last. */
export function mirroredUris(candidate: DeleteSyncCandidate): string[] {
  let chunks: string[] = [];
  if (candidate.bsky_chunk_uris) {
    try {
      const parsed = JSON.parse(candidate.bsky_chunk_uris);
      if (Array.isArray(parsed)) chunks = parsed.filter((uri): uri is string => typeof uri === 'string');
    } catch {
      chunks = [];
    }
  }
  return [
    ...new Set([candidate.bsky_uri, ...chunks, candidate.bsky_tail_uri].filter((uri): uri is string => Boolean(uri))),
  ];
}

export interface DeleteSyncResult {
  checked: number;
  present: number;
  missing: number;
  unknown: number;
  deleted: number;
  /** True when the mass-miss guard stopped the pass. */
  stoodDown: boolean;
}

/**
 * Check one account's candidates and delete mirrors whose tweet is confirmed
 * gone. The caller picks the candidates (recent, due a recheck, capped).
 */
export async function syncDeletesForAccount(
  candidates: DeleteSyncCandidate[],
  deps: DeleteSyncDeps,
): Promise<DeleteSyncResult> {
  const now = deps.now ?? Date.now;
  const result: DeleteSyncResult = { checked: 0, present: 0, missing: 0, unknown: 0, deleted: 0, stoodDown: false };
  const states: { candidate: DeleteSyncCandidate; state: SourceTweetState }[] = [];

  for (const candidate of candidates) {
    const state = await deps.check(candidate.twitter_id);
    states.push({ candidate, state });
    result.checked += 1;
    result[state] += 1;
    if (deps.pauseMs) await new Promise((resolve) => setTimeout(resolve, deps.pauseMs));
  }

  // Mass-miss guard: a suspended or protected account 404s on everything.
  const decisive = result.present + result.missing;
  if (result.missing >= 3 && result.missing / Math.max(1, decisive) > 0.5) {
    result.stoodDown = true;
    for (const { candidate } of states) deps.recordInconclusive(candidate.twitter_id);
    deps.log(
      'warn',
      'delete-sync.stood-down',
      `${result.missing} of ${decisive} checked tweets appear deleted at once. That looks like the X account being suspended or protected, so nothing was deleted.`,
      { missing: result.missing, present: result.present },
    );
    return result;
  }

  for (const { candidate, state } of states) {
    if (state === 'present') {
      deps.recordPresent(candidate.twitter_id);
      continue;
    }
    if (state !== 'missing') {
      deps.recordInconclusive(candidate.twitter_id);
      continue;
    }
    const { misses, since } = deps.recordMissing(candidate.twitter_id);
    if (misses < DELETE_SYNC_MIN_MISSES || now() - since < DELETE_SYNC_MIN_MISSING_SPAN_MS) continue;

    const uris = mirroredUris(candidate);
    for (const uri of uris) {
      try {
        await deps.deletePost(uri);
      } catch (error) {
        deps.log('warn', 'delete-sync.delete-failed', `Could not delete ${uri}: ${(error as Error).message}`, { uri });
      }
    }
    deps.markDeleted(candidate.twitter_id);
    result.deleted += 1;
    deps.log('info', 'delete-sync.deleted', `Tweet ${candidate.twitter_id} was deleted on X; deleted its mirror.`, {
      twitterId: candidate.twitter_id,
      uris,
    });
  }
  return result;
}
