import { test } from "node:test";
import assert from "node:assert/strict";
import { compact, keepPrevious, planExtraction } from "./pipeline";
import { textSha, type ExtractionRecord } from "./extract";
import { PROMPT_VERSION } from "../../prompts/extract";
import type { Posting } from "./hn";

const posting = (id: number, text = `post ${id}`): Posting => ({
  id,
  thread_id: 1,
  author: null,
  time: 0,
  text,
});
const rec = (id: number, over: Partial<ExtractionRecord> = {}): ExtractionRecord => ({
  id,
  thread_id: 1,
  author: null,
  time: 0,
  model: "m",
  prompt_version: PROMPT_VERSION,
  latency_ms: 1,
  text_sha: textSha(`post ${id}`),
  roles: [],
  ...over,
});

test("planExtraction picks new, failed, stale and edited postings", () => {
  const existing = [
    rec(1), // fresh
    rec(2, { error: "boom" }), // failed
    rec(3, { prompt_version: "old" }), // stale prompt
    rec(4), // edited below
  ];
  const todo = planExtraction(
    [posting(1), posting(2), posting(3), posting(4, "edited"), posting(5)],
    existing,
  );
  assert.deepEqual(
    todo.map((p) => p.id),
    [2, 3, 4, 5],
  );
});

test("a new failure never replaces an older success", () => {
  assert.equal(keepPrevious(rec(1), rec(1, { error: "429" })), true);
  assert.equal(keepPrevious(rec(1, { error: "old" }), rec(1, { error: "new" })), false);
  assert.equal(keepPrevious(rec(1), rec(1)), false);
  assert.equal(keepPrevious(undefined, rec(1, { error: "x" })), false);
});

test("compact keeps the last record per id, applying the merge rule", () => {
  const out = compact([
    rec(1, { latency_ms: 1 }),
    rec(1, { error: "429" }),
    rec(2, { error: "x" }),
    rec(2, { latency_ms: 9 }),
  ]);
  assert.deepEqual(
    out.map((r) => [r.id, r.error ?? null, r.latency_ms]),
    [
      [1, null, 1],
      [2, null, 9],
    ],
  );
});
