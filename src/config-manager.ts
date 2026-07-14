import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { ACTIVE_CONFIG_FILE, LEGACY_CONFIG_FILE, USING_EXTERNAL_DATA_DIR } from './storage-paths.js';

const CONFIG_FILE = ACTIVE_CONFIG_FILE;
const CONFIG_BACKUP_FILE = `${ACTIVE_CONFIG_FILE}.bak`;
const CONFIG_TMP_FILE = `${ACTIVE_CONFIG_FILE}.tmp`;
let configPathInitialized = false;
// Set when config.json exists but cannot be parsed and no backup could recover it.
// While true, saveConfig refuses to write so a transient read failure can never
// cause the (possibly recoverable) on-disk config to be overwritten with defaults.
let configUnreadable = false;

function ensureConfigPathReady(): void {
  if (configPathInitialized) {
    return;
  }
  configPathInitialized = true;

  if (!USING_EXTERNAL_DATA_DIR || fs.existsSync(CONFIG_FILE) || !fs.existsSync(LEGACY_CONFIG_FILE)) {
    return;
  }

  try {
    fs.copyFileSync(LEGACY_CONFIG_FILE, CONFIG_FILE);
    console.log(`📦 Migrated config from ${LEGACY_CONFIG_FILE} to ${CONFIG_FILE}.`);
  } catch (error) {
    console.warn(
      `⚠️ Failed to migrate legacy config from ${LEGACY_CONFIG_FILE} to ${CONFIG_FILE}: ${(error as Error).message}`,
    );
  }
}

export interface TwitterConfig {
  authToken: string;
  ct0: string;
  backupAuthToken?: string;
  backupCt0?: string;
}

export interface UserPermissions {
  viewAllMappings: boolean;
  manageOwnMappings: boolean;
  manageAllMappings: boolean;
  manageGroups: boolean;
  queueBackfills: boolean;
  runNow: boolean;
}

export type UserRole = 'admin' | 'user';

export interface WebUser {
  id: string;
  username?: string;
  email?: string;
  passwordHash: string;
  role: UserRole;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
}

export interface AIConfig {
  provider: 'gemini' | 'openai' | 'anthropic' | 'custom';
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface AccountMapping {
  id: string;
  twitterUsernames: string[];
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
  enabled: boolean;
  owner?: string;
  groupName?: string;
  groupEmoji?: string;
  createdByUserId?: string;
  profileSyncSourceUsername?: string;
  lastProfileSyncAt?: string;
  lastMirroredDisplayName?: string;
  lastMirroredDescription?: string;
  lastMirroredAvatarUrl?: string;
  lastMirroredBannerUrl?: string;
  lastPinnedTweetId?: string;
  lastPinSyncAt?: string;
  hasBotLabel?: boolean;
  pdsManaged?: boolean;
}

export interface AccountGroup {
  name: string;
  emoji?: string;
}

export interface PdsSettings {
  enabled: boolean;
  hostname: string;
  port: number;
}

export interface AppConfig {
  twitter: TwitterConfig;
  mappings: AccountMapping[];
  groups: AccountGroup[];
  users: WebUser[];
  checkIntervalMinutes: number;
  geminiApiKey?: string;
  ai?: AIConfig;
  pds?: PdsSettings;
}

const DEFAULT_TWITTER_CONFIG: TwitterConfig = {
  authToken: '',
  ct0: '',
};

export const DEFAULT_USER_PERMISSIONS: UserPermissions = {
  viewAllMappings: false,
  manageOwnMappings: true,
  manageAllMappings: false,
  manageGroups: false,
  queueBackfills: true,
  runNow: true,
};

export const ADMIN_USER_PERMISSIONS: UserPermissions = {
  viewAllMappings: true,
  manageOwnMappings: true,
  manageAllMappings: true,
  manageGroups: true,
  queueBackfills: true,
  runNow: true,
};

const DEFAULT_CONFIG: AppConfig = {
  twitter: DEFAULT_TWITTER_CONFIG,
  mappings: [],
  groups: [],
  users: [],
  checkIntervalMinutes: 5,
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeEmail = (value: unknown): string | undefined => {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : undefined;
};

const normalizeUsername = (value: unknown): string | undefined => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.replace(/^@/, '').toLowerCase();
};

const normalizeRole = (value: unknown): UserRole | undefined => {
  if (value === 'admin' || value === 'user') {
    return value;
  }
  return undefined;
};

const normalizeBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
};

const normalizeIsoDateString = (value: unknown): string | undefined => {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }

  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
};

