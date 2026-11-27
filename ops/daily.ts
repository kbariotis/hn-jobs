import "dotenv/config";

import { runIngest } from "../lib/ingest/run";
import { closeDb } from "../lib/store/db";

/**
 * Daily job: keep the database in sync with the current "Who is hiring?" thread
 * (see lib/ingest/run.ts). Everything goes through Postgres; nothing is written to disk.
 * Safe to run repeatedly; a database lease prevents overlapping runs on any host.
 *
 * Usage: npm run daily -- [--thread <id>] [--rpm 60] [--concurrency 4]
 * Exit code 1 on a hard failure, or when coverage drops below MIN_COVERAGE (failures are
 * retried on the next run either way). Run history: SELECT * FROM ingest_runs.
 */
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function main() {
  const r = await runIngest({
    threadId: arg("thread") ? Number(arg("thread")) : undefined,
    rpm: Number(arg("rpm") ?? process.env.EXTRACT_RPM ?? 60),
    concurrency: Number(arg("concurrency") ?? 4),
    log: (m) => (m.startsWith("✓") ? undefined : console.log(m)), // keep the daily log short
  });
  if (r.status === "busy") {
    console.log("Another run is in progress; exiting.");
    return;
  }
  const { extract: ex, index: idx } = r;
  console.log(
    `✓ ${r.postings} postings | ${ex.ok} extracted, ${ex.skipped} unchanged, ${ex.failed} failed, ${ex.deferred} deferred` +
      ` | index: ${idx.roles} roles, ${idx.embedded} embedded, ${idx.pruned} pruned` +
      ` | coverage ${(r.coverage * 100).toFixed(1)}% | ${r.seconds}s`,
  );
  if (ex.failedIds.length) {
    console.log(`  still failing (retried next run): ${ex.failedIds.join(", ")}`);
  }
  if (r.status !== "ok") {
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
