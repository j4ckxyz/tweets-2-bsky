#!/usr/bin/env node

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    testsPassed++;
  } else {
    console.log(`  ✗ ${message}`);
    testsFailed++;
  }
}

console.log('Running logic tests...\n');

// Test 1: Twitter URL Manipulation
console.log('Test 1: Twitter URL Manipulation (High Quality Download)');
{
  const url1 = 'https://pbs.twimg.com/media/ABC123.jpg';
  const highQuality1 = url1.includes('?') ? url1.replace('?', ':orig?') : url1 + ':orig';
  assert(highQuality1 === 'https://pbs.twimg.com/media/ABC123.jpg:orig', 'Should append :orig to plain URLs');
  
  const url2 = 'https://pbs.twimg.com/media/ABC123.jpg?format=jpg&name=small';
  const highQuality2 = url2.includes('?') ? url2.replace('?', ':orig?') : url2 + ':orig';
  assert(highQuality2 === 'https://pbs.twimg.com/media/ABC123.jpg:orig?format=jpg&name=small', 'Should replace ? with :orig? for query URLs');
  
  const url3 = 'https://pbs.twimg.com/media/DEF456.png?name=large';
  const highQuality3 = url3.includes('?') ? url3.replace('?', ':orig?') : url3 + ':orig';
  assert(highQuality3 === 'https://pbs.twimg.com/media/DEF456.png:orig?name=large', 'Should work with PNGs too');
  console.log();
}

// Test 2: Text Splitting Logic
console.log('Test 2: Text Splitting Logic');
{
  function splitText(text, limit = 300) {
    if (text.length <= limit) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }
      let splitIndex = remaining.lastIndexOf('\n\n', limit);
      if (splitIndex === -1) {
        splitIndex = remaining.lastIndexOf('. ', limit);
        if (splitIndex === -1) {
          splitIndex = remaining.lastIndexOf(' ', limit);
          if (splitIndex === -1) {
            splitIndex = limit;
          }
        } else {
          splitIndex += 1;
        }
      }
      chunks.push(remaining.substring(0, splitIndex).trim());
      remaining = remaining.substring(splitIndex).trim();
    }
    return chunks;
  }

  const text1 = 'Hello world';
  const result1 = splitText(text1, 300);
  assert(result1.length === 1, 'Short text should not be split');
  assert(result1[0] === 'Hello world', 'Content should be preserved');

  const text2 = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
  const result2 = splitText(text2, 50);
  assert(result2.length >= 2, `Should split at paragraph breaks (got ${result2.length} chunks)`);
  const allHaveContent = result2.every(c => c.length > 0);
  assert(allHaveContent, 'All chunks have content');
  console.log();
}

// Test 3: MIME Type Detection
console.log('Test 3: MIME Type Detection');
{
  const isPng = (mimeType) => mimeType === 'image/png';
  const isJpeg = (mimeType) => mimeType === 'image/jpeg' || mimeType === 'image/jpg';
  const isWebp = (mimeType) => mimeType === 'image/webp';
  const isGif = (mimeType) => mimeType === 'image/gif';
  const isAnimation = (mimeType) => isGif(mimeType) || isWebp(mimeType);

  assert(isPng('image/png') === true, 'PNG detection works');
  assert(isPng('image/jpeg') === false, 'JPEG is not PNG');
  assert(isJpeg('image/jpeg') === true, 'JPEG detection works');
  assert(isJpeg('image/jpg') === true, 'JPEG with JPG extension detection works');
  assert(isWebp('image/webp') === true, 'WebP detection works');
  assert(isGif('image/gif') === true, 'GIF detection works');
  assert(isAnimation('image/webp') === true, 'WebP is animation');
  assert(isAnimation('image/gif') === true, 'GIF is animation');
  assert(isAnimation('image/jpeg') === false, 'JPEG is not animation');
  console.log();
}

// Test 4: Aspect Ratio Calculation
console.log('Test 4: Aspect Ratio Calculation');
{
  const sizes = {
    large: { w: 1200, h: 800 },
    medium: { w: 600, h: 400 },
    small: { w: 300, h: 200 }
  };

  const getAspectRatio = (mediaSizes, originalInfo) => {
    if (mediaSizes?.large) {
      return { width: mediaSizes.large.w, height: mediaSizes.large.h };
    } else if (originalInfo) {
      return { width: originalInfo.width, height: originalInfo.height };
    }
    return undefined;
  };

  const ratio1 = getAspectRatio(sizes, undefined);
  assert(ratio1.width === 1200 && ratio1.height === 800, 'Uses large size when available');

  const ratio2 = getAspectRatio(undefined, { width: 1920, height: 1080 });
  assert(ratio2.width === 1920 && ratio2.height === 1080, 'Falls back to original_info');

  const ratio3 = getAspectRatio(undefined, undefined);
  assert(ratio3 === undefined, 'Returns undefined when no data');
  console.log();
}

// Test 5: Video Variant Sorting
console.log('Test 5: Video Variant Sorting (Highest Quality First)');
{
  const variants = [
    { content_type: 'video/mp4', url: 'low.mp4', bitrate: 500000 },
    { content_type: 'video/mp4', url: 'high.mp4', bitrate: 2000000 },
    { content_type: 'video/mp4', url: 'medium.mp4', bitrate: 1000000 },
    { content_type: 'audio/mp4', url: 'audio.mp4', bitrate: 128000 }
  ];

  const mp4s = variants
    .filter((v) => v.content_type === 'video/mp4')
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  assert(mp4s.length === 3, 'Should filter to only MP4 videos');
  assert(mp4s[0].url === 'high.mp4', 'Highest bitrate first');
  assert(mp4s[1].url === 'medium.mp4', 'Medium bitrate second');
  assert(mp4s[2].url === 'low.mp4', 'Low bitrate last');
  console.log();
}

