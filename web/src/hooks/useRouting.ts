import { History, LayoutDashboard, Newspaper, Settings2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { TAB_PATHS } from '../lib/constants';
import { getAccountIdFromPath, getTabFromPath, normalizePath } from '../lib/format';
import type { DashboardTab } from '../lib/types';

// Active tab and account detail id, kept in sync with the URL and history.
export function useRouting() {
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => {
    // The account detail route lives under the accounts tab but is not one of
    // TAB_PATHS, so it has to select the tab itself — otherwise a refresh or a
    // pasted /accounts/<id> link lands on whatever tab was last saved and the
    // detail page never renders.
    if (getAccountIdFromPath(window.location.pathname)) {
      return 'accounts';
    }

    const fromPath = getTabFromPath(window.location.pathname);
    if (fromPath) {
      return fromPath;
    }

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
  });

  // The account detail page is a sub-route of the accounts tab rather than a
  // tab of its own, so it keeps the tab highlighted and the back button works.
  const [accountDetailId, setAccountDetailId] = useState<string | null>(() =>
    getAccountIdFromPath(window.location.pathname),
  );

  useEffect(() => {
    localStorage.setItem('dashboard-tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    const expectedPath = accountDetailId ? `/accounts/${accountDetailId}` : TAB_PATHS[activeTab];
    const currentPath = normalizePath(window.location.pathname);
    if (currentPath !== expectedPath) {
      window.history.pushState({ tab: activeTab, accountDetailId }, '', expectedPath);
    }
  }, [activeTab, accountDetailId]);

  useEffect(() => {
    const onPopState = () => {
      const accountId = getAccountIdFromPath(window.location.pathname);
      setAccountDetailId(accountId);
      if (accountId) {
        setActiveTab('accounts');
        return;
      }
      const tabFromPath = getTabFromPath(window.location.pathname);
      setActiveTab(tabFromPath ?? 'overview');
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);
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

  return { activeTab, setActiveTab, accountDetailId, setAccountDetailId, dashboardTabs, activeTabMeta };
}
