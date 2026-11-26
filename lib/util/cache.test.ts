import { test } from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "./cache";

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
