// ============================================================================
// Structured event log
//
// Everything the pipeline does is written here as a queryable row instead of
// only being printed to stdout. Console output is still produced (PM2/Docker
// logs are unchanged), but the durable copy is what the dashboard reads,
// filters and exports — so "323 failed" can always be turned back into a list
// of concrete reasons long after the process that produced them restarted.
//
// Design notes:
//   * Shares the single SQLite connection from db.ts. A second connection
//     would fight the post workers for the write lock.
//   * Writes are buffered and flushed on a short timer inside one transaction.
//     Five post workers logging every media download would otherwise mean
//     thousands of individual write transactions per sweep.
//   * Retention is bounded by both age and row count so the log can never
//     grow without limit on a long-lived install.
// ============================================================================

import { rawDb } from './db.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Coarse pipeline area. Kept small and stable so dashboard filters stay useful.
export type LogStage =
  | 'system' // boot, shutdown, scheduler, housekeeping
  | 'sweep' // Twitter-side timeline checks
  | 'queue' // post_queue lifecycle: claim, settle, retry, park
  | 'post' // building and publishing a Bluesky post
  | 'media' // image/video download + blob upload
  | 'twitter' // scraper calls, cookies, rate limits
  | 'bluesky' // login, agent, PDS-level errors
  | 'profile' // profile/bio/avatar mirroring, pin sync
  | 'backfill' // history imports
  | 'ai' // alt-text and other model calls
  | 'http' // dashboard API requests worth recording
  | 'auth'; // login, registration, permission denials

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface ErrorDetail {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
  stack?: string;
  /** Provider-supplied error body (AT Protocol `error`/`message`, HTTP payload). */
  response?: unknown;
  /** Flattened `cause` chain, outermost first. */
  causes?: string[];
  /** True when a retry has a realistic chance of succeeding. */
  retryable?: boolean;
}

export interface LogEventInput {
  level: LogLevel;
  stage: LogStage;
  /** Machine-readable dotted code, e.g. `post.chunk.failed`. Stable across releases. */
  event: string;
  /** Human sentence. This is what a person reads first in the dashboard. */
  message: string;
  mappingId?: string;
  bskyIdentifier?: string;
  twitterUsername?: string;
  twitterId?: string;
  jobId?: string;
  attempt?: number;
  durationMs?: number;
  error?: ErrorDetail;
  /** Anything else worth keeping. Serialised to JSON, secrets redacted. */
  detail?: Record<string, unknown>;
  /** Set false to keep an entry out of stdout (very chatty per-chunk traces). */
  console?: boolean;
}

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  stage: LogStage;
  event: string;
  message: string;
  mappingId?: string;
  bskyIdentifier?: string;
  twitterUsername?: string;
  twitterId?: string;
  jobId?: string;
  attempt?: number;
  durationMs?: number;
  error?: ErrorDetail;
  detail?: Record<string, unknown>;
}

// --- Tunables -------------------------------------------------------------

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (Number.isFinite(raw)) return Math.min(max, Math.max(min, Math.round(raw)));
  return fallback;
}

// Rows are small (a few hundred bytes); 250k is well under 200 MB and keeps
// weeks of history for a 60-account install.
const MAX_ROWS = envInt('EVENT_LOG_MAX_ROWS', 250_000, 1_000, 5_000_000);
const MAX_AGE_MS = envInt('EVENT_LOG_RETENTION_DAYS', 30, 1, 365) * 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = envInt('EVENT_LOG_FLUSH_MS', 400, 0, 10_000);
// Stack traces are the single biggest column; cap them rather than drop them.
const MAX_STACK_CHARS = 4_000;
const MAX_DETAIL_CHARS = 8_000;

const MIN_LEVEL: LogLevel = (() => {
  const raw = (process.env.EVENT_LOG_LEVEL || '').toLowerCase();
  return (LOG_LEVELS as string[]).includes(raw) ? (raw as LogLevel) : 'debug';
})();
const MIN_RANK = LEVEL_RANK[MIN_LEVEL];

