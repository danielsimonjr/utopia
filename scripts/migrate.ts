#!/usr/bin/env bun
/**
 * Run database migrations without starting the server.
 *
 * Usage: bun run scripts/migrate.ts
 * Reads UTOPIA_MIGRATION_URL, or UTOPIA_DATABASE_URL when that is not set.
 */
import { connect, migrate } from "../server/src/core/db";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

async function main(): Promise<void> {
  const url = process.env.UTOPIA_MIGRATION_URL || process.env.UTOPIA_DATABASE_URL;
  if (!url) {
    console.error("Set UTOPIA_MIGRATION_URL or UTOPIA_DATABASE_URL before you run this script.");
    process.exit(1);
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sql = connect(url, 2);
  await migrate(sql, join(repoRoot, "migrations"));
  await sql.end();
  console.log("Migrations complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
