// Pure helpers the composer uses to turn a tweet into a Bluesky post. Kept out
// of index.ts (which starts the daemon) so each rule can be tested on its own,
// offline, with nothing but inputs and outputs.
import * as francModule from 'franc-min';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Twitter HTML-escapes `&`, `<` and `>` in tweet text. `&amp;` must be decoded
 * last: decoding it first turns a tweet that literally says "&lt;" (sent as
 * "&amp;lt;") into "<".
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const TWITTER_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'm.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.x.com',
]);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Whether a URL points at Twitter/X itself. Compares the hostname exactly: a
 * substring test on "x.com" also matches netflix.com, spacex.com, dropbox.com,
 * xbox.com, vox.com and roblox.com, which silently lost their link cards.
 */
export function isTwitterUrl(value: string): boolean {
  const url = parseUrl(value);
  if (!url) return false;
  return TWITTER_HOSTS.has(url.hostname.toLowerCase());
}

export interface TweetStatusRef {
  /** Screen name from the URL; absent for /i/status/<id> links. */
  username?: string;
  id: string;
}

/** Recognise https://x.com/<user>/status/<id> (and the twitter.com / /i/ forms). */
export function parseTweetStatusUrl(value: string): TweetStatusRef | null {
  const url = parseUrl(value);
  if (!url || !TWITTER_HOSTS.has(url.hostname.toLowerCase())) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  // /<user>/status/<id>[/photo/1]
  if (parts.length >= 3 && parts[1]?.toLowerCase() === 'status' && /^\d+$/.test(parts[2] ?? '')) {
    const username = parts[0]?.toLowerCase();
    return { username: username === 'i' ? undefined : username, id: parts[2] as string };
  }
  // /i/web/status/<id>
  if (
    parts.length >= 4 &&
    parts[0] === 'i' &&
    parts[1] === 'web' &&
    parts[2] === 'status' &&
    /^\d+$/.test(parts[3] ?? '')
  ) {
    return { id: parts[3] as string };
  }
  return null;
}

/** bsky.app URL for a post, from its at:// URI. */
export function bskyPostUrl(atUri: string, actor?: string): string | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!match) return null;
  return `https://bsky.app/profile/${actor || match[1]}/post/${match[2]}`;
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

// franc-min reports ISO 639-3; Bluesky's `langs` are BCP-47, which uses the
// two-letter ISO 639-1 code wherever one exists. Languages without a two-letter
// code keep their three-letter code, which BCP-47 also accepts.
const ISO_639_3_TO_BCP47: Record<string, string> = {
  amh: 'am',
  arb: 'ar',
  azj: 'az',
  bel: 'be',
  ben: 'bn',
  bho: 'bho',
  bos: 'bs',
  bul: 'bg',
  ceb: 'ceb',
  ces: 'cs',
  ckb: 'ckb',
  cmn: 'zh',
  deu: 'de',
  ell: 'el',
  eng: 'en',
  fra: 'fr',
  fuv: 'ff',
  guj: 'gu',
  hau: 'ha',
  hin: 'hi',
  hms: 'hms',
  hnj: 'hnj',
  hrv: 'hr',
  hun: 'hu',
  ibo: 'ig',
  ilo: 'ilo',
  ind: 'id',
  ita: 'it',
  jav: 'jv',
  jpn: 'ja',
  kan: 'kn',
  kaz: 'kk',
  kin: 'rw',
  koi: 'koi',
  kor: 'ko',
  lin: 'ln',
  mad: 'mad',
  mag: 'mag',
  mai: 'mai',
  mal: 'ml',
  mar: 'mr',
  mya: 'my',
  nld: 'nl',
  npi: 'ne',
  nya: 'ny',
  pan: 'pa',
  pbu: 'ps',
  pes: 'fa',
  plt: 'mg',
  pol: 'pl',
  por: 'pt',
  qug: 'qug',
  ron: 'ro',
  run: 'rn',
  rus: 'ru',
  sin: 'si',
  skr: 'skr',
  som: 'so',
  spa: 'es',
  srp: 'sr',
  sun: 'su',
  swe: 'sv',
  swh: 'sw',
  tam: 'ta',
  tel: 'te',
  tgl: 'tl',
  tha: 'th',
  tur: 'tr',
  ukr: 'uk',
  urd: 'ur',
  uzn: 'uz',
  vie: 'vi',
  yor: 'yo',
  zlm: 'ms',
  zul: 'zu',
  zyb: 'za',
};

