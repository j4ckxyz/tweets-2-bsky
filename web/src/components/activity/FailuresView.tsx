import { History, Loader2, RefreshCw } from 'lucide-react';
import { useDashboard } from '../../lib/dashboard-context';
import { formatRelativeTime } from '../../lib/format';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';

// Failed post queue.
export function FailuresView() {
  const {
    activityView,
    clearFailedQueue,
    fetchQueueFailures,
    isAdmin,
    queueFailures,
    queueFailuresLoading,
    retryFailedQueue,
  } = useDashboard();
  return activityView === 'failures' ? (
    <Card className="">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4" />
              Failed queue items
            </CardTitle>
            <CardDescription>
              Tweets the post queue gave up on, grouped by reason. Anything already live on Bluesky is repaired
              automatically rather than re-posted.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void fetchQueueFailures()}
              disabled={queueFailuresLoading}
            >
              {queueFailuresLoading ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
            {isAdmin && queueFailures.items.length > 0 ? (
              <>
                <Button size="sm" variant="outline" onClick={retryFailedQueue}>
                  Retry all
                </Button>
                <Button size="sm" variant="outline" onClick={clearFailedQueue}>
                  Clear all
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {queueFailures.summary.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Grouped by reason</p>
            <ul className="space-y-2">
              {queueFailures.summary.map((group, index) => (
                <li key={`failure-group-${group.stage}-${index}`} className="rounded-md border border-border px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold">
                      {group.count} tweet{group.count === 1 ? '' : 's'}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline">{group.stage}</Badge>
                      last seen {formatRelativeTime(group.lastSeenAt)}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-sm text-muted-foreground">{group.reason}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    e.g. @{group.sampleTwitterUsername} tweet {group.sampleTwitterId} → {group.sampleBskyIdentifier}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full text-left text-xs">
            <thead className="border-b border-border bg-muted/40 font-medium text-muted-foreground">
              <tr>
                <th className="px-2 py-2">Failed</th>
                <th className="px-2 py-2">Account</th>
                <th className="px-2 py-2">Tweet</th>
                <th className="px-2 py-2">Attempts</th>
                <th className="px-2 py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {queueFailures.items.map((item) => (
                <tr
                  key={`failed-${item.twitter_id}-${item.bsky_identifier}`}
                  className="border-b border-border/60 align-top last:border-0"
                >
                  <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">
                    {formatRelativeTime(item.updated_at)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 font-mono">
                    @{item.twitter_username}
                    <span className="block text-[11px] text-muted-foreground">→ {item.bsky_identifier}</span>
                  </td>
                  <td className="px-2 py-2">
                    <a
                      className="font-mono text-[11px] underline-offset-4 hover:underline"
                      href={`https://x.com/${item.twitter_username}/status/${item.twitter_id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.twitter_id}
                    </a>
                    {item.tweet_text ? (
                      <span className="mt-0.5 block max-w-[280px] truncate text-muted-foreground">
                        {item.tweet_text}
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">
                    {item.attempts}
                    {item.failure_stage ? (
                      <span className="block text-[11px] text-muted-foreground">at {item.failure_stage}</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <span className="break-words">{item.last_error || 'No reason recorded.'}</span>
                    {item.posted_uri ? (
                      <span className="mt-1 block text-[11px] text-amber-600 dark:text-amber-400">
                        This tweet is already live on Bluesky; it will be reconciled, not re-posted.
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
              {queueFailures.items.length === 0 ? (
                <tr>
                  <td className="px-2 py-6 text-center text-sm text-muted-foreground" colSpan={5}>
                    {queueFailuresLoading ? 'Loading…' : 'Nothing in the queue has failed.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  ) : null;
}
