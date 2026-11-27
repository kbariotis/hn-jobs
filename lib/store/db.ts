import { Pool } from "pg";
import type { QueryResult, QueryResultRow } from "pg";

/** A Pool, a PoolClient or a test fake: store functions only need `query`. */
export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
};

let pool: Pool | undefined;

type Env = Record<string, string | undefined>;

// Integrations may namespace their variables; this project's Neon integration uses NEON_.
const PREFIXES = ["", "NEON_"];

/** First non-empty value of `name` under any known prefix. */
const read = (env: Env, name: string) => PREFIXES.map((p) => env[`${p}${name}`]).find((v) => !!v);

/** Build a URL from discrete PG* parameters (Neon/Vercel also provide these). */
function fromParts(env: Env, hostVar: "PGHOST" | "PGHOST_UNPOOLED"): string | undefined {
  for (const p of PREFIXES) {
    const host = env[`${p}${hostVar}`];
    const user = env[`${p}PGUSER`];
    const password = env[`${p}PGPASSWORD`];
    const database = env[`${p}PGDATABASE`];
    if (host && user && password && database) {
      const u = new URL(`postgresql://${host}`);
      u.username = encodeURIComponent(user);
      u.password = encodeURIComponent(password);
      u.pathname = `/${encodeURIComponent(database)}`;
      u.searchParams.set("sslmode", "require");
      return u.toString();
    }
  }
  return undefined;
}

/**
 * Connection URL under any name Neon or Vercel's Neon integration uses, with or without the
 * NEON_ prefix. Pooled first (the server and ingest job run many short-lived connections):
 * DATABASE_URL → POSTGRES_URL → POSTGRES_PRISMA_URL → PGHOST + PGUSER/PGPASSWORD/PGDATABASE.
 */
export function databaseUrl(env: Env = process.env): string | undefined {
  return (
    read(env, "DATABASE_URL") ||
    read(env, "POSTGRES_URL") ||
    read(env, "POSTGRES_PRISMA_URL") ||
    fromParts(env, "PGHOST")
  );
}

/**
 * Direct (unpooled) URL, needed for session features such as advisory locks (same prefixes):
 * MIGRATE_DATABASE_URL → DATABASE_URL_UNPOOLED → POSTGRES_URL_NON_POOLING → PGHOST_UNPOOLED
 * parts → the pooled URL as a last resort.
 */
export function directDatabaseUrl(env: Env = process.env): string | undefined {
  return (
    env.MIGRATE_DATABASE_URL ||
    read(env, "DATABASE_URL_UNPOOLED") ||
    read(env, "POSTGRES_URL_NON_POOLING") ||
    fromParts(env, "PGHOST_UNPOOLED") ||
    databaseUrl(env)
  );
}

/** Shared pool. A URL is required: no baked-in credentials or silent localhost fallback. */
export function db(): Pool {
  if (pool) {
    return pool;
  }
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error(
      "No database URL is set ([NEON_]DATABASE_URL, [NEON_]POSTGRES_URL or PG* parameters).",
    );
  }
  pool = new Pool({ connectionString, max: 5 });
  return pool;
}

export async function closeDb() {
  await pool?.end();
  pool = undefined;
}

/** pgvector text literal. Values are numbers from the embedding API, never user input. */
export const toVector = (v: number[]) => `[${v.join(",")}]`;
