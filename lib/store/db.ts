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

/** Build a URL from discrete PG* parameters (Neon/Vercel also provide these). */
function fromParts(env: Env, host: string | undefined): string | undefined {
  const { PGUSER: user, PGPASSWORD: password, PGDATABASE: database } = env;
  if (!host || !user || !password || !database) {
    return undefined;
  }
  const u = new URL(`postgresql://${host}`);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  u.pathname = `/${encodeURIComponent(database)}`;
  u.searchParams.set("sslmode", "require");
  return u.toString();
}

/**
 * Connection URL under any name Neon or Vercel's Neon integration uses. Pooled first (the
 * server and ingest job run many short-lived connections):
 * DATABASE_URL → POSTGRES_URL → POSTGRES_PRISMA_URL → PGHOST + PGUSER/PGPASSWORD/PGDATABASE.
 */
export function databaseUrl(env: Env = process.env): string | undefined {
  return (
    env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || fromParts(env, env.PGHOST)
  );
}

/**
 * Direct (unpooled) URL, needed for session features such as advisory locks:
 * MIGRATE_DATABASE_URL → DATABASE_URL_UNPOOLED → POSTGRES_URL_NON_POOLING → PGHOST_UNPOOLED
 * parts → the pooled URL as a last resort.
 */
export function directDatabaseUrl(env: Env = process.env): string | undefined {
  return (
    env.MIGRATE_DATABASE_URL ||
    env.DATABASE_URL_UNPOOLED ||
    env.POSTGRES_URL_NON_POOLING ||
    fromParts(env, env.PGHOST_UNPOOLED) ||
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
      "No database URL is set (DATABASE_URL, POSTGRES_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE).",
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
