import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("fresh database bootstrapping", () => {
  it("creates the core schema tables before idempotent column migrations run", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".tmp-db-test-"));
    const databasePath = join(tempDir, "test.db");
    process.env.DATABASE_PATH = databasePath;

    try {
      const { runMigrations, __testing } = await import("../../src/db/migrate");
      await runMigrations();

      const { client } = await import("../../src/db/index");
      const tables = client
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accounts', 'request_logs', 'settings', 'filter_rules', 'model_mappings')")
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((row) => row.name).sort();
      expect(tableNames).toEqual(["accounts", "filter_rules", "model_mappings", "request_logs", "settings"]);
      expect(__testing?.tableExists("accounts")).toBe(true);
    } finally {
      try {
        const { client } = await import("../../src/db/index");
        client.close();
      } catch {
        // ignore
      }
      delete process.env.DATABASE_PATH;
    }
  });
});
