import { randomUUID } from "crypto";
import type { Queryable } from "./db";
import { db } from "./db";

const LOCK = "ingest";

export type Lease = { holder: string; release: () => Promise<void> };

/**
 * Take the ingest lease, or return null if another run holds a live one. Atomic: the upsert only
 * takes over an expired lease. `ttlMs` bounds how long a crashed run can block the next one.
 */
export async function acquireLease(ttlMs: number, q: Queryable = db()): Promise<Lease | null> {
  const holder = randomUUID();
  const { rowCount } = await q.query(
    `INSERT INTO ingest_lock (name, holder, lease_until)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, lease_until = EXCLUDED.lease_until
     WHERE ingest_lock.lease_until < now()`,
    [LOCK, holder, ttlMs / 1000],
  );
  if (!rowCount) {
    return null;
  }
  return {
    holder,
    release: async () => {
      // Only our own lease: a run that outlived its TTL must not free a newer run's lease.
      await q.query("UPDATE ingest_lock SET lease_until = now() WHERE name = $1 AND holder = $2", [
        LOCK,
        holder,
      ]);
    },
  };
}

export type RunStatus = "ok" | "low_coverage" | "failed";

export async function startRun(q: Queryable = db()): Promise<number> {
  const { rows } = await q.query<{ id: string }>(
    "INSERT INTO ingest_runs DEFAULT VALUES RETURNING id",
  );
  return Number(rows[0].id);
}

export async function finishRun(
  id: number,
  status: RunStatus,
  { threadId, summary }: { threadId?: number; summary: unknown },
  q: Queryable = db(),
): Promise<void> {
  await q.query(
    `UPDATE ingest_runs SET finished_at = now(), status = $2, thread_id = $3, summary = $4
     WHERE id = $1`,
    [id, status, threadId ?? null, JSON.stringify(summary)],
  );
}
