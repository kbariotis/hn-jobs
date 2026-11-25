/**
 * Client-side pacing for provider APIs: a shared requests-per-minute limiter plus
 * exponential backoff on 429s. Concurrency alone doesn't bound RPM (fast responses →
 * more requests), so workers acquire a slot before each call.
 */
export class RateLimiter {
  private nextAt = 0;
  constructor(private readonly rpm: number) {}

  /** Resolves when this caller may start a request; slots are spaced 60s/rpm apart. */
  async acquire(): Promise<void> {
    if (!Number.isFinite(this.rpm) || this.rpm <= 0) return;
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + 60_000 / this.rpm;
    if (at > now) await sleep(at - now);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isRateLimited = (e: unknown) => /\b429\b|too many requests|resource_exhausted|rate.?limit/i.test(e instanceof Error ? e.message : String(e));

/** Retry only on rate limiting; other errors surface immediately (they won't fix themselves). */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  { retries = 5, baseMs = 10_000, onRetry }: { retries?: number; baseMs?: number; onRetry?: (attempt: number, waitMs: number) => void } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRateLimited(e) || attempt >= retries) throw e;
      const wait = baseMs * 2 ** attempt * (0.75 + Math.random() / 2); // jitter avoids synchronized retries
      onRetry?.(attempt + 1, wait);
      await sleep(wait);
    }
  }
}
