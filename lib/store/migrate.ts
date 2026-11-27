import fs from "fs/promises";
import path from "path";
import { Client } from "pg";
import { directDatabaseUrl } from "./db";

/**
 * Applies db/migrations/*.sql in filename order, each once, each in its own transaction.
 *
 * CLI: ops/migrate.ts (`npm run migrate`; `-- --deploy` adds the Vercel env guard for CI).
 *
 * Runs as an explicit pre-deploy step, never at server start: serverless instances start
 * concurrently, the server's DB user is read-only, and a failed migration should stop the deploy
 * while the old version keeps serving.
 *
 * Connection: directDatabaseUrl() in ./db (MIGRATE_DATABASE_URL, DATABASE_URL_UNPOOLED,
 * POSTGRES_URL_NON_POOLING, PGHOST_UNPOOLED parts, then the pooled URL). It must be direct:
 * the advisory lock below is per session, and a transaction-mode pooler would hand that
 * session to other clients.
 */
const DIR = path.join(__dirname, "..", "..", "db", "migrations");
// Arbitrary constant: any concurrent `migrate` waits here instead of racing the same DDL.
const LOCK_KEY = 4_811_220_017;

export const migrationUrl = (env: Record<string, string | undefined> = process.env) =>
  directDatabaseUrl(env);

/**
 * Under --deploy on Vercel, decide whether this build may migrate. Production: yes. Preview:
 * only once PREVIEW_DB_IS_BRANCH=1 says previews get their own Neon branch, so a pull request
 * can never migrate the production database by accident.
 */
export function deployTarget(env = process.env): { migrate: boolean; reason: string } {
  const vercelEnv = env.VERCEL_ENV;
  if (!vercelEnv) {
    return { migrate: true, reason: "not on Vercel" };
  }
  if (vercelEnv === "production") {
    return { migrate: true, reason: "production deploy" };
  }
  if (env.PREVIEW_DB_IS_BRANCH === "1") {
    return { migrate: true, reason: `${vercelEnv} deploy on its own database branch` };
  }
  return {
    migrate: false,
    reason: `${vercelEnv} deploy without PREVIEW_DB_IS_BRANCH=1 (could be the production DB)`,
  };
}

/** Apply pending migrations, serialized across concurrent runs by an advisory lock. */
export async function runMigrations(connectionString: string, dir = DIR): Promise<string[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    try {
      return await applyPending(client, dir);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

async function applyPending(client: Client, dir: string): Promise<string[]> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  // Read after taking the lock, so a run that waited sees what the other one applied.
  const applied = new Set(
    (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
      (r) => r.name,
    ),
  );
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const pending = files.filter((f) => !applied.has(f));
  for (const name of pending) {
    try {
      await client.query("BEGIN");
      await client.query(await fs.readFile(path.join(dir, name), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`✓ ${name}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${e instanceof Error ? e.message : e}`, {
        cause: e,
      });
    }
  }
  console.log(`Migrations up to date (${files.length}).`);
  return pending;
}