// --- Schema ---------------------------------------------------------------

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    stage TEXT NOT NULL,
    event TEXT NOT NULL,
    message TEXT NOT NULL,
    mapping_id TEXT,
    bsky_identifier TEXT,
    twitter_username TEXT,
    twitter_id TEXT,
    job_id TEXT,
    attempt INTEGER,
    duration_ms INTEGER,
    error_name TEXT,
    error_message TEXT,
    error_status INTEGER,
    error_code TEXT,
    error_stack TEXT,
    detail TEXT
  );
`);
rawDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_event_log_ts ON event_log(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_event_log_level ON event_log(level, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_event_log_stage ON event_log(stage, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_event_log_tweet ON event_log(twitter_id);
  CREATE INDEX IF NOT EXISTS idx_event_log_target ON event_log(bsky_identifier, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_event_log_mapping ON event_log(mapping_id, ts DESC);
`);

// --- Redaction ------------------------------------------------------------

// The log is exportable, so anything that could carry a credential is masked
// before it is ever written. Matching is on key name, plus value shapes for
// the two token formats this app actually handles.
const SENSITIVE_KEY_PATTERN =
  /pass(word)?|token|secret|ct0|auth[_-]?token|cookie|api[_-]?key|bearer|credential|authorization|jwt|session/i;

const TOKEN_VALUE_PATTERNS: RegExp[] = [
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b[a-f0-9]{32,}\b/g, // ct0 / auth_token style hex blobs
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of TOKEN_VALUE_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redactValue(inner, depth + 1);
    }
    return out;
  }
  return String(value);
}

function serialiseDetail(detail: Record<string, unknown> | undefined): string | null {
  if (!detail || Object.keys(detail).length === 0) return null;
  try {
    const json = JSON.stringify(redactValue(detail));
    if (!json) return null;
    return json.length > MAX_DETAIL_CHARS ? `${json.slice(0, MAX_DETAIL_CHARS)}…[truncated]` : json;
  } catch {
    return JSON.stringify({ note: 'detail could not be serialised' });
  }
}

// --- Buffered writer ------------------------------------------------------

interface PendingRow {
  ts: number;
  level: LogLevel;
  stage: LogStage;
  event: string;
  message: string;
  mapping_id: string | null;
  bsky_identifier: string | null;
  twitter_username: string | null;
  twitter_id: string | null;
  job_id: string | null;
  attempt: number | null;
  duration_ms: number | null;
  error_name: string | null;
  error_message: string | null;
  error_status: number | null;
  error_code: string | null;
  error_stack: string | null;
  detail: string | null;
}

let buffer: PendingRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let insertedSincePrune = 0;
let lastPruneAt = 0;

