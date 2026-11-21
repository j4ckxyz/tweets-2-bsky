import { useEffect, useMemo } from 'react';
import * as api from '../lib/api';
import { DEFAULT_GROUP_EMOJI, DEFAULT_GROUP_KEY, DEFAULT_GROUP_NAME } from '../lib/constants';
import { getGroupKey, getGroupMeta, getMappingGroupMeta } from '../lib/format';
import type { AccountMapping } from '../lib/types';
import type { useAuthForms } from './useAuthForms';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useNotice } from './useNotice';
import type { useRouting } from './useRouting';
import type { useTheme } from './useTheme';

// Folders: options, drafts and create/rename/delete/assign actions.
export function useGroups(
  deps: Pick<
    ReturnType<typeof useDashboardState> &
      ReturnType<typeof useTheme> &
      ReturnType<typeof useNotice> &
      ReturnType<typeof useAuthSession> &
      ReturnType<typeof useRouting> &
      ReturnType<typeof useDashboardData> &
      ReturnType<typeof useAuthForms>,
    | 'authHeaders'
    | 'canManageGroupsPermission'
    | 'canManageMapping'
    | 'fetchData'
    | 'fetchGroups'
    | 'groupDraftsByKey'
    | 'groups'
    | 'handleAuthFailure'
    | 'mappings'
    | 'newGroupEmoji'
    | 'newGroupName'
    | 'setGroupDraftsByKey'
    | 'setGroups'
    | 'setIsBusy'
    | 'setIsGroupActionBusy'
    | 'setMappings'
    | 'setNewGroupEmoji'
    | 'setNewGroupName'
    | 'showNotice'
  >,
) {
  const {
    authHeaders,
    canManageGroupsPermission,
    canManageMapping,
    fetchData,
    fetchGroups,
    groupDraftsByKey,
    groups,
    handleAuthFailure,
    mappings,
    newGroupEmoji,
    newGroupName,
    setGroupDraftsByKey,
    setGroups,
    setIsBusy,
    setIsGroupActionBusy,
    setMappings,
    setNewGroupEmoji,
    setNewGroupName,
    showNotice,
  } = deps;

  const groupOptions = useMemo(() => {
    const options = new Map<string, { key: string; name: string; emoji: string }>();
    for (const group of groups) {
      const meta = getGroupMeta(group.name, group.emoji);
      if (meta.key === DEFAULT_GROUP_KEY) {
        continue;
      }
      options.set(meta.key, meta);
    }
    for (const mapping of mappings) {
      const group = getMappingGroupMeta(mapping);
      options.set(group.key, options.get(group.key) || group);
    }
    return [...options.values()].sort((a, b) => {
      const aUngrouped = a.name === DEFAULT_GROUP_NAME;
      const bUngrouped = b.name === DEFAULT_GROUP_NAME;
      if (aUngrouped && !bUngrouped) return 1;
      if (!aUngrouped && bUngrouped) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [groups, mappings]);
  const groupOptionsByKey = useMemo(() => new Map(groupOptions.map((group) => [group.key, group])), [groupOptions]);
  const reusableGroupOptions = useMemo(
    () => groupOptions.filter((group) => group.key !== DEFAULT_GROUP_KEY),
    [groupOptions],
  );

  useEffect(() => {
    setGroupDraftsByKey((previous) => {
      const next: Record<string, { name: string; emoji: string }> = {};
      for (const group of reusableGroupOptions) {
        const existing = previous[group.key];
        next[group.key] = {
          name: existing?.name ?? group.name,
          emoji: existing?.emoji ?? group.emoji,
        };
      }
      return next;
    });
  }, [reusableGroupOptions, setGroupDraftsByKey]);

  const handleCreateGroup = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }
    if (!canManageGroupsPermission) {
      showNotice('error', 'You do not have permission to create groups.');
      return;
    }

    const name = newGroupName.trim();
    const emoji = newGroupEmoji.trim() || DEFAULT_GROUP_EMOJI;
    if (!name) {
      showNotice('error', 'Enter a group name first.');
      return;
    }

    setIsBusy(true);
    try {
      await api.createGroup({ name, emoji }, { headers: authHeaders });
      setNewGroupName('');
      setNewGroupEmoji(DEFAULT_GROUP_EMOJI);
      await fetchGroups();
      showNotice('success', `Group "${name}" created.`);
    } catch (error) {
      handleAuthFailure(error, 'Failed to create group.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleAssignMappingGroup = async (mapping: AccountMapping, groupKey: string) => {
    if (!authHeaders) {
      return;
    }
    if (!canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to update this mapping.');
      return;
    }

    const selectedGroup = groupOptionsByKey.get(groupKey);
    const nextGroupName = selectedGroup?.name || '';
    const nextGroupEmoji = selectedGroup?.emoji || '';

    try {
      await api.updateMapping(
        mapping.id,
        {
          groupName: nextGroupName,
          groupEmoji: nextGroupEmoji,
        },
        { headers: authHeaders },
      );

      setMappings((previous) =>
        previous.map((entry) =>
          entry.id === mapping.id
            ? {
                ...entry,
                groupName: nextGroupName || undefined,
                groupEmoji: nextGroupEmoji || undefined,
              }
            : entry,
        ),
      );

      if (nextGroupName) {
        setGroups((previous) => {
          const key = getGroupKey(nextGroupName);
          if (previous.some((group) => getGroupKey(group.name) === key)) {
            return previous;
          }
          return [...previous, { name: nextGroupName, ...(nextGroupEmoji ? { emoji: nextGroupEmoji } : {}) }];
        });
      }
    } catch (error) {
      handleAuthFailure(error, 'Failed to move account to folder.');
    }
  };

  const updateGroupDraft = (groupKey: string, field: 'name' | 'emoji', value: string) => {
    setGroupDraftsByKey((previous) => ({
      ...previous,
      [groupKey]: {
        name: previous[groupKey]?.name ?? '',
        emoji: previous[groupKey]?.emoji ?? '',
        [field]: value,
      },
    }));
  };

  // Resolves true once the rename is saved, so the folder view can follow it.
  const handleRenameGroup = async (groupKey: string): Promise<boolean> => {
    if (!authHeaders) {
      return false;
    }
    if (!canManageGroupsPermission) {
      showNotice('error', 'You do not have permission to rename groups.');
      return false;
    }

    const draft = groupDraftsByKey[groupKey];
    if (!draft || !draft.name.trim()) {
      showNotice('error', 'Group name is required.');
      return false;
    }

    setIsGroupActionBusy(true);
    try {
      await api.updateGroup(
        groupKey,
        {
          name: draft.name.trim(),
          emoji: draft.emoji.trim(),
        },
        { headers: authHeaders },
      );
      showNotice('success', 'Group updated.');
      await fetchData();
      return true;
    } catch (error) {
      handleAuthFailure(error, 'Failed to update group.');
      return false;
    } finally {
      setIsGroupActionBusy(false);
    }
  };

  const handleDeleteGroup = async (groupKey: string) => {
    if (!authHeaders) {
      return;
    }
    if (!canManageGroupsPermission) {
      showNotice('error', 'You do not have permission to delete groups.');
      return;
    }

    const group = groupOptionsByKey.get(groupKey);
    if (!group) {
      showNotice('error', 'Group not found.');
      return;
    }

    const confirmed = window.confirm(
      `Delete "${group.name}"? Mappings in this folder will move to ${DEFAULT_GROUP_NAME}.`,
    );
    if (!confirmed) {
      return;
    }

    setIsGroupActionBusy(true);
    try {
      const response = await api.deleteGroup(groupKey, {
        headers: authHeaders,
      });
      const reassignedCount = response.data?.reassignedCount || 0;
      showNotice('success', `Group deleted. ${reassignedCount} account${reassignedCount === 1 ? '' : 's'} moved.`);
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to delete group.');
    } finally {
      setIsGroupActionBusy(false);
    }
  };

  return {
    groupOptions,
    groupOptionsByKey,
    reusableGroupOptions,
    handleCreateGroup,
    handleAssignMappingGroup,
    updateGroupDraft,
    handleRenameGroup,
    handleDeleteGroup,
  };
}