// Twitter still emits a few withdrawn ISO 639-1 codes.
const LEGACY_TWITTER_LANGS: Record<string, string> = { in: 'id', iw: 'he', ji: 'yi' };

// Codes that describe a tweet rather than name a language: undetermined, no
// linguistic content, multiple, and Twitter's private-use q-codes (qme = media
// only, qht = hashtags only, qam = mentions only, qct = cashtags only, qst =
// too short). Tagging a post with any of these helps nobody.
const NON_LANGUAGE_CODES = new Set(['und', 'zxx', 'mul', 'mis', 'art']);

/** Normalise one of Twitter's `lang` values to a BCP-47 tag, or null. */
export function normalizeTwitterLang(raw?: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(value)) return null;
  const [primaryRaw, ...rest] = value.split('-');
  const primary = (primaryRaw ?? '').toLowerCase();
  if (NON_LANGUAGE_CODES.has(primary)) return null;
  // qaa-qtz is the private-use range; Twitter's q-codes all live there.
  if (/^q[a-t][a-z]$/.test(primary)) return null;
  const mapped = LEGACY_TWITTER_LANGS[primary] ?? primary;
  const subtags = rest.map((tag) => (tag.length === 2 ? tag.toUpperCase() : tag.toLowerCase()));
  return [mapped, ...subtags].join('-');
}

const franc = (francModule as unknown as { franc: (text: string, options?: { minLength?: number }) => string }).franc;

