# HN Jobs

Natural-language search over the monthly Hacker News "Who is hiring?" thread. Type what you want ("remote Rust roles in Europe, senior") and get matching roles back, each linked to its HN post.

## Features

- **Search page**: one input, natural-language query, results with filter chips (`npm run serve`)
- **Daily sync**: picks up the newest thread and extracts only new or edited postings (`npm run daily`)
- **Structured extraction**: Gemini Flash turns each HN post into roles (company, title, remote policy, regions, locations, seniority, tech, salary…) per [LABELING.md](LABELING.md)
- **Filtered semantic search**: an LLM turns the query into hard filters (remote, region, stack, level, salary) applied in SQL, then ranks matches by embedding similarity
- **Postgres + pgvector**: one store for roles, filterable fields and vectors
- **Evals with regression gates**: extraction scored against a human-reviewed gold set; retrieval scored on 24 queries with label-derived relevance

## Architecture

```
HN Algolia API ──► data/threads/<id>.json (snapshot)
                        │ npm run extract   (Gemini Flash, cached JSONL per prompt version)
                        ▼
                 data/extracted/*.jsonl
                        │ npm run index     (upsert roles, embed changed docs)
                        ▼
          Postgres: roles (fields + tsvector) + role_embeddings (per embedding model)
                        │ lib/search/       (LLM query → SQL filters → vector ranking)
                        ▼
               ops/serve.ts ──► public/ search page
```

Layout:

```
lib/            schema.ts, canonical.ts, geo.ts   shared domain: role schema, normalization, "available in X"
  extraction/   hn (fetch + clean thread), extract, grounding, pipeline
  store/        db, role-doc, indexer             write side: roles + embeddings in Postgres
  search/       query-parse, search, search-service   read side
  evals/        gold, score, gate, ir-metrics, retrieval-queries
  util/         rate (limiter, backoff, token bucket), cache, safe (untrusted input)
models/         model factories + Gemini schema adapter
prompts/        extraction prompt (versioned)
ops/            CLI entry points (daily, serve, evals, review, migrate, ...)
```

Unit tests sit next to the module they cover (`lib/**/*.test.ts`).

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
npm run daily                        # latest thread: refresh, extract new/edited posts, index (idempotent)
npm run serve                        # search page on 127.0.0.1:3000
npm run extract -- --concurrency 8   # (manual) extract the thread in THREAD_ID
npm run index                        # (manual) load roles into Postgres and embed them
```

## Evals

| What | Command | Gate |
|---|---|---|
| Extraction vs gold labels | `npm run eval:extract -- --models google-genai:gemini-3.5-flash` | `npm run eval:check -- --models …` |
| Retrieval (24 queries, vector vs filtered) | `npm run eval:retrieval` | `npm run eval:retrieval -- --check` |
| Label review UI | `npm run review` (127.0.0.1:4777) | |

Baselines live in `data/evals/baseline*.json` and are committed. Re-baseline with `--write-baseline` when a change is intended, and commit it with the change. See LABELING.md for the labelling rules and review workflow.

Current retrieval (Gemini embeddings, thread 46108941, 837 roles): filtered nDCG@10 0.97, vector-only 0.80.

## Author

[Kostas Bariotis](https://github.com/kbariotis)
