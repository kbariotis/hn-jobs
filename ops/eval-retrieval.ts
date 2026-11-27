import "dotenv/config";

import fs from "fs/promises";
import { db, closeDb } from "../lib/store/db";
import { extractedPath, readExtractions } from "../lib/extraction/extract";
import { goldPath, type GoldFile } from "../lib/evals/gold";
import { loadThread, toPostings } from "../lib/extraction/hn";
import { alignRoles } from "../lib/evals/score";
import { canonicalizeRoles } from "../lib/canonical";
import { search, type Strategy } from "../lib/search/search";
import { ndcgAt, precisionAt, rPrecision } from "../lib/evals/ir-metrics";
import { QUERIES } from "../lib/evals/retrieval-queries";
import { cachedQueryEmbeddings } from "../lib/evals/query-embeddings";
import { extractModelId } from "../models/extract";
import { embedModelId } from "../models/embeddings";
import { PROMPT_VERSION } from "../prompts/extract";

/**
 * Retrieval eval: does a valid search return the right roles?
 *
 * Relevance comes from the best labels available per posting: human gold where reviewed,
 * Flash extractions elsewhere. On gold postings, gold roles are aligned to the indexed
 * (extracted) roles, so extraction mistakes show up as retrieval misses; relevant gold roles
 * the extractor never produced are unretrievable and still count against recall.
 *
 * Caveat: outside gold, relevance and the `filtered` strategy read the same extracted
 * fields, so there it measures query parsing + ranking, not extraction accuracy (that's
 * eval:extract's job).
 *
 * Usage: npm run eval:retrieval -- [--strategies vector,filtered] [--only id1,id2]
 *        [--write-baseline] [--check [--tolerance 0.05]]
 */
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const flag = (n: string) => process.argv.includes(`--${n}`);

type QueryResult = {
  ndcg10: number;
  p10: number;
  rprec: number;
  relevant: number;
  unretrievable: number;
  top: string[];
  filters?: unknown;
};
type Baseline = {
  created_at: string;
  embed_model: string;
  prompt_version: string;
  ndcg10: Record<string, Record<string, number>>;
};
const baselinePath = (t: number) => `data/evals/baseline.retrieval.${t}.json`;

async function relevanceSets(threadId: number) {
  const extracted = (await readExtractions(extractedPath(threadId, extractModelId()))).filter(
    (r) => !r.error && r.prompt_version === PROMPT_VERSION,
  );
  const gold: GoldFile = JSON.parse(await fs.readFile(goldPath(threadId), "utf8"));
  const goldById = new Map(
    gold.postings.filter((p) => p.status === "reviewed").map((p) => [p.id, p]),
  );
  const text = new Map(toPostings(await loadThread(threadId)).map((p) => [p.id, p.text]));

  return QUERIES.map((q) => {
    const relevant = new Set<string>();
    let unretrievable = 0;
    for (const rec of extracted) {
      const ctx = { text: text.get(rec.id) ?? "" };
      const g = goldById.get(rec.id);
      if (!g) {
        rec.roles.forEach((r, i) => q.relevant(r, ctx) && relevant.add(`${rec.id}-${i}`));
        continue;
      }
      const goldRoles = canonicalizeRoles(g.roles).roles;
      const toIndexed = new Map(alignRoles(rec.roles, goldRoles).map(([pi, gi]) => [gi, pi]));
      goldRoles.forEach((r, gi) => {
        if (!q.relevant(r, ctx)) {
          return;
        }
        const pi = toIndexed.get(gi);
        if (pi === undefined) {
          unretrievable++;
        } else {
          relevant.add(`${rec.id}-${pi}`);
        }
      });
    }
    return { q, relevant, unretrievable };
  });
}

