require("dotenv").config();

import { loadThread, toPostings } from "../lib/extraction/hn";
import { extractPostings } from "../lib/extraction/pipeline";

// Usage: npm run extract -- [--thread 46108941] [--limit 20 | --ids 1,2,3] [--refresh] [--concurrency 4] [--rpm 60]
//   Extracts postings that are new, failed, stale (prompt version) or edited since last run.
//   --rpm  max requests/minute across all workers (default EXTRACT_RPM or 60); 429s back off and retry
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const threadId = arg("thread") ?? process.env.THREAD_ID ?? "46108941";
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const thread = await loadThread(threadId, { refresh: process.argv.includes("--refresh") });
  const all = toPostings(thread);
  const ids = arg("ids")?.split(",").map(Number);
  if (ids) {
    const missing = ids.filter((id) => !all.some((p) => p.id === id));
    if (missing.length) throw new Error(`Not top-level postings in thread ${threadId}: ${missing.join(", ")}`);
  }
  const postings = ids ? all.filter((p) => ids.includes(p.id)) : all.slice(0, limit);

  const s = await extractPostings(threadId, postings, {
    concurrency: Number(arg("concurrency") ?? process.env.EXTRACT_CONCURRENCY ?? 1),
    rpm: Number(arg("rpm") ?? process.env.EXTRACT_RPM ?? 60),
  });
  console.log(`Done: ${s.ok} ok, ${s.failed} failed, ${s.skipped} up to date. Re-run to retry failures.`);
  if (s.failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
