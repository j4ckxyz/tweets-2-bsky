/**
 * Twitter handle -> Bluesky (atproto) handle mapping.
 *
 * Pure functions only: no network, no filesystem. Everything here is covered by
 * `bun scripts/test-rehandle.ts`.
 *
 * Rule sources:
 *  - Twitter/X usernames: 1-15 chars, `[A-Za-z0-9_]` only. Case-insensitive,
 *    may not contain `-` or `.`.
 *  - atproto handles (https://atproto.com/specs/handle): ASCII only, <= 253
 *    chars, >= 2 dot-separated segments. Each segment is 1-63 chars of
 *    `[a-zA-Z0-9-]` and may not start or end with `-`. The final segment (TLD)
 *    may not start with a digit. Handles normalize to lowercase.
 *
 * The interesting delta is the underscore: legal and common on Twitter, illegal
 * in a DNS label. We translate `_` -> `-`, which then creates three follow-on
 * problems this module has to solve: leading/trailing hyphens (illegal),
 * doubled hyphens, and collisions between distinct Twitter handles.
 */

export const MAX_LABEL_LENGTH = 63;
export const MAX_HANDLE_LENGTH = 253;

/** Reference regex from the atproto handle spec. */
export const ATPROTO_HANDLE_REGEX =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/** TLDs the atproto spec forbids for handles. */
export const DISALLOWED_TLDS = ['alt', 'arpa', 'example', 'internal', 'invalid', 'local', 'localhost', 'onion'];

/** Canonical Twitter/X username shape. */
export const TWITTER_USERNAME_REGEX = /^[A-Za-z0-9_]{1,15}$/;

export type NoteLevel = 'info' | 'warn';

export interface ConversionNote {
  level: NoteLevel;
  code: string;
  message: string;
}

export interface HandleConversion {
  /** Input as given. */
  input: string;
  /** Input with `@` and whitespace stripped, lowercased. */
  twitterUsername: string;
  /** The single DNS label derived from the Twitter username, or null on failure. */
  label: string | null;
  /** `${label}.${domain}`, or null on failure. */
  handle: string | null;
  /** True when `handle` is a usable atproto handle. */
  ok: boolean;
  notes: ConversionNote[];
  errors: string[];
}

const note = (level: NoteLevel, code: string, message: string): ConversionNote => ({ level, code, message });

/** Strip a leading `@` and surrounding whitespace, then lowercase. */
export function normalizeTwitterUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim().toLowerCase();
}

/**
 * Convert one Twitter username into a DNS label suitable for use as the
 * left-most segment of an atproto handle.
 */
export function twitterToLabel(rawUsername: string): {
  label: string | null;
  notes: ConversionNote[];
  errors: string[];
} {
  const notes: ConversionNote[] = [];
  const errors: string[] = [];

  const username = normalizeTwitterUsername(rawUsername);

  if (!username) {
    errors.push('Twitter username is empty.');
    return { label: null, notes, errors };
  }

  if (rawUsername.trim() !== username) {
    notes.push(
      note('info', 'normalized', `Normalized "${rawUsername.trim()}" -> "${username}" (stripped @ / lowercased).`),
    );
  }

  if (!TWITTER_USERNAME_REGEX.test(username)) {
    notes.push(
      note(
        'warn',
        'nonstandard-twitter-username',
        `"${username}" is outside the canonical Twitter shape (1-15 chars of a-z, 0-9, _). Double-check it is the handle you mean.`,
      ),
    );
  }

  // Underscores are the expected difference between the two systems.
  let label = username;
  if (label.includes('_')) {
    notes.push(note('info', 'underscore-to-hyphen', `Underscores are illegal in DNS labels; translated "_" -> "-".`));
    label = label.replace(/_/g, '-');
  }

  // Anything else outside [a-z0-9-] also becomes a hyphen, but loudly.
  const illegal = [...new Set(label.replace(/[a-z0-9-]/g, '').split(''))];
  if (illegal.length > 0) {
    notes.push(
      note(
        'warn',
        'illegal-characters',
        `Replaced character(s) ${illegal.map((c) => JSON.stringify(c)).join(', ')} with "-"; they are not valid in a handle.`,
      ),
    );
    label = label.replace(/[^a-z0-9-]/g, '-');
  }

  // `a--b` is legal per the spec regex but collides with the IDN `xn--` A-label
  // convention and reads badly, so collapse runs.
  if (/--+/.test(label)) {
    notes.push(note('info', 'collapsed-hyphens', 'Collapsed repeated hyphens into a single hyphen.'));
    label = label.replace(/-{2,}/g, '-');
  }

  // Labels may not start or end with a hyphen (so `_jack_` cannot become `-jack-`).
  const stripped = label.replace(/^-+/, '').replace(/-+$/, '');
  if (stripped !== label) {
    notes.push(
      note('info', 'trimmed-hyphens', 'Trimmed leading/trailing hyphens; a DNS label may not begin or end with "-".'),
    );
    label = stripped;
  }

  if (!label) {
    errors.push(`"${username}" contains no characters that are legal in a handle.`);
    return { label: null, notes, errors };
  }

  if (label.length > MAX_LABEL_LENGTH) {
    errors.push(`Label "${label}" is ${label.length} chars; the maximum is ${MAX_LABEL_LENGTH}.`);
    return { label: null, notes, errors };
  }

  if (label.startsWith('xn--')) {
    notes.push(
      note(
        'warn',
        'xn--prefix',
        `"${label}" starts with "xn--", which is reserved for internationalized domain names.`,
      ),
    );
  }

  return { label, notes, errors };
}

