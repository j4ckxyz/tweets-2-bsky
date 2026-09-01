import { DB_PATH } from './storage-paths.js';

interface DbStatement {
  get: (...params: any[]) => unknown;
  all: (...params: any[]) => unknown[];
  run: (...params: any[]) => unknown;
}

interface DbLike {
  prepare: (sql: string) => DbStatement;
  exec: (sql: string) => unknown;
  transaction: <T extends (...args: any[]) => any>(fn: T) => T;
  pragma?: (sql: string) => unknown;
}

const db: DbLike = await (async () => {
  if (typeof process.versions.bun === 'string') {
    const bunSqliteSpecifier = 'bun:sqlite';
    const sqliteModule = (await import(bunSqliteSpecifier)) as {
      Database: new (filename: string) => DbLike;
    };
    return new sqliteModule.Database(DB_PATH) as unknown as DbLike;
  }

  // better-sqlite3 is an optional dependency: it exists only for plain Node, and
  // its native build can fail (or be skipped) without that being a problem for
  // the supported Bun runtime. Say so plainly rather than surfacing a bare
  // module-not-found from deep inside startup.
  try {
    const betterSqliteModule = await import('better-sqlite3');
    return new betterSqliteModule.default(DB_PATH) as unknown as DbLike;
  } catch (error) {
    throw new Error(
      'No SQLite driver available. tweets-2-bsky runs on Bun, which provides bun:sqlite built in — ' +
        'install Bun (https://bun.sh) and start with `bun dist/index.js`. ' +
        `Running under plain Node additionally requires the optional better-sqlite3 package (${
          error instanceof Error ? error.message : String(error)
        }).`,
    );
  }
})();

// Enable WAL mode for better concurrency
if (typeof db.pragma === 'function') {
  db.pragma('journal_mode = WAL');
} else {
  db.exec('PRAGMA journal_mode = WAL;');
}

// WAL lets readers and one writer coexist, but two writers still collide. With
// several post workers, the fetch sweep and the event log all writing, an
// unguarded connection throws SQLITE_BUSY instantly — which used to surface as
// a "failed" tweet even when the Bluesky post had already gone out. Waiting a
// few seconds for the lock turns those into ordinary short pauses.
db.exec('PRAGMA busy_timeout = 8000;');

// Shared handle for other modules (event log) so the whole process keeps using
// one connection instead of competing for the same write lock.
export const rawDb = db;

// --- Migration Support ---
const tableInfo = db.prepare('PRAGMA table_info(processed_tweets)').all() as any[];

if (tableInfo.length > 0) {
  const schemaChanged = false;
  const hasBskyIdentifier = tableInfo.some((col) => col.name === 'bsky_identifier');
  const hasTweetText = tableInfo.some((col) => col.name === 'tweet_text');
  const hasTailUri = tableInfo.some((col) => col.name === 'bsky_tail_uri');

  if (!hasBskyIdentifier || !hasTweetText || !hasTailUri) {
    console.log('🔄 Upgrading database schema...');

    // SQLite doesn't support easy PK changes, so we recreate the table if identifier is missing
    // Or if we just need to add a column, we can do ALTER TABLE if it's not the PK.
    // However, since we might need to do both or one, let's just do the full migration pattern
    // to be safe and consistent.

    db.transaction(() => {
      // 1. Rename existing table
      db.exec('ALTER TABLE processed_tweets RENAME TO processed_tweets_old;');

      // 2. Create new table with all columns
      db.exec(`
        CREATE TABLE processed_tweets (
          twitter_id TEXT NOT NULL,
          twitter_username TEXT NOT NULL,
          bsky_identifier TEXT NOT NULL,
          tweet_text TEXT,
          bsky_uri TEXT,
          bsky_cid TEXT,
          bsky_root_uri TEXT,
          bsky_root_cid TEXT,
          bsky_tail_uri TEXT,
          bsky_tail_cid TEXT,
          status TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (twitter_id, bsky_identifier)
        );
      `);

      // 3. Migrate data
      // Handle the case where the old table might not have had bsky_identifier
      const oldColumns = tableInfo.map((c) => c.name);

      // Construct the SELECT part based on available old columns
      // If old table didn't have bsky_identifier, we default to 'unknown'
      const identifierSelect = oldColumns.includes('bsky_identifier') ? 'bsky_identifier' : "'unknown'";

      // If old table didn't have tweet_text, we default to NULL
      const textSelect = oldColumns.includes('tweet_text') ? 'tweet_text' : 'NULL';

      const tailUriSelect = oldColumns.includes('bsky_tail_uri') ? 'bsky_tail_uri' : 'NULL';
      const tailCidSelect = oldColumns.includes('bsky_tail_cid') ? 'bsky_tail_cid' : 'NULL';

      db.exec(`
        INSERT INTO processed_tweets (
          twitter_id, 
          twitter_username, 
          bsky_identifier, 
          tweet_text,
          bsky_uri, 
          bsky_cid, 
          bsky_root_uri, 
          bsky_root_cid,
          bsky_tail_uri,
          bsky_tail_cid, 
          status, 
          created_at
        )
        SELECT 
          twitter_id, 
          twitter_username, 
          ${identifierSelect}, 
          ${textSelect},
          bsky_uri, 
          bsky_cid, 
          bsky_root_uri, 
          bsky_root_cid,
          ${tailUriSelect},
          ${tailCidSelect}, 
          status, 
          created_at
        FROM processed_tweets_old;
      `);

      // 4. Drop old table
      db.exec('DROP TABLE processed_tweets_old;');
    })();
    console.log('✅ Database upgraded successfully.');
  }
} else {
  // Initialize fresh schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_tweets (
      twitter_id TEXT NOT NULL,
      twitter_username TEXT NOT NULL,
      bsky_identifier TEXT NOT NULL,
      tweet_text TEXT,
      bsky_uri TEXT,
      bsky_cid TEXT,
      bsky_root_uri TEXT,
      bsky_root_cid TEXT,
      bsky_tail_uri TEXT,
      bsky_tail_cid TEXT,
      status TEXT NOT NULL, -- 'migrated', 'skipped', 'failed'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (twitter_id, bsky_identifier)
    );
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_twitter_username ON processed_tweets(twitter_username);
  CREATE INDEX IF NOT EXISTS idx_bsky_identifier ON processed_tweets(bsky_identifier);
