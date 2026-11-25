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
import { extractModelId } from "../models/extract";
import { PROMPT_VERSION } from "../prompts/extract";

// Usage: npm run extract -- [--thread 46108941] [--limit 20 | --ids 1,2,3] [--refresh] [--concurrency 4]
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const threadId = arg("thread") ?? process.env.THREAD_ID ?? "46108941";
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const concurrency = Number(arg("concurrency") ?? process.env.EXTRACT_CONCURRENCY ?? 1);
  const modelId = extractModelId();

  const thread = await loadThread(threadId, { refresh: process.argv.includes("--refresh") });
  const ids = arg("ids")?.split(",").map(Number);
  const all = toPostings(thread);
  if (ids) {
    const missing = ids.filter((id) => !all.some((p) => p.id === id));
    if (missing.length) throw new Error(`Not top-level postings in thread ${threadId}: ${missing.join(", ")}`);
  }
  const postings = ids ? all.filter((p) => ids.includes(p.id)) : all.slice(0, limit);
  const out = extractedPath(threadId, modelId);

  // Resume: keep successful records from the same prompt version, redo errors.
  const done = new Set(
    (await readExtractions(out))
      .filter((r) => !r.error && r.prompt_version === PROMPT_VERSION)
      .map((r) => r.id)
  );
  const todo = postings.filter((p) => !done.has(p.id));

  console.log(
    `${modelId} | thread ${threadId} | ${postings.length} postings, ${done.size} done, ${todo.length} to go -> ${out}`
  );

  await fs.mkdir("data/extracted", { recursive: true });
  const extractor = await buildExtractor(modelId);

  let next = 0;
  let ok = 0;
  let failed = 0;
  const worker = async () => {
    while (next < todo.length) {
      const posting = todo[next++];
      const rec: ExtractionRecord = await extractPosting(extractor, modelId, posting);
      await fs.appendFile(out, JSON.stringify(rec) + "\n"); // append-as-you-go = crash-safe
      if (rec.error) {
        failed++;
        console.error(`✗ ${posting.id} (${rec.latency_ms}ms): ${rec.error}`);
      } else {
        ok++;
        console.log(`✓ ${posting.id} (${rec.latency_ms}ms): ${rec.roles.length} role(s)`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  // Dedupe: last record per id wins (retries append newer lines).
  const latest = new Map((await readExtractions(out)).map((r) => [r.id, r]));
  await fs.writeFile(out, [...latest.values()].map((r) => JSON.stringify(r)).join("\n") + "\n");

  console.log(`Done: ${ok} ok, ${failed} failed. Re-run to retry failures.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
