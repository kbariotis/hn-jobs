# Evals

Two evals, each with a regression gate:

| Eval           | Question it answers                         | Run                      | Gate                                |
| -------------- | ------------------------------------------- | ------------------------ | ----------------------------------- |
| **Extraction** | Did the model read each HN post correctly?  | `npm run eval:extract`   | `npm run eval:check`                |
| **Retrieval**  | Does a normal search return the right jobs? | `npm run eval:retrieval` | `npm run eval:retrieval -- --check` |

```
your labels (gold) ──► Extraction eval: is the extracted data right?
                              │
extraction ──► database ──► Retrieval eval: does search find the right roles?
```

They are separate on purpose: a bad search score can come from bad data or from bad search.
If extraction passes and retrieval drops, the problem is in search (query parsing, filters,
embeddings), not in the data.

How to label postings is in [LABELING.md](LABELING.md). This file covers what the evals do
with those labels.

## Threads

Everything is keyed by the HN thread id (one thread per month). Both evals default to
`THREAD_ID` (or `46108941`); pass `--thread <id>` for another.

| Thread     | Month    | Role in the evals                                             |
| ---------- | -------- | ------------------------------------------------------------- |
| `46108941` | December | **Dev set.** Prompt and labelling rules were tuned on it.     |
| `49922569` | October  | **Held-out set.** Labelled blind, to check we didn't overfit. |
| `50338728` | November | Live thread served by `npm run daily`. Not evaluated.         |

## The `data/` folder