`);

// --- Mirror lag ---
// `created_at` records when the row was written, which is not the same thing as
// how long a tweet waited to appear on Bluesky. Storing the source tweet's own
// timestamp alongside the moment we posted makes the delay a plain subtraction,
// so the dashboard can show real per-account lag instead of an eyeballed guess
// from the log. Added as nullable columns: rows written before this stays NULL
// and are simply excluded from the averages.
const processedColumns = new Set(
  (db.prepare('PRAGMA table_info(processed_tweets)').all() as any[]).map((col) => col.name),
);
for (const [column, definition] of [
  ['tweet_created_at', 'INTEGER'],
  ['posted_at', 'INTEGER'],
] as const) {
  if (!processedColumns.has(column)) {
    db.exec(`ALTER TABLE processed_tweets ADD COLUMN ${column} ${definition};`);
  }
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_processed_lag
    ON processed_tweets(bsky_identifier, posted_at)
    WHERE posted_at IS NOT NULL AND tweet_created_at IS NOT NULL;
`);

// --- Post queue ---
// Durable buffer between the Twitter fetch sweep and the Bluesky post workers.
// Rows are deleted once the tweet lands in processed_tweets (that table stays
// the permanent record); failed rows are kept visible until pruned or cleared.
// Created with IF NOT EXISTS so existing databases upgrade in place on boot.
db.exec(`
  CREATE TABLE IF NOT EXISTS post_queue (
    twitter_id TEXT NOT NULL,
    bsky_identifier TEXT NOT NULL,
    mapping_id TEXT NOT NULL,
    twitter_username TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'scheduled',
    request_id TEXT,
    tweet_json TEXT NOT NULL,
    tweet_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    not_before INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    enqueued_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (twitter_id, bsky_identifier)
  );
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_queue_claim ON post_queue(status, not_before, enqueued_at);
  CREATE INDEX IF NOT EXISTS idx_queue_target ON post_queue(bsky_identifier, status);
  CREATE INDEX IF NOT EXISTS idx_queue_mapping ON post_queue(mapping_id, status);
`);

// Columns added after the queue shipped. Each one is optional and nullable, so
// existing databases upgrade in place with no data movement.
//
//   posted_uri / posted_cid / posted_at
//     Stamped the instant Bluesky accepts the first chunk. Without this a post
//     that lands but whose bookkeeping write is lost (crash, SQLITE_BUSY,
//     watchdog timeout firing while the request is still in flight) looks
//     identical to a post that never happened — it gets retried and eventually
//     parked as "failed" while being plainly visible on Bluesky.
//   failure_stage / last_error_detail
//     Which part of the pipeline gave up, and the structured error behind it,
//     so a failed row explains itself without digging through stdout.
//   first_failed_at / last_attempt_at
//     How long a row has been struggling, not just its attempt count.
const queueColumns = new Set((db.prepare('PRAGMA table_info(post_queue)').all() as any[]).map((col) => col.name));
for (const [column, definition] of [
  ['posted_uri', 'TEXT'],
  ['posted_cid', 'TEXT'],
  ['posted_at', 'INTEGER'],
  ['failure_stage', 'TEXT'],
  ['last_error_detail', 'TEXT'],
  ['first_failed_at', 'INTEGER'],
  ['last_attempt_at', 'INTEGER'],
] as const) {
  if (!queueColumns.has(column)) {
    db.exec(`ALTER TABLE post_queue ADD COLUMN ${column} ${definition};`);
  }
}

// --- Source account activity ---
// What adaptive polling runs on: when each Twitter account was last checked and
// when a check last produced new tweets. Keyed by username because the same
// source account can feed several mappings, and its posting rhythm is a
// property of the account, not of any one mirror.
db.exec(`
  CREATE TABLE IF NOT EXISTS source_activity (
    twitter_username TEXT PRIMARY KEY,
    last_checked_at INTEGER,
    last_found_at INTEGER,
    empty_streak INTEGER NOT NULL DEFAULT 0
  );
`);

export interface SourceActivityRow {
  twitter_username: string;
  last_checked_at?: number;
  last_found_at?: number;
  empty_streak: number;
}

export const sourceActivityService = {
  /** Every account's activity, keyed by lower-cased username. */
  getAll(): Map<string, SourceActivityRow> {
    const rows = db.prepare('SELECT * FROM source_activity').all() as SourceActivityRow[];
    return new Map(rows.map((row) => [row.twitter_username, row]));
  },

  /**
   * Record the outcome of a check. `found` promotes the account back to the hot
   * tier; an empty check only advances the streak, so an account that goes quiet
   * cools down gradually rather than the moment one sweep finds nothing.
   */
  recordCheck(twitterUsername: string, found: boolean, at = Date.now()): void {
    const username = twitterUsername.toLowerCase();
    db.prepare(`
      INSERT INTO source_activity (twitter_username, last_checked_at, last_found_at, empty_streak)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(twitter_username) DO UPDATE SET
        last_checked_at = excluded.last_checked_at,
        last_found_at = COALESCE(excluded.last_found_at, source_activity.last_found_at),
        empty_streak = CASE WHEN excluded.last_found_at IS NULL THEN source_activity.empty_streak + 1 ELSE 0 END
    `).run(username, at, found ? at : null, found ? 0 : 1);
  },

  /**
   * Drops rows for accounts that are no longer mirrored. An empty list means
   * nothing is mirrored any more, so every row goes — returning early there
   * would strand the whole table the moment the last mapping is removed.
   */
  pruneMissing(activeUsernames: string[]): number {
    if (activeUsernames.length === 0) {
      return (db.prepare('DELETE FROM source_activity').run() as { changes: number }).changes;
    }
    const placeholders = activeUsernames.map(() => '?').join(',');
    const result = db
      .prepare(`DELETE FROM source_activity WHERE twitter_username NOT IN (${placeholders})`)
      .run(...activeUsernames.map((name) => name.toLowerCase())) as { changes: number };
    return result.changes;
  },
};

