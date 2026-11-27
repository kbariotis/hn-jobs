import { db } from "../store/db";
import { search } from "./search";
import { parseQueryUncached, type Filters } from "./query-parse";
import { safeEmail, safeHttpUrl } from "../util/safe";
import type { Location } from "../schema";
import { withSpan } from "../telemetry/tracing";

export type JobResult = {
  role_id: string;
  title: string | null;
  company: string | null;
  remote_policy: string | null;
  remote_regions: string[];
  locations: string[];
  seniority: string | null;
  employment_type: string | null;
  tech: string[];
  salary: string | null;
  apply_url: string | null; // http(s) only
  apply_email: string | null;
  hn_url: string;
  posted_at: string;
};
export type SearchResponse = {
  query: string;
  /** Threads searched, newest first. */
  thread_ids: number[];
  filters: Filters | null;
  degraded: boolean;
  results: JobResult[];
};

/**
 * How many monthly threads search covers. Postings stay open for weeks, and a new month's thread
 * fills up over days while it's being ingested, so the previous month is searched too.
 */
export const SEARCH_THREADS = 2;

/** The newest SEARCH_THREADS indexed threads, newest first. */
export async function currentThreadIds(): Promise<number[]> {
  const { rows } = await db().query<{ id: string }>(
    "SELECT DISTINCT thread_id AS id FROM roles ORDER BY thread_id DESC LIMIT $1",
    [SEARCH_THREADS],
  );
  if (!rows.length) {
    throw new Error("Nothing indexed yet. Run `npm run daily`.");
  }
  return rows.map((r) => Number(r.id));
}

const fmtSalary = (
  min: string | null,
  max: string | null,
  cur: string | null,
  period: string | null,
) => {
  if (!min && !max) {
    return null;
  }
  const n = (x: string | null) => (x ? Math.round(Number(x)).toLocaleString("en-US") : "?");
  return `${n(min)}–${n(max)} ${cur ?? ""}${period ? `/${period}` : ""}`.trim();
};

/**
 * Filtered search (LLM-parsed filters → SQL → vector ranking). If parsing fails, falls
 * back to vector-only and says so: a degraded answer beats an error page.
 */
export async function searchJobs(
  query: string,
  { threadIds, k = 20 }: { threadIds: number[]; k?: number },
): Promise<SearchResponse> {
  let filters: Filters | null = null;
  let degraded = false;
  try {
    filters = await withSpan("search.parse_query", {}, () => parseQueryUncached(query));
  } catch (e) {
    degraded = true;
    console.warn(
      `query parse failed, falling back to vector: ${e instanceof Error ? e.message.slice(0, 200) : e}`,
    );
  }
  const { hits } = filters
    ? await search(query, { strategy: "filtered", threadIds, k, filters })
    : await search(query, { strategy: "vector", threadIds, k });
  if (hits.length === 0) {
    return { query, thread_ids: threadIds, filters, degraded, results: [] };
  }

  const { rows } = await withSpan("db.hydrate_roles", { "app.hits": hits.length }, () =>
    db().query(
      `SELECT role_id, posting_id, role_title, company_name, remote_policy, remote_regions, seniority, employment_type,
            tech_stack, salary_min, salary_max, salary_currency, salary_period, apply_url, apply_email, posted_at,
            data->'locations' AS locations
     FROM roles WHERE role_id = ANY($1)`,
      [hits.map((h) => h.role_id)],
    ),
  );
  const byId = new Map(rows.map((r) => [r.role_id as string, r]));
  const results = hits.flatMap((h): JobResult[] => {
    const r = byId.get(h.role_id);
    if (!r) {
      return [];
    }
    return [
      {
        role_id: r.role_id,
        title: r.role_title,
        company: r.company_name,
        remote_policy: r.remote_policy,
        remote_regions: r.remote_regions,
        locations: (r.locations as Location[]).map((l) =>
          [l.city, l.region, l.country_code].filter(Boolean).join(", "),
        ),
        seniority: r.seniority,
        employment_type: r.employment_type,
        tech: (r.tech_stack as string[]).slice(0, 10),
        salary: fmtSalary(r.salary_min, r.salary_max, r.salary_currency, r.salary_period),
        apply_url: safeHttpUrl(r.apply_url),
        apply_email: safeEmail(r.apply_email),
        hn_url: `https://news.ycombinator.com/item?id=${Number(r.posting_id)}`,
        posted_at: new Date(r.posted_at).toISOString(),
      },
    ];
  });
  return { query, thread_ids: threadIds, filters, degraded, results };
}