const insertStmt = rawDb.prepare(`
  INSERT INTO event_log
    (ts, level, stage, event, message, mapping_id, bsky_identifier, twitter_username, twitter_id,
     job_id, attempt, duration_ms, error_name, error_message, error_status, error_code, error_stack, detail)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const flushTransaction = rawDb.transaction((rows: PendingRow[]) => {
  for (const row of rows) {
    insertStmt.run(
      row.ts,
      row.level,
      row.stage,
      row.event,
      row.message,
      row.mapping_id,
      row.bsky_identifier,
      row.twitter_username,
      row.twitter_id,
      row.job_id,
      row.attempt,
      row.duration_ms,
      row.error_name,
      row.error_message,
      row.error_status,
      row.error_code,
      row.error_stack,
      row.detail,
    );
  }
});

/** Writes anything buffered. Safe to call at any time; queries call it first. */
export function flushEventLog(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  try {
    flushTransaction(rows);
    insertedSincePrune += rows.length;
  } catch (err) {
    // Never let logging take the process down. Fall back to stderr so the
    // information is not lost entirely.
    console.error('[event-log] failed to persist entries:', (err as Error).message);
    for (const row of rows.slice(0, 20)) {
      console.error(`[event-log:dropped] ${row.level} ${row.stage} ${row.event} ${row.message}`);
    }
  }
  maybePrune();
}

function scheduleFlush(): void {
  if (FLUSH_INTERVAL_MS === 0) {
    flushEventLog();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushEventLog();
  }, FLUSH_INTERVAL_MS);
  // Logging must not hold the event loop open at shutdown.
  if (typeof (flushTimer as { unref?: () => void }).unref === 'function') {
    (flushTimer as unknown as { unref: () => void }).unref();
  }
}

function maybePrune(): void {
  const now = Date.now();
  if (insertedSincePrune < 500 && now - lastPruneAt < 10 * 60 * 1000) return;
  insertedSincePrune = 0;
  lastPruneAt = now;
  try {
    rawDb.prepare('DELETE FROM event_log WHERE ts < ?').run(now - MAX_AGE_MS);
    // Trim by row count too: a burst of errors can blow past the age budget.
    rawDb.prepare('DELETE FROM event_log WHERE id <= (SELECT MAX(id) - ? FROM event_log)').run(MAX_ROWS);
  } catch (err) {
    console.error('[event-log] prune failed:', (err as Error).message);
  }
}

// --- Console mirror -------------------------------------------------------

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'log' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'log',
  warn: 'warn',
  error: 'error',
};

function consoleLine(input: LogEventInput): string {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const scope: string[] = [];
  if (input.twitterUsername) scope.push(`@${input.twitterUsername}`);
  if (input.bskyIdentifier) scope.push(`→${input.bskyIdentifier}`);
  if (input.twitterId) scope.push(`tweet:${input.twitterId}`);
  const scopeText = scope.length > 0 ? ` [${scope.join(' ')}]` : '';
  const errorText = input.error?.message ? ` :: ${input.error.message}` : '';
  return `[${stamp}] [${input.stage}]${scopeText} ${input.message}${errorText}`;
}

// --- Public API -----------------------------------------------------------

/**
 * Records one event. Never throws: a logging failure must not break a sweep.
 */
export function logEvent(input: LogEventInput): void {
  try {
    if (LEVEL_RANK[input.level] < MIN_RANK) return;

    if (input.console !== false) {
      console[CONSOLE_METHOD[input.level]](consoleLine(input));
    }

    const error = input.error;
    buffer.push({
      ts: Date.now(),
      level: input.level,
      stage: input.stage,
      event: input.event,
      message: redactString(input.message).slice(0, 2_000),
      mapping_id: input.mappingId ?? null,
      bsky_identifier: input.bskyIdentifier ? input.bskyIdentifier.toLowerCase() : null,
      twitter_username: input.twitterUsername ? input.twitterUsername.toLowerCase() : null,
      twitter_id: input.twitterId ?? null,
      job_id: input.jobId ?? null,
      attempt: typeof input.attempt === 'number' ? input.attempt : null,
      duration_ms: typeof input.durationMs === 'number' ? Math.round(input.durationMs) : null,
      error_name: error?.name ?? null,
      error_message: error?.message ? redactString(error.message).slice(0, 2_000) : null,
      error_status: typeof error?.status === 'number' ? error.status : null,
      error_code: error?.code ?? null,
      error_stack: error?.stack ? redactString(error.stack).slice(0, MAX_STACK_CHARS) : null,
      detail: serialiseDetail({
        ...(input.detail || {}),
        ...(error?.response !== undefined ? { errorResponse: error.response } : {}),
        ...(error?.causes?.length ? { errorCauses: error.causes } : {}),
        ...(error?.retryable !== undefined ? { retryable: error.retryable } : {}),
      }),
    });

    // Errors are what people come looking for; get them durable immediately
    // so a crash right after the failure cannot lose the explanation.
    if (input.level === 'error') flushEventLog();
    else scheduleFlush();
  } catch (err) {
    console.error('[event-log] logEvent failed:', (err as Error).message);
  }
}

export interface LogQueryFilters {
  levels?: LogLevel[];
  stages?: LogStage[];
  events?: string[];
  mappingIds?: string[];
  bskyIdentifiers?: string[];
  twitterUsernames?: string[];
  twitterId?: string;
  jobId?: string;
  /** Case-insensitive substring across message, event, error text and detail. */
  search?: string;
  since?: number;
  until?: number;
  /** Keyset pagination: return rows with id strictly below this. */
  beforeId?: number;
  limit?: number;
}

function buildWhere(filters: LogQueryFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const inClause = (column: string, values: string[] | undefined, lower = false) => {
    if (!values || values.length === 0) return;
    const usable = values.slice(0, 500);
    clauses.push(`${column} IN (${usable.map(() => '?').join(', ')})`);
    for (const value of usable) params.push(lower ? value.toLowerCase() : value);
  };

  inClause('level', filters.levels);
  inClause('stage', filters.stages);
  inClause('event', filters.events);
  inClause('mapping_id', filters.mappingIds);
  inClause('bsky_identifier', filters.bskyIdentifiers, true);
  inClause('twitter_username', filters.twitterUsernames, true);

  if (filters.twitterId) {
    clauses.push('twitter_id = ?');
    params.push(filters.twitterId);
  }
  if (filters.jobId) {
    clauses.push('job_id = ?');
    params.push(filters.jobId);
  }
  if (typeof filters.since === 'number') {
    clauses.push('ts >= ?');
    params.push(filters.since);
  }
  if (typeof filters.until === 'number') {
    clauses.push('ts <= ?');
    params.push(filters.until);
  }
  if (typeof filters.beforeId === 'number') {
    clauses.push('id < ?');
    params.push(filters.beforeId);
  }
  if (filters.search?.trim()) {
    const needle = `%${filters.search.trim().toLowerCase()}%`;
    clauses.push(
      '(LOWER(message) LIKE ? OR LOWER(event) LIKE ? OR LOWER(IFNULL(error_message, "")) LIKE ? ' +
        'OR LOWER(IFNULL(detail, "")) LIKE ? OR LOWER(IFNULL(twitter_username, "")) LIKE ? ' +
        'OR LOWER(IFNULL(bsky_identifier, "")) LIKE ? OR IFNULL(twitter_id, "") LIKE ?)',
    );
    for (let i = 0; i < 7; i += 1) params.push(needle);
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function rowToEntry(row: any): LogEntry {
  const error: ErrorDetail = {};
  if (row.error_name) error.name = row.error_name;
  if (row.error_message) error.message = row.error_message;
  if (typeof row.error_status === 'number') error.status = row.error_status;
  if (row.error_code) error.code = row.error_code;
  if (row.error_stack) error.stack = row.error_stack;

  let detail: Record<string, unknown> | undefined;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      detail = { raw: row.detail };
    }
  }

  return {
    id: row.id,
    ts: row.ts,
    level: row.level,
    stage: row.stage,
    event: row.event,
    message: row.message,
    mappingId: row.mapping_id ?? undefined,
    bskyIdentifier: row.bsky_identifier ?? undefined,
    twitterUsername: row.twitter_username ?? undefined,
    twitterId: row.twitter_id ?? undefined,
    jobId: row.job_id ?? undefined,
    attempt: row.attempt ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    error: Object.keys(error).length > 0 ? error : undefined,
    detail,
  };
}

export const eventLogService = {
  /** Newest-first page of entries. */
  query(filters: LogQueryFilters = {}): LogEntry[] {
    flushEventLog();
    const limit = Math.max(1, Math.min(filters.limit ?? 200, 5_000));
    const { sql, params } = buildWhere(filters);
    const rows = rawDb
      .prepare(`SELECT * FROM event_log ${sql} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as any[];
    return rows.map(rowToEntry);
  },

  /**
   * Streams every matching row oldest-first in pages. Used by exports, which
   * can legitimately cover far more rows than a dashboard page.
   */
  *stream(filters: LogQueryFilters = {}, hardLimit = 100_000): Generator<LogEntry> {
    flushEventLog();
    const { sql, params } = buildWhere({ ...filters, beforeId: undefined, limit: undefined });
    const pageSize = 2_000;
    let afterId = 0;
    let emitted = 0;
    while (emitted < hardLimit) {
      const pageSql = sql ? `${sql} AND id > ?` : 'WHERE id > ?';
      const rows = rawDb
        .prepare(`SELECT * FROM event_log ${pageSql} ORDER BY id ASC LIMIT ?`)
        .all(...params, afterId, Math.min(pageSize, hardLimit - emitted)) as any[];
      if (rows.length === 0) return;
      for (const row of rows) {
        afterId = row.id;
        emitted += 1;
        yield rowToEntry(row);
      }
      if (rows.length < pageSize) return;
    }
  },

  count(filters: LogQueryFilters = {}): number {
    flushEventLog();
    const { sql, params } = buildWhere(filters);
    const row = rawDb.prepare(`SELECT COUNT(*) AS c FROM event_log ${sql}`).get(...params) as { c: number } | undefined;
    return row?.c ?? 0;
  },

  /** Headline numbers for the dashboard: totals by level/stage plus the window covered. */
  stats(filters: LogQueryFilters = {}): {
    total: number;
    byLevel: Record<string, number>;
    byStage: Record<string, number>;
    topEvents: { event: string; count: number }[];
    oldestTs: number | null;
    newestTs: number | null;
  } {
    flushEventLog();
    const { sql, params } = buildWhere(filters);
    const byLevelRows = rawDb
      .prepare(`SELECT level, COUNT(*) AS c FROM event_log ${sql} GROUP BY level`)
      .all(...params) as { level: string; c: number }[];
    const byStageRows = rawDb
      .prepare(`SELECT stage, COUNT(*) AS c FROM event_log ${sql} GROUP BY stage`)
      .all(...params) as { stage: string; c: number }[];
    const topEventRows = rawDb
      .prepare(`SELECT event, COUNT(*) AS c FROM event_log ${sql} GROUP BY event ORDER BY c DESC LIMIT 15`)
      .all(...params) as { event: string; c: number }[];
    const bounds = rawDb
      .prepare(`SELECT MIN(ts) AS oldest, MAX(ts) AS newest, COUNT(*) AS total FROM event_log ${sql}`)
      .get(...params) as { oldest: number | null; newest: number | null; total: number } | undefined;

    return {
      total: bounds?.total ?? 0,
      byLevel: Object.fromEntries(byLevelRows.map((row) => [row.level, row.c])),
      byStage: Object.fromEntries(byStageRows.map((row) => [row.stage, row.c])),
      topEvents: topEventRows.map((row) => ({ event: row.event, count: row.c })),
      oldestTs: bounds?.oldest ?? null,
      newestTs: bounds?.newest ?? null,
    };
  },

  /**
   * Everything recorded about one tweet, oldest-first. This is the "why did
   * this fail" view: fetch, media, each posted chunk, retries and the final
   * outcome all share the same twitter_id.
   */
  timelineForTweet(twitterId: string, bskyIdentifier?: string): LogEntry[] {
    flushEventLog();
    const params: unknown[] = [twitterId];
    let sql = 'WHERE twitter_id = ?';
    if (bskyIdentifier) {
      sql += ' AND (bsky_identifier IS NULL OR bsky_identifier = ?)';
      params.push(bskyIdentifier.toLowerCase());
    }
    const rows = rawDb.prepare(`SELECT * FROM event_log ${sql} ORDER BY id ASC LIMIT 500`).all(...params) as any[];
    return rows.map(rowToEntry);
  },

  clear(): number {
    flushEventLog();
    rawDb.prepare('DELETE FROM event_log').run();
    const row = rawDb.prepare('SELECT changes() AS c').get() as { c: number } | undefined;
    return row?.c ?? 0;
  },

  retention(): { maxRows: number; maxAgeDays: number } {
    return { maxRows: MAX_ROWS, maxAgeDays: Math.round(MAX_AGE_MS / (24 * 60 * 60 * 1000)) };
  },
};

