import type { IncomingMessage, ServerResponse } from "http";
// Starts registering OpenTelemetry (Vercel Tracing) as soon as the function loads.
import { telemetryReady } from "../lib/telemetry/register";
import { runIngest } from "../lib/ingest/run";
import { withSpan } from "../lib/telemetry/tracing";

/**
 * Scheduled ingest (Vercel Schedules, function target; see vercel.json `schedules.ingest`).
 *
 * The schedule trigger makes this function private: it has no public URL and only Vercel's
 * scheduler can invoke it, so no secret is needed. As a guard against misconfiguration it still
 * rejects anything that isn't a schedule run (CloudEvents `ce-type` header).
 *
 * Each run is time-boxed to fit the function's max duration (300 s on Hobby): extraction stops
 * starting new postings after EXTRACT_BUDGET_MS, then whatever was extracted is indexed. The rest
 * is picked up by the next run. Vercel doesn't retry failed runs and can deliver one twice or
 * overlap two; the DB lease and "skip what's done" planning make that harmless.
 */
const SCHEDULE_EVENT = "com.vercel.schedule.v1beta";

// Budget: 180 s of extraction + at most one in-flight call (60 s) + indexing < 300 s.
const EXTRACT_BUDGET_MS = 180_000;
const CALL_TIMEOUT_MS = 60_000;
const RETRIES = 1; // one 429 retry; a quota problem waits for the next run instead of the clock
const LEASE_TTL_MS = 6 * 60_000; // > max duration, so a run killed at 300 s frees the lease
const EXTRACT_RPM = Number(process.env.EXTRACT_RPM ?? 60);

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await telemetryReady;
  if (req.headers["ce-type"] !== SCHEDULE_EVENT) {
    return send(res, 400, { error: "Not a schedule run" });
  }
  try {
    const r = await withSpan("ingest.run", {}, async (span) => {
      const result = await runIngest({
        rpm: EXTRACT_RPM,
        extractBudgetMs: EXTRACT_BUDGET_MS,
        timeoutMs: CALL_TIMEOUT_MS,
        retries: RETRIES,
        leaseTtlMs: LEASE_TTL_MS,
        log: (m) => (m.startsWith("✓") ? undefined : console.log(m)),
      });
      span.setAttribute("app.ingest.status", result.status);
      if (result.status !== "busy") {
        span.setAttributes({
          "app.ingest.extracted": result.extract.ok,
          "app.ingest.failed": result.extract.failed,
          "app.ingest.deferred": result.extract.deferred,
          "app.ingest.indexed": result.index !== null,
        });
      }
      return result;
    });
    if (r.status === "busy") {
      console.log("ingest: another run holds the lease; skipping");
      return send(res, 200, { status: "busy" });
    }
    console.log(
      `ingest: ${r.status} | thread ${r.threadId} | ${r.extract.ok} extracted, ` +
        `${r.extract.failed} failed, ${r.extract.deferred} deferred | ` +
        `index ${r.index ? "updated" : "skipped"} | ${r.seconds}s`,
    );
    return send(res, 200, {
      status: r.status,
      extracted: r.extract.ok,
      failed: r.extract.failed,
      deferred: r.extract.deferred,
      indexed: r.index !== null,
      seconds: r.seconds,
    });
  } catch (err) {
    // Details stay in the logs (and ingest_runs); the response is generic.
    console.error("ingest: run failed:", err instanceof Error ? err.message : err);
    return send(res, 500, { error: "Ingest run failed" });
  }
}
