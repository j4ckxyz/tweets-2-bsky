import { History, LayoutDashboard, Newspaper, Settings2, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { TAB_PATHS } from '../lib/constants';
import { getAccountIdFromPath, getTabFromPath, normalizePath } from '../lib/format';
import type { DashboardTab } from '../lib/types';

function readSavedTab(): DashboardTab {
  const saved = localStorage.getItem('dashboard-tab');
  if (
    saved === 'overview' ||
    saved === 'accounts' ||
    saved === 'posts' ||
    saved === 'activity' ||
    saved === 'settings'
  ) {
    return saved;
  }
  return 'overview';
}

// Active tab and account detail id, derived from the URL. React Router owns the
// history; the path helpers in lib/format decide what a path means, so URLs
// resolve exactly as they always have (case-sensitive, trailing slash allowed).
export function useRouting() {
  const location = useLocation();
  const navigate = useNavigate();

  // The account detail page is a sub-route of the accounts tab rather than a
  // tab of its own, so it keeps the tab highlighted and the back button works.
  const accountDetailId = getAccountIdFromPath(location.pathname);
  const tabFromPath = accountDetailId ? 'accounts' : getTabFromPath(location.pathname);

  // A path that is not a dashboard route opens the last-used tab on first load,
  // and Overview when reached later through back/forward.
  const fallbackTabRef = useRef<DashboardTab>(readSavedTab());
  const activeTab: DashboardTab = tabFromPath ?? fallbackTabRef.current;

  useEffect(() => {
    localStorage.setItem('dashboard-tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (tabFromPath === null) {
      navigate(TAB_PATHS[activeTab]);
    }
    fallbackTabRef.current = 'overview';
  }, [activeTab, navigate, tabFromPath]);

  // Push a history entry only when the path actually changes, like the old
  // pushState sync did; re-selecting the current tab adds nothing to history.
  const goTo = useCallback(
    (path: string) => {
      if (normalizePath(window.location.pathname) !== path) {
        navigate(path);
      }
    },
    [navigate],
  );
  const openTab = useCallback((tab: DashboardTab) => goTo(TAB_PATHS[tab]), [goTo]);
  const openAccount = useCallback((mappingId: string) => goTo(`/accounts/${mappingId}`), [goTo]);
  const closeAccount = useCallback(() => goTo(TAB_PATHS.accounts), [goTo]);

  const dashboardTabs = useMemo(
    () => [
      {
        id: 'overview' as DashboardTab,
        label: 'Overview',
        icon: LayoutDashboard,
        description: 'How every mirror is keeping up, and what is running now.',
      },
      {
        id: 'accounts' as DashboardTab,
        label: 'Accounts',
        icon: Users,
        description: 'Every X account mapped to a Bluesky mirror, by folder.',
      },
      {
        id: 'posts' as DashboardTab,
        label: 'Posts',
        icon: Newspaper,
        description: 'Search and browse crossposted content.',
      },
      { id: 'activity' as DashboardTab, label: 'Activity', icon: History, description: 'Recent migration log.' },
      {
        id: 'settings' as DashboardTab,
        label: 'Settings',
        icon: Settings2,
        description: 'Account, credentials, users, and data management.',
      },
    ],
    [],
  );

  const activeTabMeta = dashboardTabs.find((tab) => tab.id === activeTab);

  return { activeTab, accountDetailId, openTab, openAccount, closeAccount, dashboardTabs, activeTabMeta };
}
