import { BskyAgent, RichText } from '@atproto/api';
import type { BlobRef } from '@atproto/api';
import { Scraper, type Profile as TwitterProfile } from '@the-convocation/twitter-scraper';
import axios from 'axios';
import sharp from 'sharp';
import { getConfig } from './config-manager.js';
import { createScraperFetch } from './scraper-fetch.js';

const PROFILE_IMAGE_MAX_BYTES = 1_000_000;
const PROFILE_IMAGE_TARGET_BYTES = 950 * 1024;
const DEFAULT_BSKY_SERVICE_URL = 'https://bsky.social';
const BSKY_SETTINGS_URL = 'https://bsky.app/settings/account';
const BSKY_PUBLIC_APPVIEW_URL = (process.env.BSKY_PUBLIC_APPVIEW_URL || 'https://public.api.bsky.app').replace(
  /\/$/,
  '',
);
const MIRROR_SUFFIX = '{bot}';
const LEGACY_MIRROR_SUFFIX = '{unofficial}';
const FEDIVERSE_BRIDGE_HANDLE = 'ap.brid.gy';
const MIN_BRIDGE_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BOT_SELF_LABEL_VALUE = 'bot';
const TCO_LINK_REGEX = /https:\/\/t\.co\/[a-zA-Z0-9]+/gi;
const TRACKING_QUERY_PARAM_PREFIXES = ['utm_'];
const TRACKING_QUERY_PARAM_NAMES = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  'igshid',
  'ref',
  'ref_src',
  'ref_url',
  'source',
  's',
  'si',
]);
const URL_EXPANSION_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

type ProfileImageKind = 'avatar' | 'banner';

interface TwitterCookieSet {
  label: string;
  authToken: string;
  ct0: string;
}

interface ProcessedProfileImage {
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface TwitterMirrorProfile {
  username: string;
  profileUrl: string;
  name?: string;
  biography?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  /** The profile's own website link (expanded, tracking parameters removed). */
  website?: string;
  /** What goes in Bluesky's native website field: their site, else the X profile. */
  mirroredWebsite: string;
  userId?: string;
  isPrivate?: boolean;
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
  twitterProfile: TwitterMirrorProfile;
  bsky: BlueskyCredentialValidation;
  avatarSynced: boolean;
  bannerSynced: boolean;
  skipped: boolean;
  changed: {
    displayName: boolean;
    description: boolean;
    avatar: boolean;
    banner: boolean;
    website: boolean;
  };
  warnings: string[];
}

export interface ProfileMirrorSyncState {
  sourceUsername?: string;
  mirroredDisplayName?: string;
  mirroredDescription?: string;
  avatarUrl?: string;
  bannerUrl?: string;
  website?: string;
}

export interface MappingProfileSyncState {
  profileSyncSourceUsername?: string;
  lastProfileSyncAt?: string;
  lastMirroredDisplayName?: string;
  lastMirroredDescription?: string;
  lastMirroredAvatarUrl?: string;
  lastMirroredBannerUrl?: string;
  lastMirroredWebsite?: string;
}

export interface FediverseBridgeResult {
  bsky: BlueskyCredentialValidation;
  bridgedAccountHandle: string;
  fediverseAddress: string;
  accountCreatedAt: string;
  ageDays: number;
  followedBridgeAccount: boolean;
  announcementUri: string;
  announcementCid: string;
}

export interface FediverseBridgeStatusResult {
  bsky: BlueskyCredentialValidation;
  bridgeAccountHandle: string;
  bridged: boolean;
}

export interface EnsureBotSelfLabelResult {
  bsky: BlueskyCredentialValidation;
  updated: boolean;
  hasBotLabel: true;
}

export interface EnsureDisplayNameBotSuffixResult {
  bsky: BlueskyCredentialValidation;
  updated: boolean;
  displayName: string;
}

const normalizeTwitterUsername = (value: string) => value.trim().replace(/^@/, '').toLowerCase();

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeMirrorStateUrl = (value?: string): string | undefined => normalizeOptionalString(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const normalizeSelfLabelValues = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const normalizedVal = normalizeOptionalString(item.val);
    if (!normalizedVal) {
      continue;
    }
    entries.push({
      ...item,
      val: normalizedVal,
    });
  }

  return entries;
};

const toNormalizedMirrorState = (state?: ProfileMirrorSyncState) => ({
  sourceUsername: normalizeTwitterUsername(state?.sourceUsername || ''),
  mirroredDisplayName: normalizeOptionalString(state?.mirroredDisplayName),
  mirroredDescription: normalizeOptionalString(state?.mirroredDescription),
  avatarUrl: normalizeMirrorStateUrl(state?.avatarUrl),
  bannerUrl: normalizeMirrorStateUrl(state?.bannerUrl),
  website: normalizeMirrorStateUrl(state?.website),
});

