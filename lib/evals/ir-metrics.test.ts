import { test } from "node:test";
import assert from "node:assert/strict";
import { ndcgAt, precisionAt, rPrecision } from "./ir-metrics";

const rel = new Set(["a", "b"]);

test("nDCG: perfect, partial, and unretrievable relevant items", () => {
  assert.equal(ndcgAt(["a", "b", "x"], rel, 2), 1);
  assert.ok(ndcgAt(["x", "a", "b"], rel, 2) < 1);
  // a third relevant role exists but was never indexed: ideal ranking can't be reached
  assert.ok(ndcgAt(["a", "b"], rel, 3) < 1);
});

test("P@k and R-precision", () => {
  assert.equal(precisionAt(["a", "x", "b"], rel, 10), 0.2);
  assert.equal(rPrecision(["a", "x", "b"], rel, 2), 0.5);
});
