// Shared shapes for the dashboard: what the API returns and what the UI keeps
// in state. Extracted from App.tsx so views can be split out of the monolith
// without each one re-declaring the payloads it renders.

export type ThemeMode = 'system' | 'light' | 'dark';
export type AuthView = 'login' | 'register';
export type DashboardTab = 'overview' | 'accounts' | 'posts' | 'activity' | 'settings';
export type SettingsSection = 'account' | 'system' | 'users' | 'twitter' | 'ai' | 'data';
export type BulkAccountsAction =
  | 'sync_profiles'
  | 'pull_twitter_bio'
  | 'bridge_all'
  | 'apply_bot_label'
  | 'append_bot_name'
  | 'sync_pins';

export type AppState = 'idle' | 'checking' | 'backfilling' | 'pacing' | 'processing';

export interface AccountMapping {
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
  bskyDid?: string;
  mirrorFromMs?: number;
  sensitiveFallbackLabel?: SensitiveFallbackLabel;
  editMode?: EditMode;
  mirrorRetweets?: boolean;
  mirrorRepliesToMirrors?: boolean;
  imageLayout?: ImageLayout;
  botDisplayNameSuffix?: boolean;
  syncDeletes?: boolean;
  /** Checked every sweep and first in line for the scraper budget. */
  priority?: boolean;
  createdByUser?: {
    id: string;
    username?: string;
    email?: string;
    role: 'admin' | 'user';
  };
}

export type SensitiveFallbackLabel = 'sexual' | 'nudity' | 'graphic-media' | 'none';
export type EditMode = 'skip' | 'replace';
export type ImageLayout = 'gallery' | 'classic';

/** Per-mapping mirroring behaviour, as edited in the account forms. */
export interface MirrorSettings {
  sensitiveFallbackLabel: SensitiveFallbackLabel;
  editMode: EditMode;
  mirrorRetweets: boolean;
  mirrorRepliesToMirrors: boolean;
  imageLayout: ImageLayout;
  botDisplayNameSuffix: boolean;
  syncDeletes: boolean;
  /** Optional so forms built before the flag existed still type-check; absent means unchanged on save. */
  priority?: boolean;
}

export interface AccountGroup {
  name: string;
  emoji?: string;
  listUri?: string;
  starterPackUri?: string;
  lastDiscoverySyncAt?: string;
}

export interface TwitterConfig {
  authToken: string;
  ct0: string;
  backupAuthToken?: string;
  backupCt0?: string;
}

