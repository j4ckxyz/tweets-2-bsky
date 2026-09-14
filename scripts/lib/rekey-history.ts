/**
 * tweets-2-bsky records what it has already mirrored under (tweet id, Bluesky
 * handle). Changing an account's handle without moving those records makes the
 * service treat its whole history as new and post it again: the September 2026
 * xmirror.bot migration posted 1,095 duplicates that way.
 *
 * These helpers copy the records to the new handle. Nothing is deleted, so the
 * operation is idempotent and the old rows remain as an audit trail.
 */

/** The subset of bun:sqlite's Database these helpers need. */
export interface SqlDb {
  query(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number };
  };
  transaction<T>(fn: () => T): () => T;
}

export interface RekeyResult {
  processedCopied: number;
  queueMoved: number;
  healthMoved: number;
}

const hasTable = (db: SqlDb, table: string) =>
  Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const columnsOf = (db: SqlDb, table: string) =>
  (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/** Copy an account's mirrored history from one handle to another. Safe to repeat. */
export function rekeyHistory(db: SqlDb, oldHandle: string, newHandle: string): RekeyResult {
  const from = oldHandle.toLowerCase();
  const to = newHandle.toLowerCase();
  const result: RekeyResult = { processedCopied: 0, queueMoved: 0, healthMoved: 0 };
  if (from === to) return result;

  db.transaction(() => {
    if (hasTable(db, 'processed_tweets')) {
      const others = columnsOf(db, 'processed_tweets').filter((c) => c !== 'bsky_identifier');
      result.processedCopied = db
        .query(
          `INSERT OR IGNORE INTO processed_tweets (bsky_identifier, ${others.join(', ')})
           SELECT ?, ${others.join(', ')} FROM processed_tweets WHERE bsky_identifier = ?`,
        )
        .run(to, from).changes;
    }
    // Pending work belongs to the account, not the handle string.
    if (hasTable(db, 'post_queue')) {
      result.queueMoved = db
        .query('UPDATE OR IGNORE post_queue SET bsky_identifier = ? WHERE bsky_identifier = ?')
        .run(to, from).changes;
    }
    if (hasTable(db, 'account_health')) {
      result.healthMoved = db
        .query('UPDATE OR IGNORE account_health SET bsky_identifier = ? WHERE bsky_identifier = ?')
        .run(to, from).changes;
    }
  })();

  return result;
}

/** Records still filed only under the old handle; zero means the move is complete. */
export function unmovedRecords(db: SqlDb, oldHandle: string, newHandle: string): number {
  if (!hasTable(db, 'processed_tweets')) return 0;
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM processed_tweets p WHERE p.bsky_identifier = ?
       AND NOT EXISTS (SELECT 1 FROM processed_tweets x WHERE x.twitter_id = p.twitter_id AND x.bsky_identifier = ?)`,
    )
    .get(oldHandle.toLowerCase(), newHandle.toLowerCase()) as { n: number };
  return row.n;
}

/**
 * Resolve journal moves to each old handle's final handle, following chains
 * (a.bsky.social -> a.j4ck.xyz -> a.xmirror.bot) and ignoring cycles.
 */
export function finalHandles(moves: { oldHandle: string; newHandle: string }[]): Map<string, string> {
  const next = new Map<string, string>();
  for (const move of moves) next.set(move.oldHandle.toLowerCase(), move.newHandle.toLowerCase());
  const final = new Map<string, string>();
  for (const start of next.keys()) {
    const seen = new Set([start]);
    let current = next.get(start) as string;
    while (next.has(current) && !seen.has(current)) {
      seen.add(current);
      current = next.get(current) as string;
    }
    if (current !== start) final.set(start, current);
  }
  return final;
}
