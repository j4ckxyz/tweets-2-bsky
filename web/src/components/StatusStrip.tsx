import { useDashboard } from '../lib/dashboard-context';

// One-line problem summary shown on every tab except Overview.
export function StatusStrip() {
  const { accountAlerts, activeJobs, activeTab, postQueue, setAccountDetailId, setActiveTab } = useDashboard();
  return activeTab !== 'overview' &&
    (accountAlerts.length > 0 || activeJobs.length > 0 || (postQueue?.failed ?? 0) > 0) ? (
    <button
      type="button"
      onClick={() => {
        setAccountDetailId(null);
        setActiveTab('overview');
      }}
      className="mb-6 flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-card px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/25"
    >
      {accountAlerts.length > 0 ? (
        <span className="font-medium text-late">
          {accountAlerts.length} account{accountAlerts.length === 1 ? '' : 's'} unavailable
        </span>
      ) : null}
      {(postQueue?.failed ?? 0) > 0 ? <span className="text-late">{postQueue?.failed} failed to post</span> : null}
      {activeJobs.length > 0 ? (
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          {activeJobs.length} job{activeJobs.length === 1 ? '' : 's'} running
        </span>
      ) : null}
      <span className="ml-auto">View on Overview</span>
    </button>
  ) : null;
}
