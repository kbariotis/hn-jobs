import { test } from "node:test";
import assert from "node:assert/strict";
import { allOf, limitsFromEnv, memoryDailyLimiter, redisRestEnv, type Limiter } from "./limits";

test("redisRestEnv reads Upstash, Vercel KV and the REDIS-prefixed integration names", () => {
  assert.deepEqual(redisRestEnv({ UPSTASH_REDIS_REST_URL: "u", UPSTASH_REDIS_REST_TOKEN: "t" }), {
    url: "u",
    token: "t",
  });
  assert.deepEqual(redisRestEnv({ REDIS_KV_REST_API_URL: "u", REDIS_KV_REST_API_TOKEN: "t" }), {
    url: "u",
    token: "t",
  });
  // The read-only token can't rate-limit (it writes): never picked up.
  assert.equal(
    redisRestEnv({ REDIS_KV_REST_API_URL: "u", REDIS_KV_REST_API_READ_ONLY_TOKEN: "t" }),
    null,
  );
  assert.equal(redisRestEnv({}), null);
});

test("memory locally, but a hard error on Vercel without Redis", () => {
  assert.equal(limitsFromEnv({}).backend, "memory");
  assert.throws(() => limitsFromEnv({ VERCEL: "1" }), /required on Vercel/);
});

const fixed = (ok: boolean, retryAfterS = 0): Limiter & { calls: number } => {
  const l = {
    calls: 0,
    take: async () => {
      l.calls++;
      return { ok, retryAfterS };
    },
  };
  return l;
};

test("allOf passes only if every limiter passes, and stops at the first refusal", async () => {
  const a = fixed(true);
  const b = fixed(false, 3600);
  const c = fixed(true);
  assert.deepEqual(await allOf(a, b, c).take("k"), { ok: false, retryAfterS: 3600 });
  assert.equal(c.calls, 0); // never reached
  assert.deepEqual(await allOf(fixed(true), fixed(true)).take("k"), { ok: true, retryAfterS: 0 });
});

test("daily budget: allows the budget, then refuses with a long retry", async () => {
  const day = memoryDailyLimiter(3);
  for (let i = 0; i < 3; i++) {
    assert.equal((await day.take("global")).ok, true);
  }
  const refused = await day.take("global");
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfterS > 60 * 60, "a daily budget refills over hours, not seconds");
});

test("miss caps default to 10/min and 2000/day; bad values fall back, never disable", async () => {
  const misses = limitsFromEnv({ SEARCH_MISS_RPM: "not-a-number" }).misses;
  let allowed = 0;
  for (let i = 0; i < 15; i++) {
    allowed += (await misses.take("global")).ok ? 1 : 0;
  }
  assert.equal(allowed, 10); // the default burst, not unlimited
  const tiny = limitsFromEnv({ SEARCH_MISS_PER_DAY: "2", SEARCH_MISS_RPM: "100" }).misses;
  assert.equal((await tiny.take("g")).ok, true);
  assert.equal((await tiny.take("g")).ok, true);
  assert.equal((await tiny.take("g")).ok, false); // daily budget wins over a loose minute cap
});