const normalizeUserPermissions = (value: unknown, role: UserRole): UserPermissions => {
  if (role === 'admin') {
    return { ...ADMIN_USER_PERMISSIONS };
  }

  const defaults = { ...DEFAULT_USER_PERMISSIONS };
  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const record = value as Record<string, unknown>;
  return {
    viewAllMappings: normalizeBoolean(record.viewAllMappings, defaults.viewAllMappings),
    manageOwnMappings: normalizeBoolean(record.manageOwnMappings, defaults.manageOwnMappings),
    manageAllMappings: normalizeBoolean(record.manageAllMappings, defaults.manageAllMappings),
    manageGroups: normalizeBoolean(record.manageGroups, defaults.manageGroups),
    queueBackfills: normalizeBoolean(record.queueBackfills, defaults.queueBackfills),
    runNow: normalizeBoolean(record.runNow, defaults.runNow),
  };
};

export function getDefaultUserPermissions(role: UserRole): UserPermissions {
  return role === 'admin' ? { ...ADMIN_USER_PERMISSIONS } : { ...DEFAULT_USER_PERMISSIONS };
}

const normalizeUser = (rawUser: unknown, index: number, fallbackNowIso: string): WebUser | null => {
  if (!rawUser || typeof rawUser !== 'object') {
    return null;
  }

  const record = rawUser as Record<string, unknown>;
  const passwordHash = normalizeString(record.passwordHash);
  if (!passwordHash) {
    return null;
  }

  const role = normalizeRole(record.role) ?? (index === 0 ? 'admin' : 'user');
  const createdAt = normalizeString(record.createdAt) ?? fallbackNowIso;
  const updatedAt = normalizeString(record.updatedAt) ?? createdAt;

  return {
    id: normalizeString(record.id) ?? randomUUID(),
    username: normalizeUsername(record.username),
    email: normalizeEmail(record.email),
    passwordHash,
    role,
    permissions: normalizeUserPermissions(record.permissions, role),
    createdAt,
    updatedAt,
  };
};

const normalizeTwitterUsernames = (value: unknown, legacyValue: unknown): string[] => {
  const seen = new Set<string>();
  const usernames: string[] = [];

  const addUsername = (candidate: unknown) => {
    const normalized = normalizeUsername(candidate);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    usernames.push(normalized);
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      addUsername(item);
    }
  } else if (typeof value === 'string') {
    for (const item of value.split(',')) {
      addUsername(item);
    }
  }

  if (usernames.length === 0) {
    addUsername(legacyValue);
  }

  return usernames;
};

const normalizeGroup = (group: unknown): AccountGroup | null => {
  if (!group || typeof group !== 'object') {
    return null;
  }
  const record = group as Record<string, unknown>;
  const name = normalizeString(record.name);
  if (!name) {
    return null;
  }
  const emoji = normalizeString(record.emoji);
  return {
    name,
    ...(emoji ? { emoji } : {}),
  };
};

const findAdminUserId = (users: WebUser[]): string | undefined => users.find((user) => user.role === 'admin')?.id;

const matchOwnerToUserId = (owner: string | undefined, users: WebUser[]): string | undefined => {
  if (!owner) {
    return undefined;
  }

  const normalizedOwner = owner.trim().toLowerCase();
  if (!normalizedOwner) {
    return undefined;
  }

  return users.find((user) => {
    const username = user.username?.toLowerCase();
    const email = user.email?.toLowerCase();
    const emailLocalPart = email?.split('@')[0];
    return normalizedOwner === username || normalizedOwner === email || normalizedOwner === emailLocalPart;
  })?.id;
};

