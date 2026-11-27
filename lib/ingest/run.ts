import { latestHiringThread, loadThread, toPostings } from "../extraction/hn";
import { extractPostings, type ExtractSummary } from "../extraction/pipeline";
import { indexThread, type IndexSummary } from "../store/indexer";
import { loadExtractions, saveExtraction } from "../store/extractions";
import { acquireLease, finishRun, startRun, type RunStatus } from "../store/ingest-runs";
import { extractModelId } from "../../models/extract";

export const MIN_COVERAGE = 0.99;
// A crashed run must not block the next one for long; a healthy run finishes well within this.
const LEASE_TTL_MS = 2 * 60 * 60 * 1000;

export type IngestResult =
  | { status: "busy" }
  | {
      status: RunStatus;
      threadId: number;
      title: string;
      postings: number;
      coverage: number;
      extract: ExtractSummary;
      index: IndexSummary;
      seconds: number;
    };

/**
 * Keep the database in sync with the current "Who is hiring?" thread, entirely through
 * Postgres (no disk): find the thread, fetch it, extract new/edited/failed postings into the
 * `extractions` table, index, record the run. Idempotent; one run at a time via a lease.
 *
 * Used by `npm run daily` (and a VPS timer). The hosted workflow runs the same pieces as
 * separate steps.
 */
export async function runIngest({
  threadId,
  rpm = 60,
  concurrency = 4,
  log = console.log,
}: {
  threadId?: number;
  rpm?: number;
  concurrency?: number;
  log?: (m: string) => void;
} = {}): Promise<IngestResult> {
  const lease = await acquireLease(LEASE_TTL_MS);
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
    });
    const index = await indexThread(target.id, await loadExtractions(target.id, modelId), {
      livePostingIds: postings.map((p) => p.id),
      log: () => {},
    });

    const done = postings.length - extract.failed - extract.deferred;
    const coverage = done / (postings.length || 1);
    const status: RunStatus = coverage < MIN_COVERAGE ? "low_coverage" : "ok";
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
