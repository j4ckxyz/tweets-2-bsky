import { useCallback } from 'react';
import * as api from '../lib/api';
import { DEFAULT_BACKFILL_LIMIT } from '../lib/constants';
import { canBridgeToFediverse, normalizeTwitterUsername } from '../lib/format';
import type { AccountMapping, BulkAccountsAction } from '../lib/types';
import type { useAccountsList } from './useAccountsList';
import type { useActivity } from './useActivity';
import type { useAuthForms } from './useAuthForms';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useGroups } from './useGroups';
import type { useNotice } from './useNotice';
import type { usePosts } from './usePosts';
import type { useRouting } from './useRouting';
import type { useTheme } from './useTheme';

// Per-account and bulk actions: run now, backfills, pins, profile sync, bot labels, bridging, deletes.
export function useAccountActions(
  deps: Pick<
    ReturnType<typeof useDashboardState> &
      ReturnType<typeof useTheme> &
      ReturnType<typeof useNotice> &
      ReturnType<typeof useAuthSession> &
      ReturnType<typeof useRouting> &
      ReturnType<typeof useDashboardData> &
      ReturnType<typeof useAuthForms> &
      ReturnType<typeof useGroups> &
      ReturnType<typeof useAccountsList> &
      ReturnType<typeof usePosts> &
      ReturnType<typeof useActivity>,
    | 'authHeaders'
    | 'canManageMapping'
    | 'canQueueBackfillsPermission'
    | 'canRunNowPermission'
    | 'currentStatus'
    | 'fediverseBridgeStatusByMappingId'
    | 'fetchData'
    | 'fetchFediverseBridgeStatuses'
    | 'fetchProfiles'
    | 'fetchRecentActivity'
    | 'fetchStatus'
    | 'getProfileForActor'
    | 'handleAuthFailure'
    | 'isAdmin'
    | 'isAnyBulkAccountsActionBusy'
    | 'isBridgeAllBusy'
    | 'isPullBioAllBusy'
    | 'isSyncAllProfilesBusy'
    | 'manageableAccountMappingsForView'
    | 'mappings'
    | 'pendingBackfills'
    | 'profilesByActor'
    | 'pullingBioMappingId'
    | 'selectedManageableMappingsForView'
    | 'setBridgeAllProgress'
    | 'setBridgingMappingId'
    | 'setFediverseBridgeStatusByMappingId'
    | 'setIsAppendBotNameAllBusy'
    | 'setIsBotLabelAllBusy'
    | 'setIsBridgeAllBusy'
    | 'setIsPullBioAllBusy'
    | 'setIsSyncAllProfilesBusy'
    | 'setMappings'
    | 'setPullingBioMappingId'
    | 'setStatus'
    | 'setSyncingProfileMappingId'
    | 'showNotice'
    | 'syncingProfileMappingId'
  >,
) {
  const {
    authHeaders,
    canManageMapping,
    canQueueBackfillsPermission,
    canRunNowPermission,
    currentStatus,
    fediverseBridgeStatusByMappingId,
    fetchData,
    fetchFediverseBridgeStatuses,
    fetchProfiles,
    fetchRecentActivity,
    fetchStatus,
    getProfileForActor,
    handleAuthFailure,
    isAdmin,
    isAnyBulkAccountsActionBusy,
    isBridgeAllBusy,
    isPullBioAllBusy,
    isSyncAllProfilesBusy,
    manageableAccountMappingsForView,
    mappings,
    pendingBackfills,
    profilesByActor,
    pullingBioMappingId,
    selectedManageableMappingsForView,
    setBridgeAllProgress,
    setBridgingMappingId,
    setFediverseBridgeStatusByMappingId,
    setIsAppendBotNameAllBusy,
    setIsBotLabelAllBusy,
    setIsBridgeAllBusy,
    setIsPullBioAllBusy,
    setIsSyncAllProfilesBusy,
    setMappings,
    setPullingBioMappingId,
    setStatus,
    setSyncingProfileMappingId,
    showNotice,
    syncingProfileMappingId,
  } = deps;

  const isBackfillQueued = useCallback(
    (mappingId: string) => pendingBackfills.some((entry) => entry.id === mappingId),
    [pendingBackfills],
  );

  const getBackfillEntry = useCallback(
    (mappingId: string) => pendingBackfills.find((entry) => entry.id === mappingId),
    [pendingBackfills],
  );

  const isBackfillActive = useCallback(
    (mappingId: string) => currentStatus?.state === 'backfilling' && currentStatus.backfillMappingId === mappingId,
    [currentStatus],
  );

  const runNow = async () => {
    if (!authHeaders) {
      return;
    }
    if (!canRunNowPermission) {
      showNotice('error', 'You do not have permission to run checks now.');
      return;
    }

    try {
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              nextCheckTime: Date.now() + 1000,
              currentStatus: {
                ...previous.currentStatus,
                state: 'checking',
                message: 'Manual run requested...',
                lastUpdate: Date.now(),
                backfillMappingId: undefined,
                backfillRequestId: undefined,
              },
            }
          : previous,
      );
      await api.runNow({}, { headers: authHeaders });
      showNotice('info', 'Check triggered.');
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to trigger a check.');
    }
  };

  const clearAllBackfills = async () => {
    if (!authHeaders) {
      return;
    }

    const confirmed = window.confirm('Stop all pending and active backfills?');
    if (!confirmed) {
      return;
    }

    try {
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              pendingBackfills: [],
              currentStatus: {
                ...previous.currentStatus,
                state: 'idle',
                message: 'Backfill queue cleared',
                backfillMappingId: undefined,
                backfillRequestId: undefined,
                lastUpdate: Date.now(),
              },
            }
          : previous,
      );
      await api.clearAllBackfills({}, { headers: authHeaders });
      showNotice('success', 'Backfill queue cleared.');
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to clear backfill queue.');
    }
  };

  const recheckAccount = async (mappingId: string, bskyIdentifier: string) => {
    if (!authHeaders) {
      return;
    }
    try {
      const response = await api.recheckAccount(mappingId, {}, { headers: authHeaders });
      showNotice('success', response.data?.message || `Will retry ${bskyIdentifier} on the next post batch.`);
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, `Failed to schedule a recheck for ${bskyIdentifier}.`);
    }
  };

  const cancelQueuedBackfill = async (mappingId: string) => {
    if (!authHeaders) {
      return;
    }

    const mapping = mappings.find((entry) => entry.id === mappingId);
    if (!mapping || !canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to cancel this queue entry.');
      return;
    }

    try {
      setStatus((previous) => {
        if (!previous) {
          return previous;
        }

        const nextPending = previous.pendingBackfills
          .filter((entry) => entry.id !== mappingId)
          .map((entry, index) => ({ ...entry, position: index + 1 }));
        return {
          ...previous,
          pendingBackfills: nextPending,
        };
      });
      await api.cancelBackfill(mappingId, { headers: authHeaders });
      showNotice('success', 'Queue entry cancelled.');
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to cancel queue entry.');
    }
  };

  const requestBackfill = async (mappingId: string, mode: 'normal' | 'reset') => {
    if (!authHeaders) {
      return;
    }
    const mapping = mappings.find((entry) => entry.id === mappingId);
    if (!mapping || !canQueueBackfillsPermission || !canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to queue backfill for this account.');
      return;
    }

    const busy = pendingBackfills.length > 0 || currentStatus?.state === 'backfilling';
    if (busy) {
      const proceed = window.confirm(
        'Backfill is already queued or active. This request will replace the existing queue item for this account. Continue?',
      );
      if (!proceed) {
        return;
      }
    }
    const safeLimit = DEFAULT_BACKFILL_LIMIT;

    try {
      if (mode === 'reset') {
        if (!isAdmin) {
          showNotice('error', 'Only admins can reset cache before backfill.');
          return;
        }
        await api.clearMappingCache(mappingId, { headers: authHeaders });
      }

      setStatus((previous) => {
        if (!previous) {
          return previous;
        }

        const now = Date.now();
        const existing = previous.pendingBackfills.filter((entry) => entry.id !== mappingId);
        const nextPending = [
          ...existing,
          {
            id: mappingId,
            limit: safeLimit,
            queuedAt: now,
            sequence: now,
            requestId: `ui-${now}`,
            position: existing.length + 1,
          },
        ].map((entry, index) => ({ ...entry, position: index + 1 }));

        return {
          ...previous,
          pendingBackfills: nextPending,
        };
      });
      await api.requestBackfill(mappingId, { limit: safeLimit }, { headers: authHeaders });
      showNotice(
        'success',
        mode === 'reset'
          ? `Cache reset and backfill queued (${safeLimit} tweets).`
          : `Backfill queued (${safeLimit} tweets).`,
      );
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to queue backfill.');
    }
  };

  const requestPinSync = async (mappingId: string) => {
    if (!authHeaders) {
      return;
    }
    const mapping = mappings.find((entry) => entry.id === mappingId);
    if (!mapping || !canQueueBackfillsPermission || !canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to sync pins for this account.');
      return;
    }

    try {
      await api.syncPin(mappingId, {}, { headers: authHeaders });
      showNotice('success', 'Pin sync queued. The pinned tweet will be mirrored and pinned on Bluesky.');
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to queue pin sync.');
    }
  };

  const handleDeleteAllPosts = async (mappingId: string) => {
    if (!authHeaders) {
      return;
    }

    const firstConfirm = window.confirm(
      'Danger: this deletes the posts this mirror created on the Bluesky account. Posts written directly on Bluesky are kept, and afterwards only new tweets are mirrored. Continue?',
    );

    if (!firstConfirm) {
      return;
    }

    const finalConfirm = window.prompt(
      'Type DELETE to remove the mirrored posts, or DELETE ALL to remove every post on the account (including ones written by hand):',
    );
    if (finalConfirm !== 'DELETE' && finalConfirm !== 'DELETE ALL') {
      return;
    }

    try {
      const response = await api.deleteAllPosts(
        mappingId,
        { scope: finalConfirm === 'DELETE ALL' ? 'all' : 'mirrored' },
        { headers: authHeaders },
      );
      showNotice('success', response.data.message);
    } catch (error) {
      handleAuthFailure(error, 'Failed to delete posts.');
    }
  };

  const handleDeleteMapping = async (mappingId: string) => {
    if (!authHeaders) {
      return;
    }
    const mapping = mappings.find((entry) => entry.id === mappingId);
    if (!mapping || !canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to delete this mapping.');
      return;
    }

    const confirmed = window.confirm('Delete this mapping?');
    if (!confirmed) {
      return;
    }

    try {
      await api.deleteMapping(mappingId, { headers: authHeaders });
      setMappings((prev) => prev.filter((mapping) => mapping.id !== mappingId));
      setFediverseBridgeStatusByMappingId((previous) => {
        if (!(mappingId in previous)) {
          return previous;
        }
        const next = { ...previous };
        delete next[mappingId];
        return next;
      });
      showNotice('success', 'Mapping deleted.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to delete mapping.');
    }
  };

  const resolveProfileSyncSource = (mapping: AccountMapping, silent = false): string | null => {
    const candidates = [
      ...new Set(mapping.twitterUsernames.map(normalizeTwitterUsername).filter((value) => value.length > 0)),
    ];
    if (candidates.length === 0) {
      if (!silent) {
        showNotice('error', 'Mapping has no Twitter source usernames.');
      }
      return null;
    }

    const selected = normalizeTwitterUsername(mapping.profileSyncSourceUsername || '');
    if (selected && candidates.includes(selected)) {
      return selected;
    }

    if (!silent && candidates.length > 1) {
      showNotice('info', `Using @${candidates[0] || ''} as the default profile sync source.`);
    }

    return candidates[0] || null;
  };

  const syncProfileFromTwitterForMapping = async (
    mapping: AccountMapping,
    options?: {
      confirm?: boolean;
      showNoticeOnResult?: boolean;
      refreshAfter?: boolean;
    },
  ): Promise<{ ok: boolean; skipped: boolean }> => {
    if (!authHeaders) {
      return { ok: false, skipped: false };
    }
    if (!canManageMapping(mapping)) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('error', 'You do not have permission to update this mapping.');
      }
      return { ok: false, skipped: false };
    }

    const sourceTwitterUsername = resolveProfileSyncSource(mapping, options?.showNoticeOnResult === false);
    if (!sourceTwitterUsername) {
      return { ok: false, skipped: false };
    }

    if (options?.confirm !== false) {
      const confirmed = window.confirm(
        `Sync profile from @${sourceTwitterUsername}? This updates display name, bio, avatar, and banner only when the Twitter profile changed.`,
      );
      if (!confirmed) {
        return { ok: false, skipped: false };
      }
    }

    setSyncingProfileMappingId(mapping.id);
    try {
      const response = await api.syncProfileFromTwitter(
        mapping.id,
        { sourceTwitterUsername },
        { headers: authHeaders },
      );

      const result = response.data;
      const warnings = result?.warnings || [];
      const skipped = Boolean(result?.skipped);

      if (result?.mapping) {
        setMappings((previous) => previous.map((entry) => (entry.id === mapping.id ? result.mapping || entry : entry)));
      }

      if (options?.showNoticeOnResult !== false) {
        if (skipped) {
          showNotice('info', `No profile changes detected for @${sourceTwitterUsername}.`);
        } else if (warnings.length > 0) {
          showNotice(
            'info',
            `Profile synced from @${sourceTwitterUsername} with ${warnings.length} warning(s). First warning: ${warnings[0]}`,
          );
        } else {
          showNotice('success', `Profile synced from @${sourceTwitterUsername}.`);
        }
      }

      if (options?.refreshAfter !== false) {
        await fetchData();
      }

      return { ok: true, skipped };
    } catch (error) {
      if (options?.showNoticeOnResult !== false) {
        handleAuthFailure(error, 'Failed to sync profile from Twitter.');
      }
      return { ok: false, skipped: false };
    } finally {
      setSyncingProfileMappingId((previous) => (previous === mapping.id ? null : previous));
    }
  };

  const handleSyncProfileFromTwitter = async (mapping: AccountMapping) => {
    await syncProfileFromTwitterForMapping(mapping, {
      confirm: true,
      showNoticeOnResult: true,
      refreshAfter: true,
    });
  };

  const pullTwitterBioForMapping = async (
    mapping: AccountMapping,
    options?: {
      confirm?: boolean;
      showNoticeOnResult?: boolean;
      refreshAfter?: boolean;
    },
  ): Promise<{ ok: boolean; skipped: boolean }> => {
    if (!authHeaders) {
      return { ok: false, skipped: false };
    }
    if (!canManageMapping(mapping)) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('error', 'You do not have permission to update this mapping.');
      }
      return { ok: false, skipped: false };
    }

    const sourceTwitterUsername = resolveProfileSyncSource(mapping, options?.showNoticeOnResult === false);
    if (!sourceTwitterUsername) {
      return { ok: false, skipped: false };
    }

    if (options?.confirm !== false) {
      const confirmed = window.confirm(
        `Pull Twitter bio from @${sourceTwitterUsername}? This updates only the bio/description on Bluesky.`,
      );
      if (!confirmed) {
        return { ok: false, skipped: false };
      }
    }

    setPullingBioMappingId(mapping.id);
    try {
      const response = await api.pullTwitterBio(mapping.id, { sourceTwitterUsername }, { headers: authHeaders });

      const result = response.data;
      const warnings = result?.warnings || [];
      const skipped = Boolean(result?.skipped);

      if (result?.mapping) {
        setMappings((previous) => previous.map((entry) => (entry.id === mapping.id ? result.mapping || entry : entry)));
      }

      if (options?.showNoticeOnResult !== false) {
        if (skipped) {
          showNotice('info', `No bio changes detected for @${sourceTwitterUsername}.`);
        } else if (warnings.length > 0) {
          showNotice(
            'info',
            `Bio pulled from @${sourceTwitterUsername} with ${warnings.length} warning(s). First warning: ${warnings[0]}`,
          );
        } else {
          showNotice('success', `Bio pulled from @${sourceTwitterUsername}.`);
        }
      }

      if (options?.refreshAfter !== false) {
        await fetchData();
      }

      return { ok: true, skipped };
    } catch (error) {
      if (options?.showNoticeOnResult !== false) {
        handleAuthFailure(error, 'Failed to pull Twitter bio.');
      }
      return { ok: false, skipped: false };
    } finally {
      setPullingBioMappingId((previous) => (previous === mapping.id ? null : previous));
    }
  };

  const handlePullTwitterBio = async (mapping: AccountMapping) => {
    await pullTwitterBioForMapping(mapping, {
      confirm: true,
      showNoticeOnResult: true,
      refreshAfter: true,
    });
  };

  const resolveBulkAccountTargets = (_actionLabel: string): AccountMapping[] => {
    if (selectedManageableMappingsForView.length > 0) {
      return selectedManageableMappingsForView;
    }
    return manageableAccountMappingsForView;
  };

  const handleSyncAllProfilesFromTwitter = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isBridgeAllBusy) {
      showNotice('info', 'Bridge-all is currently running. Please wait.');
      return;
    }

    const candidates =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (candidates.length === 0) {
      showNotice('info', 'No accounts available for profile sync.');
      return;
    }

    const confirmed = window.confirm(`Sync Twitter profile data for ${candidates.length} account(s), one at a time?`);
    if (!confirmed) {
      return;
    }

    setIsSyncAllProfilesBusy(true);
    let syncedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    try {
      for (const mapping of candidates) {
        const outcome = await syncProfileFromTwitterForMapping(mapping, {
          confirm: false,
          showNoticeOnResult: false,
          refreshAfter: false,
        });

        if (!outcome.ok) {
          failedCount += 1;
          continue;
        }
        if (outcome.skipped) {
          skippedCount += 1;
        } else {
          syncedCount += 1;
        }
      }

      await fetchData();
      showNotice(
        failedCount > 0 ? 'info' : 'success',
        `Sync all complete: ${syncedCount} updated, ${skippedCount} unchanged, ${failedCount} failed.`,
      );
    } finally {
      setIsSyncAllProfilesBusy(false);
    }
  };

  const handlePullTwitterBioForAccounts = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isAnyBulkAccountsActionBusy) {
      showNotice('info', 'A bulk accounts action is already running. Please wait.');
      return;
    }

    const candidates =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (candidates.length === 0) {
      showNotice('info', 'No accounts available for Twitter bio pull.');
      return;
    }

    const confirmed = window.confirm(
      `Pull Twitter bio for ${candidates.length} account(s), one at a time? This updates only Bluesky description.`,
    );
    if (!confirmed) {
      return;
    }

    setIsPullBioAllBusy(true);
    let syncedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    try {
      for (const mapping of candidates) {
        const outcome = await pullTwitterBioForMapping(mapping, {
          confirm: false,
          showNoticeOnResult: false,
          refreshAfter: false,
        });

        if (!outcome.ok) {
          failedCount += 1;
          continue;
        }
        if (outcome.skipped) {
          skippedCount += 1;
        } else {
          syncedCount += 1;
        }
      }

      await fetchData();
      showNotice(
        failedCount > 0 ? 'info' : 'success',
        `Pull bio complete: ${syncedCount} updated, ${skippedCount} unchanged, ${failedCount} failed.`,
      );
    } finally {
      setIsPullBioAllBusy(false);
    }
  };

  const handleAddBotLabelToAllAccounts = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isAnyBulkAccountsActionBusy) {
      showNotice('info', 'Profile or bridge actions are running. Please wait.');
      return;
    }

    const candidates =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (candidates.length === 0) {
      showNotice('info', 'No accounts available for bot label update.');
      return;
    }

    const confirmed = window.confirm(
      `Add Bluesky automated-account bot label to ${candidates.length} account(s)? This appends the bot self-label to each app.bsky.actor.profile record.`,
    );
    if (!confirmed) {
      return;
    }

    setIsBotLabelAllBusy(true);
    try {
      const response = await api.applyBotLabelAll(
        { mappingIds: candidates.map((mapping) => mapping.id) },
        { headers: authHeaders },
      );
      const result = response.data;
      await fetchData();
      const firstFailure = result.failedMappings?.[0];
      showNotice(
        result.failed > 0 ? 'info' : 'success',
        `Bot label update complete: ${result.labeled} added, ${result.alreadyLabeled} already labeled, ${result.failed} failed.${
          firstFailure ? ` First failure: ${firstFailure.bskyIdentifier} (${firstFailure.error})` : ''
        }`,
      );
    } catch (error) {
      handleAuthFailure(error, 'Failed to add bot labels to accounts.');
    } finally {
      setIsBotLabelAllBusy(false);
    }
  };

  const handleAppendBotNameToAllAccounts = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isAnyBulkAccountsActionBusy) {
      showNotice('info', 'A bulk accounts action is already running. Please wait.');
      return;
    }

    const candidates =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (candidates.length === 0) {
      showNotice('info', 'No accounts available for display-name suffix update.');
      return;
    }

    const confirmed = window.confirm(
      `Refresh display names from Twitter and append {bot} for ${candidates.length} account(s)? Legacy {UNOFFICIAL} will be removed.`,
    );
    if (!confirmed) {
      return;
    }

    setIsAppendBotNameAllBusy(true);
    try {
      const response = await api.appendBotNameAll(
        { mappingIds: candidates.map((mapping) => mapping.id) },
        { headers: authHeaders },
      );
      const result = response.data;
      await fetchData();
      const firstFailure = result.failedMappings?.[0];
      showNotice(
        result.failed > 0 ? 'info' : 'success',
        `Display-name append complete: ${result.appended} updated, ${result.alreadyAppended} already set, ${result.failed} failed.${
          firstFailure ? ` First failure: ${firstFailure.bskyIdentifier} (${firstFailure.error})` : ''
        }`,
      );
    } catch (error) {
      handleAuthFailure(error, 'Failed to append {bot} to account display names.');
    } finally {
      setIsAppendBotNameAllBusy(false);
    }
  };

  const handleSyncPinsForAccounts = async (targets: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (!canQueueBackfillsPermission) {
      showNotice('error', 'You do not have permission to sync pins.');
      return;
    }

    let queued = 0;
    let failed = 0;
    for (const mapping of targets) {
      try {
        await api.syncPin(mapping.id, {}, { headers: authHeaders });
        queued += 1;
      } catch {
        failed += 1;
      }
    }

    if (queued > 0) {
      showNotice(
        'success',
        `Pin sync queued for ${queued} account(s)${failed > 0 ? ` (${failed} failed to queue)` : ''}. Pinned tweets will be mirrored and pinned on Bluesky.`,
      );
    } else {
      showNotice('error', 'Failed to queue pin sync for the selected accounts.');
    }
    await fetchStatus();
  };

  const handleApplyAllAccountsAction = async (action: BulkAccountsAction) => {
    const actionLabel =
      action === 'sync_profiles'
        ? 'profile sync'
        : action === 'pull_twitter_bio'
          ? 'Twitter bio pull'
          : action === 'bridge_all'
            ? 'fediverse bridge'
            : action === 'apply_bot_label'
              ? 'bot label update'
              : action === 'sync_pins'
                ? 'pinned tweet sync'
                : 'display-name suffix update';
    const targets = resolveBulkAccountTargets(actionLabel);
    if (targets.length === 0) {
      return;
    }

    if (action === 'sync_profiles') {
      await handleSyncAllProfilesFromTwitter(targets);
      return;
    }
    if (action === 'pull_twitter_bio') {
      await handlePullTwitterBioForAccounts(targets);
      return;
    }
    if (action === 'bridge_all') {
      await handleBridgeAllEligible(targets);
      return;
    }
    if (action === 'apply_bot_label') {
      await handleAddBotLabelToAllAccounts(targets);
      return;
    }
    if (action === 'sync_pins') {
      await handleSyncPinsForAccounts(targets);
      return;
    }
    await handleAppendBotNameToAllAccounts(targets);
  };

  const handleUpdateProfileSyncSource = async (mapping: AccountMapping, selectedSource: string) => {
    if (!authHeaders) {
      return;
    }
    if (!canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to update this mapping.');
      return;
    }

    const normalizedSource = normalizeTwitterUsername(selectedSource || '');
    const sourceExists = mapping.twitterUsernames.some(
      (username) => normalizeTwitterUsername(username) === normalizedSource,
    );
    const nextSource = sourceExists ? normalizedSource : normalizeTwitterUsername(mapping.twitterUsernames[0] || '');

    try {
      await api.updateMapping(
        mapping.id,
        {
          profileSyncSourceUsername: nextSource,
        },
        { headers: authHeaders },
      );

      setMappings((previous) =>
        previous.map((entry) =>
          entry.id === mapping.id
            ? {
                ...entry,
                profileSyncSourceUsername: nextSource || undefined,
              }
            : entry,
        ),
      );

      showNotice('success', `Profile sync source set to @${nextSource}.`);
    } catch (error) {
      handleAuthFailure(error, 'Failed to update profile sync source.');
    }
  };

  const bridgeMappingToFediverse = async (
    mapping: AccountMapping,
    options?: {
      confirm?: boolean;
      showNoticeOnResult?: boolean;
    },
  ): Promise<{ ok: boolean; newlyBridged: boolean; skippedAsAlreadyBridged?: boolean }> => {
    if (!authHeaders) {
      return { ok: false, newlyBridged: false };
    }
    if (!canManageMapping(mapping)) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('error', 'You do not have permission to bridge this mapping.');
      }
      return { ok: false, newlyBridged: false };
    }

    const knownStatus = fediverseBridgeStatusByMappingId[mapping.id];
    if (knownStatus?.bridged === true) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('info', `${mapping.bskyIdentifier} is already bridged.`);
      }
      return { ok: true, newlyBridged: false, skippedAsAlreadyBridged: true };
    }

    const profile = getProfileForActor(mapping.bskyIdentifier);
    if (!canBridgeToFediverse(profile?.createdAt)) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('error', 'This Bluesky account must be at least 7 days old before bridging.');
      }
      return { ok: false, newlyBridged: false };
    }

    if (options?.confirm !== false) {
      const confirmed = window.confirm(
        `Bridge ${mapping.bskyIdentifier} to the fediverse now? This follows @ap.brid.gy and posts the bridge announcement.`,
      );
      if (!confirmed) {
        return { ok: false, newlyBridged: false };
      }
    }

    setBridgingMappingId(mapping.id);
    try {
      const response = await api.bridgeToFediverse(mapping.id, {}, { headers: authHeaders });
      setFediverseBridgeStatusByMappingId((previous) => ({
        ...previous,
        [mapping.id]: {
          bridged: true,
          checkedAt: new Date().toISOString(),
        },
      }));

      if (options?.showNoticeOnResult !== false) {
        showNotice(
          'success',
          `Fediverse bridge enabled: ${response.data?.fediverseAddress || `@${mapping.bskyIdentifier}@bsky.brid.gy`}`,
        );
      }

      return { ok: true, newlyBridged: true };
    } catch (error) {
      if (options?.showNoticeOnResult !== false) {
        handleAuthFailure(error, 'Failed to bridge this account to the fediverse.');
      }
      return { ok: false, newlyBridged: false };
    } finally {
      setBridgingMappingId((previous) => (previous === mapping.id ? null : previous));
    }
  };

  const handleBridgeToFediverse = async (mapping: AccountMapping) => {
    const outcome = await bridgeMappingToFediverse(mapping, {
      confirm: true,
      showNoticeOnResult: true,
    });
    if (outcome.ok && outcome.newlyBridged) {
      await fetchRecentActivity();
    }
  };

  const handleBridgeAllEligible = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isSyncAllProfilesBusy || isPullBioAllBusy || Boolean(syncingProfileMappingId) || Boolean(pullingBioMappingId)) {
      showNotice('info', 'Profile/bio sync is currently running. Please wait before bridge-all.');
      return;
    }

    const manageable =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (manageable.length === 0) {
      showNotice('info', 'No accounts available for fediverse bridge.');
      return;
    }

    const refreshedStatuses = await fetchFediverseBridgeStatuses(manageable, { force: true });
    const refreshedProfiles = await fetchProfiles(manageable.map((mapping) => mapping.bskyIdentifier));
    const statusLookup = {
      ...fediverseBridgeStatusByMappingId,
      ...(refreshedStatuses || {}),
    };
    const profileLookup = {
      ...profilesByActor,
      ...(refreshedProfiles || {}),
    };

    const alreadyBridged = manageable.filter((mapping) => statusLookup[mapping.id]?.bridged === true);
    const unknownStatusMappings = manageable.filter((mapping) => {
      const status = statusLookup[mapping.id];
      return !status || Boolean(status.error);
    });
    const eligible = manageable.filter((mapping) => {
      const status = statusLookup[mapping.id];
      if (!status || status.error) {
        return false;
      }
      if (status.bridged === true) {
        return false;
      }
      const profile = profileLookup[normalizeTwitterUsername(mapping.bskyIdentifier)];
      return canBridgeToFediverse(profile?.createdAt);
    });

    if (eligible.length === 0) {
      showNotice(
        'info',
        alreadyBridged.length > 0
          ? 'No new accounts to bridge. Eligible accounts are already bridged.'
          : unknownStatusMappings.length > 0
            ? `Could not verify bridge status for ${unknownStatusMappings.length} account(s). Try again in a few seconds.`
            : 'No eligible unbridged accounts found (accounts must be at least 7 days old).',
      );
      return;
    }

    const confirmed = window.confirm(
      `Bridge ${eligible.length} eligible unbridged account(s) now? This follows @ap.brid.gy and posts the bridge announcement for each account.`,
    );
    if (!confirmed) {
      return;
    }

    setIsBridgeAllBusy(true);
    setBridgeAllProgress({
      currentHandle: '',
      completed: 0,
      total: eligible.length,
    });
    const newlyBridgedLabels: string[] = [];
    let failedCount = 0;

    try {
      for (let index = 0; index < eligible.length; index += 1) {
        const mapping = eligible[index];
        setBridgeAllProgress({
          currentHandle: `@${mapping.bskyIdentifier}`,
          completed: index,
          total: eligible.length,
        });

        const outcome = await bridgeMappingToFediverse(mapping, {
          confirm: false,
          showNoticeOnResult: false,
        });
        if (outcome.ok && outcome.newlyBridged) {
          newlyBridgedLabels.push(`@${mapping.bskyIdentifier}`);
        } else {
          failedCount += 1;
        }

        setBridgeAllProgress({
          currentHandle: `@${mapping.bskyIdentifier}`,
          completed: index + 1,
          total: eligible.length,
        });
      }

      if (newlyBridgedLabels.length > 0) {
        await fetchRecentActivity();
      }

      const preview = newlyBridgedLabels.slice(0, 6).join(', ');
      const more = newlyBridgedLabels.length > 6 ? ` +${newlyBridgedLabels.length - 6} more` : '';
      const summary =
        newlyBridgedLabels.length > 0
          ? `Newly bridged (${newlyBridgedLabels.length}): ${preview}${more}.`
          : 'No new accounts were bridged.';

      showNotice(
        failedCount > 0 ? 'info' : 'success',
        `${summary} Already bridged: ${alreadyBridged.length}. Unknown status: ${unknownStatusMappings.length}. Failed: ${failedCount}.`,
      );
    } finally {
      setIsBridgeAllBusy(false);
      setBridgeAllProgress(null);
    }
  };

  return {
    isBackfillQueued,
    getBackfillEntry,
    isBackfillActive,
    runNow,
    clearAllBackfills,
    recheckAccount,
    cancelQueuedBackfill,
    requestBackfill,
    requestPinSync,
    handleDeleteAllPosts,
    handleDeleteMapping,
    resolveProfileSyncSource,
    syncProfileFromTwitterForMapping,
    handleSyncProfileFromTwitter,
    pullTwitterBioForMapping,
    handlePullTwitterBio,
    resolveBulkAccountTargets,
    handleSyncAllProfilesFromTwitter,
    handlePullTwitterBioForAccounts,
    handleAddBotLabelToAllAccounts,
    handleAppendBotNameToAllAccounts,
    handleSyncPinsForAccounts,
    handleApplyAllAccountsAction,
    handleUpdateProfileSyncSource,
    bridgeMappingToFediverse,
    handleBridgeToFediverse,
    handleBridgeAllEligible,
  };
}
