// Bluesky's video service accepts clips up to 300MB and 10 minutes long.
export const MAX_VIDEO_DURATION_MS = 10 * 60 * 1000;
// Stay slightly under 300MB for safety (280MiB = ~293.6M bytes, under the limit
// on either MB interpretation).
export const MAX_VIDEO_UPLOAD_BYTES = 280 * 1024 * 1024;

export interface VideoVariantLike {
  content_type?: string;
  url: string;
  bitrate?: number;
}

// Twitter serves the same clip at several bitrates. At 10 minutes the top
// variant can be well past Bluesky's size ceiling, so rank mp4s best-first and
// drop the ones whose bitrate×duration estimate cannot fit — that keeps long
// videos crossposting at the best quality that survives the upload instead of
// falling back to a bare link.
export function selectVideoVariants<T extends VideoVariantLike>(
  variants: T[],
  durationMs: number,
  maxBytes: number = MAX_VIDEO_UPLOAD_BYTES,
): T[] {
  const mp4s = variants
    .filter((v) => v.content_type === 'video/mp4')
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (durationMs <= 0) return mp4s;
  // Unknown bitrate stays a candidate: the real size check downstream decides.
  const fits = mp4s.filter((v) => !v.bitrate || (v.bitrate / 8) * (durationMs / 1000) <= maxBytes);
  // Every variant looks too big, but estimates are rough — still try the
  // smallest one rather than giving up before a single byte is fetched.
  if (fits.length === 0) return mp4s.slice(-1);
  return fits;
}
