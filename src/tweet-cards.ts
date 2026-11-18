// Card + syndication media extraction.
//
// The twitter-scraper only keeps the legacy tweet object (`__raw_UNSTABLE`) from
// GraphQL responses, dropping the sibling `card` payload. Branded/ad tweets
// ("unified cards": image_website, video_website, carousels, app cards) carry
// their media exclusively inside that card, so they arrive with empty entities.
// The helpers here recover the card from the public syndication API and expand
// it back into normal media entities + destination links.
import axios from 'axios';
import { TWEET_IMAGES_MAX } from './compose.js';

export interface UrlEntity {
  url?: string;
  expanded_url?: string;
}

export interface CardImageValue {
  url?: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface CardBindingValue {
  type?: string;
  string_value?: string;
  boolean_value?: boolean;
  image_value?: CardImageValue;
}

export interface CardBindingEntry {
  key?: string;
  value?: CardBindingValue;
}

export type CardBindingValues = Record<string, CardBindingValue> | CardBindingEntry[];

export interface TweetCard {
  name?: string;
  binding_values?: CardBindingValues;
  url?: string;
}

export interface MediaSize {
  w: number;
  h: number;
}

export interface MediaSizes {
  large?: MediaSize;
}

export interface OriginalInfo {
  width: number;
  height: number;
}

export interface VideoVariant {
  content_type: string;
  url: string;
  bitrate?: number;
}

export interface VideoInfo {
  variants?: VideoVariant[];
  duration_millis?: number;
}

export interface SensitiveMediaWarning {
  adult_content?: boolean;
  graphic_violence?: boolean;
  other?: boolean;
}

export interface MediaEntity {
  url?: string;
  expanded_url?: string;
  media_url_https?: string;
  type?: 'photo' | 'video' | 'animated_gif';
  ext_alt_text?: string;
  sizes?: MediaSizes;
  original_info?: OriginalInfo;
  video_info?: VideoInfo;
  ext_sensitive_media_warning?: SensitiveMediaWarning;
  source?: 'tweet' | 'card';
}

export interface TweetEntities {
  urls?: UrlEntity[];
  media?: MediaEntity[];
}

// Minimal structural shape the card helpers need; the app's Tweet satisfies it.
export interface CardTweet {
  id?: string;
  id_str?: string;
  card?: TweetCard | null;
  entities?: TweetEntities;
  extended_entities?: TweetEntities;
}

export function normalizeCardBindings(bindingValues?: CardBindingValues): Record<string, CardBindingValue> {
  if (!bindingValues) return {};
  if (Array.isArray(bindingValues)) {
    return bindingValues.reduce(
      (acc, entry) => {
        if (entry?.key && entry.value) acc[entry.key] = entry.value;
        return acc;
      },
      {} as Record<string, CardBindingValue>,
    );
  }
  return bindingValues as Record<string, CardBindingValue>;
}

export function isLikelyUrl(value?: string): value is string {
  if (!value) return false;
  return /^https?:\/\//i.test(value);
}

// e.g. the card_url binding on unified cards is a bare "https://twitter.com" placeholder
function isPlaceholderCardLink(link: string): boolean {
  return /^https?:\/\/(www\.)?(twitter|x)\.com\/?$/i.test(link);
}

function extractCardImageUrl(bindingValues: CardBindingValues, preferredKeys: string[]): string | undefined {
  const normalized = normalizeCardBindings(bindingValues);
  for (const key of preferredKeys) {
    const value = normalized[key];
    const imageUrl = value?.image_value?.url;
    if (imageUrl) return imageUrl;
  }
  const fallbackValue = Object.values(normalized).find((value) => value?.image_value?.url);
  return fallbackValue?.image_value?.url;
}

function extractCardLink(bindingValues: CardBindingValues, preferredKeys: string[]): string | undefined {
  const normalized = normalizeCardBindings(bindingValues);
  for (const key of preferredKeys) {
    const value = normalized[key];
    const link = value?.string_value;
    if (isLikelyUrl(link) && !isPlaceholderCardLink(link)) return link;
  }
  const fallbackValue = Object.values(normalized).find(
    (value) => isLikelyUrl(value?.string_value) && !isPlaceholderCardLink(value.string_value as string),
  );
  return fallbackValue?.string_value;
}

function extractCardTitle(bindingValues: CardBindingValues, preferredKeys: string[]): string | undefined {
  const normalized = normalizeCardBindings(bindingValues);
  for (const key of preferredKeys) {
    const value = normalized[key];
    const title = value?.string_value;
    if (title && !isLikelyUrl(title)) return title;
  }
  const fallbackValue = Object.values(normalized).find(
    (value) => value?.string_value && !isLikelyUrl(value?.string_value),
  );
  return fallbackValue?.string_value;
}

function extractCardAlt(bindingValues: CardBindingValues): string | undefined {
  const normalized = normalizeCardBindings(bindingValues);
  const altValue = Object.values(normalized).find((value) => value?.image_value?.alt);
  return altValue?.image_value?.alt;
}

export interface UnifiedCardData {
  media: MediaEntity[];
  links: string[];
  title?: string;
}

// Unified cards keep everything inside a JSON string binding instead of
// image_value bindings: media entities (in legacy format, including video_info
// for video cards), display components, and destination URLs.
export function extractUnifiedCardData(card?: TweetCard | null): UnifiedCardData | null {
  if (!card?.binding_values) return null;
  const bindings = normalizeCardBindings(card.binding_values);
  const rawJson = bindings.unified_card?.string_value;
  if (!rawJson) return null;

  // biome-ignore lint/suspicious/noExplicitAny: unified card payload is loosely structured
  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }

