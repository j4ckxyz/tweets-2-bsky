import {
  ArrowUpRight,
  Download,
  Link2,
  Loader2,
  MoreHorizontal,
  Pin,
  Plus,
  RefreshCw,
  Repeat2,
  Trash2,
  UserRound,
} from 'lucide-react';
import { DEFAULT_GROUP_KEY, DEFAULT_GROUP_NAME, selectClassName } from '../../lib/constants';
import { useDashboard } from '../../lib/dashboard-context';
import { folderText } from '../../lib/folders';
import { canBridgeToFediverse, getMappingGroupMeta } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu';

// Desktop accounts table.
export function AccountsTable() {
  const {
    allFilteredManageableSelected,
    bridgingMappingId,
    canManageGroupsPermission,
    canManageMapping,
    canQueueBackfillsPermission,
    cancelQueuedBackfill,
    fediverseBridgeStatusByMappingId,
    filteredManageableMappingIds,
    getBackfillEntry,
    getProfileForActor,
    groupOptions,
    handleAssignMappingGroup,
    handleBridgeToFediverse,
    handleDeleteAllPosts,
    handleDeleteMapping,
    handlePullTwitterBio,
    handleSyncProfileFromTwitter,
    handleUpdateProfileSyncSource,
    isAdmin,
    isAnyBulkAccountsActionBusy,
    isBackfillActive,
    isBackfillQueued,
    isBridgeAllBusy,
    isSyncAllProfilesBusy,
    openAccount,
    pagedGroupedMappings,
    pullingBioMappingId,
    requestBackfill,
    requestPinSync,
    selectedAccountMappingIdSet,
    showAccountAvatars,
    showAccountBios,
    showOwnerColumns,
    startEditMapping,
    syncingProfileMappingId,
    toggleAccountMappingSelection,
    toggleSelectAllFilteredManageable,
  } = useDashboard();
  return (
    <div className="cv-auto hidden md:block">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="w-9 px-2 py-3">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-border"
                  checked={allFilteredManageableSelected}
                  disabled={filteredManageableMappingIds.length === 0}
                  onChange={(event) => toggleSelectAllFilteredManageable(event.target.checked)}
                  aria-label="Select all accounts on this page"
                />
              </th>
              <th className="px-2 py-2 font-medium">Mirror</th>
              <th className="px-2 py-2 font-medium">X sources</th>
              <th className="px-2 py-2 font-medium">Status</th>
              {showOwnerColumns ? <th className="px-2 py-2 font-medium">Owner</th> : null}
              <th className="px-2 py-2 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(pagedGroupedMappings[0]?.mappings ?? []).map((mapping) => {
              const queued = isBackfillQueued(mapping.id);
              const active = isBackfillActive(mapping.id);
              const queuePosition = getBackfillEntry(mapping.id)?.position;
              const profile = getProfileForActor(mapping.bskyIdentifier);
              const profileHandle = profile?.handle || mapping.bskyIdentifier;
              const profileName = profile?.displayName || profileHandle;
              const profileBio = showAccountBios ? profile?.description?.trim() || '' : '';
              const profileUrl = `https://bsky.app/profile/${profileHandle}`;
              const canManageThisMapping = canManageMapping(mapping);
              const canUseFediverseBridge = canBridgeToFediverse(profile?.createdAt);
              const bridgeStatus = fediverseBridgeStatusByMappingId[mapping.id];
              const isFediverseBridged = bridgeStatus?.bridged === true;
              const bridging = bridgingMappingId === mapping.id;
              const mappingGroup = getMappingGroupMeta(mapping);
              const syncingProfile = syncingProfileMappingId === mapping.id;
              const pullingBio = pullingBioMappingId === mapping.id;
              const isSelectedForBulk = selectedAccountMappingIdSet.has(mapping.id);

              return (
                <tr key={mapping.id} className="interactive-row border-b border-border/70">
                  <td className="px-2 py-2.5 align-middle">
                    {canManageThisMapping ? (
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-border"
                        checked={isSelectedForBulk}
                        disabled={isAnyBulkAccountsActionBusy}
                        onChange={(event) => toggleAccountMappingSelection(mapping.id, event.target.checked)}
                        aria-label={`Select ${mapping.bskyIdentifier}`}
                      />
                    ) : null}
                  </td>
                  <td className="px-2 py-2.5 align-middle">
                    <div className="flex items-center gap-2">
                      {showAccountAvatars && profile?.avatar ? (
                        <img
                          className="h-7 w-7 shrink-0 rounded-full object-cover"
                          src={profile.avatar}
                          alt={profileName}
                          loading="lazy"
                          decoding="async"
                          fetchPriority="low"
                        />
                      ) : (
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                          <UserRound className="h-4 w-4" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                          onClick={() => openAccount(mapping.id)}
                          title={`Open ${profileName}`}
                        >
                          {profileName}
                        </button>
                        <a
                          className={cn(
                            'inline-flex max-w-full items-center truncate text-xs text-muted-foreground hover:text-foreground hover:underline',
                            profileName === profileHandle && 'sr-only',
                          )}
                          href={profileUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={`Open @${profileHandle} on Bluesky`}
                        >
                          {profileHandle}
                          <ArrowUpRight className="ml-1 h-3 w-3 shrink-0" />
                        </a>
                        {profileBio ? (
                          <p
                            className="mt-1 overflow-hidden text-xs text-muted-foreground"
                            style={{
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                            }}
                            title={profileBio}
                          >
                            {profileBio}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </td>
                  <td className="max-w-[16rem] px-2 py-2.5 align-middle text-[13px] text-muted-foreground">
                    <span className="line-clamp-2">
                      {mapping.twitterUsernames.map((username) => `@${username}`).join(', ')}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 align-middle">
                    <div className="flex flex-wrap items-center gap-1">
                      {active ? (
                        <Badge variant="warning">Backfilling</Badge>
                      ) : queued ? (
                        <Badge variant="warning">Queued {queuePosition ? `#${queuePosition}` : ''}</Badge>
                      ) : mapping.enabled ? null : (
                        <Badge variant="outline">Paused</Badge>
                      )}
                      {isFediverseBridged ? (
                        <span
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                          title="Bridged to the fediverse"
                        >
                          <Link2 className="h-3 w-3" />
                          Bridged
                        </span>
                      ) : null}
                      {mapping.hasBotLabel === false ? <Badge variant="warning">No bot label</Badge> : null}
                    </div>
                  </td>
                  {showOwnerColumns ? (
                    <td className="px-2 py-2.5 align-middle text-xs text-muted-foreground">
                      {mapping.owner || 'System'}
                      {mapping.createdByLabel || mapping.createdByUser?.username || mapping.createdByUser?.email ? (
                        <span className="block">
                          by {mapping.createdByLabel || mapping.createdByUser?.username || mapping.createdByUser?.email}
                        </span>
                      ) : null}
                    </td>
                  ) : null}
                  <td className="px-2 py-2.5 align-middle">
                    <div className="flex items-center justify-end gap-1.5">
                      {canManageThisMapping && canManageGroupsPermission ? (
                        <select
                          className={cn(selectClassName, 'h-8 w-28 px-1.5 py-1 text-xs')}
                          aria-label="Folder"
                          value={mappingGroup.key}
                          disabled={
                            isBridgeAllBusy ||
                            isAnyBulkAccountsActionBusy ||
                            isSyncAllProfilesBusy ||
                            Boolean(syncingProfileMappingId)
                          }
                          title="Move to folder"
                          onChange={(event) => {
                            void handleAssignMappingGroup(mapping, event.target.value);
                          }}
                        >
                          <option value={DEFAULT_GROUP_KEY}>{DEFAULT_GROUP_NAME}</option>
                          {groupOptions
                            .filter((option) => option.key !== DEFAULT_GROUP_KEY)
                            .map((option) => (
                              <option key={`group-move-${mapping.id}-${option.key}`} value={option.key}>
                                {folderText(option.emoji, option.name)}
                              </option>
                            ))}
                        </select>
                      ) : null}
                      {canManageThisMapping ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isBridgeAllBusy || isAnyBulkAccountsActionBusy || Boolean(syncingProfileMappingId)}
                          onClick={() => startEditMapping(mapping)}
                        >
                          Edit
                        </Button>
                      ) : null}
                      {canManageThisMapping ? (
                        <DropdownMenu
                          align="end"
                          triggerClassName="h-8 w-8 px-0"
                          ariaLabel={`More actions for ${mapping.bskyIdentifier}`}
                          trigger={<MoreHorizontal className="h-4 w-4" />}
                        >
                          {mapping.twitterUsernames.length > 1 ? (
                            <div className="space-y-1 px-3 py-2" data-keep-open="true">
                              <p className="text-[11px] font-medium text-muted-foreground">Profile sync source</p>
                              <select
                                className={cn(selectClassName, 'h-8 text-xs')}
                                value={mapping.profileSyncSourceUsername || ''}
                                disabled={
                                  isBridgeAllBusy ||
                                  isAnyBulkAccountsActionBusy ||
                                  isSyncAllProfilesBusy ||
                                  Boolean(syncingProfileMappingId) ||
                                  Boolean(bridgingMappingId)
                                }
                                onChange={(event) => {
                                  void handleUpdateProfileSyncSource(mapping, event.target.value);
                                }}
                              >
                                <option value="">Select sync source</option>
                                {mapping.twitterUsernames.map((username) => (
                                  <option key={`sync-source-${mapping.id}-${username}`} value={username}>
                                    @{username}
                                  </option>
                                ))}
                              </select>
                              <DropdownMenuSeparator />
                            </div>
                          ) : null}
                          <DropdownMenuItem
                            icon={
                              syncingProfile ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="h-4 w-4" />
                              )
                            }
                            disabled={
                              isBridgeAllBusy ||
                              isAnyBulkAccountsActionBusy ||
                              Boolean(syncingProfileMappingId) ||
                              Boolean(pullingBioMappingId) ||
                              isSyncAllProfilesBusy ||
                              Boolean(bridgingMappingId)
                            }
                            onClick={() => {
                              void handleSyncProfileFromTwitter(mapping);
                            }}
                          >
                            Sync Profile
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            icon={
                              pullingBio ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4" />
                              )
                            }
                            disabled={
                              isBridgeAllBusy ||
                              isAnyBulkAccountsActionBusy ||
                              Boolean(syncingProfileMappingId) ||
                              Boolean(pullingBioMappingId) ||
                              isSyncAllProfilesBusy ||
                              Boolean(bridgingMappingId)
                            }
                            onClick={() => {
                              void handlePullTwitterBio(mapping);
                            }}
                          >
                            Pull Twitter Bio
                          </DropdownMenuItem>
                          {canUseFediverseBridge && !isFediverseBridged ? (
                            <DropdownMenuItem
                              icon={
                                bridging ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Repeat2 className="h-4 w-4" />
                                )
                              }
                              disabled={
                                isBridgeAllBusy ||
                                isAnyBulkAccountsActionBusy ||
                                Boolean(bridgingMappingId) ||
                                Boolean(syncingProfileMappingId) ||
                                isSyncAllProfilesBusy
                              }
                              onClick={() => {
                                void handleBridgeToFediverse(mapping);
                              }}
                            >
                              Bridge to Fediverse
                            </DropdownMenuItem>
                          ) : null}
                          {canQueueBackfillsPermission ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                icon={<Plus className="h-4 w-4" />}
                                disabled={
                                  isBridgeAllBusy ||
                                  isAnyBulkAccountsActionBusy ||
                                  Boolean(syncingProfileMappingId) ||
                                  isSyncAllProfilesBusy
                                }
                                onClick={() => {
                                  void requestBackfill(mapping.id, 'normal');
                                }}
                              >
                                Add to queue
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                icon={<Pin className="h-4 w-4" />}
                                disabled={
                                  isBridgeAllBusy ||
                                  isAnyBulkAccountsActionBusy ||
                                  Boolean(syncingProfileMappingId) ||
                                  isSyncAllProfilesBusy
                                }
                                onClick={() => {
                                  void requestPinSync(mapping.id);
                                }}
                              >
                                Sync Pin
                              </DropdownMenuItem>
                              {queued && !active ? (
                                <DropdownMenuItem
                                  disabled={
                                    isBridgeAllBusy ||
                                    isAnyBulkAccountsActionBusy ||
                                    Boolean(syncingProfileMappingId) ||
                                    isSyncAllProfilesBusy
                                  }
                                  onClick={() => {
                                    void cancelQueuedBackfill(mapping.id);
                                  }}
                                >
                                  Cancel queue
                                </DropdownMenuItem>
                              ) : null}
                              {isAdmin ? (
                                <DropdownMenuItem
                                  disabled={
                                    isBridgeAllBusy ||
                                    isAnyBulkAccountsActionBusy ||
                                    Boolean(syncingProfileMappingId) ||
                                    isSyncAllProfilesBusy
                                  }
                                  onClick={() => {
                                    void requestBackfill(mapping.id, 'reset');
                                  }}
                                >
                                  Reset + Backfill
                                </DropdownMenuItem>
                              ) : null}
                            </>
                          ) : null}
                          {isAdmin ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                destructive
                                icon={<Trash2 className="h-4 w-4" />}
                                disabled={
                                  isBridgeAllBusy ||
                                  isAnyBulkAccountsActionBusy ||
                                  Boolean(syncingProfileMappingId) ||
                                  isSyncAllProfilesBusy
                                }
                                onClick={() => {
                                  void handleDeleteAllPosts(mapping.id);
                                }}
                              >
                                Delete Posts
                              </DropdownMenuItem>
                            </>
                          ) : null}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            destructive
                            icon={<Trash2 className="h-4 w-4" />}
                            disabled={
                              isBridgeAllBusy ||
                              isAnyBulkAccountsActionBusy ||
                              Boolean(syncingProfileMappingId) ||
                              isSyncAllProfilesBusy
                            }
                            onClick={() => {
                              void handleDeleteMapping(mapping.id);
                            }}
                          >
                            Remove mapping
                          </DropdownMenuItem>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
