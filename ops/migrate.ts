import "dotenv/config";

import fs from "fs/promises";
import path from "path";
import { db, closeDb } from "../lib/store/db";

// Applies db/migrations/*.sql in filename order, each once, each in its own transaction.
// Usage: npm run migrate
const DIR = path.join(__dirname, "..", "db", "migrations");

async function main() {
  const pool = db();
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set(
    (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();

  for (const name of files.filter((f) => !applied.has(f))) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await fs.readFile(path.join(DIR, name), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`✓ ${name}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${e instanceof Error ? e.message : e}`, { cause: e });
    } finally {
      client.release();
    }
  }
  console.log(`Migrations up to date (${files.length}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
