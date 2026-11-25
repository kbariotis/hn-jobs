require("dotenv").config();

import fs from "fs/promises";
import { latestHiringThread, loadThread, toPostings } from "../lib/preprocess";
import { extractPostings } from "../lib/pipeline";
import { indexThread } from "../lib/indexer";
import { closeDb } from "../lib/db";

/**
 * Daily job: keep the index in sync with the current "Who is hiring?" thread.
 *   1. find the newest thread   2. refresh its snapshot
 *   3. extract postings that are new / edited / previously failed   4. index (+ prune deleted)
 * Safe to run repeatedly; a lock file prevents overlapping runs.
 *
 * Usage: npm run daily -- [--thread <id>] [--rpm 60] [--concurrency 4]
 * Exit code 1 on a hard failure, or when coverage drops below MIN_COVERAGE (failures are
 * retried on the next run either way).
 */
const LOCK = "data/.daily.lock";
const STALE_LOCK_MS = 6 * 60 * 60 * 1000; // a crashed run must not block tomorrow's
const MIN_COVERAGE = 0.99;

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function acquireLock(): Promise<boolean> {
  await fs.mkdir("data", { recursive: true });
  try {
    await fs.writeFile(LOCK, String(process.pid), { flag: "wx" });
    return true;
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const { mtimeMs } = await fs.stat(LOCK);
    if (Date.now() - mtimeMs < STALE_LOCK_MS) return false;
    console.warn("⚠ Removing stale lock from a crashed run");
    await fs.rm(LOCK);
    return acquireLock();
  }
}

async function main() {
  if (!(await acquireLock())) {
    console.log("Another run is in progress; exiting.");
    return;
  }
  const started = Date.now();
  try {
    const target = arg("thread") ? { id: Number(arg("thread")), title: `thread ${arg("thread")}` } : await latestHiringThread();
    console.log(`→ ${target.title} (${target.id})`);

    const postings = toPostings(await loadThread(target.id, { refresh: true }));
    const ex = await extractPostings(target.id, postings, {
      rpm: Number(arg("rpm") ?? process.env.EXTRACT_RPM ?? 60),
      concurrency: Number(arg("concurrency") ?? 4),
      log: (m) => (m.startsWith("✓") ? undefined : console.log(m)), // keep the daily log short
    });
    const idx = await indexThread(target.id, { livePostingIds: postings.map((p) => p.id), log: () => {} });

    const coverage = (postings.length - ex.failed - ex.deferred) / (postings.length || 1);
    console.log(
      `✓ ${postings.length} postings | ${ex.ok} extracted, ${ex.skipped} unchanged, ${ex.failed} failed, ${ex.deferred} deferred` +
        ` | index: ${idx.roles} roles, ${idx.embedded} embedded, ${idx.pruned} pruned` +
        ` | coverage ${(coverage * 100).toFixed(1)}% | ${Math.round((Date.now() - started) / 1000)}s`
    );
    if (ex.failedIds.length) console.log(`  still failing (retried next run): ${ex.failedIds.join(", ")}`);
    if (coverage < MIN_COVERAGE) process.exitCode = 1;
  } finally {
    await fs.rm(LOCK, { force: true });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
