#!/usr/bin/env bun
// Offline checks for rate-limit handling in sweep checks. X answers an
// exhausted login with HTTP 429; the scraper library's default strategy then
// sleeps until the reset (up to 15 minutes), which outlived the sweep's 180s
// watchdog. Sweep sessions use throwOnRateLimit instead, which must fail at
// once, carry the reset time, and never count as a retryable error.
import { Scraper } from '@the-convocation/twitter-scraper';
import {
  RATE_LIMIT_FALLBACK_PAUSE_MS,
  TwitterRateLimitedError,
  isRetryableScraperError,
  rateLimitResetAt,
  throwOnRateLimit,
} from '../src/scraper-fetch.js';

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

const headers = (values: Record<string, string>) => new Headers(values);
const NOW = 1_800_000_000_000;

console.log('Reading the reset time\n');
{
  const inTenMinutes = NOW + 10 * 60_000;
  assert(
    rateLimitResetAt(headers({ 'x-rate-limit-reset': String(inTenMinutes / 1000) }), NOW) === inTenMinutes,
    'uses x-rate-limit-reset (epoch seconds) when it is in the near future',
  );
  assert(
    rateLimitResetAt(headers({}), NOW) === NOW + RATE_LIMIT_FALLBACK_PAUSE_MS,
    'falls back to one 15-minute window without the header',
  );
  assert(
    rateLimitResetAt(headers({ 'x-rate-limit-reset': String((NOW - 60_000) / 1000) }), NOW) ===
      NOW + RATE_LIMIT_FALLBACK_PAUSE_MS,
    'a reset time in the past falls back to a full window',
  );
  assert(
    rateLimitResetAt(headers({ 'x-rate-limit-reset': String((NOW + 5 * 3600_000) / 1000) }), NOW) ===
      NOW + RATE_LIMIT_FALLBACK_PAUSE_MS,
    'a reset hours away is treated as bogus',
  );
  assert(
    rateLimitResetAt(headers({ 'x-rate-limit-reset': 'soon' }), NOW) === NOW + RATE_LIMIT_FALLBACK_PAUSE_MS,
    'garbage falls back',
  );
}

console.log('\nThe error\n');
{
  const error = new TwitterRateLimitedError(NOW + 7 * 60_000, NOW);
  assert(error.resetAt === NOW + 7 * 60_000, 'carries the reset time');
  assert(/429/.test(error.message) && /7 min/.test(error.message), `says what happened: "${error.message}"`);
  assert(!isRetryableScraperError(error), 'is not retried on the same login (it would only hit the limit again)');
}

console.log('\nThe real scraper library against a 429\n');
{
  let requests = 0;
  const reset = Math.floor(Date.now() / 1000) + 600;
  const rateLimitedFetch = (async () => {
    requests++;
    return new Response('{"errors":[{"message":"Rate limit exceeded","code":88}]}', {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': String(reset),
      },
    });
  }) as unknown as typeof fetch;

  const scraper = new Scraper({ fetch: rateLimitedFetch, rateLimitStrategy: throwOnRateLimit });
  await scraper.setCookies(['auth_token=test', 'ct0=test']);
  const started = Date.now();
  let caught: unknown;
  try {
    for await (const _tweet of scraper.getTweets('someone', 5)) {
      // never reached
    }
  } catch (error) {
    caught = error;
  }
  const elapsed = Date.now() - started;
  assert(
    caught instanceof TwitterRateLimitedError,
    `the timeline fetch fails with TwitterRateLimitedError (got ${(caught as Error)?.name})`,
  );
  assert(elapsed < 5_000, `it fails at once instead of sleeping until the reset (${elapsed}ms)`);
  assert(requests <= 2, `it does not retry in a loop (${requests} request(s))`);
  assert(
    caught instanceof TwitterRateLimitedError && Math.abs(caught.resetAt - reset * 1000) < 1000,
    'the reset time comes from the response',
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
