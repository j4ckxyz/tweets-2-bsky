import { Bot, ChevronDown, ChevronLeft, ChevronRight, Download, Link2, Loader2, Pin, RefreshCw } from 'lucide-react';
import { ACCOUNT_PAGE_SIZE_DEFAULT, selectClassName } from '../../lib/constants';
import { useDashboard } from '../../lib/dashboard-context';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { DebouncedInput } from '../ui/debounced-input';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel } from '../ui/dropdown-menu';

// Search, view options, bulk actions and paging.
export function AccountsToolbar() {
  const {
    accountMatchesCount,
    accountsCreatorFilter,
    accountsPage,
    accountsPageCount,
    accountsPageSize,
    accountsSearchQuery,
    botLabeledMappingsForView,
    bridgeAllProgress,
    clearSelectedAccountMappings,
    currentAccountsPageEnd,
    currentAccountsPageStart,
    handleApplyAllAccountsAction,
    isAdmin,
    isAnyBulkAccountsActionBusy,
    isBridgeAllBusy,
    managedUsers,
    selectedManageableMappingsCount,
    setAccountsCreatorFilter,
    setAccountsPage,
    setAccountsPageSize,
    setAccountsSearchQuery,
    setShowAccountAvatars,
    setShowAccountBios,
    showAccountAvatars,
    showAccountBios,
  } = useDashboard();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <DebouncedInput
          className="h-8 min-w-0 flex-1 text-[13px] sm:max-w-xs"
          value={accountsSearchQuery}
          onChange={setAccountsSearchQuery}
          placeholder="Search @username, owner, handle..."
        />
        {isAdmin && managedUsers.length > 1 ? (
          <select
            className={cn(selectClassName, 'h-8 w-40 text-[13px]')}
            value={accountsCreatorFilter}
            onChange={(event) => setAccountsCreatorFilter(event.target.value)}
            aria-label="Created by user"
          >
            <option value="all">All users</option>
            {managedUsers.map((user) => (
              <option key={`creator-filter-${user.id}`} value={user.id}>
                {user.username || user.email || user.id}
              </option>
            ))}
          </select>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DropdownMenu
            align="end"
            trigger={
              <>
                View
                <ChevronDown className="h-3.5 w-3.5" />
              </>
            }
          >
            <DropdownMenuItem data-keep-open="true" onClick={() => setShowAccountAvatars((previous) => !previous)}>
              {showAccountAvatars ? 'Hide avatars' : 'Show avatars'}
            </DropdownMenuItem>
            <DropdownMenuItem data-keep-open="true" onClick={() => setShowAccountBios((previous) => !previous)}>
              {showAccountBios ? 'Hide bios' : 'Show bios'}
            </DropdownMenuItem>
          </DropdownMenu>
          <DropdownMenu
            align="end"
            disabled={isAnyBulkAccountsActionBusy}
            trigger={
              isAnyBulkAccountsActionBusy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Working...
                </>
              ) : (
                <>
                  Bulk actions
                  <ChevronDown className="h-3.5 w-3.5" />
                </>
              )
            }
          >
            <DropdownMenuLabel>
              {selectedManageableMappingsCount > 0
                ? `Apply to ${selectedManageableMappingsCount} selected`
                : 'Apply to all manageable'}
            </DropdownMenuLabel>
            <DropdownMenuItem
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={() => void handleApplyAllAccountsAction('sync_profiles')}
            >
              Sync profiles from Twitter
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Download className="h-4 w-4" />}
              onClick={() => void handleApplyAllAccountsAction('pull_twitter_bio')}
            >
              Pull Twitter bio
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Link2 className="h-4 w-4" />}
              onClick={() => void handleApplyAllAccountsAction('bridge_all')}
            >
              Bridge to fediverse
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Pin className="h-4 w-4" />}
              onClick={() => void handleApplyAllAccountsAction('sync_pins')}
            >
              Sync pinned tweets
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Bot className="h-4 w-4" />}
              onClick={() => void handleApplyAllAccountsAction('apply_bot_label')}
            >
              Apply bot label
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Bot className="h-4 w-4" />}
              onClick={() => void handleApplyAllAccountsAction('append_bot_name')}
            >
              Append {'{bot}'} to display name
            </DropdownMenuItem>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Showing {currentAccountsPageStart}-{currentAccountsPageEnd} of {accountMatchesCount} account
            {accountMatchesCount === 1 ? '' : 's'}
          </span>
          {botLabeledMappingsForView.length > 0 ? <span>{botLabeledMappingsForView.length} bot-labeled</span> : null}
          {selectedManageableMappingsCount > 0 ? (
            <button
              type="button"
              className="text-foreground underline-offset-2 hover:underline"
              onClick={clearSelectedAccountMappings}
              title="Clear selection"
            >
              {selectedManageableMappingsCount} selected ×
            </button>
          ) : null}
          {isBridgeAllBusy && bridgeAllProgress ? (
            <Badge variant="outline" className="max-w-[240px] truncate">
              {bridgeAllProgress.currentHandle
                ? `Bridging ${bridgeAllProgress.currentHandle}`
                : 'Preparing bridge-all...'}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <select
            className={cn(selectClassName, 'h-8 w-20 px-2 py-1 text-xs')}
            value={accountsPageSize}
            onChange={(event) => setAccountsPageSize(Number(event.target.value) || ACCOUNT_PAGE_SIZE_DEFAULT)}
            aria-label="Accounts per page"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
          <Button
            className="h-8 w-8"
            size="icon"
            variant="outline"
            disabled={accountsPage <= 1}
            onClick={() => setAccountsPage((previous) => Math.max(1, previous - 1))}
            aria-label="Previous page of accounts"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="w-16 text-center">
            {accountsPage}/{accountsPageCount}
          </span>
          <Button
            className="h-8 w-8"
            size="icon"
            variant="outline"
            disabled={accountsPage >= accountsPageCount}
            onClick={() => setAccountsPage((previous) => Math.min(accountsPageCount, previous + 1))}
            aria-label="Next page of accounts"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