// --- Export formatting ----------------------------------------------------

export type LogExportFormat = 'json' | 'ndjson' | 'csv' | 'txt';

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, '\\n')}"`;
}

const CSV_COLUMNS = [
  'id',
  'timestamp',
  'level',
  'stage',
  'event',
  'message',
  'twitterUsername',
  'twitterId',
  'bskyIdentifier',
  'mappingId',
  'jobId',
  'attempt',
  'durationMs',
  'errorName',
  'errorStatus',
  'errorCode',
  'errorMessage',
  'detail',
] as const;

function entryToCsvRow(entry: LogEntry): string {
  return [
    entry.id,
    new Date(entry.ts).toISOString(),
    entry.level,
    entry.stage,
    entry.event,
    entry.message,
    entry.twitterUsername,
    entry.twitterId,
    entry.bskyIdentifier,
    entry.mappingId,
    entry.jobId,
    entry.attempt,
    entry.durationMs,
    entry.error?.name,
    entry.error?.status,
    entry.error?.code,
    entry.error?.message,
    entry.detail ? JSON.stringify(entry.detail) : '',
  ]
    .map(csvCell)
    .join(',');
}

/** Single-line, grep-friendly rendering used by the txt export and clipboard copy. */
export function formatEntryAsText(entry: LogEntry): string {
  const parts = [
    new Date(entry.ts).toISOString(),
    entry.level.toUpperCase().padEnd(5),
    `[${entry.stage}]`,
    entry.event,
  ];
  const scope: string[] = [];
  if (entry.twitterUsername) scope.push(`@${entry.twitterUsername}`);
  if (entry.bskyIdentifier) scope.push(`→${entry.bskyIdentifier}`);
  if (entry.twitterId) scope.push(`tweet=${entry.twitterId}`);
  if (typeof entry.attempt === 'number') scope.push(`attempt=${entry.attempt}`);
  if (typeof entry.durationMs === 'number') scope.push(`took=${entry.durationMs}ms`);
  if (scope.length > 0) parts.push(`(${scope.join(' ')})`);
  parts.push('-', entry.message);
  if (entry.error?.message) {
    const status = entry.error.status ? ` http=${entry.error.status}` : '';
    parts.push(`| error: ${entry.error.name || 'Error'}${status}: ${entry.error.message}`);
  }
  if (entry.detail && Object.keys(entry.detail).length > 0) {
    parts.push(`| detail: ${JSON.stringify(entry.detail)}`);
  }
  return parts.join(' ');
}

