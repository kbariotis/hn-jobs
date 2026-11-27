import "dotenv/config";

import { deployTarget, migrationUrl, runMigrations } from "../lib/store/migrate";

// Usage: npm run migrate             local, VPS deploy script
//        npm run migrate -- --deploy  Vercel build (skips previews without their own DB branch)
async function main() {
  if (process.argv.includes("--deploy")) {
    const { migrate, reason } = deployTarget();
    if (!migrate) {
      console.warn(`⚠ Skipping migrations: ${reason}`);
      return;
    }
    console.log(`Migrating: ${reason}`);
  }
  const url = migrationUrl();
  if (!url) {
    throw new Error(
      "No database URL (MIGRATE_DATABASE_URL / DATABASE_URL_UNPOOLED / DATABASE_URL).",
    );
  }
  await runMigrations(url);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
