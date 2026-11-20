import axios from 'axios';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getApiErrorMessage, normalizePermissions } from '../lib/format';
import type { AccountMapping, BootstrapStatus, UserPermissions } from '../lib/types';
import type { useDashboardState } from './useDashboardState';
import type { useNotice } from './useNotice';

// Signed-in user, permissions, login/register/logout and the bootstrap check.
export function useAuthSession(
  deps: Pick<
    ReturnType<typeof useDashboardState> & ReturnType<typeof useNotice>,
    'authView' | 'me' | 'resetDashboardState' | 'setAuthView' | 'showNotice' | 'token'
  >,
) {
  const { authView, me, resetDashboardState, setAuthView, showNotice, token } = deps;

  const [bootstrapOpen, setBootstrapOpen] = useState(false);

  const isAdmin = me?.isAdmin ?? false;
  const effectivePermissions = useMemo<UserPermissions>(() => normalizePermissions(me?.permissions), [me?.permissions]);
  const canManageAllMappings = isAdmin || effectivePermissions.manageAllMappings;
  const canManageOwnMappings = isAdmin || effectivePermissions.manageOwnMappings;
  const canCreateMappings = canManageAllMappings || canManageOwnMappings;
  const canManageGroupsPermission = isAdmin || effectivePermissions.manageGroups;
  const canQueueBackfillsPermission = isAdmin || effectivePermissions.queueBackfills;
  const canRunNowPermission = isAdmin || effectivePermissions.runNow;
  const hasCurrentEmail = Boolean(me?.email && me.email.trim().length > 0);
  const authHeaders = useMemo(() => (token ? { Authorization: `Bearer ${token}` } : undefined), [token]);

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
  }, [resetDashboardState]);

  const handleAuthFailure = useCallback(
    (error: unknown, fallbackMessage: string) => {
      if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
        handleLogout();
        return;
      }
      showNotice('error', getApiErrorMessage(error, fallbackMessage));
    },
    [handleLogout, showNotice],
  );

  const fetchBootstrapStatus = useCallback(async () => {
    try {
      const response = await axios.get<BootstrapStatus>('/api/auth/bootstrap-status');
      setBootstrapOpen(Boolean(response.data?.bootstrapOpen));
    } catch {
      setBootstrapOpen(false);
    }
  }, []);

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
    setBootstrapOpen,
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