// --- Account health ---
// Why a Bluesky account is unusable, and when to look again. A taken-down or
// deactivated account fails every login identically and forever; without this
// the workers re-login several times a second (which is also how an account
// gets itself rate limited on top of being down). Keyed by identifier rather
// than mapping id so several mappings pointing at the same handle share one
// verdict.
db.exec(`
  CREATE TABLE IF NOT EXISTS account_health (
    bsky_identifier TEXT PRIMARY KEY,
    service_url TEXT NOT NULL,
    state TEXT NOT NULL,
    status TEXT,
    reason TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    last_checked_at INTEGER NOT NULL,
    next_recheck_at INTEGER NOT NULL,
    checks INTEGER NOT NULL DEFAULT 1
  );
`);

/** Hosting states that make an account unusable until a human fixes it. */
export type AccountHealthState = 'takendown' | 'suspended' | 'deactivated' | 'unknown';

export interface AccountHealthRow {
  bsky_identifier: string;
  service_url: string;
  state: AccountHealthState;
  status?: string;
  reason: string;
  detected_at: number;
  last_checked_at: number;
  next_recheck_at: number;
  checks: number;
}

// A takedown is usually permanent and a deactivation needs someone to click
// "reactivate", so rechecks stretch out fast: 1h, 6h, then daily.
const ACCOUNT_RECHECK_DELAYS_MS = [60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

const accountRecheckDelayMs = (checks: number): number =>
  ACCOUNT_RECHECK_DELAYS_MS[Math.min(checks, ACCOUNT_RECHECK_DELAYS_MS.length) - 1] ??
  ACCOUNT_RECHECK_DELAYS_MS[ACCOUNT_RECHECK_DELAYS_MS.length - 1]!;

export const accountHealthService = {
  get(bskyIdentifier: string): AccountHealthRow | null {
    const row = db
      .prepare('SELECT * FROM account_health WHERE bsky_identifier = ?')
      .get(bskyIdentifier.toLowerCase()) as AccountHealthRow | undefined;
    return row ? { ...row, status: row.status ?? undefined } : null;
  },

  list(): AccountHealthRow[] {
    return (db.prepare('SELECT * FROM account_health ORDER BY detected_at ASC').all() as AccountHealthRow[]).map(
      (row) => ({ ...row, status: row.status ?? undefined }),
    );
  },

  /** Identifiers that must not be logged into yet. Excludes ones due a recheck. */
  blockedIdentifiers(now = Date.now()): Set<string> {
    const rows = db.prepare('SELECT bsky_identifier FROM account_health WHERE next_recheck_at > ?').all(now) as {
      bsky_identifier: string;
    }[];
    return new Set(rows.map((row) => row.bsky_identifier));
  },

  /**
   * Records an account as down. `detected_at` survives repeat calls so the
   * dashboard can say how long it has been like this; every confirmation pushes
   * the next recheck further out.
   */
  markDown(input: {
    bskyIdentifier: string;
    serviceUrl: string;
    state: AccountHealthState;
    status?: string;
    reason: string;
  }): { firstDetection: boolean; row: AccountHealthRow } {
    const identifier = input.bskyIdentifier.toLowerCase();
    const now = Date.now();
    const existing = this.get(identifier);
    const checks = (existing?.checks ?? 0) + 1;
    db.prepare(
      `INSERT INTO account_health
         (bsky_identifier, service_url, state, status, reason, detected_at, last_checked_at, next_recheck_at, checks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bsky_identifier) DO UPDATE SET
         service_url = excluded.service_url,
         state = excluded.state,
         status = excluded.status,
         reason = excluded.reason,
         last_checked_at = excluded.last_checked_at,
         next_recheck_at = excluded.next_recheck_at,
         checks = excluded.checks`,
    ).run(
      identifier,
      input.serviceUrl,
      input.state,
      input.status ?? null,
      input.reason.slice(0, 1000),
      existing?.detected_at ?? now,
      now,
      now + accountRecheckDelayMs(checks),
      checks,
    );
    return { firstDetection: !existing, row: this.get(identifier)! };
  },

  /** Clears a recorded outage. Returns the row it cleared, if there was one. */
  markHealthy(bskyIdentifier: string): AccountHealthRow | null {
    const identifier = bskyIdentifier.toLowerCase();
    const existing = this.get(identifier);
    if (existing) db.prepare('DELETE FROM account_health WHERE bsky_identifier = ?').run(identifier);
    return existing;
  },

  /** Makes the next login attempt happen immediately (dashboard "Check again"). */
  recheckNow(bskyIdentifier: string): boolean {
    db.prepare('UPDATE account_health SET next_recheck_at = 0 WHERE bsky_identifier = ?').run(
      bskyIdentifier.toLowerCase(),
    );
    return changesCount() > 0;
  },
};

export interface ProcessedTweet {
  twitter_id: string;
  twitter_username: string;
  bsky_identifier: string;
  tweet_text?: string;
  bsky_uri?: string;
  bsky_cid?: string;
  bsky_root_uri?: string;
  bsky_root_cid?: string;
  bsky_tail_uri?: string;
  bsky_tail_cid?: string;
  status: 'migrated' | 'skipped' | 'failed';
  created_at?: string;
  /** Epoch ms of the source tweet itself, for measuring mirror lag. */
  tweet_created_at?: number;
  /** Epoch ms when the mirrored post landed on Bluesky. */
  posted_at?: number;
}

/** Posting volume and recency per mirrored account, over a reporting window. */
export interface AccountPostStats {
  bsky_identifier: string;
  total: number;
  posted: number;
  skipped: number;
  failed: number;
  last_posted_at: number | null;
}

/** Per-account mirror delay, measured from the source tweet to the Bluesky post. */
export interface MirrorLagStats {
  bsky_identifier: string;
  samples: number;
  averageLagMs: number;
  medianLagMs: number;
  p95LagMs: number;
  worstLagMs: number;
}

export interface ProcessedTweetSearchResult extends ProcessedTweet {
  score: number;
}

function normalizeSearchValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9@#._\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchValue(value: string): string[] {
  if (!value) {
    return [];
  }
  return value.split(' ').filter((token) => token.length > 0);
}

function orderedSubsequenceScore(query: string, candidate: string): number {
  if (!query || !candidate) {
    return 0;
  }

  let matched = 0;
  let searchIndex = 0;
  for (const char of query) {
    const foundIndex = candidate.indexOf(char, searchIndex);
    if (foundIndex === -1) {
      continue;
    }
    matched += 1;
    searchIndex = foundIndex + 1;
  }

  return matched / query.length;
}

