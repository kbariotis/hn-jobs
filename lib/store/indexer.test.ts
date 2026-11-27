import { test } from "node:test";
import assert from "node:assert/strict";
import { needsIndex } from "./indexer";

const set = (...ids: number[]) => new Set(ids);

test("needsIndex: skip quiet runs, index on new work, deletions or an empty index", () => {
  const base = { indexed: set(1, 2), live: set(1, 2), hasExtractions: true };
  assert.equal(needsIndex({ ...base, extracted: 0 }), false); // nothing changed
  assert.equal(needsIndex({ ...base, extracted: 3 }), true); // new/edited postings
  assert.equal(needsIndex({ ...base, extracted: 0, live: set(1) }), true); // 2 was deleted
  // 3 is live but not extracted yet: nothing to index until it is
  assert.equal(needsIndex({ ...base, extracted: 0, live: set(1, 2, 3) }), false);
  assert.equal(
    needsIndex({ extracted: 0, indexed: set(), live: set(1), hasExtractions: true }),
    true,
  );
  assert.equal(
    needsIndex({ extracted: 0, indexed: set(), live: set(1), hasExtractions: false }),
    false,
  );
});
