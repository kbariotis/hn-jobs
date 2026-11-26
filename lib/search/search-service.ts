import { db } from "../store/db";
import { search } from "./search";
import { parseQueryUncached, type Filters } from "./query-parse";
import { safeEmail, safeHttpUrl } from "../util/safe";
import type { Location } from "../schema";

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
  thread_id: number;
  filters: Filters | null;
  degraded: boolean;
  results: JobResult[];
};

/** Newest indexed thread = the current month. */
export async function currentThreadId(): Promise<number> {
  const { rows } = await db().query<{ id: string | null }>(
    "SELECT max(thread_id) AS id FROM roles",
  );
  if (!rows[0].id) {
    throw new Error("Nothing indexed yet. Run `npm run daily`.");
  }
  return Number(rows[0].id);
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
  { threadId, k = 20 }: { threadId: number; k?: number },
): Promise<SearchResponse> {
  let filters: Filters | null = null;
  let degraded = false;
  try {
    filters = await parseQueryUncached(query);
  } catch (e) {
    degraded = true;
    console.warn(
      `query parse failed, falling back to vector: ${e instanceof Error ? e.message.slice(0, 200) : e}`,
    );
  }
  const { hits } = filters
    ? await search(query, { strategy: "filtered", threadId, k, filters })
    : await search(query, { strategy: "vector", threadId, k });
  if (hits.length === 0) {
    return { query, thread_id: threadId, filters, degraded, results: [] };
  }

  const { rows } = await db().query(
    `SELECT role_id, posting_id, role_title, company_name, remote_policy, remote_regions, seniority, employment_type,
            tech_stack, salary_min, salary_max, salary_currency, salary_period, apply_url, apply_email, posted_at,
            data->'locations' AS locations
     FROM roles WHERE role_id = ANY($1)`,
    [hits.map((h) => h.role_id)],
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
  return { query, thread_id: threadId, filters, degraded, results };
}