  const mediaEntities = (parsed?.media_entities ?? {}) as Record<string, MediaEntity>;
  // biome-ignore lint/suspicious/noExplicitAny: unified card payload is loosely structured
  const componentObjects = (parsed?.component_objects ?? {}) as Record<string, any>;

  let title: string | undefined;
  for (const component of Object.values(componentObjects)) {
    const content = component?.data?.title?.content;
    if (typeof content === 'string' && content.trim()) {
      title = content.trim();
      break;
    }
  }

  // Preserve display order via the components list (single media or carousel media_list)
  const orderedMediaIds: string[] = [];
  const componentIds: string[] = Array.isArray(parsed?.components) ? parsed.components : [];
  for (const componentId of componentIds) {
    const data = componentObjects[componentId]?.data;
    if (!data) continue;
    if (typeof data.id === 'string') orderedMediaIds.push(data.id);
    if (Array.isArray(data.media_list)) {
      for (const item of data.media_list) {
        if (typeof item?.id === 'string') orderedMediaIds.push(item.id);
      }
    }
  }
  const knownIds = orderedMediaIds.filter((id) => mediaEntities[id]);
  const mediaIds = knownIds.length > 0 ? knownIds : Object.keys(mediaEntities);

  const media: MediaEntity[] = [];
  const seen = new Set<string>();
  for (const mediaId of mediaIds) {
    const entity = mediaEntities[mediaId];
    if (!entity?.media_url_https || seen.has(entity.media_url_https)) continue;
    seen.add(entity.media_url_https);
    media.push({
      media_url_https: entity.media_url_https,
      type: entity.type ?? 'photo',
      sizes: entity.sizes,
      original_info: entity.original_info,
      video_info: entity.video_info,
      ext_alt_text: entity.ext_alt_text || title || 'Sponsored media',
      source: 'card' as const,
    });
  }

  const links: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: unified card payload is loosely structured
  const destinationObjects = (parsed?.destination_objects ?? {}) as Record<string, any>;
  for (const destination of Object.values(destinationObjects)) {
    const url = destination?.data?.url_data?.url;
    if (isLikelyUrl(url) && !links.includes(url)) links.push(url);
  }

  return { media, links, title };
}

export function appendCallToAction(text: string, link?: string, label = 'Sponsored') {
  if (!link) return text;
  if (text.includes(link)) return text;
  return `${text}\n\n${label}: ${link}`.trim();
}

export function detectCardMedia(tweet: CardTweet): {
  imageUrls: string[];
  link?: string;
  title?: string;
  alt?: string;
} {
  if (!tweet.card?.binding_values) return { imageUrls: [] };
  const bindings = tweet.card.binding_values;

  const imageUrls: string[] = [];
  const preferredImageKeys = [
    'photo_image_full_size',
    'photo_image_full_size_original',
    'thumbnail_image',
    'image',
    'thumbnail',
    'summary_photo_image',
    'player_image',
  ];
  const preferredLinkKeys = ['site', 'destination', 'landing_url', 'cta_link', 'card_url', 'url'];
  const preferredTitleKeys = ['title', 'summary', 'card_title'];

  const primaryImage = extractCardImageUrl(bindings, preferredImageKeys);
  if (primaryImage) imageUrls.push(primaryImage);

  const imageKeys = normalizeCardBindings(bindings);
  for (const value of Object.values(imageKeys)) {
    const url = value?.image_value?.url;
    if (url && !imageUrls.includes(url)) imageUrls.push(url);
  }

  const unified = extractUnifiedCardData(tweet.card);
  if (unified) {
    for (const media of unified.media) {
      const url = media.media_url_https;
      if (media.type === 'photo' && url && !imageUrls.includes(url)) imageUrls.push(url);
    }
  }

  const link = unified?.links[0] || extractCardLink(bindings, preferredLinkKeys);
  const title = unified?.title || extractCardTitle(bindings, preferredTitleKeys);
  const alt = extractCardAlt(bindings);

  return { imageUrls, link, title, alt };
}