export interface ExportMeta {
  generatedAt: string;
  filters: LogQueryFilters;
  appVersion?: string;
  [key: string]: unknown;
}

/**
 * Renders matching entries in the requested format. Returns the body plus the
 * content type and a suggested filename so the route stays thin.
 */
export function exportLogs(
  format: LogExportFormat,
  filters: LogQueryFilters,
  meta: ExportMeta,
  hardLimit = 100_000,
): { body: string; contentType: string; filename: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const entries = [...eventLogService.stream(filters, hardLimit)];

  if (format === 'ndjson') {
    const lines = [JSON.stringify({ _meta: { ...meta, entryCount: entries.length } })];
    for (const entry of entries) lines.push(JSON.stringify(entry));
    return {
      body: `${lines.join('\n')}\n`,
      contentType: 'application/x-ndjson; charset=utf-8',
      filename: `tweets-2-bsky-logs-${stamp}.ndjson`,
    };
  }

  if (format === 'csv') {
    const lines = [CSV_COLUMNS.join(',')];
    for (const entry of entries) lines.push(entryToCsvRow(entry));
    return {
      body: `${lines.join('\n')}\n`,
      contentType: 'text/csv; charset=utf-8',
      filename: `tweets-2-bsky-logs-${stamp}.csv`,
    };
  }

  if (format === 'txt') {
    const header = [
      '# tweets-2-bsky log export',
      `# generated: ${meta.generatedAt}`,
      meta.appVersion ? `# version: ${meta.appVersion}` : null,
      `# entries: ${entries.length}`,
      `# filters: ${JSON.stringify(meta.filters)}`,
      '',
    ].filter((line): line is string => line !== null);
    return {
      body: `${[...header, ...entries.map(formatEntryAsText)].join('\n')}\n`,
      contentType: 'text/plain; charset=utf-8',
      filename: `tweets-2-bsky-logs-${stamp}.log`,
    };
  }

  return {
    body: `${JSON.stringify({ meta: { ...meta, entryCount: entries.length }, entries }, null, 2)}\n`,
    contentType: 'application/json; charset=utf-8',
    filename: `tweets-2-bsky-logs-${stamp}.json`,
  };
}

// Best-effort durability if the process is asked to stop.
for (const signal of ['beforeExit', 'SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    try {
      flushEventLog();
    } catch {
      // shutting down anyway
    }
  });
}
