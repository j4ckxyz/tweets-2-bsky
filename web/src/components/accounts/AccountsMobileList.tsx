import { ArrowUpRight, Download, Loader2, MoreHorizontal, Pin, Plus, RefreshCw, Repeat2, Trash2 } from 'lucide-react';
import { DEFAULT_GROUP_KEY, DEFAULT_GROUP_NAME, selectClassName } from '../../lib/constants';
import { useDashboard } from '../../lib/dashboard-context';
import { folderText } from '../../lib/folders';
import { canBridgeToFediverse, getMappingGroupMeta } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu';

// Accounts as stacked rows on small screens.
export function AccountsMobileList() {
  const {
    bridgingMappingId,
    canManageMapping,
    canQueueBackfillsPermission,
    cancelQueuedBackfill,
    fediverseBridgeStatusByMappingId,
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
    startEditMapping,
    syncingProfileMappingId,
    toggleAccountMappingSelection,
  } = useDashboard();

  return (
    <div className="space-y-4 md:hidden animate-fade-in">
      {(pagedGroupedMappings[0]?.mappings ?? []).map((mapping) => {
        const queued = isBackfillQueued(mapping.id);
        const active = isBackfillActive(mapping.id);
        const queuePosition = getBackfillEntry(mapping.id)?.position;
        const profile = getProfileForActor(mapping.bskyIdentifier);
        const profileHandle = profile?.handle || mapping.bskyIdentifier;
        const profileName = profile?.displayName || profileHandle;
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
          <div
            key={`mobile-mapping-${mapping.id}`}
            className="space-y-3 border-b border-border py-3 transition-colors duration-150"
          >
            <div className="flex items-start gap-3">
              {canManageThisMapping ? (
                <input
                  type="checkbox"
                  className="mt-1.5 h-4 w-4 rounded border-border"
                  checked={isSelectedForBulk}
                  disabled={isAnyBulkAccountsActionBusy}
                  onChange={(event) => toggleAccountMappingSelection(mapping.id, event.target.checked)}
                  aria-label={`Select ${mapping.bskyIdentifier}`}
                />
              ) : null}
              {showAccountAvatars && profile?.avatar ? (
                <img
                  className="h-8 w-8 shrink-0 rounded-full object-cover"
                  src={profile.avatar}
                  alt=""
                  loading="lazy"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                  onClick={() => openAccount(mapping.id)}
                  title={`Open ${profileName}`}
                >
                  {profileName}
                </button>
                {profileName !== profileHandle ? (
                  <a
                    className="inline-flex max-w-full items-center truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
                    href={profileUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open @${profileHandle} on Bluesky`}
                  >
                    {profileHandle}
                    <ArrowUpRight className="ml-0.5 h-3 w-3 shrink-0" />
                  </a>
                ) : null}
                <p className="truncate text-xs text-muted-foreground">
                  from {mapping.twitterUsernames.map((username) => `@${username}`).join(', ')}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                {active ? (
                  <Badge variant="warning">Backfilling</Badge>
                ) : queued ? (
                  <Badge variant="warning">Queued {queuePosition ? `#${queuePosition}` : ''}</Badge>
                ) : mapping.enabled ? null : (
                  <Badge variant="outline">Paused</Badge>
                )}
                {mapping.hasBotLabel === false ? <Badge variant="warning">No bot label</Badge> : null}
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <div className="text-xs text-muted-foreground">
                {isAdmin && mapping.createdByLabel ? <span>Created by: {mapping.createdByLabel}</span> : null}
              </div>
              <div className="flex items-center gap-2">
                {canManageThisMapping && groupOptions.length > 0 ? (
                  <select
                    className={cn(selectClassName, 'h-9 w-28 px-1.5 py-1 text-xs')}
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
                        <option key={`group-move-mobile-${mapping.id}-${option.key}`} value={option.key}>
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
                    triggerClassName="h-9 w-9 px-0"
                    trigger={<MoreHorizontal className="h-4 w-4" />}
                    ariaLabel={`More actions for @${profileHandle}`}
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
                            <option key={`sync-source-mobile-actions-${mapping.id}-${username}`} value={username}>
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
                        pullingBio ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />
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
                        icon={bridging ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat2 className="h-4 w-4" />}
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
            </div>
          </div>
        );
      })}
    </div>
  );
}