const buildMirrorStateFromTwitterProfile = (twitterProfile: TwitterMirrorProfile): ProfileMirrorSyncState => ({
  sourceUsername: normalizeTwitterUsername(twitterProfile.username),
  mirroredDisplayName: twitterProfile.mirroredDisplayName,
  mirroredDescription: twitterProfile.mirroredDescription,
  avatarUrl: normalizeMirrorStateUrl(twitterProfile.avatarUrl),
  bannerUrl: normalizeMirrorStateUrl(twitterProfile.bannerUrl),
  website: normalizeMirrorStateUrl(twitterProfile.mirroredWebsite),
});

export const hasMirrorStateChanges = (previous: ProfileMirrorSyncState | undefined, next: ProfileMirrorSyncState) => {
  const normalizedPrevious = toNormalizedMirrorState(previous);
  const normalizedNext = toNormalizedMirrorState(next);

  return {
    displayName: normalizedPrevious.mirroredDisplayName !== normalizedNext.mirroredDisplayName,
    description: normalizedPrevious.mirroredDescription !== normalizedNext.mirroredDescription,
    avatar: normalizedPrevious.avatarUrl !== normalizedNext.avatarUrl,
    banner: normalizedPrevious.bannerUrl !== normalizedNext.bannerUrl,
    website: normalizedPrevious.website !== normalizedNext.website,
  };
};

/**
 * The URL for Bluesky's native website field: the account's own site when its
 * X profile has one, otherwise the X profile itself — which is where the
 * mirror's posts come from, and far easier to find than a URL buried in a bio.
 */
export const buildMirroredWebsite = (website: string | undefined, username: string): string => {
  const candidate = normalizeOptionalString(website);
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
    } catch {
      // fall through to the X profile
    }
  }
  return `https://x.com/${normalizeTwitterUsername(username)}`;
};

/**
 * Whether automatic sync may overwrite the Bluesky bio. Only when it still
 * holds what the mirror last wrote (or nothing): a bio someone has edited by
 * hand on Bluesky is theirs, and a daily sync must not quietly revert it.
 */
export const canOverwriteDescription = (
  currentDescription: string | undefined,
  lastMirroredDescription: string | undefined,
): boolean => {
  const current = normalizeOptionalString(currentDescription);
  if (!current) return true;
  const previous = normalizeOptionalString(lastMirroredDescription);
  return previous !== undefined && normalizeWhitespace(current) === normalizeWhitespace(previous);
};

const normalizeBskyServiceUrl = (value?: string): string => {
  const raw = normalizeOptionalString(value) || DEFAULT_BSKY_SERVICE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  return url.toString().replace(/\/$/, '');
};

const getGraphemeSegments = (value: string): string[] => {
  const SegmenterCtor = (globalThis.Intl as any).Segmenter as
    | (new (
        locale: string,
        options: { granularity: 'grapheme' },
      ) => {
        segment: (input: string) => Iterable<{ segment: string }>;
      })
    | undefined;
  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor('en', { granularity: 'grapheme' });
    return [...segmenter.segment(value)].map((segment) => segment.segment);
  }
  return Array.from(value);
};

const truncateGraphemes = (value: string, limit: number): string => {
  if (limit <= 0) return '';
  const segments = getGraphemeSegments(value);
  if (segments.length <= limit) {
    return value;
  }
  return segments.slice(0, limit).join('');
};

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const stripMirrorDisplaySuffixes = (value: string): string => {
  if (!value) {
    return value;
  }

  const suffixPattern = /\s*\{(?:bot|unofficial)\}\s*/gi;
  return normalizeWhitespace(value.replace(suffixPattern, ' '));
};

const shouldStripTrackingParam = (rawName: string): boolean => {
  const name = rawName.trim().toLowerCase();
  if (!name) {
    return false;
  }

  if (TRACKING_QUERY_PARAM_NAMES.has(name)) {
    return true;
  }

  return TRACKING_QUERY_PARAM_PREFIXES.some((prefix) => name.startsWith(prefix));
};

