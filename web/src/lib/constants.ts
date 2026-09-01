// Fixed values the dashboard renders from: tab routes, default form state,
// permission options and the log level/stage vocabularies.
import type { DashboardTab, LogLevel, MappingFormState, UserFormState, UserPermissions } from '../types';

export const defaultMappingForm = (): MappingFormState => ({
  owner: '',
  bskyIdentifier: '',
  bskyPassword: '',
  bskyServiceUrl: 'https://bsky.social',
  groupName: '',
  groupEmoji: '📁',
  profileSyncSourceUsername: '',
});

export const defaultUserForm = (): UserFormState => ({
  username: '',
  email: '',
  password: '',
  isAdmin: false,
  permissions: { ...DEFAULT_USER_PERMISSIONS },
});

export const DEFAULT_GROUP_NAME = 'Ungrouped';
export const DEFAULT_GROUP_EMOJI = '📁';
export const DEFAULT_GROUP_KEY = 'ungrouped';
export const TAB_PATHS: Record<DashboardTab, string> = {
  overview: '/',
  accounts: '/accounts',
  posts: '/posts',
  activity: '/activity',
  settings: '/settings',
};
export const ADD_ACCOUNT_STEPS = ['Sources', 'Create', 'Bluesky', 'Verify & Create'] as const;
export const ADD_ACCOUNT_STEP_COUNT = ADD_ACCOUNT_STEPS.length;
export const ACCOUNT_SEARCH_MIN_SCORE = 22;
export const ACCOUNT_PAGE_SIZE_DEFAULT = 50;
export const DEFAULT_BACKFILL_LIMIT = 15;
export const FEDIVERSE_BRIDGE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  viewAllMappings: false,
  manageOwnMappings: true,
  manageAllMappings: false,
  manageGroups: false,
  queueBackfills: true,
  runNow: true,
};
export const PERMISSION_OPTIONS: Array<{
  key: keyof UserPermissions;
  label: string;
  help: string;
}> = [
  { key: 'viewAllMappings', label: 'View all mappings', help: 'See every mapped account, post, and activity row.' },
  { key: 'manageOwnMappings', label: 'Manage own mappings', help: 'Create, edit, and delete mappings this user owns.' },
  { key: 'manageAllMappings', label: 'Manage all mappings', help: 'Edit/delete mappings created by any user.' },
  { key: 'manageGroups', label: 'Manage groups', help: 'Create, rename, and delete account groups.' },
  { key: 'queueBackfills', label: 'Queue backfills', help: 'Queue backfills for mappings they can manage.' },
  { key: 'runNow', label: 'Run checks now', help: 'Trigger an immediate scheduler run.' },
];

export const selectClassName =
  'flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
export const LOG_LEVEL_BADGE: Record<LogLevel, string> = {
  debug: 'text-muted-foreground',
  info: 'text-sky-600 dark:text-sky-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

export const LOG_LEVEL_ROW: Record<LogLevel, string> = {
  debug: '',
  info: '',
  warn: 'bg-amber-500/5',
  error: 'bg-red-500/5',
};

// Every stage the backend emits, in rough pipeline order so the dropdown reads
// like the path a tweet actually takes.
export const LOG_STAGES = [
  'sweep',
  'twitter',
  'queue',
  'post',
  'media',
  'bluesky',
  'ai',
  'profile',
  'backfill',
  'system',
  'http',
  'auth',
] as const;

/**
 * Mirrors the server's text export line-for-line so copied and downloaded logs
 * are byte-identical for the same entries.
 */
