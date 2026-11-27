import type { Queryable } from "./db";
import { db } from "./db";
import type { ExtractionRecord } from "../extraction/extract";

type Row = {
  posting_id: string;
  thread_id: string;
  model: string;
  prompt_version: string;
  text_sha: string | null;
  author: string | null;
  posted_at: Date;
  latency_ms: number;
  roles: ExtractionRecord["roles"];
  warnings: ExtractionRecord["warnings"] | null;
  error: string | null;
};

const toRecord = (r: Row): ExtractionRecord => ({
  id: Number(r.posting_id),
  thread_id: Number(r.thread_id),
  author: r.author,
  time: Math.floor(r.posted_at.getTime() / 1000),
  model: r.model,
  prompt_version: r.prompt_version,
  latency_ms: r.latency_ms,
  ...(r.text_sha ? { text_sha: r.text_sha } : {}),
  roles: r.roles,
  ...(r.warnings ? { warnings: r.warnings } : {}),
  ...(r.error ? { error: r.error } : {}),
});

/** Postgres extraction store: what the hosted ingest job reads and writes. */
export async function loadExtractions(
  threadId: number,
  model: string,
  q: Queryable = db(),
): Promise<ExtractionRecord[]> {
  const { rows } = await q.query<Row>(
    `SELECT posting_id, thread_id, model, prompt_version, text_sha, author, posted_at, latency_ms,
            roles, warnings, error
     FROM extractions WHERE thread_id = $1 AND model = $2 ORDER BY posting_id`,
    [threadId, model],
  );
  return rows.map(toRecord);
}

/**
 * Upsert one record. The WHERE clause is `keepPrevious` (lib/extraction/pipeline.ts) in SQL:
 * a new failure never overwrites an older success.
 */
export async function saveExtraction(rec: ExtractionRecord, q: Queryable = db()): Promise<void> {
  await q.query(
    `INSERT INTO extractions (thread_id, posting_id, model, prompt_version, text_sha, author,
       posted_at, latency_ms, roles, warnings, error)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7), $8, $9, $10, $11)
     ON CONFLICT (thread_id, posting_id, model) DO UPDATE SET
       prompt_version = EXCLUDED.prompt_version, text_sha = EXCLUDED.text_sha,
       author = EXCLUDED.author, posted_at = EXCLUDED.posted_at,
       latency_ms = EXCLUDED.latency_ms, roles = EXCLUDED.roles, warnings = EXCLUDED.warnings,
       error = EXCLUDED.error, updated_at = now()
     WHERE extractions.error IS NOT NULL OR EXCLUDED.error IS NULL`,
    [
      rec.thread_id,
      rec.id,
      rec.model,
      rec.prompt_version,
      rec.text_sha ?? null,
      rec.author,
      rec.time,
      rec.latency_ms,
      JSON.stringify(rec.roles),
      rec.warnings ? JSON.stringify(rec.warnings) : null,
      rec.error ?? null,
    ],
  );
}
