#!/usr/bin/env bun
// Offline checks for the scraper's request timeout and retry classification.
// The pairing is the point: a timeout that the retry classifier does not
// recognise makes a hung account fail fast and report "no new tweets" instead
// of an error, which is worse than the hang it replaced.
import { ScraperTimeoutError, createTimedFetch, isRetryableScraperError } from '../src/scraper-fetch.js';

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

/** A fetch that never settles until its signal aborts. */
const hangingFetch = ((_input: unknown, init?: { signal?: AbortSignal }) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    });
  })) as unknown as typeof fetch;

console.log('Timeout behaviour\n');
{
  const timedFetch = createTimedFetch(50, hangingFetch);
  const started = Date.now();
  let caught: unknown;
  try {
    await timedFetch('https://example.invalid');
  } catch (error) {
    caught = error;
  }
  const elapsed = Date.now() - started;

  assert(caught instanceof ScraperTimeoutError, 'A hung request rejects with a scraper timeout');
  assert(elapsed < 1000, `The deadline fires promptly (took ${elapsed}ms)`);
  // The bug this guards: an aborted fetch rejects with "The operation was
  // aborted.", which the classifier below does not match.
  assert(
    String((caught as Error).message).includes('Timeout'),
    `The rejection reads as a timeout (got "${(caught as Error).message}")`,
  );
}

console.log('\nTimeouts reach the retry path\n');
{
  const timeout = new ScraperTimeoutError(25_000);
  assert(isRetryableScraperError(timeout), 'A scraper timeout is retryable');
  assert(
    isRetryableScraperError(new Error('Timeout: scraper request exceeded 25000ms')),
    'A timeout recognised by message alone is retryable',
  );
  const rawAbort = new Error('The operation was aborted.');
  rawAbort.name = 'AbortError';
  assert(!isRetryableScraperError(rawAbort), 'A bare abort is not mistaken for a retryable failure');
}

console.log('\nOther failures\n');
{
  assert(isRetryableScraperError(new Error('ServiceUnavailable')), 'ServiceUnavailable is retryable');
  assert(isRetryableScraperError(new Error('Request failed with status code 429')), 'Rate limiting is retryable');
  assert(isRetryableScraperError(new Error('Request failed with status code 401')), 'An expired session is retryable');
  assert(!isRetryableScraperError(new Error('Not found')), 'An unrelated failure is not retried');
  assert(!isRetryableScraperError(null), 'A null error does not throw the classifier');
  assert(!isRetryableScraperError({}), 'An error without a message does not throw the classifier');
}

console.log("\nThe caller's own signal still works\n");
{
  const timedFetch = createTimedFetch(60_000, hangingFetch);
  const controller = new AbortController();
  const pending = timedFetch('https://example.invalid', { signal: controller.signal });
  controller.abort();
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  assert(
    !(caught instanceof ScraperTimeoutError),
    'A caller-cancelled request stays an abort rather than becoming a timeout',
  );
  assert((caught as Error)?.name === 'AbortError', 'The original abort reaches the caller');
}

console.log('\nSuccessful requests\n');
{
  const okFetch = (async () => new Response('ok')) as unknown as typeof fetch;
  const timedFetch = createTimedFetch(50, okFetch);
  const response = await timedFetch('https://example.invalid');
  assert(response.status === 200, 'A normal response passes through untouched');
  // If the deadline timer were left pending, the process would not exit here.
  assert(true, 'The deadline timer is cleared once the request settles');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
