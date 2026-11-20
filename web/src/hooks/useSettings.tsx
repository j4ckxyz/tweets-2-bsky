import { Bot, Download, Settings2, SunMoon, UserRound, Users } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '../components/ui/badge';
import * as api from '../lib/api';
import { normalizePermissions } from '../lib/format';
import type { SettingsSection } from '../lib/types';
import { cn } from '../lib/utils';
import type { useAccountActions } from './useAccountActions';
import type { useAccountsList } from './useAccountsList';
import type { useActivity } from './useActivity';
import type { useAddAccount } from './useAddAccount';
import type { useAuthForms } from './useAuthForms';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useEditMapping } from './useEditMapping';
import type { useGroups } from './useGroups';
import type { useNotice } from './useNotice';
import type { usePosts } from './usePosts';
import type { useRouting } from './useRouting';
import type { useTheme } from './useTheme';

// Settings tab: section nav, X/AI config, import/export, updates and own email/password.
export function useSettings(
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
      ReturnType<typeof useAddAccount> &
      ReturnType<typeof useEditMapping>,
    | 'aiConfig'
    | 'authHeaders'
    | 'emailForm'
    | 'fetchData'
    | 'fetchRuntimeVersion'
    | 'fetchUpdateStatus'
    | 'handleAuthFailure'
    | 'hasCurrentEmail'
    | 'isAdmin'
    | 'passwordForm'
    | 'setEmailForm'
    | 'setIsBusy'
    | 'setIsUpdateBusy'
    | 'setMe'
    | 'setPasswordForm'
    | 'setToken'
    | 'showNotice'
    | 'twitterConfig'
  >,
) {
  const {
    aiConfig,
    authHeaders,
    emailForm,
    fetchData,
    fetchRuntimeVersion,
    fetchUpdateStatus,
    handleAuthFailure,
    hasCurrentEmail,
    isAdmin,
    passwordForm,
    setEmailForm,
    setIsBusy,
    setIsUpdateBusy,
    setMe,
    setPasswordForm,
    setToken,
    showNotice,
    twitterConfig,
  } = deps;

  const twitterConfigured = Boolean(twitterConfig.authToken && twitterConfig.ct0);
  const aiConfigured = Boolean(aiConfig.apiKey);
  const settingsNavItems = useMemo(
    () => [
      { id: 'account' as SettingsSection, label: 'Account', icon: UserRound },
      ...(isAdmin
        ? [
            { id: 'system' as SettingsSection, label: 'System', icon: Settings2 },
            { id: 'users' as SettingsSection, label: 'Users', icon: Users },
            {
              id: 'twitter' as SettingsSection,
              label: 'Twitter',
              icon: Bot,
              badge: (
                <Badge variant="outline" className={cn('ml-auto', twitterConfigured && 'text-foreground')}>
                  {twitterConfigured ? 'On' : 'Off'}
                </Badge>
              ),
            },
            {
              id: 'ai' as SettingsSection,
              label: 'AI',
              icon: SunMoon,
              badge: (
                <Badge variant="outline" className={cn('ml-auto', aiConfigured && 'text-foreground')}>
                  {aiConfigured ? 'On' : 'Off'}
                </Badge>
              ),
            },
            { id: 'data' as SettingsSection, label: 'Data', icon: Download },
          ]
        : []),
    ],
    [aiConfigured, isAdmin, twitterConfigured],
  );

  const handleSaveTwitterConfig = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }

    setIsBusy(true);

    try {
      await api.saveTwitterConfig(
        {
          authToken: twitterConfig.authToken,
          ct0: twitterConfig.ct0,
          backupAuthToken: twitterConfig.backupAuthToken,
          backupCt0: twitterConfig.backupCt0,
        },
        { headers: authHeaders },
      );
      showNotice('success', 'Twitter credentials saved.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to save Twitter credentials.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveAiConfig = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }

    setIsBusy(true);

    try {
      await api.saveAiConfig(
        {
          provider: aiConfig.provider,
          apiKey: aiConfig.apiKey,
          model: aiConfig.model,
          baseUrl: aiConfig.baseUrl,
        },
        { headers: authHeaders },
      );
      showNotice('success', 'AI settings saved.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to save AI settings.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleExportConfig = async () => {
    if (!authHeaders) {
      return;
    }

    try {
      const response = await api.exportConfig({
        headers: authHeaders,
        responseType: 'blob',
      });

      const blobUrl = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `tweets-2-bsky-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(blobUrl);
      showNotice('success', 'Configuration exported.');
    } catch (error) {
      handleAuthFailure(error, 'Failed to export configuration.');
    }
  };

  const handleImportConfig = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!authHeaders) {
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const confirmed = window.confirm(
      'This will overwrite accounts/settings (except user logins). Continue with import?',
    );

    if (!confirmed) {
      event.target.value = '';
      return;
    }

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      await api.importConfig(json, { headers: authHeaders });
      showNotice('success', 'Configuration imported.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to import configuration.');
    } finally {
      event.target.value = '';
    }
  };

  const handleRunUpdate = async () => {
    if (!authHeaders || !isAdmin) {
      return;
    }

    const confirmed = window.confirm(
      'Run ./update.sh now? The service may restart automatically after update completes.',
    );
    if (!confirmed) {
      return;
    }

    setIsUpdateBusy(true);
    try {
      const response = await api.runUpdate({}, { headers: authHeaders });
      showNotice('info', response.data?.message || 'Update started. Service may restart soon.');
      await Promise.all([fetchRuntimeVersion(), fetchUpdateStatus()]);
    } catch (error) {
      handleAuthFailure(error, 'Failed to start update.');
    } finally {
      setIsUpdateBusy(false);
    }
  };

  const handleChangeOwnEmail = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }

    if (!emailForm.newEmail.trim() || !emailForm.password || (hasCurrentEmail && !emailForm.currentEmail.trim())) {
      showNotice(
        'error',
        hasCurrentEmail ? 'Fill in current email, new email, and password.' : 'Fill in new email and password.',
      );
      return;
    }

    setIsBusy(true);
    try {
      const response = await api.changeOwnEmail(
        {
          currentEmail: emailForm.currentEmail,
          newEmail: emailForm.newEmail,
          password: emailForm.password,
        },
        { headers: authHeaders },
      );

      if (response.data?.token) {
        localStorage.setItem('token', response.data.token);
        setToken(response.data.token);
      }
      if (response.data?.me) {
        setMe({
          ...response.data.me,
          permissions: normalizePermissions(response.data.me.permissions),
        });
      }
      setEmailForm((previous) => ({
        currentEmail: previous.newEmail,
        newEmail: '',
        password: '',
      }));
      showNotice('success', 'Email updated.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to update email.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleChangeOwnPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }

    if (!passwordForm.currentPassword || !passwordForm.newPassword || !passwordForm.confirmPassword) {
      showNotice('error', 'Complete all password fields.');
      return;
    }
    if (passwordForm.newPassword.length < 8) {
      showNotice('error', 'New password must be at least 8 characters.');
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      showNotice('error', 'New password and confirmation do not match.');
      return;
    }

    setIsBusy(true);
    try {
      await api.changeOwnPassword(
        {
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        },
        { headers: authHeaders },
      );
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      showNotice('success', 'Password updated.');
    } catch (error) {
      handleAuthFailure(error, 'Failed to update password.');
    } finally {
      setIsBusy(false);
    }
  };

  return {
    twitterConfigured,
    aiConfigured,
    settingsNavItems,
    handleSaveTwitterConfig,
    handleSaveAiConfig,
    handleExportConfig,
    handleImportConfig,
    handleRunUpdate,
    handleChangeOwnEmail,
    handleChangeOwnPassword,
  };
}
