import { test } from "node:test";
import assert from "node:assert/strict";
import { deployTarget, migrationUrl } from "./migrate";

test("migrationUrl prefers an explicit, then a direct (unpooled), then the default URL", () => {
  assert.equal(
    migrationUrl({ MIGRATE_DATABASE_URL: "m", DATABASE_URL_UNPOOLED: "u", DATABASE_URL: "d" }),
    "m",
  );
  assert.equal(migrationUrl({ DATABASE_URL_UNPOOLED: "u", DATABASE_URL: "d" }), "u");
  assert.equal(migrationUrl({ DATABASE_URL: "d" }), "d");
  assert.equal(migrationUrl({}), undefined);
});

test("deploy builds migrate production, and previews only on their own DB branch", () => {
  assert.equal(deployTarget({}).migrate, true); // local / VPS
  assert.equal(deployTarget({ VERCEL_ENV: "production" }).migrate, true);
  assert.equal(deployTarget({ VERCEL_ENV: "preview" }).migrate, false);
  assert.equal(deployTarget({ VERCEL_ENV: "development" }).migrate, false);
  assert.equal(deployTarget({ VERCEL_ENV: "preview", PREVIEW_DB_IS_BRANCH: "1" }).migrate, true);
});
