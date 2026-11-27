import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { createHash } from "crypto";
import path from "path";
import { cleanQuery } from "../util/safe";
import { isRateLimited } from "../util/rate";
import type { SearchResponse } from "../search/search-service";
import type { Cache, Limiter } from "./limits";

/**
 * Public search page + JSON API, host-agnostic: the same app runs under `node` (local, VPS)
 * and as a Vercel function. Hosts only choose the dependencies.
 *   GET /                  page (public/)
 *   GET /api/search?q=…    filtered search over the current thread
 *   GET /healthz          liveness (no dependencies)
 *   GET /readyz           readiness: each dependency as a boolean, no LLM calls
 *
 * Order per search: per-client limit → result cache → global cap on cache misses → search.
 * Rejected and cached requests never reach the database or an LLM.
 */
export type AppDeps = {
  searchJobs: (q: string, threadId: number) => Promise<SearchResponse>;
  currentThreadId: () => Promise<number>;
  perClient: Limiter;
  /** Global cap on cache misses: each miss costs an LLM parse + an embedding. */
  misses: Limiter;
  cache: Cache;
  cacheTtlS?: number;
  /** Express "trust proxy": only when a proxy we control sets X-Forwarded-For. */
  trustProxy?: boolean | number;
  publicDir?: string;
  log?: (e: unknown) => void;
  /** Dependency checks for /readyz. Must not call an LLM (no cost per probe). */
  readiness?: Readiness;
};

export type Readiness = () => Promise<{ database: boolean; cache: boolean; llmKey: boolean }>;

/**
 * No inline script/style, no third-party anything: post content can't execute even if it slips
 * through. Exact list (no helmet defaults merged in). Static pages served by a CDN instead of
 * Express (Vercel) get the same policy from vercel.json; a test keeps the two identical.
 */
export const CSP_DIRECTIVES = {
  defaultSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  connectSrc: ["'self'"],
  imgSrc: ["'self'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};

// Queries are user text: keep them out of cache keys (and so out of Redis key listings).
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

export function createApp({
  searchJobs,
  currentThreadId,
  perClient,
  misses,
  cache,
  cacheTtlS = 600,
  trustProxy = false,
  publicDir = path.join(__dirname, "..", "..", "public"),
  log = console.error,
  readiness,
}: AppDeps) {
  const app = express();
  app.set("trust proxy", trustProxy);
  // CSP, HSTS, nosniff, no-referrer, COOP/CORP, frame denial; also drops X-Powered-By.
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );

  // Identical concurrent queries on one instance share one call.
  const inflight = new Map<string, Promise<SearchResponse>>();

  // A cache outage degrades to "miss", never to an error page.
  const cacheGet = async <T>(key: string) => {
    try {
      return await cache.get<T>(key);
    } catch (e) {
      log(e);
      return undefined;
    }
  };
  const cacheSet = async (key: string, value: unknown, ttlS: number) => {
    try {
      await cache.set(key, value, ttlS);
    } catch (e) {
      log(e);
    }
  };

  const threadId = async () => {
    const hit = await cacheGet<number>("thread:current");
    if (hit !== undefined) {
      return hit;
    }
    const id = await currentThreadId();
    await cacheSet("thread:current", id, 60); // a new month's thread shows up within a minute
    return id;
  };

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Allow", "GET, HEAD");
      return void res.status(405).json({ error: "Method not allowed" });
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ ok: true });
  });

  // Booleans only: says which dependency is down, never why (no hosts, errors or env values).
  // Rate-limited like search, since each probe wakes the database.
  app.get("/readyz", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!readiness) {
      return void res.status(404).json({ error: "Not found" });
    }
    const limit = await perClient.take(req.ip ?? "unknown");
    if (!limit.ok) {
      res.set("Retry-After", String(limit.retryAfterS));
      return void res.status(429).json({ error: "Too many requests." });
    }
    const r = await readiness();
    const ready = r.database && r.cache && r.llmKey;
    res
      .status(ready ? 200 : 503)
      .json({ ready, database: r.database, cache: r.cache, llmKey: r.llmKey });
  });

  app.get("/api/search", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const client = req.ip ?? "unknown";
    const limit = await perClient.take(client);
    if (!limit.ok) {
      res.set("Retry-After", String(limit.retryAfterS));
      return void res.status(429).json({ error: "Too many searches. Try again shortly." });
    }

    const q = cleanQuery(typeof req.query.q === "string" ? req.query.q : null);
    if (!q) {
      return void res.status(400).json({ error: "Enter a search between 2 and 200 characters." });
    }

    const thread = await threadId();
    const key = `search:${thread}:${hash(q.toLowerCase())}`;
    const cached = await cacheGet<SearchResponse>(key);
    if (cached) {
      return void res.set("X-Cache", "hit").json(cached);
    }

    let pending = inflight.get(key);
    if (!pending) {
      // Spend guard: misses are the only requests that cost money.
      if (!(await misses.take("global")).ok) {
        res.set("Retry-After", "30");
        return void res
          .status(503)
          .json({ error: "Search is busy right now. Try again in a minute." });
      }
      pending = searchJobs(q, thread).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const result = await pending;
    if (!result.degraded) {
      await cacheSet(key, result, cacheTtlS); // don't pin a fallback answer for the whole TTL
    }
    res.set("X-Cache", "miss").json(result);
  });

  app.use(
    express.static(publicDir, {
      index: "index.html",
      setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Log details server-side. Clients get a generic message (no stack traces, SQL or provider
  // errors). Express 5 routes rejected promises from async handlers here.
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log(e);
    if (res.headersSent) {
      return;
    }
    // Provider quota/rate limit: temporary, so say "busy" (and when to retry), not "broken".
    if (isRateLimited(e)) {
      res.set("Retry-After", "60");
      return void res.status(503).json({ error: "Search is busy right now. Try again later." });
    }
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}
