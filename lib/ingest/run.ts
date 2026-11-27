import { latestHiringThread, loadThread, toPostings } from "../extraction/hn";
import { extractPostings, type ExtractSummary } from "../extraction/pipeline";
import { indexThread, indexedPostingIds, needsIndex, type IndexSummary } from "../store/indexer";
import { loadExtractions, saveExtraction } from "../store/extractions";
import { acquireLease, finishRun, startRun, type RunStatus } from "../store/ingest-runs";
import { extractModelId } from "../../models/extract";

export const MIN_COVERAGE = 0.99;
// Unbounded runs (CLI, VPS timer): a crashed run must not block the next one for long.
const DEFAULT_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

export type IngestResult =
  | { status: "busy" }
  | {
      status: RunStatus;
      threadId: number;
      title: string;
      postings: number;
      coverage: number;
      extract: ExtractSummary;
      /** null when nothing changed and indexing was skipped */
      index: IndexSummary | null;
      seconds: number;
    };

export type IngestOptions = {
  threadId?: number;
  rpm?: number;
  concurrency?: number;
  log?: (m: string) => void;
  /**
   * Time box for extraction (ms). After it, no new posting starts; the rest is `deferred` and
   * the run ends `partial`, to be continued by the next run. Unset = run to completion.
   */
  extractBudgetMs?: number;
  /** Per-call model timeout / 429 retries; tighten them for time-boxed runs. */
  timeoutMs?: number;
  retries?: number;
  /** Lease length: must exceed the longest a run can live (e.g. the function's max duration). */
  leaseTtlMs?: number;
};

/**
 * Keep the database in sync with the current "Who is hiring?" thread, entirely through
 * Postgres (no disk): find the thread, fetch it, extract new/edited/failed postings into the
 * `extractions` table, index if anything changed, record the run. Idempotent and safe to run
 * concurrently or twice (one run at a time via a lease; finished postings are skipped).
 *
 * Used by `npm run daily` / a VPS timer (unbounded) and by the scheduled Vercel function
 * (api/ingest.ts: time-boxed, continued by the next run).
 */
export async function runIngest({
  threadId,
  rpm = 60,
  concurrency = 4,
  log = console.log,
  extractBudgetMs,
  timeoutMs,
  retries,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
}: IngestOptions = {}): Promise<IngestResult> {
  const lease = await acquireLease(leaseTtlMs);
  if (!lease) {
    return { status: "busy" };
  }
  const started = Date.now();
  const runId = await startRun();
  let target: { id: number; title: string } | undefined;
  try {
    target = threadId ? { id: threadId, title: `thread ${threadId}` } : await latestHiringThread();
    log(`→ ${target.title} (${target.id})`);

    const modelId = extractModelId();
    const postings = toPostings(await loadThread(target.id, { refresh: true, save: false }));
    const extract = await extractPostings(target.id, postings, {
      existing: await loadExtractions(target.id, modelId),
      save: (rec) => saveExtraction(rec),
      modelId,
      rpm,
      concurrency,
      log,
      deadline: extractBudgetMs === undefined ? undefined : started + extractBudgetMs,
      timeoutMs,
      retries,
    });

    const records = await loadExtractions(target.id, modelId);
    const live = new Set(postings.map((p) => p.id));
    const shouldIndex = needsIndex({
      extracted: extract.ok,
      indexed: await indexedPostingIds(target.id),
      live,
      hasExtractions: records.some((r) => !r.error),
    });
    const index = shouldIndex
      ? await indexThread(target.id, records, { livePostingIds: [...live], log: () => {} })
      : null;

    const done = postings.length - extract.failed - extract.deferred;
    const coverage = done / (postings.length || 1);
    let status: RunStatus = "ok";
    if (extract.deferred > 0) {
      status = "partial";
    } else if (coverage < MIN_COVERAGE) {
      status = "low_coverage";
    }
    const result = {
      status,
      threadId: target.id,
      title: target.title,
      postings: postings.length,
      coverage,
      extract,
      index,
      seconds: Math.round((Date.now() - started) / 1000),
    };
    const { status: _status, ...summary } = result;
    await finishRun(runId, status, { threadId: target.id, summary });
    return result;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await finishRun(runId, "failed", { threadId: target?.id, summary: { error } });
    throw e;
  } finally {
    await lease.release();
  }
}
