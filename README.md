# HN Jobs

Natural-language search over the monthly Hacker News "Who is hiring?" thread. Type what you want ("remote Rust roles in Europe, senior") and get matching roles back, each linked to its HN post.

## Features

- **Search page**: one input, natural-language query, results with filter chips (`npm run serve`)
- **Daily sync**: picks up the newest thread and extracts only new or edited postings, all through Postgres (`npm run daily`)
- **Structured extraction**: Gemini Flash turns each HN post into roles (company, title, remote policy, regions, locations, seniority, tech, salary…) per [LABELING.md](LABELING.md)
- **Filtered semantic search**: an LLM turns the query into hard filters (remote, region, stack, level, salary) applied in SQL, then ranks matches by embedding similarity
- **Postgres + pgvector**: one store for roles, filterable fields and vectors
- **Evals with regression gates**: extraction scored against a human-reviewed gold set; retrieval scored on 24 queries with label-derived relevance

## Architecture

```
Runtime (npm run daily, lib/ingest)        Local / evals (npm run extract + index)
HN API ──► extractions table               data/threads/<id>.json ──► data/extracted/*.jsonl
                 │                                          │
                 └──── same extraction + indexing code ─────┘
                                  ▼
          Postgres: roles (fields + tsvector) + role_embeddings (per embedding model)
                                  │ lib/search/   (LLM query → SQL filters → vector ranking)
                                  ▼
            lib/web/app.ts (Express) ──► public/ search page
```

The runtime never touches disk, and the evals never touch the runtime's data: they share code,
not storage.

Layout:

```
lib/            schema.ts, canonical.ts, geo.ts   shared domain: role schema, normalization, "available in X"
  extraction/   hn (fetch + clean thread), extract, grounding, pipeline
  store/        db, role-doc, indexer             write side: roles + embeddings in Postgres
  search/       query-parse, search, search-service   read side
  ingest/       run: the runtime sync (lease, extract into Postgres, index, run history)
  web/          app (Express, host-agnostic), limits (Upstash or in-memory)
api/index.ts    Vercel Function wrapping the app (routes rewritten to it in vercel.json)
  evals/        gold, score, gate, ir-metrics, retrieval-queries
  util/         rate (limiter, backoff, token bucket), cache, safe (untrusted input)
models/         model factories + Gemini schema adapter
prompts/        extraction prompt (versioned)
ops/            CLI entry points (daily, serve, evals, review, migrate, ...)
```

Unit tests sit next to the module they cover (`lib/**/*.test.ts`). `npm test`, `npm run lint`, `npm run format:check`, `npm run typecheck`.

## Prerequisites

- Node.js 18+
- Docker (Postgres + pgvector)
- A `GOOGLE_API_KEY` (extraction, query parsing, embeddings). Ollama is optional for local embeddings.

## Setup

```bash
npm install
cp .env.example .env   # set POSTGRES_PASSWORD / DATABASE_URL (local-only password) and GOOGLE_API_KEY
npm run db:up
npm run migrate
```

## Usage

```bash
npm run daily                        # latest thread → extractions table → index (idempotent)
npm run serve                        # search page on 127.0.0.1:3000 (Upstash limits if configured)
npm run extract -- --concurrency 8   # (manual) extract the thread in THREAD_ID
npm run index                        # (manual) load roles into Postgres and embed them
```

## Deploy

Migrations run as an explicit step before a deploy, never when the server starts (serverless
instances start concurrently, the server's DB user should be read-only, and a bad migration
should stop the deploy rather than break the live site). Concurrent runs are serialized by a
Postgres advisory lock. Keep changes expand → migrate → contract: old code must keep working
against the new schema while a deploy rolls out.

- **Vercel:** run `npm run migrate:prod` (or `npm run migrate`) against Neon first, then push.
  `vercel-build` only compiles (`npm run build`, so type errors fail the deploy); it does not
  migrate, which keeps owner DB credentials out of builds and previews off the schema.
  `npm run migrate -- --deploy` still applies the production/preview guard if a CI job runs
  migrations later.
- **VPS:** `npm ci && npm run build`, then `npm run migrate:prod` before restarting
  `npm start` (`npm run daily:prod` from a timer). Production runs compiled JS on plain node;
  ts-node is a dev dependency, used only by the dev scripts.

Vercel entry point: [`api/index.ts`](api/index.ts) default-exports the same Express app
`ops/serve.ts` runs locally, as one Vercel Function; `vercel.json` rewrites `/api/*` and
`/healthz` to it. On Vercel, `public/` is served by the CDN (Express never sees those requests), so
the page's security headers live in [`vercel.json`](vercel.json); a test keeps them identical
to what Express sends. Required env: Neon (`DATABASE_URL`, or `POSTGRES_URL`, or `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`; unpooled variants for migrations, see `lib/store/db.ts`), Redis
REST (`REDIS_KV_REST_API_URL` + `_TOKEN`), `GOOGLE_API_KEY`, `EXTRACT_MODEL`, `EMBED_MODEL`.
Until the ingest workflow exists, refresh data with `npm run daily` against Neon.

- **Connection:** `MIGRATE_DATABASE_URL`, else `DATABASE_URL_UNPOOLED` (set by the Neon
  integration), else `DATABASE_URL`. It must be a direct (unpooled) connection.

**Spend guards** (Upstash, all instances): per client `SEARCH_RPM` (20/min, burst
`SEARCH_BURST` 10); across all clients, uncached searches (each = a Gemini parse + embedding)
are capped at `SEARCH_MISS_RPM` (10/min) and `SEARCH_MISS_PER_DAY` (2000/day). Past a cap,
new queries get 503 with `Retry-After`; cached ones keep working. Also set a budget alert on
the Google project behind `GOOGLE_API_KEY`.

**Tracing (OpenTelemetry):** `lib/telemetry/register.ts` registers `@vercel/otel` on Vercel (or
anywhere `OTEL_EXPORTER_OTLP_ENDPOINT` is set). Spans: `search.request` (outcome: cache_hit,
miss, rate_limited, budget_exceeded, invalid), `search.parse_query`, `search.embed_query`,
`db.vector_search`, `db.hydrate_roles`; outgoing fetch (Gemini, Upstash) is instrumented
automatically. Attributes hold counts and outcomes only: no query text, IPs or error messages.
On Vercel, open Observability → Traces and add a sampling rule (above 0%), or nothing is
collected; Hobby includes 1M span units/month with 3-day retention.

**Lockfile:** `package-lock.json` must only reference `registry.npmjs.org` (build hosts can't
reach a private mirror). If your npm is configured with a private mirror, run
`npm run lock:normalize` after installing packages; `npm run lint` fails until you do.

## Evals

| What                                       | Command                                                          | Gate                                |
| ------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------- |
| Extraction vs gold labels                  | `npm run eval:extract -- --models google-genai:gemini-3.5-flash` | `npm run eval:check -- --models …`  |
| Retrieval (24 queries, vector vs filtered) | `npm run eval:retrieval`                                         | `npm run eval:retrieval -- --check` |
| Label review UI                            | `npm run review` (127.0.0.1:4777)                                |                                     |

Baselines live in `data/evals/baseline*.json` and are committed. Re-baseline with `--write-baseline` when a change is intended, and commit it with the change.

- [EVALS.md](EVALS.md): how each eval and gate works, what's in `data/`, when to run what,
  current results and known limitations.
- [LABELING.md](LABELING.md): labelling rules and the review workflow.

Current retrieval nDCG@10 (filtered / vector-only): December 0.97 / 0.80, October (held-out)
0.96 / 0.80.

## Author

[Kostas Bariotis](https://github.com/kbariotis)