const normalizeMapping = (rawMapping: unknown, users: WebUser[], adminUserId?: string): AccountMapping | null => {
  if (!rawMapping || typeof rawMapping !== 'object') {
    return null;
  }

  const record = rawMapping as Record<string, unknown>;
  const bskyIdentifier = normalizeString(record.bskyIdentifier);
  if (!bskyIdentifier) {
    return null;
  }

  const owner = normalizeString(record.owner);
  const usernames = normalizeTwitterUsernames(record.twitterUsernames, record.twitterUsername);
  const profileSyncSourceUsername = normalizeUsername(record.profileSyncSourceUsername);
  const resolvedProfileSyncSource =
    profileSyncSourceUsername && usernames.includes(profileSyncSourceUsername)
      ? profileSyncSourceUsername
      : usernames[0];
  const explicitCreator = normalizeString(record.createdByUserId) ?? normalizeString(record.ownerUserId);
  const explicitCreatorExists = explicitCreator && users.some((user) => user.id === explicitCreator);

  return {
    id: normalizeString(record.id) ?? randomUUID(),
    twitterUsernames: usernames,
    bskyIdentifier: bskyIdentifier.toLowerCase(),
    bskyPassword: normalizeString(record.bskyPassword) ?? '',
    bskyServiceUrl: normalizeString(record.bskyServiceUrl) ?? 'https://bsky.social',
    enabled: normalizeBoolean(record.enabled, true),
    owner,
    groupName: normalizeString(record.groupName),
    groupEmoji: normalizeString(record.groupEmoji),
    profileSyncSourceUsername: resolvedProfileSyncSource,
    lastProfileSyncAt: normalizeIsoDateString(record.lastProfileSyncAt),
    lastMirroredDisplayName: normalizeString(record.lastMirroredDisplayName),
    lastMirroredDescription: normalizeString(record.lastMirroredDescription),
    lastMirroredAvatarUrl: normalizeString(record.lastMirroredAvatarUrl),
    lastMirroredBannerUrl: normalizeString(record.lastMirroredBannerUrl),
    lastPinnedTweetId: normalizeString(record.lastPinnedTweetId),
    lastPinSyncAt: normalizeIsoDateString(record.lastPinSyncAt),
    hasBotLabel: normalizeBoolean(record.hasBotLabel, false),
    pdsManaged: normalizeBoolean(record.pdsManaged, false),
    createdByUserId:
      (explicitCreatorExists ? explicitCreator : undefined) ?? matchOwnerToUserId(owner, users) ?? adminUserId,
  };
};

const normalizeUsers = (rawUsers: unknown): WebUser[] => {
  if (!Array.isArray(rawUsers)) {
    return [];
  }

  const fallbackNowIso = new Date().toISOString();
  const normalized = rawUsers
    .map((user, index) => normalizeUser(user, index, fallbackNowIso))
    .filter((user): user is WebUser => user !== null);

  const usedIds = new Set<string>();
  for (const user of normalized) {
    if (usedIds.has(user.id)) {
      user.id = randomUUID();
    }
    usedIds.add(user.id);
  }

  const firstUser = normalized[0];
  if (firstUser && !normalized.some((user) => user.role === 'admin')) {
    firstUser.role = 'admin';
    firstUser.permissions = { ...ADMIN_USER_PERMISSIONS };
    firstUser.updatedAt = new Date().toISOString();
  }

  for (const user of normalized) {
    if (user.role === 'admin') {
      user.permissions = { ...ADMIN_USER_PERMISSIONS };
    }
  }

  return normalized;
};

const normalizePdsSettings = (rawPds: unknown): PdsSettings | undefined => {
  if (!rawPds || typeof rawPds !== 'object') {
    return undefined;
  }
  const record = rawPds as Record<string, unknown>;
  const hostname = normalizeString(record.hostname)?.toLowerCase();
  if (!hostname) {
    return undefined;
  }
  const portCandidate = Number(record.port);
  const port = Number.isInteger(portCandidate) && portCandidate > 0 && portCandidate < 65536 ? portCandidate : 3010;
  return {
    enabled: normalizeBoolean(record.enabled, false),
    hostname,
    port,
  };
};

