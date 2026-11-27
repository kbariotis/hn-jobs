import { createApp } from "../lib/web/app";
import { limitsFromEnv } from "../lib/web/limits";
import { currentThreadId, searchJobs } from "../lib/search/search-service";

/**
 * Vercel Function: the whole Express app as one function. A plain `api/` function is built
 * regardless of framework detection or custom build commands (Express auto-detection is
 * skipped when package.json has `vercel-build`). vercel.json rewrites the app's routes here;
 * Express still sees the original path. Env comes from the Vercel project. Local/VPS runs use
 * ops/serve.ts instead, with the same app.
 *
 * - Limits: Upstash only; limitsFromEnv refuses in-memory limits on Vercel.
 * - trust proxy = 1: Vercel overwrites X-Forwarded-For with the client IP (no spoofed hops),
 *   so req.ip is the real client for per-client rate limiting.
 * - Static files in public/ are served by Vercel's CDN, not Express: their security headers
 *   come from vercel.json.
 */
const SEARCH_CACHE_TTL_S = Number(process.env.SEARCH_CACHE_TTL_S ?? 600);

const { perClient, misses, cache } = limitsFromEnv();

export default createApp({
  perClient,
  misses,
  cache,
  searchJobs: (q, threadId) => searchJobs(q, { threadId }),
  currentThreadId,
  cacheTtlS: SEARCH_CACHE_TTL_S,
  trustProxy: 1,
});
