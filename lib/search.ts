import { db, toVector } from "./db";
import { compatibleRemoteRegions, countriesIn } from "./geo";
import { parseQuery, type Filters } from "./query-parse";
import { embedModelId, getEmbeddings } from "../models/embeddings";

export type Strategy = "vector" | "filtered";
export type Hit = { role_id: string; posting_id: number; role_title: string | null; company_name: string | null; distance: number };

/**
 * Filters -> parameterized SQL. Every value goes through `p()`; nothing user-supplied is
 * concatenated into the statement. Semantics mirror lib/geo.ts `availableIn`.
 */
export function filterSql(f: Filters, params: unknown[]): string[] {
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];
  if (f.work_modes.length) where.push(`r.remote_policy = ANY(${p(f.work_modes)})`);
  if (f.seniority.length) where.push(`r.seniority = ANY(${p(f.seniority)})`);
  if (f.employment_types.length) where.push(`r.employment_type = ANY(${p(f.employment_types)})`);
  if (f.tech_all.length) where.push(`r.tech_stack @> ${p(f.tech_all)}::text[]`);
  if (f.tech_any.length) where.push(`r.tech_stack && ${p(f.tech_any)}::text[]`);
  if (f.cities.length) where.push(`r.cities && ${p(f.cities)}::text[]`);
  if (f.min_salary_usd_year !== null)
    where.push(`(r.salary_currency = 'USD' AND r.salary_period = 'year' AND coalesce(r.salary_max, r.salary_min) >= ${p(f.min_salary_usd_year)})`);
  if (f.visa_sponsorship === true) where.push(`r.visa_sponsorship IS TRUE`);
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
  opts: { strategy: Strategy; k?: number; threadId?: number; embedModel?: string; filters?: Filters }
): Promise<{ hits: Hit[]; filters?: Filters }> {
  const embedModel = opts.embedModel ?? embedModelId();
  const qvec = await getEmbeddings("query", embedModel).embedQuery(query);
  const params: unknown[] = [toVector(qvec), embedModel];
  const where = ["e.embed_model = $2"];
  if (opts.threadId !== undefined) where.push(`r.thread_id = $${params.push(opts.threadId)}`);

  let filters: Filters | undefined;
  if (opts.strategy === "filtered") {
    filters = opts.filters ?? (await parseQuery(query)); // callers may parse themselves (server: no file cache)
    where.push(...filterSql(filters, params));
  }
  const limit = `$${params.push(opts.k ?? 10)}`;
  const { rows } = await db().query<Hit>(
    `SELECT r.role_id, r.posting_id, r.role_title, r.company_name, e.embedding <=> $1::vector AS distance
     FROM roles r JOIN role_embeddings e ON e.role_id = r.role_id
     WHERE ${where.join(" AND ")}
     ORDER BY distance LIMIT ${limit}`,
    params
  );
  return { hits: rows.map((r) => ({ ...r, posting_id: Number(r.posting_id) })), filters };
}