async function main() {
  const threadId = Number(arg("thread") ?? process.env.THREAD_ID ?? "46108941");
  const strategies = (arg("strategies") ?? "vector,filtered").split(",") as Strategy[];
  const only = arg("only")?.split(",");
  const embedModel = embedModelId();

  const {
    rows: [{ n }],
  } = await db().query<{ n: string }>(
    "SELECT count(*) AS n FROM roles r JOIN role_embeddings e USING (role_id) WHERE r.thread_id = $1 AND e.embed_model = $2",
    [threadId, embedModel],
  );
  if (Number(n) === 0) {
    throw new Error(
      `Nothing indexed for thread ${threadId} with ${embedModel}. Run \`npm run index\`.`,
    );
  }

  const sets = (await relevanceSets(threadId)).filter((s) => !only || only.includes(s.q.id));
  // Relevance comes from the extraction file; search sees the index. If they drift (re-extracted
  // but not re-indexed), relevant roles become unfindable and scores drop for no real reason.
  const { rows: indexed } = await db().query<{ role_id: string }>(
    "SELECT r.role_id FROM roles r JOIN role_embeddings e USING (role_id) WHERE r.thread_id = $1 AND e.embed_model = $2",
    [threadId, embedModel],
  );
  const inIndex = new Set(indexed.map((r) => r.role_id));
  const stale = [...new Set(sets.flatMap((s) => [...s.relevant]).filter((id) => !inIndex.has(id)))];
  if (stale.length) {
    throw new Error(
      `${stale.length} relevant roles are not indexed (e.g. ${stale.slice(0, 3).join(", ")}). Run \`npm run index -- --thread ${threadId}\`.`,
    );
  }
  // Cached per embedding model: after the first run the eval makes no embedding calls.
  const { vectors, embedded } = await cachedQueryEmbeddings(
    sets.map((s) => s.q.query),
    embedModel,
  );
  if (embedded) {
    console.log(`Embedded ${embedded} new queries with ${embedModel} (cached for next runs)`);
  }
  const results: Record<string, Record<string, QueryResult>> = {};
  for (const strategy of strategies) {
    results[strategy] = {};
    for (const { q, relevant, unretrievable } of sets) {
      const total = relevant.size + unretrievable;
      const { hits, filters } = await search(q.query, {
        strategy,
        threadId,
        embedModel,
        queryVector: vectors.get(q.query),
        k: Math.max(10, total),
      });
      const ranked = hits.map((h) => h.role_id);
      results[strategy][q.id] = {
        ndcg10: ndcgAt(ranked, relevant, total),
        p10: precisionAt(ranked, relevant),
        rprec: rPrecision(ranked, relevant, total),
        relevant: total,
        unretrievable,
        top: ranked.slice(0, 10),
        ...(filters ? { filters } : {}),
      };
    }
  }

  // Per-query table: one nDCG column per strategy, plus relevance counts.
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const table = Object.fromEntries(
    sets.map(({ q }) => [
      q.id,
      {
        kind: q.kind,
        relevant: results[strategies[0]][q.id].relevant,
        ...Object.fromEntries(strategies.map((s) => [`${s} nDCG@10`, r2(results[s][q.id].ndcg10)])),
        ...Object.fromEntries(strategies.map((s) => [`${s} P@10`, r2(results[s][q.id].p10)])),
      },
    ]),
  );
  console.table(table);
  const mean = (s: string, kind?: string, m: keyof QueryResult = "ndcg10") => {
    const xs = sets
      .filter(({ q }) => !kind || q.kind === kind)
      .map(({ q }) => results[s][q.id][m] as number);
    return r2(xs.reduce((a, b) => a + b, 0) / (xs.length || 1));
  };
  console.table(
    Object.fromEntries(
      strategies.map((s) => [
        s,
        {
          "nDCG@10": mean(s),
          "P@10": mean(s, undefined, "p10"),
          "R-prec": mean(s, undefined, "rprec"),
          "nDCG structured": mean(s, "structured"),
          "nDCG semantic": mean(s, "semantic"),
        },
      ]),
    ),
  );

  await fs.mkdir("data/evals", { recursive: true });
  const out = `data/evals/retrieval.${threadId}.json`;
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        embed_model: embedModel,
        prompt_version: PROMPT_VERSION,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Full report (incl. parsed filters and top-10 ids): ${out}`);

  if (flag("write-baseline")) {
    if (only) {
      throw new Error("Not writing a baseline from a partial run (--only).");
    }
    const baseline: Baseline = {
      created_at: new Date().toISOString(),
      embed_model: embedModel,
      prompt_version: PROMPT_VERSION,
      ndcg10: Object.fromEntries(
        strategies.map((s) => [
          s,
          Object.fromEntries(sets.map(({ q }) => [q.id, r2(results[s][q.id].ndcg10)])),
        ]),
      ),
    };
    await fs.writeFile(baselinePath(threadId), JSON.stringify(baseline, null, 2) + "\n");
    console.log(`✓ Baseline written: ${baselinePath(threadId)}`);
  }

  if (flag("check")) {
    // Per-query, not mean: a big drop on one query shouldn't hide behind gains elsewhere.
    const base: Baseline = JSON.parse(await fs.readFile(baselinePath(threadId), "utf8"));
    const tol = Number(arg("tolerance") ?? 0.05);
    let failed = false;
    console.log(
      `\nRegression gate vs ${baselinePath(threadId)} (${base.created_at}), tolerance ${tol}`,
    );
    if (base.embed_model !== embedModel) {
      console.log(`  embed model ${base.embed_model} -> ${embedModel}`);
    }
    for (const s of strategies) {
      const drops = sets
        .map(({ q }) => ({
          id: q.id,
          was: base.ndcg10[s]?.[q.id],
          now: r2(results[s][q.id].ndcg10),
        }))
        .filter((d) => d.was !== undefined && d.was - d.now > tol);
      failed ||= drops.length > 0;
      console.log(`${drops.length ? "✗" : "✓"} ${s}: ${drops.length} query regression(s)`);
      for (const d of drops) {
        console.log(`    ${d.id}: ${d.was} -> ${d.now}`);
      }
    }
    if (failed) {
      process.exitCode = 1;
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