| Path                                 | In git | What it is                                                                                                                                                           |
| ------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threads/<id>.json`                  | yes\*  | Frozen snapshot of the thread from the HN API, so evals always see the same text. \*The live thread is not committed: the daily job rewrites it.                     |
| `gold/extract.<id>.json`             | yes    | Human labels: the roles each posting _should_ produce. Each entry stores the text it was labelled against, so edits to the post are detected.                        |
| `evals/baseline.<id>.json`           | yes    | Extraction gate baseline: the list of known, accepted errors.                                                                                                        |
| `evals/baseline.retrieval.<id>.json` | yes    | Retrieval gate baseline: accepted nDCG@10 per query and strategy.                                                                                                    |
| `extracted/<id>.<model>.jsonl`       | no     | Model output, one record per posting, with prompt version and a hash of the post text. Expensive to rebuild (Gemini quota); reused until the prompt or post changes. |
| `evals/extract.<id>.json`            | no     | Full report of the last extraction eval: per-field scores and every mismatch.                                                                                        |
| `evals/retrieval.<id>.json`          | no     | Full report of the last retrieval eval: per-query scores, parsed filters, top-10 ids.                                                                                |
| `evals/query-parse-cache.json`       | no     | Cached "query → filters" LLM output, so retrieval runs are repeatable and free. See [Limitations](#limitations).                                                     |

---

## Extraction eval

**Ground truth:** postings you reviewed in the label UI (`npm run review`). Drafts that were
never reviewed are ignored unless you pass `--include-drafts` (they are biased toward the
model that seeded them).

### Process

1. **Load** the frozen thread and the reviewed gold postings.
2. **Get the model's answer** for each one from `data/extracted/`. With `--run`, postings
   that are missing, failed or stale (old prompt version, edited text) are extracted again.
3. **Pair roles.** A post can list several jobs, so each predicted role is matched to the
   gold role it most likely means, by title and location (with a fallback that pairs
   leftovers such as "Intern" with "Intern/Co-op").
   - Gold role with no partner → **missed role**.
   - Predicted role with no partner → **invented role**.
4. **Compare field by field**, after normalizing both sides the same way
   ("NYC" = "New York", "golang" = "go", "EU" = "EUROPE"):
   - single-value fields (employment type, remote policy, seniority, visa): exact match;
   - list fields (tech stack, regions, timezones, locations): partial credit (F1);
   - apply URL and email: must also appear in the post, so invented links count as errors.
5. **Report** to `data/evals/extract.<id>.json` and the console: per-field accuracy and the
   list of mismatches.

### Gate

The baseline is a **list of known errors**, each identified as
`posting | role | field` (for example _"46109012, Backend Engineer, seniority"_), plus a hash
of every gold posting.

`--check` fails only when **a new error appears on a posting whose text and labels haven't
changed**. Percentages are not used: with ~40 postings a single flipped field moves a score by
2–3 points, which would be noise.

- Edited posts, newly reviewed postings and reopened ones are **listed but not gated**, so
  reviewing more postings never breaks the gate.
- Errors that disappeared are reported as **fixed**.
- Tolerance is 0 by default. With `--run` (fresh model calls) raise it slightly, since model
  output is not bit-for-bit reproducible.

### Commands

```bash
npm run eval:extract -- --models google-genai:gemini-3.5-flash                  # score
npm run eval:check -- --models google-genai:gemini-3.5-flash                    # gate
npm run eval:extract -- --models google-genai:gemini-3.5-flash --write-baseline # accept
npm run eval:extract -- --thread 49922569 --models google-genai:gemini-3.5-flash  # held-out
```

---

## Retrieval eval

**Ground truth:** 24 example searches in [`lib/evals/retrieval-queries.ts`](lib/evals/retrieval-queries.ts),
each with a **rule** describing what a correct result looks like. For example:

> _"remote Rust jobs"_ → relevant if the role is remote **and** its tech stack includes Rust.

Rules, not hand-picked lists of job ids, so they work on any month's thread and every
judgment can be traced back to a field.

- **19 structured queries:** constraints that exist as fields (remote, region, city, stack,
  seniority, salary, visa). Relevance = those fields.
- **5 semantic queries:** topics with no field behind them ("climate tech"). Relevance = a
  keyword match on the post text. A weaker judgment; read those scores with that in mind.

### Process

1. **Check the index exists** for this thread and embedding model.
2. **Mark the correct answers.** Apply every query's rule to every role in the thread:
   - postings you reviewed use **your gold labels**;
   - all other postings use **the model's extraction**.

   For reviewed postings, gold roles are paired with the extracted (searchable) roles, like
   in the extraction eval. A relevant gold role the extractor never produced can't be found
   by search but **still counts against the score**, so extraction misses show up here too.

3. **Drift check.** If any correct answer is missing from the database (re-extracted but not
   re-indexed), stop with an error instead of reporting misleadingly low scores.
4. **Search** each query two ways:
   - **`vector`**: turn the query into an embedding and return the most similar roles.
   - **`filtered`**: an LLM turns the query into hard filters (remote, region, stack, level,
     salary, visa), SQL keeps only roles that pass them, then similarity ranks those. The
     LLM step is read from `query-parse-cache.json` when present.
5. **Score the top 10** of each search against the correct answers:
   - **nDCG@10** (headline): are the right jobs at the top? 1.0 = all correct answers first.
   - **P@10**: how many of the 10 results are correct.
   - **R-precision**: of all correct answers, how many made it into the top _R_ (_R_ = number
     of correct answers).
6. **Report** to the console (per-query table plus averages, split structured / semantic)
   and to `data/evals/retrieval.<id>.json` (also the parsed filters and top-10 ids per query,
   which is where to look when a query fails).

### Gate

The baseline stores nDCG@10 **per query and per strategy**. `--check` fails if **any single
query** drops more than `--tolerance` (default 0.05) below its baseline. It's per query, not
the average, so one broken search can't hide behind 23 good ones. It also prints a note if
the embedding model differs from the one the baseline was recorded with.

### Commands

```bash
npm run eval:retrieval                                   # score both strategies
npm run eval:retrieval -- --check                        # gate
npm run eval:retrieval -- --write-baseline               # accept (refused with --only)
npm run eval:retrieval -- --thread 49922569              # held-out
npm run eval:retrieval -- --strategies filtered --only remote-rust   # debug one query
```

---

## When to run what

| You changed…                                           | Run                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| Extraction prompt, schema, normalization (`canonical`) | `extract` → `index` → `eval:check` → `eval:retrieval -- --check`  |
| Query parsing prompt or filter logic                   | delete `query-parse-cache.json`, then `eval:retrieval -- --check` |
| Search ranking, SQL filters, geography rules           | `eval:retrieval -- --check`                                       |
| Embedding model                                        | `index`, then `eval:retrieval`; expect to re-baseline             |
| Gold labels (more reviews, fixes)                      | `eval:extract`; re-baseline both if the change is intended        |

When a change is intended and the new numbers are better or acceptable, write the baseline
(`--write-baseline`) and **commit it together with the change**, so the history shows why
the benchmark moved.

### Adding a new held-out thread

1. Seed a blind sample: `npm run seed-gold -- --thread <id> --sample 25 --seed 1 --skeleton`.
2. Label it in the blind review UI (see LABELING.md → _Held-out threads_).
3. Extract and index the thread, then run both evals with `--thread <id>`.
4. Adjudicate each extraction mismatch against the post text (label error vs model error),
   then write both baselines and commit them with the gold file.

---

## Current results

Gemini 3.5 Flash extraction, `gemini-embedding-001` embeddings, prompt version 5.

| Thread             | Extraction gate                        | Retrieval nDCG@10: `filtered` | `vector` |
| ------------------ | -------------------------------------- | ----------------------------- | -------- |
| December (dev)     | 41 postings gated, 0 new errors        | 0.97                          | 0.80     |
| October (held-out) | 14 reviewed; 10 mismatches adjudicated | 0.96                          | 0.80     |

The held-out result is close to the dev result, which is the main evidence that the prompt
and rules weren't overfit to December.

## Limitations

1. **`filtered` partly grades itself.** For postings nobody reviewed, the "correct answers"
   come from the same extracted fields the filters run on. If the model wrongly marks a role
   onsite, the filter drops it _and_ the eval agrees it isn't relevant. Treat 0.97 as an upper
   bound; the semantic queries and the reviewed postings are the honest signal.
2. **The query-parse cache can hide regressions.** It isn't keyed by prompt version, so after
   changing the parsing prompt the eval keeps using old filters until the cache is deleted.
3. **Every retrieval run calls Gemini** to embed the 24 queries (those aren't cached), so the
   gate can't run when the API quota is exhausted.
4. **The live thread has no quality score.** `npm run daily` reports coverage (share of posts
   extracted, alert below 99%), which says how much was extracted, not how well.
5. **Small samples.** 41 + 14 reviewed postings and 24 queries catch regressions well, but
   absolute percentages carry wide error bars.
