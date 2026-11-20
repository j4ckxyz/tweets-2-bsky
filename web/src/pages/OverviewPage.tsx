import { AccountHealth } from '../components/AccountHealth';
import { Countdown } from '../components/Countdown';
import { useDashboard } from '../lib/dashboard-context';
import { formatCompactNumber } from '../lib/facets';
import { formatRelativeTime, formatState } from '../lib/format';

export function OverviewPage() {
  const {
    authHeaders,
    currentStatus,
    handleLogout,
    latestActivity,
    mappings,
    openAccount,
    pendingBackfills,
    queuedPostCount,
    setRouteSummary,
    topAccount,
    topAccountProfile,
  } = useDashboard();
  return (
    <section className="space-y-8 animate-fade-in">
      <section aria-labelledby="routes-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="routes-heading" className="text-base font-semibold">
            Routes
          </h2>
          <p className="text-xs text-muted-foreground">
            Time from a tweet appearing on X to its post on Bluesky. Click a route for detail.
          </p>
        </div>
        <AccountHealth
          authHeaders={authHeaders}
          onAuthFailure={handleLogout}
          onOpenAccount={(mappingId) => {
            openAccount(mappingId);
          }}
          onSummary={setRouteSummary}
        />
      </section>

      <section aria-labelledby="instance-heading" className="border-t border-border pt-6">
        <h2 id="instance-heading" className="mb-3 text-base font-semibold">
          Instance
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <dt className="text-xs text-muted-foreground">Mirrors</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">
              {mappings.length}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {mappings.filter((mapping) => mapping.hasBotLabel === true).length} bot-labelled
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Next run</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">
              <Countdown />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">State</dt>
            <dd className="mt-0.5 font-semibold">{formatState(currentStatus?.state || 'idle')}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Queued posts</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">
              {queuedPostCount}
              {pendingBackfills.length > 0 ? (
                <span className="ml-1.5 font-normal text-muted-foreground">
                  +{pendingBackfills.length} backfill{pendingBackfills.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Last activity</dt>
            <dd className="mt-0.5 font-semibold">
              {latestActivity?.created_at
                ? formatRelativeTime(new Date(latestActivity.created_at).getTime())
                : 'None yet'}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Most engagement</dt>
            <dd className="mt-0.5 flex min-w-0 items-center gap-2">
              {topAccount ? (
                <>
                  {topAccountProfile?.avatar ? (
                    <img
                      className="h-5 w-5 shrink-0 rounded-full object-cover"
                      src={topAccountProfile.avatar}
                      alt=""
                      loading="lazy"
                    />
                  ) : null}
                  <span className="truncate font-semibold">@{topAccountProfile?.handle || topAccount.identifier}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatCompactNumber(topAccount.score)}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">No data yet</span>
              )}
            </dd>
          </div>
        </dl>
      </section>
    </section>
  );
}
