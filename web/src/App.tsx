import axios from 'axios';
import {
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  Folder,
  Heart,
  History,
  LayoutDashboard,
  Link2,
  Loader2,
  LogOut,
  MessageCircle,
  Moon,
  MoreHorizontal,
  Newspaper,
  Pin,
  Play,
  Plus,
  Quote,
  RefreshCw,
  Repeat2,
  Save,
  Settings2,
  Sun,
  SunMoon,
  Trash2,
  Upload,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from './components/ui/dropdown-menu';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { NavList } from './components/ui/nav-list';
import { cn } from './lib/utils';

type ThemeMode = 'system' | 'light' | 'dark';
type AuthView = 'login' | 'register';
type DashboardTab = 'overview' | 'accounts' | 'posts' | 'activity' | 'settings';
type SettingsSection = 'account' | 'system' | 'users' | 'twitter' | 'ai' | 'data';
type BulkAccountsAction =
  | 'sync_profiles'
  | 'pull_twitter_bio'
  | 'bridge_all'
  | 'apply_bot_label'
  | 'append_bot_name'
  | 'sync_pins';

type AppState = 'idle' | 'checking' | 'backfilling' | 'pacing' | 'processing';

interface AccountMapping {
  id: string;
  twitterUsernames: string[];
  bskyIdentifier: string;
  bskyPassword?: string;
  bskyServiceUrl?: string;
  enabled: boolean;
  owner?: string;
  groupName?: string;
  groupEmoji?: string;
  createdByUserId?: string;
  createdByLabel?: string;
  profileSyncSourceUsername?: string;
  lastProfileSyncAt?: string;
  lastMirroredDisplayName?: string;
  lastMirroredDescription?: string;
  lastMirroredAvatarUrl?: string;
  lastMirroredBannerUrl?: string;
  hasBotLabel?: boolean;
  createdByUser?: {
    id: string;
    username?: string;
    email?: string;
    role: 'admin' | 'user';
  };
}

interface AccountGroup {
  name: string;
  emoji?: string;
}

interface TwitterConfig {
  authToken: string;
  ct0: string;
  backupAuthToken?: string;
  backupCt0?: string;
}

interface AIConfig {
  provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface ActivityLog {
  twitter_id: string;
  twitter_username: string;
  bsky_identifier: string;
  tweet_text?: string;
  bsky_uri?: string;
  status: 'migrated' | 'skipped' | 'failed';
  created_at?: string;
}

interface BskyFacetFeatureLink {
  $type: 'app.bsky.richtext.facet#link';
  uri: string;
}

interface BskyFacetFeatureMention {
  $type: 'app.bsky.richtext.facet#mention';
  did: string;
}

interface BskyFacetFeatureTag {
  $type: 'app.bsky.richtext.facet#tag';
  tag: string;
}

type BskyFacetFeature = BskyFacetFeatureLink | BskyFacetFeatureMention | BskyFacetFeatureTag;

interface BskyFacet {
  index?: {
    byteStart?: number;
    byteEnd?: number;
  };
  features?: BskyFacetFeature[];
}

interface EnrichedPostMedia {
  type: 'image' | 'video' | 'external';
  url?: string;
  thumb?: string;
  alt?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
}

interface EnrichedPost {
  bskyUri: string;
  bskyCid?: string;
  bskyIdentifier: string;
  twitterId: string;
  twitterUsername: string;
  twitterUrl?: string;
  postUrl?: string;
  createdAt?: string;
  text: string;
  facets: BskyFacet[];
  author: {
    did?: string;
    handle: string;
    displayName?: string;
    avatar?: string;
  };
  stats: {
    likes: number;
    reposts: number;
    replies: number;
    quotes: number;
    engagement: number;
  };
  media: EnrichedPostMedia[];
}

interface LocalPostSearchResult {
  twitterId: string;
  twitterUsername: string;
  bskyIdentifier: string;
  tweetText?: string;
  bskyUri?: string;
  bskyCid?: string;
  createdAt?: string;
  postUrl?: string;
  twitterUrl?: string;
  score: number;
}

interface BskyProfileView {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
  description?: string;
  createdAt?: string;
}

interface FediverseBridgeStatusView {
  bridged: boolean;
  checkedAt: string;
  error?: string;
}

interface PendingBackfill {
  id: string;
  limit?: number;
  queuedAt: number;
  sequence: number;
  requestId: string;
  position: number;
}

interface StatusState {
  state: AppState;
  currentAccount?: string;
  processedCount?: number;
  totalCount?: number;
  message?: string;
  backfillMappingId?: string;
  backfillRequestId?: string;
  lastUpdate: number;
}

type ActiveJobKind = 'checking' | 'mirroring' | 'backfilling' | 'profile-sync' | 'pin-sync';

interface ActiveJobView {
  id: string;
  kind: ActiveJobKind;
  account?: string;
  target?: string;
  message?: string;
  processedCount?: number;
  totalCount?: number;
  startedAt: number;
  updatedAt: number;
}

const JOB_KIND_LABEL: Record<string, string> = {
  checking: 'Checking',
  mirroring: 'Mirroring',
  backfilling: 'Backfilling',
  'profile-sync': 'Profile sync',
  'pin-sync': 'Pin sync',
};

const JOB_KIND_DOT: Record<string, string> = {
  checking: 'bg-sky-500',
  mirroring: 'bg-emerald-500',
  backfilling: 'bg-amber-500',
  'profile-sync': 'bg-violet-500',
  'pin-sync': 'bg-pink-500',
};

interface StatusResponse {
  lastCheckTime: number;
  nextCheckTime: number;
  nextCheckMinutes: number;
  checkIntervalMinutes: number;
  pendingBackfills: PendingBackfill[];
  currentStatus: StatusState;
  activeJobs?: ActiveJobView[];
}

interface UserPermissions {
  viewAllMappings: boolean;
  manageOwnMappings: boolean;
  manageAllMappings: boolean;
  manageGroups: boolean;
  queueBackfills: boolean;
  runNow: boolean;
}

interface AuthUser {
  id: string;
  username?: string;
  email?: string;
  isAdmin: boolean;
  permissions: UserPermissions;
}

interface ManagedUser {
  id: string;
  username?: string;
  email?: string;
  role: 'admin' | 'user';
  isAdmin: boolean;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
  mappingCount: number;
  activeMappingCount: number;
  mappings: AccountMapping[];
}

interface TwitterMirrorProfile {
  username: string;
  profileUrl: string;
  name?: string;
  biography?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  mirroredDisplayName: string;
  mirroredDescription: string;
}

interface BlueskyCredentialValidation {
  did: string;
  handle: string;
  email?: string;
  emailConfirmed: boolean;
  serviceUrl: string;
  settingsUrl: string;
}

interface MirrorProfileSyncResult {
  success: boolean;
  twitterProfile: TwitterMirrorProfile;
  bsky: BlueskyCredentialValidation;
  avatarSynced: boolean;
  bannerSynced: boolean;
  skipped?: boolean;
  changed?: {
    displayName: boolean;
    description: boolean;
    avatar: boolean;
    banner: boolean;
  };
  warnings: string[];
  sourceTwitterUsername?: string;
  mapping?: AccountMapping;
}

interface BulkBotLabelAllResult {
  success: boolean;
  total: number;
  labeled: number;
  alreadyLabeled: number;
  failed: number;
  failedMappings?: Array<{
    id: string;
    bskyIdentifier: string;
    error: string;
  }>;
  mappings?: AccountMapping[];
}

interface BulkAppendBotNameAllResult {
  success: boolean;
  total: number;
  appended: number;
  alreadyAppended: number;
  failed: number;
  failedMappings?: Array<{
    id: string;
    bskyIdentifier: string;
    error: string;
  }>;
  mappings?: AccountMapping[];
}

interface BootstrapStatus {
  bootstrapOpen: boolean;
}

interface RuntimeVersionInfo {
  version: string;
  commit?: string;
  branch?: string;
  startedAt: number;
}

interface UpdateStatusInfo {
  running: boolean;
  pid?: number;
  startedAt?: number;
  startedBy?: string;
  finishedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  logFile?: string;
  logTail?: string[];
}

interface Notice {
  tone: 'success' | 'error' | 'info';
  message: string;
}

interface MappingFormState {
  owner: string;
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl: string;
  groupName: string;
  groupEmoji: string;
  profileSyncSourceUsername: string;
}

interface UserFormState {
  username: string;
  email: string;
  password: string;
  isAdmin: boolean;
  permissions: UserPermissions;
}

interface AccountSecurityEmailState {
  currentEmail: string;
  newEmail: string;
  password: string;
}

interface AccountSecurityPasswordState {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

const defaultMappingForm = (): MappingFormState => ({
  owner: '',
  bskyIdentifier: '',
  bskyPassword: '',
  bskyServiceUrl: 'https://bsky.social',
  groupName: '',
  groupEmoji: '📁',
  profileSyncSourceUsername: '',
});

const defaultUserForm = (): UserFormState => ({
  username: '',
  email: '',
  password: '',
  isAdmin: false,
  permissions: { ...DEFAULT_USER_PERMISSIONS },
});

const DEFAULT_GROUP_NAME = 'Ungrouped';
const DEFAULT_GROUP_EMOJI = '📁';
const DEFAULT_GROUP_KEY = 'ungrouped';
const TAB_PATHS: Record<DashboardTab, string> = {
  overview: '/',
  accounts: '/accounts',
  posts: '/posts',
  activity: '/activity',
  settings: '/settings',
};
const ADD_ACCOUNT_STEPS = ['Sources', 'Create', 'Bluesky', 'Verify & Create'] as const;
const ADD_ACCOUNT_STEP_COUNT = ADD_ACCOUNT_STEPS.length;
const ACCOUNT_SEARCH_MIN_SCORE = 22;
const ACCOUNT_PAGE_SIZE_DEFAULT = 50;
const DEFAULT_BACKFILL_LIMIT = 15;
const FEDIVERSE_BRIDGE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  viewAllMappings: false,
  manageOwnMappings: true,
  manageAllMappings: false,
  manageGroups: false,
  queueBackfills: true,
  runNow: true,
};
const PERMISSION_OPTIONS: Array<{
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

const selectClassName =
  'flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

function getApiErrorMessage(error: unknown, fallback: string): string {
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

function formatState(state: AppState): string {
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

function getBskyPostUrl(activity: ActivityLog): string | null {
  if (!activity.bsky_uri || !activity.bsky_identifier) {
    return null;
  }

  const postId = activity.bsky_uri.split('/').filter(Boolean).pop();
  if (!postId) {
    return null;
  }

  return `https://bsky.app/profile/${activity.bsky_identifier}/post/${postId}`;
}

function normalizeTwitterUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function normalizeGroupName(value?: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || DEFAULT_GROUP_NAME;
}

function normalizeGroupEmoji(value?: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || DEFAULT_GROUP_EMOJI;
}

function getGroupKey(groupName?: string): string {
  return normalizeGroupName(groupName).toLowerCase();
}

function getGroupMeta(groupName?: string, groupEmoji?: string) {
  const name = normalizeGroupName(groupName);
  const emoji = normalizeGroupEmoji(groupEmoji);
  return {
    key: getGroupKey(name),
    name,
    emoji,
  };
}

function getMappingGroupMeta(mapping?: Pick<AccountMapping, 'groupName' | 'groupEmoji'>) {
  return getGroupMeta(mapping?.groupName, mapping?.groupEmoji);
}

function getTwitterPostUrl(twitterUsername?: string, twitterId?: string): string | undefined {
  if (!twitterUsername || !twitterId) {
    return undefined;
  }
  return `https://x.com/${normalizeTwitterUsername(twitterUsername)}/status/${twitterId}`;
}

function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

function getTabFromPath(pathname: string): DashboardTab | null {
  const normalized = normalizePath(pathname);
  const entry = (Object.entries(TAB_PATHS) as Array<[DashboardTab, string]>).find(([, path]) => path === normalized);
  return entry ? entry[0] : null;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function getUserLabel(user?: Pick<AuthUser, 'username' | 'email'>): string {
  return user?.username || user?.email || 'user';
}

function getProfileAgeMs(createdAt?: string): number | null {
  if (!createdAt) {
    return null;
  }
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Date.now() - parsed;
}

function canBridgeToFediverse(createdAt?: string): boolean {
  const ageMs = getProfileAgeMs(createdAt);
  return ageMs !== null && ageMs >= FEDIVERSE_BRIDGE_MIN_AGE_MS;
}

function normalizePermissions(permissions?: Partial<UserPermissions>): UserPermissions {
  return {
    ...DEFAULT_USER_PERMISSIONS,
    ...(permissions || {}),
  };
}

function addTwitterUsernames(current: string[], value: string): string[] {
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

function normalizeSearchValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9@#._\-\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchValue(value: string): string[] {
  if (!value) {
    return [];
  }
  return value.split(' ').filter((token) => token.length > 0);
}

function orderedSubsequenceScore(query: string, candidate: string): number {
  if (!query || !candidate) {
    return 0;
  }

  let matched = 0;
  let searchIndex = 0;
  for (const char of query) {
    const foundIndex = candidate.indexOf(char, searchIndex);
    if (foundIndex === -1) {
      continue;
    }
    matched += 1;
    searchIndex = foundIndex + 1;
  }

  return matched / query.length;
}

function buildBigrams(value: string): Set<string> {
  const result = new Set<string>();
  if (value.length < 2) {
    if (value.length === 1) {
      result.add(value);
    }
    return result;
  }
  for (let i = 0; i < value.length - 1; i += 1) {
    result.add(value.slice(i, i + 2));
  }
  return result;
}

function diceCoefficient(a: string, b: string): number {
  const aBigrams = buildBigrams(a);
  const bBigrams = buildBigrams(b);
  if (aBigrams.size === 0 || bBigrams.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const gram of aBigrams) {
    if (bBigrams.has(gram)) {
      overlap += 1;
    }
  }
  return (2 * overlap) / (aBigrams.size + bBigrams.size);
}

function scoreSearchField(query: string, tokens: string[], candidateValue?: string): number {
  const candidate = normalizeSearchValue(candidateValue || '');
  if (!query || !candidate) {
    return 0;
  }

  let score = 0;
  if (candidate === query) {
    score += 170;
  } else if (candidate.startsWith(query)) {
    score += 138;
  } else if (candidate.includes(query)) {
    score += 108;
  }

  let matchedTokens = 0;
  for (const token of tokens) {
    if (candidate.includes(token)) {
      matchedTokens += 1;
      score += token.length >= 4 ? 18 : 12;
    }
  }
  if (tokens.length > 0) {
    score += (matchedTokens / tokens.length) * 46;
  }

  score += orderedSubsequenceScore(query, candidate) * 45;
  score += diceCoefficient(query, candidate) * 52;
  return score;
}

function scoreAccountMapping(mapping: AccountMapping, query: string, tokens: string[]): number {
  const usernameScores = mapping.twitterUsernames.map((username) => scoreSearchField(query, tokens, username) * 1.24);
  const bestUsernameScore = usernameScores.length > 0 ? Math.max(...usernameScores) : 0;
  const identifierScore = scoreSearchField(query, tokens, mapping.bskyIdentifier) * 1.2;
  const ownerScore = scoreSearchField(query, tokens, mapping.owner) * 0.92;
  const groupScore = scoreSearchField(query, tokens, mapping.groupName) * 0.72;
  const combined = [bestUsernameScore, identifierScore, ownerScore, groupScore];
  const maxScore = Math.max(...combined);
  return maxScore + (combined.reduce((total, value) => total + value, 0) - maxScore) * 0.24;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const compactNumberFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

type FacetSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'mention'; text: string; href: string }
  | { type: 'tag'; text: string; href: string };

function sliceByBytes(bytes: Uint8Array, start: number, end: number): string {
  return textDecoder.decode(bytes.slice(start, end));
}

function buildFacetSegments(text: string, facets: BskyFacet[]): FacetSegment[] {
  const bytes = textEncoder.encode(text);
  const sortedFacets = [...facets].sort((a, b) => (a.index?.byteStart || 0) - (b.index?.byteStart || 0));
  const segments: FacetSegment[] = [];
  let cursor = 0;

  for (const facet of sortedFacets) {
    const start = Number(facet.index?.byteStart);
    const end = Number(facet.index?.byteEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < cursor || end <= start || end > bytes.length) continue;

    if (start > cursor) {
      segments.push({ type: 'text', text: sliceByBytes(bytes, cursor, start) });
    }

    const rawText = sliceByBytes(bytes, start, end);
    const feature = facet.features?.[0];
    if (!feature) {
      segments.push({ type: 'text', text: rawText });
    } else if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
      segments.push({ type: 'link', text: rawText, href: feature.uri });
    } else if (feature.$type === 'app.bsky.richtext.facet#mention' && feature.did) {
      segments.push({ type: 'mention', text: rawText, href: `https://bsky.app/profile/${feature.did}` });
    } else if (feature.$type === 'app.bsky.richtext.facet#tag' && feature.tag) {
      segments.push({
        type: 'tag',
        text: rawText,
        href: `https://bsky.app/hashtag/${encodeURIComponent(feature.tag)}`,
      });
    } else {
      segments.push({ type: 'text', text: rawText });
    }

    cursor = end;
  }

  if (cursor < bytes.length) {
    segments.push({ type: 'text', text: sliceByBytes(bytes, cursor, bytes.length) });
  }

  if (segments.length === 0) {
    return [{ type: 'text', text }];
  }

  return segments;
}

function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(Math.max(0, value));
}

function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [authView, setAuthView] = useState<AuthView>('login');
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('theme-mode');
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
    return 'system';
  });
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light');

  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [enrichedPosts, setEnrichedPosts] = useState<EnrichedPost[]>([]);
  const [profilesByActor, setProfilesByActor] = useState<Record<string, BskyProfileView>>({});
  const [twitterConfig, setTwitterConfig] = useState<TwitterConfig>({ authToken: '', ct0: '' });
  const [aiConfig, setAiConfig] = useState<AIConfig>({ provider: 'gemini', apiKey: '', model: '', baseUrl: '' });
  const [recentActivity, setRecentActivity] = useState<ActivityLog[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState<RuntimeVersionInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusInfo | null>(null);
  const [countdown, setCountdown] = useState('--');
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => {
    const fromPath = getTabFromPath(window.location.pathname);
    if (fromPath) {
      return fromPath;
    }

    const saved = localStorage.getItem('dashboard-tab');
    if (
      saved === 'overview' ||
      saved === 'accounts' ||
      saved === 'posts' ||
      saved === 'activity' ||
      saved === 'settings'
    ) {
      return saved;
    }
    return 'overview';
  });

  const [me, setMe] = useState<AuthUser | null>(null);
  const [editingMapping, setEditingMapping] = useState<AccountMapping | null>(null);
  const [newMapping, setNewMapping] = useState<MappingFormState>(defaultMappingForm);
  const [newTwitterUsers, setNewTwitterUsers] = useState<string[]>([]);
  const [newTwitterInput, setNewTwitterInput] = useState('');
  const [newTwitterMirrorProfiles, setNewTwitterMirrorProfiles] = useState<Record<string, TwitterMirrorProfile>>({});
  const [selectedMirrorSourceUsername, setSelectedMirrorSourceUsername] = useState('');
  const [validatedBskyCredentials, setValidatedBskyCredentials] = useState<BlueskyCredentialValidation | null>(null);
  const [isMirrorPreviewLoading, setIsMirrorPreviewLoading] = useState(false);
  const [isCredentialValidationBusy, setIsCredentialValidationBusy] = useState(false);
  const [syncingProfileMappingId, setSyncingProfileMappingId] = useState<string | null>(null);
  const [pullingBioMappingId, setPullingBioMappingId] = useState<string | null>(null);
  const [isSyncAllProfilesBusy, setIsSyncAllProfilesBusy] = useState(false);
  const [isPullBioAllBusy, setIsPullBioAllBusy] = useState(false);
  const [isBotLabelAllBusy, setIsBotLabelAllBusy] = useState(false);
  const [isAppendBotNameAllBusy, setIsAppendBotNameAllBusy] = useState(false);
  const [bridgingMappingId, setBridgingMappingId] = useState<string | null>(null);
  const [isBridgeAllBusy, setIsBridgeAllBusy] = useState(false);
  const [bridgeAllProgress, setBridgeAllProgress] = useState<{
    currentHandle: string;
    completed: number;
    total: number;
  } | null>(null);
  const [fediverseBridgeStatusByMappingId, setFediverseBridgeStatusByMappingId] = useState<
    Record<string, FediverseBridgeStatusView>
  >({});
  const [editForm, setEditForm] = useState<MappingFormState>(defaultMappingForm);
  const [editTwitterUsers, setEditTwitterUsers] = useState<string[]>([]);
  const [editTwitterInput, setEditTwitterInput] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupEmoji, setNewGroupEmoji] = useState(DEFAULT_GROUP_EMOJI);
  const [isAddAccountSheetOpen, setIsAddAccountSheetOpen] = useState(false);
  const [addAccountStep, setAddAccountStep] = useState(1);
  const [settingsActiveSection, setSettingsActiveSection] = useState<SettingsSection>('account');
  const [selectedFolderKey, setSelectedFolderKey] = useState('__all__');
  const [accountsSearchQuery, setAccountsSearchQuery] = useState('');
  const [accountsPage, setAccountsPage] = useState(1);
  const [accountsPageSize, setAccountsPageSize] = useState(ACCOUNT_PAGE_SIZE_DEFAULT);
  const [selectedAccountMappingIds, setSelectedAccountMappingIds] = useState<string[]>([]);
  const [showAccountAvatars, setShowAccountAvatars] = useState(false);
  const [showAccountBios, setShowAccountBios] = useState(false);
  const [postsGroupFilter, setPostsGroupFilter] = useState('all');
  const [postsSearchQuery, setPostsSearchQuery] = useState('');
  const [localPostSearchResults, setLocalPostSearchResults] = useState<LocalPostSearchResult[]>([]);
  const [isSearchingLocalPosts, setIsSearchingLocalPosts] = useState(false);
  const [activityGroupFilter, setActivityGroupFilter] = useState('all');
  const [groupDraftsByKey, setGroupDraftsByKey] = useState<Record<string, { name: string; emoji: string }>>({});
  const [isGroupActionBusy, setIsGroupActionBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [managedUsers, setManagedUsers] = useState<ManagedUser[]>([]);
  const [accountsCreatorFilter, setAccountsCreatorFilter] = useState('all');
  const [newUserForm, setNewUserForm] = useState<UserFormState>(defaultUserForm);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingUserForm, setEditingUserForm] = useState<UserFormState>(defaultUserForm);
  const [emailForm, setEmailForm] = useState<AccountSecurityEmailState>({
    currentEmail: '',
    newEmail: '',
    password: '',
  });
  const [passwordForm, setPasswordForm] = useState<AccountSecurityPasswordState>({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  const [isBusy, setIsBusy] = useState(false);
  const [isUpdateBusy, setIsUpdateBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  const noticeTimerRef = useRef<number | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const postsSearchRequestRef = useRef(0);
  const statusRequestRef = useRef(0);
  const statusMutationRef = useRef(0);
  const fediverseBridgeStatusByMappingIdRef = useRef<Record<string, FediverseBridgeStatusView>>({});
  const bridgeStatusFetchRef = useRef<Promise<Record<string, FediverseBridgeStatusView> | null> | null>(null);

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

  const showNotice = useCallback((tone: Notice['tone'], message: string) => {
    setNotice({ tone, message });
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
    }, 4200);
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token');
    setToken(null);
    setMe(null);
    setMappings([]);
    setGroups([]);
    setEnrichedPosts([]);
    setProfilesByActor({});
    setStatus(null);
    setRuntimeVersion(null);
    setUpdateStatus(null);
    setRecentActivity([]);
    setEditingMapping(null);
    setNewTwitterUsers([]);
    setNewTwitterMirrorProfiles({});
    setSelectedMirrorSourceUsername('');
    setValidatedBskyCredentials(null);
    setIsMirrorPreviewLoading(false);
    setIsCredentialValidationBusy(false);
    setSyncingProfileMappingId(null);
    setIsSyncAllProfilesBusy(false);
    setBridgingMappingId(null);
    setIsBridgeAllBusy(false);
    setBridgeAllProgress(null);
    setFediverseBridgeStatusByMappingId({});
    setEditTwitterUsers([]);
    setNewGroupName('');
    setNewGroupEmoji(DEFAULT_GROUP_EMOJI);
    setIsAddAccountSheetOpen(false);
    setAddAccountStep(1);
    setSettingsActiveSection('account');
    setAccountsSearchQuery('');
    setPostsSearchQuery('');
    setLocalPostSearchResults([]);
    setIsSearchingLocalPosts(false);
    setGroupDraftsByKey({});
    setIsGroupActionBusy(false);
    setIsUpdateBusy(false);
    setManagedUsers([]);
    setAccountsCreatorFilter('all');
    setNewUserForm(defaultUserForm());
    setEditingUserId(null);
    setEditingUserForm(defaultUserForm());
    setEmailForm({ currentEmail: '', newEmail: '', password: '' });
    setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    postsSearchRequestRef.current = 0;
    setAuthView('login');
  }, []);

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

  useEffect(() => {
    fediverseBridgeStatusByMappingIdRef.current = fediverseBridgeStatusByMappingId;
  }, [fediverseBridgeStatusByMappingId]);

  const fetchBootstrapStatus = useCallback(async () => {
    try {
      const response = await axios.get<BootstrapStatus>('/api/auth/bootstrap-status');
      setBootstrapOpen(Boolean(response.data?.bootstrapOpen));
    } catch {
      setBootstrapOpen(false);
    }
  }, []);

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
  }, [authHeaders, handleAuthFailure]);

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
  }, [authHeaders, handleAuthFailure]);

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
  }, [authHeaders, handleAuthFailure]);

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
  }, [authHeaders, handleAuthFailure]);

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
  }, [authHeaders, handleAuthFailure]);

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
  }, [authHeaders, handleAuthFailure, isAdmin]);

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
  }, [authHeaders, handleAuthFailure, isAdmin]);

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
    [authHeaders, handleAuthFailure],
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
    [authHeaders, handleLogout],
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
    ],
  );

  useEffect(() => {
    localStorage.setItem('theme-mode', themeMode);
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem('dashboard-tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    const expectedPath = TAB_PATHS[activeTab];
    const currentPath = normalizePath(window.location.pathname);
    if (currentPath !== expectedPath) {
      window.history.pushState({ tab: activeTab }, '', expectedPath);
    }
  }, [activeTab]);

  useEffect(() => {
    const onPopState = () => {
      const tabFromPath = getTabFromPath(window.location.pathname);
      if (tabFromPath) {
        setActiveTab(tabFromPath);
      } else {
        setActiveTab('overview');
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = () => {
      const next = themeMode === 'system' ? (media.matches ? 'dark' : 'light') : themeMode;
      setResolvedTheme(next);
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(next);
    };

    applyTheme();
    media.addEventListener('change', applyTheme);

    return () => {
      media.removeEventListener('change', applyTheme);
    };
  }, [themeMode]);

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
    if (!bootstrapOpen && authView === 'register') {
      setAuthView('login');
    }
  }, [authView, bootstrapOpen]);

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

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isAddAccountSheetOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAddAccountSheet();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isAddAccountSheetOpen]);

  useEffect(() => {
    if (newTwitterUsers.length === 0) {
      setSelectedMirrorSourceUsername('');
      return;
    }

    const normalizedSelected = normalizeTwitterUsername(selectedMirrorSourceUsername);
    const hasSelected = newTwitterUsers.some((username) => normalizeTwitterUsername(username) === normalizedSelected);
    if (!hasSelected) {
      setSelectedMirrorSourceUsername(newTwitterUsers[0] || '');
    }
  }, [newTwitterUsers, selectedMirrorSourceUsername]);

  useEffect(() => {
    if (!editingMapping) {
      return;
    }

    const candidates = [
      ...new Set(editTwitterUsers.map(normalizeTwitterUsername).filter((username) => username.length > 0)),
    ];
    const selected = normalizeTwitterUsername(editForm.profileSyncSourceUsername || '');
    if (candidates.length === 0) {
      if (editForm.profileSyncSourceUsername !== '') {
        setEditForm((previous) => ({ ...previous, profileSyncSourceUsername: '' }));
      }
      return;
    }

    if (candidates.includes(selected)) {
      return;
    }

    const next = candidates[0] || '';
    if (editForm.profileSyncSourceUsername !== next) {
      setEditForm((previous) => ({ ...previous, profileSyncSourceUsername: next }));
    }
  }, [editForm.profileSyncSourceUsername, editTwitterUsers, editingMapping]);

  useEffect(() => {
    setValidatedBskyCredentials(null);
  }, [newMapping.bskyIdentifier, newMapping.bskyPassword, newMapping.bskyServiceUrl]);

  const pendingBackfills = status?.pendingBackfills ?? [];
  const activeJobs = status?.activeJobs ?? [];
  const currentStatus = status?.currentStatus;
  const latestActivity = recentActivity[0];
  const selectedMirrorPreview = selectedMirrorSourceUsername
    ? newTwitterMirrorProfiles[normalizeTwitterUsername(selectedMirrorSourceUsername)]
    : undefined;
  const dashboardTabs = useMemo(
    () => [
      {
        id: 'overview' as DashboardTab,
        label: 'Overview',
        icon: LayoutDashboard,
        description: 'Status, recent activity, and top performers.',
      },
      {
        id: 'accounts' as DashboardTab,
        label: 'Accounts',
        icon: Users,
        description: 'Manage Twitter-to-Bluesky mappings and folders.',
      },
      {
        id: 'posts' as DashboardTab,
        label: 'Posts',
        icon: Newspaper,
        description: 'Search and browse crossposted content.',
      },
      { id: 'activity' as DashboardTab, label: 'Activity', icon: History, description: 'Recent migration log.' },
      {
        id: 'settings' as DashboardTab,
        label: 'Settings',
        icon: Settings2,
        description: 'Account, credentials, users, and data management.',
      },
    ],
    [],
  );
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
  const groupOptions = useMemo(() => {
    const options = new Map<string, { key: string; name: string; emoji: string }>();
    for (const group of groups) {
      const meta = getGroupMeta(group.name, group.emoji);
      if (meta.key === DEFAULT_GROUP_KEY) {
        continue;
      }
      options.set(meta.key, meta);
    }
    for (const mapping of mappings) {
      const group = getMappingGroupMeta(mapping);
      options.set(group.key, options.get(group.key) || group);
    }
    return [...options.values()].sort((a, b) => {
      const aUngrouped = a.name === DEFAULT_GROUP_NAME;
      const bUngrouped = b.name === DEFAULT_GROUP_NAME;
      if (aUngrouped && !bUngrouped) return 1;
      if (!aUngrouped && bUngrouped) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [groups, mappings]);
  const groupOptionsByKey = useMemo(() => new Map(groupOptions.map((group) => [group.key, group])), [groupOptions]);
  const reusableGroupOptions = useMemo(
    () => groupOptions.filter((group) => group.key !== DEFAULT_GROUP_KEY),
    [groupOptions],
  );
  const managedUsersById = useMemo(() => new Map(managedUsers.map((user) => [user.id, user])), [managedUsers]);
  const accountMappingsForView = useMemo(() => {
    if (!isAdmin || accountsCreatorFilter === 'all') {
      return mappings;
    }
    return mappings.filter((mapping) => mapping.createdByUserId === accountsCreatorFilter);
  }, [accountsCreatorFilter, isAdmin, mappings]);
  const botLabeledMappingsForView = useMemo(
    () => accountMappingsForView.filter((mapping) => mapping.hasBotLabel === true),
    [accountMappingsForView],
  );
  const isAnyBulkAccountsActionBusy =
    isSyncAllProfilesBusy ||
    isPullBioAllBusy ||
    isBridgeAllBusy ||
    isBotLabelAllBusy ||
    isAppendBotNameAllBusy ||
    Boolean(syncingProfileMappingId) ||
    Boolean(pullingBioMappingId) ||
    Boolean(bridgingMappingId);
  const bridgedMappingsForView = useMemo(
    () =>
      [...accountMappingsForView]
        .filter((mapping) => fediverseBridgeStatusByMappingId[mapping.id]?.bridged === true)
        .sort((a, b) => a.bskyIdentifier.localeCompare(b.bskyIdentifier)),
    [accountMappingsForView, fediverseBridgeStatusByMappingId],
  );
  const bridgeEligibleUnbridgedMappings = useMemo(
    () =>
      accountMappingsForView
        .filter(
          (mapping) =>
            canManageAllMappings ||
            (canManageOwnMappings && (!mapping.createdByUserId || mapping.createdByUserId === me?.id)),
        )
        .filter((mapping) => {
          const bridgeStatus = fediverseBridgeStatusByMappingId[mapping.id];
          if (!bridgeStatus || bridgeStatus.error) {
            return false;
          }
          if (bridgeStatus.bridged === true) {
            return false;
          }
          const profile = profilesByActor[normalizeTwitterUsername(mapping.bskyIdentifier)];
          return canBridgeToFediverse(profile?.createdAt);
        }),
    [
      accountMappingsForView,
      canManageAllMappings,
      canManageOwnMappings,
      fediverseBridgeStatusByMappingId,
      me?.id,
      profilesByActor,
    ],
  );
  const groupedMappings = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; emoji: string; mappings: AccountMapping[] }>();
    for (const option of groupOptions) {
      groups.set(option.key, {
        ...option,
        mappings: [],
      });
    }
    for (const mapping of accountMappingsForView) {
      const group = getMappingGroupMeta(mapping);
      const existing = groups.get(group.key);
      if (!existing) {
        groups.set(group.key, { ...group, mappings: [mapping] });
        continue;
      }
      existing.mappings.push(mapping);
    }

    return [...groups.values()]
      .sort((a, b) => {
        const aUngrouped = a.name === DEFAULT_GROUP_NAME;
        const bUngrouped = b.name === DEFAULT_GROUP_NAME;
        if (aUngrouped && !bUngrouped) return 1;
        if (!aUngrouped && bUngrouped) return -1;
        return a.name.localeCompare(b.name);
      })
      .map((group) => ({
        ...group,
        mappings: [...group.mappings].sort((a, b) =>
          `${(a.owner || '').toLowerCase()}-${a.bskyIdentifier.toLowerCase()}`.localeCompare(
            `${(b.owner || '').toLowerCase()}-${b.bskyIdentifier.toLowerCase()}`,
          ),
        ),
      }));
  }, [accountMappingsForView, groupOptions]);
  const deferredAccountsSearchQuery = useDeferredValue(accountsSearchQuery);
  const normalizedAccountsQuery = useMemo(
    () => normalizeSearchValue(deferredAccountsSearchQuery),
    [deferredAccountsSearchQuery],
  );
  const accountSearchTokens = useMemo(() => tokenizeSearchValue(normalizedAccountsQuery), [normalizedAccountsQuery]);
  const accountSearchScores = useMemo(() => {
    const scores = new Map<string, number>();
    if (!normalizedAccountsQuery) {
      return scores;
    }

    for (const mapping of accountMappingsForView) {
      scores.set(mapping.id, scoreAccountMapping(mapping, normalizedAccountsQuery, accountSearchTokens));
    }
    return scores;
  }, [accountMappingsForView, accountSearchTokens, normalizedAccountsQuery]);
  const filteredGroupedMappings = useMemo(() => {
    const hasQuery = normalizedAccountsQuery.length > 0;
    const sortByScore = (items: AccountMapping[]) => {
      if (!hasQuery) {
        return items;
      }
      return [...items].sort((a, b) => {
        const scoreDelta = (accountSearchScores.get(b.id) || 0) - (accountSearchScores.get(a.id) || 0);
        if (scoreDelta !== 0) return scoreDelta;
        return `${(a.owner || '').toLowerCase()}-${a.bskyIdentifier.toLowerCase()}`.localeCompare(
          `${(b.owner || '').toLowerCase()}-${b.bskyIdentifier.toLowerCase()}`,
        );
      });
    };

    const withSearch = groupedMappings
      .map((group) => {
        const mappingsForGroup = hasQuery
          ? group.mappings.filter((mapping) => (accountSearchScores.get(mapping.id) || 0) >= ACCOUNT_SEARCH_MIN_SCORE)
          : group.mappings;
        return {
          ...group,
          mappings: sortByScore(mappingsForGroup),
        };
      })
      .filter((group) => !hasQuery || group.mappings.length > 0);

    if (selectedFolderKey !== '__all__') {
      const match = withSearch.find((group) => group.key === selectedFolderKey);
      return match ? [match] : [];
    }

    const allMappings = sortByScore(
      hasQuery
        ? accountMappingsForView.filter(
            (mapping) => (accountSearchScores.get(mapping.id) || 0) >= ACCOUNT_SEARCH_MIN_SCORE,
          )
        : [...accountMappingsForView].sort((a, b) =>
            `${(a.owner || '').toLowerCase()}-${a.bskyIdentifier.toLowerCase()}`.localeCompare(
              `${(b.owner || '').toLowerCase()}-${b.bskyIdentifier.toLowerCase()}`,
            ),
          ),
    );

    return [
      {
        key: '__all__',
        name: hasQuery ? 'Search Results' : 'All Accounts',
        emoji: hasQuery ? '🔎' : '🌐',
        mappings: allMappings,
      },
    ];
  }, [accountMappingsForView, accountSearchScores, selectedFolderKey, groupedMappings, normalizedAccountsQuery]);
  const accountMatchesCount = useMemo(
    () => filteredGroupedMappings.reduce((total, group) => total + group.mappings.length, 0),
    [filteredGroupedMappings],
  );
  const paginatedMappings = useMemo(
    () => filteredGroupedMappings.flatMap((group) => group.mappings),
    [filteredGroupedMappings],
  );
  const accountsPageCount = useMemo(
    () => Math.max(1, Math.ceil(paginatedMappings.length / Math.max(1, accountsPageSize))),
    [accountsPageSize, paginatedMappings.length],
  );
  useEffect(() => {
    setAccountsPage(1);
  }, [accountsPageSize, accountsSearchQuery, selectedFolderKey, accountsCreatorFilter]);
  useEffect(() => {
    if (accountsPage > accountsPageCount) {
      setAccountsPage(accountsPageCount);
    }
  }, [accountsPage, accountsPageCount]);
  const pagedMappingIdSet = useMemo(() => {
    const safePageSize = Math.max(1, accountsPageSize);
    const start = Math.max(0, (accountsPage - 1) * safePageSize);
    const end = start + safePageSize;
    return new Set(paginatedMappings.slice(start, end).map((mapping) => mapping.id));
  }, [accountsPage, accountsPageSize, paginatedMappings]);
  const pagedGroupedMappings = useMemo(
    () =>
      filteredGroupedMappings
        .map((group) => ({
          ...group,
          mappings: group.mappings.filter((mapping) => pagedMappingIdSet.has(mapping.id)),
        }))
        .filter((group) => group.mappings.length > 0),
    [filteredGroupedMappings, pagedMappingIdSet],
  );
  const currentAccountsPageStart =
    accountMatchesCount === 0 ? 0 : (accountsPage - 1) * Math.max(1, accountsPageSize) + 1;
  const currentAccountsPageEnd =
    accountMatchesCount === 0 ? 0 : Math.min(accountMatchesCount, accountsPage * Math.max(1, accountsPageSize));
  const resolveMappingForLocalPost = useCallback(
    (post: LocalPostSearchResult) =>
      mappingsByBskyIdentifier.get(normalizeTwitterUsername(post.bskyIdentifier)) ||
      mappingsByTwitterUsername.get(normalizeTwitterUsername(post.twitterUsername)),
    [mappingsByBskyIdentifier, mappingsByTwitterUsername],
  );
  const resolveMappingForPost = useCallback(
    (post: EnrichedPost) =>
      mappingsByBskyIdentifier.get(normalizeTwitterUsername(post.bskyIdentifier)) ||
      mappingsByTwitterUsername.get(normalizeTwitterUsername(post.twitterUsername)),
    [mappingsByBskyIdentifier, mappingsByTwitterUsername],
  );
  const resolveMappingForActivity = useCallback(
    (activity: ActivityLog) =>
      mappingsByBskyIdentifier.get(normalizeTwitterUsername(activity.bsky_identifier)) ||
      mappingsByTwitterUsername.get(normalizeTwitterUsername(activity.twitter_username)),
    [mappingsByBskyIdentifier, mappingsByTwitterUsername],
  );
  const filteredPostedActivity = useMemo(
    () =>
      postedActivity.filter((post) => {
        if (postsGroupFilter === 'all') return true;
        const mapping = resolveMappingForPost(post);
        return getMappingGroupMeta(mapping).key === postsGroupFilter;
      }),
    [postedActivity, postsGroupFilter, resolveMappingForPost],
  );
  const filteredLocalPostSearchResults = useMemo(
    () =>
      localPostSearchResults.filter((post) => {
        if (postsGroupFilter === 'all') return true;
        const mapping = resolveMappingForLocalPost(post);
        return getMappingGroupMeta(mapping).key === postsGroupFilter;
      }),
    [localPostSearchResults, postsGroupFilter, resolveMappingForLocalPost],
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
  const canManageMapping = useCallback(
    (mapping: AccountMapping) =>
      canManageAllMappings ||
      (canManageOwnMappings && (!mapping.createdByUserId || mapping.createdByUserId === me?.id)),
    [canManageAllMappings, canManageOwnMappings, me?.id],
  );
  const manageableAccountMappingsForView = useMemo(
    () => accountMappingsForView.filter((mapping) => canManageMapping(mapping)),
    [accountMappingsForView, canManageMapping],
  );
  const manageableMappingIdsForView = useMemo(
    () => new Set(manageableAccountMappingsForView.map((mapping) => mapping.id)),
    [manageableAccountMappingsForView],
  );
  const selectedAccountMappingIdSet = useMemo(() => new Set(selectedAccountMappingIds), [selectedAccountMappingIds]);
  const selectedManageableMappingsForView = useMemo(
    () => manageableAccountMappingsForView.filter((mapping) => selectedAccountMappingIdSet.has(mapping.id)),
    [manageableAccountMappingsForView, selectedAccountMappingIdSet],
  );
  const selectedManageableMappingsCount = selectedManageableMappingsForView.length;
  const filteredManageableMappingIds = useMemo(() => {
    const seen = new Set<string>();
    for (const group of pagedGroupedMappings) {
      for (const mapping of group.mappings) {
        if (seen.has(mapping.id) || !canManageMapping(mapping)) {
          continue;
        }
        seen.add(mapping.id);
      }
    }
    return [...seen];
  }, [canManageMapping, pagedGroupedMappings]);
  const allFilteredManageableSelected =
    filteredManageableMappingIds.length > 0 &&
    filteredManageableMappingIds.every((mappingId) => selectedAccountMappingIdSet.has(mappingId));
  useEffect(() => {
    setSelectedAccountMappingIds((previous) => {
      const next = previous.filter((mappingId) => manageableMappingIdsForView.has(mappingId));
      if (next.length === previous.length) {
        return previous;
      }
      return next;
    });
  }, [manageableMappingIdsForView]);
  const twitterConfigured = Boolean(twitterConfig.authToken && twitterConfig.ct0);
  const aiConfigured = Boolean(aiConfig.apiKey);
  const settingsNavItems = useMemo(
    () => [
      { id: 'account' as SettingsSection, label: 'Account', icon: UserRound },
      ...(isAdmin
        ? [
            { id: 'system' as SettingsSection, label: 'System', icon: Settings2 },
            { id: 'users' as SettingsSection, label: 'Users', icon: Users },
            {
              id: 'twitter' as SettingsSection,
              label: 'Twitter',
              icon: Bot,
              badge: (
                <Badge variant={twitterConfigured ? 'success' : 'outline'} className="ml-auto">
                  {twitterConfigured ? 'On' : 'Off'}
                </Badge>
              ),
            },
            {
              id: 'ai' as SettingsSection,
              label: 'AI',
              icon: SunMoon,
              badge: (
                <Badge variant={aiConfigured ? 'success' : 'outline'} className="ml-auto">
                  {aiConfigured ? 'On' : 'Off'}
                </Badge>
              ),
            },
            { id: 'data' as SettingsSection, label: 'Data', icon: Download },
          ]
        : []),
    ],
    [aiConfigured, isAdmin, twitterConfigured],
  );

  useEffect(() => {
    if (postsGroupFilter !== 'all' && !groupOptions.some((group) => group.key === postsGroupFilter)) {
      setPostsGroupFilter('all');
    }
    if (activityGroupFilter !== 'all' && !groupOptions.some((group) => group.key === activityGroupFilter)) {
      setActivityGroupFilter('all');
    }
  }, [activityGroupFilter, groupOptions, postsGroupFilter]);

  useEffect(() => {
    if (!isAdmin) {
      if (accountsCreatorFilter !== 'all') {
        setAccountsCreatorFilter('all');
      }
      return;
    }

    if (accountsCreatorFilter !== 'all' && !managedUsers.some((user) => user.id === accountsCreatorFilter)) {
      setAccountsCreatorFilter('all');
    }
  }, [accountsCreatorFilter, isAdmin, managedUsers]);

  useEffect(() => {
    setGroupDraftsByKey((previous) => {
      const next: Record<string, { name: string; emoji: string }> = {};
      for (const group of reusableGroupOptions) {
        const existing = previous[group.key];
        next[group.key] = {
          name: existing?.name ?? group.name,
          emoji: existing?.emoji ?? group.emoji,
        };
      }
      return next;
    });
  }, [reusableGroupOptions]);

  useEffect(() => {
    if (!authHeaders) {
      setIsSearchingLocalPosts(false);
      setLocalPostSearchResults([]);
      return;
    }

    const query = postsSearchQuery.trim();
    if (!query) {
      postsSearchRequestRef.current += 1;
      setIsSearchingLocalPosts(false);
      setLocalPostSearchResults([]);
      return;
    }

    const requestId = postsSearchRequestRef.current + 1;
    postsSearchRequestRef.current = requestId;
    setIsSearchingLocalPosts(true);

    const timer = window.setTimeout(async () => {
      try {
        const response = await axios.get<LocalPostSearchResult[]>('/api/posts/search', {
          params: { q: query, limit: 120 },
          headers: authHeaders,
        });
        if (postsSearchRequestRef.current !== requestId) {
          return;
        }
        setLocalPostSearchResults(Array.isArray(response.data) ? response.data : []);
      } catch (error) {
        if (postsSearchRequestRef.current !== requestId) {
          return;
        }
        setLocalPostSearchResults([]);
        handleAuthFailure(error, 'Failed to search local post history.');
      } finally {
        if (postsSearchRequestRef.current === requestId) {
          setIsSearchingLocalPosts(false);
        }
      }
    }, 220);

    return () => {
      window.clearTimeout(timer);
    };
  }, [authHeaders, handleAuthFailure, postsSearchQuery]);

  const isBackfillQueued = useCallback(
    (mappingId: string) => pendingBackfills.some((entry) => entry.id === mappingId),
    [pendingBackfills],
  );

  const getBackfillEntry = useCallback(
    (mappingId: string) => pendingBackfills.find((entry) => entry.id === mappingId),
    [pendingBackfills],
  );

  const isBackfillActive = useCallback(
    (mappingId: string) => currentStatus?.state === 'backfilling' && currentStatus.backfillMappingId === mappingId,
    [currentStatus],
  );

  const progressPercent = useMemo(() => {
    if (!currentStatus?.totalCount || currentStatus.totalCount <= 0) {
      return 0;
    }
    const processed = currentStatus.processedCount || 0;
    return Math.max(0, Math.min(100, Math.round((processed / currentStatus.totalCount) * 100)));
  }, [currentStatus]);

  const cycleThemeMode = () => {
    setThemeMode((prev) => {
      if (prev === 'system') return 'light';
      if (prev === 'light') return 'dark';
      return 'system';
    });
  };

  const themeIcon =
    themeMode === 'system' ? (
      <SunMoon className="h-4 w-4" />
    ) : themeMode === 'light' ? (
      <Sun className="h-4 w-4" />
    ) : (
      <Moon className="h-4 w-4" />
    );

  const themeLabel = themeMode === 'system' ? `Theme: system (${resolvedTheme})` : `Theme: ${themeMode}`;
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

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError('');
    setIsBusy(true);

    const data = new FormData(event.currentTarget);
    const identifier = String(data.get('identifier') || '').trim();
    const password = String(data.get('password') || '');

    try {
      const response = await axios.post<{ token: string }>('/api/login', { identifier, password });
      localStorage.setItem('token', response.data.token);
      setToken(response.data.token);
      showNotice('success', 'Logged in.');
    } catch (error) {
      setAuthError(getApiErrorMessage(error, 'Invalid credentials.'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleRegister = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError('');
    setIsBusy(true);

    const data = new FormData(event.currentTarget);
    const username = String(data.get('username') || '').trim();
    const email = String(data.get('email') || '').trim();
    const password = String(data.get('password') || '');

    try {
      await axios.post('/api/register', { username, email, password });
      setAuthView('login');
      showNotice('success', 'Registration successful. Please log in.');
      await fetchBootstrapStatus();
    } catch (error) {
      setAuthError(getApiErrorMessage(error, 'Registration failed.'));
    } finally {
      setIsBusy(false);
    }
  };

  const runNow = async () => {
    if (!authHeaders) {
      return;
    }
    if (!canRunNowPermission) {
      showNotice('error', 'You do not have permission to run checks now.');
      return;
    }

    try {
      statusMutationRef.current += 1;
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              nextCheckTime: Date.now() + 1000,
              currentStatus: {
                ...previous.currentStatus,
                state: 'checking',
                message: 'Manual run requested...',
                lastUpdate: Date.now(),
                backfillMappingId: undefined,
                backfillRequestId: undefined,
              },
            }
          : previous,
      );
      await axios.post('/api/run-now', {}, { headers: authHeaders });
      showNotice('info', 'Check triggered.');
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to trigger a check.');
    }
  };

  const clearAllBackfills = async () => {
    if (!authHeaders) {
      return;
    }

    const confirmed = window.confirm('Stop all pending and active backfills?');
    if (!confirmed) {
      return;
    }

    try {
      statusMutationRef.current += 1;
      setStatus((previous) =>
        previous
          ? {
              ...previous,
              pendingBackfills: [],
              currentStatus: {
                ...previous.currentStatus,
                state: 'idle',
                message: 'Backfill queue cleared',
                backfillMappingId: undefined,
                backfillRequestId: undefined,
                lastUpdate: Date.now(),
              },
            }
          : previous,
      );
      await axios.post('/api/backfill/clear-all', {}, { headers: authHeaders });
      showNotice('success', 'Backfill queue cleared.');
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to clear backfill queue.');
    }
  };

  const cancelQueuedBackfill = async (mappingId: string) => {
    if (!authHeaders) {
      return;
    }

    const mapping = mappings.find((entry) => entry.id === mappingId);
    if (!mapping || !canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to cancel this queue entry.');
      return;
    }

    try {
      statusMutationRef.current += 1;
      setStatus((previous) => {
        if (!previous) {
          return previous;
        }

        const nextPending = previous.pendingBackfills
          .filter((entry) => entry.id !== mappingId)
          .map((entry, index) => ({ ...entry, position: index + 1 }));
        return {
          ...previous,
          pendingBackfills: nextPending,
        };
      });
      await axios.delete(`/api/backfill/${mappingId}`, { headers: authHeaders });
      showNotice('success', 'Queue entry cancelled.');
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to cancel queue entry.');
    }
  };

  const requestBackfill = async (mappingId: string, mode: 'normal' | 'reset') => {
    if (!authHeaders) {
      return;
    }
    const mapping = mappings.find((entry) => entry.id === mappingId);
    if (!mapping || !canQueueBackfillsPermission || !canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to queue backfill for this account.');
      return;
    }

    const busy = pendingBackfills.length > 0 || currentStatus?.state === 'backfilling';
    if (busy) {
      const proceed = window.confirm(
        'Backfill is already queued or active. This request will replace the existing queue item for this account. Continue?',
      );
      if (!proceed) {
        return;
      }
    }
    const safeLimit = DEFAULT_BACKFILL_LIMIT;

    try {
      if (mode === 'reset') {
        if (!isAdmin) {
          showNotice('error', 'Only admins can reset cache before backfill.');
          return;
        }
        await axios.delete(`/api/mappings/${mappingId}/cache`, { headers: authHeaders });
      }

      statusMutationRef.current += 1;
      setStatus((previous) => {
        if (!previous) {
          return previous;
        }

        const now = Date.now();
        const existing = previous.pendingBackfills.filter((entry) => entry.id !== mappingId);
        const nextPending = [
          ...existing,
          {
            id: mappingId,
            limit: safeLimit,
            queuedAt: now,
            sequence: now,
            requestId: `ui-${now}`,
            position: existing.length + 1,
          },
        ].map((entry, index) => ({ ...entry, position: index + 1 }));

        return {
          ...previous,
          pendingBackfills: nextPending,
        };
      });
      await axios.post(`/api/backfill/${mappingId}`, { limit: safeLimit }, { headers: authHeaders });
      showNotice(
        'success',
        mode === 'reset'
          ? `Cache reset and backfill queued (${safeLimit} tweets).`
          : `Backfill queued (${safeLimit} tweets).`,
      );
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to queue backfill.');
    }
  };

  const requestPinSync = async (mappingId: string) => {
    if (!authHeaders) {
      return;
    }
    const mapping = mappings.find((entry) => entry.id === mappingId);
    if (!mapping || !canQueueBackfillsPermission || !canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to sync pins for this account.');
      return;
    }

    try {
      await axios.post(`/api/pin-sync/${mappingId}`, {}, { headers: authHeaders });
      showNotice('success', 'Pin sync queued. The pinned tweet will be mirrored and pinned on Bluesky.');
      await fetchStatus();
    } catch (error) {
      handleAuthFailure(error, 'Failed to queue pin sync.');
    }
  };

  const handleDeleteAllPosts = async (mappingId: string) => {
    if (!authHeaders) {
      return;
    }

    const firstConfirm = window.confirm(
      'Danger: this deletes all posts on the mapped Bluesky account and clears local cache. Continue?',
    );

    if (!firstConfirm) {
      return;
    }

    const finalConfirm = window.prompt('Type DELETE to confirm:');
    if (finalConfirm !== 'DELETE') {
      return;
    }

    try {
      const response = await axios.post<{ message: string }>(
        `/api/mappings/${mappingId}/delete-all-posts`,
        {},
        { headers: authHeaders },
      );
      showNotice('success', response.data.message);
    } catch (error) {
      handleAuthFailure(error, 'Failed to delete posts.');
    }
  };

  const handleDeleteMapping = async (mappingId: string) => {
    if (!authHeaders) {
      return;
    }
    const mapping = mappings.find((entry) => entry.id === mappingId);
    if (!mapping || !canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to delete this mapping.');
      return;
    }

    const confirmed = window.confirm('Delete this mapping?');
    if (!confirmed) {
      return;
    }

    try {
      await axios.delete(`/api/mappings/${mappingId}`, { headers: authHeaders });
      setMappings((prev) => prev.filter((mapping) => mapping.id !== mappingId));
      setFediverseBridgeStatusByMappingId((previous) => {
        if (!(mappingId in previous)) {
          return previous;
        }
        const next = { ...previous };
        delete next[mappingId];
        return next;
      });
      showNotice('success', 'Mapping deleted.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to delete mapping.');
    }
  };

  const resolveProfileSyncSource = (mapping: AccountMapping, silent = false): string | null => {
    const candidates = [
      ...new Set(mapping.twitterUsernames.map(normalizeTwitterUsername).filter((value) => value.length > 0)),
    ];
    if (candidates.length === 0) {
      if (!silent) {
        showNotice('error', 'Mapping has no Twitter source usernames.');
      }
      return null;
    }

    const selected = normalizeTwitterUsername(mapping.profileSyncSourceUsername || '');
    if (selected && candidates.includes(selected)) {
      return selected;
    }

    if (!silent && candidates.length > 1) {
      showNotice('info', `Using @${candidates[0] || ''} as the default profile sync source.`);
    }

    return candidates[0] || null;
  };

  const syncProfileFromTwitterForMapping = async (
    mapping: AccountMapping,
    options?: {
      confirm?: boolean;
      showNoticeOnResult?: boolean;
      refreshAfter?: boolean;
    },
  ): Promise<{ ok: boolean; skipped: boolean }> => {
    if (!authHeaders) {
      return { ok: false, skipped: false };
    }
    if (!canManageMapping(mapping)) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('error', 'You do not have permission to update this mapping.');
      }
      return { ok: false, skipped: false };
    }

    const sourceTwitterUsername = resolveProfileSyncSource(mapping, options?.showNoticeOnResult === false);
    if (!sourceTwitterUsername) {
      return { ok: false, skipped: false };
    }

    if (options?.confirm !== false) {
      const confirmed = window.confirm(
        `Sync profile from @${sourceTwitterUsername}? This updates display name, bio, avatar, and banner only when the Twitter profile changed.`,
      );
      if (!confirmed) {
        return { ok: false, skipped: false };
      }
    }

    setSyncingProfileMappingId(mapping.id);
    try {
      const response = await axios.post<MirrorProfileSyncResult>(
        `/api/mappings/${mapping.id}/sync-profile-from-twitter`,
        { sourceTwitterUsername },
        { headers: authHeaders },
      );

      const result = response.data;
      const warnings = result?.warnings || [];
      const skipped = Boolean(result?.skipped);

      if (result?.mapping) {
        setMappings((previous) => previous.map((entry) => (entry.id === mapping.id ? result.mapping || entry : entry)));
      }

      if (options?.showNoticeOnResult !== false) {
        if (skipped) {
          showNotice('info', `No profile changes detected for @${sourceTwitterUsername}.`);
        } else if (warnings.length > 0) {
          showNotice(
            'info',
            `Profile synced from @${sourceTwitterUsername} with ${warnings.length} warning(s). First warning: ${warnings[0]}`,
          );
        } else {
          showNotice('success', `Profile synced from @${sourceTwitterUsername}.`);
        }
      }

      if (options?.refreshAfter !== false) {
        await fetchData();
      }

      return { ok: true, skipped };
    } catch (error) {
      if (options?.showNoticeOnResult !== false) {
        handleAuthFailure(error, 'Failed to sync profile from Twitter.');
      }
      return { ok: false, skipped: false };
    } finally {
      setSyncingProfileMappingId((previous) => (previous === mapping.id ? null : previous));
    }
  };

  const handleSyncProfileFromTwitter = async (mapping: AccountMapping) => {
    await syncProfileFromTwitterForMapping(mapping, {
      confirm: true,
      showNoticeOnResult: true,
      refreshAfter: true,
    });
  };

  const pullTwitterBioForMapping = async (
    mapping: AccountMapping,
    options?: {
      confirm?: boolean;
      showNoticeOnResult?: boolean;
      refreshAfter?: boolean;
    },
  ): Promise<{ ok: boolean; skipped: boolean }> => {
    if (!authHeaders) {
      return { ok: false, skipped: false };
    }
    if (!canManageMapping(mapping)) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('error', 'You do not have permission to update this mapping.');
      }
      return { ok: false, skipped: false };
    }

    const sourceTwitterUsername = resolveProfileSyncSource(mapping, options?.showNoticeOnResult === false);
    if (!sourceTwitterUsername) {
      return { ok: false, skipped: false };
    }

    if (options?.confirm !== false) {
      const confirmed = window.confirm(
        `Pull Twitter bio from @${sourceTwitterUsername}? This updates only the bio/description on Bluesky.`,
      );
      if (!confirmed) {
        return { ok: false, skipped: false };
      }
    }

    setPullingBioMappingId(mapping.id);
    try {
      const response = await axios.post<MirrorProfileSyncResult>(
        `/api/mappings/${mapping.id}/pull-twitter-bio`,
        { sourceTwitterUsername },
        { headers: authHeaders },
      );

      const result = response.data;
      const warnings = result?.warnings || [];
      const skipped = Boolean(result?.skipped);

      if (result?.mapping) {
        setMappings((previous) => previous.map((entry) => (entry.id === mapping.id ? result.mapping || entry : entry)));
      }

      if (options?.showNoticeOnResult !== false) {
        if (skipped) {
          showNotice('info', `No bio changes detected for @${sourceTwitterUsername}.`);
        } else if (warnings.length > 0) {
          showNotice(
            'info',
            `Bio pulled from @${sourceTwitterUsername} with ${warnings.length} warning(s). First warning: ${warnings[0]}`,
          );
        } else {
          showNotice('success', `Bio pulled from @${sourceTwitterUsername}.`);
        }
      }

      if (options?.refreshAfter !== false) {
        await fetchData();
      }

      return { ok: true, skipped };
    } catch (error) {
      if (options?.showNoticeOnResult !== false) {
        handleAuthFailure(error, 'Failed to pull Twitter bio.');
      }
      return { ok: false, skipped: false };
    } finally {
      setPullingBioMappingId((previous) => (previous === mapping.id ? null : previous));
    }
  };

  const handlePullTwitterBio = async (mapping: AccountMapping) => {
    await pullTwitterBioForMapping(mapping, {
      confirm: true,
      showNoticeOnResult: true,
      refreshAfter: true,
    });
  };

  const resolveBulkAccountTargets = (_actionLabel: string): AccountMapping[] => {
    if (selectedManageableMappingsForView.length > 0) {
      return selectedManageableMappingsForView;
    }
    return manageableAccountMappingsForView;
  };

  const handleSyncAllProfilesFromTwitter = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isBridgeAllBusy) {
      showNotice('info', 'Bridge-all is currently running. Please wait.');
      return;
    }

    const candidates =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (candidates.length === 0) {
      showNotice('info', 'No accounts available for profile sync.');
      return;
    }

    const confirmed = window.confirm(`Sync Twitter profile data for ${candidates.length} account(s), one at a time?`);
    if (!confirmed) {
      return;
    }

    setIsSyncAllProfilesBusy(true);
    let syncedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    try {
      for (const mapping of candidates) {
        const outcome = await syncProfileFromTwitterForMapping(mapping, {
          confirm: false,
          showNoticeOnResult: false,
          refreshAfter: false,
        });

        if (!outcome.ok) {
          failedCount += 1;
          continue;
        }
        if (outcome.skipped) {
          skippedCount += 1;
        } else {
          syncedCount += 1;
        }
      }

      await fetchData();
      showNotice(
        failedCount > 0 ? 'info' : 'success',
        `Sync all complete: ${syncedCount} updated, ${skippedCount} unchanged, ${failedCount} failed.`,
      );
    } finally {
      setIsSyncAllProfilesBusy(false);
    }
  };

  const handlePullTwitterBioForAccounts = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isAnyBulkAccountsActionBusy) {
      showNotice('info', 'A bulk accounts action is already running. Please wait.');
      return;
    }

    const candidates =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (candidates.length === 0) {
      showNotice('info', 'No accounts available for Twitter bio pull.');
      return;
    }

    const confirmed = window.confirm(
      `Pull Twitter bio for ${candidates.length} account(s), one at a time? This updates only Bluesky description.`,
    );
    if (!confirmed) {
      return;
    }

    setIsPullBioAllBusy(true);
    let syncedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    try {
      for (const mapping of candidates) {
        const outcome = await pullTwitterBioForMapping(mapping, {
          confirm: false,
          showNoticeOnResult: false,
          refreshAfter: false,
        });

        if (!outcome.ok) {
          failedCount += 1;
          continue;
        }
        if (outcome.skipped) {
          skippedCount += 1;
        } else {
          syncedCount += 1;
        }
      }

      await fetchData();
      showNotice(
        failedCount > 0 ? 'info' : 'success',
        `Pull bio complete: ${syncedCount} updated, ${skippedCount} unchanged, ${failedCount} failed.`,
      );
    } finally {
      setIsPullBioAllBusy(false);
    }
  };

  const handleAddBotLabelToAllAccounts = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isAnyBulkAccountsActionBusy) {
      showNotice('info', 'Profile or bridge actions are running. Please wait.');
      return;
    }

    const candidates =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (candidates.length === 0) {
      showNotice('info', 'No accounts available for bot label update.');
      return;
    }

    const confirmed = window.confirm(
      `Add Bluesky automated-account bot label to ${candidates.length} account(s)? This appends the bot self-label to each app.bsky.actor.profile record.`,
    );
    if (!confirmed) {
      return;
    }

    setIsBotLabelAllBusy(true);
    try {
      const response = await axios.post<BulkBotLabelAllResult>(
        '/api/mappings/bot-label-all',
        { mappingIds: candidates.map((mapping) => mapping.id) },
        { headers: authHeaders },
      );
      const result = response.data;
      await fetchData();
      const firstFailure = result.failedMappings?.[0];
      showNotice(
        result.failed > 0 ? 'info' : 'success',
        `Bot label update complete: ${result.labeled} added, ${result.alreadyLabeled} already labeled, ${result.failed} failed.${
          firstFailure ? ` First failure: ${firstFailure.bskyIdentifier} (${firstFailure.error})` : ''
        }`,
      );
    } catch (error) {
      handleAuthFailure(error, 'Failed to add bot labels to accounts.');
    } finally {
      setIsBotLabelAllBusy(false);
    }
  };

  const handleAppendBotNameToAllAccounts = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isAnyBulkAccountsActionBusy) {
      showNotice('info', 'A bulk accounts action is already running. Please wait.');
      return;
    }

    const candidates =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (candidates.length === 0) {
      showNotice('info', 'No accounts available for display-name suffix update.');
      return;
    }

    const confirmed = window.confirm(
      `Refresh display names from Twitter and append {bot} for ${candidates.length} account(s)? Legacy {UNOFFICIAL} will be removed.`,
    );
    if (!confirmed) {
      return;
    }

    setIsAppendBotNameAllBusy(true);
    try {
      const response = await axios.post<BulkAppendBotNameAllResult>(
        '/api/mappings/append-bot-name-all',
        { mappingIds: candidates.map((mapping) => mapping.id) },
        { headers: authHeaders },
      );
      const result = response.data;
      await fetchData();
      const firstFailure = result.failedMappings?.[0];
      showNotice(
        result.failed > 0 ? 'info' : 'success',
        `Display-name append complete: ${result.appended} updated, ${result.alreadyAppended} already set, ${result.failed} failed.${
          firstFailure ? ` First failure: ${firstFailure.bskyIdentifier} (${firstFailure.error})` : ''
        }`,
      );
    } catch (error) {
      handleAuthFailure(error, 'Failed to append {bot} to account display names.');
    } finally {
      setIsAppendBotNameAllBusy(false);
    }
  };

  const handleSyncPinsForAccounts = async (targets: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (!canQueueBackfillsPermission) {
      showNotice('error', 'You do not have permission to sync pins.');
      return;
    }

    let queued = 0;
    let failed = 0;
    for (const mapping of targets) {
      try {
        await axios.post(`/api/pin-sync/${mapping.id}`, {}, { headers: authHeaders });
        queued += 1;
      } catch {
        failed += 1;
      }
    }

    if (queued > 0) {
      showNotice(
        'success',
        `Pin sync queued for ${queued} account(s)${failed > 0 ? ` (${failed} failed to queue)` : ''}. Pinned tweets will be mirrored and pinned on Bluesky.`,
      );
    } else {
      showNotice('error', 'Failed to queue pin sync for the selected accounts.');
    }
    await fetchStatus();
  };

  const handleApplyAllAccountsAction = async (action: BulkAccountsAction) => {
    const actionLabel =
      action === 'sync_profiles'
        ? 'profile sync'
        : action === 'pull_twitter_bio'
          ? 'Twitter bio pull'
          : action === 'bridge_all'
            ? 'fediverse bridge'
            : action === 'apply_bot_label'
              ? 'bot label update'
              : action === 'sync_pins'
                ? 'pinned tweet sync'
                : 'display-name suffix update';
    const targets = resolveBulkAccountTargets(actionLabel);
    if (targets.length === 0) {
      return;
    }

    if (action === 'sync_profiles') {
      await handleSyncAllProfilesFromTwitter(targets);
      return;
    }
    if (action === 'pull_twitter_bio') {
      await handlePullTwitterBioForAccounts(targets);
      return;
    }
    if (action === 'bridge_all') {
      await handleBridgeAllEligible(targets);
      return;
    }
    if (action === 'apply_bot_label') {
      await handleAddBotLabelToAllAccounts(targets);
      return;
    }
    if (action === 'sync_pins') {
      await handleSyncPinsForAccounts(targets);
      return;
    }
    await handleAppendBotNameToAllAccounts(targets);
  };

  const toggleAccountMappingSelection = (mappingId: string, checked: boolean) => {
    setSelectedAccountMappingIds((previous) => {
      if (checked) {
        if (previous.includes(mappingId)) {
          return previous;
        }
        return [...previous, mappingId];
      }
      return previous.filter((id) => id !== mappingId);
    });
  };

  const toggleSelectAllFilteredManageable = (checked: boolean) => {
    setSelectedAccountMappingIds((previous) => {
      if (!checked) {
        return previous.filter((mappingId) => !filteredManageableMappingIds.includes(mappingId));
      }
      const seen = new Set(previous);
      for (const mappingId of filteredManageableMappingIds) {
        seen.add(mappingId);
      }
      return [...seen];
    });
  };

  const clearSelectedAccountMappings = () => {
    setSelectedAccountMappingIds([]);
  };

  const handleUpdateProfileSyncSource = async (mapping: AccountMapping, selectedSource: string) => {
    if (!authHeaders) {
      return;
    }
    if (!canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to update this mapping.');
      return;
    }

    const normalizedSource = normalizeTwitterUsername(selectedSource || '');
    const sourceExists = mapping.twitterUsernames.some(
      (username) => normalizeTwitterUsername(username) === normalizedSource,
    );
    const nextSource = sourceExists ? normalizedSource : normalizeTwitterUsername(mapping.twitterUsernames[0] || '');

    try {
      await axios.put(
        `/api/mappings/${mapping.id}`,
        {
          profileSyncSourceUsername: nextSource,
        },
        { headers: authHeaders },
      );

      setMappings((previous) =>
        previous.map((entry) =>
          entry.id === mapping.id
            ? {
                ...entry,
                profileSyncSourceUsername: nextSource || undefined,
              }
            : entry,
        ),
      );

      showNotice('success', `Profile sync source set to @${nextSource}.`);
    } catch (error) {
      handleAuthFailure(error, 'Failed to update profile sync source.');
    }
  };

  const bridgeMappingToFediverse = async (
    mapping: AccountMapping,
    options?: {
      confirm?: boolean;
      showNoticeOnResult?: boolean;
    },
  ): Promise<{ ok: boolean; newlyBridged: boolean; skippedAsAlreadyBridged?: boolean }> => {
    if (!authHeaders) {
      return { ok: false, newlyBridged: false };
    }
    if (!canManageMapping(mapping)) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('error', 'You do not have permission to bridge this mapping.');
      }
      return { ok: false, newlyBridged: false };
    }

    const knownStatus = fediverseBridgeStatusByMappingId[mapping.id];
    if (knownStatus?.bridged === true) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('info', `${mapping.bskyIdentifier} is already bridged.`);
      }
      return { ok: true, newlyBridged: false, skippedAsAlreadyBridged: true };
    }

    const profile = getProfileForActor(mapping.bskyIdentifier);
    if (!canBridgeToFediverse(profile?.createdAt)) {
      if (options?.showNoticeOnResult !== false) {
        showNotice('error', 'This Bluesky account must be at least 7 days old before bridging.');
      }
      return { ok: false, newlyBridged: false };
    }

    if (options?.confirm !== false) {
      const confirmed = window.confirm(
        `Bridge ${mapping.bskyIdentifier} to the fediverse now? This follows @ap.brid.gy and posts the bridge announcement.`,
      );
      if (!confirmed) {
        return { ok: false, newlyBridged: false };
      }
    }

    setBridgingMappingId(mapping.id);
    try {
      const response = await axios.post<{ fediverseAddress?: string }>(
        `/api/mappings/${mapping.id}/bridge-to-fediverse`,
        {},
        { headers: authHeaders },
      );
      setFediverseBridgeStatusByMappingId((previous) => ({
        ...previous,
        [mapping.id]: {
          bridged: true,
          checkedAt: new Date().toISOString(),
        },
      }));

      if (options?.showNoticeOnResult !== false) {
        showNotice(
          'success',
          `Fediverse bridge enabled: ${response.data?.fediverseAddress || `@${mapping.bskyIdentifier}@bsky.brid.gy`}`,
        );
      }

      return { ok: true, newlyBridged: true };
    } catch (error) {
      if (options?.showNoticeOnResult !== false) {
        handleAuthFailure(error, 'Failed to bridge this account to the fediverse.');
      }
      return { ok: false, newlyBridged: false };
    } finally {
      setBridgingMappingId((previous) => (previous === mapping.id ? null : previous));
    }
  };

  const handleBridgeToFediverse = async (mapping: AccountMapping) => {
    const outcome = await bridgeMappingToFediverse(mapping, {
      confirm: true,
      showNoticeOnResult: true,
    });
    if (outcome.ok && outcome.newlyBridged) {
      await fetchRecentActivity();
    }
  };

  const handleBridgeAllEligible = async (targetsOverride?: AccountMapping[]) => {
    if (!authHeaders) {
      return;
    }
    if (isSyncAllProfilesBusy || isPullBioAllBusy || Boolean(syncingProfileMappingId) || Boolean(pullingBioMappingId)) {
      showNotice('info', 'Profile/bio sync is currently running. Please wait before bridge-all.');
      return;
    }

    const manageable =
      targetsOverride && targetsOverride.length > 0 ? targetsOverride : manageableAccountMappingsForView;
    if (manageable.length === 0) {
      showNotice('info', 'No accounts available for fediverse bridge.');
      return;
    }

    const refreshedStatuses = await fetchFediverseBridgeStatuses(manageable, { force: true });
    const refreshedProfiles = await fetchProfiles(manageable.map((mapping) => mapping.bskyIdentifier));
    const statusLookup = {
      ...fediverseBridgeStatusByMappingId,
      ...(refreshedStatuses || {}),
    };
    const profileLookup = {
      ...profilesByActor,
      ...(refreshedProfiles || {}),
    };

    const alreadyBridged = manageable.filter((mapping) => statusLookup[mapping.id]?.bridged === true);
    const unknownStatusMappings = manageable.filter((mapping) => {
      const status = statusLookup[mapping.id];
      return !status || Boolean(status.error);
    });
    const eligible = manageable.filter((mapping) => {
      const status = statusLookup[mapping.id];
      if (!status || status.error) {
        return false;
      }
      if (status.bridged === true) {
        return false;
      }
      const profile = profileLookup[normalizeTwitterUsername(mapping.bskyIdentifier)];
      return canBridgeToFediverse(profile?.createdAt);
    });

    if (eligible.length === 0) {
      showNotice(
        'info',
        alreadyBridged.length > 0
          ? 'No new accounts to bridge. Eligible accounts are already bridged.'
          : unknownStatusMappings.length > 0
            ? `Could not verify bridge status for ${unknownStatusMappings.length} account(s). Try again in a few seconds.`
            : 'No eligible unbridged accounts found (accounts must be at least 7 days old).',
      );
      return;
    }

    const confirmed = window.confirm(
      `Bridge ${eligible.length} eligible unbridged account(s) now? This follows @ap.brid.gy and posts the bridge announcement for each account.`,
    );
    if (!confirmed) {
      return;
    }

    setIsBridgeAllBusy(true);
    setBridgeAllProgress({
      currentHandle: '',
      completed: 0,
      total: eligible.length,
    });
    const newlyBridgedLabels: string[] = [];
    let failedCount = 0;

    try {
      for (let index = 0; index < eligible.length; index += 1) {
        const mapping = eligible[index];
        setBridgeAllProgress({
          currentHandle: `@${mapping.bskyIdentifier}`,
          completed: index,
          total: eligible.length,
        });

        const outcome = await bridgeMappingToFediverse(mapping, {
          confirm: false,
          showNoticeOnResult: false,
        });
        if (outcome.ok && outcome.newlyBridged) {
          newlyBridgedLabels.push(`@${mapping.bskyIdentifier}`);
        } else {
          failedCount += 1;
        }

        setBridgeAllProgress({
          currentHandle: `@${mapping.bskyIdentifier}`,
          completed: index + 1,
          total: eligible.length,
        });
      }

      if (newlyBridgedLabels.length > 0) {
        await fetchRecentActivity();
      }

      const preview = newlyBridgedLabels.slice(0, 6).join(', ');
      const more = newlyBridgedLabels.length > 6 ? ` +${newlyBridgedLabels.length - 6} more` : '';
      const summary =
        newlyBridgedLabels.length > 0
          ? `Newly bridged (${newlyBridgedLabels.length}): ${preview}${more}.`
          : 'No new accounts were bridged.';

      showNotice(
        failedCount > 0 ? 'info' : 'success',
        `${summary} Already bridged: ${alreadyBridged.length}. Unknown status: ${unknownStatusMappings.length}. Failed: ${failedCount}.`,
      );
    } finally {
      setIsBridgeAllBusy(false);
      setBridgeAllProgress(null);
    }
  };

  const addNewTwitterUsername = () => {
    setNewTwitterUsers((previous) => addTwitterUsernames(previous, newTwitterInput));
    setNewTwitterInput('');
  };

  const removeNewTwitterUsername = (username: string) => {
    setNewTwitterUsers((previous) =>
      previous.filter((existing) => normalizeTwitterUsername(existing) !== normalizeTwitterUsername(username)),
    );
  };

  const addEditTwitterUsername = () => {
    setEditTwitterUsers((previous) => addTwitterUsernames(previous, editTwitterInput));
    setEditTwitterInput('');
  };

  const removeEditTwitterUsername = (username: string) => {
    setEditTwitterUsers((previous) =>
      previous.filter((existing) => normalizeTwitterUsername(existing) !== normalizeTwitterUsername(username)),
    );
  };

  const handleCreateGroup = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }
    if (!canManageGroupsPermission) {
      showNotice('error', 'You do not have permission to create groups.');
      return;
    }

    const name = newGroupName.trim();
    const emoji = newGroupEmoji.trim() || DEFAULT_GROUP_EMOJI;
    if (!name) {
      showNotice('error', 'Enter a group name first.');
      return;
    }

    setIsBusy(true);
    try {
      await axios.post('/api/groups', { name, emoji }, { headers: authHeaders });
      setNewGroupName('');
      setNewGroupEmoji(DEFAULT_GROUP_EMOJI);
      await fetchGroups();
      showNotice('success', `Group "${name}" created.`);
    } catch (error) {
      handleAuthFailure(error, 'Failed to create group.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleAssignMappingGroup = async (mapping: AccountMapping, groupKey: string) => {
    if (!authHeaders) {
      return;
    }
    if (!canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to update this mapping.');
      return;
    }

    const selectedGroup = groupOptionsByKey.get(groupKey);
    const nextGroupName = selectedGroup?.name || '';
    const nextGroupEmoji = selectedGroup?.emoji || '';

    try {
      await axios.put(
        `/api/mappings/${mapping.id}`,
        {
          groupName: nextGroupName,
          groupEmoji: nextGroupEmoji,
        },
        { headers: authHeaders },
      );

      setMappings((previous) =>
        previous.map((entry) =>
          entry.id === mapping.id
            ? {
                ...entry,
                groupName: nextGroupName || undefined,
                groupEmoji: nextGroupEmoji || undefined,
              }
            : entry,
        ),
      );

      if (nextGroupName) {
        setGroups((previous) => {
          const key = getGroupKey(nextGroupName);
          if (previous.some((group) => getGroupKey(group.name) === key)) {
            return previous;
          }
          return [...previous, { name: nextGroupName, ...(nextGroupEmoji ? { emoji: nextGroupEmoji } : {}) }];
        });
      }
    } catch (error) {
      handleAuthFailure(error, 'Failed to move account to folder.');
    }
  };

  const updateGroupDraft = (groupKey: string, field: 'name' | 'emoji', value: string) => {
    setGroupDraftsByKey((previous) => ({
      ...previous,
      [groupKey]: {
        name: previous[groupKey]?.name ?? '',
        emoji: previous[groupKey]?.emoji ?? '',
        [field]: value,
      },
    }));
  };

  const handleRenameGroup = async (groupKey: string) => {
    if (!authHeaders) {
      return;
    }
    if (!canManageGroupsPermission) {
      showNotice('error', 'You do not have permission to rename groups.');
      return;
    }

    const draft = groupDraftsByKey[groupKey];
    if (!draft || !draft.name.trim()) {
      showNotice('error', 'Group name is required.');
      return;
    }

    setIsGroupActionBusy(true);
    try {
      await axios.put(
        `/api/groups/${encodeURIComponent(groupKey)}`,
        {
          name: draft.name.trim(),
          emoji: draft.emoji.trim(),
        },
        { headers: authHeaders },
      );
      showNotice('success', 'Group updated.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to update group.');
    } finally {
      setIsGroupActionBusy(false);
    }
  };

  const handleDeleteGroup = async (groupKey: string) => {
    if (!authHeaders) {
      return;
    }
    if (!canManageGroupsPermission) {
      showNotice('error', 'You do not have permission to delete groups.');
      return;
    }

    const group = groupOptionsByKey.get(groupKey);
    if (!group) {
      showNotice('error', 'Group not found.');
      return;
    }

    const confirmed = window.confirm(
      `Delete "${group.name}"? Mappings in this folder will move to ${DEFAULT_GROUP_NAME}.`,
    );
    if (!confirmed) {
      return;
    }

    setIsGroupActionBusy(true);
    try {
      const response = await axios.delete<{ reassignedCount?: number }>(`/api/groups/${encodeURIComponent(groupKey)}`, {
        headers: authHeaders,
      });
      const reassignedCount = response.data?.reassignedCount || 0;
      showNotice('success', `Group deleted. ${reassignedCount} account${reassignedCount === 1 ? '' : 's'} moved.`);
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to delete group.');
    } finally {
      setIsGroupActionBusy(false);
    }
  };

  const resetAddAccountDraft = () => {
    setNewMapping({
      ...defaultMappingForm(),
      owner: getUserLabel(me),
    });
    setNewTwitterUsers([]);
    setNewTwitterInput('');
    setNewTwitterMirrorProfiles({});
    setSelectedMirrorSourceUsername('');
    setValidatedBskyCredentials(null);
    setIsMirrorPreviewLoading(false);
    setIsCredentialValidationBusy(false);
    setAddAccountStep(1);
  };

  const openAddAccountSheet = () => {
    if (!canCreateMappings) {
      showNotice('error', 'You do not have permission to add mappings.');
      return;
    }
    resetAddAccountDraft();
    setIsAddAccountSheetOpen(true);
  };

  const closeAddAccountSheet = () => {
    setIsAddAccountSheetOpen(false);
    resetAddAccountDraft();
  };

  const applyGroupPresetToNewMapping = (groupKey: string) => {
    const group = groupOptionsByKey.get(groupKey);
    if (!group || group.key === DEFAULT_GROUP_KEY) {
      return;
    }
    setNewMapping((previous) => ({
      ...previous,
      groupName: group.name,
      groupEmoji: group.emoji,
    }));
  };

  const ensureTwitterMirrorProfileLoaded = useCallback(
    async (twitterUsername: string): Promise<TwitterMirrorProfile | null> => {
      if (!authHeaders) {
        return null;
      }

      const normalized = normalizeTwitterUsername(twitterUsername);
      if (!normalized) {
        return null;
      }

      const cached = newTwitterMirrorProfiles[normalized];
      if (cached) {
        return cached;
      }

      setIsMirrorPreviewLoading(true);
      try {
        const response = await axios.post<TwitterMirrorProfile>(
          '/api/onboarding/twitter-profile',
          { twitterUsername: normalized },
          { headers: authHeaders },
        );
        setNewTwitterMirrorProfiles((previous) => ({
          ...previous,
          [normalized]: response.data,
        }));
        return response.data;
      } catch (error) {
        handleAuthFailure(error, 'Failed to fetch Twitter profile metadata.');
        return null;
      } finally {
        setIsMirrorPreviewLoading(false);
      }
    },
    [authHeaders, handleAuthFailure, newTwitterMirrorProfiles],
  );

  const validateAddAccountCredentials = useCallback(async (): Promise<BlueskyCredentialValidation | null> => {
    if (!authHeaders) {
      return null;
    }

    const bskyIdentifier = newMapping.bskyIdentifier.trim();
    const bskyPassword = newMapping.bskyPassword.trim();
    const bskyServiceUrl = newMapping.bskyServiceUrl.trim();

    if (!bskyIdentifier || !bskyPassword) {
      showNotice('error', 'Bluesky identifier and app password are required.');
      return null;
    }

    setIsCredentialValidationBusy(true);
    try {
      const response = await axios.post<BlueskyCredentialValidation>(
        '/api/onboarding/bsky-credentials',
        {
          bskyIdentifier,
          bskyPassword,
          bskyServiceUrl,
        },
        { headers: authHeaders },
      );
      setValidatedBskyCredentials(response.data);
      return response.data;
    } catch (error) {
      setValidatedBskyCredentials(null);
      handleAuthFailure(error, 'Failed to validate Bluesky credentials.');
      return null;
    } finally {
      setIsCredentialValidationBusy(false);
    }
  }, [
    authHeaders,
    handleAuthFailure,
    newMapping.bskyIdentifier,
    newMapping.bskyPassword,
    newMapping.bskyServiceUrl,
    showNotice,
  ]);

  useEffect(() => {
    if (!isAddAccountSheetOpen || addAccountStep !== 1) {
      return;
    }

    if (!selectedMirrorSourceUsername) {
      return;
    }

    void ensureTwitterMirrorProfileLoaded(selectedMirrorSourceUsername);
  }, [addAccountStep, ensureTwitterMirrorProfileLoaded, isAddAccountSheetOpen, selectedMirrorSourceUsername]);

  const submitNewMapping = async () => {
    if (!authHeaders) {
      return;
    }
    if (!canCreateMappings) {
      showNotice('error', 'You do not have permission to add mappings.');
      return;
    }

    if (newTwitterUsers.length === 0) {
      showNotice('error', 'Add at least one Twitter username.');
      return;
    }

    const sourceTwitterUsername = normalizeTwitterUsername(selectedMirrorSourceUsername || newTwitterUsers[0] || '');
    if (!sourceTwitterUsername) {
      showNotice('error', 'Select a Twitter source for profile mirroring.');
      return;
    }

    const mirrorPreview = await ensureTwitterMirrorProfileLoaded(sourceTwitterUsername);
    if (!mirrorPreview) {
      showNotice('error', 'Fetch Twitter metadata before creating this mapping.');
      return;
    }

    if (!(validatedBskyCredentials || (await validateAddAccountCredentials()))) {
      showNotice('error', 'Validate Bluesky credentials before creating this mapping.');
      return;
    }

    setIsBusy(true);

    try {
      const createResponse = await axios.post<AccountMapping>(
        '/api/mappings',
        {
          owner: newMapping.owner.trim(),
          twitterUsernames: newTwitterUsers,
          bskyIdentifier: newMapping.bskyIdentifier.trim(),
          bskyPassword: newMapping.bskyPassword,
          bskyServiceUrl: newMapping.bskyServiceUrl.trim(),
          groupName: newMapping.groupName.trim(),
          groupEmoji: newMapping.groupEmoji.trim(),
          profileSyncSourceUsername: sourceTwitterUsername,
        },
        { headers: authHeaders },
      );

      const syncResponse = await axios.post<MirrorProfileSyncResult>(
        `/api/mappings/${createResponse.data.id}/sync-profile-from-twitter`,
        {
          sourceTwitterUsername,
        },
        { headers: authHeaders },
      );

      const warnings = syncResponse.data.warnings || [];
      const botLabelApplied = createResponse.data.hasBotLabel === true;

      setNewMapping(defaultMappingForm());
      setNewTwitterUsers([]);
      setNewTwitterInput('');
      setNewTwitterMirrorProfiles({});
      setSelectedMirrorSourceUsername('');
      setValidatedBskyCredentials(null);
      setIsAddAccountSheetOpen(false);
      setAddAccountStep(1);
      if (warnings.length > 0) {
        showNotice(
          'info',
          `Account mapping added. Profile mirrored with ${warnings.length} warning(s).${
            botLabelApplied
              ? ''
              : ' Bot label was not applied automatically; use the bulk bot-label button in Accounts.'
          }`,
        );
      } else {
        showNotice(
          botLabelApplied ? 'success' : 'info',
          `Account mapping added and Bluesky profile mirrored from Twitter.${
            botLabelApplied
              ? ''
              : ' Bot label was not applied automatically; use the bulk bot-label button in Accounts.'
          }`,
        );
      }
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to add account mapping.');
    } finally {
      setIsBusy(false);
    }
  };

  const advanceAddAccountStep = () => {
    if (addAccountStep === 1) {
      if (newTwitterUsers.length === 0) {
        showNotice('error', 'Add at least one Twitter username.');
        return;
      }

      const sourceTwitterUsername = normalizeTwitterUsername(selectedMirrorSourceUsername || newTwitterUsers[0] || '');
      if (!sourceTwitterUsername) {
        showNotice('error', 'Select a Twitter source for profile mirroring.');
        return;
      }

      setIsMirrorPreviewLoading(true);
      void ensureTwitterMirrorProfileLoaded(sourceTwitterUsername)
        .then((profile) => {
          if (!profile) {
            return;
          }
          setAddAccountStep(2);
        })
        .finally(() => {
          setIsMirrorPreviewLoading(false);
        });
      return;
    }

    if (addAccountStep === 2) {
      setAddAccountStep(3);
      return;
    }

    if (addAccountStep === 3) {
      if (!newMapping.bskyIdentifier.trim() || !newMapping.bskyPassword.trim()) {
        showNotice('error', 'Bluesky identifier and app password are required.');
        return;
      }

      setIsCredentialValidationBusy(true);
      void validateAddAccountCredentials()
        .then((validation) => {
          if (!validation) {
            return;
          }
          setAddAccountStep(4);
        })
        .finally(() => {
          setIsCredentialValidationBusy(false);
        });
    }
  };

  const retreatAddAccountStep = () => {
    setAddAccountStep((previous) => Math.max(1, previous - 1));
  };

  const startEditMapping = (mapping: AccountMapping) => {
    if (!canManageMapping(mapping)) {
      showNotice('error', 'You do not have permission to edit this mapping.');
      return;
    }
    setEditingMapping(mapping);
    setEditForm({
      owner: mapping.owner || '',
      bskyIdentifier: mapping.bskyIdentifier,
      bskyPassword: '',
      bskyServiceUrl: mapping.bskyServiceUrl || 'https://bsky.social',
      groupName: mapping.groupName || '',
      groupEmoji: mapping.groupEmoji || '📁',
      profileSyncSourceUsername: mapping.profileSyncSourceUsername || mapping.twitterUsernames[0] || '',
    });
    setEditTwitterUsers(mapping.twitterUsernames);
    setEditTwitterInput('');
  };

  const handleUpdateMapping = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders || !editingMapping) {
      return;
    }
    if (!canManageMapping(editingMapping)) {
      showNotice('error', 'You do not have permission to edit this mapping.');
      return;
    }

    if (editTwitterUsers.length === 0) {
      showNotice('error', 'At least one Twitter username is required.');
      return;
    }

    const normalizedProfileSyncSource = normalizeTwitterUsername(editForm.profileSyncSourceUsername || '');
    const hasSourceInMapping = editTwitterUsers.some(
      (username) => normalizeTwitterUsername(username) === normalizedProfileSyncSource,
    );
    const profileSyncSourceUsername = hasSourceInMapping
      ? normalizedProfileSyncSource
      : normalizeTwitterUsername(editTwitterUsers[0] || '');

    setIsBusy(true);

    try {
      await axios.put(
        `/api/mappings/${editingMapping.id}`,
        {
          owner: editForm.owner.trim(),
          twitterUsernames: editTwitterUsers,
          bskyIdentifier: editForm.bskyIdentifier.trim(),
          bskyPassword: editForm.bskyPassword,
          bskyServiceUrl: editForm.bskyServiceUrl.trim(),
          groupName: editForm.groupName.trim(),
          groupEmoji: editForm.groupEmoji.trim(),
          profileSyncSourceUsername,
        },
        { headers: authHeaders },
      );

      setEditingMapping(null);
      setEditForm(defaultMappingForm());
      setEditTwitterUsers([]);
      setEditTwitterInput('');
      showNotice('success', 'Mapping updated.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to update mapping.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveTwitterConfig = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }

    setIsBusy(true);

    try {
      await axios.post(
        '/api/twitter-config',
        {
          authToken: twitterConfig.authToken,
          ct0: twitterConfig.ct0,
          backupAuthToken: twitterConfig.backupAuthToken,
          backupCt0: twitterConfig.backupCt0,
        },
        { headers: authHeaders },
      );
      showNotice('success', 'Twitter credentials saved.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to save Twitter credentials.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveAiConfig = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }

    setIsBusy(true);

    try {
      await axios.post(
        '/api/ai-config',
        {
          provider: aiConfig.provider,
          apiKey: aiConfig.apiKey,
          model: aiConfig.model,
          baseUrl: aiConfig.baseUrl,
        },
        { headers: authHeaders },
      );
      showNotice('success', 'AI settings saved.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to save AI settings.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleExportConfig = async () => {
    if (!authHeaders) {
      return;
    }

    try {
      const response = await axios.get<Blob>('/api/config/export', {
        headers: authHeaders,
        responseType: 'blob',
      });

      const blobUrl = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `tweets-2-bsky-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(blobUrl);
      showNotice('success', 'Configuration exported.');
    } catch (error) {
      handleAuthFailure(error, 'Failed to export configuration.');
    }
  };

  const handleImportConfig = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!authHeaders) {
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const confirmed = window.confirm(
      'This will overwrite accounts/settings (except user logins). Continue with import?',
    );

    if (!confirmed) {
      event.target.value = '';
      return;
    }

    try {
      const text = await file.text();
      const json = JSON.parse(text);

      await axios.post('/api/config/import', json, { headers: authHeaders });
      showNotice('success', 'Configuration imported.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to import configuration.');
    } finally {
      event.target.value = '';
    }
  };

  const handleRunUpdate = async () => {
    if (!authHeaders || !isAdmin) {
      return;
    }

    const confirmed = window.confirm(
      'Run ./update.sh now? The service may restart automatically after update completes.',
    );
    if (!confirmed) {
      return;
    }

    setIsUpdateBusy(true);
    try {
      const response = await axios.post<{ message?: string }>('/api/update', {}, { headers: authHeaders });
      showNotice('info', response.data?.message || 'Update started. Service may restart soon.');
      await Promise.all([fetchRuntimeVersion(), fetchUpdateStatus()]);
    } catch (error) {
      handleAuthFailure(error, 'Failed to start update.');
    } finally {
      setIsUpdateBusy(false);
    }
  };

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
      await axios.post(
        '/api/admin/users',
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
      await axios.put(
        `/api/admin/users/${userId}`,
        {
          username: username || undefined,
          email: email || undefined,
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
      await axios.post(
        `/api/admin/users/${userId}/reset-password`,
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
      await axios.delete(`/api/admin/users/${user.id}`, { headers: authHeaders });
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

  const handleChangeOwnEmail = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }

    if (!emailForm.newEmail.trim() || !emailForm.password || (hasCurrentEmail && !emailForm.currentEmail.trim())) {
      showNotice(
        'error',
        hasCurrentEmail ? 'Fill in current email, new email, and password.' : 'Fill in new email and password.',
      );
      return;
    }

    setIsBusy(true);
    try {
      const response = await axios.post<{ token?: string; me?: AuthUser }>(
        '/api/me/change-email',
        {
          currentEmail: emailForm.currentEmail,
          newEmail: emailForm.newEmail,
          password: emailForm.password,
        },
        { headers: authHeaders },
      );

      if (response.data?.token) {
        localStorage.setItem('token', response.data.token);
        setToken(response.data.token);
      }
      if (response.data?.me) {
        setMe({
          ...response.data.me,
          permissions: normalizePermissions(response.data.me.permissions),
        });
      }
      setEmailForm((previous) => ({
        currentEmail: previous.newEmail,
        newEmail: '',
        password: '',
      }));
      showNotice('success', 'Email updated.');
      await fetchData();
    } catch (error) {
      handleAuthFailure(error, 'Failed to update email.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleChangeOwnPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authHeaders) {
      return;
    }

    if (!passwordForm.currentPassword || !passwordForm.newPassword || !passwordForm.confirmPassword) {
      showNotice('error', 'Complete all password fields.');
      return;
    }
    if (passwordForm.newPassword.length < 8) {
      showNotice('error', 'New password must be at least 8 characters.');
      return;
    }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      showNotice('error', 'New password and confirmation do not match.');
      return;
    }

    setIsBusy(true);
    try {
      await axios.post(
        '/api/me/change-password',
        {
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        },
        { headers: authHeaders },
      );
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      showNotice('success', 'Password updated.');
    } catch (error) {
      handleAuthFailure(error, 'Failed to update password.');
    } finally {
      setIsBusy(false);
    }
  };

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md border-border/80 bg-card">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl">Tweets-2-Bsky</CardTitle>
            <CardDescription>
              {authView === 'login'
                ? 'Sign in to manage mappings, status, and account settings.'
                : 'Create your first dashboard account.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {authError ? (
              <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500 dark:text-red-300">
                {authError}
              </div>
            ) : null}

            <form className="space-y-4" onSubmit={authView === 'login' ? handleLogin : handleRegister}>
              {authView === 'login' ? (
                <div className="space-y-2">
                  <Label htmlFor="identifier">Email or Username</Label>
                  <Input id="identifier" name="identifier" autoComplete="username" required />
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input id="username" name="username" autoComplete="username" placeholder="optional" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" name="email" type="email" autoComplete="email" placeholder="optional" />
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" name="password" type="password" autoComplete="current-password" required />
              </div>

              <Button className="w-full" type="submit" disabled={isBusy}>
                {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {authView === 'login' ? 'Sign in' : 'Create account'}
              </Button>
            </form>

            {bootstrapOpen || authView === 'register' ? (
              <Button
                className="mt-4 w-full"
                variant="ghost"
                onClick={() => {
                  setAuthError('');
                  setAuthView(authView === 'login' ? 'register' : 'login');
                }}
                type="button"
              >
                {authView === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
              </Button>
            ) : (
              <p className="mt-4 text-center text-xs text-muted-foreground">
                Account creation is disabled. Ask an admin to create your user.
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    );
  }

  const activeTabMeta = dashboardTabs.find((tab) => tab.id === activeTab);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-card/40 lg:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-foreground text-xs font-bold text-background">
            T2B
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">Tweets-2-Bsky</p>
            <p className="truncate text-xs text-muted-foreground">Control panel</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          <NavList items={dashboardTabs} activeId={activeTab} onSelect={setActiveTab} />
        </div>

        <div className="space-y-3 border-t border-border p-3">
          <div className="space-y-1 px-1 text-xs text-muted-foreground">
            <p className="flex items-center gap-1.5">
              <Clock3 className="h-3.5 w-3.5 shrink-0" />
              Next run <span className="font-mono text-foreground">{countdown}</span>
            </p>
            <p
              className="truncate"
              title={`${runtimeVersionLabel}${runtimeBranchLabel ? ` ${runtimeBranchLabel}` : ''}`}
            >
              <span className="font-mono text-foreground">{runtimeVersionLabel}</span>
              {runtimeBranchLabel ? <span className="ml-1.5">{runtimeBranchLabel}</span> : null}
            </p>
          </div>
          <Button variant="outline" size="sm" className="w-full justify-start" onClick={cycleThemeMode}>
            {themeIcon}
            <span className="ml-2 truncate">{themeLabel}</span>
          </Button>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleLogout}>
            <LogOut className="mr-2 h-4 w-4" />
            Logout
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border bg-card/60 px-3 py-2 lg:hidden">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-[10px] font-bold text-background">
              T2B
            </div>
            <p className="text-sm font-semibold">Tweets-2-Bsky</p>
          </div>
          <div className="overflow-x-auto pb-0.5">
            <div className="inline-flex min-w-full gap-1.5 sm:min-w-0">
              {dashboardTabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    className={cn(
                      'inline-flex h-9 touch-manipulation items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium',
                      isActive
                        ? 'bg-foreground text-background'
                        : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    onClick={() => setActiveTab(tab.id)}
                    type="button"
                  >
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <main className="flex-1">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold sm:text-2xl">{activeTabMeta?.label ?? 'Dashboard'}</h1>
                <p className="text-sm text-muted-foreground">{activeTabMeta?.description}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canCreateMappings ? (
                  <Button size="sm" variant="outline" onClick={openAddAccountSheet}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add account
                  </Button>
                ) : null}
                <Button size="sm" onClick={runNow} disabled={!canRunNowPermission}>
                  <Play className="mr-2 h-4 w-4" />
                  Run now
                </Button>
                {isAdmin && pendingBackfills.length > 0 ? (
                  <Button size="sm" variant="destructive" onClick={clearAllBackfills}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clear queue
                  </Button>
                ) : null}
              </div>
            </div>

            {notice ? (
              <div
                className={cn(
                  'mb-5 rounded-md border px-4 py-2 text-sm',
                  notice.tone === 'success' &&
                    'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/30 dark:text-emerald-300',
                  notice.tone === 'error' &&
                    'border-red-500/40 bg-red-500/10 text-red-700 dark:border-red-500/30 dark:text-red-300',
                  notice.tone === 'info' && 'border-border bg-muted text-muted-foreground',
                )}
              >
                {notice.message}
              </div>
            ) : null}

            {activeJobs.length > 0 || (currentStatus && currentStatus.state !== 'idle') ? (
              <Card className="mb-6">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                  <p className="text-sm font-semibold">
                    {activeJobs.length > 0
                      ? `${activeJobs.length} job${activeJobs.length === 1 ? '' : 's'} running`
                      : `${formatState(currentStatus?.state || 'processing')} in progress`}
                  </p>
                  {pendingBackfills.length > 0 ? (
                    <p className="text-xs text-muted-foreground">{pendingBackfills.length} backfill(s) queued</p>
                  ) : null}
                </div>
                {activeJobs.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {activeJobs.map((job) => (
                      <li key={job.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2 text-sm">
                        <span
                          className={cn(
                            'inline-block h-2 w-2 shrink-0 self-center rounded-full',
                            JOB_KIND_DOT[job.kind] || 'bg-muted-foreground',
                          )}
                        />
                        <span className="font-medium">{JOB_KIND_LABEL[job.kind] || job.kind}</span>
                        {job.account ? <span className="font-mono text-xs">@{job.account}</span> : null}
                        {job.target ? <span className="text-xs text-muted-foreground">→ {job.target}</span> : null}
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{job.message}</span>
                        {typeof job.totalCount === 'number' && job.totalCount > 0 ? (
                          <span className="font-mono text-xs text-muted-foreground">
                            {job.processedCount ?? 0}/{job.totalCount}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : currentStatus ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <p className="text-sm text-muted-foreground">
                      {currentStatus.currentAccount ? `@${currentStatus.currentAccount} • ` : ''}
                      {currentStatus.message || 'Working through account queue.'}
                    </p>
                    {currentStatus.totalCount ? (
                      <p className="font-mono text-xs text-muted-foreground">
                        {(currentStatus.processedCount || 0).toLocaleString()} /{' '}
                        {(currentStatus.totalCount || 0).toLocaleString()} ({progressPercent || 0}%)
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            ) : null}

            {activeTab === 'overview' ? (
              <section className="space-y-6">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                  <Card className="">
                    <CardContent className="p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Mapped Accounts</p>
                      <p className="mt-2 text-2xl font-semibold">{mappings.length}</p>
                    </CardContent>
                  </Card>
                  <Card className="">
                    <CardContent className="p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Bot-Labeled</p>
                      <p className="mt-2 text-2xl font-semibold">
                        {mappings.filter((mapping) => mapping.hasBotLabel === true).length}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="">
                    <CardContent className="p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Backfill Queue</p>
                      <p className="mt-2 text-2xl font-semibold">{pendingBackfills.length}</p>
                    </CardContent>
                  </Card>
                  <Card className="">
                    <CardContent className="p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Current State</p>
                      <p className="mt-2 text-2xl font-semibold">{formatState(currentStatus?.state || 'idle')}</p>
                    </CardContent>
                  </Card>
                  <Card className="">
                    <CardContent className="p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Latest Activity</p>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        {latestActivity?.created_at
                          ? new Date(latestActivity.created_at).toLocaleString()
                          : 'No activity yet'}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="">
                    <CardContent className="p-4">
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Top Account (Engagement)</p>
                      {topAccount ? (
                        <div className="mt-2 flex items-center gap-3">
                          {topAccountProfile?.avatar ? (
                            <img
                              className="h-9 w-9 rounded-full border border-border/70 object-cover"
                              src={topAccountProfile.avatar}
                              alt={topAccountProfile.handle || topAccount.identifier}
                              loading="lazy"
                            />
                          ) : (
                            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-muted text-muted-foreground">
                              <UserRound className="h-4 w-4" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">
                              @{topAccountProfile?.handle || topAccount.identifier}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {formatCompactNumber(topAccount.score)} interactions • {topAccount.posts} posts
                            </p>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">No engagement data yet.</p>
                      )}
                    </CardContent>
                  </Card>
                </div>

                <Card className="">
                  <CardHeader>
                    <CardTitle>Quick Navigation</CardTitle>
                    <CardDescription>Use tabs to focus one workflow at a time, especially on mobile.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2 pt-0">
                    {dashboardTabs
                      .filter((tab) => tab.id !== 'overview')
                      .map((tab) => {
                        const Icon = tab.icon;
                        return (
                          <Button key={`overview-${tab.id}`} variant="outline" onClick={() => setActiveTab(tab.id)}>
                            <Icon className="mr-2 h-4 w-4" />
                            Open {tab.label}
                          </Button>
                        );
                      })}
                  </CardContent>
                </Card>
              </section>
            ) : null}

            {activeTab === 'accounts' ? (
              <section className="grid gap-6 lg:grid-cols-[240px_1fr]">
                <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
                  <Card>
                    <CardContent className="space-y-0.5 p-2">
                      <button
                        type="button"
                        onClick={() => setSelectedFolderKey('__all__')}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
                          selectedFolderKey === '__all__'
                            ? 'bg-foreground text-background'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        <Folder className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">All accounts</span>
                        <span className="text-xs opacity-70">{accountMappingsForView.length}</span>
                      </button>
                      {groupedMappings.map((group) => (
                        <button
                          key={group.key}
                          type="button"
                          onClick={() => setSelectedFolderKey(group.key)}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors',
                            selectedFolderKey === group.key
                              ? 'bg-foreground text-background'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          <span className="shrink-0">{group.emoji}</span>
                          <span className="min-w-0 flex-1 truncate">{group.name}</span>
                          <span className="text-xs opacity-70">{group.mappings.length}</span>
                        </button>
                      ))}
                    </CardContent>
                  </Card>

                  {canManageGroupsPermission ? (
                    <Card>
                      <details>
                        <summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                          Manage folders
                        </summary>
                        <div className="space-y-3 border-t border-border/70 p-3">
                          <form
                            className="space-y-2"
                            onSubmit={(event) => {
                              void handleCreateGroup(event);
                            }}
                          >
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              New folder
                            </p>
                            <div className="flex items-end gap-2">
                              <div className="w-16 space-y-1">
                                <Label htmlFor="accounts-group-emoji">Emoji</Label>
                                <Input
                                  id="accounts-group-emoji"
                                  value={newGroupEmoji}
                                  onChange={(event) => setNewGroupEmoji(event.target.value)}
                                  placeholder="📁"
                                  maxLength={8}
                                />
                              </div>
                              <div className="flex-1 space-y-1">
                                <Label htmlFor="accounts-group-name">Name</Label>
                                <Input
                                  id="accounts-group-name"
                                  value={newGroupName}
                                  onChange={(event) => setNewGroupName(event.target.value)}
                                  placeholder="Gaming, News..."
                                />
                              </div>
                              <Button
                                type="submit"
                                size="icon"
                                variant="outline"
                                disabled={isBusy || newGroupName.trim().length === 0}
                                aria-label="Create folder"
                              >
                                <Plus className="h-4 w-4" />
                              </Button>
                            </div>
                          </form>

                          {reusableGroupOptions.length > 0 ? (
                            <div className="space-y-2 border-t border-border/70 pt-3">
                              {reusableGroupOptions.map((group) => {
                                const draft = groupDraftsByKey[group.key] || { name: group.name, emoji: group.emoji };
                                return (
                                  <div key={`group-manager-${group.key}`} className="flex items-end gap-1.5">
                                    <div className="w-14">
                                      <Input
                                        aria-label="Folder emoji"
                                        value={draft.emoji}
                                        onChange={(event) => updateGroupDraft(group.key, 'emoji', event.target.value)}
                                        maxLength={8}
                                        className="px-2"
                                      />
                                    </div>
                                    <Input
                                      aria-label="Folder name"
                                      className="min-w-0 flex-1"
                                      value={draft.name}
                                      onChange={(event) => updateGroupDraft(group.key, 'name', event.target.value)}
                                    />
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      disabled={isGroupActionBusy || !draft.name.trim()}
                                      title="Save folder"
                                      onClick={() => {
                                        void handleRenameGroup(group.key);
                                      }}
                                    >
                                      <Save className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="text-red-600 hover:text-red-500 dark:text-red-300 dark:hover:text-red-200"
                                      disabled={isGroupActionBusy}
                                      title="Delete folder"
                                      onClick={() => {
                                        void handleDeleteGroup(group.key);
                                      }}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>
                                );
                              })}
                              <p className="text-xs text-muted-foreground">
                                Deleting a folder moves its mappings to {DEFAULT_GROUP_NAME}.
                              </p>
                            </div>
                          ) : null}
                        </div>
                      </details>
                    </Card>
                  ) : null}
                </div>

                <div className="min-w-0 space-y-4">
                  <Card>
                    <CardContent className="space-y-3 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          className="max-w-xs"
                          value={accountsSearchQuery}
                          onChange={(event) => setAccountsSearchQuery(event.target.value)}
                          placeholder="Search @username, owner, handle..."
                        />
                        {isAdmin ? (
                          <select
                            className={cn(selectClassName, 'h-10 w-44 text-sm')}
                            value={accountsCreatorFilter}
                            onChange={(event) => setAccountsCreatorFilter(event.target.value)}
                            aria-label="Created by user"
                          >
                            <option value="all">All users</option>
                            {managedUsers.map((user) => (
                              <option key={`creator-filter-${user.id}`} value={user.id}>
                                {user.username || user.email || user.id}
                              </option>
                            ))}
                          </select>
                        ) : null}

                        <div className="ml-auto flex flex-wrap items-center gap-2">
                          {canCreateMappings ? (
                            <Button size="sm" variant="outline" onClick={openAddAccountSheet}>
                              <Plus className="mr-2 h-4 w-4" />
                              Add account
                            </Button>
                          ) : null}
                          <DropdownMenu
                            align="end"
                            trigger={
                              <>
                                View
                                <ChevronDown className="h-3.5 w-3.5" />
                              </>
                            }
                          >
                            <DropdownMenuItem
                              data-keep-open="true"
                              onClick={() => setShowAccountAvatars((previous) => !previous)}
                            >
                              {showAccountAvatars ? 'Hide avatars' : 'Show avatars'}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              data-keep-open="true"
                              onClick={() => setShowAccountBios((previous) => !previous)}
                            >
                              {showAccountBios ? 'Hide bios' : 'Show bios'}
                            </DropdownMenuItem>
                          </DropdownMenu>
                          <DropdownMenu
                            align="end"
                            disabled={isAnyBulkAccountsActionBusy}
                            trigger={
                              isAnyBulkAccountsActionBusy ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  Working...
                                </>
                              ) : (
                                <>
                                  Bulk actions
                                  <ChevronDown className="h-3.5 w-3.5" />
                                </>
                              )
                            }
                          >
                            <DropdownMenuLabel>
                              {selectedManageableMappingsCount > 0
                                ? `Apply to ${selectedManageableMappingsCount} selected`
                                : 'Apply to all manageable'}
                            </DropdownMenuLabel>
                            <DropdownMenuItem
                              icon={<RefreshCw className="h-4 w-4" />}
                              onClick={() => void handleApplyAllAccountsAction('sync_profiles')}
                            >
                              Sync profiles from Twitter
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              icon={<Download className="h-4 w-4" />}
                              onClick={() => void handleApplyAllAccountsAction('pull_twitter_bio')}
                            >
                              Pull Twitter bio
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              icon={<Link2 className="h-4 w-4" />}
                              onClick={() => void handleApplyAllAccountsAction('bridge_all')}
                            >
                              Bridge to fediverse
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              icon={<Pin className="h-4 w-4" />}
                              onClick={() => void handleApplyAllAccountsAction('sync_pins')}
                            >
                              Sync pinned tweets
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              icon={<Bot className="h-4 w-4" />}
                              onClick={() => void handleApplyAllAccountsAction('apply_bot_label')}
                            >
                              Apply bot label
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              icon={<Bot className="h-4 w-4" />}
                              onClick={() => void handleApplyAllAccountsAction('append_bot_name')}
                            >
                              Append {'{bot}'} to display name
                            </DropdownMenuItem>
                          </DropdownMenu>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <div className="flex flex-wrap items-center gap-3">
                          <span>
                            Showing {currentAccountsPageStart}-{currentAccountsPageEnd} of {accountMatchesCount} account
                            {accountMatchesCount === 1 ? '' : 's'}
                          </span>
                          {botLabeledMappingsForView.length > 0 ? (
                            <span>{botLabeledMappingsForView.length} bot-labeled</span>
                          ) : null}
                          {selectedManageableMappingsCount > 0 ? (
                            <button
                              type="button"
                              className="text-foreground underline-offset-2 hover:underline"
                              onClick={clearSelectedAccountMappings}
                              title="Clear selection"
                            >
                              {selectedManageableMappingsCount} selected ×
                            </button>
                          ) : null}
                          {isBridgeAllBusy && bridgeAllProgress ? (
                            <Badge variant="outline" className="max-w-[240px] truncate">
                              {bridgeAllProgress.currentHandle
                                ? `Bridging ${bridgeAllProgress.currentHandle}`
                                : 'Preparing bridge-all...'}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            className={cn(selectClassName, 'h-8 w-20 px-2 py-1 text-xs')}
                            value={accountsPageSize}
                            onChange={(event) =>
                              setAccountsPageSize(Number(event.target.value) || ACCOUNT_PAGE_SIZE_DEFAULT)
                            }
                            aria-label="Accounts per page"
                          >
                            <option value={25}>25</option>
                            <option value={50}>50</option>
                            <option value={100}>100</option>
                            <option value={200}>200</option>
                          </select>
                          <Button
                            size="icon"
                            variant="outline"
                            disabled={accountsPage <= 1}
                            onClick={() => setAccountsPage((previous) => Math.max(1, previous - 1))}
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <span className="w-16 text-center">
                            {accountsPage}/{accountsPageCount}
                          </span>
                          <Button
                            size="icon"
                            variant="outline"
                            disabled={accountsPage >= accountsPageCount}
                            onClick={() => setAccountsPage((previous) => Math.min(accountsPageCount, previous + 1))}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {bridgedMappingsForView.length > 0 || bridgeEligibleUnbridgedMappings.length > 0 ? (
                    <details className="rounded-lg border border-border/70 bg-muted/20 text-sm">
                      <summary className="cursor-pointer list-none px-3 py-2.5 text-xs text-muted-foreground">
                        <span className="font-medium uppercase tracking-wide">Fediverse Bridge</span> —{' '}
                        {bridgedMappingsForView.length} bridged, {bridgeEligibleUnbridgedMappings.length} eligible now
                      </summary>
                      <div className="flex flex-wrap gap-1.5 border-t border-border/60 p-3 pt-2.5">
                        {bridgedMappingsForView.slice(0, 24).map((mapping) => {
                          const profile = getProfileForActor(mapping.bskyIdentifier);
                          const handle = profile?.handle || mapping.bskyIdentifier;
                          return (
                            <Badge key={`bridged-list-${mapping.id}`} variant="success">
                              <Link2 className="h-3 w-3" />@{handle}
                            </Badge>
                          );
                        })}
                        {bridgedMappingsForView.length > 24 ? (
                          <Badge variant="outline">+{bridgedMappingsForView.length - 24} more</Badge>
                        ) : null}
                      </div>
                    </details>
                  ) : null}

                  {accountMatchesCount === 0 ? (
                    <Card>
                      <CardContent className="p-6 text-center text-sm text-muted-foreground">
                        {normalizedAccountsQuery
                          ? 'No accounts matched this search.'
                          : 'No mappings in this folder yet.'}
                        {canCreateMappings ? (
                          <div className="mt-3">
                            <Button size="sm" variant="outline" onClick={openAddAccountSheet}>
                              <Plus className="mr-2 h-4 w-4" />
                              Create your first account
                            </Button>
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>
                  ) : (
                    <Card className="cv-auto overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-left text-sm">
                          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                            <tr>
                              <th className="w-9 px-2 py-3">
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded border-border"
                                  checked={allFilteredManageableSelected}
                                  disabled={filteredManageableMappingIds.length === 0}
                                  onChange={(event) => toggleSelectAllFilteredManageable(event.target.checked)}
                                  aria-label="Select all accounts on this page"
                                />
                              </th>
                              <th className="px-2 py-3">Owner</th>
                              {isAdmin ? <th className="px-2 py-3">Created By</th> : null}
                              <th className="px-2 py-3">Twitter Sources</th>
                              <th className="px-2 py-3">Bluesky Target</th>
                              <th className="px-2 py-3">Status</th>
                              <th className="px-2 py-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(pagedGroupedMappings[0]?.mappings ?? []).map((mapping) => {
                              const queued = isBackfillQueued(mapping.id);
                              const active = isBackfillActive(mapping.id);
                              const queuePosition = getBackfillEntry(mapping.id)?.position;
                              const profile = getProfileForActor(mapping.bskyIdentifier);
                              const profileHandle = profile?.handle || mapping.bskyIdentifier;
                              const profileName = profile?.displayName || profileHandle;
                              const profileBio = showAccountBios ? profile?.description?.trim() || '' : '';
                              const profileUrl = `https://bsky.app/profile/${profileHandle}`;
                              const canManageThisMapping = canManageMapping(mapping);
                              const canUseFediverseBridge = canBridgeToFediverse(profile?.createdAt);
                              const bridgeStatus = fediverseBridgeStatusByMappingId[mapping.id];
                              const isFediverseBridged = bridgeStatus?.bridged === true;
                              const bridging = bridgingMappingId === mapping.id;
                              const mappingGroup = getMappingGroupMeta(mapping);
                              const syncingProfile = syncingProfileMappingId === mapping.id;
                              const pullingBio = pullingBioMappingId === mapping.id;
                              const isSelectedForBulk = selectedAccountMappingIdSet.has(mapping.id);

                              return (
                                <tr
                                  key={mapping.id}
                                  className="interactive-row border-b border-border/60 last:border-0"
                                >
                                  <td className="px-2 py-3 align-top">
                                    {canManageThisMapping ? (
                                      <input
                                        type="checkbox"
                                        className="h-3.5 w-3.5 rounded border-border"
                                        checked={isSelectedForBulk}
                                        disabled={isAnyBulkAccountsActionBusy}
                                        onChange={(event) =>
                                          toggleAccountMappingSelection(mapping.id, event.target.checked)
                                        }
                                        aria-label={`Select ${mapping.bskyIdentifier}`}
                                      />
                                    ) : null}
                                  </td>
                                  <td className="px-2 py-3 align-top">
                                    <div className="flex items-center gap-2 font-medium">
                                      <UserRound className="h-4 w-4 text-muted-foreground" />
                                      {mapping.owner || 'System'}
                                    </div>
                                  </td>
                                  {isAdmin ? (
                                    <td className="px-2 py-3 align-top text-xs text-muted-foreground">
                                      {mapping.createdByLabel ||
                                        mapping.createdByUser?.username ||
                                        mapping.createdByUser?.email ||
                                        '--'}
                                    </td>
                                  ) : null}
                                  <td className="px-2 py-3 align-top">
                                    <div className="flex flex-wrap gap-2">
                                      {mapping.twitterUsernames.map((username) => (
                                        <Badge key={username} variant="secondary">
                                          @{username}
                                        </Badge>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-2 py-3 align-top">
                                    <div className="flex items-center gap-2">
                                      {showAccountAvatars && profile?.avatar ? (
                                        <img
                                          className="h-8 w-8 rounded-full border border-border/70 object-cover"
                                          src={profile.avatar}
                                          alt={profileName}
                                          loading="lazy"
                                          decoding="async"
                                          fetchPriority="low"
                                        />
                                      ) : (
                                        <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-muted text-muted-foreground">
                                          <UserRound className="h-4 w-4" />
                                        </div>
                                      )}
                                      <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">{profileName}</p>
                                        <a
                                          className="inline-flex max-w-full items-center truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                                          href={profileUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          title={`Open @${profileHandle} on Bluesky`}
                                        >
                                          {profileHandle}
                                          <ArrowUpRight className="ml-1 h-3 w-3 shrink-0" />
                                        </a>
                                        {profileBio ? (
                                          <p
                                            className="mt-1 overflow-hidden text-xs text-muted-foreground"
                                            style={{
                                              display: '-webkit-box',
                                              WebkitLineClamp: 2,
                                              WebkitBoxOrient: 'vertical',
                                            }}
                                            title={profileBio}
                                          >
                                            {profileBio}
                                          </p>
                                        ) : null}
                                      </div>
                                    </div>
                                  </td>
                                  <td className="px-2 py-3 align-top">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      {active ? (
                                        <Badge variant="warning">Backfilling</Badge>
                                      ) : queued ? (
                                        <Badge variant="warning">
                                          Queued {queuePosition ? `#${queuePosition}` : ''}
                                        </Badge>
                                      ) : (
                                        <Badge variant="success">Active</Badge>
                                      )}
                                      {isFediverseBridged ? (
                                        <Badge variant="success">
                                          <Link2 className="h-3 w-3" />
                                          Bridged
                                        </Badge>
                                      ) : null}
                                      {mapping.hasBotLabel ? (
                                        <Badge variant="outline">
                                          <Bot className="h-3 w-3" />
                                          Bot
                                        </Badge>
                                      ) : null}
                                    </div>
                                  </td>
                                  <td className="px-2 py-3 align-top">
                                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                                      {canManageThisMapping && canManageGroupsPermission ? (
                                        <select
                                          className={cn(selectClassName, 'h-8 w-28 px-1.5 py-1 text-xs')}
                                          value={mappingGroup.key}
                                          disabled={
                                            isBridgeAllBusy ||
                                            isAnyBulkAccountsActionBusy ||
                                            isSyncAllProfilesBusy ||
                                            Boolean(syncingProfileMappingId)
                                          }
                                          title="Move to folder"
                                          onChange={(event) => {
                                            void handleAssignMappingGroup(mapping, event.target.value);
                                          }}
                                        >
                                          <option value={DEFAULT_GROUP_KEY}>
                                            {DEFAULT_GROUP_EMOJI} {DEFAULT_GROUP_NAME}
                                          </option>
                                          {groupOptions
                                            .filter((option) => option.key !== DEFAULT_GROUP_KEY)
                                            .map((option) => (
                                              <option key={`group-move-${mapping.id}-${option.key}`} value={option.key}>
                                                {option.emoji} {option.name}
                                              </option>
                                            ))}
                                        </select>
                                      ) : null}
                                      {canManageThisMapping ? (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled={
                                            isBridgeAllBusy ||
                                            isAnyBulkAccountsActionBusy ||
                                            Boolean(syncingProfileMappingId)
                                          }
                                          onClick={() => startEditMapping(mapping)}
                                        >
                                          Edit
                                        </Button>
                                      ) : null}
                                      {canManageThisMapping ? (
                                        <DropdownMenu
                                          align="end"
                                          triggerClassName="h-9 w-9 px-0"
                                          trigger={<MoreHorizontal className="h-4 w-4" />}
                                        >
                                          {mapping.twitterUsernames.length > 1 ? (
                                            <div className="space-y-1 px-3 py-2" data-keep-open="true">
                                              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                                Profile sync source
                                              </p>
                                              <select
                                                className={cn(selectClassName, 'h-8 text-xs')}
                                                value={mapping.profileSyncSourceUsername || ''}
                                                disabled={
                                                  isBridgeAllBusy ||
                                                  isAnyBulkAccountsActionBusy ||
                                                  isSyncAllProfilesBusy ||
                                                  Boolean(syncingProfileMappingId) ||
                                                  Boolean(bridgingMappingId)
                                                }
                                                onChange={(event) => {
                                                  void handleUpdateProfileSyncSource(mapping, event.target.value);
                                                }}
                                              >
                                                <option value="">Select sync source</option>
                                                {mapping.twitterUsernames.map((username) => (
                                                  <option
                                                    key={`sync-source-${mapping.id}-${username}`}
                                                    value={username}
                                                  >
                                                    @{username}
                                                  </option>
                                                ))}
                                              </select>
                                              <DropdownMenuSeparator />
                                            </div>
                                          ) : null}
                                          <DropdownMenuItem
                                            icon={
                                              syncingProfile ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                              ) : (
                                                <RefreshCw className="h-4 w-4" />
                                              )
                                            }
                                            disabled={
                                              isBridgeAllBusy ||
                                              isAnyBulkAccountsActionBusy ||
                                              Boolean(syncingProfileMappingId) ||
                                              Boolean(pullingBioMappingId) ||
                                              isSyncAllProfilesBusy ||
                                              Boolean(bridgingMappingId)
                                            }
                                            onClick={() => {
                                              void handleSyncProfileFromTwitter(mapping);
                                            }}
                                          >
                                            Sync Profile
                                          </DropdownMenuItem>
                                          <DropdownMenuItem
                                            icon={
                                              pullingBio ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                              ) : (
                                                <Download className="h-4 w-4" />
                                              )
                                            }
                                            disabled={
                                              isBridgeAllBusy ||
                                              isAnyBulkAccountsActionBusy ||
                                              Boolean(syncingProfileMappingId) ||
                                              Boolean(pullingBioMappingId) ||
                                              isSyncAllProfilesBusy ||
                                              Boolean(bridgingMappingId)
                                            }
                                            onClick={() => {
                                              void handlePullTwitterBio(mapping);
                                            }}
                                          >
                                            Pull Twitter Bio
                                          </DropdownMenuItem>
                                          {canUseFediverseBridge && !isFediverseBridged ? (
                                            <DropdownMenuItem
                                              icon={
                                                bridging ? (
                                                  <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : (
                                                  <Repeat2 className="h-4 w-4" />
                                                )
                                              }
                                              disabled={
                                                isBridgeAllBusy ||
                                                isAnyBulkAccountsActionBusy ||
                                                Boolean(bridgingMappingId) ||
                                                Boolean(syncingProfileMappingId) ||
                                                isSyncAllProfilesBusy
                                              }
                                              onClick={() => {
                                                void handleBridgeToFediverse(mapping);
                                              }}
                                            >
                                              Bridge to Fediverse
                                            </DropdownMenuItem>
                                          ) : null}
                                          {canQueueBackfillsPermission ? (
                                            <>
                                              <DropdownMenuSeparator />
                                              <DropdownMenuItem
                                                icon={<Plus className="h-4 w-4" />}
                                                disabled={
                                                  isBridgeAllBusy ||
                                                  isAnyBulkAccountsActionBusy ||
                                                  Boolean(syncingProfileMappingId) ||
                                                  isSyncAllProfilesBusy
                                                }
                                                onClick={() => {
                                                  void requestBackfill(mapping.id, 'normal');
                                                }}
                                              >
                                                Add to queue
                                              </DropdownMenuItem>
                                              <DropdownMenuItem
                                                icon={<Pin className="h-4 w-4" />}
                                                disabled={
                                                  isBridgeAllBusy ||
                                                  isAnyBulkAccountsActionBusy ||
                                                  Boolean(syncingProfileMappingId) ||
                                                  isSyncAllProfilesBusy
                                                }
                                                onClick={() => {
                                                  void requestPinSync(mapping.id);
                                                }}
                                              >
                                                Sync Pin
                                              </DropdownMenuItem>
                                              {queued && !active ? (
                                                <DropdownMenuItem
                                                  disabled={
                                                    isBridgeAllBusy ||
                                                    isAnyBulkAccountsActionBusy ||
                                                    Boolean(syncingProfileMappingId) ||
                                                    isSyncAllProfilesBusy
                                                  }
                                                  onClick={() => {
                                                    void cancelQueuedBackfill(mapping.id);
                                                  }}
                                                >
                                                  Cancel queue
                                                </DropdownMenuItem>
                                              ) : null}
                                              {isAdmin ? (
                                                <DropdownMenuItem
                                                  disabled={
                                                    isBridgeAllBusy ||
                                                    isAnyBulkAccountsActionBusy ||
                                                    Boolean(syncingProfileMappingId) ||
                                                    isSyncAllProfilesBusy
                                                  }
                                                  onClick={() => {
                                                    void requestBackfill(mapping.id, 'reset');
                                                  }}
                                                >
                                                  Reset + Backfill
                                                </DropdownMenuItem>
                                              ) : null}
                                            </>
                                          ) : null}
                                          {isAdmin ? (
                                            <>
                                              <DropdownMenuSeparator />
                                              <DropdownMenuItem
                                                destructive
                                                icon={<Trash2 className="h-4 w-4" />}
                                                disabled={
                                                  isBridgeAllBusy ||
                                                  isAnyBulkAccountsActionBusy ||
                                                  Boolean(syncingProfileMappingId) ||
                                                  isSyncAllProfilesBusy
                                                }
                                                onClick={() => {
                                                  void handleDeleteAllPosts(mapping.id);
                                                }}
                                              >
                                                Delete Posts
                                              </DropdownMenuItem>
                                            </>
                                          ) : null}
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem
                                            destructive
                                            icon={<Trash2 className="h-4 w-4" />}
                                            disabled={
                                              isBridgeAllBusy ||
                                              isAnyBulkAccountsActionBusy ||
                                              Boolean(syncingProfileMappingId) ||
                                              isSyncAllProfilesBusy
                                            }
                                            onClick={() => {
                                              void handleDeleteMapping(mapping.id);
                                            }}
                                          >
                                            Remove mapping
                                          </DropdownMenuItem>
                                        </DropdownMenu>
                                      ) : null}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </Card>
                  )}
                </div>
              </section>
            ) : null}

            {activeTab === 'posts' ? (
              <section className="space-y-6">
                <Card className="">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-1">
                        <CardTitle>Already Posted</CardTitle>
                        <CardDescription>
                          Native-styled feed plus local SQLite search across all crossposted history.
                        </CardDescription>
                      </div>
                      <div className="grid w-full gap-2 md:max-w-2xl md:grid-cols-[1fr_240px]">
                        <div className="space-y-1">
                          <Label htmlFor="posts-search">Search crossposted posts</Label>
                          <div className="relative">
                            <Input
                              id="posts-search"
                              value={postsSearchQuery}
                              onChange={(event) => setPostsSearchQuery(event.target.value)}
                              placeholder="Search by text, @username, tweet id, or Bluesky handle"
                            />
                            {isSearchingLocalPosts ? (
                              <Loader2 className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                            ) : null}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="posts-group-filter">Filter group</Label>
                          <select
                            id="posts-group-filter"
                            className={selectClassName}
                            value={postsGroupFilter}
                            onChange={(event) => setPostsGroupFilter(event.target.value)}
                          >
                            <option value="all">All folders</option>
                            {groupOptions.map((group) => (
                              <option key={`posts-filter-${group.key}`} value={group.key}>
                                {group.emoji} {group.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {postsSearchQuery.trim() ? (
                      filteredLocalPostSearchResults.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                          {isSearchingLocalPosts ? 'Searching local history...' : 'No local crossposted posts matched.'}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {filteredLocalPostSearchResults.map((post) => {
                            const mapping = resolveMappingForLocalPost(post);
                            const groupMeta = getMappingGroupMeta(mapping);
                            const sourceTweetUrl =
                              post.twitterUrl || getTwitterPostUrl(post.twitterUsername, post.twitterId);
                            const postUrl =
                              post.postUrl ||
                              (post.bskyUri
                                ? `https://bsky.app/profile/${post.bskyIdentifier}/post/${
                                    post.bskyUri.split('/').filter(Boolean).pop() || ''
                                  }`
                                : undefined);

                            return (
                              <article
                                key={`${post.twitterId}-${post.bskyIdentifier}-${post.bskyCid || post.createdAt || 'result'}`}
                                className="rounded-lg border border-border/70 bg-background p-4"
                              >
                                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold">
                                      @{post.bskyIdentifier}{' '}
                                      <span className="text-muted-foreground">from @{post.twitterUsername}</span>
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {post.createdAt ? new Date(post.createdAt).toLocaleString() : 'Unknown time'}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Badge variant="outline">
                                      {groupMeta.emoji} {groupMeta.name}
                                    </Badge>
                                    <Badge variant="secondary">Relevance {Math.round(post.score)}</Badge>
                                  </div>
                                </div>
                                <p className="mb-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
                                  {post.tweetText || 'No local tweet text stored for this record.'}
                                </p>
                                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                                  <span className="font-mono">Tweet ID: {post.twitterId}</span>
                                  {sourceTweetUrl ? (
                                    <a
                                      className="inline-flex items-center text-foreground underline-offset-4 hover:underline"
                                      href={sourceTweetUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Source
                                      <ArrowUpRight className="ml-1 h-3 w-3" />
                                    </a>
                                  ) : null}
                                  {postUrl ? (
                                    <a
                                      className="inline-flex items-center text-foreground underline-offset-4 hover:underline"
                                      href={postUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Bluesky
                                      <ArrowUpRight className="ml-1 h-3 w-3" />
                                    </a>
                                  ) : null}
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      )
                    ) : filteredPostedActivity.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
                        No posted entries yet.
                      </div>
                    ) : (
                      <div className="grid gap-3 md:grid-cols-2">
                        {filteredPostedActivity.map((post, index) => {
                          const postUrl =
                            post.postUrl ||
                            (post.bskyUri
                              ? `https://bsky.app/profile/${post.bskyIdentifier}/post/${
                                  post.bskyUri.split('/').filter(Boolean).pop() || ''
                                }`
                              : undefined);
                          const sourceTweetUrl =
                            post.twitterUrl || getTwitterPostUrl(post.twitterUsername, post.twitterId);
                          const segments = buildFacetSegments(post.text, post.facets || []);
                          const mapping = resolveMappingForPost(post);
                          const groupMeta = getMappingGroupMeta(mapping);
                          const statItems: Array<{
                            key: 'likes' | 'reposts' | 'replies' | 'quotes';
                            value: number;
                            icon: typeof Heart;
                          }> = [
                            { key: 'likes', value: post.stats.likes, icon: Heart },
                            { key: 'reposts', value: post.stats.reposts, icon: Repeat2 },
                            { key: 'replies', value: post.stats.replies, icon: MessageCircle },
                            { key: 'quotes', value: post.stats.quotes, icon: Quote },
                          ].filter((item) => item.value > 0);
                          const authorAvatar = post.author.avatar || getProfileForActor(post.author.handle)?.avatar;
                          const authorHandle = post.author.handle || post.bskyIdentifier;
                          const authorName = post.author.displayName || authorHandle;

                          return (
                            <article
                              key={post.bskyUri || `${post.bskyCid || 'post'}-${post.createdAt || index}`}
                              className="cv-auto rounded-lg border border-border bg-background p-4"
                            >
                              <div className="mb-3 flex items-start justify-between gap-3">
                                <div className="flex items-center gap-2">
                                  {authorAvatar ? (
                                    <img
                                      className="h-9 w-9 rounded-full border border-border/70 object-cover"
                                      src={authorAvatar}
                                      alt={authorName}
                                      loading="lazy"
                                    />
                                  ) : (
                                    <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border/70 bg-muted text-muted-foreground">
                                      <UserRound className="h-4 w-4" />
                                    </div>
                                  )}
                                  <div>
                                    <p className="text-sm font-semibold">{authorName}</p>
                                    <p className="text-xs text-muted-foreground">
                                      @{authorHandle} • from @{post.twitterUsername}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Badge variant="outline">
                                    {groupMeta.emoji} {groupMeta.name}
                                  </Badge>
                                  <Badge variant="success">Posted</Badge>
                                </div>
                              </div>

                              <p className="mb-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
                                {segments.map((segment, segmentIndex) => {
                                  if (segment.type === 'text') {
                                    return <span key={`${post.bskyUri}-segment-${segmentIndex}`}>{segment.text}</span>;
                                  }

                                  const linkTone =
                                    segment.type === 'mention'
                                      ? 'text-cyan-600 hover:text-cyan-500 dark:text-cyan-300 dark:hover:text-cyan-200'
                                      : segment.type === 'tag'
                                        ? 'text-indigo-600 hover:text-indigo-500 dark:text-indigo-300 dark:hover:text-indigo-200'
                                        : 'text-sky-600 hover:text-sky-500 dark:text-sky-300 dark:hover:text-sky-200';

                                  return (
                                    <a
                                      key={`${post.bskyUri}-segment-${segmentIndex}`}
                                      className={cn('hover:underline', linkTone)}
                                      href={segment.href}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {segment.text}
                                    </a>
                                  );
                                })}
                              </p>

                              {post.media.length > 0 ? (
                                <div className="mb-3 space-y-2">
                                  {post.media.map((media, mediaIndex) => {
                                    if (media.type === 'image') {
                                      const imageSrc = media.url || media.thumb;
                                      if (!imageSrc) return null;
                                      return (
                                        <a
                                          key={`${post.bskyUri}-media-${mediaIndex}`}
                                          className="group block overflow-hidden rounded-lg border border-border/70 bg-muted"
                                          href={imageSrc}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          <img
                                            className="h-56 w-full object-cover"
                                            src={imageSrc}
                                            alt={media.alt || 'Bluesky media'}
                                            loading="lazy"
                                          />
                                        </a>
                                      );
                                    }

                                    if (media.type === 'video') {
                                      const videoHref = media.url || media.thumb;
                                      return (
                                        <div
                                          key={`${post.bskyUri}-media-${mediaIndex}`}
                                          className="group overflow-hidden rounded-lg border border-border/70 bg-muted"
                                        >
                                          {media.thumb ? (
                                            <img
                                              className="h-56 w-full object-cover"
                                              src={media.thumb}
                                              alt={media.alt || 'Video thumbnail'}
                                              loading="lazy"
                                            />
                                          ) : (
                                            <div className="flex h-44 items-center justify-center text-sm text-muted-foreground">
                                              Video attachment
                                            </div>
                                          )}
                                          {videoHref ? (
                                            <div className="border-t border-border/70 p-2 text-right">
                                              <a
                                                className="inline-flex items-center text-xs text-foreground underline-offset-4 hover:underline"
                                                href={videoHref}
                                                target="_blank"
                                                rel="noreferrer"
                                              >
                                                Open video
                                                <ArrowUpRight className="ml-1 h-3 w-3" />
                                              </a>
                                            </div>
                                          ) : null}
                                        </div>
                                      );
                                    }

                                    if (media.type === 'external') {
                                      if (!media.url) return null;
                                      return (
                                        <a
                                          key={`${post.bskyUri}-media-${mediaIndex}`}
                                          className="group block overflow-hidden rounded-lg border border-border/70 bg-background transition-colors hover:bg-muted/60"
                                          href={media.url}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          {media.thumb ? (
                                            <img
                                              className="h-40 w-full object-cover"
                                              src={media.thumb}
                                              alt={media.title || media.url}
                                              loading="lazy"
                                            />
                                          ) : null}
                                          <div className="space-y-1 p-3">
                                            <p className="truncate text-sm font-medium">{media.title || media.url}</p>
                                            {media.description ? (
                                              <p className="max-h-10 overflow-hidden text-xs text-muted-foreground">
                                                {media.description}
                                              </p>
                                            ) : null}
                                          </div>
                                        </a>
                                      );
                                    }

                                    return null;
                                  })}
                                </div>
                              ) : null}

                              {statItems.length > 0 ? (
                                <div className="mb-3 flex flex-wrap gap-2">
                                  {statItems.map((stat) => {
                                    const Icon = stat.icon;
                                    return (
                                      <span
                                        key={`${post.bskyUri}-stat-${stat.key}`}
                                        className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted px-2 py-1 text-xs text-muted-foreground"
                                      >
                                        <Icon className="h-3.5 w-3.5" />
                                        {formatCompactNumber(stat.value)}
                                      </span>
                                    );
                                  })}
                                </div>
                              ) : null}

                              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                                <span>
                                  {post.createdAt ? new Date(post.createdAt).toLocaleString() : 'Unknown time'}
                                </span>
                                <div className="flex items-center gap-3">
                                  {sourceTweetUrl ? (
                                    <a
                                      className="inline-flex items-center text-foreground underline-offset-4 hover:underline"
                                      href={sourceTweetUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Source
                                      <ArrowUpRight className="ml-1 h-3 w-3" />
                                    </a>
                                  ) : null}
                                  {postUrl ? (
                                    <a
                                      className="inline-flex items-center text-foreground underline-offset-4 hover:underline"
                                      href={postUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      Bluesky
                                      <ArrowUpRight className="ml-1 h-3 w-3" />
                                    </a>
                                  ) : (
                                    <span>Missing URI</span>
                                  )}
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </section>
            ) : null}

            {activeTab === 'activity' ? (
              <section className="space-y-6">
                <Card className="">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-1">
                        <CardTitle className="flex items-center gap-2">
                          <History className="h-4 w-4" />
                          Recent Activity
                        </CardTitle>
                        <CardDescription>Latest migration outcomes from the processing database.</CardDescription>
                      </div>
                      <div className="w-full max-w-xs">
                        <Label htmlFor="activity-group-filter">Filter group</Label>
                        <select
                          id="activity-group-filter"
                          className={selectClassName}
                          value={activityGroupFilter}
                          onChange={(event) => setActivityGroupFilter(event.target.value)}
                        >
                          <option value="all">All folders</option>
                          {groupOptions.map((group) => (
                            <option key={`activity-filter-${group.key}`} value={group.key}>
                              {group.emoji} {group.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-left text-sm">
                        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-2 py-3">Time</th>
                            <th className="px-2 py-3">Twitter User</th>
                            <th className="px-2 py-3">Group</th>
                            <th className="px-2 py-3">Status</th>
                            <th className="px-2 py-3">Details</th>
                            <th className="px-2 py-3 text-right">Link</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredRecentActivity.map((activity, index) => {
                            const href = getBskyPostUrl(activity);
                            const sourceTweetUrl = getTwitterPostUrl(activity.twitter_username, activity.twitter_id);
                            const mapping = resolveMappingForActivity(activity);
                            const groupMeta = getMappingGroupMeta(mapping);

                            return (
                              <tr
                                key={`${activity.twitter_id}-${activity.created_at || index}`}
                                className="interactive-row border-b border-border/60 last:border-0"
                              >
                                <td className="px-2 py-3 align-top text-xs text-muted-foreground">
                                  {activity.created_at
                                    ? new Date(activity.created_at).toLocaleTimeString([], {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })
                                    : '--'}
                                </td>
                                <td className="px-2 py-3 align-top font-medium">@{activity.twitter_username}</td>
                                <td className="px-2 py-3 align-top">
                                  <Badge variant="outline">
                                    {groupMeta.emoji} {groupMeta.name}
                                  </Badge>
                                </td>
                                <td className="px-2 py-3 align-top">
                                  {activity.status === 'migrated' ? (
                                    <Badge variant="success">Migrated</Badge>
                                  ) : activity.status === 'skipped' ? (
                                    <Badge variant="outline">Skipped</Badge>
                                  ) : (
                                    <Badge variant="danger">Failed</Badge>
                                  )}
                                </td>
                                <td className="px-2 py-3 align-top text-xs text-muted-foreground">
                                  <div className="max-w-[340px] truncate">
                                    {activity.tweet_text || `Tweet ID: ${activity.twitter_id}`}
                                  </div>
                                </td>
                                <td className="px-2 py-3 align-top text-right">
                                  <div className="flex flex-col items-end gap-1">
                                    {sourceTweetUrl ? (
                                      <a
                                        className="inline-flex items-center text-xs text-foreground underline-offset-4 hover:underline"
                                        href={sourceTweetUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        Source
                                        <ArrowUpRight className="ml-1 h-3 w-3" />
                                      </a>
                                    ) : null}
                                    {href ? (
                                      <a
                                        className="inline-flex items-center text-xs text-foreground underline-offset-4 hover:underline"
                                        href={href}
                                        target="_blank"
                                        rel="noreferrer"
                                      >
                                        Bluesky
                                        <ArrowUpRight className="ml-1 h-3 w-3" />
                                      </a>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">--</span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                          {filteredRecentActivity.length === 0 ? (
                            <tr>
                              <td className="px-2 py-6 text-center text-sm text-muted-foreground" colSpan={6}>
                                No activity for this filter.
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </section>
            ) : null}

            {activeTab === 'settings' ? (
              <section className="grid gap-6 lg:grid-cols-[200px_1fr]">
                <Card className="h-fit lg:sticky lg:top-6">
                  <CardContent className="p-2">
                    <NavList
                      items={settingsNavItems}
                      activeId={settingsActiveSection}
                      onSelect={setSettingsActiveSection}
                    />
                  </CardContent>
                </Card>

                <div className="min-w-0 space-y-6">
                  {settingsActiveSection === 'account' ? (
                    <Card className="">
                      <CardHeader>
                        <CardTitle>Account Security</CardTitle>
                        <CardDescription>Update your own email/password with verification.</CardDescription>
                      </CardHeader>
                      <CardContent className="grid gap-4 border-t border-border/70 pt-4 lg:grid-cols-2">
                        <form className="space-y-3" onSubmit={handleChangeOwnEmail}>
                          <p className="text-sm font-semibold">Change Email</p>
                          <div className="space-y-2">
                            <Label htmlFor="account-current-email">Current Email</Label>
                            <Input
                              id="account-current-email"
                              type="email"
                              value={emailForm.currentEmail}
                              onChange={(event) => {
                                setEmailForm((previous) => ({ ...previous, currentEmail: event.target.value }));
                              }}
                              placeholder={hasCurrentEmail ? undefined : 'No current email on this account'}
                              required={hasCurrentEmail}
                              disabled={!hasCurrentEmail}
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="account-new-email">New Email</Label>
                            <Input
                              id="account-new-email"
                              type="email"
                              value={emailForm.newEmail}
                              onChange={(event) => {
                                setEmailForm((previous) => ({ ...previous, newEmail: event.target.value }));
                              }}
                              required
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="account-email-password">Current Password</Label>
                            <Input
                              id="account-email-password"
                              type="password"
                              value={emailForm.password}
                              onChange={(event) => {
                                setEmailForm((previous) => ({ ...previous, password: event.target.value }));
                              }}
                              required
                            />
                          </div>
                          <Button className="w-full sm:w-auto" size="sm" type="submit" disabled={isBusy}>
                            <Save className="mr-2 h-4 w-4" />
                            Save Email
                          </Button>
                        </form>

                        <form className="space-y-3" onSubmit={handleChangeOwnPassword}>
                          <p className="text-sm font-semibold">Change Password</p>
                          <div className="space-y-2">
                            <Label htmlFor="account-current-password">Current Password</Label>
                            <Input
                              id="account-current-password"
                              type="password"
                              value={passwordForm.currentPassword}
                              onChange={(event) => {
                                setPasswordForm((previous) => ({ ...previous, currentPassword: event.target.value }));
                              }}
                              required
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="account-new-password">New Password</Label>
                            <Input
                              id="account-new-password"
                              type="password"
                              value={passwordForm.newPassword}
                              onChange={(event) => {
                                setPasswordForm((previous) => ({ ...previous, newPassword: event.target.value }));
                              }}
                              required
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="account-confirm-password">Confirm New Password</Label>
                            <Input
                              id="account-confirm-password"
                              type="password"
                              value={passwordForm.confirmPassword}
                              onChange={(event) => {
                                setPasswordForm((previous) => ({ ...previous, confirmPassword: event.target.value }));
                              }}
                              required
                            />
                          </div>
                          <Button className="w-full sm:w-auto" size="sm" type="submit" disabled={isBusy}>
                            <Save className="mr-2 h-4 w-4" />
                            Save Password
                          </Button>
                        </form>
                      </CardContent>
                    </Card>
                  ) : null}

                  {settingsActiveSection === 'account' && !isAdmin ? (
                    <Card className="">
                      <CardHeader>
                        <CardTitle>Access Scope</CardTitle>
                        <CardDescription>Your current account permissions.</CardDescription>
                      </CardHeader>
                      <CardContent className="flex flex-wrap gap-2 pt-0">
                        {PERMISSION_OPTIONS.filter((permission) => effectivePermissions[permission.key]).map(
                          (permission) => (
                            <Badge key={`self-perm-${permission.key}`} variant="outline">
                              {permission.label}
                            </Badge>
                          ),
                        )}
                      </CardContent>
                    </Card>
                  ) : null}

                  {settingsActiveSection === 'system' && isAdmin ? (
                    <Card className="">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <Settings2 className="h-4 w-4" />
                          Admin Settings
                        </CardTitle>
                        <CardDescription>Running version, updates, and quick account creation.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4 pt-0">
                        <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="space-y-1">
                              <p className="text-sm font-semibold">Running Version</p>
                              <p className="font-mono text-sm text-foreground">{runtimeVersionLabel}</p>
                              {runtimeBranchLabel ? (
                                <p className="text-xs text-muted-foreground">{runtimeBranchLabel}</p>
                              ) : null}
                              <p className="text-xs text-muted-foreground">{updateStateLabel}</p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                onClick={() => {
                                  void handleRunUpdate();
                                }}
                                disabled={isUpdateBusy || updateStatus?.running}
                              >
                                {isUpdateBusy || updateStatus?.running ? (
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <RefreshCw className="mr-2 h-4 w-4" />
                                )}
                                {updateStatus?.running ? 'Updating...' : 'Update'}
                              </Button>
                              {canCreateMappings ? (
                                <Button className="w-full sm:w-auto" onClick={openAddAccountSheet}>
                                  <Plus className="mr-2 h-4 w-4" />
                                  Add Account
                                </Button>
                              ) : null}
                            </div>
                          </div>
                          {updateStatus?.logTail && updateStatus.logTail.length > 0 ? (
                            <details className="mt-3">
                              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                                Update log
                              </summary>
                              <pre className="mt-2 max-h-44 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                                {updateStatus.logTail.join('\n')}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  ) : null}

                  {settingsActiveSection === 'users' && isAdmin ? (
                    <Card className="">
                      <CardHeader>
                        <CardTitle>User Access Manager</CardTitle>
                        <CardDescription>Create users and control what they can see/manage.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4 border-t border-border/70 pt-4">
                        <form
                          className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3"
                          onSubmit={handleCreateUser}
                        >
                          <p className="text-sm font-semibold">Create User</p>
                          <div className="grid gap-3 md:grid-cols-3">
                            <div className="space-y-2">
                              <Label htmlFor="new-user-username">Username</Label>
                              <Input
                                id="new-user-username"
                                value={newUserForm.username}
                                onChange={(event) => {
                                  setNewUserForm((previous) => ({ ...previous, username: event.target.value }));
                                }}
                                placeholder="operator"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="new-user-email">Email</Label>
                              <Input
                                id="new-user-email"
                                type="email"
                                value={newUserForm.email}
                                onChange={(event) => {
                                  setNewUserForm((previous) => ({ ...previous, email: event.target.value }));
                                }}
                                placeholder="operator@example.com"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="new-user-password">Password</Label>
                              <Input
                                id="new-user-password"
                                type="password"
                                value={newUserForm.password}
                                onChange={(event) => {
                                  setNewUserForm((previous) => ({ ...previous, password: event.target.value }));
                                }}
                                placeholder="Minimum 8 characters"
                                required
                              />
                            </div>
                          </div>

                          <label className="inline-flex items-center gap-2 text-sm font-medium">
                            <input
                              type="checkbox"
                              checked={newUserForm.isAdmin}
                              onChange={(event) => {
                                setNewUserForm((previous) => ({
                                  ...previous,
                                  isAdmin: event.target.checked,
                                }));
                              }}
                            />
                            Make admin
                          </label>

                          {!newUserForm.isAdmin ? (
                            <div className="grid gap-2 md:grid-cols-2">
                              {PERMISSION_OPTIONS.map((permission) => (
                                <label
                                  key={`new-user-permission-${permission.key}`}
                                  className="rounded-md border border-border/70 bg-background px-3 py-2 text-xs"
                                >
                                  <span className="flex items-center justify-between gap-2">
                                    <span className="font-medium">{permission.label}</span>
                                    <input
                                      type="checkbox"
                                      checked={newUserForm.permissions[permission.key]}
                                      onChange={(event) => {
                                        const checked = event.target.checked;
                                        setNewUserForm((previous) => ({
                                          ...previous,
                                          permissions: {
                                            ...previous.permissions,
                                            [permission.key]: checked,
                                          },
                                        }));
                                      }}
                                    />
                                  </span>
                                  <span className="mt-1 block text-muted-foreground">{permission.help}</span>
                                </label>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">Admins always get full access.</p>
                          )}

                          <Button size="sm" type="submit" disabled={isBusy}>
                            <Plus className="mr-2 h-4 w-4" />
                            Create user
                          </Button>
                        </form>

                        {managedUsers.length === 0 ? (
                          <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                            No user accounts created yet.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {managedUsers.map((user) => {
                              const isEditing = editingUserId === user.id;
                              const displayName = user.username || user.email || user.id;
                              return (
                                <div
                                  key={`managed-user-${user.id}`}
                                  className="rounded-lg border border-border/70 bg-card/60 p-3"
                                >
                                  {isEditing ? (
                                    <div className="space-y-3">
                                      <div className="grid gap-3 md:grid-cols-2">
                                        <div className="space-y-1">
                                          <Label htmlFor={`edit-user-username-${user.id}`}>Username</Label>
                                          <Input
                                            id={`edit-user-username-${user.id}`}
                                            value={editingUserForm.username}
                                            onChange={(event) => {
                                              setEditingUserForm((previous) => ({
                                                ...previous,
                                                username: event.target.value,
                                              }));
                                            }}
                                          />
                                        </div>
                                        <div className="space-y-1">
                                          <Label htmlFor={`edit-user-email-${user.id}`}>Email</Label>
                                          <Input
                                            id={`edit-user-email-${user.id}`}
                                            type="email"
                                            value={editingUserForm.email}
                                            onChange={(event) => {
                                              setEditingUserForm((previous) => ({
                                                ...previous,
                                                email: event.target.value,
                                              }));
                                            }}
                                          />
                                        </div>
                                      </div>

                                      <label className="inline-flex items-center gap-2 text-sm font-medium">
                                        <input
                                          type="checkbox"
                                          checked={editingUserForm.isAdmin}
                                          onChange={(event) => {
                                            setEditingUserForm((previous) => ({
                                              ...previous,
                                              isAdmin: event.target.checked,
                                            }));
                                          }}
                                        />
                                        Admin access
                                      </label>

                                      {!editingUserForm.isAdmin ? (
                                        <div className="grid gap-2 md:grid-cols-2">
                                          {PERMISSION_OPTIONS.map((permission) => (
                                            <label
                                              key={`edit-user-permission-${user.id}-${permission.key}`}
                                              className="rounded-md border border-border/70 bg-background px-3 py-2 text-xs"
                                            >
                                              <span className="flex items-center justify-between gap-2">
                                                <span className="font-medium">{permission.label}</span>
                                                <input
                                                  type="checkbox"
                                                  checked={editingUserForm.permissions[permission.key]}
                                                  onChange={(event) => {
                                                    const checked = event.target.checked;
                                                    setEditingUserForm((previous) => ({
                                                      ...previous,
                                                      permissions: {
                                                        ...previous.permissions,
                                                        [permission.key]: checked,
                                                      },
                                                    }));
                                                  }}
                                                />
                                              </span>
                                              <span className="mt-1 block text-muted-foreground">
                                                {permission.help}
                                              </span>
                                            </label>
                                          ))}
                                        </div>
                                      ) : null}

                                      <div className="flex flex-wrap justify-end gap-2">
                                        <Button size="sm" variant="ghost" onClick={resetEditingUser} type="button">
                                          Cancel
                                        </Button>
                                        <Button
                                          size="sm"
                                          onClick={() => {
                                            void handleSaveEditedUser(user.id);
                                          }}
                                          type="button"
                                          disabled={isBusy}
                                        >
                                          Save user
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="space-y-3">
                                      <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="space-y-1">
                                          <p className="text-sm font-semibold">{displayName}</p>
                                          <p className="text-xs text-muted-foreground">
                                            {user.email ? `Email: ${user.email}` : 'No email set'}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            {user.mappingCount} mappings ({user.activeMappingCount} active)
                                          </p>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <Badge variant={user.isAdmin ? 'success' : 'outline'}>
                                            {user.isAdmin ? 'Admin' : 'User'}
                                          </Badge>
                                          {user.id === me?.id ? <Badge variant="secondary">You</Badge> : null}
                                        </div>
                                      </div>

                                      {!user.isAdmin ? (
                                        <div className="flex flex-wrap gap-2">
                                          {PERMISSION_OPTIONS.filter(
                                            (permission) => user.permissions[permission.key],
                                          ).map((permission) => (
                                            <Badge key={`user-perm-${user.id}-${permission.key}`} variant="outline">
                                              {permission.label}
                                            </Badge>
                                          ))}
                                        </div>
                                      ) : null}

                                      <div className="flex flex-wrap gap-2">
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => {
                                            setAccountsCreatorFilter(user.id);
                                            setActiveTab('accounts');
                                          }}
                                        >
                                          View Accounts
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={() => beginEditUser(user)}>
                                          Edit
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => {
                                            void handleResetUserPassword(user.id);
                                          }}
                                        >
                                          Reset Password
                                        </Button>
                                        {user.id !== me?.id ? (
                                          <Button
                                            size="sm"
                                            variant="ghost"
                                            className="text-red-600 hover:text-red-500 dark:text-red-300 dark:hover:text-red-200"
                                            onClick={() => {
                                              void handleDeleteUser(user);
                                            }}
                                          >
                                            Delete
                                          </Button>
                                        ) : null}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  ) : null}

                  {settingsActiveSection === 'twitter' && isAdmin ? (
                    <Card className="">
                      <CardHeader>
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <CardTitle>Twitter Credentials</CardTitle>
                            <CardDescription>Primary and backup cookie values.</CardDescription>
                          </div>
                          <Badge variant={twitterConfigured ? 'success' : 'outline'}>
                            {twitterConfigured ? 'Configured' : 'Missing'}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3 border-t border-border/70 pt-4">
                        <form className="space-y-3" onSubmit={handleSaveTwitterConfig}>
                          <div className="space-y-2">
                            <Label htmlFor="authToken">Primary Auth Token</Label>
                            <Input
                              id="authToken"
                              value={twitterConfig.authToken}
                              onChange={(event) => {
                                setTwitterConfig((prev) => ({ ...prev, authToken: event.target.value }));
                              }}
                              required
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="ct0">Primary CT0</Label>
                            <Input
                              id="ct0"
                              value={twitterConfig.ct0}
                              onChange={(event) => {
                                setTwitterConfig((prev) => ({ ...prev, ct0: event.target.value }));
                              }}
                              required
                            />
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label htmlFor="backupAuthToken">Backup Auth Token</Label>
                              <Input
                                id="backupAuthToken"
                                value={twitterConfig.backupAuthToken || ''}
                                onChange={(event) => {
                                  setTwitterConfig((prev) => ({ ...prev, backupAuthToken: event.target.value }));
                                }}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="backupCt0">Backup CT0</Label>
                              <Input
                                id="backupCt0"
                                value={twitterConfig.backupCt0 || ''}
                                onChange={(event) => {
                                  setTwitterConfig((prev) => ({ ...prev, backupCt0: event.target.value }));
                                }}
                              />
                            </div>
                          </div>

                          <Button className="w-full sm:w-auto" size="sm" type="submit" disabled={isBusy}>
                            <Save className="mr-2 h-4 w-4" />
                            Save Twitter Credentials
                          </Button>
                        </form>
                      </CardContent>
                    </Card>
                  ) : null}

                  {settingsActiveSection === 'ai' && isAdmin ? (
                    <Card className="">
                      <CardHeader>
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <CardTitle>AI Settings</CardTitle>
                            <CardDescription>Optional enrichment and rewrite provider config.</CardDescription>
                          </div>
                          <Badge variant={aiConfigured ? 'success' : 'outline'}>
                            {aiConfigured ? 'Configured' : 'Optional'}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3 border-t border-border/70 pt-4">
                        <form className="space-y-3" onSubmit={handleSaveAiConfig}>
                          <div className="space-y-2">
                            <Label htmlFor="provider">Provider</Label>
                            <select
                              className={selectClassName}
                              id="provider"
                              value={aiConfig.provider}
                              onChange={(event) => {
                                setAiConfig((prev) => ({
                                  ...prev,
                                  provider: event.target.value as AIConfig['provider'],
                                }));
                              }}
                            >
                              <option value="gemini">Google Gemini</option>
                              <option value="openai">OpenAI / OpenRouter</option>
                              <option value="anthropic">Anthropic</option>
                              <option value="custom">Custom</option>
                            </select>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="apiKey">API Key</Label>
                            <Input
                              id="apiKey"
                              type="password"
                              value={aiConfig.apiKey || ''}
                              onChange={(event) => {
                                setAiConfig((prev) => ({ ...prev, apiKey: event.target.value }));
                              }}
                            />
                          </div>
                          {aiConfig.provider !== 'gemini' ? (
                            <>
                              <div className="space-y-2">
                                <Label htmlFor="model">Model ID</Label>
                                <Input
                                  id="model"
                                  value={aiConfig.model || ''}
                                  onChange={(event) => {
                                    setAiConfig((prev) => ({ ...prev, model: event.target.value }));
                                  }}
                                  placeholder="gpt-4o"
                                />
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="baseUrl">Base URL</Label>
                                <Input
                                  id="baseUrl"
                                  value={aiConfig.baseUrl || ''}
                                  onChange={(event) => {
                                    setAiConfig((prev) => ({ ...prev, baseUrl: event.target.value }));
                                  }}
                                  placeholder="https://api.example.com/v1"
                                />
                              </div>
                            </>
                          ) : null}

                          <Button className="w-full sm:w-auto" size="sm" type="submit" disabled={isBusy}>
                            <Bot className="mr-2 h-4 w-4" />
                            Save AI Settings
                          </Button>
                        </form>
                      </CardContent>
                    </Card>
                  ) : null}

                  {settingsActiveSection === 'data' && isAdmin ? (
                    <Card className="">
                      <CardHeader>
                        <CardTitle>Data Management</CardTitle>
                        <CardDescription>Export/import mappings and provider settings.</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3 border-t border-border/70 pt-4">
                        <Button className="w-full sm:w-auto" variant="outline" onClick={handleExportConfig}>
                          <Download className="mr-2 h-4 w-4" />
                          Export configuration
                        </Button>
                        <input
                          ref={importInputRef}
                          className="hidden"
                          type="file"
                          accept="application/json,.json"
                          onChange={(event) => {
                            void handleImportConfig(event);
                          }}
                        />
                        <Button
                          className="w-full sm:w-auto"
                          variant="outline"
                          onClick={() => {
                            importInputRef.current?.click();
                          }}
                        >
                          <Upload className="mr-2 h-4 w-4" />
                          Import configuration
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          Imports preserve dashboard users and passwords while replacing mappings, provider keys, and
                          scheduler settings.
                        </p>
                      </CardContent>
                    </Card>
                  ) : null}
                </div>
              </section>
            ) : null}
            {isAddAccountSheetOpen ? (
              <div
                className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-stretch sm:justify-end"
                onClick={closeAddAccountSheet}
              >
                <aside
                  className="flex h-[95vh] w-full max-w-xl flex-col rounded-t-2xl border border-border/80 bg-card shadow-2xl sm:h-full sm:rounded-none sm:rounded-l-2xl"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="flex items-start justify-between border-b border-border/70 px-5 py-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">Add Account</p>
                      <h2 className="text-lg font-semibold">Create Crosspost Mapping</h2>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={closeAddAccountSheet}
                      aria-label="Close add account flow"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="border-b border-border/70 px-5 py-3">
                    <div className="flex items-center gap-2">
                      {ADD_ACCOUNT_STEPS.map((label, index) => {
                        const step = index + 1;
                        const active = step === addAccountStep;
                        const complete = step < addAccountStep;
                        return (
                          <div key={label} className="flex min-w-0 flex-1 items-center gap-2">
                            <div
                              className={cn(
                                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                                complete && 'border-foreground bg-foreground text-background',
                                active && 'border-foreground text-foreground',
                                !active && !complete && 'border-border text-muted-foreground',
                              )}
                            >
                              {step}
                            </div>
                            <span
                              className={cn(
                                'truncate text-xs',
                                active ? 'text-foreground' : complete ? 'text-foreground/90' : 'text-muted-foreground',
                              )}
                            >
                              {label}
                            </span>
                            {step < ADD_ACCOUNT_STEP_COUNT ? <div className="h-px flex-1 bg-border/70" /> : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto px-5 py-4">
                    {addAccountStep === 1 ? (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold">Add Twitter source account(s)</p>
                          <p className="text-xs text-muted-foreground">
                            Enter one or more usernames. We will preview metadata from your selected source.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="add-account-twitter-usernames">Twitter Usernames</Label>
                          <div className="flex gap-2">
                            <Input
                              id="add-account-twitter-usernames"
                              value={newTwitterInput}
                              onChange={(event) => {
                                setNewTwitterInput(event.target.value);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ',') {
                                  event.preventDefault();
                                  addNewTwitterUsername();
                                }
                              }}
                              placeholder="@accountname"
                            />
                            <Button
                              variant="outline"
                              type="button"
                              disabled={normalizeTwitterUsername(newTwitterInput).length === 0}
                              onClick={addNewTwitterUsername}
                            >
                              Add
                            </Button>
                          </div>
                        </div>
                        <div className="flex min-h-7 flex-wrap gap-2">
                          {newTwitterUsers.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No source usernames added yet.</p>
                          ) : (
                            newTwitterUsers.map((username) => (
                              <Badge key={`new-${username}`} variant="secondary" className="gap-1 pr-1">
                                @{username}
                                <button
                                  type="button"
                                  className="rounded-full px-1 text-muted-foreground transition hover:bg-background hover:text-foreground"
                                  onClick={() => removeNewTwitterUsername(username)}
                                  aria-label={`Remove @${username}`}
                                >
                                  ×
                                </button>
                              </Badge>
                            ))
                          )}
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="add-account-source-select">Profile Mirror Source</Label>
                          <select
                            id="add-account-source-select"
                            className={selectClassName}
                            value={selectedMirrorSourceUsername}
                            onChange={(event) => {
                              setSelectedMirrorSourceUsername(event.target.value);
                            }}
                          >
                            {newTwitterUsers.map((username) => (
                              <option key={`source-${username}`} value={username}>
                                @{username}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium">Twitter metadata preview</p>
                            <Button
                              variant="outline"
                              size="sm"
                              type="button"
                              disabled={!selectedMirrorSourceUsername || isMirrorPreviewLoading}
                              onClick={() => {
                                if (!selectedMirrorSourceUsername) return;
                                void ensureTwitterMirrorProfileLoaded(selectedMirrorSourceUsername);
                              }}
                            >
                              {isMirrorPreviewLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                              Refresh preview
                            </Button>
                          </div>
                          {selectedMirrorPreview ? (
                            <>
                              <p>
                                <span className="font-medium">Display name:</span>{' '}
                                {selectedMirrorPreview.mirroredDisplayName}
                              </p>
                              <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                                {selectedMirrorPreview.mirroredDescription}
                              </p>
                            </>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Add a username and fetch preview to confirm the mirrored profile text.
                            </p>
                          )}
                        </div>
                      </div>
                    ) : null}

                    {addAccountStep === 2 ? (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold">Create Bluesky account (or use existing)</p>
                          <p className="text-xs text-muted-foreground">
                            Open Bluesky in a new tab, create account if needed, then generate an app password.
                          </p>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Button asChild variant="outline">
                            <a href="https://bsky.app" target="_blank" rel="noreferrer">
                              Create account
                              <ArrowUpRight className="ml-2 h-4 w-4" />
                            </a>
                          </Button>
                          <Button asChild variant="outline">
                            <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noreferrer">
                              I have an account
                              <ArrowUpRight className="ml-2 h-4 w-4" />
                            </a>
                          </Button>
                        </div>
                        <p className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                          Keep this drawer open, finish account setup in Bluesky, then continue to enter credentials.
                        </p>
                      </div>
                    ) : null}

                    {addAccountStep === 3 ? (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold">Enter Bluesky credentials</p>
                          <p className="text-xs text-muted-foreground">Support includes custom PDS/service URLs.</p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="add-account-bsky-identifier">Bluesky Identifier</Label>
                          <Input
                            id="add-account-bsky-identifier"
                            value={newMapping.bskyIdentifier}
                            onChange={(event) => {
                              setNewMapping((previous) => ({ ...previous, bskyIdentifier: event.target.value }));
                            }}
                            placeholder="example.bsky.social"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="add-account-bsky-password">Bluesky App Password</Label>
                          <Input
                            id="add-account-bsky-password"
                            type="password"
                            value={newMapping.bskyPassword}
                            onChange={(event) => {
                              setNewMapping((previous) => ({ ...previous, bskyPassword: event.target.value }));
                            }}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="add-account-bsky-url">Bluesky Service URL</Label>
                          <Input
                            id="add-account-bsky-url"
                            value={newMapping.bskyServiceUrl}
                            onChange={(event) => {
                              setNewMapping((previous) => ({ ...previous, bskyServiceUrl: event.target.value }));
                            }}
                            placeholder="https://bsky.social"
                          />
                        </div>
                        <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-medium">Credential check</p>
                            <Button
                              variant="outline"
                              size="sm"
                              type="button"
                              disabled={isCredentialValidationBusy}
                              onClick={() => {
                                void validateAddAccountCredentials();
                              }}
                            >
                              {isCredentialValidationBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                              Validate
                            </Button>
                          </div>
                          {validatedBskyCredentials ? (
                            <p className="text-xs text-muted-foreground">
                              Authenticated as @{validatedBskyCredentials.handle} on{' '}
                              {validatedBskyCredentials.serviceUrl}.
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Validate now, or use Next to validate automatically.
                            </p>
                          )}
                        </div>
                      </div>
                    ) : null}

                    {addAccountStep === 4 ? (
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <p className="text-sm font-semibold">Verify email and create mapping</p>
                          <p className="text-xs text-muted-foreground">
                            Verify email in Bluesky, then create mapping to auto-sync name, bio, avatar, and banner, and
                            apply the Bluesky bot self-label.
                          </p>
                        </div>
                        <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                          <p>
                            <span className="font-medium">Email status:</span>{' '}
                            {validatedBskyCredentials?.emailConfirmed ? 'confirmed' : 'not confirmed yet'}
                          </p>
                          <Button asChild variant="outline" size="sm">
                            <a
                              href={validatedBskyCredentials?.settingsUrl || 'https://bsky.app/settings/account'}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open Bluesky account settings
                              <ArrowUpRight className="ml-2 h-4 w-4" />
                            </a>
                          </Button>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="add-account-owner">Owner (Optional)</Label>
                          <Input
                            id="add-account-owner"
                            value={newMapping.owner}
                            onChange={(event) => {
                              setNewMapping((previous) => ({ ...previous, owner: event.target.value }));
                            }}
                            placeholder="jack"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Use Existing Folder (Optional)</Label>
                          {reusableGroupOptions.length === 0 ? (
                            <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
                              No folders yet. Create one below or from the Accounts tab.
                            </p>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {reusableGroupOptions.map((group) => {
                                const selected = getGroupKey(newMapping.groupName) === group.key;
                                return (
                                  <button
                                    key={`preset-group-${group.key}`}
                                    className={cn(
                                      'inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs transition-colors',
                                      selected
                                        ? 'border-foreground bg-foreground text-background'
                                        : 'border-border bg-background text-foreground hover:bg-muted',
                                    )}
                                    onClick={() => applyGroupPresetToNewMapping(group.key)}
                                    type="button"
                                  >
                                    <span>{group.emoji}</span>
                                    <span>{group.name}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                          <div className="space-y-2">
                            <Label htmlFor="add-account-group-name">Folder / Group Name (Optional)</Label>
                            <Input
                              id="add-account-group-name"
                              value={newMapping.groupName}
                              onChange={(event) => {
                                setNewMapping((previous) => ({ ...previous, groupName: event.target.value }));
                              }}
                              placeholder="Gaming, News, Sports..."
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="add-account-group-emoji">Emoji</Label>
                            <Input
                              id="add-account-group-emoji"
                              value={newMapping.groupEmoji}
                              onChange={(event) => {
                                setNewMapping((previous) => ({ ...previous, groupEmoji: event.target.value }));
                              }}
                              maxLength={8}
                              placeholder={DEFAULT_GROUP_EMOJI}
                            />
                          </div>
                        </div>
                        <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
                          <p>
                            <span className="font-medium">Owner:</span> {newMapping.owner || '--'}
                          </p>
                          <p>
                            <span className="font-medium">Twitter Sources:</span>{' '}
                            {newTwitterUsers.length > 0
                              ? newTwitterUsers.map((username) => `@${username}`).join(', ')
                              : '--'}
                          </p>
                          <p>
                            <span className="font-medium">Bluesky Target:</span> {newMapping.bskyIdentifier || '--'}
                          </p>
                          <p>
                            <span className="font-medium">Mirror Source:</span>{' '}
                            {selectedMirrorSourceUsername ? `@${selectedMirrorSourceUsername}` : '--'}
                          </p>
                          {selectedMirrorPreview ? (
                            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                              {selectedMirrorPreview.mirroredDescription}
                            </p>
                          ) : null}
                          <p>
                            <span className="font-medium">Folder:</span>{' '}
                            {newMapping.groupName.trim()
                              ? `${newMapping.groupEmoji.trim() || DEFAULT_GROUP_EMOJI} ${newMapping.groupName.trim()}`
                              : `${DEFAULT_GROUP_EMOJI} ${DEFAULT_GROUP_NAME}`}
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-border/70 px-5 py-4">
                    <Button variant="outline" onClick={retreatAddAccountStep} disabled={addAccountStep === 1 || isBusy}>
                      <ChevronLeft className="mr-2 h-4 w-4" />
                      Back
                    </Button>
                    {addAccountStep < ADD_ACCOUNT_STEP_COUNT ? (
                      <Button
                        onClick={advanceAddAccountStep}
                        disabled={isBusy || isMirrorPreviewLoading || isCredentialValidationBusy}
                      >
                        Next
                        <ChevronRight className="ml-2 h-4 w-4" />
                      </Button>
                    ) : (
                      <Button onClick={() => void submitNewMapping()} disabled={isBusy}>
                        {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                        Create Account
                      </Button>
                    )}
                  </div>
                </aside>
              </div>
            ) : null}

            {editingMapping ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                <Card className="w-full max-w-xl border-border/90 bg-card">
                  <CardHeader>
                    <CardTitle>Edit Mapping</CardTitle>
                    <CardDescription>Update ownership, handles, and target credentials.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form className="space-y-3" onSubmit={handleUpdateMapping}>
                      <div className="space-y-2">
                        <Label htmlFor="edit-owner">Owner</Label>
                        <Input
                          id="edit-owner"
                          value={editForm.owner}
                          onChange={(event) => {
                            setEditForm((prev) => ({ ...prev, owner: event.target.value }));
                          }}
                          required
                        />
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                        <div className="space-y-2">
                          <Label htmlFor="edit-groupName">Folder / Group Name</Label>
                          <Input
                            id="edit-groupName"
                            value={editForm.groupName}
                            onChange={(event) => {
                              setEditForm((prev) => ({ ...prev, groupName: event.target.value }));
                            }}
                            placeholder="Gaming, News, Sports..."
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="edit-groupEmoji">Emoji</Label>
                          <Input
                            id="edit-groupEmoji"
                            value={editForm.groupEmoji}
                            onChange={(event) => {
                              setEditForm((prev) => ({ ...prev, groupEmoji: event.target.value }));
                            }}
                            placeholder="📁"
                            maxLength={8}
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-twitterUsernames">Twitter Usernames</Label>
                        <div className="flex gap-2">
                          <Input
                            id="edit-twitterUsernames"
                            value={editTwitterInput}
                            onChange={(event) => {
                              setEditTwitterInput(event.target.value);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ',') {
                                event.preventDefault();
                                addEditTwitterUsername();
                              }
                            }}
                            placeholder="@accountname"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            disabled={normalizeTwitterUsername(editTwitterInput).length === 0}
                            onClick={addEditTwitterUsername}
                          >
                            Add
                          </Button>
                        </div>
                        <div className="flex min-h-7 flex-wrap gap-2">
                          {editTwitterUsers.map((username) => (
                            <Badge key={`edit-${username}`} variant="secondary" className="gap-1 pr-1">
                              @{username}
                              <button
                                type="button"
                                className="rounded-full px-1 text-muted-foreground transition hover:bg-background hover:text-foreground"
                                onClick={() => removeEditTwitterUsername(username)}
                                aria-label={`Remove @${username}`}
                              >
                                ×
                              </button>
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-bskyIdentifier">Bluesky Identifier</Label>
                        <Input
                          id="edit-bskyIdentifier"
                          value={editForm.bskyIdentifier}
                          onChange={(event) => {
                            setEditForm((prev) => ({ ...prev, bskyIdentifier: event.target.value }));
                          }}
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-profile-sync-source">Profile Sync Source</Label>
                        <select
                          id="edit-profile-sync-source"
                          className={selectClassName}
                          value={editForm.profileSyncSourceUsername}
                          onChange={(event) => {
                            setEditForm((previous) => ({ ...previous, profileSyncSourceUsername: event.target.value }));
                          }}
                        >
                          {editTwitterUsers.length > 1 ? <option value="">Select source username</option> : null}
                          {editTwitterUsers.map((username) => (
                            <option key={`edit-sync-source-${username}`} value={username}>
                              @{username}
                            </option>
                          ))}
                        </select>
                        {editTwitterUsers.length > 1 ? (
                          <p className="text-xs text-muted-foreground">
                            Required when multiple Twitter usernames map to one Bluesky account.
                          </p>
                        ) : null}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-bskyPassword">New App Password (optional)</Label>
                        <Input
                          id="edit-bskyPassword"
                          type="password"
                          value={editForm.bskyPassword}
                          onChange={(event) => {
                            setEditForm((prev) => ({ ...prev, bskyPassword: event.target.value }));
                          }}
                          placeholder="Leave blank to keep existing"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-bskyServiceUrl">Service URL</Label>
                        <Input
                          id="edit-bskyServiceUrl"
                          value={editForm.bskyServiceUrl}
                          onChange={(event) => {
                            setEditForm((prev) => ({ ...prev, bskyServiceUrl: event.target.value }));
                          }}
                        />
                      </div>

                      <div className="flex flex-wrap justify-end gap-2 pt-2">
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => {
                            setEditingMapping(null);
                          }}
                        >
                          Cancel
                        </Button>
                        <Button type="submit" disabled={isBusy}>
                          {isBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                          Save changes
                        </Button>
                      </div>
                    </form>
                  </CardContent>
                </Card>
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
