require("dotenv").config();

import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { db, closeDb, toVector } from "../lib/db";
import { extractedPath, readExtractions, type ExtractionRecord } from "../lib/extract";
import { roleDoc } from "../lib/role-doc";
import { extractModelId } from "../models/extract";
import { embedModelId, getEmbeddings } from "../models/embeddings";
import { PROMPT_VERSION } from "../prompts/extract";

// Loads extractions into Postgres and embeds new/changed role docs. No extraction LLM calls.
// Idempotent: re-running upserts rows, drops roles a posting no longer has, and skips
// embeddings whose doc text is unchanged.
// Usage: npm run index -- [--thread 46108941]
const threadArg = process.argv.indexOf("--thread");
const THREAD_ID = threadArg !== -1 ? process.argv[threadArg + 1] : process.env.THREAD_ID ?? "46108941";
const EMBED_BATCH = 50;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function upsertPosting(client: PoolClient, rec: ExtractionRecord) {
  await client.query("BEGIN");
  try {
    for (const [i, r] of rec.roles.entries()) {
      await client.query(
        `INSERT INTO roles (role_id, posting_id, role_index, thread_id, posted_at, extract_model, prompt_version,
           company_name, role_title, employment_type, remote_policy, seniority, remote_regions, timezones,
           countries, cities, tech_stack, salary_min, salary_max, salary_currency, salary_period,
           visa_sponsorship, apply_url, apply_email, data, doc)
         VALUES ($1,$2,$3,$4,to_timestamp($5),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (role_id) DO UPDATE SET
           posted_at = EXCLUDED.posted_at, extract_model = EXCLUDED.extract_model, prompt_version = EXCLUDED.prompt_version,
           company_name = EXCLUDED.company_name, role_title = EXCLUDED.role_title, employment_type = EXCLUDED.employment_type,
           remote_policy = EXCLUDED.remote_policy, seniority = EXCLUDED.seniority, remote_regions = EXCLUDED.remote_regions,
           timezones = EXCLUDED.timezones, countries = EXCLUDED.countries, cities = EXCLUDED.cities,
           tech_stack = EXCLUDED.tech_stack, salary_min = EXCLUDED.salary_min, salary_max = EXCLUDED.salary_max,
           salary_currency = EXCLUDED.salary_currency, salary_period = EXCLUDED.salary_period,
           visa_sponsorship = EXCLUDED.visa_sponsorship, apply_url = EXCLUDED.apply_url,
           apply_email = EXCLUDED.apply_email, data = EXCLUDED.data, doc = EXCLUDED.doc`,
        [
          `${rec.id}-${i}`, rec.id, i, rec.thread_id, rec.time, rec.model, rec.prompt_version,
          r.company_name, r.role_title, r.employment_type, r.remote_policy, r.seniority, r.remote_regions, r.timezones,
          [...new Set(r.locations.map((l) => l.country_code).filter(Boolean))],
          [...new Set(r.locations.map((l) => l.city).filter(Boolean))],
          r.tech_stack, r.salary?.min ?? null, r.salary?.max ?? null, r.salary?.currency ?? null, r.salary?.period ?? null,
          r.visa_sponsorship, r.apply_url, r.apply_email, JSON.stringify(r), roleDoc(r),
        ]
      );
    }
    // A re-extraction can yield fewer roles; drop the leftovers (embeddings cascade).
    await client.query("DELETE FROM roles WHERE posting_id = $1 AND role_index >= $2", [rec.id, rec.roles.length]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function main() {
  const modelId = extractModelId();
  const path = extractedPath(THREAD_ID, modelId);
  const all = await readExtractions(path);
  const records = all.filter((r) => !r.error && r.prompt_version === PROMPT_VERSION);
  if (records.length === 0) throw new Error(`No v${PROMPT_VERSION} extractions at ${path}. Run \`npm run extract\` first.`);
  if (records.length < all.length) console.warn(`⚠ Skipping ${all.length - records.length} failed/stale extractions.`);

  const pool = db();
  const client = await pool.connect();
  try {
    for (const rec of records) await upsertPosting(client, rec);
  } finally {
    client.release();
  }
  console.log(`✓ Upserted ${records.length} postings from ${path}`);

  // Embed rows whose doc changed (or were never embedded) for this embedding model.
  const embedModel = embedModelId();
  const { rows } = await pool.query<{ role_id: string; doc: string }>(
    `SELECT r.role_id, r.doc FROM roles r
     LEFT JOIN role_embeddings e ON e.role_id = r.role_id AND e.embed_model = $1
     WHERE r.thread_id = $2 AND (e.doc_hash IS NULL OR e.doc_hash <> encode(sha256(convert_to(r.doc, 'UTF8')), 'hex'))`,
    [embedModel, THREAD_ID]
  );
  const embedder = getEmbeddings("document", embedModel);
  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const batch = rows.slice(i, i + EMBED_BATCH);
    const vectors = await embedder.embedDocuments(batch.map((r) => r.doc));
    for (const [j, r] of batch.entries()) {
      if (!vectors[j]?.length) throw new Error(`Empty embedding for ${r.role_id}`);
      await pool.query(
        `INSERT INTO role_embeddings (role_id, embed_model, doc_hash, embedding) VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (role_id, embed_model) DO UPDATE SET doc_hash = EXCLUDED.doc_hash, embedding = EXCLUDED.embedding`,
        [r.role_id, embedModel, sha(r.doc), toVector(vectors[j])]
      );
    }
    console.log(`  embedded ${Math.min(i + EMBED_BATCH, rows.length)}/${rows.length}`);
  }
  const { rows: [count] } = await pool.query<{ roles: string; embedded: string }>(
    `SELECT count(*) AS roles, count(e.role_id) AS embedded FROM roles r
     LEFT JOIN role_embeddings e ON e.role_id = r.role_id AND e.embed_model = $1 WHERE r.thread_id = $2`,
    [embedModel, THREAD_ID]
  );
  console.log(`✓ Thread ${THREAD_ID}: ${count.roles} roles, ${count.embedded} embedded with ${embedModel}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
