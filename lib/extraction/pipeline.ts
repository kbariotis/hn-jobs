import fs from "fs/promises";
import { RateLimiter, isRateLimited } from "../util/rate";
import type { Posting } from "./hn";
import {
  buildExtractor,
  extractPosting,
  extractedPath,
  isFresh,
  readExtractions,
  type ExtractionRecord,
} from "./extract";
import { extractModelId } from "../../models/extract";

export type ExtractSummary = {
  total: number;
  skipped: number;
  ok: number;
  failed: number;
  failedIds: number[];
  deferred: number;
};

// After this many rate-limited failures in a row (each already retried with backoff), the quota
// is gone for now: stop and leave the rest for the next run instead of burning minutes per posting.
const BREAKER_THRESHOLD = 3;

/** Postings that need a (re-)extraction: new, failed, stale prompt version, or edited text. */
export function planExtraction(postings: Posting[], existing: ExtractionRecord[]): Posting[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  return postings.filter((p) => {
    const r = byId.get(p.id);
    return !r || !isFresh(r, p.text);
  });
}

/**
 * Merge rule shared by every store: the newest record wins, except that a new failure never
 * replaces an older success (a transient 429 must not wipe a posting's roles).
 * The Postgres store mirrors this in its upsert; keep the two in sync.
 */
export const keepPrevious = (prev: ExtractionRecord | undefined, next: ExtractionRecord) =>
  !!next.error && !!prev && !prev.error;

export type ExtractOptions = {
  /** What the store already holds for this thread and model. */
  existing: ExtractionRecord[];
  /** Persist one record as soon as it's produced (crash-safe). */
  save: (rec: ExtractionRecord) => Promise<void>;
  concurrency?: number;
  rpm?: number;
  modelId?: string;
  log?: (m: string) => void;
  /**
   * Epoch ms after which no new posting is started (time-boxed runs). Unstarted postings count
   * as `deferred` and are picked up next run, since planExtraction skips finished ones.
   */
  deadline?: number;
  /** Per-call model timeout and 429 retries (defaults suit unbounded CLI runs). */
  timeoutMs?: number;
  retries?: number;
};

/**
 * Extract what `planExtraction` says is missing, rate-limited, with a circuit breaker on quota
 * exhaustion. Storage-agnostic: callers pass what exists and how to save.
 */
export async function extractPostings(
  threadId: string | number,
  postings: Posting[],
  {
    existing,
    save,
    concurrency = 4,
    rpm = 60,
    modelId = extractModelId(),
    log = console.log,
    deadline,
    timeoutMs,
    retries,
  }: ExtractOptions,
): Promise<ExtractSummary> {
  const todo = planExtraction(postings, existing);
  const summary: ExtractSummary = {
    total: postings.length,
    skipped: postings.length - todo.length,
    ok: 0,
    failed: 0,
    failedIds: [],
    deferred: 0,
  };
  log(
    `${modelId} | thread ${threadId} | ${rpm} rpm | ${postings.length} postings, ${summary.skipped} up to date, ${todo.length} to extract`,
  );
  if (todo.length === 0) {
    return summary;
  }

  const extractor = await buildExtractor(modelId);
  const limiter = new RateLimiter(rpm);
  let next = 0;
  let rateLimitedStreak = 0;
  let tripped = false;
  const worker = async () => {
    while (next < todo.length && !tripped) {
      if (deadline !== undefined && Date.now() >= deadline) {
        return; // time box reached: leave the rest for the next run
      }
      const posting = todo[next++];
      const rec: ExtractionRecord = await extractPosting(extractor, modelId, posting, {
        limiter,
        timeoutMs,
        retries,
      });
      await save(rec);
      if (rec.error) {
        summary.failed++;
        summary.failedIds.push(posting.id);
        log(`✗ ${posting.id} (${rec.latency_ms}ms): ${rec.error.slice(0, 200)}`);
        rateLimitedStreak = isRateLimited(rec.error) ? rateLimitedStreak + 1 : 0;
        if (rateLimitedStreak >= BREAKER_THRESHOLD && !tripped) {
          tripped = true;
          log(
            `⏸ ${BREAKER_THRESHOLD} rate-limited failures in a row: stopping; the rest is retried next run`,
          );
        }
      } else {
        rateLimitedStreak = 0;
        summary.ok++;
        log(`✓ ${posting.id} (${rec.latency_ms}ms): ${rec.roles.length} role(s)`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  summary.deferred = todo.length - summary.ok - summary.failed;
  return summary;
}

/** Last record per id, applying `keepPrevious`. */
export function compact(records: ExtractionRecord[]): ExtractionRecord[] {
  const latest = new Map<number, ExtractionRecord>();
  for (const r of records) {
    if (!keepPrevious(latest.get(r.id), r)) {
      latest.set(r.id, r);
    }
  }
  return [...latest.values()];
}

/**
 * JSONL store (local runs and evals): appends as it goes, then compacts the file to one record
 * per posting.
 */
export async function extractToFile(
  threadId: string | number,
  postings: Posting[],
  opts: Omit<ExtractOptions, "existing" | "save"> = {},
): Promise<ExtractSummary> {
  const modelId = opts.modelId ?? extractModelId();
  const out = extractedPath(threadId, modelId);
  await fs.mkdir("data/extracted", { recursive: true });
  const summary = await extractPostings(threadId, postings, {
    ...opts,
    modelId,
    existing: await readExtractions(out),
    save: (rec) => fs.appendFile(out, JSON.stringify(rec) + "\n"),
  });
  if (summary.ok + summary.failed > 0) {
    const records = compact(await readExtractions(out));
    await fs.writeFile(out, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return summary;
}
