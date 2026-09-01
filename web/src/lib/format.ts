// Presentation helpers: turning API values into the strings and URLs the UI
// shows. No React and no state, so they can be unit tested directly.
import axios from 'axios';
import type { AccountMapping, ActivityLog, AppState, AuthUser, DashboardTab, LogEntry, UserPermissions } from '../types';
import { DEFAULT_GROUP_EMOJI, DEFAULT_GROUP_NAME, DEFAULT_USER_PERMISSIONS, FEDIVERSE_BRIDGE_MIN_AGE_MS, TAB_PATHS } from './constants';

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const serverMessage = error.response?.data?.error;
    if (typeof serverMessage === 'string' && serverMessage.length > 0) {
      return serverMessage;
    }
    if (typeof error.message === 'string' && error.message.length > 0) {
      return error.message;
    }
  }
  return fallback;
}

export function formatState(state: AppState): string {
  switch (state) {
    case 'checking':
      return 'Checking';
    case 'backfilling':
      return 'Backfilling';
    case 'pacing':
      return 'Pacing';
    case 'processing':
      return 'Processing';
    default:
      return 'Idle';
  }
}

// --- Log viewer helpers ---------------------------------------------------
export function formatLogEntryForExport(entry: LogEntry): string {
  const parts = [
    new Date(entry.ts).toISOString(),
    entry.level.toUpperCase().padEnd(5),
    `[${entry.stage}]`,
    entry.event,
  ];
  const scope: string[] = [];
  if (entry.twitterUsername) scope.push(`@${entry.twitterUsername}`);
  if (entry.bskyIdentifier) scope.push(`→${entry.bskyIdentifier}`);
  if (entry.twitterId) scope.push(`tweet=${entry.twitterId}`);
  if (typeof entry.attempt === 'number') scope.push(`attempt=${entry.attempt}`);
  if (typeof entry.durationMs === 'number') scope.push(`took=${entry.durationMs}ms`);
  if (scope.length > 0) parts.push(`(${scope.join(' ')})`);
  parts.push('-', entry.message);
  if (entry.error?.message) {
    const status = entry.error.status ? ` http=${entry.error.status}` : '';
    parts.push(`| error: ${entry.error.name || 'Error'}${status}: ${entry.error.message}`);
  }
  if (entry.detail && Object.keys(entry.detail).length > 0) {
    parts.push(`| detail: ${JSON.stringify(entry.detail)}`);
  }
  return parts.join(' ');
}

/** Reads the server's suggested filename out of Content-Disposition. */
export function filenameFromResponse(response: { headers: Record<string, any> }, fallback: string): string {
  const disposition = response.headers?.['content-disposition'];
  if (typeof disposition === 'string') {
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match?.[1]) return match[1];
  }
  return fallback;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Release the object URL once the download has had a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function formatRelativeTime(timestamp: number): string {
  const deltaMs = Date.now() - timestamp;
  const absMs = Math.abs(deltaMs);
  const suffix = deltaMs >= 0 ? 'ago' : 'from now';
  if (absMs < 60_000) return `${Math.max(1, Math.round(absMs / 1000))}s ${suffix}`;
  if (absMs < 3_600_000) return `${Math.round(absMs / 60_000)}m ${suffix}`;
  if (absMs < 86_400_000) return `${Math.round(absMs / 3_600_000)}h ${suffix}`;
  return `${Math.round(absMs / 86_400_000)}d ${suffix}`;
}

export function getBskyPostUrl(activity: ActivityLog): string | null {
  if (!activity.bsky_uri || !activity.bsky_identifier) {
    return null;
  }

  const postId = activity.bsky_uri.split('/').filter(Boolean).pop();
  if (!postId) {
    return null;
  }

  return `https://bsky.app/profile/${activity.bsky_identifier}/post/${postId}`;
}

export function normalizeTwitterUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function normalizeGroupName(value?: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || DEFAULT_GROUP_NAME;
}

export function normalizeGroupEmoji(value?: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || DEFAULT_GROUP_EMOJI;
}

export function getGroupKey(groupName?: string): string {
  return normalizeGroupName(groupName).toLowerCase();
}

export function getGroupMeta(groupName?: string, groupEmoji?: string) {
  const name = normalizeGroupName(groupName);
  const emoji = normalizeGroupEmoji(groupEmoji);
  return {
    key: getGroupKey(name),
    name,
    emoji,
  };
}

export function getMappingGroupMeta(mapping?: Pick<AccountMapping, 'groupName' | 'groupEmoji'>) {
  return getGroupMeta(mapping?.groupName, mapping?.groupEmoji);
}

export function getTwitterPostUrl(twitterUsername?: string, twitterId?: string): string | undefined {
  if (!twitterUsername || !twitterId) {
    return undefined;
  }
  return `https://x.com/${normalizeTwitterUsername(twitterUsername)}/status/${twitterId}`;
}

export function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

export function getTabFromPath(pathname: string): DashboardTab | null {
  const normalized = normalizePath(pathname);
  const entry = (Object.entries(TAB_PATHS) as Array<[DashboardTab, string]>).find(([, path]) => path === normalized);
  return entry ? entry[0] : null;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function getUserLabel(user?: Pick<AuthUser, 'username' | 'email'> | null): string {
  return user?.username || user?.email || 'user';
}

export function getProfileAgeMs(createdAt?: string): number | null {
  if (!createdAt) {
    return null;
  }
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Date.now() - parsed;
}

export function canBridgeToFediverse(createdAt?: string): boolean {
  const ageMs = getProfileAgeMs(createdAt);
  return ageMs !== null && ageMs >= FEDIVERSE_BRIDGE_MIN_AGE_MS;
}

export function normalizePermissions(permissions?: Partial<UserPermissions>): UserPermissions {
  return {
    ...DEFAULT_USER_PERMISSIONS,
    ...(permissions || {}),
  };
}

export function addTwitterUsernames(current: string[], value: string): string[] {
  const candidates = value
    .split(/[\s,]+/)
    .map(normalizeTwitterUsername)
    .filter((username) => username.length > 0);
  if (candidates.length === 0) {
    return current;
  }

  const seen = new Set(current.map(normalizeTwitterUsername));
  const next = [...current];
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    next.push(candidate);
  }

  return next;
}