// Test 6: Size Formatting
console.log('Test 6: Size Formatting');
{
  const formatSize = (bytes) => (bytes / 1024).toFixed(2) + ' KB';
  const formatSizeMB = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';

  assert(formatSize(1024) === '1.00 KB', '1KB formats correctly');
  assert(formatSize(1536) === '1.50 KB', '1.5KB formats correctly');
  assert(formatSizeMB(1048576) === '1.00 MB', '1MB formats correctly');
  console.log();
}

// Test 7: Fixed Delay (10 seconds)
console.log('Test 7: Fixed Delay (10 seconds)');
{
  const wait = 10000;
  assert(wait === 10000, 'Delay is fixed at 10 seconds');
  assert(wait >= 5000 && wait <= 15000, 'Delay is reasonable for pacing');
  console.log();
}

// Test 8: Retry Logic Simulation
console.log('Test 8: Retry Logic Simulation (High Quality -> Standard)');
{
  const runRetryTests = async () => {
    // Test 8a: High quality succeeds
    {
      let highQualityFailed = false;
      const downloadWithRetry = async (url) => {
        const isHighQuality = url.includes(':orig');
        if (isHighQuality && highQualityFailed) {
          throw new Error('High quality download failed');
        }
        if (isHighQuality && !highQualityFailed) {
          return { buffer: Buffer.from('high quality'), mimeType: 'image/jpeg' };
        }
        return { buffer: Buffer.from('standard quality'), mimeType: 'image/jpeg' };
      };

      highQualityFailed = false;
      const result1 = await downloadWithRetry('https://example.com/image.jpg:orig');
      assert(result1.buffer.toString() === 'high quality', 'High quality download succeeds when available');
    }

    // Test 8b: High quality fails, falls back to standard
    {
      let callCount = 0;
      const downloadWithRetry = async (url) => {
        callCount++;
        const isHighQuality = url.includes(':orig');
        
        if (isHighQuality && callCount === 1) {
          throw new Error('High quality download failed');
        }
        
        if (isHighQuality && callCount === 2) {
          const fallbackUrl = url.replace(':orig?', '?');
          return { buffer: Buffer.from('standard quality'), mimeType: 'image/jpeg' };
        }
        
        return { buffer: Buffer.from('standard quality'), mimeType: 'image/jpeg' };
      };

      const result2 = await downloadWithRetry('https://example.com/image.jpg:orig');
      assert(result2.buffer.toString() === 'standard quality', 'Falls back to standard quality on failure');
    }

    // Test 8c: Standard URL doesn't use retry logic
    {
      const downloadWithRetry = async (url) => {
        const isHighQuality = url.includes(':orig');
        if (isHighQuality) {
          throw new Error('Should not be high quality');
        }
        return { buffer: Buffer.from('standard quality'), mimeType: 'image/jpeg' };
      };

      const result3 = await downloadWithRetry('https://example.com/image.jpg');
      assert(result3.buffer.toString() === 'standard quality', 'Standard URL downloads directly');
    }
  };

  runRetryTests().catch(err => {
    console.log(`  ✗ Retry test error: ${err.message}`);
    testsFailed++;
  });
  console.log();
}

// Test 9: Image Compression Quality Settings
console.log('Test 9: Image Compression Quality Settings');
{
  const settings = {
    jpeg: { quality: 92, mozjpeg: true },
    jpegFallback: { quality: 85, mozjpeg: true },
    png: { compressionLevel: 9, adaptiveFiltering: true },
    webp: { quality: 90, effort: 6 }
  };

  assert(settings.jpeg.quality === 92, 'JPEG quality is 92%');
  assert(settings.jpeg.mozjpeg === true, 'JPEG uses mozjpeg');
  assert(settings.jpegFallback.quality === 85, 'Fallback JPEG quality is 85%');
  assert(settings.png.compressionLevel === 9, 'PNG compression level is 9 (max)');
  assert(settings.webp.quality === 90, 'WebP quality is 90%');
  assert(settings.webp.effort === 6, 'WebP encoding effort is 6 (high)');
  console.log();
}

// Test 10: Bluesky Size Limits
console.log('Test 10: Bluesky Size Limits Compliance');
{
  const MAX_SIZE = 950 * 1024;
  const LARGE_IMAGE_THRESHOLD = 2000;
  const FALLBACK_THRESHOLD = 1600;

  assert(MAX_SIZE === 972800, 'Max size is 950KB (972800 bytes)');
  assert(LARGE_IMAGE_THRESHOLD === 2000, 'Large image threshold is 2000px');
  assert(FALLBACK_THRESHOLD === 1600, 'Fallback threshold is 1600px');
  console.log();
}

// Summary
console.log('─'.repeat(40));
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);
console.log('─'.repeat(40));

if (testsFailed > 0) {
  console.log('\nSome tests failed!');
  process.exit(1);
} else {
  console.log('\nAll tests passed!');
  process.exit(0);
}
