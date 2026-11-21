import * as api from '../lib/api';
import { defaultUserForm } from '../lib/constants';
import { normalizeEmail, normalizePermissions, normalizeUsername } from '../lib/format';
import type { ManagedUser } from '../lib/types';
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
import type { useSettings } from './useSettings';
import type { useTheme } from './useTheme';

// Admin user management: create, edit, reset password, delete.
export function useUserAdmin(
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
      ReturnType<typeof useEditMapping> &
      ReturnType<typeof useSettings>,
    | 'accountsCreatorFilter'
    | 'authHeaders'
    | 'editingUserForm'
    | 'fetchData'
    | 'fetchManagedUsers'
    | 'handleAuthFailure'
    | 'isAdmin'
    | 'newUserForm'
    | 'setAccountsCreatorFilter'
    | 'setEditingUserForm'
    | 'setEditingUserId'
    | 'setIsBusy'
    | 'setNewUserForm'
    | 'showNotice'
  >,
) {
  const {
    accountsCreatorFilter,
    authHeaders,
    editingUserForm,
    fetchData,
    fetchManagedUsers,
    handleAuthFailure,
    isAdmin,
    newUserForm,
    setAccountsCreatorFilter,
    setEditingUserForm,
    setEditingUserId,
    setIsBusy,
    setNewUserForm,
    showNotice,
  } = deps;

  const beginEditUser = (user: ManagedUser) => {
    setEditingUserId(user.id);
    setEditingUserForm({
      username: user.username || '',
      email: user.email || '',
      password: '',
      isAdmin: user.isAdmin,
      permissions: normalizePermissions(user.permissions),
    });
  };

  const resetEditingUser = () => {
    setEditingUserId(null);
    setEditingUserForm(defaultUserForm());
  };

  const handleCreateUser = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders || !isAdmin) {
      return;
    }

    const username = normalizeUsername(newUserForm.username);
    const email = normalizeEmail(newUserForm.email);
    if (!username && !email) {
      showNotice('error', 'Provide at least a username or email.');
      return;
    }
    if (!newUserForm.password || newUserForm.password.length < 8) {
      showNotice('error', 'Password must be at least 8 characters.');
      return;
    }

    setIsBusy(true);
    try {
      await api.createUser(
        {
          username: username || undefined,
          email: email || undefined,
          password: newUserForm.password,
          isAdmin: newUserForm.isAdmin,
          permissions: newUserForm.permissions,
        },
        { headers: authHeaders },
      );
      setNewUserForm(defaultUserForm());
      showNotice('success', 'User account created.');
      await fetchManagedUsers();
    } catch (error) {
      handleAuthFailure(error, 'Failed to create user.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveEditedUser = async (userId: string) => {
    if (!authHeaders || !isAdmin) {
      return;
    }

    const username = normalizeUsername(editingUserForm.username);
    const email = normalizeEmail(editingUserForm.email);
    if (!username && !email) {
      showNotice('error', 'Provide at least a username or email.');
      return;
    }

    setIsBusy(true);
    try {
      await api.updateUser(
        userId,
        {
          // '' clears the field; undefined would tell the server to keep it.
          username,
          email,
          isAdmin: editingUserForm.isAdmin,
          permissions: editingUserForm.permissions,
        },
        { headers: authHeaders },
      );
      showNotice('success', 'User updated.');
      resetEditingUser();
      await Promise.all([fetchManagedUsers(), fetchData()]);
    } catch (error) {
      handleAuthFailure(error, 'Failed to update user.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleResetUserPassword = async (userId: string) => {
    if (!authHeaders || !isAdmin) {
      return;
    }

    const newPassword = window.prompt('Enter a new password (min 8 chars):');
    if (!newPassword) {
      return;
    }
    if (newPassword.length < 8) {
      showNotice('error', 'Password must be at least 8 characters.');
      return;
    }

    setIsBusy(true);
    try {
      await api.resetUserPassword(
        userId,
        {
          newPassword,
        },
        { headers: authHeaders },
      );
      showNotice('success', 'Password reset.');
    } catch (error) {
      handleAuthFailure(error, 'Failed to reset password.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleDeleteUser = async (user: ManagedUser) => {
    if (!authHeaders || !isAdmin) {
      return;
    }

    const confirmed = window.confirm(
      `Delete ${user.username || user.email || user.id}? Their mapped accounts will be disabled.`,
    );
    if (!confirmed) {
      return;
    }

    setIsBusy(true);
    try {
      await api.deleteUser(user.id, { headers: authHeaders });
      showNotice('success', 'User deleted and owned mappings disabled.');
      if (accountsCreatorFilter === user.id) {
        setAccountsCreatorFilter('all');
      }
      await Promise.all([fetchManagedUsers(), fetchData()]);
    } catch (error) {
      handleAuthFailure(error, 'Failed to delete user.');
    } finally {
      setIsBusy(false);
    }
  };

  return {
    beginEditUser,
    resetEditingUser,
    handleCreateUser,
    handleSaveEditedUser,
    handleResetUserPassword,
    handleDeleteUser,
  };
}
