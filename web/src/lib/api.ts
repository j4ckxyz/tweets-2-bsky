// Every dashboard API endpoint, one function each. They wrap the global axios
// instance on purpose: the debug interceptors in useAuthSession and the per-call
// auth headers keep working exactly as before. Pass the same config you would
// pass to axios (headers, params, responseType, signal).
import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import type {
  AIConfig,
  AccountDetailResponse,
  AccountGroup,
  AccountHealthResponse,
  AccountMapping,
  ActivityLog,
  AuthUser,
  BlueskyCredentialValidation,
  BootstrapStatus,
  BskyProfileView,
  BulkAppendBotNameAllResult,
  BulkBotLabelAllResult,
  DiscoveryState,
  EnrichedPost,
  FediverseBridgeStatusView,
  LocalPostSearchResult,
  LogsResponse,
  ManagedUser,
  MirrorProfileSyncResult,
  PreviewResult,
  QueueFailuresResponse,
  RuntimeVersionInfo,
  StatusResponse,
  TwitterConfig,
  TwitterMirrorProfile,
  UpdateStatusInfo,
} from './types';

export const appendBotNameAll = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<BulkAppendBotNameAllResult>('/api/mappings/append-bot-name-all', data, config);
export const applyBotLabelAll = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<BulkBotLabelAllResult>('/api/mappings/bot-label-all', data, config);
export const bridgeToFediverse = (mappingId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<{ fediverseAddress?: string }>(`/api/mappings/${mappingId}/bridge-to-fediverse`, data, config);
export const cancelBackfill = (mappingId: string, config?: AxiosRequestConfig) =>
  axios.delete(`/api/backfill/${mappingId}`, config);
export const changeOwnEmail = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<{ token?: string; me?: AuthUser }>('/api/me/change-email', data, config);
export const changeOwnPassword = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post('/api/me/change-password', data, config);
export const clearAllBackfills = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post('/api/backfill/clear-all', data, config);
export const clearFailedQueue = (config?: AxiosRequestConfig) => axios.delete('/api/queue/failed', config);
export const clearLogs = (config?: AxiosRequestConfig) => axios.delete('/api/logs', config);
export const clearMappingCache = (mappingId: string, config?: AxiosRequestConfig) =>
  axios.delete(`/api/mappings/${mappingId}/cache`, config);
export const createGroup = (data?: unknown, config?: AxiosRequestConfig) => axios.post('/api/groups', data, config);
export const createMapping = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<AccountMapping>('/api/mappings', data, config);
export const createUser = (data?: unknown, config?: AxiosRequestConfig) => axios.post('/api/admin/users', data, config);
export const deleteAllPosts = (mappingId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<{ message: string }>(`/api/mappings/${mappingId}/delete-all-posts`, data, config);
export const deleteGroup = (groupKey: string, config?: AxiosRequestConfig) =>
  axios.delete<{ reassignedCount?: number }>(`/api/groups/${encodeURIComponent(groupKey)}`, config);
export const deleteMapping = (mappingId: string, config?: AxiosRequestConfig) =>
  axios.delete(`/api/mappings/${mappingId}`, config);
export const deleteUser = (userId: string, config?: AxiosRequestConfig) =>
  axios.delete(`/api/admin/users/${userId}`, config);
export const exportConfig = (config?: AxiosRequestConfig) => axios.get<Blob>('/api/config/export', config);
export const exportLogs = (query: string, config?: AxiosRequestConfig) =>
  axios.get(`/api/logs/export?${query}`, config);
export const getAccountDetail = (mappingId: string, config?: AxiosRequestConfig) =>
  axios.get<AccountDetailResponse>(`/api/accounts/${mappingId}`, config);
export const getAccountHealth = (config?: AxiosRequestConfig) =>
  axios.get<AccountHealthResponse>('/api/account-health', config);
export const getAiConfig = (config?: AxiosRequestConfig) => axios.get<AIConfig>('/api/ai-config', config);
export const getBootstrapStatus = (config?: AxiosRequestConfig) =>
  axios.get<BootstrapStatus>('/api/auth/bootstrap-status', config);
export const getBskyProfiles = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<Record<string, BskyProfileView>>('/api/bsky/profiles', data, config);
export const getDiscovery = (config?: AxiosRequestConfig) => axios.get<DiscoveryState>('/api/discovery', config);
export const getEnrichedPosts = (config?: AxiosRequestConfig) =>
  axios.get<EnrichedPost[]>('/api/posts/enriched?limit=36', config);
export const getFediverseBridgeStatuses = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<Record<string, FediverseBridgeStatusView>>('/api/mappings/fediverse-bridge-status', data, config);
export const getGroups = (config?: AxiosRequestConfig) => axios.get<AccountGroup[]>('/api/groups', config);
export const getLogDiagnostics = (config?: AxiosRequestConfig) => axios.get('/api/logs/diagnostics', config);
export const getLogs = (query: string, config?: AxiosRequestConfig) =>
  axios.get<LogsResponse>(`/api/logs?${query}`, config);
export const getMappings = (config?: AxiosRequestConfig) => axios.get<AccountMapping[]>('/api/mappings', config);
export const getMe = (config?: AxiosRequestConfig) => axios.get<AuthUser>('/api/me', config);
export const getQueueFailures = (config?: AxiosRequestConfig) =>
  axios.get<QueueFailuresResponse>('/api/queue/failures?limit=200', config);
export const getRecentActivity = (config?: AxiosRequestConfig) =>
  axios.get<ActivityLog[]>('/api/recent-activity?limit=20', config);
export const getStatus = (config?: AxiosRequestConfig) => axios.get<StatusResponse>('/api/status', config);
export const getTwitterConfig = (config?: AxiosRequestConfig) =>
  axios.get<TwitterConfig>('/api/twitter-config', config);
export const getTwitterProfile = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<TwitterMirrorProfile>('/api/onboarding/twitter-profile', data, config);
export const getUpdateStatus = (config?: AxiosRequestConfig) =>
  axios.get<UpdateStatusInfo>('/api/update-status', config);
export const getUsers = (config?: AxiosRequestConfig) => axios.get<ManagedUser[]>('/api/admin/users', config);
export const getVersion = (config?: AxiosRequestConfig) => axios.get<RuntimeVersionInfo>('/api/version', config);
export const importConfig = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post('/api/config/import', data, config);
export const login = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<{ token: string }>('/api/login', data, config);
export const previewMirror = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<PreviewResult>('/api/preview', data, config);
export const pullTwitterBio = (mappingId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<MirrorProfileSyncResult>(`/api/mappings/${mappingId}/pull-twitter-bio`, data, config);
export const recheckAccount = (mappingId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.post(`/api/mappings/${mappingId}/recheck-account`, data, config);
export const register = (data?: unknown, config?: AxiosRequestConfig) => axios.post('/api/register', data, config);
export const requestBackfill = (mappingId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.post(`/api/backfill/${mappingId}`, data, config);
export const resetUserPassword = (userId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.post(`/api/admin/users/${userId}/reset-password`, data, config);
export const retryFailedQueue = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post('/api/queue/retry-failed', data, config);
export const runNow = (data?: unknown, config?: AxiosRequestConfig) => axios.post('/api/run-now', data, config);
export const runUpdate = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<{ message?: string }>('/api/update', data, config);
export const saveAiConfig = (data?: unknown, config?: AxiosRequestConfig) => axios.post('/api/ai-config', data, config);
export const saveDiscovery = (data?: unknown, config?: AxiosRequestConfig) => axios.put('/api/discovery', data, config);
export const saveTwitterConfig = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post('/api/twitter-config', data, config);
export const searchPosts = (config?: AxiosRequestConfig) =>
  axios.get<LocalPostSearchResult[]>('/api/posts/search', config);
export const syncGroupDiscovery = (groupKey: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<{ message: string }>(`/api/groups/${encodeURIComponent(groupKey)}/discovery-sync`, data, config);
export const syncPin = (mappingId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.post(`/api/pin-sync/${mappingId}`, data, config);
export const syncProfileFromTwitter = <T = MirrorProfileSyncResult>(
  mappingId: string,
  data?: unknown,
  config?: AxiosRequestConfig,
) => axios.post<T>(`/api/mappings/${mappingId}/sync-profile-from-twitter`, data, config);
export const unjamAccount = (mappingId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.post(`/api/accounts/${mappingId}/unjam`, data, config);
export const updateGroup = (groupKey: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.put(`/api/groups/${encodeURIComponent(groupKey)}`, data, config);
export const updateMapping = (mappingId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.put(`/api/mappings/${mappingId}`, data, config);
export const updateUser = (userId: string, data?: unknown, config?: AxiosRequestConfig) =>
  axios.put(`/api/admin/users/${userId}`, data, config);
export const validateBskyCredentials = (data?: unknown, config?: AxiosRequestConfig) =>
  axios.post<BlueskyCredentialValidation>('/api/onboarding/bsky-credentials', data, config);
