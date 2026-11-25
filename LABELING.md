# Labelling guide: HN job extraction

The rules for gold labels (`data/gold/`) **and** for the extraction prompt (`prompts/extract.ts`).
If you change a rule here, change the prompt, bump `PROMPT_VERSION`, and re-check affected labels.

Mechanical normalization (aliases, versions, region codes) is done in code by `lib/canonical.ts`
for both model output and gold. Labels don't need to get spelling right, only meaning.

## General

- **Label what the post says.** If a value isn't stated (or unmistakably implied), use `null` / `[]`.
  "Most HN jobs are full-time" is not evidence.
- **Not a job posting** (meta comment, question, job-seeker) → `roles: []`.

## Roles

- One role per distinct title. "Various Roles (Front-end, Back-end, Full Stack)" → 3 roles.
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

**remote_policy**: `remote | hybrid | onsite | null`. "Remote or NYC office" → `remote`.

**seniority**: from the title or explicit text only ("Senior", "Staff", "0–3 years" → junior).
"Software Engineer II" → `mid`, "Software Engineer 1" → `junior`. A plain "Software Engineer" → `null`.
"Senior Staff" → `staff` (closest; no finer value).

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
