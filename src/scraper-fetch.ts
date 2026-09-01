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
