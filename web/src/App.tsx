import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { AccountAlertsBanner } from './components/AccountAlertsBanner';
import { AddAccountSheet } from './components/AddAccountSheet';
import { EditMappingDialog } from './components/EditMappingDialog';
import { JobsStrip } from './components/JobsStrip';
import { NoticeBanner } from './components/NoticeBanner';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { StatusStrip } from './components/StatusStrip';
import { MobileNav } from './components/layout/MobileNav';
import { PageHeader } from './components/layout/PageHeader';
import { Sidebar } from './components/layout/Sidebar';
import { DashboardProvider, useDashboard } from './lib/dashboard-context';
import type { DashboardTab } from './lib/types';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { AccountsPage } from './pages/AccountsPage';
import { ActivityPage } from './pages/ActivityPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { PostsPage } from './pages/PostsPage';
import { SettingsPage } from './pages/SettingsPage';

const pageForTab: Record<DashboardTab, ReactNode> = {
  overview: <OverviewPage />,
  accounts: <AccountsPage />,
  posts: <PostsPage />,
  activity: <ActivityPage />,
  settings: <SettingsPage />,
};

function AppShell() {
  const { accountDetailId, activeTab, token } = useDashboard();
  const location = useLocation();

  useEffect(() => {
    console.log(
      '%cTweets-2-Bsky %cReady to syndicate! 🚀\n%cView source & contribute: https://github.com/j4ckxyz/tweets-2-bsky',
      'color: #0284c7; font-weight: bold; font-size: 14px;',
      'color: #64748b; font-size: 12px; font-weight: 500;',
      'color: #94a3b8; font-size: 10px;',
    );
  }, []);

  if (!token) {
    return <LoginPage />;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />

        <main className="flex-1">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
            <PageHeader />

            <NoticeBanner />

            <StatusStrip />

            <AccountAlertsBanner />

            <JobsStrip />

            <RouteErrorBoundary resetKey={location.pathname}>
              <Routes>
                <Route caseSensitive path="/" element={<OverviewPage />} />
                <Route caseSensitive path="/accounts" element={<AccountsPage />} />
                <Route
                  caseSensitive
                  path="/accounts/:accountId"
                  element={accountDetailId ? <AccountDetailPage /> : pageForTab[activeTab]}
                />
                <Route caseSensitive path="/posts" element={<PostsPage />} />
                <Route caseSensitive path="/activity" element={<ActivityPage />} />
                <Route caseSensitive path="/settings" element={<SettingsPage />} />
                {/* Not a dashboard path: show the fallback tab while useRouting redirects to it. */}
                <Route path="*" element={pageForTab[activeTab]} />
              </Routes>
            </RouteErrorBoundary>

            <AddAccountSheet />

            <EditMappingDialog />
          </div>
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <DashboardProvider>
      <AppShell />
    </DashboardProvider>
  );
}

export default App;
