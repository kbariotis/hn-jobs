import "dotenv/config";

import { extractedPath, readExtractions } from "../lib/extraction/extract";
import { saveExtraction } from "../lib/store/extractions";
import { closeDb, db } from "../lib/store/db";
import { extractModelId } from "../models/extract";

/**
 * One-off seed: copy a thread's local JSONL extractions into the `extractions` table, so the
 * hosted ingest job skips postings already extracted (it only redoes new, edited, failed or
 * stale ones). Same merge rule as every save: a failure never overwrites a success.
 *
 * Usage: DOTENV_CONFIG_PATH=.env.production.local npm run import-extractions -- --thread <id>
 */
async function main() {
  const i = process.argv.indexOf("--thread");
  const threadId = i === -1 ? process.env.THREAD_ID : process.argv[i + 1];
  if (!threadId) {
    throw new Error("--thread <id> is required");
  }
  const records = await readExtractions(extractedPath(threadId, extractModelId()));
  if (!records.length) {
    throw new Error(`No local extractions for thread ${threadId}. Run \`npm run extract\`.`);
  }
  const host = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
  console.log(`Importing ${records.length} records for thread ${threadId} into ${host}…`);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    for (const rec of records) {
      await saveExtraction(rec, client);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  const ok = records.filter((r) => !r.error).length;
  console.log(`✓ ${records.length} imported (${ok} successful, ${records.length - ok} failed)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
