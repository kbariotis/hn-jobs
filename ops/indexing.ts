require("dotenv").config();

import { closeDb } from "../lib/store/db";
import { indexThread } from "../lib/store/indexer";
import { embedModelId } from "../models/embeddings";

// Loads extractions into Postgres and embeds new/changed role docs. No extraction LLM calls.
// Usage: npm run index -- [--thread 46108941]
const threadArg = process.argv.indexOf("--thread");
const THREAD_ID = threadArg !== -1 ? process.argv[threadArg + 1] : process.env.THREAD_ID ?? "46108941";

indexThread(THREAD_ID)
  .then((s) => {
    if (s.skipped) console.warn(`⚠ Skipping ${s.skipped} failed/stale extractions.`);
    console.log(`✓ Upserted ${s.postings} postings`);
    console.log(`✓ Thread ${THREAD_ID}: ${s.roles} roles, ${s.embedded} newly embedded with ${embedModelId()}`);
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
