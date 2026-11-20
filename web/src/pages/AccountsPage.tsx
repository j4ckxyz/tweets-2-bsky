import { Plus } from 'lucide-react';
import { AccountsMobileList } from '../components/accounts/AccountsMobileList';
import { AccountsTable } from '../components/accounts/AccountsTable';
import { AccountsToolbar } from '../components/accounts/AccountsToolbar';
import { BridgeSummary } from '../components/accounts/BridgeSummary';
import { FolderSidebar } from '../components/accounts/FolderSidebar';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { useDashboard } from '../lib/dashboard-context';

export function AccountsPage() {
  const { accountMatchesCount, canCreateMappings, normalizedAccountsQuery, openAddAccountSheet } = useDashboard();
  return (
    <section className="grid gap-6 lg:grid-cols-[200px_1fr] animate-fade-in">
      <FolderSidebar />

      <div className="min-w-0 space-y-4">
        <AccountsToolbar />

        <BridgeSummary />

        {accountMatchesCount === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              {normalizedAccountsQuery ? 'No accounts matched this search.' : 'No mappings in this folder yet.'}
              {canCreateMappings ? (
                <div className="mt-3">
                  <Button size="sm" variant="outline" onClick={openAddAccountSheet}>
                    <Plus className="mr-2 h-4 w-4" />
                    Create your first account
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Desktop Table View */}
            <AccountsTable />

            {/* Mobile Card List View */}
            <AccountsMobileList />
          </>
        )}
      </div>
    </section>
  );
}