function buildBigrams(value: string): Set<string> {
  const result = new Set<string>();
  if (value.length < 2) {
    if (value.length === 1) {
      result.add(value);
    }
    return result;
  }

  for (let i = 0; i < value.length - 1; i += 1) {
    result.add(value.slice(i, i + 2));
  }

  return result;
}

function diceCoefficient(a: string, b: string): number {
  const aBigrams = buildBigrams(a);
  const bBigrams = buildBigrams(b);
  if (aBigrams.size === 0 || bBigrams.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const gram of aBigrams) {
    if (bBigrams.has(gram)) {
      overlap += 1;
    }
  }

  return (2 * overlap) / (aBigrams.size + bBigrams.size);
}

function scoreCandidateField(query: string, tokens: string[], candidateValue?: string): number {
  const candidate = normalizeSearchValue(candidateValue || '');
  if (!query || !candidate) {
    return 0;
  }

  let score = 0;
  if (candidate === query) {
    score += 170;
  } else if (candidate.startsWith(query)) {
    score += 140;
  } else if (candidate.includes(query)) {
    score += 112;
  }

  let matchedTokens = 0;
  for (const token of tokens) {
    if (candidate.includes(token)) {
      matchedTokens += 1;
      score += token.length >= 4 ? 18 : 12;
    }
  }

  if (tokens.length > 0) {
    score += (matchedTokens / tokens.length) * 48;
  }

  score += orderedSubsequenceScore(query, candidate) * 46;
  score += diceCoefficient(query, candidate) * 55;

  return score;
}

function scoreProcessedTweet(tweet: ProcessedTweet, query: string, tokens: string[]): number {
  const usernameScore = scoreCandidateField(query, tokens, tweet.twitter_username) * 1.25;
  const identifierScore = scoreCandidateField(query, tokens, tweet.bsky_identifier) * 1.18;
  const textScore = scoreCandidateField(query, tokens, tweet.tweet_text) * 0.98;
  const idScore = scoreCandidateField(query, tokens, tweet.twitter_id) * 0.72;

  const maxScore = Math.max(usernameScore, identifierScore, textScore, idScore);
  const blendedScore = maxScore + (usernameScore + identifierScore + textScore + idScore - maxScore) * 0.22;

  const recencyBoost = (() => {
    if (!tweet.created_at) return 0;
    const timestamp = Date.parse(tweet.created_at);
    if (!Number.isFinite(timestamp)) return 0;
    const ageDays = (Date.now() - timestamp) / (24 * 60 * 60 * 1000);
    return Math.max(0, 7 - ageDays);
  })();

  return blendedScore + recencyBoost;
}

