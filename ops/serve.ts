import "dotenv/config";

import http from "http";
import fs from "fs/promises";
import path from "path";
import { TtlCache } from "../lib/util/cache";
import { KeyedTokenBucket } from "../lib/util/rate";
import { cleanQuery } from "../lib/util/safe";
import { currentThreadId, searchJobs, type SearchResponse } from "../lib/search/search-service";

/**
 * Public search page + JSON API. Read-only.
 *   GET /                  page (public/)
 *   GET /api/search?q=…    filtered search over the current thread
 *   GET /healthz
 *
 * Controls (all in-memory, single instance):
 *   - per-client rate limit (SEARCH_RPM, burst SEARCH_BURST)
 *   - global cap on cache misses (SEARCH_MISS_RPM): each miss costs an LLM parse + an embedding
 *   - result cache keyed by normalized query (SEARCH_CACHE_TTL_S, SEARCH_CACHE_MAX)
 *
 * Binds 127.0.0.1 by default. Set HOST=0.0.0.0 only behind a reverse proxy, and TRUST_PROXY=1
 * only if that proxy sets X-Forwarded-For (otherwise clients could spoof their rate-limit key).
 */
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const num = (name: string, dflt: number) => Number(process.env[name] ?? dflt);

const perClient = new KeyedTokenBucket(num("SEARCH_RPM", 20), num("SEARCH_BURST", 10));
const misses = new KeyedTokenBucket(num("SEARCH_MISS_RPM", 60), num("SEARCH_MISS_RPM", 60));
const cache = new TtlCache<SearchResponse>(
  num("SEARCH_CACHE_MAX", 1000),
  num("SEARCH_CACHE_TTL_S", 600) * 1000,
);
// Identical concurrent queries share one call.
const inflight = new Map<string, Promise<SearchResponse>>();
const thread = new TtlCache<number>(1, 60_000); // re-check the current thread every minute

const PUBLIC = path.join(__dirname, "..", "public");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const SECURITY_HEADERS = {
  // No inline script/style, no third-party anything:
  // post content can't execute even if it slips through.
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
};

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function clientKey(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] ?? "")
      .split(",")[0]
      .trim();
    if (xff) {
      return xff;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function getThreadId(): Promise<number> {
  const hit = thread.get("current");
  if (hit !== undefined) {
    return hit;
  }
  const id = await currentThreadId();
  thread.set("current", id);
  return id;
}

async function handleSearch(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const key = clientKey(req);
  if (!perClient.take(key)) {
    return send(
      res,
      429,
      { error: "Too many searches. Try again shortly." },
      { "Retry-After": String(perClient.retryAfter(key)) },
    );
  }

  const q = cleanQuery(url.searchParams.get("q"));
  if (!q) {
    return send(res, 400, { error: "Enter a search between 2 and 200 characters." });
  }

  const threadId = await getThreadId();
  const cacheKey = `${threadId}|${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return send(res, 200, cached, { "X-Cache": "hit" });
  }

  let pending = inflight.get(cacheKey);
  if (!pending) {
    // Spend guard: misses are the only requests that cost money.
    if (!misses.take("global")) {
      return send(
        res,
        503,
        { error: "Search is busy right now. Try again in a minute." },
        { "Retry-After": "30" },
      );
    }
    pending = searchJobs(q, { threadId }).finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, pending);
  }
  const result = await pending;
  if (!result.degraded) {
    cache.set(cacheKey, result);
  } // don't pin a fallback answer for the whole TTL
  return send(res, 200, result, { "X-Cache": "miss" });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { error: "Method not allowed" }, { Allow: "GET, HEAD" });
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/search") {
      return await handleSearch(req, res, url);
    }
    if (url.pathname === "/healthz") {
      return send(res, 200, { ok: true });
    }
    const file = STATIC[url.pathname];
    if (!file) {
      return send(res, 404, { error: "Not found" });
    }
    const body = await fs.readFile(path.join(PUBLIC, file));
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": TYPES[path.extname(file)],
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (e) {
    // Log details server-side. Clients get a generic message
    // (no stack traces, SQL or provider errors).
    console.error(e);
    if (!res.headersSent) {
      send(res, 500, { error: "Something went wrong. Please try again." });
    }
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(PORT, HOST, () => console.log(`Search on http://${HOST}:${PORT}`));
