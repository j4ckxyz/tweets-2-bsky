import { Clock3, LogOut } from 'lucide-react';
import { useDashboard } from '../../lib/dashboard-context';
import { Countdown } from '../Countdown';
import { LogoMark } from '../Logo';
import { ThemeSwitcher } from '../ThemeSwitcher';
import { NavList } from '../ui/nav-list';

// Desktop navigation rail.
export function Sidebar() {
  const { activeTab, dashboardTabs, handleLogout, openTab, runtimeBranchLabel, runtimeVersionLabel } = useDashboard();
  return (
    <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-border bg-rail lg:flex">
      <div className="flex items-center gap-2.5 px-4 pb-5 pt-5">
        <LogoMark className="h-[15px] w-8 text-foreground" />
        <p className="truncate text-[15px] font-semibold tracking-[-0.01em]">tweets-2-bsky</p>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5">
        <NavList
          items={dashboardTabs}
          activeId={activeTab}
          onSelect={(id) => {
            openTab(id);
          }}
          ariaLabel="Dashboard sections"
        />
      </div>

      <div className="space-y-3 border-t border-border px-4 py-4">
        <dl className="space-y-1 text-xs text-muted-foreground">
          <div className="flex items-center justify-between gap-2">
            <dt className="flex items-center gap-1.5">
              <Clock3 className="h-3.5 w-3.5 shrink-0" />
              Next run
            </dt>
            <dd className="tabular-nums text-foreground">
              <Countdown />
            </dd>
          </div>
          <div
            className="flex items-center justify-between gap-2"
            title={`${runtimeVersionLabel}${runtimeBranchLabel ? ` ${runtimeBranchLabel}` : ''}`}
          >
            <dt>Version</dt>
            <dd className="truncate tabular-nums text-foreground">{runtimeVersionLabel}</dd>
          </div>
        </dl>
        <ThemeSwitcher />
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={handleLogout}
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </button>
      </div>
    </aside>
  );
}
