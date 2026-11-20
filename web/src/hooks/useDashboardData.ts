import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import type { SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RouteSummary } from '../components/AccountHealth';
import * as api from '../lib/api';
import { normalizeTwitterUsername } from '../lib/format';
import { queryKeys } from '../lib/query-keys';
import type {
  AIConfig,
  AccountGroup,
  AccountMapping,
  BskyProfileView,
  FediverseBridgeStatusView,
  StatusResponse,
  TwitterConfig,
} from '../lib/types';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardState } from './useDashboardState';
import type { useNotice } from './useNotice';
import type { useRouting } from './useRouting';
import type { useTheme } from './useTheme';

// Status polls faster everywhere except the accounts list, where a long table
// re-renders on every update.
const STATUS_POLL_MS = 3000;
const STATUS_POLL_ACCOUNTS_MS = 7000;
const ACTIVITY_POLL_MS = 7000;
const POSTS_POLL_MS = 12000;
const VERSION_POLL_MS = 15000;

// Server data shared across pages. TanStack Query owns fetching, caching and
// polling; the fetchX / setX functions keep the shape the action hooks use:
// fetchX refetches, setX writes the cache (an optimistic update).
export function useDashboardData(
  deps: Pick<
    ReturnType<typeof useDashboardState> &
      ReturnType<typeof useTheme> &
      ReturnType<typeof useNotice> &
      ReturnType<typeof useAuthSession> &
      ReturnType<typeof useRouting>,
    | 'activeTab'
    | 'authHeaders'
    | 'fediverseBridgeStatusByMappingId'
    | 'handleAuthFailure'
    | 'handleLogout'
    | 'isAdmin'
    | 'setFediverseBridgeStatusByMappingId'
    | 'token'
  >,
) {
  const {
    activeTab,
    authHeaders,
    fediverseBridgeStatusByMappingId,
    handleAuthFailure,
    handleLogout,
    isAdmin,
    setFediverseBridgeStatusByMappingId,
    token,
  } = deps;
  const queryClient = useQueryClient();
  const signedIn = Boolean(authHeaders);

  const [routeSummary, setRouteSummary] = useState<RouteSummary | null>(null);
  const [twitterConfig, setTwitterConfig] = useState<TwitterConfig>({ authToken: '', ct0: '' });
  const [aiConfig, setAiConfig] = useState<AIConfig>({ provider: 'gemini', apiKey: '', model: '', baseUrl: '' });
  const importInputRef = useRef<HTMLInputElement>(null);
  const fediverseBridgeStatusByMappingIdRef = useRef<Record<string, FediverseBridgeStatusView>>({});
  const bridgeStatusFetchRef = useRef<Promise<Record<string, FediverseBridgeStatusView> | null> | null>(null);

  useEffect(() => {
    fediverseBridgeStatusByMappingIdRef.current = fediverseBridgeStatusByMappingId;
  }, [fediverseBridgeStatusByMappingId]);

  // ---- queries -------------------------------------------------------------

  const mappingsQuery = useQuery({
    queryKey: queryKeys.mappings,
    queryFn: async () => {
      const response = await api.getMappings({ headers: authHeaders });
      return Array.isArray(response.data) ? response.data : [];
    },
    enabled: signedIn,
    meta: { errorMessage: 'Failed to load dashboard data.' },
  });
  const mappings = useMemo(() => mappingsQuery.data ?? [], [mappingsQuery.data]);

  const groupsQuery = useQuery({
    queryKey: queryKeys.groups,
    queryFn: async () => {
      const response = await api.getGroups({ headers: authHeaders });
      return Array.isArray(response.data) ? response.data : [];
    },
    enabled: signedIn,
    meta: { errorMessage: 'Failed to fetch account groups.' },
  });
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);

  const statusQuery = useQuery({
    queryKey: queryKeys.status,
    queryFn: async () => (await api.getStatus({ headers: authHeaders })).data,
    enabled: signedIn,
    refetchInterval: activeTab === 'accounts' ? STATUS_POLL_ACCOUNTS_MS : STATUS_POLL_MS,
    meta: { errorMessage: 'Failed to fetch status.' },
  });
  const status = statusQuery.data ?? null;

  const recentActivityQuery = useQuery({
    queryKey: queryKeys.recentActivity,
    queryFn: async () => (await api.getRecentActivity({ headers: authHeaders })).data,
    enabled: signedIn,
    refetchInterval: activeTab === 'overview' || activeTab === 'activity' ? ACTIVITY_POLL_MS : false,
    meta: { errorMessage: 'Failed to fetch activity.' },
  });
  const recentActivity = useMemo(() => recentActivityQuery.data ?? [], [recentActivityQuery.data]);

  const enrichedPostsQuery = useQuery({
    queryKey: queryKeys.enrichedPosts,
    queryFn: async () => (await api.getEnrichedPosts({ headers: authHeaders })).data,
    enabled: signedIn,
    refetchInterval: activeTab === 'overview' || activeTab === 'posts' ? POSTS_POLL_MS : false,
    meta: { errorMessage: 'Failed to fetch Bluesky posts.' },
  });
  const enrichedPosts = useMemo(() => enrichedPostsQuery.data ?? [], [enrichedPostsQuery.data]);

  const versionQuery = useQuery({
    queryKey: queryKeys.version,
    queryFn: async () => (await api.getVersion({ headers: authHeaders })).data,
    enabled: signedIn,
    refetchInterval: VERSION_POLL_MS,
    meta: { errorMessage: 'Failed to fetch app version.' },
  });
  const runtimeVersion = versionQuery.data ?? null;

  const updateStatusQuery = useQuery({
    queryKey: queryKeys.updateStatus,
    queryFn: async () => (await api.getUpdateStatus({ headers: authHeaders })).data,
    enabled: signedIn && isAdmin,
    refetchInterval: VERSION_POLL_MS,
    meta: { errorMessage: 'Failed to fetch update status.' },
  });
  const updateStatus = isAdmin ? (updateStatusQuery.data ?? null) : null;

  const usersQuery = useQuery({
    queryKey: queryKeys.users,
    queryFn: async () => {
      const response = await api.getUsers({ headers: authHeaders });
      return Array.isArray(response.data) ? response.data : [];
    },
    enabled: signedIn && isAdmin,
    meta: { errorMessage: 'Failed to fetch dashboard users.' },
  });
  const managedUsers = useMemo(() => (isAdmin ? (usersQuery.data ?? []) : []), [isAdmin, usersQuery.data]);

  // The X and AI settings forms are seeded from the server, and every reload
  // overwrites them with what is saved.
  const twitterConfigQuery = useQuery({
    queryKey: queryKeys.twitterConfig,
    queryFn: async () => (await api.getTwitterConfig({ headers: authHeaders })).data,
    enabled: signedIn && isAdmin,
    meta: { errorMessage: 'Failed to load dashboard data.' },
  });
  const twitterConfigData = twitterConfigQuery.data;
  const twitterConfigUpdatedAt = twitterConfigQuery.dataUpdatedAt;
  useEffect(() => {
    if (!twitterConfigData || twitterConfigUpdatedAt === 0) return;
    setTwitterConfig({
      authToken: twitterConfigData.authToken || '',
      ct0: twitterConfigData.ct0 || '',
      backupAuthToken: twitterConfigData.backupAuthToken || '',
      backupCt0: twitterConfigData.backupCt0 || '',
    });
  }, [twitterConfigData, twitterConfigUpdatedAt]);

  const aiConfigQuery = useQuery({
    queryKey: queryKeys.aiConfig,
    queryFn: async () => (await api.getAiConfig({ headers: authHeaders })).data,
    enabled: signedIn && isAdmin,
    meta: { errorMessage: 'Failed to load dashboard data.' },
  });
  const aiConfigData = aiConfigQuery.data;
  const aiConfigUpdatedAt = aiConfigQuery.dataUpdatedAt;
  useEffect(() => {
    if (!aiConfigData || aiConfigUpdatedAt === 0) return;
    setAiConfig({
      provider: aiConfigData.provider || 'gemini',
      apiKey: aiConfigData.apiKey || '',
      model: aiConfigData.model || '',
      baseUrl: aiConfigData.baseUrl || '',
    });
  }, [aiConfigData, aiConfigUpdatedAt]);

  const loadProfiles = useCallback(
    async (actors: string[]): Promise<Record<string, BskyProfileView>> => {
      const normalizedActors = [...new Set(actors.map(normalizeTwitterUsername).filter((actor) => actor.length > 0))];
      if (normalizedActors.length === 0) {
        return {};
      }
      const response = await api.getBskyProfiles({ actors: normalizedActors }, { headers: authHeaders });
      return response.data || {};
    },
    [authHeaders],
  );

  // Avatars and bios for every mapped Bluesky account, refreshed whenever the
  // dashboard reloads its mappings.
  const profilesQuery = useQuery({
    queryKey: queryKeys.bskyProfiles,
    queryFn: () =>
      loadProfiles(
        (queryClient.getQueryData<AccountMapping[]>(queryKeys.mappings) ?? []).map((mapping) => mapping.bskyIdentifier),
      ),
    enabled: signedIn && mappingsQuery.isSuccess,
    meta: { errorMessage: 'Failed to resolve Bluesky profiles.' },
  });
  const profilesByActor = useMemo(() => profilesQuery.data ?? {}, [profilesQuery.data]);

  // ---- cache writers (optimistic updates from the action hooks) -------------

  const setMappings = useCallback(
    (update: SetStateAction<AccountMapping[]>) =>
      queryClient.setQueryData<AccountMapping[]>(queryKeys.mappings, (previous) =>
        typeof update === 'function' ? update(previous ?? []) : update,
      ),
    [queryClient],
  );

  const setGroups = useCallback(
    (update: SetStateAction<AccountGroup[]>) =>
      queryClient.setQueryData<AccountGroup[]>(queryKeys.groups, (previous) =>
        typeof update === 'function' ? update(previous ?? []) : update,
      ),
    [queryClient],
  );

  // An optimistic status update must not be overwritten by a poll that started
  // before it, so any in-flight status request is cancelled first.
  const setStatus = useCallback(
    (update: SetStateAction<StatusResponse | null>) => {
      void queryClient.cancelQueries({ queryKey: queryKeys.status });
      queryClient.setQueryData<StatusResponse | null>(queryKeys.status, (previous) =>
        typeof update === 'function' ? update(previous ?? null) : update,
      );
    },
    [queryClient],
  );

  // ---- refetchers ------------------------------------------------------------

  const refetch = useCallback(
    async (queryKey: readonly unknown[]) => {
      if (!authHeaders) {
        return;
      }
      await queryClient.refetchQueries({ queryKey });
    },
    [authHeaders, queryClient],
  );
  const fetchStatus = useCallback(() => refetch(queryKeys.status), [refetch]);
  const fetchRecentActivity = useCallback(() => refetch(queryKeys.recentActivity), [refetch]);
  const fetchEnrichedPosts = useCallback(() => refetch(queryKeys.enrichedPosts), [refetch]);
  const fetchGroups = useCallback(() => refetch(queryKeys.groups), [refetch]);
  const fetchRuntimeVersion = useCallback(() => refetch(queryKeys.version), [refetch]);
  const fetchUpdateStatus = useCallback(() => refetch(queryKeys.updateStatus), [refetch]);
  const fetchManagedUsers = useCallback(() => refetch(queryKeys.users), [refetch]);

  // Profiles for a chosen set of accounts (after a bulk profile sync). The
  // result replaces the cached map, as it always has.
  const fetchProfiles = useCallback(
    async (actors: string[]): Promise<Record<string, BskyProfileView> | null> => {
      if (!authHeaders) {
        return null;
      }
      try {
        const nextProfiles = await loadProfiles(actors);
        queryClient.setQueryData(queryKeys.bskyProfiles, nextProfiles);
        return nextProfiles;
      } catch (error) {
        handleAuthFailure(error, 'Failed to resolve Bluesky profiles.');
        return null;
      }
    },
    [authHeaders, handleAuthFailure, loadProfiles, queryClient],
  );

  const fetchFediverseBridgeStatuses = useCallback(
    async (
      mappingData: AccountMapping[],
      options?: {
        force?: boolean;
      },
    ): Promise<Record<string, FediverseBridgeStatusView> | null> => {
      if (!authHeaders) {
        return null;
      }

      const mappingIds = [...new Set(mappingData.map((mapping) => mapping.id).filter((id) => id.length > 0))];
      if (mappingIds.length === 0) {
        setFediverseBridgeStatusByMappingId({});
        return {};
      }

      if (!options?.force && bridgeStatusFetchRef.current) {
        return bridgeStatusFetchRef.current;
      }

      const request = (async () => {
        try {
          const response = await api.getFediverseBridgeStatuses({ mappingIds }, { headers: authHeaders });
          const nextStatuses = response.data || {};
          setFediverseBridgeStatusByMappingId((previous) => {
            const next = { ...previous };
            for (const id of mappingIds) {
              delete next[id];
            }
            for (const [id, status] of Object.entries(nextStatuses)) {
              next[id] = status;
            }
            return next;
          });
          return nextStatuses;
        } catch (error) {
          if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
            handleLogout();
            return null;
          }
          console.warn('Failed to fetch fediverse bridge statuses.', error);
          return null;
        } finally {
          bridgeStatusFetchRef.current = null;
        }
      })();

      bridgeStatusFetchRef.current = request;
      return request;
    },
    [authHeaders, handleLogout, setFediverseBridgeStatusByMappingId],
  );

  // Reload everything after an action: the account data first, then the live
  // status, activity and posts, then profiles in the background.
  const fetchData = useCallback(
    async (options?: { refreshBridgeStatuses?: boolean }) => {
      if (!authHeaders) {
        return;
      }

      await Promise.all(
        [
          queryKeys.me,
          queryKeys.mappings,
          queryKeys.groups,
          queryKeys.version,
          queryKeys.twitterConfig,
          queryKeys.aiConfig,
          queryKeys.updateStatus,
          queryKeys.users,
        ].map((queryKey) => queryClient.refetchQueries({ queryKey })),
      );

      const mappingData = queryClient.getQueryData<AccountMapping[]>(queryKeys.mappings) ?? [];
      const mappingIds = new Set(mappingData.map((mapping) => mapping.id));
      setFediverseBridgeStatusByMappingId((previous) => {
        const next = Object.fromEntries(
          Object.entries(previous).filter(([mappingId]) => mappingIds.has(mappingId)),
        ) as Record<string, FediverseBridgeStatusView>;
        return next;
      });

      await Promise.all(
        [queryKeys.status, queryKeys.recentActivity, queryKeys.enrichedPosts].map((queryKey) =>
          queryClient.refetchQueries({ queryKey }),
        ),
      );

      void queryClient.refetchQueries({ queryKey: queryKeys.bskyProfiles });

      if (options?.refreshBridgeStatuses === true) {
        void fetchFediverseBridgeStatuses(mappingData, { force: true });
      }
    },
    [authHeaders, fetchFediverseBridgeStatuses, queryClient, setFediverseBridgeStatusByMappingId],
  );

  // A replaced token (changing your own email issues a new one) reloads
  // everything with the new credentials. Signing in needs nothing here: the
  // queries start as soon as there is a token.
  const previousTokenRef = useRef(token);
  useEffect(() => {
    const previousToken = previousTokenRef.current;
    previousTokenRef.current = token;
    if (token && previousToken && previousToken !== token) {
      void fetchData();
    }
  }, [fetchData, token]);

  useEffect(() => {
    if (!token || activeTab !== 'accounts' || mappings.length === 0) {
      return;
    }

    const hasMissingStatuses = mappings.some(
      (mapping) => fediverseBridgeStatusByMappingIdRef.current[mapping.id] === undefined,
    );
    if (!hasMissingStatuses) {
      return;
    }

    const timer = window.setTimeout(() => {
      void fetchFediverseBridgeStatuses(mappings, { force: true });
    }, 150);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeTab, fetchFediverseBridgeStatuses, mappings, token]);

  // ---- derived values --------------------------------------------------------

  const pendingBackfills = status?.pendingBackfills ?? [];
  const activeJobs = status?.activeJobs ?? [];
  const currentStatus = status?.currentStatus;
  const postQueue = status?.queue;
  const accountAlerts = status?.accountAlerts ?? [];
  const queuedPostCount = (postQueue?.pending ?? 0) + (postQueue?.processing ?? 0);
  const latestActivity = recentActivity[0];
  const postedActivity = useMemo(() => enrichedPosts.slice(0, 12), [enrichedPosts]);
  const engagementByAccount = useMemo(() => {
    const map = new Map<string, { identifier: string; score: number; posts: number }>();
    for (const post of enrichedPosts) {
      const key = normalizeTwitterUsername(post.bskyIdentifier);
      const existing = map.get(key) || {
        identifier: post.bskyIdentifier,
        score: 0,
        posts: 0,
      };
      existing.score += post.stats.engagement || 0;
      existing.posts += 1;
      map.set(key, existing);
    }
    return [...map.values()].sort((a, b) => b.score - a.score);
  }, [enrichedPosts]);
  const topAccount = engagementByAccount[0];
  const getProfileForActor = useCallback(
    (actor: string) => profilesByActor[normalizeTwitterUsername(actor)],
    [profilesByActor],
  );
  const topAccountProfile = topAccount ? getProfileForActor(topAccount.identifier) : undefined;
  const mappingsByBskyIdentifier = useMemo(() => {
    const map = new Map<string, AccountMapping>();
    for (const mapping of mappings) {
      map.set(normalizeTwitterUsername(mapping.bskyIdentifier), mapping);
    }
    return map;
  }, [mappings]);
  const mappingsByTwitterUsername = useMemo(() => {
    const map = new Map<string, AccountMapping>();
    for (const mapping of mappings) {
      for (const username of mapping.twitterUsernames) {
        map.set(normalizeTwitterUsername(username), mapping);
      }
    }
    return map;
  }, [mappings]);

  const progressPercent = useMemo(() => {
    if (!currentStatus?.totalCount || currentStatus.totalCount <= 0) {
      return 0;
    }
    const processed = currentStatus.processedCount || 0;
    return Math.max(0, Math.min(100, Math.round((processed / currentStatus.totalCount) * 100)));
  }, [currentStatus]);
  const runtimeVersionLabel = runtimeVersion
    ? `v${runtimeVersion.version}${runtimeVersion.commit ? ` (${runtimeVersion.commit})` : ''}`
    : 'v--';
  const runtimeBranchLabel = runtimeVersion?.branch ? `branch ${runtimeVersion.branch}` : null;
  const updateStateLabel = updateStatus?.running
    ? 'Update in progress'
    : updateStatus?.finishedAt
      ? updateStatus.exitCode === 0
        ? 'Last update succeeded'
        : 'Last update failed'
      : 'No update run recorded';

  return {
    mappings,
    setMappings,
    groups,
    setGroups,
    status,
    setStatus,
    recentActivity,
    enrichedPosts,
    profilesByActor,
    runtimeVersion,
    updateStatus,
    managedUsers,
    routeSummary,
    setRouteSummary,
    twitterConfig,
    setTwitterConfig,
    aiConfig,
    setAiConfig,
    importInputRef,
    fediverseBridgeStatusByMappingIdRef,
    bridgeStatusFetchRef,
    fetchStatus,
    fetchRecentActivity,
    fetchEnrichedPosts,
    fetchGroups,
    fetchRuntimeVersion,
    fetchUpdateStatus,
    fetchManagedUsers,
    fetchProfiles,
    fetchFediverseBridgeStatuses,
    fetchData,
    pendingBackfills,
    activeJobs,
    currentStatus,
    postQueue,
    accountAlerts,
    queuedPostCount,
    latestActivity,
    postedActivity,
    engagementByAccount,
    topAccount,
    getProfileForActor,
    topAccountProfile,
    mappingsByBskyIdentifier,
    mappingsByTwitterUsername,
    progressPercent,
    runtimeVersionLabel,
    runtimeBranchLabel,
    updateStateLabel,
  };
}
