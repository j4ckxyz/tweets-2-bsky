// Rich-text facets: Bluesky indexes them by UTF-8 byte offset while JavaScript
// strings are UTF-16, so segments are sliced from encoded bytes rather than
// from the string directly.
import type { BskyFacet } from '../types';

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();
export const compactNumberFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export type FacetSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'mention'; text: string; href: string }
  | { type: 'tag'; text: string; href: string };

export function sliceByBytes(bytes: Uint8Array, start: number, end: number): string {
  return textDecoder.decode(bytes.slice(start, end));
}

export function buildFacetSegments(text: string, facets: BskyFacet[]): FacetSegment[] {
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

export function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(Math.max(0, value));
}
