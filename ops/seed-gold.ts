require("dotenv").config();

import fs from "fs/promises";
import { loadThread, toPostings } from "../lib/preprocess";
import { extractedPath, readExtractions } from "../lib/extract";
import { extractModelId } from "../models/extract";
import type { GoldFile, GoldPosting } from "../lib/gold";
import { goldPath } from "../lib/gold";

/**
 * Seed draft gold labels from a model's extractions. Drafts are a starting point for
 * human review, NOT ground truth. Existing entries are left alone (drafts may hold partial
 * hand edits); --refresh-drafts replaces drafts. "reviewed" entries are never touched.
 *
 * Usage: EXTRACT_MODEL=... npm run seed-gold -- --ids 1,2,3 [--thread 46108941] [--refresh-drafts]
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const threadId = Number(arg("thread") ?? process.env.THREAD_ID ?? "46108941");
  const ids = arg("ids")?.split(",").map(Number);
  if (!ids?.length) throw new Error("--ids is required");
  const refreshDrafts = process.argv.includes("--refresh-drafts");

  const modelId = extractModelId();
  const extractions = new Map(
    (await readExtractions(extractedPath(threadId, modelId))).map((r) => [r.id, r])
  );
  const postings = new Map(toPostings(await loadThread(threadId)).map((p) => [p.id, p]));

  const path = goldPath(threadId);
  let gold: GoldFile;
  try {
    gold = JSON.parse(await fs.readFile(path, "utf8"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    gold = { thread_id: threadId, postings: [] };
  }
  const existing = new Map(gold.postings.map((p) => [p.id, p]));

  let added = 0;
  let refreshed = 0;
  for (const id of ids) {
    const rec = extractions.get(id);
    const posting = postings.get(id);
    if (!rec || rec.error) throw new Error(`No successful extraction for ${id} with ${modelId}`);
    if (!posting) throw new Error(`${id} is not a top-level posting in thread ${threadId}`);

    const prev = existing.get(id);
    if (prev?.status === "reviewed") continue; // human labels win, always
    if (prev && !refreshDrafts) continue;

    const entry: GoldPosting = {
      id,
      status: "draft",
      seeded_from: `${modelId}@prompt-v${rec.prompt_version}`,
      notes: prev?.notes ?? [],
      text: posting.text,
      roles: rec.roles,
    };
    existing.set(id, entry);
    prev ? refreshed++ : added++;
  }

  gold.postings = [...existing.values()].sort((a, b) => a.id - b.id);
  await fs.mkdir("data/gold", { recursive: true });
  await fs.writeFile(path, JSON.stringify(gold, null, 2) + "\n");

  const reviewed = gold.postings.filter((p) => p.status === "reviewed").length;
  console.log(
    `${path}: +${added} new, ${refreshed} drafts refreshed | ${reviewed}/${gold.postings.length} reviewed`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
