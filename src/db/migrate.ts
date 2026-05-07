import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index";
import { existsSync } from "node:fs";

export async function runMigrations() {
  const migrationsFolder = "./drizzle";

  // Only run file-based migrations if the folder exists
  if (existsSync(`${migrationsFolder}/meta/_journal.json`)) {
    console.log("[DB] Running migrations...");
    await migrate(db, { migrationsFolder });
    console.log("[DB] Migrations complete.");
  } else {
    console.log("[DB] No migrations found, skipping. Use 'bun run db:push' to sync schema.");
  }
}

// Run if called directly
if (import.meta.main) {
  await runMigrations();
  console.log("[DB] Database migrated successfully");
  process.exit(0);
}