export function buildCardMediaEntities(tweet: CardTweet): { media: MediaEntity[]; link?: string } {
  // Unified cards carry full media entities (including videos with variants) — use them directly
  const unified = extractUnifiedCardData(tweet.card);
  if (unified && unified.media.length > 0) {
    return { media: unified.media.slice(0, 4), link: unified.links[0] };
  }

  const cardData = detectCardMedia(tweet);
  if (cardData.imageUrls.length === 0) return { media: [] };

  const media = cardData.imageUrls.slice(0, 4).map((url) => ({
    media_url_https: url,
    type: 'photo' as const,
    ext_alt_text: cardData.alt || cardData.title || 'Sponsored image',
    source: 'card' as const,
  }));

  return { media, link: cardData.link };
}

export function ensureUrlEntity(entities: TweetEntities | undefined, link?: string) {
  if (!link) return;
  if (!entities) return;
  const urls = entities.urls || [];
  if (!urls.some((url) => url.expanded_url === link || url.url === link)) {
    urls.push({ url: link, expanded_url: link });
    entities.urls = urls;
  }
}

// Organic link-preview cards (plain OG summary/player cards). They carry one
// OG image as many size-variant bindings (thumbnail_image_small ..
// photo_image_full_size_x_large), which the multi-image heuristic in
// detectSponsoredCard would misread as an ad carousel. These tweets must keep
// the normal external link-embed path instead of having card media injected.
const ORGANIC_CARD_NAMES = /^(summary|summary_large_image|player)$/i;

export function detectSponsoredCard(tweet: CardTweet): boolean {
  if (!tweet.card?.binding_values) return false;
  const cardName = tweet.card.name?.toLowerCase() || '';
  if (ORGANIC_CARD_NAMES.test(cardName)) return false;
  const cardMedia = detectCardMedia(tweet);
  const hasMultipleImages = cardMedia.imageUrls.length > 1;
  const promoKeywords = ['promo', 'unified', 'carousel', 'collection', 'amplify'];
  const hasPromoName = promoKeywords.some((keyword) => cardName.includes(keyword));
  return hasMultipleImages || hasPromoName;
}

export function mergeMediaEntities(
  primary: MediaEntity[],
  secondary: MediaEntity[],
  limit = TWEET_IMAGES_MAX,
): MediaEntity[] {
  const merged: MediaEntity[] = [];
  const seen = new Set<string>();
  const ordered = [
    ...primary.filter((media) => media?.source !== 'card'),
    ...primary.filter((media) => media?.source === 'card'),
    ...secondary.filter((media) => media?.source !== 'card'),
    ...secondary.filter((media) => media?.source === 'card'),
  ];

  for (const media of ordered) {
    if (!media?.media_url_https) continue;
    if (seen.has(media.media_url_https)) continue;
    merged.push(media);
    seen.add(media.media_url_https);
    if (merged.length >= limit) break;
  }

  return merged;
}

export function detectCarouselLinks(tweet: CardTweet): string[] {
  if (!tweet.card?.binding_values) return [];
  const bindings = normalizeCardBindings(tweet.card.binding_values);
  const links = Object.values(bindings)
    .map((value) => value?.string_value)
    .filter((value): value is string => isLikelyUrl(value) && !isPlaceholderCardLink(value));
  const unifiedLinks = extractUnifiedCardData(tweet.card)?.links ?? [];
  return [...new Set([...unifiedLinks, ...links])];
}

export function mergeUrlEntities(entities: TweetEntities | undefined, links: string[]) {
  if (!entities || links.length === 0) return;
  const urls = entities.urls || [];
  for (const link of links) {
    if (!urls.some((url) => url.expanded_url === link || url.url === link)) {
      urls.push({ url: link, expanded_url: link });
    }
  }
  entities.urls = urls;
}

export function injectCardMedia(tweet: CardTweet) {
  if (!tweet.card?.binding_values) return;
  const cardMedia = buildCardMediaEntities(tweet);
  if (cardMedia.media.length === 0) return;

  const existingMedia = tweet.extended_entities?.media || tweet.entities?.media || [];
  const mergedMedia = mergeMediaEntities(existingMedia, cardMedia.media);

  if (!tweet.extended_entities) tweet.extended_entities = {};
  tweet.extended_entities.media = mergedMedia;
  if (!tweet.entities) tweet.entities = {};
  if (!tweet.entities.media) tweet.entities.media = mergedMedia;

  if (cardMedia.link) {
    ensureUrlEntity(tweet.entities, cardMedia.link);
  }

  const carouselLinks = detectCarouselLinks(tweet);
  mergeUrlEntities(tweet.entities, carouselLinks);
}

