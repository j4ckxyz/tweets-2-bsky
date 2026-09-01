// Per-account health: how fast each mirror is keeping up, when it last posted,
// what is queued behind it, and whether its Bluesky account is down. The
// numbers all existed in the log and the queue already — this is the screen
// that answers "is this mirror healthy?" without reading either.
import { AlertTriangle, Clock, Gauge, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { cn } from '../lib/utils';

export interface AccountHealthSource {
  twitterUsername: string;
  tier: string;
  lastCheckedAt: number | null;
  lastFoundAt: number | null;
  dueInMs: number;
}

export interface AccountHealthRow {
  mappingId: string;
  bskyIdentifier: string;
  twitterUsernames: string[];
  enabled: boolean;
  groupName?: string;
  groupEmoji?: string;
  down: { state: string; reason: string; detectedAt: number } | null;
  lag: { samples: number; averageMs: number; medianMs: number; p95Ms: number; worstMs: number } | null;
  posts: { posted: number; skipped: number; failed: number; lastPostedAt: number | null };
  queue: { pending: number; processing: number; failed: number };
  sources: AccountHealthSource[];
}

export interface AccountHealthResponse {
  windowDays: number;
  accounts: AccountHealthRow[];
  summary: {
    accounts: number;
    down: number;
    averageLagMs: number | null;
    lagSamples: number;
    postedInWindow: number;
  };
}

// The stated goal is a 5-10 minute mirror delay, so the thresholds mark where a
// mirror stops meeting it rather than using round numbers for their own sake.
const LAG_GOOD_MS = 10 * 60 * 1000;
const LAG_WARN_MS = 30 * 60 * 1000;

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

function formatAgo(timestamp: number | null): string {
  if (!timestamp) return 'never';
  return `${formatDuration(Date.now() - timestamp)} ago`;
}

function lagTone(lagMs: number): string {
  if (lagMs <= LAG_GOOD_MS) return 'text-emerald-600 dark:text-emerald-400';
  if (lagMs <= LAG_WARN_MS) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

const TIER_LABEL: Record<string, string> = {
  active: 'checked every sweep',
  recent: 'checked every 10m',
  quiet: 'checked every 30m',
  dormant: 'checked hourly',
};

export function AccountHealth({
  authHeaders,
  onAuthFailure,
}: {
  authHeaders?: Record<string, string>;
  onAuthFailure?: () => void;
}) {
  const [data, setData] = useState<AccountHealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'lag' | 'name' | 'recent'>('lag');

  const load = useCallback(async () => {
    if (!authHeaders) return;
    setLoading(true);
    try {
      const response = await axios.get<AccountHealthResponse>('/api/account-health', { headers: authHeaders });
      setData(response.data);
      setError(null);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        onAuthFailure?.();
        return;
      }
      setError('Could not load account health.');
    } finally {
      setLoading(false);
    }
  }, [authHeaders, onAuthFailure]);

  useEffect(() => {
    void load();
  }, [load]);

  const accounts = useMemo(() => {
    const rows = [...(data?.accounts ?? [])];
    // Down accounts float to the top whatever the sort: they are the ones that
    // need a human, and a paused mirror has no lag to rank by.
    rows.sort((a, b) => {
      if (Boolean(a.down) !== Boolean(b.down)) return a.down ? -1 : 1;
      if (sortBy === 'name') return a.bskyIdentifier.localeCompare(b.bskyIdentifier);
      if (sortBy === 'recent') return (b.posts.lastPostedAt ?? 0) - (a.posts.lastPostedAt ?? 0);
      return (b.lag?.averageMs ?? -1) - (a.lag?.averageMs ?? -1);
    });
    return rows;
  }, [data, sortBy]);

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
        {error}{' '}
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
        {loading ? 'Loading account health…' : 'No account health yet.'}
      </div>
    );
  }

  const { summary } = data;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Average mirror delay</span>
            <strong className={summary.averageLagMs === null ? '' : lagTone(summary.averageLagMs)}>
              {summary.averageLagMs === null ? 'no data yet' : formatDuration(summary.averageLagMs)}
            </strong>
          </span>
          <span className="text-muted-foreground">
            {summary.postedInWindow} posted in {data.windowDays}d
          </span>
          {summary.down > 0 ? (
            <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
              <AlertTriangle className="h-4 w-4" />
              {summary.down} account{summary.down === 1 ? '' : 's'} down
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as typeof sortBy)}
          >
            <option value="lag">Slowest first</option>
            <option value="recent">Recently posted</option>
            <option value="name">By handle</option>
          </select>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {summary.lagSamples === 0 ? (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Mirror delay is measured from tweets posted after this update. Numbers appear as new tweets are mirrored.
        </p>
      ) : null}

      <div className="grid gap-2 md:grid-cols-2">
        {accounts.map((account) => {
          const hottest = account.sources.reduce<AccountHealthSource | null>(
            (best, source) => (best === null || source.dueInMs < best.dueInMs ? source : best),
            null,
          );
          return (
            <div
              key={account.mappingId}
              className={cn(
                'cv-auto rounded-lg border bg-background p-3',
                account.down ? 'border-red-500/50' : 'border-border',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {account.groupEmoji ? `${account.groupEmoji} ` : ''}
                    {account.bskyIdentifier}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {account.twitterUsernames.map((name) => `@${name}`).join(', ')}
                  </p>
                </div>
                {account.down ? (
                  <Badge className="bg-red-600 text-white">{account.down.state}</Badge>
                ) : account.enabled ? null : (
                  <Badge variant="secondary">paused</Badge>
                )}
              </div>

              {account.down ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{account.down.reason}</p> : null}

              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <p className="text-muted-foreground">Avg delay</p>
                  <p className={cn('font-medium', account.lag ? lagTone(account.lag.averageMs) : '')}>
                    {account.lag ? formatDuration(account.lag.averageMs) : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Worst</p>
                  <p className="font-medium">{account.lag ? formatDuration(account.lag.worstMs) : '—'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Last post</p>
                  <p className="font-medium">{formatAgo(account.posts.lastPostedAt)}</p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {hottest ? (TIER_LABEL[hottest.tier] ?? hottest.tier) : 'no sources'}
                </span>
                <span>·</span>
                <span>{account.posts.posted} posted</span>
                {account.queue.pending > 0 ? <span>· {account.queue.pending} queued</span> : null}
                {account.queue.failed > 0 ? (
                  <span className="text-red-600 dark:text-red-400">· {account.queue.failed} parked</span>
                ) : null}
                {account.lag ? <span>· {account.lag.samples} sampled</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
