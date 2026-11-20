import { FailuresView } from '../components/activity/FailuresView';
import { LogsView } from '../components/activity/LogsView';
import { OutcomesView } from '../components/activity/OutcomesView';
import { useDashboard } from '../lib/dashboard-context';
import { cn } from '../lib/utils';

export function ActivityPage() {
  const { activityView, postQueue, setActivityView } = useDashboard();
  return (
    <section className="space-y-6 animate-fade-in">
      <div
        className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md border border-border bg-rail p-0.5"
        role="tablist"
        aria-label="Activity views"
      >
        {[
          { id: 'outcomes' as const, label: 'Migration outcomes' },
          { id: 'logs' as const, label: 'System log' },
          {
            id: 'failures' as const,
            label: `Failed queue${(postQueue?.failed ?? 0) > 0 ? ` (${postQueue?.failed})` : ''}`,
          },
        ].map((view) => (
          <button
            key={`activity-view-${view.id}`}
            type="button"
            role="tab"
            aria-selected={activityView === view.id}
            onClick={() => setActivityView(view.id)}
            className={cn(
              'h-7 whitespace-nowrap rounded-[5px] px-3 text-[13px] transition-colors duration-150',
              activityView === view.id
                ? 'bg-card font-medium text-foreground shadow-[0_1px_2px_oklch(var(--foreground)/0.1)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {view.label}
          </button>
        ))}
      </div>

      <LogsView />

      <FailuresView />

      <OutcomesView />
    </section>
  );
}