export const dbService = {
  getTweet(twitterId: string, bskyIdentifier: string): ProcessedTweet | null {
    // Records are always written lower-cased (saveProcessedTweet normalises),
    // but callers pass whatever casing the mapping was configured with. Without
    // normalising here, a mapping stored as "NintendoBotX.bsky.social" reads
    // back as "no record" and the tweet gets posted (and retried) all over.
    const stmt = db.prepare('SELECT * FROM processed_tweets WHERE twitter_id = ? AND bsky_identifier = ?');
    const row = stmt.get(twitterId, bskyIdentifier.toLowerCase()) as any;
    if (!row) return null;
    return {
      twitter_id: row.twitter_id,
      twitter_username: row.twitter_username,
      bsky_identifier: row.bsky_identifier,
      tweet_text: row.tweet_text,
      bsky_uri: row.bsky_uri,
      bsky_cid: row.bsky_cid,
      bsky_root_uri: row.bsky_root_uri,
      bsky_root_cid: row.bsky_root_cid,
      bsky_tail_uri: row.bsky_tail_uri,
      bsky_tail_cid: row.bsky_tail_cid,
      status: row.status,
      created_at: row.created_at,
    };
  },

  saveTweet(tweet: ProcessedTweet) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO processed_tweets
      (twitter_id, twitter_username, bsky_identifier, tweet_text, bsky_uri, bsky_cid, bsky_root_uri, bsky_root_cid, bsky_tail_uri, bsky_tail_cid, status, tweet_created_at, posted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      tweet.twitter_id,
      tweet.twitter_username,
      tweet.bsky_identifier,
      tweet.tweet_text || null,
      tweet.bsky_uri || null,
      tweet.bsky_cid || null,
      tweet.bsky_root_uri || null,
      tweet.bsky_root_cid || null,
      tweet.bsky_tail_uri || null,
      tweet.bsky_tail_cid || null,
      tweet.status,
      tweet.tweet_created_at ?? null,
      tweet.posted_at ?? null,
    );
  },

  // Mirror lag per Bluesky account: how long tweets waited between being posted
  // on Twitter and appearing on Bluesky. Only rows carrying both timestamps
  // count, so accounts mirrored before the columns existed simply report no
  // samples rather than a wrong number. Backfills are excluded by the window —
  // importing a two-year-old tweet is not a five-minute mirror delay, and
  // averaging those in would swamp the signal.
  getMirrorLagStats(windowMs = 7 * 24 * 60 * 60 * 1000, maxLagMs = 6 * 60 * 60 * 1000): MirrorLagStats[] {
    const since = Date.now() - windowMs;
    const rows = db
      .prepare(`
        SELECT
          bsky_identifier,
          posted_at - tweet_created_at AS lag_ms
        FROM processed_tweets
        WHERE posted_at IS NOT NULL
          AND tweet_created_at IS NOT NULL
          AND posted_at >= ?
          AND posted_at - tweet_created_at BETWEEN 0 AND ?
        ORDER BY bsky_identifier, lag_ms
      `)
      .all(since, maxLagMs) as { bsky_identifier: string; lag_ms: number }[];

    const byAccount = new Map<string, number[]>();
    for (const row of rows) {
      const existing = byAccount.get(row.bsky_identifier);
      if (existing) existing.push(row.lag_ms);
      else byAccount.set(row.bsky_identifier, [row.lag_ms]);
    }

    return Array.from(byAccount.entries()).map(([bskyIdentifier, lags]) => {
      // Rows arrive already sorted by lag within each account, so percentiles
      // are a direct index rather than another sort per account.
      const total = lags.reduce((sum, lag) => sum + lag, 0);
      return {
        bsky_identifier: bskyIdentifier,
        samples: lags.length,
        averageLagMs: Math.round(total / lags.length),
        medianLagMs: lags[Math.floor((lags.length - 1) * 0.5)] ?? 0,
        p95LagMs: lags[Math.floor((lags.length - 1) * 0.95)] ?? 0,
        worstLagMs: lags[lags.length - 1] ?? 0,
      };
    });
  },

  // Posting counts and the last mirrored post per account, for the health card.
  // One grouped scan rather than a query per mapping, so a dashboard with a
  // hundred accounts still costs a single statement.
  getAccountPostStats(sinceMs = 7 * 24 * 60 * 60 * 1000): AccountPostStats[] {
    const since = new Date(Date.now() - sinceMs).toISOString();
    return db
      .prepare(`
        SELECT
          bsky_identifier,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'migrated' THEN 1 ELSE 0 END) AS posted,
          SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          MAX(CASE WHEN status = 'migrated' THEN COALESCE(posted_at, strftime('%s', created_at) * 1000) END)
            AS last_posted_at
        FROM processed_tweets
        WHERE created_at >= ?
        GROUP BY bsky_identifier
      `)
      .all(since) as AccountPostStats[];
  },

  getTweetsByBskyIdentifier(bskyIdentifier: string): Record<string, any> {
    const stmt = db.prepare('SELECT * FROM processed_tweets WHERE bsky_identifier = ?');
    const rows = stmt.all(bskyIdentifier.toLowerCase()) as any[];
    const map: Record<string, any> = {};
    for (const row of rows) {
      map[row.twitter_id] = {
        uri: row.bsky_uri,
        cid: row.bsky_cid,
        root: row.bsky_root_uri ? { uri: row.bsky_root_uri, cid: row.bsky_root_cid } : undefined,
        tail: row.bsky_tail_uri && row.bsky_tail_cid ? { uri: row.bsky_tail_uri, cid: row.bsky_tail_cid } : undefined,
        migrated: row.status === 'migrated',
        skipped: row.status === 'skipped',
      };
    }
    return map;
  },

  getTweetsByUsername(username: string): Record<string, any> {
    const stmt = db.prepare('SELECT * FROM processed_tweets WHERE twitter_username = ?');
    const rows = stmt.all(username.toLowerCase()) as any[];
    const map: Record<string, any> = {};
    for (const row of rows) {
      map[row.twitter_id] = {
        uri: row.bsky_uri,
        cid: row.bsky_cid,
        root: row.bsky_root_uri ? { uri: row.bsky_root_uri, cid: row.bsky_root_cid } : undefined,
        tail: row.bsky_tail_uri && row.bsky_tail_cid ? { uri: row.bsky_tail_uri, cid: row.bsky_tail_cid } : undefined,
        migrated: row.status === 'migrated',
        skipped: row.status === 'skipped',
      };
    }
    return map;
  },

  getRecentProcessedTweets(limit = 50): ProcessedTweet[] {
    const stmt = db.prepare('SELECT * FROM processed_tweets ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?');
    return stmt.all(limit) as ProcessedTweet[];
  },

  /** Recent mirrored tweets for one Bluesky account, newest first. */
  getRecentTweetsForIdentifier(bskyIdentifier: string, limit = 25): ProcessedTweet[] {
    return db
      .prepare(
        `SELECT * FROM processed_tweets
         WHERE bsky_identifier = ?
         ORDER BY COALESCE(posted_at, strftime('%s', created_at) * 1000) DESC, rowid DESC
         LIMIT ?`,
      )
      .all(bskyIdentifier.toLowerCase(), Math.max(1, Math.min(limit, 200))) as ProcessedTweet[];
  },

  searchMigratedTweets(query: string, limit = 60, scanLimit = 3000): ProcessedTweetSearchResult[] {
    const normalizedQuery = normalizeSearchValue(query || '');
    if (!normalizedQuery) {
      return [];
    }

    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 200)) : 60;
    const safeScanLimit = Number.isFinite(scanLimit) ? Math.max(safeLimit, Math.min(scanLimit, 8000)) : 3000;
    const tokens = tokenizeSearchValue(normalizedQuery);

    const stmt = db.prepare(
      'SELECT * FROM processed_tweets WHERE status = "migrated" ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ?',
    );
    const rows = stmt.all(safeScanLimit) as ProcessedTweet[];

    return rows
      .map((row) => ({
        ...row,
        score: scoreProcessedTweet(row, normalizedQuery, tokens),
      }))
      .filter((row) => row.score >= 22)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        const aTime = a.created_at ? Date.parse(a.created_at) : 0;
        const bTime = b.created_at ? Date.parse(b.created_at) : 0;
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      })
      .slice(0, safeLimit);
  },

  deleteTweetsByUsername(username: string) {
    const stmt = db.prepare('DELETE FROM processed_tweets WHERE twitter_username = ?');
    stmt.run(username.toLowerCase());
  },

  deleteTweetsByBskyIdentifier(bskyIdentifier: string) {
    const stmt = db.prepare('DELETE FROM processed_tweets WHERE bsky_identifier = ?');
    stmt.run(bskyIdentifier.toLowerCase());
  },

  repairUnknownIdentifiers(twitterUsername: string, bskyIdentifier: string) {
    const stmt = db.prepare(
      'UPDATE processed_tweets SET bsky_identifier = ? WHERE bsky_identifier = "unknown" AND twitter_username = ?',
    );
    stmt.run(bskyIdentifier.toLowerCase(), twitterUsername.toLowerCase());
  },

  clearAll() {
    db.prepare('DELETE FROM processed_tweets').run();
  },
};

// ============================================================================
// Post Queue Service
// ============================================================================

export type QueueItemKind = 'scheduled' | 'backfill';
export type QueueItemStatus = 'pending' | 'processing' | 'failed';

export interface QueueItem {
  twitter_id: string;
  bsky_identifier: string;
  mapping_id: string;
  twitter_username: string;
  kind: QueueItemKind;
  request_id?: string;
  tweet_json: string;
  tweet_text?: string;
  status: QueueItemStatus;
  attempts: number;
  not_before: number;
  last_error?: string;
  enqueued_at: number;
  updated_at: number;
  /** Set as soon as Bluesky accepts the post, before any bookkeeping write. */
  posted_uri?: string;
  posted_cid?: string;
  posted_at?: number;
  /** Pipeline area that gave up: 'login' | 'media' | 'post' | 'record' | 'batch' | … */
  failure_stage?: string;
  /** JSON-encoded ErrorDetail from the event log, for the dashboard drill-down. */
  last_error_detail?: string;
  first_failed_at?: number;
  last_attempt_at?: number;
}

