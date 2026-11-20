import { useDashboard } from '../../lib/dashboard-context';
import { cn } from '../../lib/utils';

// Sticky top bar with the five-tab grid on small screens.
export function MobileNav() {
  const { activeTab, dashboardTabs, setAccountDetailId, setActiveTab } = useDashboard();
  return (
    <div className="sticky top-0 z-30 border-b border-border bg-rail/95 px-3 pb-2 pt-3 backdrop-blur lg:hidden">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span
          className="airmail-mark h-4 w-4 shrink-0 rounded ring-1 ring-inset ring-foreground/10"
          aria-hidden="true"
        />
        <p className="text-sm font-semibold">tweets-2-bsky</p>
      </div>
      <div>
        <div className="grid grid-cols-5 gap-1">
          {dashboardTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                className={cn(
                  'flex h-12 touch-manipulation flex-col items-center justify-center gap-0.5 rounded-md text-[11px] sm:h-9 sm:flex-row sm:gap-1.5 sm:text-sm',
                  isActive
                    ? 'bg-card font-medium text-foreground ring-1 ring-border'
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                )}
                onClick={() => {
                  setAccountDetailId(null);
                  setActiveTab(tab.id);
                }}
                type="button"
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon className={cn('h-4 w-4', isActive && 'text-primary')} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
