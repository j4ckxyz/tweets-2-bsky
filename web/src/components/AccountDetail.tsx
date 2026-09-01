// One page per mirrored account: its configuration, health, queue, recent
// posts and log, plus every action that applies to it. Managing one account
// previously meant hopping between the account list, the activity tab, the
// failed-queue panel and the log.
//
// Actions are hidden when the viewer cannot manage this account, but that is
// only presentation — the server re-checks permission on every one of them.
import axios from 'axios';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  ExternalLink,
  Gauge,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Unlock,
  UserRoundCog,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { cn } from '../lib/utils';
import { MirrorPreview } from './MirrorPreview';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface QueueItemView {
  twitter_id: string;
  twitter_username: string;
  status: string;
  attempts: number;
  tweet_text?: string;
  last_error?: string;
  failure_stage?: string;
  enqueued_at: number;
  not_before: number;
  updated_at: number;
}

interface AccountDetailResponse {
  mapping: {
    id: string;
    bskyIdentifier: string;
    bskyServiceUrl?: string;
    twitterUsernames: string[];
    enabled: boolean;
    owner?: string;
    groupName?: string;
    groupEmoji?: string;
    hasBotLabel?: boolean;
    profileSyncSourceUsername?: string;
    lastProfileSyncAt?: string;
    lastPinnedTweetId?: string;
    lastPinSyncAt?: string;
  };
  permissions: { canManage: boolean; canQueueBackfills: boolean; canRunNow: boolean; isAdmin: boolean };
  down: { state: string; reason: string; detectedAt: number; nextRecheckAt: number; checks: number } | null;
  lag: { samples: number; averageMs: number; medianMs: number; p95Ms: number; worstMs: number } | null;
  posts: { posted: number; skipped: number; failed: number; lastPostedAt: number | null };
  queue: {
    pending: number;
    ready: number;
    backoff: number;
    processing: number;
    failed: number;
    nextRetryAt: number | null;
    oldestEnqueuedAt: number | null;
    items: QueueItemView[];
  };
  sources: {
    twitterUsername: string;
    tier: string;
    dueInMs: number;
    lastCheckedAt: number | null;
    lastFoundAt: number | null;
    emptyStreak: number;
  }[];
  recentPosts: {
    twitter_id: string;
    tweet_text?: string;
    bsky_uri?: string;
    status: string;
    created_at?: string;
    posted_at?: number;
    tweet_created_at?: number;
  }[];
  recentLogs: { id: number; level: string; stage: string; event: string; message: string; timestamp: number }[];
}

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

function formatAgo(timestamp: number | null | undefined): string {
  if (!timestamp) return 'never';
  return `${formatDuration(Date.now() - timestamp)} ago`;
}

const TIER_LABEL: Record<string, string> = {
  active: 'every sweep',
  recent: 'every 10m',
  quiet: 'every 30m',
  dormant: 'hourly',
};

const LEVEL_TONE: Record<string, string> = {
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-muted-foreground',
  debug: 'text-muted-foreground/70',
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-lg font-semibold', tone)}>{value}</p>
    </div>
  );
}

