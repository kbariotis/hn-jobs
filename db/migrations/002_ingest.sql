-- Runtime extraction store (the hosted ingest job has no disk). Local runs and evals keep using
-- data/extracted/*.jsonl; both go through the same extraction code.
CREATE TABLE extractions (
  thread_id      bigint NOT NULL,
  posting_id     bigint NOT NULL,
  model          text NOT NULL,
  prompt_version text NOT NULL,
  text_sha       text,
  author         text,
  posted_at      timestamptz NOT NULL,
  latency_ms     int NOT NULL,
  roles          jsonb NOT NULL,
  warnings       jsonb,
  error          text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, posting_id, model)
);

-- One ingest run at a time, on any host. A lease (not a session lock) so it works across
-- serverless invocations and expires by itself if a run dies.
CREATE TABLE ingest_lock (
  name        text PRIMARY KEY,
  holder      text NOT NULL,
  lease_until timestamptz NOT NULL
);

-- Run history: the ingest job's log, since hosted runtime logs are short-lived.
CREATE TABLE ingest_runs (
  id          bigserial PRIMARY KEY,
  thread_id   bigint,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running', -- running | ok | low_coverage | failed
  summary     jsonb
);
