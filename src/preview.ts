// Dry-run preview bridge.
//
// The composer lives in index.ts, which imports the server — so the server
// cannot import it back. index.ts registers a runner here at startup and the
// server calls it, which keeps the preview honest: it runs the real compose
// path with dryRun set, rather than a second implementation that drifts from
// what actually gets posted.

export interface PreviewChunk {
  text: string;
  /** Characters in this chunk, against Bluesky's 300 limit. */
  length: number;
}

export interface PreviewTweet {
  twitterId: string;
  originalText: string;
  createdAt?: string;
  /** What would be posted, one entry per chunk of the thread. */
  chunks: PreviewChunk[];
  images: number;
  video: boolean;
  quote: boolean;
  linkCard: boolean;
  isReply: boolean;
  /** Set when the tweet would not be posted at all, with the reason why. */
  skipped?: { stage: string; reason: string };
}

export interface PreviewRequest {
  twitterUsername: string;
  /** Existing mapping to preview against; omit to preview an unconfigured account. */
  mappingId?: string;
  limit: number;
}

export interface PreviewResult {
  twitterUsername: string;
  fetched: number;
  tweets: PreviewTweet[];
}

export type PreviewRunner = (request: PreviewRequest) => Promise<PreviewResult>;

let runner: PreviewRunner | null = null;

export function setPreviewRunner(fn: PreviewRunner): void {
  runner = fn;
}

export function isPreviewAvailable(): boolean {
  return runner !== null;
}

export async function runPreview(request: PreviewRequest): Promise<PreviewResult> {
  if (!runner) {
    throw new Error('Preview is not available: the mirror process has not finished starting up.');
  }
  return runner(request);
}
