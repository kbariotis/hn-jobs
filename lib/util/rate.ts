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

export const isRateLimited = (e: unknown) =>
  /\b429\b|too many requests|resource_exhausted|rate.?limit/i.test(e instanceof Error ? e.message : String(e));

/** Retry only on rate limiting; other errors surface immediately (they won't fix themselves). */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  {
    retries = 5,
    baseMs = 10_000,
    onRetry,
  }: { retries?: number; baseMs?: number; onRetry?: (attempt: number, waitMs: number) => void } = {},
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

/**
 * Token bucket per key (client IP, or "global"). `perMinute` sustained, `burst` short-term.
 * Idle buckets are swept so the map can't grow without bound.
 */
export class KeyedTokenBucket {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private lastSweep = Date.now();
  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** true if allowed (and consumes a token). */
  take(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    if (this.buckets.size < this.maxKeys || this.buckets.has(key)) this.buckets.set(key, b);
    return ok;
  }

  /** Seconds until the next token for `key` (for Retry-After). */
  retryAfter(key: string): number {
    const b = this.buckets.get(key);
    return b ? Math.max(1, Math.ceil(((1 - b.tokens) / this.perMinute) * 60)) : 1;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const fullAfter = (this.burst / this.perMinute) * 60_000;
    for (const [k, b] of this.buckets) if (now - b.at > fullAfter) this.buckets.delete(k);
  }
}
