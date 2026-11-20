import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
// Per-account health: how fast each mirror is keeping up, when it last posted,
// what is queued behind it, and whether its Bluesky account is down. The
// numbers all existed in the log and the queue already — this is the screen
// that answers "is this mirror healthy?" without reading either.
import { ChevronRight, RefreshCw, Search } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api';
import { queryKeys } from '../lib/query-keys';
import type { AccountHealthResponse, AccountHealthRow, AccountHealthSource } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

// The stated goal is a 5-10 minute mirror delay, so the thresholds mark where a
// mirror stops meeting it rather than using round numbers for their own sake.
const LAG_GOOD_MS = 10 * 60 * 1000;
const LAG_WARN_MS = 30 * 60 * 1000;

// The transit bar spends almost nothing on on-time routes, so a healthy route
// is a short tick and only slow or late routes run long across the track.
const TRANSIT_MAX_MS = 4 * 60 * 60 * 1000;
const TRANSIT_ONTIME_SHARE = 0.06;

function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Compact form for table cells: one unit pair at most.
function formatShort(ms: number): string {
  if (ms < 60 * 1000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatAgo(timestamp: number | null): string {
  if (!timestamp) return 'never';
  return `${formatShort(Date.now() - timestamp)} ago`;
}

type Standing = 'attention' | 'slow' | 'ontime' | 'nodata';

const STANDING_LABEL: Record<Standing, string> = {
  attention: 'Needs attention',
  slow: 'Slow',
  ontime: 'On time',
  nodata: 'No delay data yet',
};

const STANDING_HINT: Record<Standing, string> = {
  attention: 'down, erroring, or typically over 30 minutes',
  slow: 'typically 10–30 minutes',
  ontime: 'typically under 10 minutes',
  nodata: 'no tweets mirrored in the window',
};

const STANDING_ORDER: Standing[] = ['attention', 'slow', 'ontime', 'nodata'];

function lagStanding(lagMs: number): Exclude<Standing, 'attention' | 'nodata'> | 'attention' {
  if (lagMs <= LAG_GOOD_MS) return 'ontime';
  if (lagMs <= LAG_WARN_MS) return 'slow';
  return 'attention';
}

function standingOf(account: AccountHealthRow): Standing {
  if (account.down) return 'attention';
  if (account.queue.failed > 0) return 'attention';
  if (account.sources.some((source) => source.lastError || source.protectedSince)) return 'attention';
  if (!account.lag) return 'nodata';
  return lagStanding(account.lag.medianMs);
}

const LAG_TEXT: Record<string, string> = {
  ontime: 'text-foreground',
  slow: 'text-slow',
  attention: 'text-late',
};

const LAG_INK: Record<string, string> = {
  ontime: 'bg-foreground/35',
  slow: 'bg-slow',
  attention: 'bg-late',
};

const DOWN_LABEL: Record<string, string> = {
  takendown: 'Taken down',
  suspended: 'Suspended',
  deactivated: 'Deactivated',
  unknown: 'Unavailable',
};

const TIER_LABEL: Record<string, string> = {
  priority: 'every sweep',
  active: 'every sweep',
  recent: 'every 10m',
  quiet: 'every 30m',
  dormant: 'hourly',
};

function transitPosition(ms: number): number {
  const clamped = Math.min(TRANSIT_MAX_MS, Math.max(0, ms));
  if (clamped <= LAG_GOOD_MS) return (clamped / LAG_GOOD_MS) * TRANSIT_ONTIME_SHARE;
  const beyond = Math.sqrt((clamped - LAG_GOOD_MS) / (TRANSIT_MAX_MS - LAG_GOOD_MS));
  return TRANSIT_ONTIME_SHARE + beyond * (1 - TRANSIT_ONTIME_SHARE);
}

// Tweeted (left post) to posted (right post): the route's average transit is
// the run, the worst case a faint tail beyond it.
function TransitBar({ typicalMs, tailMs }: { typicalMs: number; tailMs: number }) {
  const standing = lagStanding(typicalMs);
  const avg = Math.max(0.015, transitPosition(typicalMs));
  const worst = Math.max(avg, transitPosition(tailMs));
  return (
    <div className="relative h-3 w-full" aria-hidden="true">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
      <div
        className={cn('absolute top-1/2 h-px -translate-y-1/2 opacity-50', LAG_INK[standing])}
        style={{ left: `${avg * 100}%`, width: `${(worst - avg) * 100}%` }}
      />
      <div
        className={cn('absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full', LAG_INK[standing])}
        style={{ width: `${avg * 100}%` }}
      />
      <span
        className={cn(
          'absolute left-0 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full',
          LAG_INK[standing],
        )}
      />
      <span
        className={cn(
          'absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card',
          LAG_INK[standing],
        )}
        style={{ left: `${avg * 100}%` }}
      />
    </div>
  );
}

// Post volume as a dot on a fixed size ramp, so busy routes read at a glance
// without another number column.
function VolumeDot({ posted }: { posted: number }) {
  const size = posted === 0 ? 4 : posted < 5 ? 4 : posted < 20 ? 6 : posted < 60 ? 9 : 12;
  return (
    <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center" title={`${posted} posted in the window`}>
      <span
        className={cn('rounded-full', posted === 0 ? 'border border-muted-foreground/60' : 'bg-foreground/45')}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

const GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.6fr)_4.5rem_6.75rem_5.5rem_1rem] md:items-center';

export interface RouteSummary {
  routes: number;
  attention: number;
  typicalLagMs: number | null;
}

export function formatTransit(ms: number): string {
  return formatDuration(ms);
}

// Median of per-route medians: the headline number. Retries and catch-up after
// an outage drag the sample mean far from what a typical tweet sees.
function typicalLag(accounts: AccountHealthRow[]): number | null {
  const medians = accounts
    .map((account) => account.lag?.medianMs)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  return medians.length === 0 ? null : medians[Math.floor((medians.length - 1) / 2)];
}

export function AccountHealth({
  authHeaders,
  onAuthFailure,
  onOpenAccount,
  onSummary,
}: {
  authHeaders?: Record<string, string>;
  onAuthFailure?: () => void;
  onOpenAccount?: (mappingId: string) => void;
  onSummary?: (summary: RouteSummary) => void;
}) {
  const [sortBy, setSortBy] = useState<'lag' | 'name' | 'recent'>('lag');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAllOnTime, setShowAllOnTime] = useState(false);

  const healthQuery = useQuery({
    queryKey: queryKeys.accountHealth,
    queryFn: async () => (await api.getAccountHealth({ headers: authHeaders })).data,
    enabled: Boolean(authHeaders),
  });
  const data: AccountHealthResponse | null = healthQuery.data ?? null;
  const loading = healthQuery.isFetching;
  const healthError = healthQuery.error;
  const signedOut = axios.isAxiosError(healthError) && healthError.response?.status === 401;
  const error = healthError && !signedOut ? 'Could not load account health.' : null;
  useEffect(() => {
    if (signedOut) {
      onAuthFailure?.();
    }
  }, [onAuthFailure, signedOut]);
  const { refetch } = healthQuery;
  const load = useCallback(async () => {
    await refetch();
  }, [refetch]);

  useEffect(() => {
    if (!data || !onSummary) return;
    onSummary({
      routes: data.accounts.length,
      attention: data.accounts.filter((account) => standingOf(account) === 'attention').length,
      typicalLagMs: typicalLag(data.accounts),
    });
  }, [data, onSummary]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/^@/, '');
    const rows = (data?.accounts ?? []).filter(
      (account) =>
        !needle ||
        account.bskyIdentifier.toLowerCase().includes(needle) ||
        account.twitterUsernames.some((name) => name.toLowerCase().includes(needle)),
    );
    rows.sort((a, b) => {
      // Down accounts lead their group whatever the sort: they need a human,
      // and a paused mirror has no lag to rank by.
      if (Boolean(a.down) !== Boolean(b.down)) return a.down ? -1 : 1;
      if (sortBy === 'name') return a.bskyIdentifier.localeCompare(b.bskyIdentifier);
      if (sortBy === 'recent') return (b.posts.lastPostedAt ?? 0) - (a.posts.lastPostedAt ?? 0);
      return (b.lag?.medianMs ?? -1) - (a.lag?.medianMs ?? -1);
    });
    const byStanding = new Map<Standing, AccountHealthRow[]>();
    for (const row of rows) {
      const standing = standingOf(row);
      byStanding.set(standing, [...(byStanding.get(standing) ?? []), row]);
    }
    return STANDING_ORDER.filter((standing) => byStanding.has(standing)).map((standing) => ({
      standing,
      rows: byStanding.get(standing) ?? [],
    }));
  }, [data, sortBy, query]);

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 border-y border-border py-4 text-sm text-muted-foreground">
        {error}
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-px border-y border-border" aria-busy={loading}>
        {['a', 'b', 'c', 'd', 'e'].map((key) => (
          <div key={key} className="flex items-center gap-4 py-3.5">
            <div className="h-3 w-48 animate-pulse rounded bg-muted" />
            <div className="h-1 flex-1 animate-pulse rounded bg-muted" />
          </div>
        ))}
        <p className="sr-only">{loading ? 'Loading account health…' : 'No account health yet.'}</p>
      </div>
    );
  }

  const { summary } = data;
  const typicalLagMs = typicalLag(data.accounts);
  const lateCount = groups.find((group) => group.standing === 'attention')?.rows.length ?? 0;
  const searching = query.trim().length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Typical transit</dt>
            <dd
              className={cn(
                'text-base font-semibold tabular-nums',
                typicalLagMs === null ? 'text-muted-foreground' : LAG_TEXT[lagStanding(typicalLagMs)],
              )}
            >
              {typicalLagMs === null ? 'no data yet' : formatDuration(typicalLagMs)}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Need attention</dt>
            <dd className={cn('font-semibold tabular-nums', lateCount > 0 ? 'text-late' : 'text-foreground')}>
              {lateCount}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">Posted in {data.windowDays}d</dt>
            <dd className="font-semibold tabular-nums">{summary.postedInWindow.toLocaleString()}</dd>
          </div>
        </dl>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <label className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
            <span className="sr-only">Filter routes</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-8 w-full rounded-md border border-input bg-card pl-8 pr-2 text-[13px] text-foreground placeholder:text-muted-foreground hover:border-foreground/25"
              placeholder="Filter by handle"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            className="h-8 rounded-md border border-input bg-card px-2 text-[13px] hover:border-foreground/25"
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as typeof sortBy)}
            aria-label="Sort routes"
          >
            <option value="lag">Slowest first</option>
            <option value="recent">Recently posted</option>
            <option value="name">By handle</option>
          </select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh account health"
            title="Refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {summary.lagSamples === 0 ? (
        <p className="border-l-0 bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
          Transit time is measured from tweets mirrored after this update. Numbers appear as new tweets come through.
        </p>
      ) : null}

      <div className="text-sm">
        <div
          aria-hidden="true"
          className={cn(GRID, 'hidden border-b border-border pb-2 text-xs font-medium text-muted-foreground md:grid')}
        >
          <span>Route</span>
          <span className="flex justify-between">
            <span>Typical transit</span>
            <span className="font-normal">0 · 4h</span>
          </span>
          <span className="text-right">95th pct</span>
          <span className="text-right">Last post</span>
          <span>Checked</span>
          <span />
        </div>

        {groups.length === 0 ? (
          <p className="border-b border-border py-6 text-center text-sm text-muted-foreground">
            No routes match “{query}”.
          </p>
        ) : null}

        {groups.map(({ standing, rows }) => {
          const collapsible = standing === 'ontime' && !searching && !showAllOnTime && rows.length > 12;
          const visibleRows = collapsible ? rows.slice(0, 8) : rows;
          return (
            <section key={standing} aria-label={STANDING_LABEL[standing]}>
              <h3 className="flex items-baseline gap-2 border-b border-border pb-1.5 pt-5 text-xs font-normal">
                <span
                  className={cn(
                    'font-semibold',
                    standing === 'attention' ? 'text-late' : standing === 'slow' ? 'text-slow' : 'text-foreground',
                  )}
                >
                  {STANDING_LABEL[standing]}
                </span>
                <span className="tabular-nums text-muted-foreground">{rows.length}</span>
                <span className="hidden text-muted-foreground sm:inline">· {STANDING_HINT[standing]}</span>
              </h3>

              {visibleRows.map((account) => {
                const rowStanding = account.lag ? lagStanding(account.lag.medianMs) : 'ontime';
                const nextSource = account.sources.reduce<AccountHealthSource | null>(
                  (best, source) => (best === null || source.dueInMs < best.dueInMs ? source : best),
                  null,
                );
                const problems = [
                  ...(account.down ? [{ key: 'down', tone: 'late', text: account.down.reason }] : []),
                  ...account.sources
                    .filter((source) => source.lastError || source.protectedSince)
                    .map((source) => ({
                      key: `src-${source.twitterUsername}`,
                      tone: 'slow',
                      text: `@${source.twitterUsername}: ${
                        source.protectedSince ? 'protected on X, tweets cannot be read' : source.lastError
                      }`,
                    })),
                  ...(account.queue.failed > 0
                    ? [
                        {
                          key: 'parked',
                          tone: 'late',
                          text: `${account.queue.failed} tweet${account.queue.failed === 1 ? '' : 's'} failed to post`,
                        },
                      ]
                    : []),
                ];
                const expanded = expandedId === account.mappingId;
                return (
                  <Fragment key={account.mappingId}>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setExpandedId(expanded ? null : account.mappingId)}
                      className={cn(
                        GRID,
                        'cv-route w-full cursor-pointer border-b text-left border-border/70 py-2.5 transition-colors duration-150 hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04] focus-visible:outline-none',
                        expanded && 'bg-foreground/[0.03]',
                        !account.enabled && 'opacity-60',
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <VolumeDot posted={account.posts.posted} />
                          <span className="truncate font-medium">{account.bskyIdentifier}</span>
                          {account.down ? (
                            <Badge variant="danger">{DOWN_LABEL[account.down.state] ?? account.down.state}</Badge>
                          ) : null}
                          {!account.enabled ? <Badge variant="outline">paused</Badge> : null}
                        </div>
                        <p className="ml-5 truncate text-xs text-muted-foreground">
                          from {account.twitterUsernames.map((name) => `@${name}`).join(', ')}
                        </p>
                        {problems.map((problem) => (
                          <p
                            key={problem.key}
                            className={cn(
                              'ml-5 mt-0.5 truncate text-xs',
                              problem.tone === 'late' ? 'text-late' : 'text-slow',
                            )}
                            title={problem.text}
                          >
                            {problem.text}
                          </p>
                        ))}
                      </div>

                      <div className="col-span-2 flex items-center gap-3 md:col-span-1">
                        {account.lag ? (
                          <>
                            <div className="min-w-0 flex-1">
                              <TransitBar typicalMs={account.lag.medianMs} tailMs={account.lag.p95Ms} />
                            </div>
                            <span className={cn('w-16 shrink-0 text-right font-medium', LAG_TEXT[rowStanding])}>
                              {formatShort(account.lag.medianMs)}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">no samples</span>
                        )}
                      </div>

                      <div className="hidden text-right text-muted-foreground md:block">
                        {account.lag ? formatShort(account.lag.p95Ms) : '—'}
                      </div>
                      <div className="hidden text-right text-muted-foreground md:block">
                        {formatAgo(account.posts.lastPostedAt)}
                      </div>
                      <div className="hidden truncate text-xs text-muted-foreground md:block">
                        {nextSource ? (TIER_LABEL[nextSource.tier] ?? nextSource.tier) : 'no sources'}
                      </div>
                      <div className="row-start-1 col-start-2 self-start md:row-auto md:col-auto md:self-center">
                        <ChevronRight
                          className={cn(
                            'h-4 w-4 text-muted-foreground transition-transform duration-150',
                            expanded && 'rotate-90',
                          )}
                        />
                      </div>
                    </button>

                    {expanded ? (
                      <div className="border-b border-border/70 bg-foreground/[0.03] px-5 pb-4 pt-1">
                        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4 lg:grid-cols-6">
                          {[
                            ['Average', account.lag ? formatShort(account.lag.averageMs) : '—'],
                            ['95th pct', account.lag ? formatShort(account.lag.p95Ms) : '—'],
                            ['Worst', account.lag ? formatShort(account.lag.worstMs) : '—'],
                            ['Sampled', account.lag ? String(account.lag.samples) : '0'],
                            ['Posted', String(account.posts.posted)],
                            ['Queued', String(account.queue.pending + account.queue.processing)],
                          ].map(([label, value]) => (
                            <div key={label}>
                              <dt className="text-muted-foreground">{label}</dt>
                              <dd className="font-medium">{value}</dd>
                            </div>
                          ))}
                        </dl>
                        {account.sources.length > 0 ? (
                          <ul className="mt-3 space-y-1 text-xs">
                            {account.sources.map((source) => (
                              <li key={source.twitterUsername} className="flex flex-wrap gap-x-3 text-muted-foreground">
                                <span className="font-medium text-foreground">@{source.twitterUsername}</span>
                                <span>checked {TIER_LABEL[source.tier] ?? source.tier}</span>
                                <span>last checked {formatAgo(source.lastCheckedAt)}</span>
                                <span>next {source.dueInMs <= 0 ? 'now' : `in ${formatShort(source.dueInMs)}`}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {onOpenAccount ? (
                          <Button
                            className="mt-3"
                            size="sm"
                            variant="outline"
                            onClick={() => onOpenAccount(account.mappingId)}
                          >
                            Open account
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}

              {collapsible ? (
                <button
                  type="button"
                  className="w-full border-b border-border/70 py-2.5 text-left text-xs font-medium text-primary hover:underline"
                  onClick={() => setShowAllOnTime(true)}
                >
                  Show {rows.length - visibleRows.length} more on-time routes
                </button>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