/** Text with URLs, mentions and hashtags removed: what language detection should see. */
function stripNonProse(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#$][\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Guess a language from text alone. Returns null rather than a wrong guess. */
export function detectTextLanguage(text: string): string | null {
  const prose = stripNonProse(text);
  // Below this, trigram detection is closer to noise than to an answer.
  if (prose.length < 20) return null;
  try {
    const code3 = franc(prose, { minLength: 20 });
    if (!code3 || code3 === 'und') return null;
    return ISO_639_3_TO_BCP47[code3] ?? null;
  } catch {
    return null;
  }
}

/**
 * Languages for a mirrored post. Twitter's own `lang` wins (it is far better
 * than trigram detection on 280 characters); the text is only consulted when
 * Twitter did not say. When neither is confident, `langs` is left out — Bluesky
 * shows untagged posts to everyone, whereas a wrong tag hides the post from
 * exactly the people who read that language.
 */
export function resolvePostLangs(twitterLang: string | null | undefined, text: string): string[] | undefined {
  if (twitterLang?.trim()) {
    const fromTwitter = normalizeTwitterLang(twitterLang);
    // Twitter answered "no language to speak of" (und, zxx, media/hashtag-only
    // q-codes). Its detector saw the same text trigrams would, so trust it.
    return fromTwitter ? [fromTwitter] : undefined;
  }
  // No verdict from Twitter (older queued payloads): fall back to the text.
  const detected = detectTextLanguage(text);
  return detected ? [detected] : undefined;
}

// ---------------------------------------------------------------------------
// Content labels
// ---------------------------------------------------------------------------

export interface SensitiveMediaLike {
  ext_sensitive_media_warning?: { adult_content?: boolean; graphic_violence?: boolean; other?: boolean };
}

/** What to label a post whose tweet is flagged sensitive without saying why. */
export type SensitiveFallbackLabel = 'sexual' | 'nudity' | 'graphic-media' | 'none';

export const SENSITIVE_FALLBACK_LABELS: SensitiveFallbackLabel[] = ['sexual', 'nudity', 'graphic-media', 'none'];

export function normalizeSensitiveFallbackLabel(value: unknown): SensitiveFallbackLabel | undefined {
  return typeof value === 'string' && (SENSITIVE_FALLBACK_LABELS as string[]).includes(value)
    ? (value as SensitiveFallbackLabel)
    : undefined;
}

/**
 * Mirror Twitter's sensitive-media flags as Bluesky self labels. Per-media
 * warnings carry a category and map to a specific label. The tweet-level
 * `possibly_sensitive` flag has no category — accounts that tick "mark media I
 * post as sensitive" get it on every media tweet — so what it becomes is a
 * per-mapping choice, defaulting to the mildest adult label.
 */
export function buildSensitiveLabels(
  mediaEntities: SensitiveMediaLike[],
  possiblySensitive: boolean | undefined,
  fallback: SensitiveFallbackLabel = 'sexual',
): string[] {
  const values = new Set<string>();
  for (const media of mediaEntities) {
    const warning = media.ext_sensitive_media_warning;
    if (!warning) continue;
    if (warning.adult_content) values.add('porn');
    if (warning.graphic_violence) values.add('graphic-media');
    if (warning.other) values.add('graphic-media');
  }
  if (values.size === 0 && possiblySensitive && fallback !== 'none') {
    values.add(fallback);
  }
  return [...values];
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

export interface FacetLike {
  index: { byteStart: number; byteEnd: number };
  features: { $type: string; [key: string]: unknown }[];
}

function utf16IndexToUtf8Index(text: string, index: number): number {
  return Buffer.byteLength(text.slice(0, index), 'utf8');
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

/**
 * RichText.detectFacets leaves `did: ''` on a mention it could not resolve (a
 * tweet saying "@nytimes.com", say). A mention facet with an empty DID fails
 * record validation, so the PDS rejected the whole post and the tweet was
 * parked as failed. Drop those features; the text itself is untouched.
 */
export function dropUnresolvedMentions(facets: FacetLike[] | undefined): FacetLike[] | undefined {
  if (!facets) return facets;
  const cleaned = facets
    .map((facet) => ({
      ...facet,
      features: facet.features.filter(
        (feature) =>
          feature.$type !== 'app.bsky.richtext.facet#mention' ||
          (typeof feature.did === 'string' && feature.did.startsWith('did:')),
      ),
    }))
    .filter((facet) => facet.features.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Turn Twitter @handles into Bluesky facets. A handle that is mirrored on this
 * instance becomes a real mention of the mirror's DID — hover card, follow
 * button and notification all work — and anything else links to the X profile.
 */
export function addTwitterHandleFacets(
  text: string,
  facets: FacetLike[] | undefined,
  resolveMirrorDid: (twitterUsername: string) => string | undefined = () => undefined,
): FacetLike[] | undefined {
  const existingFacets = facets ?? [];
  const newFacets: FacetLike[] = [];
  const regex = /@([A-Za-z0-9_]{1,15})/g;

  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    const handle = match[1];
    if (!handle) continue;

    const atIndex = match.index;
    const prevChar = atIndex > 0 ? text[atIndex - 1] : '';
    if (prevChar && /[A-Za-z0-9_]/.test(prevChar)) continue;

    const endIndex = atIndex + handle.length + 1;
    const trailing = text.slice(endIndex);
    if (trailing.startsWith('.') && /^\.[A-Za-z0-9-]+/.test(trailing)) continue;

    const nextChar = endIndex < text.length ? text[endIndex] : '';
    if (nextChar && /[A-Za-z0-9_]/.test(nextChar)) continue;

    const byteStart = utf16IndexToUtf8Index(text, atIndex);
    const byteEnd = utf16IndexToUtf8Index(text, endIndex);

    const overlaps = existingFacets.some((facet) =>
      rangesOverlap(byteStart, byteEnd, facet.index.byteStart, facet.index.byteEnd),
    );
    if (overlaps) continue;

    const did = resolveMirrorDid(handle.toLowerCase());
    newFacets.push({
      index: { byteStart, byteEnd },
      features: [
        did
          ? { $type: 'app.bsky.richtext.facet#mention', did }
          : { $type: 'app.bsky.richtext.facet#link', uri: `https://x.com/${handle}` },
      ],
    });
  }

  if (newFacets.length === 0) return facets;
  return [...existingFacets, ...newFacets].sort((a, b) => a.index.byteStart - b.index.byteStart);
}
