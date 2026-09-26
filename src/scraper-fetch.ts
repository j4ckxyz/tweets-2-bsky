// The scraper's HTTP layer.
//
// The underlying library has no per-request timeout, so a stuck request used to
// hang until the sweep's 180s watchdog killed it, stalling a concurrency slot
// the whole time. A timeout alone is not enough though: an aborted fetch
// rejects with "The operation was aborted.", which does not match the retry
// classifier below — so a timed-out account would fail fast, skip its retries
// and report "no new tweets" rather than an error. The timeout therefore
// rejects with its own message, and the classifier is shared with the caller so
// the two cannot drift apart again.

/** Marker used so a timeout is recognisable by class as well as by message. */
export class ScraperTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Timeout: scraper request exceeded ${timeoutMs}ms`);
    this.name = 'ScraperTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Wrap fetch with a per-request deadline. A caller-supplied signal still
 * aborts the request — the deadline is additional, not a replacement.
 */
export function createTimedFetch(timeoutMs: number, fetchImpl: typeof fetch = fetch): typeof fetch {
  return function timedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    // Chaining rather than overwriting: dropping the caller's signal would make
    // the request outlive whatever the caller uses to cancel it.
    const callerSignal = init?.signal;
    const abortFromCaller = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    }

    return fetchImpl(input, { ...init, signal: controller.signal })
      .catch((error: unknown) => {
        // Only our own deadline becomes a timeout; a caller-driven abort stays
        // an abort so cancellation is not mistaken for a retryable failure.
        if (timedOut && !callerSignal?.aborted) throw new ScraperTimeoutError(timeoutMs);
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', abortFromCaller);
      });
  };
}

export interface RateLimiterOptions {
  minGapMs: number;
  jitterMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Global spacing between requests to Twitter. Each call reserves the next free
 * slot (minimum gap plus random jitter after the previous one) and waits for
 * it, so any number of concurrent callers still reach Twitter one gap apart.
 */
export function createRateLimiter(options: RateLimiterOptions): () => Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  let nextSlotMs = 0;
  return async function acquire(): Promise<void> {
    const gap = options.minGapMs + Math.floor(random() * (options.jitterMs + 1));
    const current = now();
    const slot = Math.max(current, nextSlotMs);
    nextSlotMs = slot + gap;
    if (slot > current) {
      await sleep(slot - current);
    }
  };
}

/**
 * Gate every HTTP request the scraper makes behind the rate limiter. Gating
 * the scraper's own fetch, rather than each logical call site, is what makes
 * the gap hold per request: one timeline fetch is a user-id lookup plus one or
 * more pages, and each of those is a separate hit against the account's limits.
 * The slot is taken before the timed fetch starts, so waiting for it never
 * counts against the request deadline.
 */
export function createGatedFetch(acquire: () => Promise<void>, fetchImpl: typeof fetch = fetch): typeof fetch {
  return async function gatedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
    await acquire();
    return fetchImpl(input, init);
  } as typeof fetch;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (Number.isFinite(raw)) return Math.min(max, Math.max(min, Math.round(raw)));
  return fallback;
}

// Minimum spacing between Twitter API requests across the whole process, plus
// random jitter. This is the single knob that controls scraper-account risk.
export const SCRAPER_MIN_GAP_MS = envInt('SCRAPER_MIN_GAP_MS', 800, 0, 60_000);
export const SCRAPER_JITTER_MS = envInt('SCRAPER_JITTER_MS', 400, 0, 60_000);
export const SCRAPER_REQUEST_TIMEOUT_MS = envInt('SCRAPER_REQUEST_TIMEOUT_MS', 25_000, 5_000, 120_000);

/** The one limiter every Twitter request in the process shares. */
export const acquireScraperSlot = createRateLimiter({ minGapMs: SCRAPER_MIN_GAP_MS, jitterMs: SCRAPER_JITTER_MS });

/** Fetch for `new Scraper({ fetch })`: rate limited and with a per-request deadline. */
export function createScraperFetch(): typeof fetch {
  return createGatedFetch(acquireScraperSlot, createTimedFetch(SCRAPER_REQUEST_TIMEOUT_MS));
}

/**
 * Whether a scraper failure is worth retrying (and worth switching credentials
 * for). Kept beside the timeout that produces one of these so a change to
 * either stays honest about the other.
 */
export function isRetryableScraperError(error: unknown): boolean {
  if (error instanceof ScraperTimeoutError) return true;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return false;
  return (
    message.includes('ServiceUnavailable') ||
    message.includes('Timeout') ||
    message.includes('timeout') ||
    message.includes('429') ||
    message.includes('401')
  );
}
