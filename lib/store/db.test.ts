import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseUrl, directDatabaseUrl } from "./db";

const parts = { PGUSER: "u", PGPASSWORD: "p@ss/word", PGDATABASE: "neondb" };

test("databaseUrl accepts every name Neon and Vercel's integration use, pooled first", () => {
  assert.equal(databaseUrl({ DATABASE_URL: "a", POSTGRES_URL: "b" }), "a");
  assert.equal(databaseUrl({ POSTGRES_URL: "b", POSTGRES_PRISMA_URL: "c" }), "b");
  assert.equal(databaseUrl({ POSTGRES_PRISMA_URL: "c" }), "c");
  assert.equal(databaseUrl({}), undefined);
});

test("databaseUrl builds a URL from PG* parts, escaping credentials", () => {
  const url = new URL(databaseUrl({ PGHOST: "ep-x-pooler.neon.tech", ...parts })!);
  assert.equal(url.hostname, "ep-x-pooler.neon.tech");
  assert.equal(decodeURIComponent(url.password), "p@ss/word");
  assert.equal(url.pathname, "/neondb");
  assert.equal(url.searchParams.get("sslmode"), "require");
  assert.equal(databaseUrl({ PGHOST: "h", PGUSER: "u" }), undefined); // incomplete parts
});

test("directDatabaseUrl prefers unpooled names, then falls back to the pooled URL", () => {
  assert.equal(directDatabaseUrl({ MIGRATE_DATABASE_URL: "m", DATABASE_URL_UNPOOLED: "u" }), "m");
  assert.equal(directDatabaseUrl({ DATABASE_URL_UNPOOLED: "u", DATABASE_URL: "d" }), "u");
  assert.equal(directDatabaseUrl({ POSTGRES_URL_NON_POOLING: "n", DATABASE_URL: "d" }), "n");
  const fromParts = directDatabaseUrl({ PGHOST_UNPOOLED: "ep-x.neon.tech", ...parts });
  assert.equal(new URL(fromParts!).hostname, "ep-x.neon.tech");
  assert.equal(directDatabaseUrl({ POSTGRES_URL: "b" }), "b");
});
