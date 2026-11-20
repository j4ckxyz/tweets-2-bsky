import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { pickMirrorSettings } from '../components/MirrorSettingsFields';
import { DEFAULT_GROUP_KEY, defaultMappingForm } from '../lib/constants';
import { addTwitterUsernames, getUserLabel, normalizeTwitterUsername } from '../lib/format';
import type {
  AccountMapping,
  BlueskyCredentialValidation,
  MappingFormState,
  MirrorProfileSyncResult,
  TwitterMirrorProfile,
} from '../lib/types';
import type { useAuthForms } from './useAuthForms';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useGroups } from './useGroups';
import type { useNotice } from './useNotice';

// The add-account sheet: step state, mirror preview, credential check and submit.
export function useAddAccount(
  deps: Pick<
    ReturnType<typeof useDashboardState> &
      ReturnType<typeof useNotice> &
      ReturnType<typeof useAuthSession> &
      ReturnType<typeof useDashboardData> &
      ReturnType<typeof useAuthForms> &
      ReturnType<typeof useGroups>,
    | 'addAccountStep'
    | 'authHeaders'
    | 'canCreateMappings'
    | 'fetchData'
    | 'groupOptionsByKey'
    | 'handleAuthFailure'
    | 'isAddAccountSheetOpen'
    | 'me'
    | 'newTwitterMirrorProfiles'
    | 'newTwitterUsers'
    | 'selectedMirrorSourceUsername'
    | 'setAddAccountStep'
    | 'setIsAddAccountSheetOpen'
    | 'setIsBusy'
    | 'setIsCredentialValidationBusy'
    | 'setIsMirrorPreviewLoading'
    | 'setNewTwitterMirrorProfiles'
    | 'setNewTwitterUsers'
    | 'setSelectedMirrorSourceUsername'
    | 'setValidatedBskyCredentials'
    | 'showNotice'
    | 'validatedBskyCredentials'
  >,
) {
  const {
    addAccountStep,
    authHeaders,
    canCreateMappings,
    fetchData,
    groupOptionsByKey,
    handleAuthFailure,
    isAddAccountSheetOpen,
    me,
    newTwitterMirrorProfiles,
    newTwitterUsers,
    selectedMirrorSourceUsername,
    setAddAccountStep,
    setIsAddAccountSheetOpen,
    setIsBusy,
    setIsCredentialValidationBusy,
    setIsMirrorPreviewLoading,
    setNewTwitterMirrorProfiles,
    setNewTwitterUsers,
    setSelectedMirrorSourceUsername,
    setValidatedBskyCredentials,
    showNotice,
    validatedBskyCredentials,
  } = deps;

  const [newMapping, setNewMapping] = useState<MappingFormState>(defaultMappingForm);
  const [newTwitterInput, setNewTwitterInput] = useState('');

  useEffect(() => {
    if (!isAddAccountSheetOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAddAccountSheet();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isAddAccountSheetOpen]);

  useEffect(() => {
    if (newTwitterUsers.length === 0) {
      setSelectedMirrorSourceUsername('');
      return;
    }

    const normalizedSelected = normalizeTwitterUsername(selectedMirrorSourceUsername);
    const hasSelected = newTwitterUsers.some((username) => normalizeTwitterUsername(username) === normalizedSelected);
    if (!hasSelected) {
      setSelectedMirrorSourceUsername(newTwitterUsers[0] || '');
    }
  }, [newTwitterUsers, selectedMirrorSourceUsername, setSelectedMirrorSourceUsername]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately re-runs when any credential field changes to invalidate the previous validation
  useEffect(() => {
    setValidatedBskyCredentials(null);
  }, [newMapping.bskyIdentifier, newMapping.bskyPassword, newMapping.bskyServiceUrl]);
  const selectedMirrorPreview = selectedMirrorSourceUsername
    ? newTwitterMirrorProfiles[normalizeTwitterUsername(selectedMirrorSourceUsername)]
    : undefined;

  const addNewTwitterUsername = () => {
    setNewTwitterUsers((previous) => addTwitterUsernames(previous, newTwitterInput));
    setNewTwitterInput('');
  };

  const removeNewTwitterUsername = (username: string) => {
    setNewTwitterUsers((previous) =>
      previous.filter((existing) => normalizeTwitterUsername(existing) !== normalizeTwitterUsername(username)),
    );
  };

  const resetAddAccountDraft = () => {
    setNewMapping({
      ...defaultMappingForm(),
      owner: getUserLabel(me),
    });
    setNewTwitterUsers([]);
    setNewTwitterInput('');
    setNewTwitterMirrorProfiles({});
    setSelectedMirrorSourceUsername('');
    setValidatedBskyCredentials(null);
    setIsMirrorPreviewLoading(false);
    setIsCredentialValidationBusy(false);
    setAddAccountStep(1);
  };

  const openAddAccountSheet = () => {
    if (!canCreateMappings) {
      showNotice('error', 'You do not have permission to add mappings.');
      return;
    }
    resetAddAccountDraft();
    setIsAddAccountSheetOpen(true);
  };

  const closeAddAccountSheet = () => {
    setIsAddAccountSheetOpen(false);
    resetAddAccountDraft();
  };

  const applyGroupPresetToNewMapping = (groupKey: string) => {
    const group = groupOptionsByKey.get(groupKey);
    if (!group || group.key === DEFAULT_GROUP_KEY) {
      return;
    }
    setNewMapping((previous) => ({
      ...previous,
      groupName: group.name,
      groupEmoji: group.emoji,
    }));
  };

  const ensureTwitterMirrorProfileLoaded = useCallback(
    async (twitterUsername: string): Promise<TwitterMirrorProfile | null> => {
      if (!authHeaders) {
        return null;
      }

      const normalized = normalizeTwitterUsername(twitterUsername);
      if (!normalized) {
        return null;
      }

      const cached = newTwitterMirrorProfiles[normalized];
      if (cached) {
        return cached;
      }

      setIsMirrorPreviewLoading(true);
      try {
        const response = await axios.post<TwitterMirrorProfile>(
          '/api/onboarding/twitter-profile',
          { twitterUsername: normalized },
          { headers: authHeaders },
        );
        setNewTwitterMirrorProfiles((previous) => ({
          ...previous,
          [normalized]: response.data,
        }));
        return response.data;
      } catch (error) {
        handleAuthFailure(error, 'Failed to fetch Twitter profile metadata.');
        return null;
      } finally {
        setIsMirrorPreviewLoading(false);
      }
    },
    [authHeaders, handleAuthFailure, newTwitterMirrorProfiles, setIsMirrorPreviewLoading, setNewTwitterMirrorProfiles],
  );

  const validateAddAccountCredentials = useCallback(async (): Promise<BlueskyCredentialValidation | null> => {
    if (!authHeaders) {
      return null;
    }

    const bskyIdentifier = newMapping.bskyIdentifier.trim();
    const bskyPassword = newMapping.bskyPassword.trim();
    const bskyServiceUrl = newMapping.bskyServiceUrl.trim();

    if (!bskyIdentifier || !bskyPassword) {
      showNotice('error', 'Bluesky identifier and app password are required.');
      return null;
    }

    setIsCredentialValidationBusy(true);
    try {
      const response = await axios.post<BlueskyCredentialValidation>(
        '/api/onboarding/bsky-credentials',
        {
          bskyIdentifier,
          bskyPassword,
          bskyServiceUrl,
        },
        { headers: authHeaders },
      );
      setValidatedBskyCredentials(response.data);
      return response.data;
    } catch (error) {
      setValidatedBskyCredentials(null);
      handleAuthFailure(error, 'Failed to validate Bluesky credentials.');
      return null;
    } finally {
      setIsCredentialValidationBusy(false);
    }
  }, [
    authHeaders,
    handleAuthFailure,
    newMapping.bskyIdentifier,
    newMapping.bskyPassword,
    newMapping.bskyServiceUrl,
    showNotice,
    setIsCredentialValidationBusy,
    setValidatedBskyCredentials,
  ]);

  useEffect(() => {
    if (!isAddAccountSheetOpen || addAccountStep !== 1) {
      return;
    }

    if (!selectedMirrorSourceUsername) {
      return;
    }

    void ensureTwitterMirrorProfileLoaded(selectedMirrorSourceUsername);
  }, [addAccountStep, ensureTwitterMirrorProfileLoaded, isAddAccountSheetOpen, selectedMirrorSourceUsername]);

  const submitNewMapping = async () => {
    if (!authHeaders) {
      return;
    }
    if (!canCreateMappings) {
      showNotice('error', 'You do not have permission to add mappings.');
      return;
    }

    if (newTwitterUsers.length === 0) {
      showNotice('error', 'Add at least one Twitter username.');
      return;
    }

    const sourceTwitterUsername = normalizeTwitterUsername(selectedMirrorSourceUsername || newTwitterUsers[0] || '');
    if (!sourceTwitterUsername) {
      showNotice('error', 'Select a Twitter source for profile mirroring.');
      return;
    }

    const mirrorPreview = await ensureTwitterMirrorProfileLoaded(sourceTwitterUsername);
    if (!mirrorPreview) {
      showNotice('error', 'Fetch Twitter metadata before creating this mapping.');
      return;
    }

    if (!(validatedBskyCredentials || (await validateAddAccountCredentials()))) {
      showNotice('error', 'Validate Bluesky credentials before creating this mapping.');
      return;
    }

    setIsBusy(true);

    try {
      const createResponse = await axios.post<AccountMapping>(
        '/api/mappings',
        {
          owner: newMapping.owner.trim(),
          twitterUsernames: newTwitterUsers,
          bskyIdentifier: newMapping.bskyIdentifier.trim(),
          bskyPassword: newMapping.bskyPassword,
          bskyServiceUrl: newMapping.bskyServiceUrl.trim(),
          groupName: newMapping.groupName.trim(),
          groupEmoji: newMapping.groupEmoji.trim(),
          profileSyncSourceUsername: sourceTwitterUsername,
          startFrom: newMapping.startFrom,
          ...pickMirrorSettings(newMapping),
        },
        { headers: authHeaders },
      );

      const syncResponse = await axios.post<MirrorProfileSyncResult>(
        `/api/mappings/${createResponse.data.id}/sync-profile-from-twitter`,
        {
          sourceTwitterUsername,
        },
        { headers: authHeaders },
      );

      const warnings = syncResponse.data.warnings || [];
      const botLabelApplied = createResponse.data.hasBotLabel === true;

      setNewMapping(defaultMappingForm());
      setNewTwitterUsers([]);
      setNewTwitterInput('');
      setNewTwitterMirrorProfiles({});
      setSelectedMirrorSourceUsername('');
      setValidatedBskyCredentials(null);
      setIsAddAccountSheetOpen(false);
      setAddAccountStep(1);
      if (warnings.length > 0) {
        showNotice(
          'info',
          `Account mapping added. Profile mirrored with ${warnings.length} warning(s).${
            botLabelApplied
              ? ''
              : ' Bot label was not applied automatically; use the bulk bot-label button in Accounts.'
          }`,
        );
      } else {
        showNotice(
          botLabelApplied ? 'success' : 'info',
          `Account mapping added and Bluesky profile mirrored from Twitter.${
            botLabelApplied
              ? ''
              : ' Bot label was not applied automatically; use the bulk bot-label button in Accounts.'
          }`,
        );
      }
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to add account mapping.');
    } finally {
      setIsBusy(false);
    }
  };

  const advanceAddAccountStep = () => {
    if (addAccountStep === 1) {
      if (newTwitterUsers.length === 0) {
        showNotice('error', 'Add at least one Twitter username.');
        return;
      }

      const sourceTwitterUsername = normalizeTwitterUsername(selectedMirrorSourceUsername || newTwitterUsers[0] || '');
      if (!sourceTwitterUsername) {
        showNotice('error', 'Select a Twitter source for profile mirroring.');
        return;
      }

      setIsMirrorPreviewLoading(true);
      void ensureTwitterMirrorProfileLoaded(sourceTwitterUsername)
        .then((profile) => {
          if (!profile) {
            return;
          }
          setAddAccountStep(2);
        })
        .finally(() => {
          setIsMirrorPreviewLoading(false);
        });
      return;
    }

    if (addAccountStep === 2) {
      setAddAccountStep(3);
      return;
    }

    if (addAccountStep === 3) {
      if (!newMapping.bskyIdentifier.trim() || !newMapping.bskyPassword.trim()) {
        showNotice('error', 'Bluesky identifier and app password are required.');
        return;
      }

      setIsCredentialValidationBusy(true);
      void validateAddAccountCredentials()
        .then((validation) => {
          if (!validation) {
            return;
          }
          setAddAccountStep(4);
        })
        .finally(() => {
          setIsCredentialValidationBusy(false);
        });
    }
  };

  const retreatAddAccountStep = () => {
    setAddAccountStep((previous) => Math.max(1, previous - 1));
  };

  return {
    newMapping,
    setNewMapping,
    newTwitterInput,
    setNewTwitterInput,
    selectedMirrorPreview,
    addNewTwitterUsername,
    removeNewTwitterUsername,
    resetAddAccountDraft,
    openAddAccountSheet,
    closeAddAccountSheet,
    applyGroupPresetToNewMapping,
    ensureTwitterMirrorProfileLoaded,
    validateAddAccountCredentials,
    submitNewMapping,
    advanceAddAccountStep,
    retreatAddAccountStep,
  };
}
