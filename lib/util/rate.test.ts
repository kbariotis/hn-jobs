import { test } from "node:test";
import assert from "node:assert/strict";
import { withBackoff, isRateLimited, RateLimiter, KeyedTokenBucket } from "./rate";

test("backoff retries 429s, then succeeds", async () => {
  let calls = 0;
  const out = await withBackoff(async () => {
    if (++calls < 3) throw new Error("[429 Too Many Requests] Your project is temporarily rate-limited");
    return "ok";
  }, { baseMs: 1 });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("backoff does not retry other errors, and gives up after `retries`", async () => {
  let calls = 0;
  await assert.rejects(withBackoff(async () => { calls++; throw new Error("400 bad schema"); }, { baseMs: 1 }), /400/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withBackoff(async () => { calls++; throw new Error("429"); }, { baseMs: 1, retries: 2 }), /429/);
  assert.equal(calls, 3);
  assert.ok(isRateLimited(new Error("RESOURCE_EXHAUSTED")));
});

test("limiter spaces request starts at 60s/rpm", async () => {
  const limiter = new RateLimiter(1200); // 50ms apart
  const t0 = Date.now();
  await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
  assert.ok(Date.now() - t0 >= 95, `took ${Date.now() - t0}ms`);
});

test("KeyedTokenBucket: burst, refill, per-key isolation", () => {
  const b = new KeyedTokenBucket(60, 2); // 1 token/s, burst 2
  const t = 1_000_000;
  assert.ok(b.take("ip1", t));
  assert.ok(b.take("ip1", t));
  assert.ok(!b.take("ip1", t)); // burst exhausted
  assert.ok(b.take("ip2", t)); // other clients unaffected
  assert.ok(b.take("ip1", t + 1000)); // refilled one token
});
