import { Play, Plus, Trash2 } from 'lucide-react';
import { useDashboard } from '../../lib/dashboard-context';
import { formatTransit } from '../AccountHealth';
import { Button } from '../ui/button';

// Page title, summary line and the global actions.
export function PageHeader() {
  const {
    activeTab,
    activeTabMeta,
    canCreateMappings,
    canRunNowPermission,
    clearAllBackfills,
    isAdmin,
    openAddAccountSheet,
    pendingBackfills,
    routeSummary,
    runNow,
  } = useDashboard();
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.015em] sm:text-[22px]">
          {activeTabMeta?.label ?? 'Dashboard'}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {activeTab === 'overview' && routeSummary ? (
            <>
              {routeSummary.routes} routes ·{' '}
              <span className={routeSummary.attention > 0 ? 'font-medium text-late' : undefined}>
                {routeSummary.attention} need attention
              </span>
              {routeSummary.typicalLagMs !== null
                ? ` · typical transit ${formatTransit(routeSummary.typicalLagMs)}`
                : ''}
            </>
          ) : (
            activeTabMeta?.description
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canCreateMappings ? (
          <Button size="sm" variant="outline" onClick={openAddAccountSheet}>
            <Plus className="mr-2 h-4 w-4" />
            Add account
          </Button>
        ) : null}
        <Button size="sm" onClick={runNow} disabled={!canRunNowPermission}>
          <Play className="mr-2 h-4 w-4" />
          Run now
        </Button>
        {isAdmin && pendingBackfills.length > 0 ? (
          <Button size="sm" variant="outline" className="text-late" onClick={clearAllBackfills}>
            <Trash2 className="mr-2 h-4 w-4" />
            Clear queue
          </Button>
        ) : null}
      </div>
    </div>
  );
}
