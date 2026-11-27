import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseUrl, directDatabaseUrl, strictTls } from "./db";

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
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
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

test("NEON_-prefixed names (this project's Neon integration) resolve too", () => {
  const env = { NEON_DATABASE_URL: "pooled", NEON_DATABASE_URL_UNPOOLED: "direct" };
  assert.equal(databaseUrl(env), "pooled");
  assert.equal(directDatabaseUrl(env), "direct");
  // An unprefixed name still wins when both exist.
  assert.equal(databaseUrl({ ...env, DATABASE_URL: "plain" }), "plain");
});

test("strictTls pins weak sslmodes to verify-full and leaves others alone", () => {
  const neon = "postgresql://u:p@ep-x.neon.tech/neondb?sslmode=require&channel_binding=require";
  const out = new URL(strictTls(neon)!);
  assert.equal(out.searchParams.get("sslmode"), "verify-full");
  assert.equal(out.searchParams.get("channel_binding"), "require"); // other params kept
  assert.equal(strictTls("postgres://u:p@127.0.0.1:5433/db"), "postgres://u:p@127.0.0.1:5433/db");
  assert.equal(strictTls("postgres://h/db?sslmode=disable"), "postgres://h/db?sslmode=disable");
  assert.equal(databaseUrl({ NEON_DATABASE_URL: neon })?.includes("sslmode=verify-full"), true);
});
