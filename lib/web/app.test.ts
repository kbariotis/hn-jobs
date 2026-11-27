import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import fs from "fs";
import path from "path";
import { createApp, type AppDeps } from "./app";
import { memoryCache, memoryLimiter, type Cache } from "./limits";
import type { SearchResponse } from "../search/search-service";

const response = (query: string, degraded = false): SearchResponse => ({
  query,
  thread_id: 7,
  filters: null,
  degraded,
  results: [],
});

/** Start the app on a random port with fakes; returns a GET helper and the call log. */
async function start(over: Partial<AppDeps> = {}) {
  const calls: string[] = [];
  const app = createApp({
    searchJobs: async (q) => {
      calls.push(q);
      return response(q);
    },
    currentThreadId: async () => 7,
    perClient: memoryLimiter(60, 100),
    misses: memoryLimiter(60, 100),
    cache: memoryCache(),
    log: () => {},
    ...over,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (p: string, init?: RequestInit) => fetch(base + p, init);
  return { get, calls, close: () => new Promise((r) => server.close(r)) };
}

test("search: miss, then cache hit with one backend call", async (t) => {
  const s = await start();
  t.after(s.close);
  const a = await s.get("/api/search?q=remote%20rust");
  assert.equal(a.status, 200);
  assert.equal(a.headers.get("x-cache"), "miss");
  assert.equal((await a.json()).query, "remote rust");
  const b = await s.get("/api/search?q=Remote%20Rust");
  assert.equal(b.headers.get("x-cache"), "hit");
  assert.deepEqual(s.calls, ["remote rust"]);
});

test("rejects bad queries and limits clients before any backend work", async (t) => {
  const s = await start({ perClient: memoryLimiter(1, 1) });
  t.after(s.close);
  assert.equal((await s.get("/api/search?q=x")).status, 400);
  const limited = await s.get("/api/search?q=hello");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.deepEqual(s.calls, []);
});

test("global miss cap returns 503, but cached answers still work", async (t) => {
  const s = await start({ misses: memoryLimiter(1, 1) });
  t.after(s.close);
  assert.equal((await s.get("/api/search?q=first")).status, 200);
  assert.equal((await s.get("/api/search?q=second")).status, 503);
  assert.equal((await s.get("/api/search?q=first")).status, 200);
});

test("degraded answers are not cached", async (t) => {
  const s = await start({ searchJobs: async (q) => response(q, true) });
  t.after(s.close);
  await s.get("/api/search?q=hello");
  assert.equal((await s.get("/api/search?q=hello")).headers.get("x-cache"), "miss");
});

test("a cache outage degrades to a miss, not an error", async (t) => {
  const broken: Cache = {
    get: async () => {
      throw new Error("redis down");
    },
    set: async () => {
      throw new Error("redis down");
    },
  };
  const s = await start({ cache: broken });
  t.after(s.close);
  assert.equal((await s.get("/api/search?q=hello")).status, 200);
});

test("security headers, 405, 404, generic 500", async (t) => {
  const s = await start({
    searchJobs: async () => {
      throw new Error("SELECT secret FROM provider");
    },
  });
  t.after(s.close);
  const page = await s.get("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(page.headers.get("x-powered-by"), null);
  assert.equal((await s.get("/api/search?q=hi", { method: "POST" })).status, 405);
  assert.equal((await s.get("/nope")).status, 404);
  const err = await s.get("/api/search?q=boom");
  assert.equal(err.status, 500);
  assert.doesNotMatch(await err.text(), /SELECT|secret/);
});

test("provider quota errors become 503 with Retry-After, without leaking details", async (t) => {
  const s = await start({
    searchJobs: async () => {
      throw new Error("[429 Too Many Requests] Your project has exceeded its monthly spending cap");
    },
  });
  t.after(s.close);
  const r = await s.get("/api/search?q=hello");
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("retry-after"), "60");
  assert.doesNotMatch(await r.text(), /spending cap|429/);
});

test("vercel.json gives CDN-served static files the same headers Express sends", async (t) => {
  const s = await start();
  t.after(s.close);
  const res = await s.get("/healthz");
  const vercel = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "vercel.json"), "utf8"),
  ) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
  const all = vercel.headers.find((h) => h.source === "/(.*)");
  assert.ok(all, "vercel.json needs a catch-all headers entry");
  for (const { key, value } of all.headers) {
    assert.equal(res.headers.get(key), value, `${key} differs between Express and vercel.json`);
  }
});

test("readyz reports each dependency as a boolean, 503 when one is down", async (t) => {
  const s = await start({
    readiness: async () => ({ database: true, cache: true, llmKey: false, databaseError: null }),
  });
  t.after(s.close);
  const r = await s.get("/readyz");
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), {
    ready: false,
    database: true,
    databaseError: null,
    cache: true,
    llmKey: false,
  });
});
