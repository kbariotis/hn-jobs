import { test } from "node:test";
import assert from "node:assert/strict";
import { limitsFromEnv, redisRestEnv } from "./limits";

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
