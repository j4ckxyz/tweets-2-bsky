import { useEffect, useState } from 'react';
import { pickMirrorSettings } from '../components/MirrorSettingsFields';
import * as api from '../lib/api';
import { defaultMappingForm, mirrorSettingsFromMapping } from '../lib/constants';
import { addTwitterUsernames, normalizeTwitterUsername } from '../lib/format';
import type { AccountMapping, MappingFormState } from '../lib/types';
import type { useAccountActions } from './useAccountActions';
import type { useAccountsList } from './useAccountsList';
import type { useActivity } from './useActivity';
import type { useAddAccount } from './useAddAccount';
import type { useAuthForms } from './useAuthForms';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useGroups } from './useGroups';
import type { useNotice } from './useNotice';
import type { usePosts } from './usePosts';
import type { useRouting } from './useRouting';
import type { useTheme } from './useTheme';

// The edit-account dialog form and save.
export function useEditMapping(
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
      ReturnType<typeof useActivity> &
      ReturnType<typeof useAccountActions> &
      ReturnType<typeof useAddAccount>,
    | 'authHeaders'
    | 'canManageMapping'
    | 'editTwitterUsers'
    | 'editingMapping'
    | 'fetchData'
    | 'handleAuthFailure'
    | 'setEditTwitterUsers'
    | 'setEditingMapping'
    | 'setIsBusy'
    | 'showNotice'
  >,
) {
  const {
    authHeaders,
    canManageMapping,
    editTwitterUsers,
    editingMapping,
    fetchData,
    handleAuthFailure,
    setEditTwitterUsers,
    setEditingMapping,
    setIsBusy,
    showNotice,
  } = deps;

  const [editForm, setEditForm] = useState<MappingFormState>(defaultMappingForm);
  const [editTwitterInput, setEditTwitterInput] = useState('');

  useEffect(() => {
    if (!editingMapping) {
      return;
    }

    const candidates = [
      ...new Set(editTwitterUsers.map(normalizeTwitterUsername).filter((username) => username.length > 0)),
    ];
    const selected = normalizeTwitterUsername(editForm.profileSyncSourceUsername || '');
    if (candidates.length === 0) {
      if (editForm.profileSyncSourceUsername !== '') {
        setEditForm((previous) => ({ ...previous, profileSyncSourceUsername: '' }));
      }
      return;
    }

    if (candidates.includes(selected)) {
      return;
    }

    const next = candidates[0] || '';
    if (editForm.profileSyncSourceUsername !== next) {
      setEditForm((previous) => ({ ...previous, profileSyncSourceUsername: next }));
    }
  }, [editForm.profileSyncSourceUsername, editTwitterUsers, editingMapping]);

  const addEditTwitterUsername = () => {
    setEditTwitterUsers((previous) => addTwitterUsernames(previous, editTwitterInput));
    setEditTwitterInput('');
  };

  const removeEditTwitterUsername = (username: string) => {
    setEditTwitterUsers((previous) =>
      previous.filter((existing) => normalizeTwitterUsername(existing) !== normalizeTwitterUsername(username)),
    );
  };

  const startEditMapping = (mapping: AccountMapping) => {
    if (!canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to edit this mapping.');
      return;
    }
    setEditingMapping(mapping);
    setEditForm({
      owner: mapping.owner || '',
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: '',
      bskyServiceUrl: mapping.bskyServiceUrl || 'https://bsky.social',
      groupName: mapping.groupName || '',
      groupEmoji: mapping.groupEmoji || '📁',
      profileSyncSourceUsername: mapping.profileSyncSourceUsername || mapping.twitterUsernames[0] || '',
      startFrom: 'recent',
      ...mirrorSettingsFromMapping(mapping),
    });
    setEditTwitterUsers(mapping.twitterUsernames);
    setEditTwitterInput('');
  };

  const handleUpdateMapping = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders || !editingMapping) {
      return;
    }
    if (!canManageMapping(editingMapping)) {
      showNotice('error', 'You do not have permission to edit this mapping.');
      return;
    }

    if (editTwitterUsers.length === 0) {
      showNotice('error', 'At least one Twitter username is required.');
      return;
    }

    const normalizedProfileSyncSource = normalizeTwitterUsername(editForm.profileSyncSourceUsername || '');
    const hasSourceInMapping = editTwitterUsers.some(
      (username) => normalizeTwitterUsername(username) === normalizedProfileSyncSource,
    );
    const profileSyncSourceUsername = hasSourceInMapping
      ? normalizedProfileSyncSource
      : normalizeTwitterUsername(editTwitterUsers[0] || '');

    setIsBusy(true);

    try {
      await api.updateMapping(
        editingMapping.id,
        {
          owner: editForm.owner.trim(),
          twitterUsernames: editTwitterUsers,
          bskyIdentifier: editForm.bskyIdentifier.trim(),
          bskyPassword: editForm.bskyPassword,
          bskyServiceUrl: editForm.bskyServiceUrl.trim(),
          groupName: editForm.groupName.trim(),
          groupEmoji: editForm.groupEmoji.trim(),
          profileSyncSourceUsername,
          ...pickMirrorSettings(editForm),
        },
        { headers: authHeaders },
      );

      setEditingMapping(null);
      setEditForm(defaultMappingForm());
      setEditTwitterUsers([]);
      setEditTwitterInput('');
      showNotice('success', 'Mapping updated.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to update mapping.');
    } finally {
      setIsBusy(false);
    }
  };

  return {
    editForm,
    setEditForm,
    editTwitterInput,
    setEditTwitterInput,
    addEditTwitterUsername,
    removeEditTwitterUsername,
    startEditMapping,
    handleUpdateMapping,
  };
}
