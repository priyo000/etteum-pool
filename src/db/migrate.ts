import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db, client } from "./index";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";

/**
 * Create all tables if they don't exist (fresh deploy support).
 * Each statement runs independently with try/catch so that:
 *   - Tables that already exist (possibly from older schema) are untouched
 *   - Indexes that reference columns not in an existing table are skipped
 * This ensures the database is usable even without drizzle migration files.
 */
function ensureTablesExist() {
  const statements = [
    // ── accounts ──
    `CREATE TABLE IF NOT EXISTS accounts (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      provider text NOT NULL,
      email text NOT NULL,
      password text NOT NULL,
      status text DEFAULT 'pending' NOT NULL,
      enabled integer DEFAULT 1 NOT NULL,
      tokens text,
      quota_limit real DEFAULT 0,
      quota_remaining real DEFAULT 0,
      quota_reset_at integer,
      last_used_at integer,
      last_login_at integer,
      error_message text,
      metadata text,
      created_at integer NOT NULL,
      updated_at integer
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_email_idx ON accounts (provider, email)`,

    // ── request_logs ──
    `CREATE TABLE IF NOT EXISTS request_logs (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      account_id integer REFERENCES accounts(id),
      provider text NOT NULL,
      model text,
      prompt_tokens integer DEFAULT 0,
      completion_tokens integer DEFAULT 0,
      total_tokens integer DEFAULT 0,
      credits_used real DEFAULT 0,
      status text NOT NULL,
      duration_ms integer,
      error_message text,
      request_body text,
      response_body text,
      account_email text,
      account_quota_before real DEFAULT 0,
      account_quota_after real DEFAULT 0,
      compression_stats text,
      created_at integer NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS request_logs_created_at_idx ON request_logs (created_at)`,
    `CREATE INDEX IF NOT EXISTS request_logs_status_created_at_idx ON request_logs (status, created_at)`,
    `CREATE INDEX IF NOT EXISTS request_logs_provider_created_at_idx ON request_logs (provider, created_at)`,
    `CREATE INDEX IF NOT EXISTS request_logs_provider_model_status_idx ON request_logs (provider, model, status)`,
    `CREATE INDEX IF NOT EXISTS request_logs_account_idx ON request_logs (account_id)`,

    // ── settings ──
    `CREATE TABLE IF NOT EXISTS settings (
      key text PRIMARY KEY NOT NULL,
      value text,
      updated_at integer
    )`,

    // ── usage_summary ──
    `CREATE TABLE IF NOT EXISTS usage_summary (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      bucket text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      total_requests integer DEFAULT 0,
      success_requests integer DEFAULT 0,
      error_requests integer DEFAULT 0,
      prompt_tokens integer DEFAULT 0,
      completion_tokens integer DEFAULT 0,
      total_tokens integer DEFAULT 0,
      credits_used real DEFAULT 0,
      total_duration_ms integer DEFAULT 0
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS usage_summary_bucket_provider_model_idx ON usage_summary (bucket, provider, model)`,
    `CREATE INDEX IF NOT EXISTS usage_summary_bucket_idx ON usage_summary (bucket)`,
    `CREATE INDEX IF NOT EXISTS usage_summary_provider_idx ON usage_summary (provider, bucket)`,

    // ── vcc_cards ──
    `CREATE TABLE IF NOT EXISTS vcc_cards (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      number text NOT NULL,
      exp_month text NOT NULL,
      exp_year text NOT NULL,
      cvv text NOT NULL,
      name text DEFAULT 'John Doe',
      status text DEFAULT 'active' NOT NULL,
      used_by_account_id integer REFERENCES accounts(id),
      created_at integer NOT NULL,
      updated_at integer
    )`,
    `CREATE INDEX IF NOT EXISTS vcc_cards_status_idx ON vcc_cards (status)`,

    // ── vcc_transactions ──
    `CREATE TABLE IF NOT EXISTS vcc_transactions (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      account_id integer REFERENCES accounts(id),
      card_last4 text NOT NULL,
      card_brand text,
      amount real,
      currency text DEFAULT 'usd',
      status text NOT NULL,
      stripe_charge_id text,
      created_at integer NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS vcc_transactions_account_idx ON vcc_transactions (account_id)`,
    `CREATE INDEX IF NOT EXISTS vcc_transactions_status_idx ON vcc_transactions (status)`,

    // ── image_studio_chats ──
    `CREATE TABLE IF NOT EXISTS image_studio_chats (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      title text,
      messages text NOT NULL,
      final_prompt text,
      options text,
      assist_model text,
      created_at integer NOT NULL,
      updated_at integer
    )`,
    `CREATE INDEX IF NOT EXISTS image_studio_chats_updated_at_idx ON image_studio_chats (updated_at)`,

    // ── image_studio_results ──
    `CREATE TABLE IF NOT EXISTS image_studio_results (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      chat_id integer REFERENCES image_studio_chats(id) ON DELETE SET NULL,
      prompt text NOT NULL,
      type text DEFAULT 'image' NOT NULL,
      aspect_ratio text DEFAULT '1:1' NOT NULL,
      n integer DEFAULT 1 NOT NULL,
      urls text NOT NULL,
      credits_used real DEFAULT 0,
      created_at integer NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS image_studio_results_created_at_idx ON image_studio_results (created_at)`,
    `CREATE INDEX IF NOT EXISTS image_studio_results_chat_idx ON image_studio_results (chat_id)`,

    // ── filter_rules ──
    `CREATE TABLE IF NOT EXISTS filter_rules (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      rule_id text NOT NULL UNIQUE,
      pattern text NOT NULL,
      replacement text DEFAULT '' NOT NULL,
      is_active integer DEFAULT 1 NOT NULL,
      is_regex integer DEFAULT 0 NOT NULL,
      sort_order integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      updated_at integer
    )`,
    `CREATE INDEX IF NOT EXISTS filter_rules_sort_order_idx ON filter_rules (sort_order)`,

    // ── proxy_pool (matches schema.ts: url, type, label, status, ...) ──
    `CREATE TABLE IF NOT EXISTS proxy_pool (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      url text NOT NULL,
      type text DEFAULT 'http' NOT NULL,
      label text,
      status text DEFAULT 'active' NOT NULL,
      last_used_at integer,
      last_checked_at integer,
      error_message text,
      latency_ms integer,
      success_count integer DEFAULT 0,
      fail_count integer DEFAULT 0,
      created_at integer NOT NULL,
      updated_at integer
    )`,
    `CREATE INDEX IF NOT EXISTS proxy_pool_status_idx ON proxy_pool (status)`,

    // ── model_mappings ──
    `CREATE TABLE IF NOT EXISTS model_mappings (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      source_pattern text NOT NULL,
      match_type text DEFAULT 'contains' NOT NULL,
      target_model text DEFAULT '' NOT NULL,
      enabled integer DEFAULT 1 NOT NULL,
      priority integer DEFAULT 0 NOT NULL,
      label text,
      created_at integer NOT NULL,
      updated_at integer
    )`,
    `CREATE INDEX IF NOT EXISTS model_mappings_priority_idx ON model_mappings (priority)`,
  ];

  for (const stmt of statements) {
    try {
      client.exec(stmt);
    } catch {
      // Ignore: table already exists with different schema, or index column missing.
      // This is expected on existing DBs where schema evolved via manual ALTER TABLE.
    }
  }
}

