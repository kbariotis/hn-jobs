import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { db, toVector } from "./db";
import { extractedPath, readExtractions, type ExtractionRecord } from "./extract";
import { roleDoc } from "./role-doc";
import { extractModelId } from "../models/extract";
import { embedModelId, getEmbeddings } from "../models/embeddings";
import { PROMPT_VERSION } from "../prompts/extract";

const EMBED_BATCH = 50;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type IndexSummary = { postings: number; skipped: number; pruned: number; embedded: number; roles: number };

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

/**
 * Load a thread's extractions into Postgres and embed new/changed role docs. Idempotent:
 * upserts rows, drops roles a posting no longer has, skips embeddings whose doc is unchanged.
 * `livePostingIds`: postings currently in the thread; anything else indexed for it (deleted
 * comments) is removed.
 */
export async function indexThread(
  threadId: string | number,
  { embedModel = embedModelId(), livePostingIds, log = console.log }: { embedModel?: string; livePostingIds?: number[]; log?: (m: string) => void } = {}
): Promise<IndexSummary> {
  const path = extractedPath(threadId, extractModelId());
  const all = await readExtractions(path);
  const live = livePostingIds ? new Set(livePostingIds) : null;
  const records = all.filter((r) => !r.error && r.prompt_version === PROMPT_VERSION && (!live || live.has(r.id)));
  if (records.length === 0) throw new Error(`No v${PROMPT_VERSION} extractions at ${path}. Run \`npm run extract\` first.`);

  const pool = db();
  const client = await pool.connect();
  try {
    for (const rec of records) await upsertPosting(client, rec);
  } finally {
    client.release();
  }
  let pruned = 0;
  if (live) {
    const res = await pool.query("DELETE FROM roles WHERE thread_id = $1 AND NOT (posting_id = ANY($2::bigint[]))", [threadId, [...live]]);
    pruned = res.rowCount ?? 0;
  }

  const { rows } = await pool.query<{ role_id: string; doc: string }>(
    `SELECT r.role_id, r.doc FROM roles r
     LEFT JOIN role_embeddings e ON e.role_id = r.role_id AND e.embed_model = $1
     WHERE r.thread_id = $2 AND (e.doc_hash IS NULL OR e.doc_hash <> encode(sha256(convert_to(r.doc, 'UTF8')), 'hex'))`,
    [embedModel, threadId]
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
    log(`  embedded ${Math.min(i + EMBED_BATCH, rows.length)}/${rows.length}`);
  }
  const { rows: [count] } = await pool.query<{ roles: string }>("SELECT count(*) AS roles FROM roles WHERE thread_id = $1", [threadId]);
  return { postings: records.length, skipped: all.length - records.length, pruned, embedded: rows.length, roles: Number(count.roles) };
}
