// Bluesky posts cap at 300 characters, so a long tweet becomes a self-thread.
// Chunks used to carry a " (1/3)" counter, which reserved 8 characters of every
// chunk and made mirrored threads read like machine output — native Bluesky
// threads just flow. The counter is gone, so chunks get the full limit back.
export const BSKY_POST_LIMIT = 300;

export function splitText(text: string, limit: number = BSKY_POST_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Smart splitting priority:
    // 1. Double newline (paragraph)
    // 2. Sentence end (.!?)
    // 3. Space
    // 4. Force split

    let splitIndex = -1;

    // Check paragraphs
    let checkIndex = remaining.lastIndexOf('\n\n', limit);
    if (checkIndex !== -1) splitIndex = checkIndex;

    // Check sentences
    if (splitIndex === -1) {
      // Look for punctuation followed by space
      const sentenceMatches = Array.from(remaining.substring(0, limit).matchAll(/[.!?]\s/g));
      if (sentenceMatches.length > 0) {
        const lastMatch = sentenceMatches[sentenceMatches.length - 1];
        if (lastMatch && lastMatch.index !== undefined) {
          splitIndex = lastMatch.index + 1; // Include punctuation
        }
      }
    }

    // Check spaces
    if (splitIndex === -1) {
      checkIndex = remaining.lastIndexOf(' ', limit);
      if (checkIndex !== -1) splitIndex = checkIndex;
    }

    // Force split if no good break point found
    if (splitIndex === -1) {
      splitIndex = limit;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}
