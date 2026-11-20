import axios from 'axios';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  filenameFromResponse,
  formatLogEntryForExport,
  getMappingGroupMeta,
  normalizeTwitterUsername,
  triggerBlobDownload,
} from '../lib/format';
import type { ActivityLog, LogEntry, LogLevel, LogsResponse, QueueFailuresResponse } from '../lib/types';
import type { useAuthSession } from './useAuthSession';
import type { useDashboardData } from './useDashboardData';
import type { useDashboardState } from './useDashboardState';
import type { useNotice } from './useNotice';
import type { usePosts } from './usePosts';
import type { useRouting } from './useRouting';

// Activity tab: outcomes filter, system log viewer and the failed post queue.
export function useActivity(
  deps: Pick<
    ReturnType<typeof useDashboardState> &
      ReturnType<typeof useNotice> &
      ReturnType<typeof useAuthSession> &
      ReturnType<typeof useRouting> &
      ReturnType<typeof useDashboardData> &
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

  // System log viewer state (Activity tab → "System log").
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [logHasMore, setLogHasMore] = useState(false);
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | LogLevel>('all');
  const [logStageFilter, setLogStageFilter] = useState('all');
  const [logSearch, setLogSearch] = useState('');
  const [logLimit, setLogLimit] = useState(200);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logAutoRefresh, setLogAutoRefresh] = useState(true);
  const [activityView, setActivityView] = useState<'outcomes' | 'logs' | 'failures'>('outcomes');
  const [queueFailures, setQueueFailures] = useState<QueueFailuresResponse>({ summary: [], items: [] });
  const [queueFailuresLoading, setQueueFailuresLoading] = useState(false);

  // Filters live in one place so the viewer, the clipboard copy and the file
  // download always describe exactly the same set of entries.
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

  const fetchLogs = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!authHeaders) {
        return;
      }
      if (!options.silent) setLogsLoading(true);
      try {
        const params = new URLSearchParams(logQueryParams);
        params.set('limit', String(logLimit));
        const response = await axios.get<LogsResponse>(`/api/logs?${params.toString()}`, { headers: authHeaders });
        setLogEntries(response.data.entries || []);
        setLogHasMore(Boolean(response.data.hasMore));
      } catch (error) {
        handleAuthFailure(error, 'Failed to fetch logs.');
      } finally {
        if (!options.silent) setLogsLoading(false);
      }
    },
    [authHeaders, handleAuthFailure, logLimit, logQueryParams],
  );

  const fetchQueueFailures = useCallback(async () => {
    if (!authHeaders) {
      return;
    }
    setQueueFailuresLoading(true);
    try {
      const response = await axios.get<QueueFailuresResponse>('/api/queue/failures?limit=200', {
        headers: authHeaders,
      });
      setQueueFailures({ summary: response.data.summary || [], items: response.data.items || [] });
    } catch (error) {
      handleAuthFailure(error, 'Failed to fetch queue failures.');
    } finally {
      setQueueFailuresLoading(false);
    }
  }, [authHeaders, handleAuthFailure]);

  // The log viewer is only fetched while it is on screen. Refetch immediately
  // whenever a filter changes so the list always matches the controls.
  useEffect(() => {
    if (!token || activeTab !== 'activity' || activityView !== 'logs') {
      return;
    }
    void fetchLogs();
  }, [token, activeTab, activityView, fetchLogs]);

  useEffect(() => {
    if (!token || activeTab !== 'activity' || activityView !== 'logs' || !logAutoRefresh) {
      return;
    }
    // Silent refresh: no spinner, so a live tail does not flicker.
    const interval = window.setInterval(() => {
      void fetchLogs({ silent: true });
    }, 5000);
    return () => {
      window.clearInterval(interval);
    };
  }, [token, activeTab, activityView, logAutoRefresh, fetchLogs]);

  useEffect(() => {
    if (!token || activeTab !== 'activity' || activityView !== 'failures') {
      return;
    }
    void fetchQueueFailures();
  }, [token, activeTab, activityView, fetchQueueFailures]);
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
      const response = await axios.post('/api/queue/retry-failed', {}, { headers: authHeaders });
      showNotice('success', response.data?.message || 'Failed tweets requeued.');
      await fetchStatus();
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
      const response = await axios.delete('/api/queue/failed', { headers: authHeaders });
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
      const response = await axios.get(`/api/logs/export?${params.toString()}`, {
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
      const response = await axios.get('/api/logs/diagnostics', { headers: authHeaders, responseType: 'blob' });
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
      const response = await axios.delete('/api/logs', { headers: authHeaders });
      showNotice('success', response.data?.message || 'Logs cleared.');
      await fetchLogs();
    } catch (error) {
      handleAuthFailure(error, 'Failed to clear logs.');
    }
  };

  return {
    logEntries,
    setLogEntries,
    logHasMore,
    setLogHasMore,
    logLevelFilter,
    setLogLevelFilter,
    logStageFilter,
    setLogStageFilter,
    logSearch,
    setLogSearch,
    logLimit,
    setLogLimit,
    logsLoading,
    setLogsLoading,
    logAutoRefresh,
    setLogAutoRefresh,
    activityView,
    setActivityView,
    queueFailures,
    setQueueFailures,
    queueFailuresLoading,
    setQueueFailuresLoading,
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