const normalizeAiConfig = (rawAi: unknown): AIConfig | undefined => {
  if (!rawAi || typeof rawAi !== 'object') {
    return undefined;
  }
  const record = rawAi as Record<string, unknown>;
  const provider = record.provider;
  if (provider !== 'gemini' && provider !== 'openai' && provider !== 'anthropic' && provider !== 'custom') {
    return undefined;
  }

  const apiKey = normalizeString(record.apiKey);
  const model = normalizeString(record.model);
  const baseUrl = normalizeString(record.baseUrl);
  return {
    provider,
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
};

const normalizeConfigShape = (rawConfig: unknown): AppConfig => {
  if (!rawConfig || typeof rawConfig !== 'object') {
    return { ...DEFAULT_CONFIG };
  }

  const record = rawConfig as Record<string, unknown>;
  const rawTwitter =
    record.twitter && typeof record.twitter === 'object' ? (record.twitter as Record<string, unknown>) : {};
  const users = normalizeUsers(record.users);
  const adminUserId = findAdminUserId(users);

  const mappings = Array.isArray(record.mappings)
    ? record.mappings
        .map((mapping) => normalizeMapping(mapping, users, adminUserId))
        .filter((mapping): mapping is AccountMapping => mapping !== null)
    : [];

  const groups = Array.isArray(record.groups)
    ? record.groups.map(normalizeGroup).filter((group): group is AccountGroup => group !== null)
    : [];

  const seenGroups = new Set<string>();
  const dedupedGroups = groups.filter((group) => {
    const key = group.name.toLowerCase();
    if (seenGroups.has(key)) {
      return false;
    }
    seenGroups.add(key);
    return true;
  });

  const checkIntervalCandidate = Number(record.checkIntervalMinutes);
  const checkIntervalMinutes =
    Number.isFinite(checkIntervalCandidate) && checkIntervalCandidate >= 1 ? Math.round(checkIntervalCandidate) : 5;

  const geminiApiKey = normalizeString(record.geminiApiKey);
  const ai = normalizeAiConfig(record.ai);
  const pds = normalizePdsSettings(record.pds);

  return {
    twitter: {
      authToken: normalizeString(rawTwitter.authToken) ?? '',
      ct0: normalizeString(rawTwitter.ct0) ?? '',
      backupAuthToken: normalizeString(rawTwitter.backupAuthToken),
      backupCt0: normalizeString(rawTwitter.backupCt0),
    },
    mappings,
    groups: dedupedGroups,
    users,
    checkIntervalMinutes,
    ...(geminiApiKey ? { geminiApiKey } : {}),
    ...(ai ? { ai } : {}),
    ...(pds ? { pds } : {}),
  };
};

const writeConfigFile = (config: AppConfig) => {
  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  // Atomic write: write to a temp file and rename over the target so a crash
  // mid-write can never leave a truncated/corrupted config.json behind.
  fs.writeFileSync(CONFIG_TMP_FILE, serialized);
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fs.copyFileSync(CONFIG_FILE, CONFIG_BACKUP_FILE);
    }
  } catch (error) {
    console.warn(`⚠️ Failed to refresh config backup: ${(error as Error).message}`);
  }
  fs.renameSync(CONFIG_TMP_FILE, CONFIG_FILE);
};

const parseConfigText = (rawText: string): AppConfig => normalizeConfigShape(JSON.parse(rawText));

export function getConfig(): AppConfig {
  ensureConfigPathReady();

  if (!fs.existsSync(CONFIG_FILE)) {
    configUnreadable = false;
    return { ...DEFAULT_CONFIG };
  }

  try {
    const rawText = fs.readFileSync(CONFIG_FILE, 'utf8');
    const rawConfig = JSON.parse(rawText);
    const normalizedConfig = normalizeConfigShape(rawConfig);
    configUnreadable = false;

    if (JSON.stringify(rawConfig) !== JSON.stringify(normalizedConfig)) {
      writeConfigFile(normalizedConfig);
    }

    return normalizedConfig;
  } catch (err) {
    console.error('Error reading config:', err);
  }

  // Main config is unreadable — attempt automatic recovery from the backup
  // written alongside every successful save.
  try {
    if (fs.existsSync(CONFIG_BACKUP_FILE)) {
      const recovered = parseConfigText(fs.readFileSync(CONFIG_BACKUP_FILE, 'utf8'));
      writeConfigFile(recovered);
      configUnreadable = false;
      console.warn(`♻️ Recovered config from backup: ${CONFIG_BACKUP_FILE}`);
      return recovered;
    }
  } catch (backupErr) {
    console.error('Error reading config backup:', backupErr);
  }

  configUnreadable = true;
  console.error(
    `🛑 config.json is unreadable and no backup could be restored. Refusing to overwrite it; fix or remove ${CONFIG_FILE} to continue.`,
  );
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: AppConfig): void {
  ensureConfigPathReady();

  if (configUnreadable && fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      `Refusing to save config: existing ${CONFIG_FILE} is unreadable and saving would overwrite it with defaults. Fix or remove the file first.`,
    );
  }

  const normalizedConfig = normalizeConfigShape(config);
  writeConfigFile(normalizedConfig);
  configUnreadable = false;
}

export function addMapping(mapping: Omit<AccountMapping, 'id' | 'enabled'>): void {
  const config = getConfig();
  const newMapping: AccountMapping = {
    ...mapping,
    id: randomUUID(),
    enabled: true,
  };
  config.mappings.push(newMapping);
  saveConfig(config);
}

export function updateMapping(id: string, updates: Partial<Omit<AccountMapping, 'id'>>): void {
  const config = getConfig();
  const index = config.mappings.findIndex((m) => m.id === id);
  const existing = config.mappings[index];

  if (index !== -1 && existing) {
    config.mappings[index] = { ...existing, ...updates };
    saveConfig(config);
  }
}

export function removeMapping(id: string): void {
  const config = getConfig();
  config.mappings = config.mappings.filter((m) => m.id !== id);
  saveConfig(config);
}

export function updateTwitterConfig(twitter: TwitterConfig): void {
  const config = getConfig();
  config.twitter = twitter;
  saveConfig(config);
}
