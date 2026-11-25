import type { Location, Role } from "./schema";
import { normalizeUrl } from "./grounding";
import { canonicalizeRoles } from "./canonical";

/**
 * Field-level scoring of extracted roles against gold labels.
 * Deterministic on purpose: no LLM judge, so scores are cheap, stable and diffable.
 * `description` is free text and deliberately not scored.
 */

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9+#]+/g, " ").trim();
// Crude plural folding so "Engineers" aligns with "Engineer".
const stem = (t: string) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);
const tokens = (s: string) => new Set(norm(s).split(" ").filter(Boolean).map(stem));
// List items compare without separators: "node.js" == "nodejs" == "Node JS".
const itemKey = (s: string) => norm(s).replace(/ /g, "");
// Locations match on city + country; region is often omitted by one side and isn't worth a miss.
const locKey = (l: Location) => `${itemKey(l.city ?? "")}|${l.country_code ?? ""}`;

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Disambiguates same-title roles that differ by location (e.g. "Engineering Manager" x2).
function roleSimilarity(pred: Role, gold: Role): number {
  const title = jaccard(tokens(pred.role_title), tokens(gold.role_title));
  const where = jaccard(
    new Set([...pred.locations.map(locKey), ...pred.remote_regions]),
    new Set([...gold.locations.map(locKey), ...gold.remote_regions])
  );
  return 0.85 * title + 0.15 * where;
}

export const MATCH_THRESHOLD = 0.5;
export const LEFTOVER_THRESHOLD = 0.3; // some title overlap required, so unrelated roles never pair

/** Greedy one-to-one alignment, best pairs first. Fine at HN-post scale (<20 roles). */
export function alignRoles(pred: Role[], gold: Role[]): Array<[number, number]> {
  const candidates: Array<[number, number, number]> = [];
  pred.forEach((p, i) =>
    gold.forEach((g, j) => {
      const s = roleSimilarity(p, g);
      if (s >= MATCH_THRESHOLD) candidates.push([s, i, j]);
    })
  );
  candidates.sort((a, b) => b[0] - a[0]);
  const usedP = new Set<number>();
  const usedG = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const [, i, j] of candidates) {
    if (usedP.has(i) || usedG.has(j)) continue;
    usedP.add(i);
    usedG.add(j);
    pairs.push([i, j]);
  }
  // One leftover on each side: same role with a reworded title ("Intern" vs "Intern/Co-op").
  // Pair them so field errors are scored instead of a missing + an extra role.
  const leftP = pred.map((_, i) => i).filter((i) => !usedP.has(i));
  const leftG = gold.map((_, j) => j).filter((j) => !usedG.has(j));
  if (leftP.length === 1 && leftG.length === 1 && roleSimilarity(pred[leftP[0]], gold[leftG[0]]) >= LEFTOVER_THRESHOLD)
    pairs.push([leftP[0], leftG[0]]);
  return pairs;
}

type Scalar = string | number | boolean | null;
const SCALAR_FIELDS = ["employment_type", "remote_policy", "seniority", "visa_sponsorship"] as const;
const SET_KEYS = {
  tech_stack: (r: Role) => r.tech_stack.map(itemKey),
  locations: (r: Role) => r.locations.map(locKey),
  remote_regions: (r: Role) => r.remote_regions,
  timezones: (r: Role) => r.timezones.map(itemKey),
} as const;

const salaryKey = (s: Role["salary"]) =>
  s ? `${s.min}|${s.max}|${s.currency?.toUpperCase()}|${s.period}` : null;

// Comparators per exact-match field. Normalization is part of the metric definition.
const EXACT: Record<string, (r: Role) => Scalar> = {
  company_name: (r) => norm(r.company_name),
  ...Object.fromEntries(SCALAR_FIELDS.map((f) => [f, (r: Role) => r[f]])),
  salary: (r) => salaryKey(r.salary),
  apply_url: (r) => (r.apply_url ? normalizeUrl(r.apply_url) : null),
  apply_email: (r) => r.apply_email?.toLowerCase() ?? null,
};

