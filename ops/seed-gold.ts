import "dotenv/config";

import fs from "fs/promises";
import { loadThread, toPostings } from "../lib/extraction/hn";
import { extractedPath, readExtractions } from "../lib/extraction/extract";
import { extractModelId } from "../models/extract";
import type { GoldFile, GoldPosting } from "../lib/evals/gold";
import { goldPath } from "../lib/evals/gold";
import type { Role } from "../lib/schema";
import { isNotFound } from "../lib/util/fs";

/**
 * Seed draft gold labels from a model's extractions. Drafts are a starting point for
 * human review, NOT ground truth. Existing entries are left alone (drafts may hold partial
 * hand edits); --refresh-drafts replaces drafts. "reviewed" entries are never touched.
 *
 * Usage: EXTRACT_MODEL=... npm run seed-gold -- (--ids 1,2,3 | --sample 25 [--seed 1]) [--thread 46108941]
 *          [--refresh-drafts] [--blank]
 *   --sample N  pick N random top-level postings (reproducible with --seed); job or not, so
 *               the sample isn't filtered by the model we're evaluating
 *   --blank     draft with no roles, for blind labelling (pair with `npm run review -- --blind`)
 *   --skeleton  roles from the model with only company + title kept; every other field empty.
 *               Fields stay blind; role segmentation is anchored on the model (so the held-out
 *               set no longer tests role counts).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const threadId = Number(arg("thread") ?? process.env.THREAD_ID ?? "46108941");
  const postingsList = toPostings(await loadThread(threadId));
  const sample = arg("sample");
  const ids = sample
    ? sampleIds(
        postingsList.map((p) => p.id),
        Number(sample),
        Number(arg("seed") ?? 1),
      )
    : arg("ids")?.split(",").map(Number);
  if (!ids?.length) throw new Error("--ids or --sample is required");
  const blank = process.argv.includes("--blank");
  const skeleton = process.argv.includes("--skeleton");
  if (blank && skeleton) throw new Error("--blank and --skeleton are exclusive");
  const refreshDrafts = process.argv.includes("--refresh-drafts");

  const modelId = extractModelId();
  const extractions = new Map((await readExtractions(extractedPath(threadId, modelId))).map((r) => [r.id, r]));
  const postings = new Map(postingsList.map((p) => [p.id, p]));

  const path = goldPath(threadId);
  let gold: GoldFile;
  try {
    gold = JSON.parse(await fs.readFile(path, "utf8"));
  } catch (e) {
    if (!isNotFound(e)) throw e;
    gold = { thread_id: threadId, postings: [] };
  }
  const existing = new Map(gold.postings.map((p) => [p.id, p]));

  let added = 0;
  let refreshed = 0;
  for (const id of ids) {
    const rec = extractions.get(id);
    const posting = postings.get(id);
    if (!blank && (!rec || rec.error)) throw new Error(`No successful extraction for ${id} with ${modelId}`);
    if (!posting) throw new Error(`${id} is not a top-level posting in thread ${threadId}`);

    const prev = existing.get(id);
    if (prev?.status === "reviewed") continue; // human labels win, always
    if (prev && !refreshDrafts) continue;

    const entry: GoldPosting = {
      id,
      status: "draft",
      seeded_from: blank ? "blank" : `${skeleton ? "skeleton:" : ""}${modelId}@prompt-v${rec!.prompt_version}`,
      notes: prev?.notes ?? [],
      text: posting.text,
      roles: blank ? [] : skeleton ? rec!.roles.map(skeletonRole) : rec!.roles,
    };
    existing.set(id, entry);
    if (prev) refreshed++;
    else added++;
  }

  gold.postings = [...existing.values()].sort((a, b) => a.id - b.id);
  await fs.mkdir("data/gold", { recursive: true });
  await fs.writeFile(path, JSON.stringify(gold, null, 2) + "\n");

  const reviewed = gold.postings.filter((p) => p.status === "reviewed").length;
  console.log(`${path}: +${added} new, ${refreshed} drafts refreshed | ${reviewed}/${gold.postings.length} reviewed`);
}

const skeletonRole = (r: Role): Role => ({
  company_name: r.company_name,
  role_title: r.role_title,
  employment_type: null,
  remote_policy: null,
  remote_regions: [],
  timezones: [],
  locations: [],
  seniority: null,
  tech_stack: [],
  salary: null,
  visa_sponsorship: null,
  apply_url: null,
  apply_email: null,
  description: "",
});

/** Deterministic shuffle (mulberry32) so a sample can be re-derived from its seed. */
function sampleIds(ids: number[], n: number, seed: number): number[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const xs = [...ids].sort((x, y) => x - y);
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs.slice(0, n);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
