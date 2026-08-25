#!/usr/bin/env bun
import {
  MAX_VIDEO_DURATION_MS,
  MAX_VIDEO_UPLOAD_BYTES,
  type VideoVariantLike,
  selectVideoVariants,
} from '../src/video-limits.js';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

const variants: VideoVariantLike[] = [
  { content_type: 'video/mp4', url: 'low.mp4', bitrate: 832_000 },
  { content_type: 'video/mp4', url: 'high.mp4', bitrate: 10_368_000 },
  { content_type: 'video/mp4', url: 'medium.mp4', bitrate: 2_176_000 },
  { content_type: 'application/x-mpegURL', url: 'playlist.m3u8' },
];

console.log('Video limits\n');
assert(MAX_VIDEO_DURATION_MS === 600_000, "Duration ceiling is Bluesky's 10 minutes");
assert(MAX_VIDEO_UPLOAD_BYTES < 300 * 1024 * 1024, 'Size ceiling stays under 300MB');

console.log('\nVariant selection');
{
  // 30s clip: everything fits, best quality first.
  const short = selectVideoVariants(variants, 30_000);
  assert(short.length === 3, 'Non-mp4 variants are filtered out');
  assert(short[0]?.url === 'high.mp4', 'Short clip keeps the highest bitrate first');
  assert(short[2]?.url === 'low.mp4', 'Lower bitrates remain as fallbacks');
}
{
  // 10min at 10.4Mbps ≈ 777MB: too big. 2.2Mbps ≈ 163MB: fits.
  const long = selectVideoVariants(variants, MAX_VIDEO_DURATION_MS);
  assert(long[0]?.url === 'medium.mp4', 'Ten-minute clip drops the oversized top variant');
  assert(
    long.every((v) => v.url !== 'high.mp4'),
    'Variant estimated over the ceiling is not attempted',
  );
  assert(long.length === 2, 'Remaining variants stay available as fallbacks');
}
{
  const none = selectVideoVariants([{ content_type: 'video/mp4', url: 'huge.mp4', bitrate: 50_000_000 }], 600_000);
  assert(none.length === 1 && none[0]?.url === 'huge.mp4', 'Falls back to smallest variant when nothing fits');
}
{
  const unknown = selectVideoVariants([{ content_type: 'video/mp4', url: 'x.mp4' }], 600_000);
  assert(unknown.length === 1, 'Unknown bitrate stays a candidate');
}
{
  const noDuration = selectVideoVariants(variants, 0);
  assert(noDuration.length === 3 && noDuration[0]?.url === 'high.mp4', 'Missing duration keeps all mp4s ranked');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
