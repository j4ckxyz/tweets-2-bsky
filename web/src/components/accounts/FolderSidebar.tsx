import { ChevronDown, Folder, Plus, Save, Trash2 } from 'lucide-react';
import { DEFAULT_GROUP_NAME } from '../../lib/constants';
import { useDashboard } from '../../lib/dashboard-context';
import { getMappingGroupMeta } from '../../lib/format';
import { cn } from '../../lib/utils';
import { DiscoveryPanel } from '../DiscoveryPanel';
import { FolderGlyph } from '../FolderGlyph';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

// Folder list and the folder manager.
export function FolderSidebar() {
  const {
    accountMappingsForView,
    authHeaders,
    canManageGroupsPermission,
    groupDraftsByKey,
    groupedMappings,
    handleCreateGroup,
    handleDeleteGroup,
    handleRenameGroup,
    isAdmin,
    isBusy,
    isGroupActionBusy,
    mappings,
    newGroupEmoji,
    newGroupName,
    reusableGroupOptions,
    selectedFolderKey,
    setNewGroupEmoji,
    setNewGroupName,
    setSelectedFolderKey,
    showNotice,
    updateGroupDraft,
  } = useDashboard();
  return (
    <div className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:self-start">
      <nav aria-label="Folders">
        <p className="mb-1.5 hidden px-2.5 text-xs font-medium text-muted-foreground lg:block">Folders</p>
        <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:block lg:space-y-0.5 lg:overflow-visible lg:px-0 lg:pb-0">
          <button
            type="button"
            onClick={() => setSelectedFolderKey('__all__')}
            aria-current={selectedFolderKey === '__all__' ? 'true' : undefined}
            className={cn(
              'flex shrink-0 items-center whitespace-nowrap lg:w-full gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
              selectedFolderKey === '__all__'
                ? 'bg-card font-medium text-foreground ring-1 ring-border'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            <Folder className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">All accounts</span>
            <span className="text-xs tabular-nums text-muted-foreground">{accountMappingsForView.length}</span>
          </button>
          {groupedMappings.map((group) => (
            <button
              key={group.key}
              type="button"
              onClick={() => setSelectedFolderKey(group.key)}
              aria-current={selectedFolderKey === group.key ? 'true' : undefined}
              className={cn(
                'flex shrink-0 items-center whitespace-nowrap lg:w-full gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors duration-150',
                selectedFolderKey === group.key
                  ? 'bg-card font-medium text-foreground ring-1 ring-border'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              <FolderGlyph emoji={group.emoji} className="w-4 shrink-0 text-center" />
              <span className="min-w-0 flex-1 truncate">{group.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{group.mappings.length}</span>
            </button>
          ))}
        </div>
      </nav>

      {canManageGroupsPermission ? (
        <Card>
          <details>
            <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              Manage folders
              <ChevronDown className="h-3.5 w-3.5" />
            </summary>
            <div className="space-y-3 border-t border-border/70 p-3">
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  void handleCreateGroup(event);
                }}
              >
                <p className="text-xs font-medium text-muted-foreground">New folder</p>
                <div className="flex items-end gap-2">
                  <div className="w-16 space-y-1">
                    <Label htmlFor="accounts-group-emoji">Emoji</Label>
                    <Input
                      id="accounts-group-emoji"
                      value={newGroupEmoji}
                      onChange={(event) => setNewGroupEmoji(event.target.value)}
                      placeholder="📁"
                      maxLength={8}
                    />
                  </div>
                  <div className="flex-1 space-y-1">
                    <Label htmlFor="accounts-group-name">Name</Label>
                    <Input
                      id="accounts-group-name"
                      value={newGroupName}
                      onChange={(event) => setNewGroupName(event.target.value)}
                      placeholder="Gaming, News..."
                    />
                  </div>
                  <Button
                    type="submit"
                    size="icon"
                    variant="outline"
                    disabled={isBusy || newGroupName.trim().length === 0}
                    aria-label="Create folder"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </form>

              {reusableGroupOptions.length > 0 ? (
                <div className="space-y-2 border-t border-border/70 pt-3">
                  {reusableGroupOptions.map((group) => {
                    const draft = groupDraftsByKey[group.key] || { name: group.name, emoji: group.emoji };
                    return (
                      <div key={`group-manager-${group.key}`} className="flex items-end gap-1.5">
                        <div className="w-14">
                          <Input
                            aria-label="Folder emoji"
                            value={draft.emoji}
                            onChange={(event) => updateGroupDraft(group.key, 'emoji', event.target.value)}
                            maxLength={8}
                            className="px-2"
                          />
                        </div>
                        <Input
                          aria-label="Folder name"
                          className="min-w-0 flex-1"
                          value={draft.name}
                          onChange={(event) => updateGroupDraft(group.key, 'name', event.target.value)}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={isGroupActionBusy || !draft.name.trim()}
                          title="Save folder"
                          onClick={() => {
                            void handleRenameGroup(group.key);
                          }}
                        >
                          <Save className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-red-600 hover:text-red-500 dark:text-red-300 dark:hover:text-red-200"
                          disabled={isGroupActionBusy}
                          title="Delete folder"
                          onClick={() => {
                            void handleDeleteGroup(group.key);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground">
                    Deleting a folder moves its mappings to {DEFAULT_GROUP_NAME}.
                  </p>
                </div>
              ) : null}
              {authHeaders ? (
                <DiscoveryPanel
                  authHeaders={authHeaders}
                  isAdmin={isAdmin}
                  folders={reusableGroupOptions.map((group) => ({
                    ...group,
                    members: mappings.filter(
                      (mapping) => mapping.enabled && getMappingGroupMeta(mapping).key === group.key,
                    ).length,
                  }))}
                  accounts={mappings.map((mapping) => ({
                    id: mapping.id,
                    bskyIdentifier: mapping.bskyIdentifier,
                  }))}
                  notify={showNotice}
                />
              ) : null}
            </div>
          </details>
        </Card>
      ) : null}
    </div>
  );
}
