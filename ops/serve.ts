import "dotenv/config";

import { createApp } from "../lib/web/app";
import { limitsFromEnv } from "../lib/web/limits";
import { currentThreadId, searchJobs } from "../lib/search/search-service";

/**
 * Search server on plain Node (local dev, or a VPS behind a reverse proxy). See lib/web/app.ts.
 *
 * Binds 127.0.0.1 by default. Set HOST=0.0.0.0 only behind a reverse proxy, and TRUST_PROXY=1
 * only if that proxy sets X-Forwarded-For (otherwise clients could spoof their rate-limit key).
 * Limits use Upstash when UPSTASH_REDIS_REST_URL/TOKEN are set, in-memory otherwise.
 */
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);

const { backend, ...limits } = limitsFromEnv();
const app = createApp({
  ...limits,
  searchJobs: (q, threadId) => searchJobs(q, { threadId }),
  currentThreadId,
  cacheTtlS: Number(process.env.SEARCH_CACHE_TTL_S ?? 600),
  trustProxy: process.env.TRUST_PROXY === "1" ? 1 : false,
});

const server = app.listen(PORT, HOST, () =>
  console.log(`Search on http://${HOST}:${PORT} (limits: ${backend})`),
);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
