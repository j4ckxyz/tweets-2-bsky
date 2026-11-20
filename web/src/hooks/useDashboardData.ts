import axios from 'axios';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RouteSummary } from '../components/AccountHealth';
import { normalizePermissions, normalizeTwitterUsername } from '../lib/format';
import type {
  AIConfig,
  AccountGroup,
  AccountMapping,
  ActivityLog,
  AuthUser,
  BskyProfileView,
  EnrichedPost,
  FediverseBridgeStatusView,
  ManagedUser,
  RuntimeVersionInfo,
  StatusResponse,
  TwitterConfig,
  UpdateStatusInfo,
} from '../lib/types';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardState } from './useDashboardState';
import type { useRouting } from './useRouting';

// Server data shared across pages, its loaders and the polling that keeps it fresh.
export function useDashboardData(
  deps: Pick<
    ReturnType<typeof useDashboardState> & ReturnType<typeof useAuthSession> & ReturnType<typeof useRouting>,
    | 'activeTab'
    | 'authHeaders'
    | 'enrichedPosts'
    | 'fediverseBridgeStatusByMappingId'
    | 'fetchBootstrapStatus'
    | 'handleAuthFailure'
    | 'handleLogout'
    | 'isAdmin'
    | 'mappings'
    | 'profilesByActor'
    | 'recentActivity'
    | 'runtimeVersion'
    | 'setEmailForm'
    | 'setEnrichedPosts'
    | 'setFediverseBridgeStatusByMappingId'
    | 'setGroups'
    | 'setManagedUsers'
    | 'setMappings'
    | 'setMe'
    | 'setProfilesByActor'
    | 'setRecentActivity'
    | 'setRuntimeVersion'
    | 'setStatus'
    | 'setUpdateStatus'
    | 'status'
    | 'token'
    | 'updateStatus'
  >,
) {
  const {
    activeTab,
    authHeaders,
    enrichedPosts,
    fediverseBridgeStatusByMappingId,
    fetchBootstrapStatus,
    handleAuthFailure,
    handleLogout,
    isAdmin,
    mappings,
    profilesByActor,
    recentActivity,
    runtimeVersion,
    setEmailForm,
    setEnrichedPosts,
    setFediverseBridgeStatusByMappingId,
    setGroups,
    setManagedUsers,
    setMappings,
    setMe,
    setProfilesByActor,
    setRecentActivity,
    setRuntimeVersion,
    setStatus,
    setUpdateStatus,
    status,
    token,
    updateStatus,
  } = deps;

  const [jobsExpanded, setJobsExpanded] = useState(false);
  const [routeSummary, setRouteSummary] = useState<RouteSummary | null>(null);
  const [twitterConfig, setTwitterConfig] = useState<TwitterConfig>({ authToken: '', ct0: '' });
  const [aiConfig, setAiConfig] = useState<AIConfig>({ provider: 'gemini', apiKey: '', model: '', baseUrl: '' });
  const [countdown, setCountdown] = useState('--');
  const [showAccountAvatars, setShowAccountAvatars] = useState(false);
  const [showAccountBios, setShowAccountBios] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const statusRequestRef = useRef(0);
  const statusMutationRef = useRef(0);
  const fediverseBridgeStatusByMappingIdRef = useRef<Record<string, FediverseBridgeStatusView>>({});
  const bridgeStatusFetchRef = useRef<Promise<Record<string, FediverseBridgeStatusView> | null> | null>(null);

  useEffect(() => {
    fediverseBridgeStatusByMappingIdRef.current = fediverseBridgeStatusByMappingId;
  }, [fediverseBridgeStatusByMappingId]);

  const fetchStatus = useCallback(async () => {
    if (!authHeaders) {
      return;
    }

    const requestToken = ++statusRequestRef.current;
    const mutationTokenAtStart = statusMutationRef.current;

    try {
      const response = await axios.get<StatusResponse>('/api/status', { headers: authHeaders });
      if (requestToken !== statusRequestRef.current) {
        return;
      }
      if (mutationTokenAtStart !== statusMutationRef.current) {
        return;
      }
      setStatus(response.data);
    } catch (error) {
      handleAuthFailure(error, 'Failed to fetch status.');
    }
  }, [authHeaders, handleAuthFailure, setStatus]);

  const fetchRecentActivity = useCallback(async () => {
    if (!authHeaders) {
      return;
    }

    try {
      const response = await axios.get<ActivityLog[]>('/api/recent-activity?limit=20', { headers: authHeaders });
      setRecentActivity(response.data);
    } catch (error) {
      handleAuthFailure(error, 'Failed to fetch activity.');
    }
  }, [authHeaders, handleAuthFailure, setRecentActivity]);

  const fetchEnrichedPosts = useCallback(async () => {
    if (!authHeaders) {
      return;
    }

    try {
      const response = await axios.get<EnrichedPost[]>('/api/posts/enriched?limit=36', { headers: authHeaders });
      setEnrichedPosts(response.data);
    } catch (error) {
      handleAuthFailure(error, 'Failed to fetch Bluesky posts.');
    }
  }, [authHeaders, handleAuthFailure, setEnrichedPosts]);

  const fetchGroups = useCallback(async () => {
    if (!authHeaders) {
      return;
    }

    try {
      const response = await axios.get<AccountGroup[]>('/api/groups', { headers: authHeaders });
      setGroups(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      handleAuthFailure(error, 'Failed to fetch account groups.');
    }
  }, [authHeaders, handleAuthFailure, setGroups]);

  const fetchRuntimeVersion = useCallback(async () => {
    if (!authHeaders) {
      return;
    }

    try {
      const response = await axios.get<RuntimeVersionInfo>('/api/version', { headers: authHeaders });
      setRuntimeVersion(response.data);
    } catch (error) {
      handleAuthFailure(error, 'Failed to fetch app version.');
    }
  }, [authHeaders, handleAuthFailure, setRuntimeVersion]);

  const fetchUpdateStatus = useCallback(async () => {
    if (!authHeaders || !isAdmin) {
      return;
    }

    try {
      const response = await axios.get<UpdateStatusInfo>('/api/update-status', { headers: authHeaders });
      setUpdateStatus(response.data);
    } catch (error) {
      handleAuthFailure(error, 'Failed to fetch update status.');
    }
  }, [authHeaders, handleAuthFailure, isAdmin, setUpdateStatus]);

  const fetchManagedUsers = useCallback(async () => {
    if (!authHeaders || !isAdmin) {
      setManagedUsers([]);
      return;
    }

    try {
      const response = await axios.get<ManagedUser[]>('/api/admin/users', { headers: authHeaders });
      setManagedUsers(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      handleAuthFailure(error, 'Failed to fetch dashboard users.');
    }
  }, [authHeaders, handleAuthFailure, isAdmin, setManagedUsers]);

  const fetchProfiles = useCallback(
    async (actors: string[]): Promise<Record<string, BskyProfileView> | null> => {
      if (!authHeaders) {
        return null;
      }

      const normalizedActors = [...new Set(actors.map(normalizeTwitterUsername).filter((actor) => actor.length > 0))];
      if (normalizedActors.length === 0) {
        setProfilesByActor({});
        return {};
      }

      try {
        const response = await axios.post<Record<string, BskyProfileView>>(
          '/api/bsky/profiles',
          { actors: normalizedActors },
          { headers: authHeaders },
        );
        const nextProfiles = response.data || {};
        setProfilesByActor(nextProfiles);
        return nextProfiles;
      } catch (error) {
        handleAuthFailure(error, 'Failed to resolve Bluesky profiles.');
        return null;
      }
    },
    [authHeaders, handleAuthFailure, setProfilesByActor],
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
          const response = await axios.post<Record<string, FediverseBridgeStatusView>>(
            '/api/mappings/fediverse-bridge-status',
            { mappingIds },
            { headers: authHeaders },
          );
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

  const fetchData = useCallback(
    async (options?: { refreshBridgeStatuses?: boolean }) => {
      if (!authHeaders) {
        return;
      }

      try {
        const [meResponse, mappingsResponse, groupsResponse] = await Promise.all([
          axios.get<AuthUser>('/api/me', { headers: authHeaders }),
          axios.get<AccountMapping[]>('/api/mappings', { headers: authHeaders }),
          axios.get<AccountGroup[]>('/api/groups', { headers: authHeaders }),
        ]);

        const profile = meResponse.data;
        const mappingData = Array.isArray(mappingsResponse.data) ? mappingsResponse.data : [];
        const groupData = Array.isArray(groupsResponse.data) ? groupsResponse.data : [];
        setMe({
          ...profile,
          permissions: normalizePermissions(profile.permissions),
        });
        setMappings(mappingData);
        setGroups(groupData);
        setEmailForm((previous) => ({
          ...previous,
          currentEmail: profile.email || '',
        }));
        const versionResponse = await axios.get<RuntimeVersionInfo>('/api/version', { headers: authHeaders });
        setRuntimeVersion(versionResponse.data);

        if (profile.isAdmin) {
          const [twitterResponse, aiResponse, updateStatusResponse, usersResponse] = await Promise.all([
            axios.get<TwitterConfig>('/api/twitter-config', { headers: authHeaders }),
            axios.get<AIConfig>('/api/ai-config', { headers: authHeaders }),
            axios.get<UpdateStatusInfo>('/api/update-status', { headers: authHeaders }),
            axios.get<ManagedUser[]>('/api/admin/users', { headers: authHeaders }),
          ]);

          setTwitterConfig({
            authToken: twitterResponse.data.authToken || '',
            ct0: twitterResponse.data.ct0 || '',
            backupAuthToken: twitterResponse.data.backupAuthToken || '',
            backupCt0: twitterResponse.data.backupCt0 || '',
          });

          setAiConfig({
            provider: aiResponse.data.provider || 'gemini',
            apiKey: aiResponse.data.apiKey || '',
            model: aiResponse.data.model || '',
            baseUrl: aiResponse.data.baseUrl || '',
          });
          setUpdateStatus(updateStatusResponse.data);
          setManagedUsers(Array.isArray(usersResponse.data) ? usersResponse.data : []);
        } else {
          setUpdateStatus(null);
          setManagedUsers([]);
        }

        const mappingIds = new Set(mappingData.map((mapping) => mapping.id));
        setFediverseBridgeStatusByMappingId((previous) => {
          const next = Object.fromEntries(
            Object.entries(previous).filter(([mappingId]) => mappingIds.has(mappingId)),
          ) as Record<string, FediverseBridgeStatusView>;
          return next;
        });

        await Promise.all([fetchStatus(), fetchRecentActivity(), fetchEnrichedPosts()]);

        void fetchProfiles(mappingData.map((mapping) => mapping.bskyIdentifier));

        const shouldRefreshBridgeStatuses = options?.refreshBridgeStatuses === true;
        if (shouldRefreshBridgeStatuses) {
          void fetchFediverseBridgeStatuses(mappingData, { force: options?.refreshBridgeStatuses === true });
        }
      } catch (error) {
        handleAuthFailure(error, 'Failed to load dashboard data.');
      }
    },
    [
      authHeaders,
      fetchEnrichedPosts,
      fetchFediverseBridgeStatuses,
      fetchProfiles,
      fetchRecentActivity,
      fetchStatus,
      handleAuthFailure,
      setEmailForm,
      setFediverseBridgeStatusByMappingId,
      setGroups,
      setManagedUsers,
      setMappings,
      setMe,
      setRuntimeVersion,
      setUpdateStatus,
    ],
  );

  useEffect(() => {
    if (!token) {
      void fetchBootstrapStatus();
      return;
    }

    void fetchData();
  }, [token, fetchBootstrapStatus, fetchData]);

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

  useEffect(() => {
    if (!token) {
      return;
    }

    const statusPollIntervalMs = activeTab === 'accounts' ? 7000 : 3000;
    const shouldPollActivity = activeTab === 'overview' || activeTab === 'activity';
    const shouldPollPosts = activeTab === 'overview' || activeTab === 'posts';

    const statusInterval = window.setInterval(() => {
      void fetchStatus();
    }, statusPollIntervalMs);

    const activityInterval = shouldPollActivity
      ? window.setInterval(() => {
          void fetchRecentActivity();
        }, 7000)
      : null;

    const postsInterval = shouldPollPosts
      ? window.setInterval(() => {
          void fetchEnrichedPosts();
        }, 12000)
      : null;

    return () => {
      window.clearInterval(statusInterval);
      if (activityInterval !== null) {
        window.clearInterval(activityInterval);
      }
      if (postsInterval !== null) {
        window.clearInterval(postsInterval);
      }
    };
  }, [activeTab, token, fetchEnrichedPosts, fetchRecentActivity, fetchStatus]);

  useEffect(() => {
    if (!token) {
      return;
    }

    const versionInterval = window.setInterval(() => {
      void fetchRuntimeVersion();
      if (isAdmin) {
        void fetchUpdateStatus();
      }
    }, 15000);

    return () => {
      window.clearInterval(versionInterval);
    };
  }, [token, isAdmin, fetchRuntimeVersion, fetchUpdateStatus]);

  useEffect(() => {
    if (activeTab !== 'overview' || !status?.nextCheckTime) {
      setCountdown('--');
      return;
    }

    const updateCountdown = () => {
      const ms = status.nextCheckTime - Date.now();
      if (ms <= 0) {
        setCountdown('Checking...');
        return;
      }

      const minutes = Math.floor(ms / 60000);
      const seconds = Math.floor((ms % 60000) / 1000);
      setCountdown(`${minutes}m ${String(seconds).padStart(2, '0')}s`);
    };

    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeTab, status?.nextCheckTime]);

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
    jobsExpanded,
    setJobsExpanded,
    routeSummary,
    setRouteSummary,
    twitterConfig,
    setTwitterConfig,
    aiConfig,
    setAiConfig,
    countdown,
    setCountdown,
    showAccountAvatars,
    setShowAccountAvatars,
    showAccountBios,
    setShowAccountBios,
    expandedLogId,
    setExpandedLogId,
    importInputRef,
    statusRequestRef,
    statusMutationRef,
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
