import { isCancelledError, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import type { SetStateAction } from 'react';
import { useCallback, useEffect, useMemo } from 'react';
import * as api from '../lib/api';
import { getApiErrorMessage, normalizePermissions } from '../lib/format';
import { setQueryErrorHandler } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import type { AccountMapping, AuthUser, UserPermissions } from '../lib/types';
import type { useDashboardState } from './useDashboardState';
import type { useNotice } from './useNotice';
import type { useTheme } from './useTheme';

// Signed-in user, permissions, login/register/logout and the bootstrap check.
export function useAuthSession(
  deps: Pick<
    ReturnType<typeof useDashboardState> & ReturnType<typeof useTheme> & ReturnType<typeof useNotice>,
    'authView' | 'resetDashboardState' | 'setAuthView' | 'setEmailForm' | 'showNotice' | 'token'
  >,
) {
  const { authView, resetDashboardState, setAuthView, setEmailForm, showNotice, token } = deps;
  const queryClient = useQueryClient();
  const authHeaders = useMemo(() => (token ? { Authorization: `Bearer ${token}` } : undefined), [token]);

  // Whether first-user registration is open; only asked while signed out.
  const bootstrapQuery = useQuery({
    queryKey: queryKeys.bootstrapStatus,
    queryFn: async () => {
      try {
        const response = await api.getBootstrapStatus();
        return Boolean(response.data?.bootstrapOpen);
      } catch {
        return false;
      }
    },
    enabled: !token,
  });
  const bootstrapOpen = bootstrapQuery.data ?? false;

  const meQuery = useQuery({
    queryKey: queryKeys.me,
    queryFn: async (): Promise<AuthUser> => {
      const response = await api.getMe({ headers: authHeaders });
      return { ...response.data, permissions: normalizePermissions(response.data.permissions) };
    },
    enabled: Boolean(authHeaders),
    meta: { errorMessage: 'Failed to load dashboard data.' },
  });
  const me = meQuery.data ?? null;
  const setMe = useCallback(
    (update: SetStateAction<AuthUser | null>) =>
      queryClient.setQueryData<AuthUser | null>(queryKeys.me, (previous) =>
        typeof update === 'function' ? update(previous ?? null) : update,
      ),
    [queryClient],
  );

  // Every successful load of the signed-in user refreshes the "current email"
  // field in Settings.
  const meEmail = meQuery.data?.email;
  const meUpdatedAt = meQuery.dataUpdatedAt;
  useEffect(() => {
    if (meUpdatedAt === 0) return;
    setEmailForm((previous) => ({ ...previous, currentEmail: meEmail || '' }));
  }, [meEmail, meUpdatedAt, setEmailForm]);

  const isAdmin = me?.isAdmin ?? false;
  const effectivePermissions = useMemo<UserPermissions>(() => normalizePermissions(me?.permissions), [me?.permissions]);
  const canManageAllMappings = isAdmin || effectivePermissions.manageAllMappings;
  const canManageOwnMappings = isAdmin || effectivePermissions.manageOwnMappings;
  const canCreateMappings = canManageAllMappings || canManageOwnMappings;
  const canManageGroupsPermission = isAdmin || effectivePermissions.manageGroups;
  const canQueueBackfillsPermission = isAdmin || effectivePermissions.queueBackfills;
  const canRunNowPermission = isAdmin || effectivePermissions.runNow;
  const hasCurrentEmail = Boolean(me?.email && me.email.trim().length > 0);

  useEffect(() => {
    const debugApiLogging = window.localStorage.getItem('debug-api') === '1';
    if (!debugApiLogging) {
      return;
    }

    const requestInterceptor = axios.interceptors.request.use((config) => {
      console.debug('[tweets-2-bsky:web] api-request', {
        method: config.method?.toUpperCase(),
        url: config.url,
        params: config.params,
        hasData: config.data !== undefined,
        timestamp: new Date().toISOString(),
      });
      return config;
    });

    const responseInterceptor = axios.interceptors.response.use(
      (response) => {
        console.debug('[tweets-2-bsky:web] api-response', {
          method: response.config.method?.toUpperCase(),
          url: response.config.url,
          status: response.status,
          timestamp: new Date().toISOString(),
        });
        return response;
      },
      (error) => {
        if (axios.isAxiosError(error)) {
          console.debug('[tweets-2-bsky:web] api-error', {
            method: error.config?.method?.toUpperCase(),
            url: error.config?.url,
            status: error.response?.status,
            message: error.message,
            timestamp: new Date().toISOString(),
          });
        }
        return Promise.reject(error);
      },
    );

    return () => {
      axios.interceptors.request.eject(requestInterceptor);
      axios.interceptors.response.eject(responseInterceptor);
    };
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    resetDashboardState();
    queryClient.clear();
  }, [queryClient, resetDashboardState]);

  const handleAuthFailure = useCallback(
    (error: unknown, fallbackMessage: string) => {
      // Only the token check answers with a bare 401/403. A 401/403 that carries
      // an `error` message (wrong current password, missing permission) is an
      // ordinary failure: show it rather than signing the user out.
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403) &&
        typeof error.response?.data?.error !== 'string'
      ) {
        handleLogout();
        return;
      }
      showNotice('error', getApiErrorMessage(error, fallbackMessage));
    },
    [handleLogout, showNotice],
  );

  // Failed queries report the same way failed requests always have: sign out
  // on 401/403, otherwise an error notice with the query's message.
  useEffect(() => {
    setQueryErrorHandler((error, meta) => {
      if (isCancelledError(error) || !meta?.errorMessage) {
        return;
      }
      handleAuthFailure(error, meta.errorMessage);
    });
    return () => setQueryErrorHandler(null);
  }, [handleAuthFailure]);

  const fetchBootstrapStatus = useCallback(async () => {
    await queryClient.refetchQueries({ queryKey: queryKeys.bootstrapStatus });
  }, [queryClient]);

  useEffect(() => {
    if (!bootstrapOpen && authView === 'register') {
      setAuthView('login');
    }
  }, [authView, bootstrapOpen, setAuthView]);
  const canManageMapping = useCallback(
    (mapping: AccountMapping) =>
      canManageAllMappings ||
      (canManageOwnMappings && (!mapping.createdByUserId || mapping.createdByUserId === me?.id)),
    [canManageAllMappings, canManageOwnMappings, me?.id],
  );

  return {
    bootstrapOpen,
    me,
    setMe,
    isAdmin,
    effectivePermissions,
    canManageAllMappings,
    canManageOwnMappings,
    canCreateMappings,
    canManageGroupsPermission,
    canQueueBackfillsPermission,
    canRunNowPermission,
    hasCurrentEmail,
    authHeaders,
    handleLogout,
    handleAuthFailure,
    fetchBootstrapStatus,
    canManageMapping,
  };
}
