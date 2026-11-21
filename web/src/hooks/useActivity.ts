import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api';
import {
  filenameFromResponse,
  formatLogEntryForExport,
  getMappingGroupMeta,
  normalizeTwitterUsername,
  triggerBlobDownload,
} from '../lib/format';
import { queryKeys } from '../lib/query-keys';
import type { ActivityLog, LogEntry, LogLevel, QueueFailuresResponse } from '../lib/types';
import type { useAccountsList } from './useAccountsList';
import type { useAuthForms } from './useAuthForms';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useGroups } from './useGroups';
import type { useNotice } from './useNotice';
import type { usePosts } from './usePosts';
import type { useRouting } from './useRouting';
import type { useTheme } from './useTheme';

// Activity tab: outcomes filter, system log viewer and the failed post queue.
const EMPTY_QUEUE_FAILURES: QueueFailuresResponse = { summary: [], items: [] };

export function useActivity(
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
      ReturnType<typeof usePosts>,
    | 'activeTab'
    | 'activityGroupFilter'
    | 'authHeaders'
    | 'fetchStatus'
    | 'handleAuthFailure'
    | 'mappingsByBskyIdentifier'
    | 'mappingsByTwitterUsername'
    | 'recentActivity'
    | 'showNotice'
    | 'token'
  >,
) {
  const {
    activeTab,
    activityGroupFilter,
    authHeaders,
    fetchStatus,
    handleAuthFailure,
    mappingsByBskyIdentifier,
    mappingsByTwitterUsername,
    recentActivity,
    showNotice,
    token,
  } = deps;

  const queryClient = useQueryClient();

  // System log viewer state (Activity tab → "System log").
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | LogLevel>('all');
  const [logStageFilter, setLogStageFilter] = useState('all');
  const [logSearch, setLogSearch] = useState('');
  const [logLimit, setLogLimit] = useState(200);
  const [logAutoRefresh, setLogAutoRefresh] = useState(true);
  const [activityView, setActivityView] = useState<'outcomes' | 'logs' | 'failures'>('outcomes');

  // Filters live in one place so the viewer, the clipboard copy and the file
  // download always describe exactly the same set of entries.
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
  const logQueryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (logLevelFilter !== 'all') {
      // Selecting a level means "this and worse", which is what people expect
      // from a log level control.
      const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
      params.set('level', order.slice(order.indexOf(logLevelFilter)).join(','));
    }
    if (logStageFilter !== 'all') params.set('stage', logStageFilter);
    if (logSearch.trim()) params.set('q', logSearch.trim());
    return params;
  }, [logLevelFilter, logStageFilter, logSearch]);

  // The log viewer only fetches while it is on screen, and refetches straight
  // away when a filter changes so the list always matches the controls.
  const logsVisible = Boolean(token && authHeaders) && activeTab === 'activity' && activityView === 'logs';
  const logsQueryString = useMemo(() => {
    const params = new URLSearchParams(logQueryParams);
    params.set('limit', String(logLimit));
    return params.toString();
  }, [logLimit, logQueryParams]);
  const logsQuery = useQuery({
    queryKey: queryKeys.logs(logsQueryString),
    queryFn: async () => (await api.getLogs(logsQueryString, { headers: authHeaders })).data,
    enabled: logsVisible,
    // Auto-refresh is a silent live tail: no spinner, so the list does not flicker.
    refetchInterval: logAutoRefresh ? 5000 : false,
    placeholderData: keepPreviousData,
    meta: { errorMessage: 'Failed to fetch logs.' },
  });
  const logEntries = useMemo<LogEntry[]>(() => logsQuery.data?.entries || [], [logsQuery.data]);
  const logHasMore = Boolean(logsQuery.data?.hasMore);

  // The spinner shows for fetches someone asked for (opening the view, changing
  // a filter, Refresh), never for the auto-refresh tick. A filter change shows
  // the previous entries as placeholder data until the new ones arrive.
  const [logsFetchRequested, setLogsFetchRequested] = useState(false);
  useEffect(() => {
    if (logsVisible) {
      setLogsFetchRequested(true);
    }
  }, [logsVisible]);
  const logsFetching = logsQuery.isFetching;
  useEffect(() => {
    if (!logsFetching) {
      setLogsFetchRequested(false);
    }
  }, [logsFetching]);
  const logsLoading = logsFetching && (logsFetchRequested || logsQuery.isPlaceholderData);

  const fetchLogs = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!authHeaders) {
        return;
      }
      if (!options.silent) setLogsFetchRequested(true);
      try {
        await queryClient.refetchQueries({ queryKey: queryKeys.logs(logsQueryString) });
      } finally {
        if (!options.silent) setLogsFetchRequested(false);
      }
    },
    [authHeaders, logsQueryString, queryClient],
  );

  const queueFailuresQuery = useQuery({
    queryKey: queryKeys.queueFailures,
    queryFn: async (): Promise<QueueFailuresResponse> => {
      const response = await api.getQueueFailures({
        headers: authHeaders,
      });
      return { summary: response.data.summary || [], items: response.data.items || [] };
    },
    enabled: Boolean(token && authHeaders) && activeTab === 'activity' && activityView === 'failures',
    meta: { errorMessage: 'Failed to fetch queue failures.' },
  });
  const queueFailures = queueFailuresQuery.data ?? EMPTY_QUEUE_FAILURES;
  const queueFailuresLoading = queueFailuresQuery.isFetching;

  const fetchQueueFailures = useCallback(async () => {
    if (!authHeaders) {
      return;
    }
    await queryClient.refetchQueries({ queryKey: queryKeys.queueFailures });
  }, [authHeaders, queryClient]);
  const resolveMappingForActivity = useCallback(
    (activity: ActivityLog) =>
      mappingsByBskyIdentifier.get(normalizeTwitterUsername(activity.bsky_identifier)) ||
      mappingsByTwitterUsername.get(normalizeTwitterUsername(activity.twitter_username)),
    [mappingsByBskyIdentifier, mappingsByTwitterUsername],
  );
  const filteredRecentActivity = useMemo(
    () =>
      recentActivity.filter((activity) => {
        if (activityGroupFilter === 'all') return true;
        const mapping = resolveMappingForActivity(activity);
        return getMappingGroupMeta(mapping).key === activityGroupFilter;
      }),
    [activityGroupFilter, recentActivity, resolveMappingForActivity],
  );

  const retryFailedQueue = async () => {
    if (!authHeaders) {
      return;
    }
    try {
      const response = await api.retryFailedQueue({}, { headers: authHeaders });
      showNotice('success', response.data?.message || 'Failed tweets requeued.');
      await Promise.all([fetchStatus(), fetchQueueFailures()]);
    } catch (error) {
      handleAuthFailure(error, 'Failed to requeue failed tweets.');
    }
  };

  const clearFailedQueue = async () => {
    if (!authHeaders) {
      return;
    }
    const confirmed = window.confirm('Remove all failed tweets from the post queue? They will not be retried.');
    if (!confirmed) {
      return;
    }
    try {
      const response = await api.clearFailedQueue({ headers: authHeaders });
      showNotice('success', response.data?.message || 'Failed tweets removed.');
      await Promise.all([fetchStatus(), fetchQueueFailures()]);
    } catch (error) {
      handleAuthFailure(error, 'Failed to clear failed tweets.');
    }
  };

  // Copies exactly what is on screen, in the same one-line format the .log
  // export uses, so a pasted snippet and a downloaded file look identical.
  const copyLogsToClipboard = async () => {
    if (logEntries.length === 0) {
      showNotice('info', 'There are no log entries to copy.');
      return;
    }
    // Screen order is newest-first; a copied log reads better oldest-first.
    const text = [...logEntries].slice().reverse().map(formatLogEntryForExport).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      showNotice('success', `Copied ${logEntries.length} log entr${logEntries.length === 1 ? 'y' : 'ies'}.`);
    } catch {
      // Clipboard access is blocked outside secure contexts (plain http on a
      // LAN address, for instance), which is a very common self-hosted setup.
      showNotice('error', 'The browser blocked clipboard access. Use Download instead.');
    }
  };

  const downloadLogs = async (format: 'txt' | 'json' | 'ndjson' | 'csv') => {
    if (!authHeaders) {
      return;
    }
    try {
      const params = new URLSearchParams(logQueryParams);
      params.set('format', format);
      params.set('limit', '50000');
      // The route needs the auth header, so fetch as a blob and save it
      // client-side rather than pointing the browser straight at the URL.
      const response = await api.exportLogs(params.toString(), {
        headers: authHeaders,
        responseType: 'blob',
      });
      triggerBlobDownload(response.data as Blob, filenameFromResponse(response, `tweets-2-bsky-logs.${format}`));
      showNotice('success', `Log export (${format}) downloaded.`);
    } catch (error) {
      handleAuthFailure(error, 'Failed to export logs.');
    }
  };

  const downloadDiagnostics = async () => {
    if (!authHeaders) {
      return;
    }
    try {
      const response = await api.getLogDiagnostics({ headers: authHeaders, responseType: 'blob' });
      triggerBlobDownload(response.data as Blob, filenameFromResponse(response, 'tweets-2-bsky-diagnostics.json'));
      showNotice('success', 'Diagnostics bundle downloaded.');
    } catch (error) {
      handleAuthFailure(error, 'Failed to build the diagnostics bundle.');
    }
  };

  const clearLogs = async () => {
    if (!authHeaders) {
      return;
    }
    const confirmed = window.confirm('Delete every stored log entry? Exports you have already downloaded are kept.');
    if (!confirmed) {
      return;
    }
    try {
      const response = await api.clearLogs({ headers: authHeaders });
      showNotice('success', response.data?.message || 'Logs cleared.');
      await fetchLogs();
    } catch (error) {
      handleAuthFailure(error, 'Failed to clear logs.');
    }
  };

  return {
    expandedLogId,
    setExpandedLogId,
    logEntries,
    logHasMore,
    logLevelFilter,
    setLogLevelFilter,
    logStageFilter,
    setLogStageFilter,
    logSearch,
    setLogSearch,
    logLimit,
    setLogLimit,
    logsLoading,
    logAutoRefresh,
    setLogAutoRefresh,
    activityView,
    setActivityView,
    queueFailures,
    queueFailuresLoading,
    logQueryParams,
    fetchLogs,
    fetchQueueFailures,
    resolveMappingForActivity,
    filteredRecentActivity,
    retryFailedQueue,
    clearFailedQueue,
    copyLogsToClipboard,
    downloadLogs,
    downloadDiagnostics,
    clearLogs,
  };
}
