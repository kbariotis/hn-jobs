import { test } from "node:test";
import assert from "node:assert/strict";
import { compareToBaseline, goldHash, type Baseline } from "../lib/gate";
import type { Mismatch } from "../lib/score";

const post = (id: number, text = `post ${id}`) => ({ id, text, roles: [] });
const mm = (posting_id: number, field: string, role = "SWE"): Mismatch => ({ posting_id, role, field, pred: "x", gold: "y" });

function baseline(posts: ReturnType<typeof post>[], mismatches: string[]): Baseline {
  return {
    thread_id: 1,
    created_at: "t",
    gold: Object.fromEntries(posts.map((p) => [String(p.id), goldHash(p)])),
    models: { m: { prompt_version: "4", fields: {}, mismatches } },
  };
}

test("new error on an unchanged posting is a regression; vanished one is fixed", () => {
  const b = baseline([post(1), post(2)], ["1|SWE|seniority"]);
  const g = compareToBaseline(b, "m", [post(1), post(2)], [mm(2, "salary")]);
  assert.deepEqual(g.regressions, ["2|SWE|salary"]);
  assert.deepEqual(g.fixed, ["1|SWE|seniority"]);
  assert.equal(g.gated, 2);
});

test("same field wrong with a different value is not a new error", () => {
  const b = baseline([post(1)], ["1|SWE|seniority"]);
  const g = compareToBaseline(b, "m", [post(1)], [{ ...mm(1, "seniority"), pred: "other" }]);
  assert.deepEqual(g.regressions, []);
});

test("newly reviewed, edited and reopened postings are reported, not gated", () => {
  const b = baseline([post(1), post(2), post(3)], ["2|SWE|salary"]);
  const now = [post(1), post(2, "relabelled"), post(4)]; // 2 edited, 3 reopened, 4 new
  const g = compareToBaseline(b, "m", now, [mm(2, "tech_stack"), mm(4, "salary")]);
  assert.deepEqual(g.regressions, []);
  assert.deepEqual(g.fixed, []); // 2's old error isn't "fixed" — its labels changed
  assert.deepEqual([g.added, g.changed, g.removed], [[4], [2], [3]]);
  assert.equal(g.gated, 1);
});

test("unknown model fails loudly", () => {
  assert.throws(() => compareToBaseline(baseline([], []), "other", [], []), /No baseline/);
});