export type Mismatch = { posting_id: number; role: string; field: string; pred: unknown; gold: unknown };

export class Scorecard {
  postings = 0;
  roleCountExact = 0;
  predRoles = 0;
  goldRoles = 0;
  matchedRoles = 0;
  exact: Record<string, { ok: number; n: number }> = {};
  sets: Record<string, { tp: number; fp: number; fn: number; exact: number; n: number }> = {};
  mismatches: Mismatch[] = [];

  add(postingId: number, predRaw: Role[], goldRaw: Role[]) {
    // Both sides through the same canonicalizer: hand-edited labels may not be normalized.
    const pred = canonicalizeRoles(predRaw).roles;
    const gold = canonicalizeRoles(goldRaw).roles;
    this.postings++;
    if (pred.length === gold.length) this.roleCountExact++;
    this.predRoles += pred.length;
    this.goldRoles += gold.length;

    const pairs = alignRoles(pred, gold);
    this.matchedRoles += pairs.length;

    // Unmatched roles are recorded so missing/extra roles show up in the error list.
    const matchedP = new Set(pairs.map(([i]) => i));
    const matchedG = new Set(pairs.map(([, j]) => j));
    pred.forEach((p, i) => !matchedP.has(i) && this.mismatches.push({ posting_id: postingId, role: p.role_title, field: "role(extra)", pred: p.role_title, gold: null }));
    gold.forEach((g, j) => !matchedG.has(j) && this.mismatches.push({ posting_id: postingId, role: g.role_title, field: "role(missing)", pred: null, gold: g.role_title }));

    for (const [i, j] of pairs) {
      const p = pred[i];
      const g = gold[j];
      for (const [field, key] of Object.entries(EXACT)) {
        const e = (this.exact[field] ??= { ok: 0, n: 0 });
        e.n++;
        if (key(p) === key(g)) e.ok++;
        else this.mismatches.push({ posting_id: postingId, role: g.role_title, field, pred: (p as any)[field], gold: (g as any)[field] });
      }
      for (const [field, keys] of Object.entries(SET_KEYS)) {
        const s = (this.sets[field] ??= { tp: 0, fp: 0, fn: 0, exact: 0, n: 0 });
        const ps = new Set(keys(p));
        const gs = new Set(keys(g));
        let tp = 0;
        for (const x of ps) if (gs.has(x)) tp++;
        s.tp += tp;
        s.fp += ps.size - tp;
        s.fn += gs.size - tp;
        s.n++;
        if (tp === ps.size && tp === gs.size) s.exact++;
        else this.mismatches.push({ posting_id: postingId, role: g.role_title, field, pred: p[field as keyof Role], gold: g[field as keyof Role] });
      }
    }
  }

  summary() {
    const pct = (a: number, b: number) => (b === 0 ? null : Math.round((1000 * a) / b) / 10);
    const rp = pct(this.matchedRoles, this.predRoles);
    const rr = pct(this.matchedRoles, this.goldRoles);
    return {
      postings: this.postings,
      role_count_exact: pct(this.roleCountExact, this.postings),
      role_precision: rp,
      role_recall: rr,
      fields: {
        ...Object.fromEntries(Object.entries(this.exact).map(([f, e]) => [f, pct(e.ok, e.n)])),
        ...Object.fromEntries(
          Object.entries(this.sets).map(([f, s]) => {
            const p = s.tp / (s.tp + s.fp || 1);
            const r = s.tp / (s.tp + s.fn || 1);
            const f1 = p + r === 0 ? (s.tp + s.fp + s.fn === 0 ? 1 : 0) : (2 * p * r) / (p + r);
            return [f, Math.round(1000 * f1) / 10];
          })
        ),
      } as Record<string, number | null>,
    };
  }
}