export function AccountDetail({
  mappingId,
  authHeaders,
  onBack,
  onNotice,
}: {
  mappingId: string;
  authHeaders?: Record<string, string>;
  onBack: () => void;
  onNotice?: (type: 'success' | 'error', message: string) => void;
}) {
  const [data, setData] = useState<AccountDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [backfillLimit, setBackfillLimit] = useState('50');

  const load = useCallback(async () => {
    if (!authHeaders) return;
    try {
      const response = await axios.get<AccountDetailResponse>(`/api/accounts/${mappingId}`, { headers: authHeaders });
      setData(response.data);
      setError(null);
    } catch (err) {
      const message = axios.isAxiosError(err)
        ? ((err.response?.data as { error?: string } | undefined)?.error ?? err.message)
        : 'Could not load this account.';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, mappingId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The queue and log move while the page is open, so a slow poll keeps it
  // honest without the page needing a manual refresh to be trusted.
  useEffect(() => {
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [load]);

  const act = useCallback(
    async (key: string, run: () => Promise<{ data?: { message?: string } }>, fallbackMessage: string) => {
      setBusy(key);
      try {
        const response = await run();
        onNotice?.('success', response?.data?.message || fallbackMessage);
        await load();
      } catch (err) {
        const message = axios.isAxiosError(err)
          ? ((err.response?.data as { error?: string } | undefined)?.error ?? err.message)
          : fallbackMessage;
        onNotice?.('error', message);
      } finally {
        setBusy(null);
      }
    },
    [load, onNotice],
  );

  if (loading) {
    return <p className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  if (error || !data) {
    return (
      <div className="space-y-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to accounts
        </Button>
        <p className="rounded-lg border border-red-500/40 bg-red-500/5 p-4 text-sm">{error ?? 'Account not found.'}</p>
      </div>
    );
  }

  const { mapping, permissions, down, lag, posts, queue, sources, recentPosts, recentLogs } = data;
  const canManage = permissions.canManage;
  const stuck = queue.processing > 0;

  return (
    <section className="space-y-4 animate-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-1">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to accounts
          </Button>
          <h2 className="text-xl font-semibold">
            {mapping.groupEmoji ? `${mapping.groupEmoji} ` : ''}
            {mapping.bskyIdentifier}
          </h2>
          <p className="text-sm text-muted-foreground">
            Mirroring {mapping.twitterUsernames.map((name) => `@${name}`).join(', ')}
            {mapping.owner ? ` · owned by ${mapping.owner}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {down ? <Badge className="bg-red-600 text-white">{down.state}</Badge> : null}
          <Badge variant={mapping.enabled ? 'default' : 'secondary'}>{mapping.enabled ? 'Active' : 'Paused'}</Badge>
          {mapping.hasBotLabel ? <Badge variant="secondary">Bot-labeled</Badge> : null}
          <a
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            href={`https://bsky.app/profile/${mapping.bskyIdentifier}`}
            target="_blank"
            rel="noreferrer"
          >
            Open on Bluesky
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>

      {down ? (
        <div className="rounded-lg border border-red-500/50 bg-red-500/5 p-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-red-600 dark:text-red-400">
            <AlertTriangle className="h-4 w-4" />
            Posting is paused: this Bluesky account is {down.state}.
          </p>
          <p className="mt-1 text-muted-foreground">{down.reason}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Detected {formatAgo(down.detectedAt)} · {down.checks} check{down.checks === 1 ? '' : 's'} · next automatic
            recheck {down.nextRecheckAt > Date.now() ? `in ${formatDuration(down.nextRecheckAt - Date.now())}` : 'due'}
          </p>
          {canManage ? (
            <Button
              className="mt-2"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act(
                  'recheck',
                  () => axios.post(`/api/mappings/${mapping.id}/recheck-account`, {}, { headers: authHeaders }),
                  'Recheck queued.',
                )
              }
            >
              <RefreshCw className={cn('mr-2 h-4 w-4', busy === 'recheck' && 'animate-spin')} />
              Recheck now
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Average mirror delay" value={lag ? formatDuration(lag.averageMs) : 'no data yet'} />
        <Stat label="Worst delay (7d)" value={lag ? formatDuration(lag.worstMs) : '—'} />
        <Stat label="Posted (7d)" value={String(posts.posted)} />
        <Stat label="Last post" value={formatAgo(posts.lastPostedAt)} />
      </div>

      {canManage ? (
        <div className="rounded-lg border border-border bg-background p-4">
          <h3 className="text-sm font-medium">Actions</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Checking for tweets does not repost anything: tweets already mirrored are skipped by id.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {permissions.canQueueBackfills ? (
              <>
                <Button
                  variant="default"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    act(
                      'check',
                      () => axios.post(`/api/backfill/${mapping.id}`, { limit: 15 }, { headers: authHeaders }),
                      'Checking this account for new tweets.',
                    )
                  }
                >
                  <RefreshCw className={cn('mr-2 h-4 w-4', busy === 'check' && 'animate-spin')} />
                  Check for new tweets now
                </Button>
                <div className="flex items-center gap-1">
                  <Input
                    className="h-9 w-20"
                    type="number"
                    min={1}
                    max={200}
                    value={backfillLimit}
                    onChange={(event) => setBackfillLimit(event.target.value)}
                    aria-label="Number of tweets to scan"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      act(
                        'backfill',
                        () =>
                          axios.post(
                            `/api/backfill/${mapping.id}`,
                            { limit: Number(backfillLimit) || 50 },
                            { headers: authHeaders },
                          ),
                        'Backfill queued.',
                      )
                    }
                  >
                    Scan older tweets
                  </Button>
                </div>
              </>
            ) : null}

            <Button
              variant={stuck ? 'default' : 'outline'}
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act(
                  'unjam',
                  () => axios.post(`/api/accounts/${mapping.id}/unjam`, {}, { headers: authHeaders }),
                  'Checked for stuck queue items.',
                )
              }
              title="Re-arm queue items left claimed by a worker that never finished"
            >
              <Unlock className={cn('mr-2 h-4 w-4', busy === 'unjam' && 'animate-pulse')} />
              Unjam queue
            </Button>

            {queue.failed > 0 ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  act(
                    'retry',
                    () =>
                      axios.post(`/api/accounts/${mapping.id}/unjam`, { includeFailed: true }, { headers: authHeaders }),
                    'Parked failures re-armed.',
                  )
                }
              >
                <RotateCcw className={cn('mr-2 h-4 w-4', busy === 'retry' && 'animate-spin')} />
                Retry {queue.failed} failed
              </Button>
            ) : null}

            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act(
                  'toggle',
                  () => axios.put(`/api/mappings/${mapping.id}`, { enabled: !mapping.enabled }, { headers: authHeaders }),
                  mapping.enabled ? 'Account paused.' : 'Account resumed.',
                )
              }
            >
              {mapping.enabled ? <Pause className="mr-2 h-4 w-4" /> : <Play className="mr-2 h-4 w-4" />}
              {mapping.enabled ? 'Pause mirroring' : 'Resume mirroring'}
            </Button>

            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act(
                  'profile',
                  () =>
                    axios.post(
                      `/api/mappings/${mapping.id}/sync-profile-from-twitter`,
                      {},
                      { headers: authHeaders },
                    ),
                  'Profile synced from Twitter.',
                )
              }
            >
              <UserRoundCog className={cn('mr-2 h-4 w-4', busy === 'profile' && 'animate-spin')} />
              Sync profile
            </Button>

            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                act(
                  'pin',
                  () => axios.post(`/api/pin-sync/${mapping.id}`, {}, { headers: authHeaders }),
                  'Pinned tweet sync queued.',
                )
              }
            >
              Sync pinned tweet
            </Button>
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          You can view this account but not change it. Ask an admin, or the account's owner, for access.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-background p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Clock className="h-4 w-4" />
            Sources
          </h3>
          <div className="mt-3 space-y-2">
            {sources.map((source) => (
              <div key={source.twitterUsername} className="rounded-md border border-border/70 bg-muted/30 p-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <a
                    className="font-medium hover:underline"
                    href={`https://x.com/${source.twitterUsername}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    @{source.twitterUsername}
                  </a>
                  <Badge variant="secondary">{TIER_LABEL[source.tier] ?? source.tier}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Checked {formatAgo(source.lastCheckedAt)} · last new tweet {formatAgo(source.lastFoundAt)}
                  {source.dueInMs > 0 ? ` · due in ${formatDuration(source.dueInMs)}` : ' · due now'}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-background p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Gauge className="h-4 w-4" />
            Queue
          </h3>
          <div className="mt-3 grid grid-cols-4 gap-2 text-center text-sm">
            <div>
              <p className="text-muted-foreground text-xs">Ready</p>
              <p className="font-semibold">{queue.ready}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Retrying</p>
              <p className="font-semibold">{queue.backoff}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Posting</p>
              <p className={cn('font-semibold', stuck && 'text-amber-600 dark:text-amber-400')}>{queue.processing}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">Parked</p>
              <p className={cn('font-semibold', queue.failed > 0 && 'text-red-600 dark:text-red-400')}>{queue.failed}</p>
            </div>
          </div>
          {queue.items.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Queue is empty.</p>
          ) : (
            <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
              {queue.items.map((item) => (
                <div key={item.twitter_id} className="rounded-md border border-border/70 p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{item.status}</span>
                    <span className="text-muted-foreground">
                      {item.attempts} attempt{item.attempts === 1 ? '' : 's'} · queued {formatAgo(item.enqueued_at)}
                    </span>
                  </div>
                  {item.tweet_text ? <p className="mt-1 truncate text-muted-foreground">{item.tweet_text}</p> : null}
                  {item.last_error ? (
                    <p className="mt-1 text-red-600 dark:text-red-400">
                      {item.failure_stage ? `${item.failure_stage}: ` : ''}
                      {item.last_error}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {canManage && mapping.twitterUsernames[0] ? (
        <div className="rounded-lg border border-border bg-background p-4">
          <MirrorPreview
            twitterUsername={mapping.profileSyncSourceUsername || mapping.twitterUsernames[0]}
            mappingId={mapping.id}
            authHeaders={authHeaders}
          />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-background p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2 className="h-4 w-4" />
            Recent posts
          </h3>
          {recentPosts.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Nothing mirrored yet.</p>
          ) : (
            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
              {recentPosts.map((post) => {
                const lagMs =
                  post.posted_at && post.tweet_created_at ? post.posted_at - post.tweet_created_at : null;
                return (
                  <div key={post.twitter_id} className="rounded-md border border-border/70 p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">{post.status}</span>
                      <span className="text-muted-foreground">
                        {formatAgo(post.posted_at ?? null)}
                        {lagMs !== null && lagMs >= 0 ? ` · ${formatDuration(lagMs)} delay` : ''}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-foreground/90">{post.tweet_text || '(no text)'}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border bg-background p-4">
          <h3 className="text-sm font-medium">Recent activity</h3>
          {recentLogs.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No log entries for this account yet.</p>
          ) : (
            <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
              {recentLogs.map((entry) => (
                <div key={entry.id} className="text-xs">
                  <span className={cn('font-mono', LEVEL_TONE[entry.level] ?? '')}>{entry.level}</span>{' '}
                  <span className="text-muted-foreground">{formatAgo(entry.timestamp)}</span>
                  <p className={cn(LEVEL_TONE[entry.level] ?? 'text-foreground/90')}>{entry.message}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