export interface QueueEnqueueInput {
  twitter_id: string;
  bsky_identifier: string;
  mapping_id: string;
  twitter_username: string;
  kind: QueueItemKind;
  request_id?: string;
  tweet_json: string;
  tweet_text?: string;
}

export interface QueueBatch {
  mapping_id: string;
  bsky_identifier: string;
  twitter_username: string;
  items: QueueItem[];
}

export interface QueueMappingCounts {
  mapping_id: string;
  bsky_identifier: string;
  pending: number;
  processing: number;
  failed: number;
  /** Subset of `pending` that is claimable right now (not_before has passed). */
  ready: number;
  /** Subset of `pending` still serving retry backoff. */
  backoff: number;
  oldest_enqueued_at: number | null;
  /** When the earliest backed-off row becomes claimable again. */
  next_retry_at: number | null;
}

export interface QueueCounts {
  pending: number;
  processing: number;
  failed: number;
  ready: number;
  backoff: number;
  perMapping: QueueMappingCounts[];
}

// Twitter ids are numeric snowflakes, so shorter strings are always older.
// Ordering by (length, value) yields chronological order without BigInt casts.
const TWEET_ID_ORDER = 'LENGTH(twitter_id) ASC, twitter_id ASC';

const changesCount = (): number => {
  const row = db.prepare('SELECT changes() AS c').get() as { c: number } | undefined;
  return row?.c ?? 0;
};

const rowToQueueItem = (row: any): QueueItem => ({
  twitter_id: row.twitter_id,
  bsky_identifier: row.bsky_identifier,
  mapping_id: row.mapping_id,
  twitter_username: row.twitter_username,
  kind: row.kind,
  request_id: row.request_id ?? undefined,
  tweet_json: row.tweet_json,
  tweet_text: row.tweet_text ?? undefined,
  status: row.status,
  attempts: row.attempts,
  not_before: row.not_before,
  last_error: row.last_error ?? undefined,
  enqueued_at: row.enqueued_at,
  updated_at: row.updated_at,
  posted_uri: row.posted_uri ?? undefined,
  posted_cid: row.posted_cid ?? undefined,
  posted_at: row.posted_at ?? undefined,
  failure_stage: row.failure_stage ?? undefined,
  last_error_detail: row.last_error_detail ?? undefined,
  first_failed_at: row.first_failed_at ?? undefined,
  last_attempt_at: row.last_attempt_at ?? undefined,
});