const stripTrackingParamsFromUrl = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    const names = [...parsed.searchParams.keys()];
    for (const name of names) {
      if (shouldStripTrackingParam(name)) {
        parsed.searchParams.delete(name);
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
};

const resolveRedirectUrl = (response: unknown): string | undefined => {
  if (!isRecord(response)) {
    return undefined;
  }
  const request = isRecord(response.request) ? response.request : undefined;
  const res = request && isRecord(request.res) ? request.res : undefined;
  return normalizeOptionalString(res?.responseUrl);
};

const decodeEscapedUrlValue = (value: string): string => {
  return value
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .trim();
};

const extractRedirectUrlFromHtml = (html: string): string | undefined => {
  const metaRefresh =
    html.match(/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>\s]+)/i)?.[1] ||
    html.match(/<meta[^>]+content=["'][^"']*url=([^"'>\s]+)/i)?.[1];
  if (metaRefresh) {
    return decodeEscapedUrlValue(metaRefresh);
  }

  const locationReplace =
    html.match(/location\.replace\(\s*(["'])(.+?)\1\s*\)/i)?.[2] ||
    html.match(/window\.location(?:\.href)?\s*=\s*(["'])(.+?)\1/i)?.[2];
  if (locationReplace) {
    return decodeEscapedUrlValue(locationReplace);
  }

  const titleUrl = html.match(/<title>\s*(https?:\/\/[^<\s]+)\s*<\/title>/i)?.[1];
  if (titleUrl) {
    return decodeEscapedUrlValue(titleUrl);
  }

  return undefined;
};

const expandShortUrl = async (shortUrl: string): Promise<string> => {
  try {
    const head = await axios.head(shortUrl, {
      maxRedirects: 8,
      timeout: 8_000,
      headers: URL_EXPANSION_HEADERS,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const resolvedByHead = resolveRedirectUrl(head);
    if (resolvedByHead && resolvedByHead !== shortUrl) {
      return resolvedByHead;
    }
  } catch {
    // Fall through to GET-based resolver.
  }

  try {
    const get = await axios.get<string>(shortUrl, {
      maxRedirects: 8,
      timeout: 8_000,
      headers: URL_EXPANSION_HEADERS,
      maxContentLength: 512 * 1024,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const resolvedByGet = resolveRedirectUrl(get);
    if (resolvedByGet && resolvedByGet !== shortUrl) {
      return resolvedByGet;
    }

    const html = typeof get.data === 'string' ? get.data : '';
    const resolvedFromHtml = extractRedirectUrlFromHtml(html);
    if (resolvedFromHtml) {
      return resolvedFromHtml;
    }
  } catch {
    return shortUrl;
  }

  return shortUrl;
};

const expandAndNormalizeTwitterBioLinks = async (biography?: string): Promise<string | undefined> => {
  const bio = normalizeOptionalString(biography);
  if (!bio) {
    return undefined;
  }

  let expandedBio = bio;
  const matches = expandedBio.match(TCO_LINK_REGEX) || [];
  const uniqueMatches = [...new Set(matches)];
  for (const tcoUrl of uniqueMatches) {
    const resolvedUrl = await expandShortUrl(tcoUrl);
    const normalizedUrl = stripTrackingParamsFromUrl(resolvedUrl);
    if (!normalizedUrl || normalizedUrl === tcoUrl) {
      continue;
    }
    expandedBio = expandedBio.split(tcoUrl).join(normalizedUrl);
  }

  return normalizeOptionalString(expandedBio);
};

const normalizeTwitterAvatarUrl = (url?: string): string | undefined => {
  if (!url) return undefined;
  return url.replace('_normal.', '_400x400.');
};

const normalizeTwitterBannerUrl = (url?: string): string | undefined => {
  if (!url) return undefined;
  if (/\/\d+x\d+(?:$|\?)/.test(url)) {
    return url;
  }
  return `${url}/1500x500`;
};

const inferImageMimeTypeFromUrl = (url: string): 'image/jpeg' | 'image/png' => {
  const lower = url.toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  return 'image/jpeg';
};

const detectImageMimeType = (contentType: unknown, url: string): 'image/jpeg' | 'image/png' => {
  if (typeof contentType === 'string') {
    const normalized = contentType.split(';')[0]?.trim().toLowerCase();
    if (normalized === 'image/png') return 'image/png';
    if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image/jpeg';
  }
  return inferImageMimeTypeFromUrl(url);
};

const getProfileImagePreset = (kind: ProfileImageKind) => {
  if (kind === 'avatar') {
    return {
      width: 640,
      height: 640,
    };
  }
  return {
    width: 1500,
    height: 500,
  };
};

const compressProfileImage = async (
  sourceBuffer: Buffer,
  sourceMimeType: 'image/jpeg' | 'image/png',
  kind: ProfileImageKind,
): Promise<ProcessedProfileImage> => {
  const preset = getProfileImagePreset(kind);
  const metadata = await sharp(sourceBuffer, { failOn: 'none' }).metadata();
  const hasAlpha = Boolean(metadata.hasAlpha);
  const scales = [1, 0.92, 0.85, 0.78, 0.7, 0.62, 0.54, 0.46];
  const jpegQualities = [92, 88, 84, 80, 76, 72, 68, 64];
  const basePng = sourceMimeType === 'image/png' && hasAlpha;

  let best: ProcessedProfileImage | null = null;

  for (let i = 0; i < scales.length; i += 1) {
    const scale = scales[i] || 1;
    const jpegQuality = jpegQualities[i] || 70;
    const width = Math.max(kind === 'avatar' ? 256 : 800, Math.round(preset.width * scale));
    const height = Math.max(kind === 'avatar' ? 256 : 260, Math.round(preset.height * scale));

    const resized = sharp(sourceBuffer, { failOn: 'none' }).rotate().resize(width, height, {
      fit: 'cover',
      position: 'centre',
      withoutEnlargement: false,
    });

    const pngBuffer = basePng
      ? await resized
          .clone()
          .png({
            compressionLevel: 9,
            adaptiveFiltering: true,
            palette: true,
            quality: 90,
          })
          .toBuffer()
      : null;

    if (pngBuffer) {
      if (pngBuffer.length <= PROFILE_IMAGE_TARGET_BYTES) {
        return {
          buffer: pngBuffer,
          mimeType: 'image/png',
        };
      }
      if (pngBuffer.length <= PROFILE_IMAGE_MAX_BYTES) {
        if (!best || pngBuffer.length < best.buffer.length) {
          best = {
            buffer: pngBuffer,
            mimeType: 'image/png',
          };
        }
      }
    }

    const jpegBuffer = await resized
      .clone()
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: jpegQuality, mozjpeg: true })
      .toBuffer();

    if (jpegBuffer.length <= PROFILE_IMAGE_TARGET_BYTES) {
      return {
        buffer: jpegBuffer,
        mimeType: 'image/jpeg',
      };
    }

    if (jpegBuffer.length <= PROFILE_IMAGE_MAX_BYTES) {
      if (!best || jpegBuffer.length < best.buffer.length) {
        best = {
          buffer: jpegBuffer,
          mimeType: 'image/jpeg',
        };
      }
    }
  }

  if (best) {
    return best;
  }

  throw new Error('Could not compress image under Bluesky profile limit (1MB).');
};

const buildTwitterCookieSets = (): TwitterCookieSet[] => {
  const config = getConfig();
  const sets: TwitterCookieSet[] = [];

  if (config.twitter.authToken && config.twitter.ct0) {
    sets.push({
      label: 'primary',
      authToken: config.twitter.authToken,
      ct0: config.twitter.ct0,
    });
  }

  if (config.twitter.backupAuthToken && config.twitter.backupCt0) {
    sets.push({
      label: 'backup',
      authToken: config.twitter.backupAuthToken,
      ct0: config.twitter.backupCt0,
    });
  }

  return sets;
};

// Profile lookups count against the same Twitter account as timeline fetches,
// so they go through the same process-wide rate limiter.
const profileScraperFetch = createScraperFetch();

const fetchTwitterProfileWithCookies = async (
  username: string,
  cookieSet: TwitterCookieSet,
): Promise<TwitterProfile> => {
  const scraper = new Scraper({ fetch: profileScraperFetch });
  await scraper.setCookies([`auth_token=${cookieSet.authToken}`, `ct0=${cookieSet.ct0}`]);
  return scraper.getProfile(username);
};

export const buildMirroredDisplayName = (name: string | undefined, username: string, withSuffix = true): string => {
  const cleanedName = stripMirrorDisplaySuffixes(normalizeWhitespace(name || ''));
  const baseName = cleanedName || `@${normalizeTwitterUsername(username)}`;
  // The account already carries Bluesky's own `bot` self-label; the text
  // suffix is optional on top of it.
  if (!withSuffix) return truncateGraphemes(baseName, 64);
  const suffixed = `${baseName} ${MIRROR_SUFFIX}`;
  // Truncate the name, never the suffix: a long name used to push "{bot}" off the end.
  const suffixLength = getGraphemeSegments(` ${MIRROR_SUFFIX}`).length;
  return getGraphemeSegments(suffixed).length <= 64
    ? suffixed
    : `${truncateGraphemes(baseName, 64 - suffixLength).trimEnd()} ${MIRROR_SUFFIX}`;
};

export const buildMirroredDescription = (biography: string | undefined, username: string): string => {
  const normalizedUsername = normalizeTwitterUsername(username);
  const intro = `Unofficial mirror account of https://x.com/${normalizedUsername} from Twitter`;
  const bio = normalizeWhitespace(biography || '');
  if (!bio) {
    return truncateGraphemes(intro, 256);
  }

  const full = `${intro}\n\n${bio}`;
  if (getGraphemeSegments(full).length <= 256) {
    return full;
  }

  const reserved = getGraphemeSegments(`${intro}\n\n`).length;
  const maxBioLength = Math.max(0, 256 - reserved);
  const truncatedBio = truncateGraphemes(bio, maxBioLength);
  return `${intro}\n\n${truncatedBio}`;
};

export const fetchTwitterMirrorProfile = async (
  inputUsername: string,
  options: { botDisplayNameSuffix?: boolean } = {},
): Promise<TwitterMirrorProfile> => {
  const username = normalizeTwitterUsername(inputUsername);
  if (!username) {
    throw new Error('Twitter username is required.');
  }

  const cookieSets = buildTwitterCookieSets();
  if (cookieSets.length === 0) {
    throw new Error('Twitter cookies are not configured. Save auth_token and ct0 in settings first.');
  }

  let lastError: unknown;
  for (const cookieSet of cookieSets) {
    try {
      const profile = await fetchTwitterProfileWithCookies(username, cookieSet);
      const resolvedUsername = normalizeTwitterUsername(profile.username || username);
      const cleanedName = normalizeOptionalString(profile.name);
      const cleanedBio = await expandAndNormalizeTwitterBioLinks(profile.biography);
      const website = profile.website ? stripTrackingParamsFromUrl(profile.website) : undefined;

      return {
        username: resolvedUsername,
        profileUrl: `https://x.com/${resolvedUsername}`,
        name: cleanedName,
        biography: cleanedBio,
        avatarUrl: normalizeTwitterAvatarUrl(profile.avatar),
        bannerUrl: normalizeTwitterBannerUrl(profile.banner),
        website,
        mirroredWebsite: buildMirroredWebsite(website, resolvedUsername),
        userId: profile.userId,
        isPrivate: profile.isPrivate,
        mirroredDisplayName: buildMirroredDisplayName(
          cleanedName,
          resolvedUsername,
          options.botDisplayNameSuffix !== false,
        ),
        mirroredDescription: buildMirroredDescription(cleanedBio, resolvedUsername),
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error && lastError.message) {
    throw new Error(`Failed to fetch Twitter profile: ${lastError.message}`);
  }
  throw new Error('Failed to fetch Twitter profile.');
};

const loginBlueskyAgent = async (args: {
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
}): Promise<{ agent: BskyAgent; credentials: BlueskyCredentialValidation }> => {
  const identifier = normalizeOptionalString(args.bskyIdentifier);
  const password = normalizeOptionalString(args.bskyPassword);
  if (!identifier || !password) {
    throw new Error('Bluesky identifier and app password are required.');
  }

  const serviceUrl = normalizeBskyServiceUrl(args.bskyServiceUrl);
  const agent = new BskyAgent({ service: serviceUrl });
  await agent.login({ identifier, password });

  const sessionResponse = await agent.com.atproto.server.getSession();
  const session = sessionResponse.data;

  return {
    agent,
    credentials: {
      did: session.did,
      handle: session.handle,
      email: session.email,
      emailConfirmed: Boolean(session.emailConfirmed),
      serviceUrl,
      settingsUrl: BSKY_SETTINGS_URL,
    },
  };
};

export const validateBlueskyCredentials = async (args: {
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
}): Promise<BlueskyCredentialValidation> => {
  const { credentials } = await loginBlueskyAgent(args);
  return credentials;
};

export const ensureBlueskyBotSelfLabel = async (args: {
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
}): Promise<EnsureBotSelfLabelResult> => {
  const { agent, credentials } = await loginBlueskyAgent(args);
  const repo = agent.session?.did || credentials.did;
  if (!repo) {
    throw new Error('Missing Bluesky session DID.');
  }

  let existingProfileRecord: Record<string, unknown> = {
    $type: 'app.bsky.actor.profile',
  };

  try {
    const response = await agent.com.atproto.repo.getRecord({
      repo,
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
    });
    if (isRecord(response.data?.value)) {
      existingProfileRecord = { ...response.data.value };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const looksLikeMissingRecord = /not found|record.*not.*found|could not locate/i.test(message);
    if (!looksLikeMissingRecord) {
      throw error;
    }
  }

  const existingLabels = isRecord(existingProfileRecord.labels) ? existingProfileRecord.labels : undefined;
  const existingValues = normalizeSelfLabelValues(existingLabels?.values);
  const alreadyHasBotLabel = existingValues.some(
    (entry) => normalizeOptionalString(entry.val)?.toLowerCase() === BOT_SELF_LABEL_VALUE,
  );
  if (alreadyHasBotLabel) {
    return {
      bsky: credentials,
      updated: false,
      hasBotLabel: true,
    };
  }

  const nextValues = [...existingValues, { val: BOT_SELF_LABEL_VALUE }];
  const nextProfileRecord: Record<string, unknown> = {
    ...existingProfileRecord,
    $type: 'app.bsky.actor.profile',
    labels: {
      $type: 'com.atproto.label.defs#selfLabels',
      values: nextValues,
    },
  };

  await agent.com.atproto.repo.putRecord({
    repo,
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
    record: nextProfileRecord,
  });

  return {
    bsky: credentials,
    updated: true,
    hasBotLabel: true,
  };
};

export const ensureBlueskyDisplayNameBotSuffix = async (args: {
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
  twitterUsername?: string;
  botDisplayNameSuffix?: boolean;
}): Promise<EnsureDisplayNameBotSuffixResult> => {
  const { agent, credentials } = await loginBlueskyAgent(args);
  const repo = agent.session?.did || credentials.did;
  if (!repo) {
    throw new Error('Missing Bluesky session DID.');
  }

  let existingProfileRecord: Record<string, unknown> = {
    $type: 'app.bsky.actor.profile',
  };

  try {
    const response = await agent.com.atproto.repo.getRecord({
      repo,
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
    });
    if (isRecord(response.data?.value)) {
      existingProfileRecord = { ...response.data.value };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const looksLikeMissingRecord = /not found|record.*not.*found|could not locate/i.test(message);
    if (!looksLikeMissingRecord) {
      throw error;
    }
  }

  const currentDisplayName = normalizeOptionalString(existingProfileRecord.displayName);
  const normalizedTwitterUsername = normalizeTwitterUsername(args.twitterUsername || '');
  let sourceDisplayName = currentDisplayName;
  let sourceUsername = credentials.handle;

  if (normalizedTwitterUsername) {
    const twitterProfile = await fetchTwitterMirrorProfile(normalizedTwitterUsername);
    sourceDisplayName = normalizeOptionalString(twitterProfile.name);
    sourceUsername = twitterProfile.username;
  }

  const nextDisplayName = buildMirroredDisplayName(
    sourceDisplayName,
    sourceUsername,
    args.botDisplayNameSuffix !== false,
  );
  const currentNormalized = normalizeWhitespace(currentDisplayName || '');
  const legacySuffixPresent = currentNormalized.toLowerCase().includes(LEGACY_MIRROR_SUFFIX);
  const updated = currentNormalized !== nextDisplayName || legacySuffixPresent;

  if (updated) {
    const nextProfileRecord: Record<string, unknown> = {
      ...existingProfileRecord,
      $type: 'app.bsky.actor.profile',
      displayName: nextDisplayName,
    };

    await agent.com.atproto.repo.putRecord({
      repo,
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
      record: nextProfileRecord,
    });
  }

  return {
    bsky: credentials,
    updated,
    displayName: nextDisplayName,
  };
};

export const applyProfileMirrorSyncState = <T extends MappingProfileSyncState>(
  mapping: T,
  sourceTwitterUsername: string,
  result: MirrorProfileSyncResult,
): T => {
  const normalizedSource = normalizeTwitterUsername(sourceTwitterUsername);
  const next: T = {
    ...mapping,
    profileSyncSourceUsername: normalizedSource || mapping.profileSyncSourceUsername,
    lastProfileSyncAt: new Date().toISOString(),
  };

  if (result.changed.displayName) {
    next.lastMirroredDisplayName = result.twitterProfile.mirroredDisplayName;
  }

  if (result.changed.description) {
    next.lastMirroredDescription = result.twitterProfile.mirroredDescription;
  }

  if (result.changed.avatar && result.avatarSynced) {
    next.lastMirroredAvatarUrl = normalizeMirrorStateUrl(result.twitterProfile.avatarUrl);
  }

  if (result.changed.banner && result.bannerSynced) {
    next.lastMirroredBannerUrl = normalizeMirrorStateUrl(result.twitterProfile.bannerUrl);
  }

  if (result.changed.website) {
    next.lastMirroredWebsite = result.twitterProfile.mirroredWebsite;
  }

  return next;
};

const fetchPublicProfile = async (actor: string): Promise<{ did: string; handle: string; createdAt?: string }> => {
  const normalizedActor = normalizeOptionalString(actor);
  if (!normalizedActor) {
    throw new Error('Actor is required.');
  }

  const response = await axios.get(`${BSKY_PUBLIC_APPVIEW_URL}/xrpc/app.bsky.actor.getProfile`, {
    params: {
      actor: normalizedActor,
    },
    timeout: 15_000,
  });

  const did = normalizeOptionalString(response.data?.did);
  const handle = normalizeOptionalString(response.data?.handle);
  if (!did || !handle) {
    throw new Error(`Could not resolve Bluesky profile for ${normalizedActor}.`);
  }

  return {
    did,
    handle,
    createdAt: normalizeOptionalString(response.data?.createdAt),
  };
};

const hasFollowRecordForDid = async (agent: BskyAgent, subjectDid: string): Promise<boolean> => {
  const repo = agent.session?.did;
  if (!repo) {
    throw new Error('Missing Bluesky session DID.');
  }

  let cursor: string | undefined;
  let pageCount = 0;

  while (pageCount < 200) {
    pageCount += 1;
    const response = await agent.com.atproto.repo.listRecords({
      repo,
      collection: 'app.bsky.graph.follow',
      limit: 100,
      cursor,
    });

    const records = Array.isArray(response.data.records) ? response.data.records : [];
    for (const record of records) {
      const value = record.value as { subject?: string };
      if (typeof value?.subject === 'string' && value.subject === subjectDid) {
        return true;
      }
    }

    cursor = response.data.cursor;
    if (!cursor) {
      break;
    }
  }

  return false;
};

export const getFediverseBridgeStatus = async (args: {
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
}): Promise<FediverseBridgeStatusResult> => {
  const { agent, credentials } = await loginBlueskyAgent(args);

  const bridgeProfile = await fetchPublicProfile(FEDIVERSE_BRIDGE_HANDLE);
  const bridged = await hasFollowRecordForDid(agent, bridgeProfile.did);

  return {
    bsky: credentials,
    bridgeAccountHandle: bridgeProfile.handle,
    bridged,
  };
};

const uploadProfileImage = async (agent: BskyAgent, url: string, kind: ProfileImageKind): Promise<BlobRef> => {
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 20_000,
    maxContentLength: 10 * 1024 * 1024,
  });

  const mimeType = detectImageMimeType(response.headers?.['content-type'], url);
  const sourceBuffer = Buffer.from(response.data);
  const processed = await compressProfileImage(sourceBuffer, mimeType, kind);
  const { data } = await agent.uploadBlob(processed.buffer, {
    encoding: processed.mimeType,
  });
  return data.blob;
};

export const syncBlueskyProfileFromTwitter = async (args: {
  twitterUsername: string;
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
  previousSync?: ProfileMirrorSyncState;
  syncDisplayName?: boolean;
  syncDescription?: boolean;
  syncAvatar?: boolean;
  syncBanner?: boolean;
  syncWebsite?: boolean;
  /**
   * Overwrite a bio that was edited by hand on Bluesky. Off for automatic
   * syncs; the explicit "pull bio from X" button sets it.
   */
  forceDescription?: boolean;
  botDisplayNameSuffix?: boolean;
}): Promise<MirrorProfileSyncResult> => {
  const twitterProfile = await fetchTwitterMirrorProfile(args.twitterUsername, {
    botDisplayNameSuffix: args.botDisplayNameSuffix,
  });
  const nextMirrorState = buildMirrorStateFromTwitterProfile(twitterProfile);
  const rawChanged = hasMirrorStateChanges(args.previousSync, nextMirrorState);
  const changed = {
    displayName: (args.syncDisplayName ?? true) ? rawChanged.displayName : false,
    description: (args.syncDescription ?? true) ? rawChanged.description : false,
    avatar: (args.syncAvatar ?? true) ? rawChanged.avatar : false,
    banner: (args.syncBanner ?? true) ? rawChanged.banner : false,
    website: (args.syncWebsite ?? true) ? rawChanged.website : false,
  };
  // One login serves both the credential check and the profile write (this
  // used to sign in twice per sync, against a per-account session limit).
  const { agent, credentials: bsky } = await loginBlueskyAgent({
    bskyIdentifier: args.bskyIdentifier,
    bskyPassword: args.bskyPassword,
    bskyServiceUrl: args.bskyServiceUrl,
  });

  if (!changed.displayName && !changed.description && !changed.avatar && !changed.banner && !changed.website) {
    return {
      twitterProfile,
      bsky,
      avatarSynced: false,
      bannerSynced: false,
      skipped: true,
      changed,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  let avatarBlob: BlobRef | undefined;
  let bannerBlob: BlobRef | undefined;

  if (changed.avatar && twitterProfile.avatarUrl) {
    try {
      avatarBlob = await uploadProfileImage(agent, twitterProfile.avatarUrl, 'avatar');
    } catch (error) {
      warnings.push(`Avatar sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (changed.avatar) {
    warnings.push('No Twitter avatar found for this profile.');
  }

  if (changed.banner && twitterProfile.bannerUrl) {
    try {
      bannerBlob = await uploadProfileImage(agent, twitterProfile.bannerUrl, 'banner');
    } catch (error) {
      warnings.push(`Banner sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (changed.banner) {
    warnings.push('No Twitter banner found for this profile.');
  }

  const shouldUpdateProfile =
    changed.displayName || changed.description || changed.website || Boolean(avatarBlob) || Boolean(bannerBlob);

  if (shouldUpdateProfile) {
    await agent.upsertProfile((existing) => {
      let writeDescription = changed.description;
      if (
        writeDescription &&
        !args.forceDescription &&
        !canOverwriteDescription(existing?.description, args.previousSync?.mirroredDescription)
      ) {
        writeDescription = false;
        changed.description = false;
        const note = 'The Bluesky bio was edited by hand, so the X bio was not copied over it.';
        // upsertProfile re-runs this callback on a write conflict.
        if (!warnings.includes(note)) warnings.push(note);
      }
      return {
        ...(existing || {}),
        ...(changed.displayName ? { displayName: twitterProfile.mirroredDisplayName } : {}),
        ...(writeDescription ? { description: twitterProfile.mirroredDescription } : {}),
        ...(changed.website ? { website: twitterProfile.mirroredWebsite } : {}),
        ...(avatarBlob ? { avatar: avatarBlob } : {}),
        ...(bannerBlob ? { banner: bannerBlob } : {}),
      };
    });
  }

  return {
    twitterProfile,
    bsky,
    avatarSynced: Boolean(avatarBlob),
    bannerSynced: Boolean(bannerBlob),
    skipped: false,
    changed,
    warnings,
  };
};

export const bridgeBlueskyAccountToFediverse = async (args: {
  bskyIdentifier: string;
  bskyPassword: string;
  bskyServiceUrl?: string;
}): Promise<FediverseBridgeResult> => {
  const { agent, credentials: bsky } = await loginBlueskyAgent(args);
  const accountProfile = await fetchPublicProfile(bsky.did || bsky.handle);
  const createdAtRaw = normalizeOptionalString(accountProfile.createdAt);
  if (!createdAtRaw) {
    throw new Error('Could not determine when this Bluesky account was created.');
  }

  const createdAtMs = Date.parse(createdAtRaw);
  if (!Number.isFinite(createdAtMs)) {
    throw new Error('Invalid Bluesky account creation timestamp.');
  }

  const ageMs = Date.now() - createdAtMs;
  if (ageMs < MIN_BRIDGE_ACCOUNT_AGE_MS) {
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    throw new Error(`Account must be at least 7 days old before bridging (currently ${ageDays} day(s)).`);
  }

  const bridgeProfile = await fetchPublicProfile(FEDIVERSE_BRIDGE_HANDLE);
  const alreadyFollowing = await hasFollowRecordForDid(agent, bridgeProfile.did);
  if (!alreadyFollowing) {
    const repo = agent.session?.did;
    if (!repo) {
      throw new Error('Missing Bluesky session DID.');
    }

    await agent.com.atproto.repo.createRecord({
      repo,
      collection: 'app.bsky.graph.follow',
      record: {
        subject: bridgeProfile.did,
        createdAt: new Date().toISOString(),
      },
    });
  }

  const fediverseAddress = `@${bsky.handle}@bsky.brid.gy`;
  const text = `This account can now be found on the fediverse at ${fediverseAddress}`;
  const richText = new RichText({ text });
  await richText.detectFacets(agent);

  const post = await agent.post({
    text: richText.text,
    facets: richText.facets,
    createdAt: new Date().toISOString(),
  });

  return {
    bsky,
    bridgedAccountHandle: bsky.handle,
    fediverseAddress,
    accountCreatedAt: new Date(createdAtMs).toISOString(),
    ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
    followedBridgeAccount: !alreadyFollowing,
    announcementUri: post.uri,
    announcementCid: post.cid,
  };
};
