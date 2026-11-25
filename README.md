# HN Jobs - Intelligent Job Search Assistant

An AI-powered chat assistant that helps you find the best open roles suited to you personally. The assistant asks you questions about your preferences and skills, then searches through a comprehensive Hacker News jobs index to present you with the most relevant opportunities.

## Features

- **Intelligent Chat Interface**: Interactive conversation-based job search
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
                        │ lib/search.ts     (vector | filtered)
                        ▼
               ops/chat.ts agent ──► user
```

Key files: `lib/schema.ts` (role schema), `prompts/extract.ts`, `lib/canonical.ts` (normalization), `lib/search.ts`, `lib/query-parse.ts`, `lib/geo.ts` (what "available in X" means), `db/migrations/`.

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
npm run extract -- --concurrency 8   # extract the thread in THREAD_ID (resumable)
npm run index                        # load roles into Postgres and embed them
npm run start -- ops/chat.ts         # chat assistant
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
