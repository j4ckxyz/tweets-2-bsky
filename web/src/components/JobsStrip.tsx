import { ChevronDown } from 'lucide-react';
import { useDashboard } from '../lib/dashboard-context';
import { formatRelativeTime, formatState } from '../lib/format';
import { JOB_KIND_DOT, JOB_KIND_LABEL } from '../lib/types';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

// Running jobs and post-queue status, shown on Overview.
export function JobsStrip() {
  const {
    activeJobs,
    activeTab,
    clearFailedQueue,
    currentStatus,
    isAdmin,
    jobsExpanded,
    pendingBackfills,
    postQueue,
    progressPercent,
    queuedPostCount,
    retryFailedQueue,
    setActiveTab,
    setActivityView,
    setJobsExpanded,
  } = useDashboard();
  return activeTab === 'overview' &&
    (activeJobs.length > 0 ||
      queuedPostCount > 0 ||
      (postQueue?.failed ?? 0) > 0 ||
      (currentStatus && currentStatus.state !== 'idle')) ? (
    <div className="mb-8 rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-1.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium disabled:cursor-default"
          onClick={() => setJobsExpanded((previous) => !previous)}
          disabled={activeJobs.length === 0}
          aria-expanded={activeJobs.length > 0 ? jobsExpanded : undefined}
        >
          <span className="relative flex h-2 w-2" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40 motion-reduce:animate-none" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          {activeJobs.length > 0
            ? `${activeJobs.length} job${activeJobs.length === 1 ? '' : 's'} running`
            : queuedPostCount > 0
              ? `${queuedPostCount} tweet${queuedPostCount === 1 ? '' : 's'} queued to post`
              : (postQueue?.failed ?? 0) > 0
                ? `${postQueue?.failed} tweet${postQueue?.failed === 1 ? '' : 's'} failed to post`
                : `${formatState(currentStatus?.state || 'processing')} in progress`}
          {activeJobs.length > 0 ? (
            <span className="min-w-0 truncate font-normal text-muted-foreground">
              · {activeJobs.map((job) => (job.account ? `@${job.account}` : job.kind)).join(', ')}
            </span>
          ) : null}
          {activeJobs.length > 0 ? (
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
                jobsExpanded && 'rotate-180',
              )}
            />
          ) : null}
        </button>
        <div className="flex flex-wrap items-center gap-3">
          {activeJobs.length > 0 && queuedPostCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {postQueue?.processing ?? 0} posting · {postQueue?.ready ?? postQueue?.pending ?? 0} ready
              {/* A pending item serving retry backoff is not "waiting to post" — calling
                            both the same made the queue look permanently stuck. */}
              {(postQueue?.backoff ?? 0) > 0
                ? ` · ${postQueue?.backoff} waiting to retry${
                    postQueue?.nextRetryAt ? ` (next ${formatRelativeTime(postQueue.nextRetryAt)})` : ''
                  }`
                : ''}
            </p>
          ) : null}
          {pendingBackfills.length > 0 ? (
            <p className="text-xs text-muted-foreground">{pendingBackfills.length} backfill(s) queued</p>
          ) : null}
          {(postQueue?.failed ?? 0) > 0 ? (
            <button
              type="button"
              className="text-xs text-red-600 underline-offset-4 hover:underline dark:text-red-400"
              onClick={() => {
                setActiveTab('activity');
                setActivityView('failures');
              }}
            >
              {postQueue?.failed} failed — see why
            </button>
          ) : null}
          {isAdmin && (postQueue?.failed ?? 0) > 0 ? (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="ghost" className="h-7" onClick={retryFailedQueue}>
                Retry failed
              </Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={clearFailedQueue}>
                Clear failed
              </Button>
            </span>
          ) : null}
        </div>
      </div>
      {activeJobs.length > 0 ? (
        jobsExpanded ? (
          <ul className="divide-y divide-border border-t border-border">
            {activeJobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-1.5 text-[13px]">
                <span
                  className={cn(
                    'inline-block h-2 w-2 shrink-0 self-center rounded-full',
                    JOB_KIND_DOT[job.kind] || 'bg-muted-foreground',
                  )}
                />
                <span className="font-medium">{JOB_KIND_LABEL[job.kind] || job.kind}</span>
                {job.account ? <span className="text-foreground">@{job.account}</span> : null}
                {job.target ? <span className="text-xs text-muted-foreground">→ {job.target}</span> : null}
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{job.message}</span>
                {typeof job.totalCount === 'number' && job.totalCount > 0 ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {job.processedCount ?? 0}/{job.totalCount}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null
      ) : currentStatus ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2">
          <p className="text-sm text-muted-foreground">
            {currentStatus.currentAccount ? `@${currentStatus.currentAccount} • ` : ''}
            {currentStatus.message || 'Working through account queue.'}
          </p>
          {currentStatus.totalCount ? (
            <p className="font-mono text-xs text-muted-foreground">
              {(currentStatus.processedCount || 0).toLocaleString()} /{' '}
              {(currentStatus.totalCount || 0).toLocaleString()} ({progressPercent || 0}%)
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;
}
