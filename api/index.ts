import type { IncomingMessage, ServerResponse } from "http";
// Starts registering OpenTelemetry (Vercel Tracing) as soon as the function loads.
import { telemetryReady } from "../lib/telemetry/register";
import { createApp, type Readiness } from "../lib/web/app";
import { db } from "../lib/store/db";
import { limitsFromEnv } from "../lib/web/limits";
import { failureCategory, type FailureCategory } from "../lib/web/readiness";
import { currentThreadIds, searchJobs } from "../lib/search/search-service";

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
const HAS_LLM_KEY = Boolean(process.env.GOOGLE_API_KEY);

const { perClient, misses, cache } = limitsFromEnv();

// Each check is reduced to a boolean plus a fixed category; details are logged server-side only.
const check = async (
  name: string,
  fn: () => Promise<unknown>,
): Promise<{ ok: boolean; category: FailureCategory | null }> => {
  try {
    await fn();
    return { ok: true, category: null };
  } catch (err) {
    console.error(`readiness: ${name} failed:`, err instanceof Error ? err.message : err);
    return { ok: false, category: failureCategory(err) };
  }
};
const readiness: Readiness = async () => {
  const database = await check("database", () => db().query("SELECT max(thread_id) FROM roles"));
  const cacheCheck = await check("cache", () => cache.get("readyz"));
  return {
    database: database.ok,
    databaseError: database.category,
    cache: cacheCheck.ok,
    llmKey: HAS_LLM_KEY,
  };
};

const app = createApp({
  perClient,
  misses,
  cache,
  searchJobs: (q, threadIds) => searchJobs(q, { threadIds }),
  currentThreadIds,
  cacheTtlS: SEARCH_CACHE_TTL_S,
  trustProxy: 1,
  readiness,
});

// Wait for tracing registration (a few ms, once per cold start) so every request is traced.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await telemetryReady;
  return app(req, res);
}