export function ensureSponsoredLinks(text: string, tweet: CardTweet): string {
  if (!tweet.card?.binding_values) return text;
  const carouselLinks = detectCarouselLinks(tweet);
  const cardLink = detectCardMedia(tweet).link;
  const links = [...new Set([cardLink, ...carouselLinks].filter(Boolean))] as string[];
  if (links.length === 0) return text;

  const appendedLinks = links.slice(0, 2).map((link) => `Link: ${link}`);
  const updatedText = `${text}\n\n${appendedLinks.join('\n')}`.trim();
  return updatedText;
}

// Access token expected by cdn.syndication.twimg.com, derived from the tweet id
function syndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export async function fetchSyndicationTweet(tweetId: string): Promise<{ images: string[]; card?: TweetCard }> {
  try {
    const res = await axios.get('https://cdn.syndication.twimg.com/tweet-result', {
      params: { id: tweetId, token: syndicationToken(tweetId) },
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      timeout: 10000,
    });
    const data = res.data as Record<string, unknown>;
    const images = ((data?.photos as { url?: string }[] | undefined) ?? [])
      .map((photo) => photo.url)
      .filter(Boolean) as string[];
    const card = (data?.card as TweetCard | undefined) ?? undefined;
    return { images, card };
  } catch {
    return { images: [] };
  }
}

export interface PollChoice {
  label: string;
  count?: number;
}

export interface PollData {
  choices: PollChoice[];
  endsAt?: string;
  countsAreFinal?: boolean;
}

// Polls are cards too (poll2choice_text_only .. poll4choice_image), with the
// choices/results in plain bindings. Bluesky has no poll embed, so callers
// link back to the original tweet instead.
export function extractPollData(card?: TweetCard | null): PollData | null {
  if (!card?.name || !/^poll\d+choice/i.test(card.name)) return null;
  const bindings = normalizeCardBindings(card.binding_values);

  const choices: PollChoice[] = [];
  for (let i = 1; i <= 4; i++) {
    const label = bindings[`choice${i}_label`]?.string_value;
    if (!label) break;
    const rawCount = bindings[`choice${i}_count`]?.string_value;
    const count = rawCount ? Number(rawCount) : Number.NaN;
    choices.push({ label, count: Number.isFinite(count) ? count : undefined });
  }
  if (choices.length === 0) return null;

  return {
    choices,
    endsAt: bindings.end_datetime_utc?.string_value,
    countsAreFinal: bindings.counts_are_final?.boolean_value === true,
  };
}

// Bottom-of-post note pointing readers at the original tweet's poll.
export function buildPollNote(card: TweetCard | null | undefined, tweetUrl: string): string | null {
  const poll = extractPollData(card);
  if (!poll) return null;

  const choiceList = poll.choices.map((choice) => choice.label).join(' / ');
  const summary = choiceList.length <= 60 ? ` (${choiceList})` : '';
  const action = poll.countsAreFinal ? 'see the results on X' : 'vote on X';
  return `📊 This post has a poll${summary} — ${action}: ${tweetUrl}`;
}

// Check stage run for every tweet before media handling: the scraper only keeps
// the legacy tweet object and drops the GraphQL card payload, so branded/ad
// tweets (unified cards) and polls lose their card. Recover it from the
// syndication API and inject any card media, so these tweets post like any other.
export async function recoverCardData(tweet: CardTweet): Promise<{ isSponsoredCard: boolean }> {
  let isSponsoredCard = detectSponsoredCard(tweet);
  if (!isSponsoredCard) {
    const tweetId = tweet.id_str || tweet.id;
    if (tweetId) {
      const syndication = await fetchSyndicationTweet(tweetId);
      if (!tweet.card && syndication.card) {
        tweet.card = syndication.card;
        isSponsoredCard = detectSponsoredCard(tweet);
      }
      if (!isSponsoredCard && syndication.images.length > 0) {
        injectSyndicationMedia(tweet, syndication);
      }
    }
  }
  if (isSponsoredCard) {
    injectCardMedia(tweet);
  }
  return { isSponsoredCard };
}

export function injectSyndicationMedia(tweet: CardTweet, syndication: { images: string[] }) {
  if (syndication.images.length === 0) return;
  const media = syndication.images.slice(0, TWEET_IMAGES_MAX).map((url) => ({
    media_url_https: url,
    type: 'photo' as const,
    ext_alt_text: 'Image from Twitter',
    source: 'card' as const,
  }));

  const existingMedia = tweet.extended_entities?.media || tweet.entities?.media || [];
  const mergedMedia = mergeMediaEntities(existingMedia, media);

  if (!tweet.extended_entities) tweet.extended_entities = {};
  tweet.extended_entities.media = mergedMedia;
  if (!tweet.entities) tweet.entities = {};
  if (!tweet.entities.media) tweet.entities.media = mergedMedia;
}
