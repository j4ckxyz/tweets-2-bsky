// Bluesky posts cap at 300 characters, so a long tweet becomes a self-thread.
// Chunks used to carry a " (1/3)" counter, which reserved 8 characters of every
// chunk and made mirrored threads read like machine output — native Bluesky
// threads just flow. The counter is gone, so chunks get the full limit back.
//
// "Characters" here means what Bluesky counts: grapheme clusters, capped at 300,
// with the record text also capped at 3000 UTF-8 bytes. Counting UTF-16 code
// units instead split emoji-heavy tweets early, and a forced split could land
// between the two halves of a surrogate pair and corrupt the emoji.
export const BSKY_POST_LIMIT = 300;
export const BSKY_POST_BYTE_LIMIT = 3000;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Number of grapheme clusters, the unit Bluesky's 300 limit is measured in. */
export function graphemeLength(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

/**
 * UTF-16 index of the longest prefix that stays within both the grapheme and
 * the byte limit. Always a grapheme boundary, so slicing there never splits a
 * character.
 */
function maxPrefixIndex(text: string, graphemeLimit: number, byteLimit: number): number {
  let graphemes = 0;
  let bytes = 0;
  for (const { index, segment } of segmenter.segment(text)) {
    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    if (graphemes + 1 > graphemeLimit || bytes + segmentBytes > byteLimit) return index;
    graphemes += 1;
    bytes += segmentBytes;
  }
  return text.length;
}

function fits(text: string, limit: number): boolean {
  return graphemeLength(text) <= limit && Buffer.byteLength(text, 'utf8') <= BSKY_POST_BYTE_LIMIT;
}

export function splitText(text: string, limit: number = BSKY_POST_LIMIT): string[] {
  if (fits(text, limit)) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (fits(remaining, limit)) {
      chunks.push(remaining);
      break;
    }

    // The furthest this chunk may reach; every break point is searched for
    // inside this window.
    const hardIndex = maxPrefixIndex(remaining, limit, BSKY_POST_BYTE_LIMIT);
    const window = remaining.slice(0, hardIndex);

    // Smart splitting priority:
    // 1. Double newline (paragraph)
    // 2. Sentence end (.!?)
    // 3. Space
    // 4. Force split (on a grapheme boundary)
    let splitIndex = window.lastIndexOf('\n\n');

    if (splitIndex <= 0) {
      const sentenceMatches = Array.from(window.matchAll(/[.!?]\s/g));
      const lastMatch = sentenceMatches[sentenceMatches.length - 1];
      splitIndex = lastMatch?.index !== undefined ? lastMatch.index + 1 : -1;
    }

    if (splitIndex <= 0) {
      splitIndex = window.lastIndexOf(' ');
    }

    if (splitIndex <= 0) {
      splitIndex = hardIndex;
    }

    const chunk = remaining.substring(0, splitIndex).trim();
    if (chunk.length === 0) {
      // Only whitespace before the break: take the hard window instead so the
      // loop always makes progress.
      chunks.push(remaining.substring(0, hardIndex).trim());
      remaining = remaining.substring(hardIndex).trim();
      continue;
    }
    chunks.push(chunk);
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks.filter((chunk) => chunk.length > 0);
}
