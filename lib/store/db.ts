import { Pool } from "pg";

let pool: Pool | undefined;

/** Shared pool. DATABASE_URL is required: no baked-in credentials or silent localhost fallback. */
export function db(): Pool {
  if (pool) {
    return pool;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (see .env.example).");
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
