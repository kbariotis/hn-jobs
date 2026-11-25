import { test } from "node:test";
import assert from "node:assert/strict";
import { safeHttpUrl, safeEmail, cleanQuery } from "../lib/safe";
import { TtlCache } from "../lib/cache";
import { KeyedTokenBucket } from "../lib/rate";

test("safeHttpUrl: http(s) only, bare domains upgraded, tricks rejected", () => {
  assert.equal(safeHttpUrl("https://acme.co/jobs"), "https://acme.co/jobs");
  assert.equal(safeHttpUrl("acme.co/careers"), "https://acme.co/careers");
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("JaVaScRiPt:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,<script>"), null);
  assert.equal(safeHttpUrl("https://good.com@evil.com/"), null);
  assert.equal(safeHttpUrl("localhost"), null);
  assert.equal(safeHttpUrl(null), null);
});

test("safeEmail and cleanQuery", () => {
  assert.equal(safeEmail("jane@acme.com"), "jane@acme.com");
  assert.equal(safeEmail("<script>@x.com"), null);
  assert.equal(cleanQuery("  remote\n\trust  "), "remote rust");
  assert.equal(cleanQuery("a"), null);
  assert.equal(cleanQuery("x".repeat(201)), null);
});

test("TtlCache: expiry and LRU eviction", async () => {
  const c = new TtlCache<number>(2, 30);
  c.set("a", 1);
  c.set("b", 2);
  c.get("a"); // a is now most recent
  c.set("c", 3); // evicts b
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(c.get("a"), undefined);
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
