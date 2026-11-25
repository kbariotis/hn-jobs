# Labelling guide: HN job extraction

The rules for gold labels (`data/gold/`) **and** for the extraction prompt (`prompts/extract.ts`).
If you change a rule here, change the prompt, bump `PROMPT_VERSION`, and re-check affected labels.

Mechanical normalization (aliases, versions, region codes) is done in code by `lib/canonical.ts`
for both model output and gold. Labels don't need to get spelling right, only meaning.

## General

- **Label what the post says.** If a value isn't stated (or unmistakably implied), use `null` / `[]`.
  "Most HN jobs are full-time" is not evidence. Deliberate exceptions, chosen for filtering usefulness over
  precision: city-only → `onsite`, and the seniority rules for "experienced" and "Manager" titles.
- **Not a job posting** (meta comment, question, job-seeker) → `roles: []`.

## Roles

- One role per distinct title. "Various Roles (Front-end, Back-end, Full Stack)" → 3 roles.
- Every named title is a role, including passing mentions ("also looking for 2D artists"). Passing
  mentions inherit like any other role (table below): header-level employment type / remote policy
  and company tech apply; salary, seniority and visa only where written next to them.
- Same title in different locations with different links → separate roles (e.g. Abnormal's two "Engineering Manager" posts).
- Combinatorial titles ("Staff and Senior SWEs, Full Stack and Backend") → one role per combination
  that the post actually offers. _Open: confirm on SmarterDx (46108976)._

## Inheritance in multi-role posts

| Fact | Applies to every role? |
|---|---|
| `company_name`, company tech stack, header-level `remote_policy` / `employment_type` / regions | **Yes** |
| `salary`, `seniority`, `visa_sponsorship` | **Only roles it is written next to**, unless the post says it covers all (e.g. a header-level salary for "Multiple roles") |

## Fields

**employment_type**: `full-time | part-time | contract | internship | null`. `null` when not stated.
If several are offered ("Full-time or Part-time"), use the first listed and add a note. _(Single value
is a known schema limitation.)_

**remote_policy**: `remote | hybrid | onsite | null`. Several offered → the most flexible
(remote > hybrid > onsite): "Remote or NYC office" → `remote`, "Onsite or Hybrid" → `hybrid`.
An office location with no remote/hybrid mention for the role → `onsite`.

**seniority**: from the title or explicit text only ("Senior", "Staff", "0–3 years" → junior).
"Software Engineer II" → `mid`, "Software Engineer 1" → `junior`. A plain "Software Engineer" → `null`.
"Senior Staff" → `staff` (closest; no finer value).
"Experienced" said of the role → `senior`. Titles with "Manager" → `manager`, "Head of" → `director`,
unless the title states a level ("Senior Product Manager" → `senior`).

**tech_stack**: named technologies only: languages, frameworks, libraries, databases, cloud services,
tools, operating systems. Lowercase.
- No versions: `react 19` → `react`, `tailwind v4` → `tailwind` (normalized in code).
- No concepts, domains or protocols: not `ai`, `llms`, `saas`, `rest apis`, `http`, `iot`.
- Products the role builds on count (`openzfs`, `onshape`); generic categories don't.

**locations**: office locations as `{city, region, country_code}`.
- `country_code`: ISO 3166-1 alpha-2 (`US`, `GB`, `NL`, `IN`).
- `region`: US state / CA province code when relevant (`NY`, `CA`), else `null`.
- `city` as written, abbreviations expanded (`NYC` → `New York`, `SF` → `San Francisco`).
  Neighbourhoods/boroughs → their city (`Williamsburg, Brooklyn` → `New York`).
  Metro areas as written (`San Francisco Bay Area`). Country only → `city: null`.
- Never "Remote" here.

**remote_regions**: where remote hires may live, as codes: ISO alpha-2 countries or one of
`EUROPE`, `EMEA`, `LATAM`, `APAC`, `AMERICAS`, `GLOBAL`.
- "Remote (EU)" / "Europe" → `EUROPE`. "North America" → `US`, `CA`. "Worldwide" → `GLOBAL`.
- Empty if not remote or unrestricted-and-unstated.

**timezones**: timezone constraints as written: `CET`, `US Pacific hours`, `EU time zone`. Never put
timezones in `remote_regions`.

**salary**: only stated figures. `$165k-$210k` → `{165000, 210000, USD, year}`. Equity/OTE notes don't
change the numbers. A missing currency symbol is `null` unless the post's country makes it unambiguous.

**apply_url**: a URL that appears in the post, copied exactly. Prefer the job/careers link over the
homepage. Never construct or extend one.

**apply_email**: decode obfuscation (`gray at netail.ai` → `gray@netail.ai`).

**description**: 1–3 sentence summary. Not scored.

## Review workflow

1. `npm run review`: amber pills = another model disagrees. Decide on the rules above, not on which model said it.
2. Write a note for every non-obvious decision. If a rule is missing, add it here.
3. `npm run eval:extract`: check that mismatches are model errors, not label errors.
4. `npm run eval:extract -- --models <a,b> --write-baseline`, then commit the gold file and `data/evals/baseline.<thread>.json` together.

### Held-out threads (blind)

Gold for a new thread checks that the rules and prompt generalize beyond the thread they were tuned on.
Label it blind, or the labels inherit the model's mistakes:

1. `npm run seed-gold -- --thread <id> --sample 25 --seed 1 --blank` (random sample, no roles).
2. `npm run review -- --thread <id> --blind`: no model suggestions; add roles by hand.
3. `npm run eval:extract -- --thread <id> --models <m>`, then adjudicate each mismatch: label error
   (fix the label, with a note) or model error (leave it). Never fix a label just because the model disagrees.

## Regression gate

`npm run eval:check -- --models <a,b>` exits 1 if a model makes an error the baseline didn't. Run it after every prompt, schema, canonicalizer or model change.

- The gate tracks errors as (posting, role, field), not percentages. With ~30 postings one flipped field moves a score by about 3 points.
- Postings reviewed, edited or reopened since the baseline are listed but not gated, so reviewing never breaks the gate. Re-baseline to include them.
- Extractions aren't committed. A fresh clone needs `--run`, and fresh runs aren't bit-for-bit reproducible, so allow some slack with `--tolerance N`.
