import fs from "fs/promises";
import { RateLimiter, isRateLimited } from "../util/rate";
import type { Posting } from "./hn";
import { buildExtractor, extractPosting, extractedPath, isFresh, readExtractions, type ExtractionRecord } from "./extract";
import { extractModelId } from "../../models/extract";

export type ExtractSummary = { total: number; skipped: number; ok: number; failed: number; failedIds: number[]; deferred: number };

// After this many rate-limited failures in a row (each already retried with backoff), the quota
// is gone for now: stop and leave the rest for the next run instead of burning minutes per posting.
const BREAKER_THRESHOLD = 3;

/**
 * Extract postings that are new, failed before, stale (prompt version) or edited (text hash).
 * Appends as it goes (crash-safe), then compacts the file to the last record per id.
 */
export async function extractPostings(
  threadId: string | number,
  postings: Posting[],
  { concurrency = 4, rpm = 60, modelId = extractModelId(), log = console.log }: { concurrency?: number; rpm?: number; modelId?: string; log?: (m: string) => void } = {}
): Promise<ExtractSummary> {
  const out = extractedPath(threadId, modelId);
  const existing = new Map((await readExtractions(out)).map((r) => [r.id, r]));
  const todo = postings.filter((p) => {
    const r = existing.get(p.id);
    return !r || !isFresh(r, p.text);
  });
  const summary: ExtractSummary = { total: postings.length, skipped: postings.length - todo.length, ok: 0, failed: 0, failedIds: [], deferred: 0 };
  log(`${modelId} | thread ${threadId} | ${rpm} rpm | ${postings.length} postings, ${summary.skipped} up to date, ${todo.length} to extract`);
  if (todo.length === 0) return summary;

  await fs.mkdir("data/extracted", { recursive: true });
  const extractor = await buildExtractor(modelId);
  const limiter = new RateLimiter(rpm);
  let next = 0;
  let rateLimitedStreak = 0;
  let tripped = false;
  const worker = async () => {
    while (next < todo.length && !tripped) {
      const posting = todo[next++];
      const rec: ExtractionRecord = await extractPosting(extractor, modelId, posting, { limiter });
      await fs.appendFile(out, JSON.stringify(rec) + "\n");
      if (rec.error) {
        summary.failed++;
        summary.failedIds.push(posting.id);
        log(`✗ ${posting.id} (${rec.latency_ms}ms): ${rec.error.slice(0, 200)}`);
        rateLimitedStreak = isRateLimited(rec.error) ? rateLimitedStreak + 1 : 0;
        if (rateLimitedStreak >= BREAKER_THRESHOLD && !tripped) {
          tripped = true;
          log(`⏸ ${BREAKER_THRESHOLD} rate-limited failures in a row: stopping; the rest is retried next run`);
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

  // Compact: last record per id wins, but never let a new failure overwrite an older success.
  const latest = new Map<number, ExtractionRecord>();
  for (const r of await readExtractions(out)) {
    const prev = latest.get(r.id);
    if (r.error && prev && !prev.error) continue;
    latest.set(r.id, r);
  }
  await fs.writeFile(out, [...latest.values()].map((r) => JSON.stringify(r)).join("\n") + "\n");
  return summary;
}
