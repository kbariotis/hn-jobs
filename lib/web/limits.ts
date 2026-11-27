import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { KeyedTokenBucket } from "../util/rate";
import { TtlCache } from "../util/cache";

/**
 * Rate limiting and caching for the search API. Upstash (Redis over HTTP) works on every host,
 * serverless or VPS; the in-memory versions are for local dev and tests only, because each
 * serverless instance would get its own counters.
 */
export type Limiter = { take(key: string): Promise<{ ok: boolean; retryAfterS: number }> };
export type Cache = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlS: number): Promise<void>;
};

export function memoryLimiter(perMinute: number, burst: number): Limiter {
  const bucket = new KeyedTokenBucket(perMinute, burst);
  return {
    take: async (key) => {
      const ok = bucket.take(key);
      return { ok, retryAfterS: ok ? 0 : bucket.retryAfter(key) };
    },
  };
}

export function memoryCache(maxEntries = 1000): Cache {
  const cache = new TtlCache<unknown>(maxEntries, 60_000);
  return {
    get: async <T>(key: string) => cache.get(key) as T | undefined,
    set: async (key, value, ttlS) => cache.set(key, value, ttlS * 1000),
  };
}

export function upstashLimiter(
  redis: Redis,
  perMinute: number,
  burst: number,
  prefix: string,
): Limiter {
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.tokenBucket(perMinute, "60 s", burst),
    prefix: `hnjobs:rl:${prefix}`,
  });
  return {
    take: async (key) => {
      const r = await rl.limit(key);
      return { ok: r.success, retryAfterS: Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)) };
    },
  };
}

/** Fixed daily budget per key (resets every 24 h window), e.g. total uncached searches per day. */
export function upstashDailyLimiter(redis: Redis, perDay: number, prefix: string): Limiter {
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(perDay, "1 d"),
    prefix: `hnjobs:rl:${prefix}`,
  });
  return {
    take: async (key) => {
      const r = await rl.limit(key);
      return { ok: r.success, retryAfterS: Math.max(1, Math.ceil((r.reset - Date.now()) / 1000)) };
    },
  };
}

/** In-memory approximation of a daily budget: a bucket of `perDay` that refills over 24 h. */
export const memoryDailyLimiter = (perDay: number): Limiter =>
  memoryLimiter(perDay / (24 * 60), perDay);

/**
 * Passes only if every limiter passes; stops at the first refusal and reports its retry time.
 * Order cheapest/most-likely-to-refuse first.
 */
export function allOf(...limiters: Limiter[]): Limiter {
  return {
    take: async (key) => {
      for (const l of limiters) {
        const r = await l.take(key);
        if (!r.ok) {
          return r;
        }
      }
      return { ok: true, retryAfterS: 0 };
    },
  };
}

export function upstashCache(redis: Redis): Cache {
  return {
    get: async <T>(key: string) => (await redis.get<T>(`hnjobs:c:${key}`)) ?? undefined,
    set: async (key, value, ttlS) => {
      await redis.set(`hnjobs:c:${key}`, value, { ex: Math.max(1, Math.round(ttlS)) });
    },
  };
}

/**
 * Redis REST URL + read-write token under any of the names integrations use: Upstash's own,
 * Vercel KV's, or the Vercel marketplace integration with the "REDIS" prefix this project uses.
 * Never the *_READ_ONLY_TOKEN: rate limiting writes.
 */
export function redisRestEnv(env = process.env): { url: string; token: string } | null {
  for (const p of ["UPSTASH_REDIS_REST", "KV_REST_API", "REDIS_KV_REST_API"]) {
    const url = env[`${p}_URL`];
    const token = env[`${p}_TOKEN`];
    if (url && token) {
      return { url, token };
    }
  }
  return null;
}

export type Limits = { perClient: Limiter; misses: Limiter; cache: Cache; backend: string };

/**
 * Upstash when Redis REST credentials are set (see redisRestEnv), memory otherwise. On a
 * serverless host memory limits would silently not work, so there it's an error, not a fallback.
 *
 * `misses` guards spend (each cache miss = a Gemini parse + embedding, from any number of IPs):
 * SEARCH_MISS_RPM per minute AND SEARCH_MISS_PER_DAY per day, across all clients.
 */
export function limitsFromEnv(env = process.env): Limits {
  // Positive numbers only: a typo must not disable a limit (NaN) or set it to zero.
  const num = (name: string, dflt: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  const rpm = num("SEARCH_RPM", 20);
  const burst = num("SEARCH_BURST", 10);
  const missRpm = num("SEARCH_MISS_RPM", 10);
  const missPerDay = num("SEARCH_MISS_PER_DAY", 2000);
  const rest = redisRestEnv(env);
  if (rest) {
    const redis = new Redis(rest);
    return {
      perClient: upstashLimiter(redis, rpm, burst, "client"),
      misses: allOf(
        upstashLimiter(redis, missRpm, missRpm, "miss"),
        upstashDailyLimiter(redis, missPerDay, "miss-day"),
      ),
      cache: upstashCache(redis),
      backend: "upstash",
    };
  }
  if (env.VERCEL) {
    throw new Error(
      "Redis REST credentials are required on Vercel (memory limits are per instance).",
    );
  }
  return {
    perClient: memoryLimiter(rpm, burst),
    misses: allOf(memoryLimiter(missRpm, missRpm), memoryDailyLimiter(missPerDay)),
    cache: memoryCache(num("SEARCH_CACHE_MAX", 1000)),
    backend: "memory",
  };
}