/** Validate a full handle against the atproto handle spec. */
export function validateHandle(handle: string): string[] {
  const errors: string[] = [];

  if (handle !== handle.toLowerCase()) {
    errors.push(`Handle "${handle}" is not lowercase.`);
  }
  if (handle.length > MAX_HANDLE_LENGTH) {
    errors.push(`Handle "${handle}" is ${handle.length} chars; the maximum is ${MAX_HANDLE_LENGTH}.`);
  }

  const segments = handle.split('.');
  if (segments.length < 2) {
    errors.push(`Handle "${handle}" needs at least two dot-separated segments.`);
  }
  for (const segment of segments) {
    if (segment.length < 1 || segment.length > MAX_LABEL_LENGTH) {
      errors.push(`Segment "${segment}" must be 1-${MAX_LABEL_LENGTH} chars.`);
    }
    if (segment.startsWith('-') || segment.endsWith('-')) {
      errors.push(`Segment "${segment}" may not start or end with a hyphen.`);
    }
    if (/[^a-z0-9-]/.test(segment)) {
      errors.push(`Segment "${segment}" contains characters outside a-z, 0-9 and "-".`);
    }
  }

  const tld = segments[segments.length - 1] ?? '';
  if (/^[0-9]/.test(tld)) {
    errors.push(`The top-level domain "${tld}" may not start with a digit.`);
  }
  if (DISALLOWED_TLDS.includes(tld)) {
    errors.push(`The top-level domain "${tld}" is not allowed for atproto handles.`);
  }

  if (errors.length === 0 && !ATPROTO_HANDLE_REGEX.test(handle)) {
    errors.push(`Handle "${handle}" does not match the atproto handle syntax regex.`);
  }

  return errors;
}

/** Full conversion: Twitter username + base domain -> validated atproto handle. */
export function convertHandle(rawUsername: string, domain: string): HandleConversion {
  const twitterUsername = normalizeTwitterUsername(rawUsername);
  const { label, notes, errors } = twitterToLabel(rawUsername);

  const baseDomain = domain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (!baseDomain) {
    errors.push('Base domain is empty.');
  }

  if (!label || errors.length > 0) {
    return { input: rawUsername, twitterUsername, label, handle: null, ok: false, notes, errors };
  }

  const handle = `${label}.${baseDomain}`;
  const handleErrors = validateHandle(handle);
  errors.push(...handleErrors);

  return {
    input: rawUsername,
    twitterUsername,
    label,
    handle: handleErrors.length === 0 ? handle : null,
    ok: handleErrors.length === 0,
    notes,
    errors,
  };
}

export interface CollisionGroup {
  handle: string;
  sources: string[];
}

/**
 * Two different Twitter handles can converge on one atproto handle (`a_b` and
 * `a__b` both become `a-b`). Never auto-suffix: report and let a human decide.
 */
export function findCollisions(conversions: HandleConversion[]): CollisionGroup[] {
  const byHandle = new Map<string, string[]>();
  for (const conversion of conversions) {
    if (!conversion.ok || !conversion.handle) continue;
    const sources = byHandle.get(conversion.handle) ?? [];
    sources.push(conversion.twitterUsername);
    byHandle.set(conversion.handle, sources);
  }
  return [...byHandle.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([handle, sources]) => ({ handle, sources: [...new Set(sources)] }))
    .filter((group) => group.sources.length > 1);
}
