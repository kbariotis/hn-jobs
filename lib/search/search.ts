import { db, toVector } from "../store/db";
import { compatibleRemoteRegions, countriesIn } from "../geo";
import { parseQuery, type Filters } from "./query-parse";
import { embedModelId, getEmbeddings } from "../../models/embeddings";
import { withSpan } from "../telemetry/tracing";

export type Strategy = "vector" | "filtered";
export type Hit = {
  role_id: string;
  posting_id: number;
  role_title: string | null;
  company_name: string | null;
  thread_id: number;
  distance: number;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
// Unknown company or title: never treated as a repost.
const repostKey = (h: Hit) =>
  h.company_name && h.role_title ? `${norm(h.company_name)}|${norm(h.role_title)}` : null;

/**
 * Companies repost the same role every month. When a role (same company and title) appears in
 * several threads, keep only the newest thread's hits. Hits from the same thread are never merged:
 * one posting can list the same title for different offices. Keeps the distance order.
 */
export function dropReposts(hits: Hit[]): Hit[] {
  const newest = new Map<string, number>();
  for (const h of hits) {
    const key = repostKey(h);
    if (key) {
      newest.set(key, Math.max(newest.get(key) ?? 0, h.thread_id));
    }
  }
  return hits.filter((h) => {
    const key = repostKey(h);
    return !key || h.thread_id === newest.get(key);
  });
}

/**
 * Filters -> parameterized SQL. Every value goes through `p()`; nothing user-supplied is
 * concatenated into the statement. Semantics mirror lib/geo.ts `availableIn`.
 */
export function filterSql(f: Filters, params: unknown[]): string[] {
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];
  if (f.work_modes.length) {
    where.push(`r.remote_policy = ANY(${p(f.work_modes)})`);
  }
  if (f.seniority.length) {
    where.push(`r.seniority = ANY(${p(f.seniority)})`);
  }
  if (f.employment_types.length) {
    where.push(`r.employment_type = ANY(${p(f.employment_types)})`);
  }
  if (f.tech_all.length) {
    where.push(`r.tech_stack @> ${p(f.tech_all)}::text[]`);
  }
  if (f.tech_any.length) {
    where.push(`r.tech_stack && ${p(f.tech_any)}::text[]`);
  }
  if (f.cities.length) {
    where.push(`r.cities && ${p(f.cities)}::text[]`);
  }
  if (f.min_salary_usd_year !== null) {
    where.push(
      `(r.salary_currency = 'USD' AND r.salary_period = 'year' AND coalesce(r.salary_max, r.salary_min) >= ${p(f.min_salary_usd_year)})`,
    );
  }
  if (f.visa_sponsorship === true) {
    where.push(`r.visa_sponsorship IS TRUE`);
  }
  if (f.regions.length) {
    // Available in ANY requested region: remote and open there, or an office there.
    const ors = f.regions.map((code) => {
      const remote = compatibleRemoteRegions(code);
      const offices = countriesIn(code);
      const remoteSql = `(r.remote_policy = 'remote' AND r.remote_regions && ${p(remote)}::text[])`;
      const officeSql = `r.countries && ${p(offices)}::text[]`;
      return `${remoteSql} OR ${officeSql}`;
    });
    where.push(`(${ors.join(" OR ")})`);
  }
  return where;
}

export async function search(
  query: string,
  opts: {
    strategy: Strategy;
    k?: number;
    /** Threads to search; when several, reposted roles keep only the newest copy. */
    threadIds?: number[];
    embedModel?: string;
    filters?: Filters;
    /** Precomputed query embedding (must come from `embedModel`); evals pass a cached one. */
    queryVector?: number[];
  },
): Promise<{ hits: Hit[]; filters?: Filters }> {
  const embedModel = opts.embedModel ?? embedModelId();
  const qvec =
    opts.queryVector ??
    (await withSpan("search.embed_query", { "app.embed_model": embedModel }, () =>
      getEmbeddings("query", embedModel).embedQuery(query),
    ));
  const params: unknown[] = [toVector(qvec), embedModel];
  const where = ["e.embed_model = $2"];
  if (opts.threadIds !== undefined) {
    where.push(`r.thread_id = ANY($${params.push(opts.threadIds)}::bigint[])`);
  }
  const k = opts.k ?? 10;
  // Over-fetch across threads so dropping older reposts still leaves k hits.
  const multiThread = (opts.threadIds?.length ?? 0) > 1;

  let filters: Filters | undefined;
  if (opts.strategy === "filtered") {
    // Callers may parse themselves (the server does, to skip the file cache).
    filters = opts.filters ?? (await parseQuery(query));
    where.push(...filterSql(filters, params));
  }
  const limit = `$${params.push(multiThread ? k * 2 : k)}`;
  const { rows } = await withSpan(
    "db.vector_search",
    { "app.strategy": opts.strategy, "app.sql.conditions": where.length },
    () =>
      db().query<Hit>(
        `SELECT r.role_id, r.posting_id, r.role_title, r.company_name, r.thread_id, e.embedding <=> $1::vector AS distance
     FROM roles r JOIN role_embeddings e ON e.role_id = r.role_id
     WHERE ${where.join(" AND ")}
     ORDER BY distance LIMIT ${limit}`,
        params,
      ),
  );
  const hits = rows.map((r) => ({
    ...r,
    posting_id: Number(r.posting_id),
    thread_id: Number(r.thread_id),
  }));
  return { hits: multiThread ? dropReposts(hits).slice(0, k) : hits, filters };
}
