import { createHash } from "crypto";
import type { GoldPosting } from "./gold";
import type { Mismatch } from "./score";

/**
 * Regression gate for extraction evals.
 *
 * Compares *which* errors a model makes, not percentages: with ~30 gold postings one
 * flipped field moves a score by ~3 points, so a % threshold is either noisy or blind.
 * Every gold posting is hashed, so reviewing more postings (or editing one) doesn't
 * register as a regression. Only postings whose labels are unchanged since the baseline
 * are gated; new and edited ones are reported until you re-baseline.
 */

export type Baseline = {
  thread_id: number;
  created_at: string;
  gold: Record<string, string>; // posting id -> hash of the labels it was scored against
  models: Record<
    string,
    { prompt_version: string; fields: Record<string, number | null>; mismatches: string[] }
  >;
};

export const baselinePath = (threadId: string | number) => `data/evals/baseline.${threadId}.json`;

/** Labels + input text: if either changes, old results for this posting are not comparable. */
export const goldHash = (p: Pick<GoldPosting, "text" | "roles">) =>
  createHash("sha1")
    .update(JSON.stringify({ text: p.text, roles: p.roles }))
    .digest("hex")
    .slice(0, 12);

// Value excluded on purpose: a different wrong value is the same error, not a new one.
export const mismatchKey = (m: Mismatch) => `${m.posting_id}|${m.role}|${m.field}`;

export type GateResult = {
  regressions: string[]; // new mismatches on comparable postings
  fixed: string[]; // baseline mismatches that disappeared
  gated: number; // postings compared
  added: number[]; // in gold now, not in baseline (not gated)
  changed: number[]; // labels edited since baseline (not gated)
  removed: number[]; // in baseline, no longer scored (e.g. reopened as draft)
};

export function compareToBaseline(
  baseline: Baseline,
  model: string,
  gold: Pick<GoldPosting, "id" | "text" | "roles">[],
  mismatches: Mismatch[],
): GateResult {
  const base = baseline.models[model];
  if (!base) {
    throw new Error(`No baseline for ${model}. Run with --write-baseline first.`);
  }

  const now = new Map(gold.map((p) => [String(p.id), goldHash(p)]));
  const comparable = new Set(
    [...now].filter(([id, h]) => baseline.gold[id] === h).map(([id]) => id),
  );
  const onComparable = (k: string) => comparable.has(k.slice(0, k.indexOf("|")));

  const before = new Set(base.mismatches.filter(onComparable));
  const after = new Set(mismatches.map(mismatchKey).filter(onComparable));
  const ids = (xs: string[]) => xs.map(Number).sort((a, b) => a - b);

  return {
    regressions: [...after].filter((k) => !before.has(k)).sort(),
    fixed: [...before].filter((k) => !after.has(k)).sort(),
    gated: comparable.size,
    added: ids([...now.keys()].filter((id) => !(id in baseline.gold))),
    changed: ids(
      [...now]
        .filter(([id, h]) => id in baseline.gold && baseline.gold[id] !== h)
        .map(([id]) => id),
    ),
    removed: ids(Object.keys(baseline.gold).filter((id) => !now.has(id))),
  };
}
