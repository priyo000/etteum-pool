#!/usr/bin/env bun
import { sql } from "bun";
import { createCipheriv, randomBytes, scryptSync } from "crypto";

const ENOWXAI_API_URL = "http://127.0.0.1:1431/api/accounts";
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://priyo:000521@localhost:5432/pool_proxy";

interface EnowxaiAccount {
  id: string;
  email: string;
  provider: string;
  status: string;
  credit_limit: number;
  remaining_credits: number;
  created_at: string;
  cookies?: string;
  tokens?: any;
}

interface EnowxaiResponse {
  accounts: EnowxaiAccount[];
}

function encryptPassword(password: string): string {
  const key = scryptSync(ENCRYPTION_KEY, "salt", 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);

  let encrypted = cipher.update(password, "utf8", "hex");
  encrypted += cipher.final("hex");

  return `${iv.toString("hex")}:${encrypted}`;
}

async function fetchEnowxaiAccounts(): Promise<EnowxaiAccount[]> {
  try {
    const response = await fetch(ENOWXAI_API_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch accounts: ${response.statusText}`);
    }
    const data: EnowxaiResponse = await response.json();
    return data.accounts.filter((acc) => acc.provider === "kiro");
  } catch (error) {
    console.error("❌ Error fetching from enowxai API:", error);
    throw error;
  }
}

async function migrateAccounts() {
  console.log("🔍 Fetching Kiro accounts from enowxai API...");

  const enowxaiAccounts = await fetchEnowxaiAccounts();
  console.log(`📁 Found ${enowxaiAccounts.length} Kiro accounts in enowxai`);

  const db = sql(DATABASE_URL);

  let migratedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const account of enowxaiAccounts) {
    try {
      // Check if account already exists
      const existing = await db`
        SELECT id FROM accounts
        WHERE provider = 'kiro' AND email = ${account.email}
      `;

      if (existing.length > 0) {
        console.log(`⏭️  Skipping ${account.email} - already exists`);
        skippedCount++;
        continue;
      }

      // Encrypt a placeholder password
      const encryptedPassword = encryptPassword("placeholder_password");

      // Prepare tokens JSONB - use existing tokens if available, otherwise create basic structure
      const tokens = account.tokens || {
        web_cookie: account.cookies || "",
        expires_in: "3600",
      };

      // Prepare metadata JSONB
      const metadata = {
        source: "enowxai_api_migration",
        migrated_at: new Date().toISOString(),
        enowxai_id: account.id,
        enowxai_created_at: account.created_at,
      };

      // Map enowxai status to poolprox2 status
      let status = "pending";
      if (account.status === "active") {
        status = "active";
      } else if (account.status === "error") {
        status = "error";
      }

      // Insert into database
      await db`
        INSERT INTO accounts (
          provider,
          email,
          password,
          status,
          tokens,
          quota_limit,
          quota_remaining,
          metadata,
          created_at,
          updated_at
        ) VALUES (
          'kiro',
          ${account.email},
          ${encryptedPassword},
          ${status},
          ${JSON.stringify(tokens)}::jsonb,
          ${account.credit_limit || 0},
          ${account.remaining_credits || 0},
          ${JSON.stringify(metadata)}::jsonb,
          NOW(),
          NOW()
        )
      `;

      migratedCount++;
      console.log(`✅ Migrated ${account.email} (${account.remaining_credits}/${account.credit_limit} credits)`);

    } catch (error) {
      errorCount++;
      console.error(`❌ Error processing ${account.email}:`, error);
    }
  }

  console.log("\n📊 Migration Summary:");
  console.log(`   ✅ Kiro accounts migrated: ${migratedCount}`);
  console.log(`   ⏭️  Skipped (already exists): ${skippedCount}`);
  console.log(`   ❌ Errors: ${errorCount}`);
  console.log(`   📁 Total enowxai accounts: ${enowxaiAccounts.length}`);
}

// Run migration
migrateAccounts().catch((error) => {
  console.error("💥 Migration failed:", error);
  process.exit(1);
});