export const postQueueService = {
  // INSERT OR IGNORE dedupes against everything already queued (any status)
  // for the same Bluesky target; callers additionally pre-filter against
  // processed_tweets. Returns how many rows were actually inserted.
  enqueue(items: QueueEnqueueInput[]): number {
    if (items.length === 0) return 0;
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO post_queue
        (twitter_id, bsky_identifier, mapping_id, twitter_username, kind, request_id, tweet_json, tweet_text, status, attempts, not_before, enqueued_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
    `);
    let inserted = 0;
    const runAll = db.transaction(() => {
      for (const item of items) {
        stmt.run(
          item.twitter_id,
          item.bsky_identifier.toLowerCase(),
          item.mapping_id,
          item.twitter_username.toLowerCase(),
          item.kind,
          item.request_id ?? null,
          item.tweet_json,
          item.tweet_text ?? null,
          now,
          now,
        );
        inserted += changesCount();
      }
    });
    runAll();
    return inserted;
  },

  // Every queued twitter_id for a Bluesky target regardless of status, so the
  // sweep treats queued-but-not-yet-posted tweets as already seen.
  getQueuedIdSet(bskyIdentifier: string): Set<string> {
    const rows = db
      .prepare('SELECT twitter_id FROM post_queue WHERE bsky_identifier = ?')
      .all(bskyIdentifier.toLowerCase()) as { twitter_id: string }[];
    return new Set(rows.map((row) => row.twitter_id));
  },

  // Claims the oldest eligible (mapping, source account) group and marks its
  // pending rows as processing. Groups whose mapping is locked by another
  // worker (excluded) or no longer enabled (not in allowed) are passed over.
  claimNextBatch(excludedMappingIds: Set<string>, allowedMappingIds: Set<string>, maxItems = 50): QueueBatch | null {
    const now = Date.now();
    const groups = db
      .prepare(`
        SELECT mapping_id, twitter_username, bsky_identifier, MIN(enqueued_at) AS oldest
        FROM post_queue
        WHERE status = 'pending' AND not_before <= ?
        GROUP BY mapping_id, twitter_username, bsky_identifier
        ORDER BY oldest ASC
      `)
      .all(now) as { mapping_id: string; twitter_username: string; bsky_identifier: string }[];

    const group = groups.find((g) => !excludedMappingIds.has(g.mapping_id) && allowedMappingIds.has(g.mapping_id));
    if (!group) return null;

    let items: QueueItem[] = [];
    const claim = db.transaction(() => {
      const rows = db
        .prepare(`
          SELECT * FROM post_queue
          WHERE status = 'pending' AND not_before <= ?
            AND mapping_id = ? AND twitter_username = ? AND bsky_identifier = ?
          ORDER BY ${TWEET_ID_ORDER}
          LIMIT ?
        `)
        .all(now, group.mapping_id, group.twitter_username, group.bsky_identifier, maxItems) as any[];
      items = rows.map(rowToQueueItem);
      const mark = db.prepare(
        "UPDATE post_queue SET status = 'processing', updated_at = ? WHERE twitter_id = ? AND bsky_identifier = ?",
      );
      for (const item of items) {
        mark.run(now, item.twitter_id, item.bsky_identifier);
      }
    });
    claim();

    if (items.length === 0) return null;
    return {
      mapping_id: group.mapping_id,
      bsky_identifier: group.bsky_identifier,
      twitter_username: group.twitter_username,
      items,
    };
  },

  markDone(twitterId: string, bskyIdentifier: string): void {
    db.prepare('DELETE FROM post_queue WHERE twitter_id = ? AND bsky_identifier = ?').run(
      twitterId,
      bskyIdentifier.toLowerCase(),
    );
  },

  // Called the moment Bluesky accepts a tweet's first chunk, before alt-text,
  // threading bookkeeping or the processed_tweets write. If anything after this
  // point dies, the row still knows the post exists and must never be re-posted.
  markPosted(twitterId: string, bskyIdentifier: string, uri: string, cid: string): void {
    db.prepare(
      'UPDATE post_queue SET posted_uri = ?, posted_cid = ?, posted_at = ?, updated_at = ? WHERE twitter_id = ? AND bsky_identifier = ?',
    ).run(uri, cid, Date.now(), Date.now(), twitterId, bskyIdentifier.toLowerCase());
  },

  // Rows that reached Bluesky but never made it into processed_tweets. The
  // caller repairs the permanent record from posted_uri/posted_cid instead of
  // retrying, which would publish a duplicate.
  listPostedButUnrecorded(limit = 500): QueueItem[] {
    const rows = db
      .prepare(
        `SELECT * FROM post_queue
         WHERE posted_uri IS NOT NULL
         ORDER BY posted_at ASC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 5000))) as any[];
    return rows.map(rowToQueueItem);
  },

  // Failed attempt: exponential backoff (5 min doubling, capped at 6h), then
  // terminal 'failed' after maxAttempts so a poison tweet can't retry forever.
  // `stage` and `detail` are what turn a parked row from "it didn't work" into
  // an explanation the dashboard can show without anyone reading stdout.
  releaseForRetry(
    item: QueueItem,
    errorMessage: string,
    maxAttempts: number,
    options: { stage?: string; detail?: unknown; retryable?: boolean } = {},
  ): { status: 'pending' | 'failed'; attempts: number; retryAt: number | null } {
    const attempts = item.attempts + 1;
    const now = Date.now();
    const firstFailedAt = item.first_failed_at ?? now;
    const stage = options.stage ?? 'unknown';
    let detailJson: string | null = null;
    if (options.detail !== undefined) {
      try {
        detailJson = JSON.stringify(options.detail).slice(0, 4000);
      } catch {
        detailJson = null;
      }
    }

    // A permanently-rejected post (malformed record, deleted account) will
    // never succeed; park it now instead of burning seven more attempts and
    // six hours of backoff on a guaranteed failure.
    const park = attempts >= maxAttempts || options.retryable === false;

    if (park) {
      db.prepare(
        `UPDATE post_queue
         SET status = 'failed', attempts = ?, last_error = ?, failure_stage = ?, last_error_detail = ?,
             first_failed_at = ?, last_attempt_at = ?, updated_at = ?
         WHERE twitter_id = ? AND bsky_identifier = ?`,
      ).run(
        attempts,
        errorMessage.slice(0, 1000),
        stage,
        detailJson,
        firstFailedAt,
        now,
        now,
        item.twitter_id,
        item.bsky_identifier,
      );
      return { status: 'failed', attempts, retryAt: null };
    }

    const backoffMs = Math.min(5 * 60 * 1000 * 2 ** (attempts - 1), 6 * 60 * 60 * 1000);
    const retryAt = now + backoffMs;
    db.prepare(
      `UPDATE post_queue
       SET status = 'pending', attempts = ?, not_before = ?, last_error = ?, failure_stage = ?,
           last_error_detail = ?, first_failed_at = ?, last_attempt_at = ?, updated_at = ?
       WHERE twitter_id = ? AND bsky_identifier = ?`,
    ).run(
      attempts,
      retryAt,
      errorMessage.slice(0, 1000),
      stage,
      detailJson,
      firstFailedAt,
      now,
      now,
      item.twitter_id,
      item.bsky_identifier,
    );
    return { status: 'pending', attempts, retryAt };
  },

  // Puts a claimed row back without counting it as an attempt. Used when the
  // batch aborted before this tweet was ever tried (login failure, watchdog
  // timeout on an earlier tweet) — those items did nothing wrong, and charging
  // them an attempt each time is how untouched tweets used to reach the
  // 8-attempt cap and get parked as "failed".
  //
  // `delayMs` is chosen by the caller from how many times this mapping has
  // failed in a row, so a broken app password backs off instead of retrying
  // every 30 seconds forever.
  releaseUnattempted(item: QueueItem, reason: string, delayMs = 30_000): void {
    db.prepare(
      `UPDATE post_queue
       SET status = 'pending', not_before = ?, last_error = ?, failure_stage = 'not-attempted', updated_at = ?
       WHERE twitter_id = ? AND bsky_identifier = ?`,
    ).run(Date.now() + delayMs, reason.slice(0, 1000), Date.now(), item.twitter_id, item.bsky_identifier);
  },

  // Crash recovery: anything left 'processing' by a previous run goes back to
  // pending. processed_tweets checks make re-runs idempotent.
  resetProcessing(): number {
    db.prepare("UPDATE post_queue SET status = 'pending', updated_at = ? WHERE status = 'processing'").run(Date.now());
    return changesCount();
  },

  getCounts(): QueueCounts {
    const now = Date.now();
    const totals = db.prepare('SELECT status, COUNT(*) AS count FROM post_queue GROUP BY status').all() as {
      status: QueueItemStatus;
      count: number;
    }[];
    // `pending` alone is ambiguous: a row serving a six-hour retry backoff looks
    // exactly like one about to post. Splitting it means the dashboard can say
    // "waiting to retry in 42m" instead of a number that never seems to move.
    const perMapping = db
      .prepare(`
        SELECT mapping_id, bsky_identifier,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'pending' AND not_before <= ? THEN 1 ELSE 0 END) AS ready,
          SUM(CASE WHEN status = 'pending' AND not_before > ? THEN 1 ELSE 0 END) AS backoff,
          MIN(CASE WHEN status IN ('pending', 'processing') THEN enqueued_at ELSE NULL END) AS oldest_enqueued_at,
          MIN(CASE WHEN status = 'pending' AND not_before > ? THEN not_before ELSE NULL END) AS next_retry_at
        FROM post_queue
        GROUP BY mapping_id, bsky_identifier
        ORDER BY oldest_enqueued_at ASC
      `)
      .all(now, now, now) as QueueMappingCounts[];
    const byStatus = new Map(totals.map((row) => [row.status, row.count]));
    return {
      pending: byStatus.get('pending') ?? 0,
      processing: byStatus.get('processing') ?? 0,
      failed: byStatus.get('failed') ?? 0,
      ready: perMapping.reduce((total, entry) => total + (entry.ready ?? 0), 0),
      backoff: perMapping.reduce((total, entry) => total + (entry.backoff ?? 0), 0),
      perMapping,
    };
  },

  // Item listing for the dashboard; tweet_json is omitted to keep payloads small.
  listItems(
    options: { mappingIds?: Set<string>; limit?: number; status?: QueueItemStatus } = {},
  ): Omit<QueueItem, 'tweet_json'>[] {
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
    const where = options.status ? 'WHERE status = ?' : '';
    const params: unknown[] = options.status ? [options.status] : [];
    const rows = db
      .prepare(`
        SELECT twitter_id, bsky_identifier, mapping_id, twitter_username, kind, request_id, tweet_text,
               status, attempts, not_before, last_error, enqueued_at, updated_at,
               posted_uri, posted_cid, posted_at, failure_stage, last_error_detail, first_failed_at, last_attempt_at
        FROM post_queue
        ${where}
        ORDER BY CASE status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, enqueued_at ASC, ${TWEET_ID_ORDER}
        LIMIT ?
      `)
      .all(...params, limit * 4) as any[];
    const filtered = options.mappingIds ? rows.filter((row) => options.mappingIds?.has(row.mapping_id)) : rows;
    return filtered.slice(0, limit).map((row) => {
      const item = rowToQueueItem({ ...row, tweet_json: '' });
      const { tweet_json: _omit, ...rest } = item;
      return rest;
    });
  },

  // "Why did 323 tweets fail?" answered in one query: the distinct reasons,
  // how many rows share each, and a representative tweet for each group.
  summarizeFailures(mappingIds?: Set<string>): {
    stage: string;
    reason: string;
    count: number;
    sampleTwitterId: string;
    sampleTwitterUsername: string;
    sampleBskyIdentifier: string;
    lastSeenAt: number;
  }[] {
    const rows = db
      .prepare(`
        SELECT mapping_id,
               IFNULL(failure_stage, 'unknown') AS stage,
               IFNULL(last_error, 'No reason recorded') AS reason,
               COUNT(*) AS count,
               MAX(updated_at) AS last_seen_at,
               MIN(twitter_id) AS sample_twitter_id,
               MIN(twitter_username) AS sample_twitter_username,
               MIN(bsky_identifier) AS sample_bsky_identifier
        FROM post_queue
        WHERE status = 'failed'
        GROUP BY mapping_id, stage, reason
        ORDER BY count DESC, last_seen_at DESC
        LIMIT 200
      `)
      .all() as any[];
    return rows
      .filter((row) => !mappingIds || mappingIds.has(row.mapping_id))
      .map((row) => ({
        stage: row.stage,
        reason: row.reason,
        count: row.count,
        sampleTwitterId: row.sample_twitter_id,
        sampleTwitterUsername: row.sample_twitter_username,
        sampleBskyIdentifier: row.sample_bsky_identifier,
        lastSeenAt: row.last_seen_at,
      }));
  },

  cancelPendingByRequestId(requestId: string): number {
    db.prepare("DELETE FROM post_queue WHERE status = 'pending' AND request_id = ?").run(requestId);
    return changesCount();
  },

  cancelPendingBackfills(mappingId?: string): number {
    if (mappingId) {
      db.prepare("DELETE FROM post_queue WHERE status = 'pending' AND kind = 'backfill' AND mapping_id = ?").run(
        mappingId,
      );
    } else {
      db.prepare("DELETE FROM post_queue WHERE status = 'pending' AND kind = 'backfill'").run();
    }
    return changesCount();
  },

  deleteByMappingId(mappingId: string): number {
    db.prepare('DELETE FROM post_queue WHERE mapping_id = ?').run(mappingId);
    return changesCount();
  },

  deleteByBskyIdentifier(bskyIdentifier: string): number {
    db.prepare('DELETE FROM post_queue WHERE bsky_identifier = ?').run(bskyIdentifier.toLowerCase());
    return changesCount();
  },

  clearFailed(): number {
    db.prepare("DELETE FROM post_queue WHERE status = 'failed'").run();
    return changesCount();
  },

  /**
   * Re-arm rows stuck in `processing` for one mapping. Rows are normally
   * released when a batch settles, and any left over are re-armed at boot — but
   * a worker that dies mid-batch (or a watchdog firing while a request is still
   * in flight) leaves rows claimed with nothing working on them, and the account
   * then looks jammed until the process restarts. `olderThanMs` guards against
   * stealing rows from a batch that is genuinely still posting.
   */
  resetProcessingForMapping(mappingId: string, olderThanMs = 5 * 60 * 1000): number {
    db.prepare(
      `UPDATE post_queue
       SET status = 'pending', not_before = 0, updated_at = ?
       WHERE status = 'processing' AND mapping_id = ? AND updated_at < ?`,
    ).run(Date.now(), mappingId, Date.now() - olderThanMs);
    return changesCount();
  },

  /** Re-arm this mapping's parked failures, leaving every other account alone. */
  retryFailedForMapping(mappingId: string): number {
    db.prepare(
      `UPDATE post_queue
       SET status = 'pending', attempts = 0, not_before = 0, last_error = NULL, failure_stage = NULL,
           last_error_detail = NULL, first_failed_at = NULL, updated_at = ?
       WHERE status = 'failed' AND mapping_id = ?`,
    ).run(Date.now(), mappingId);
    return changesCount();
  },

  retryFailed(): number {
    db.prepare(
      `UPDATE post_queue
       SET status = 'pending', attempts = 0, not_before = 0, last_error = NULL, failure_stage = NULL,
           last_error_detail = NULL, first_failed_at = NULL, updated_at = ?
       WHERE status = 'failed'`,
    ).run(Date.now());
    return changesCount();
  },

  purgeFailedOlderThan(maxAgeMs: number): number {
    db.prepare("DELETE FROM post_queue WHERE status = 'failed' AND updated_at < ?").run(Date.now() - maxAgeMs);
    return changesCount();
  },
};