/**
 * Idempotent column-add migrations.
 * The drizzle/ folder is gitignored in this repo — fresh deploys would never
 * see file-based migrations for new columns. Each entry below adds a column
 * if it doesn't already exist; safe to run on every boot.
 *
 * Order: from oldest schema additions to newest. Add to the END of the list
 * when you add a new column to schema.ts.
 */
const IDEMPOTENT_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // 2026-06-13 — compression_stats (token-saver telemetry, see src/proxy/compression/)
  { table: "request_logs", column: "compression_stats", ddl: "ALTER TABLE request_logs ADD COLUMN compression_stats TEXT" },
];

function tableHasColumn(table: string, column: string): boolean {
  try {
    const rows = client.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function runIdempotentColumns() {
  for (const m of IDEMPOTENT_COLUMNS) {
    if (tableHasColumn(m.table, m.column)) continue;
    try {
      await db.run(sql.raw(m.ddl));
      console.log(`[DB] Added column ${m.table}.${m.column}`);
    } catch (err) {
      // Re-check: another process may have added it concurrently.
      if (!tableHasColumn(m.table, m.column)) {
        console.error(`[DB] Failed to add ${m.table}.${m.column}:`, err);
      }
    }
  }
}

export async function runMigrations() {
  // Always ensure tables exist (handles fresh deploys without migration files)
  ensureTablesExist();
  
  const migrationsFolder = "./drizzle";

  // Only run file-based migrations if the folder exists
  if (existsSync(`${migrationsFolder}/meta/_journal.json`)) {
    console.log("[DB] Running migrations...");
    await migrate(db, { migrationsFolder });
    console.log("[DB] Migrations complete.");
  } else {
    console.log("[DB] Tables ensured. No additional migrations found.");
  }

  // Always run idempotent column-add migrations (works on fresh deploys without drizzle/).
  await runIdempotentColumns();
}

// Run if called directly
if (import.meta.main) {
  await runMigrations();
  console.log("[DB] Database migrated successfully");
  process.exit(0);
}
