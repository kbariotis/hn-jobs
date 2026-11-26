import { z } from "zod";
import { SystemMessage, HumanMessage } from "langchain";
import fs from "fs/promises";
import { EmploymentType, RemotePolicy, Seniority } from "../schema";
import { toGeminiSchema } from "../../models/gemini-schema";
import { canonicalRegion, canonicalTech } from "../canonical";
import { getExtractModel } from "../../models/extract";

/** Hard constraints a search query states. Anything soft stays in the vector part. */
export const Filters = z.object({
  work_modes: z.array(RemotePolicy).describe("Only if the query restricts work mode, e.g. 'remote' -> ['remote']"),
  regions: z.array(z.string()).describe("Where the job must be available: ISO alpha-2 or EUROPE/EMEA/LATAM/APAC/AMERICAS/GLOBAL"),
  cities: z.array(z.string()).describe("Specific cities, full names ('NYC' -> 'New York')"),
  seniority: z.array(Seniority),
  employment_types: z.array(EmploymentType),
  tech_all: z.array(z.string()).describe("Technologies that must all be present, lowercase"),
  tech_any: z.array(z.string()).describe("Alternatives where any one suffices ('Python or Go')"),
  min_salary_usd_year: z.number().nullable(),
  visa_sponsorship: z.boolean().nullable().describe("true only if the query asks for visa sponsorship"),
});
export type Filters = z.infer<typeof Filters>;

export const PARSER_VERSION = "1";

const prompt = new SystemMessage(`Turn a job-search query into hard filters.
Only extract constraints the query states; leave everything else empty or null. Never add filters the user did not ask for.
- "remote" -> work_modes ["remote"]. "onsite"/"in office" -> ["onsite"]. "hybrid" -> ["hybrid"].
- Places: countries/macro regions go in regions ("Europe" -> EUROPE, "US" -> US, "UK" -> GB, "anywhere" -> GLOBAL); cities go in cities.
- "senior" -> ["senior"]; "senior or staff" -> ["senior","staff"]; "entry level"/"new grad" -> ["junior"]; "internship" -> employment_types ["internship"].
- Tech: "React and TypeScript" -> tech_all; "Python or Go" -> tech_any. Use common names (golang -> go, node.js -> node).
- Salary: "$150k+" -> min_salary_usd_year 150000. Only USD yearly amounts.`);

const cachePath = "data/evals/query-parse-cache.json";

/**
 * File-cached parse for evals: reproducible runs, no repeat LLM calls. Not for the server
 * (it would persist every user query to disk, unbounded); use parseQueryUncached there.
 */
export async function parseQuery(query: string, modelId?: string): Promise<Filters> {
  const cache: Record<string, Filters> = await fs.readFile(cachePath, "utf8").then(JSON.parse).catch(() => ({}));
  const key = `${modelId ?? "default"}|v${PARSER_VERSION}|${query}`;
  if (cache[key]) return cache[key];
  const filters = await parseQueryUncached(query, modelId);
  cache[key] = filters;
  await fs.mkdir("data/evals", { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n");
  return filters;
}

const CODE = /^([A-Z]{2}|EUROPE|EMEA|LATAM|APAC|AMERICAS|GLOBAL)$/;
const MAX_ITEMS = 10;

/** Parse + canonicalize with the same normalizers as extraction. The query is untrusted: output is bounded. */
export async function parseQueryUncached(query: string, modelId?: string): Promise<Filters> {
  const model = await getExtractModel(modelId);
  const structured = model.withStructuredOutput(toGeminiSchema(Filters), { name: "search_filters" });
  const raw = Filters.parse(await structured.invoke([prompt, new HumanMessage(query)]));
  const tech = (xs: string[]) => [...new Set(xs.map(canonicalTech).filter((t): t is string => !!t))];
  // A prompt-injected query can only produce weird filters, never SQL (all values are
  // parameters). Still cap sizes and drop anything that isn't a known code or a sane string.
  const short = (xs: string[]) => xs.map((x) => x.trim()).filter((x) => x.length > 0 && x.length <= 60).slice(0, MAX_ITEMS);
  const salary = raw.min_salary_usd_year;
  return {
    ...raw,
    regions: [...new Set(raw.regions.flatMap((r) => canonicalRegion(r).codes))].filter((c) => CODE.test(c)).slice(0, MAX_ITEMS),
    cities: short(raw.cities),
    tech_all: tech(short(raw.tech_all)),
    tech_any: tech(short(raw.tech_any)),
    min_salary_usd_year: salary !== null && Number.isFinite(salary) && salary > 0 && salary < 10_000_000 ? salary : null,
  };
}