export interface AIConfig {
  provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface ActivityLog {
  twitter_id: string;
  twitter_username: string;
  bsky_identifier: string;
  tweet_text?: string;
  bsky_uri?: string;
  /** reposted: a retweet mirrored as a Bluesky repost. deleted: the tweet and its mirror were deleted. */
  status: 'migrated' | 'skipped' | 'failed' | 'reposted' | 'deleted';
  created_at?: string;
}

export interface BskyFacetFeatureLink {
  $type: 'app.bsky.richtext.facet#link';
  uri: string;
}

export interface BskyFacetFeatureMention {
  $type: 'app.bsky.richtext.facet#mention';
  did: string;
}

export interface BskyFacetFeatureTag {
  $type: 'app.bsky.richtext.facet#tag';
  tag: string;
}

export type BskyFacetFeature = BskyFacetFeatureLink | BskyFacetFeatureMention | BskyFacetFeatureTag;

export interface BskyFacet {
  index?: {
    byteStart?: number;
    byteEnd?: number;
  };
  features?: BskyFacetFeature[];
}

export interface EnrichedPostMedia {
  type: 'image' | 'video' | 'external';
  url?: string;
  thumb?: string;
  alt?: string;
  width?: number;
  height?: number;
  title?: string;
  description?: string;
}

export interface EnrichedPost {
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

export interface LocalPostSearchResult {
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

export interface BskyProfileView {
  did?: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
  description?: string;
  createdAt?: string;
}

export interface FediverseBridgeStatusView {
  bridged: boolean;
  checkedAt: string;
  error?: string;
}

export interface PendingBackfill {
  id: string;
  limit?: number;
  queuedAt: number;
  sequence: number;
  requestId: string;
  position: number;
}

export interface StatusState {
  state: AppState;
  currentAccount?: string;
  processedCount?: number;
  totalCount?: number;
  message?: string;
  backfillMappingId?: string;
  backfillRequestId?: string;
  lastUpdate: number;
}

export type ActiveJobKind = 'checking' | 'mirroring' | 'backfilling' | 'profile-sync' | 'pin-sync';

export interface ActiveJobView {
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

export const JOB_KIND_LABEL: Record<string, string> = {
  checking: 'Checking',
  mirroring: 'Mirroring',
  backfilling: 'Backfilling',
  'profile-sync': 'Profile sync',
  'pin-sync': 'Pin sync',
};

export const JOB_KIND_DOT: Record<string, string> = {
  checking: 'bg-sky-500',
  mirroring: 'bg-emerald-500',
  backfilling: 'bg-amber-500',
  'profile-sync': 'bg-primary',
  'pin-sync': 'bg-primary',
};

export interface QueueMappingCounts {
  mapping_id: string;
  bsky_identifier: string;
  pending: number;
  processing: number;
  failed: number;
  ready?: number;
  backoff?: number;
  oldest_enqueued_at: number | null;
  next_retry_at?: number | null;
}

export interface QueueSummary {
  pending: number;
  processing: number;
  failed: number;
  /** Pending items that can post right now. */
  ready?: number;
  /** Pending items still serving retry backoff. */
  backoff?: number;
  nextRetryAt?: number | null;
  oldestEnqueuedAt: number | null;
  perMapping: QueueMappingCounts[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogErrorDetail {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
  stack?: string;
}

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  stage: string;
  event: string;
  message: string;
  mappingId?: string;
  bskyIdentifier?: string;
  twitterUsername?: string;
  twitterId?: string;
  jobId?: string;
  attempt?: number;
  durationMs?: number;
  error?: LogErrorDetail;
  detail?: Record<string, unknown>;
}

export interface LogsResponse {
  entries: LogEntry[];
  hasMore: boolean;
  retention?: { maxRows: number; maxAgeDays: number };
}

export interface QueueFailureGroup {
  stage: string;
  reason: string;
  count: number;
  sampleTwitterId: string;
  sampleTwitterUsername: string;
  sampleBskyIdentifier: string;
  lastSeenAt: number;
}

export interface QueueFailureItem {
  twitter_id: string;
  bsky_identifier: string;
  mapping_id: string;
  twitter_username: string;
  kind: string;
  tweet_text?: string;
  status: string;
  attempts: number;
  not_before: number;
  last_error?: string;
  failure_stage?: string;
  last_error_detail?: string;
  enqueued_at: number;
  updated_at: number;
  first_failed_at?: number;
  posted_uri?: string;
}

export interface QueueFailuresResponse {
  summary: QueueFailureGroup[];
  items: QueueFailureItem[];
}

// A Bluesky account the workers cannot post to at all: taken down, suspended or
// deactivated. Distinct from a failed tweet — nothing here is retryable until
// the account itself comes back.
export interface AccountAlert {
  mappingId: string;
  bskyIdentifier: string;
  twitterUsernames: string[];
  state: 'takendown' | 'suspended' | 'deactivated' | 'unknown';
  status?: string;
  reason: string;
  detectedAt: number;
  lastCheckedAt: number;
  nextRecheckAt: number;
  queuedTweets: number;
}

export interface StatusResponse {
  lastCheckTime: number;
  nextCheckTime: number;
  nextCheckMinutes: number;
  checkIntervalMinutes: number;
  pendingBackfills: PendingBackfill[];
  currentStatus: StatusState;
  activeJobs?: ActiveJobView[];
  queue?: QueueSummary;
  accountAlerts?: AccountAlert[];
}

export interface UserPermissions {
  viewAllMappings: boolean;
  manageOwnMappings: boolean;
  manageAllMappings: boolean;
  manageGroups: boolean;
  queueBackfills: boolean;
  runNow: boolean;
}

export interface AuthUser {
  id: string;
  username?: string;
  email?: string;
  isAdmin: boolean;
  permissions: UserPermissions;
}

export interface ManagedUser {
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

export interface TwitterMirrorProfile {
  username: string;
  profileUrl: string;
  name?: string;
  biography?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  mirroredDisplayName: string;
  mirroredDescription: string;
}

export interface BlueskyCredentialValidation {
  did: string;
  handle: string;
  email?: string;
  emailConfirmed: boolean;
  serviceUrl: string;
  settingsUrl: string;
}

export interface MirrorProfileSyncResult {
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

export interface BulkBotLabelAllResult {
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

export interface BulkAppendBotNameAllResult {
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

export interface BootstrapStatus {
  bootstrapOpen: boolean;
}

export interface RuntimeVersionInfo {
  version: string;
  commit?: string;
  branch?: string;
  startedAt: number;
}

export interface UpdateStatusInfo {
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

export interface Notice {
  tone: 'success' | 'error' | 'info';
  message: string;
}

export interface MappingFormState extends MirrorSettings {
  owner: string;
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl: string;
  groupName: string;
  groupEmoji: string;
  profileSyncSourceUsername: string;
  /** New mappings only: mirror just new tweets, or the latest ones straight away. */
  startFrom: 'now' | 'recent';
}

export interface UserFormState {
  username: string;
  email: string;
  password: string;
  isAdmin: boolean;
  permissions: UserPermissions;
}

export interface AccountSecurityEmailState {
  currentEmail: string;
  newEmail: string;
  password: string;
}

export interface AccountSecurityPasswordState {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

// Response shapes for the account health, account detail, discovery and preview endpoints.
export interface AccountHealthSource {
  twitterUsername: string;
  tier: string;
  lastCheckedAt: number | null;
  lastFoundAt: number | null;
  dueInMs: number;
  lastError?: string | null;
  protectedSince?: number | null;
}

export interface AccountHealthRow {
  mappingId: string;
  bskyIdentifier: string;
  twitterUsernames: string[];
  enabled: boolean;
  groupName?: string;
  groupEmoji?: string;
  down: { state: string; reason: string; detectedAt: number } | null;
  lag: { samples: number; averageMs: number; medianMs: number; p95Ms: number; worstMs: number } | null;
  posts: { posted: number; skipped: number; failed: number; lastPostedAt: number | null };
  queue: { pending: number; processing: number; failed: number };
  sources: AccountHealthSource[];
}

export interface AccountHealthResponse {
  windowDays: number;
  accounts: AccountHealthRow[];
  summary: {
    accounts: number;
    down: number;
    averageLagMs: number | null;
    lagSamples: number;
    postedInWindow: number;
  };
}

export interface QueueItemView {
  twitter_id: string;
  twitter_username: string;
  status: string;
  attempts: number;
  tweet_text?: string;
  last_error?: string;
  failure_stage?: string;
  enqueued_at: number;
  not_before: number;
  updated_at: number;
}

export interface AccountDetailResponse {
  mapping: {
    id: string;
    bskyIdentifier: string;
    bskyServiceUrl?: string;
    twitterUsernames: string[];
    enabled: boolean;
    owner?: string;
    groupName?: string;
    groupEmoji?: string;
    hasBotLabel?: boolean;
    profileSyncSourceUsername?: string;
    lastProfileSyncAt?: string;
    lastPinnedTweetId?: string;
    lastPinSyncAt?: string;
  };
  permissions: { canManage: boolean; canQueueBackfills: boolean; canRunNow: boolean; isAdmin: boolean };
  down: { state: string; reason: string; detectedAt: number; nextRecheckAt: number; checks: number } | null;
  lag: { samples: number; averageMs: number; medianMs: number; p95Ms: number; worstMs: number } | null;
  posts: { posted: number; skipped: number; failed: number; lastPostedAt: number | null };
  queue: {
    pending: number;
    ready: number;
    backoff: number;
    processing: number;
    failed: number;
    nextRetryAt: number | null;
    oldestEnqueuedAt: number | null;
    items: QueueItemView[];
  };
  sources: {
    twitterUsername: string;
    tier: string;
    dueInMs: number;
    lastCheckedAt: number | null;
    lastFoundAt: number | null;
    emptyStreak: number;
    lastError: string | null;
    lastErrorAt: number | null;
    errorStreak: number;
    protectedSince: number | null;
  }[];
  recentPosts: {
    twitter_id: string;
    tweet_text?: string;
    bsky_uri?: string;
    status: string;
    created_at?: string;
    posted_at?: number;
    tweet_created_at?: number;
  }[];
  // Log rows carry `ts` (epoch ms); reading `timestamp` showed every entry as "never".
  recentLogs: { id: number; level: string; stage: string; event: string; message: string; ts: number }[];
}

export interface DiscoveryState {
  curatorMappingId: string | null;
  groups: { name: string; listUri: string | null; starterPackUri: string | null; lastDiscoverySyncAt: string | null }[];
}

export interface PreviewChunk {
  text: string;
  length: number;
}

export interface PreviewTweet {
  twitterId: string;
  originalText: string;
  createdAt?: string;
  chunks: PreviewChunk[];
  images: number;
  video: boolean;
  quote: boolean;
  linkCard: boolean;
  isReply: boolean;
  repostOf?: string;
  langs?: string[];
  extraMediaPosts?: number;
  skipped?: { stage: string; reason: string };
}

export interface PreviewResult {
  twitterUsername: string;
  fetched: number;
  tweets: PreviewTweet[];
}
