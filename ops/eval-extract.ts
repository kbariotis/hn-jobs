require("dotenv").config();

import fs from "fs/promises";
import { loadThread, toPostings } from "../lib/preprocess";
import {
  buildExtractor,
  extractPosting,
  extractedPath,
  readExtractions,
  type ExtractionRecord,
} from "../lib/extract";
import { goldPath, type GoldFile } from "../lib/gold";
import { Scorecard, type Mismatch } from "../lib/score";
import { baselinePath, compareToBaseline, goldHash, mismatchKey, type Baseline } from "../lib/gate";
import { extractModelId } from "../models/extract";
import { PROMPT_VERSION } from "../prompts/extract";

/**
 * Score one or more models against reviewed gold labels.
 *
 * Usage: npm run eval:extract -- [--models a,b] [--run] [--include-drafts] [--errors 15]
 *   --run             extract gold postings a model is missing (or has stale/failed)
 *   --include-drafts  also score unreviewed drafts (biased toward the seeding model!)
 *   --write-baseline  record current results as the committed benchmark (replaces the file)
 *   --check           exit 1 if a model makes errors the baseline didn't (see lib/gate.ts)
 *   --tolerance N     allowed new errors per model under --check (default 0; raise with --run,
 *                     since fresh extractions aren't bit-for-bit reproducible)
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const threadId = Number(arg("thread") ?? process.env.THREAD_ID ?? "46108941");
  const models = (arg("models") ?? extractModelId()).split(",");
  const maxErrors = Number(arg("errors") ?? 15);

  const gold: GoldFile = JSON.parse(await fs.readFile(goldPath(threadId), "utf8"));
  const labels = gold.postings.filter((p) => flag("include-drafts") || p.status === "reviewed");
  const writeBaseline = flag("write-baseline");
  const check = flag("check");
  if ((writeBaseline || check) && flag("include-drafts")) throw new Error("Baselines are reviewed-only; drop --include-drafts.");
  if (labels.length === 0) throw new Error("No reviewed gold postings. Review some, or pass --include-drafts.");

  // Preprocessing drift invalidates labels silently — surface it.
  const postings = new Map(toPostings(await loadThread(threadId)).map((p) => [p.id, p]));
  const drifted = labels.filter((l) => postings.get(l.id)?.text !== l.text).map((l) => l.id);
  if (drifted.length) console.warn(`⚠ Preprocessed text differs from labelling time for: ${drifted.join(", ")}`);

  const report: Record<string, unknown> = {};
  const rows: Record<string, Record<string, unknown>> = {};
  const results: Results = {};

  for (const modelId of models) {
    const path = extractedPath(threadId, modelId);
    const fresh = (r: ExtractionRecord) => !r.error && r.prompt_version === PROMPT_VERSION;
    let records = new Map((await readExtractions(path)).filter(fresh).map((r) => [r.id, r]));

    const missing = labels.filter((l) => !records.has(l.id));
    if (missing.length && flag("run")) {
      console.log(`${modelId}: extracting ${missing.length} postings…`);
      const extractor = await buildExtractor(modelId);
      await fs.mkdir("data/extracted", { recursive: true });
      for (const l of missing) {
        const rec = await extractPosting(extractor, modelId, postings.get(l.id)!);
        await fs.appendFile(path, JSON.stringify(rec) + "\n");
        if (rec.error) console.error(`  ✗ ${l.id}: ${rec.error.slice(0, 200)}`);
      }
      records = new Map((await readExtractions(path)).filter(fresh).map((r) => [r.id, r]));
    }

    const card = new Scorecard();
    let failed = 0;
    let warnings = 0;
    const latencies: number[] = [];
    for (const l of labels) {
      const rec = records.get(l.id);
      if (!rec) failed++; // missing or failed extraction scores as "found nothing"
      else {
        latencies.push(rec.latency_ms);
        warnings += rec.warnings?.length ?? 0;
      }
      card.add(l.id, rec?.roles ?? [], l.roles);
    }
    if (failed && !flag("run")) console.warn(`⚠ ${modelId}: ${failed} gold postings have no fresh extraction. Use --run.`);

    latencies.sort((a, b) => a - b);
    const s = card.summary();
    rows[modelId] = {
      postings: s.postings,
      "failed/missing": failed,
      "role count exact %": s.role_count_exact,
      "role precision %": s.role_precision,
      "role recall %": s.role_recall,
      ...Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [`${k} %`, v])),
      "guard warnings": warnings,
      "latency p50 ms": latencies[Math.floor(latencies.length / 2)] ?? null,
    };
    report[modelId] = { summary: s, failed, warnings, mismatches: card.mismatches };
    results[modelId] = { failed, fields: s.fields, mismatches: card.mismatches };

    console.log(`\n${modelId}: ${card.mismatches.length} mismatches (showing ${Math.min(maxErrors, card.mismatches.length)})`);
    for (const m of card.mismatches.slice(0, maxErrors)) {
      console.log(`  ${m.posting_id} ${m.role.slice(0, 32).padEnd(32)} ${m.field.padEnd(16)} pred=${JSON.stringify(m.pred)} gold=${JSON.stringify(m.gold)}`);
    }
  }

  console.log(`\nGold: ${labels.length} postings (${flag("include-drafts") ? "incl. drafts" : "reviewed only"}), prompt v${PROMPT_VERSION}`);
  console.table(rows);

  await fs.mkdir("data/evals", { recursive: true });
  const out = `data/evals/extract.${threadId}.json`;
  await fs.writeFile(
    out,
    JSON.stringify({ at: new Date().toISOString(), prompt_version: PROMPT_VERSION, gold_postings: labels.map((l) => l.id), models: report }, null, 2) + "\n"
  );
  console.log(`Full report: ${out}`);

  if (writeBaseline) await saveBaseline(threadId, labels, results);
  if (check) process.exitCode = await runGate(threadId, labels, results);
}

type Results = Record<string, { failed: number; fields: Record<string, number | null>; mismatches: Mismatch[] }>;

async function saveBaseline(threadId: number, labels: GoldFile["postings"], results: Results) {
  // A failed extraction would bake "found nothing" errors into the benchmark.
  const incomplete = Object.entries(results).filter(([, r]) => r.failed > 0).map(([m]) => m);
  if (incomplete.length) throw new Error(`Not writing baseline: missing/failed extractions for ${incomplete.join(", ")}. Use --run.`);
  const baseline: Baseline = {
    thread_id: threadId,
    created_at: new Date().toISOString(),
    gold: Object.fromEntries(labels.map((l) => [String(l.id), goldHash(l)])),
    models: Object.fromEntries(
      Object.entries(results).map(([m, r]) => [
        m,
        { prompt_version: PROMPT_VERSION, fields: r.fields, mismatches: [...new Set(r.mismatches.map(mismatchKey))].sort() },
      ])
    ),
  };
  await fs.writeFile(baselinePath(threadId), JSON.stringify(baseline, null, 2) + "\n");
  console.log(`\n✓ Baseline written: ${baselinePath(threadId)} (${labels.length} postings, ${Object.keys(results).join(", ")})`);
}

async function runGate(threadId: number, labels: GoldFile["postings"], results: Results): Promise<number> {
  const baseline: Baseline = JSON.parse(await fs.readFile(baselinePath(threadId), "utf8"));
  const tolerance = Number(arg("tolerance") ?? 0);
  let failed = false;
  console.log(`\nRegression gate vs ${baselinePath(threadId)} (${baseline.created_at}), tolerance ${tolerance}`);
  for (const [model, r] of Object.entries(results)) {
    const g = compareToBaseline(baseline, model, labels, r.mismatches);
    const ok = g.regressions.length <= tolerance;
    failed ||= !ok;
    console.log(`${ok ? "✓" : "✗"} ${model}: ${g.regressions.length} new error(s), ${g.fixed.length} fixed, ${g.gated} postings gated`);
    for (const k of g.regressions) console.log(`    + ${k}`);
    for (const k of g.fixed) console.log(`    - ${k}`);
    const ungated = [["new", g.added], ["edited", g.changed], ["removed", g.removed]] as const;
    for (const [what, ids] of ungated) if (ids.length) console.log(`    ${ids.length} ${what} since baseline, not gated: ${ids.join(", ")}`);
    const base = baseline.models[model];
    if (base.prompt_version !== PROMPT_VERSION) console.log(`    prompt v${base.prompt_version} -> v${PROMPT_VERSION}`);
  }
  if (failed) console.log("\nGate failed. Fix the regression, or re-baseline with --write-baseline if the change is intended.");
  return failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
