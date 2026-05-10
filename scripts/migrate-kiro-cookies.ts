#!/usr/bin/env bun
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { createCipheriv, randomBytes, scryptSync } from "crypto";
import { sql } from "bun";

const ENOWXAI_COOKIES_DIR = "/home/priyo/.local/lib/enowxai/cookies";
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://priyo:000521@localhost:5432/pool_proxy";

interface CookieFile {
  email: string;
  saved_at: number;
  expires_at: number;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
  }>;
}

function encryptPassword(password: string): string {
  const key = scryptSync(ENCRYPTION_KEY, "salt", 32);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);

  let encrypted = cipher.update(password, "utf8", "hex");
  encrypted += cipher.final("hex");

  return `${iv.toString("hex")}:${encrypted}`;
}

function cookiesToWebCookieString(cookies: CookieFile["cookies"]): string {
  return cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

function isKiroCookie(cookieFile: CookieFile): boolean {
  // Check if any cookie domain contains kiro or claude related domains
  const kiroDomains = ["kiro.dev", "claude.ai", "anthropic.com"];
  return cookieFile.cookies.some((cookie) =>
    kiroDomains.some((domain) => cookie.domain.includes(domain))
  );
}

async function migrateCookies() {
  console.log("🔍 Scanning enowxai cookies directory...");

  const files = await readdir(ENOWXAI_COOKIES_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  console.log(`📁 Found ${jsonFiles.length} cookie files`);

  const db = sql(DATABASE_URL);

  let kiroCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const file of jsonFiles) {
    try {
      const filePath = join(ENOWXAI_COOKIES_DIR, file);
      const content = await readFile(filePath, "utf-8");
      const cookieData: CookieFile = JSON.parse(content);

      // Check if this is a Kiro cookie
      if (!isKiroCookie(cookieData)) {
        skippedCount++;
        continue;
      }

      const email = cookieData.email;
      const webCookie = cookiesToWebCookieString(cookieData.cookies);

      // Check if account already exists
      const existing = await db`
        SELECT id FROM accounts
        WHERE provider = 'kiro' AND email = ${email}
      `;

      if (existing.length > 0) {
        console.log(`⏭️  Skipping ${email} - already exists`);
        skippedCount++;
        continue;
      }

      // Encrypt a placeholder password (since we don't have the actual password)
      const encryptedPassword = encryptPassword("placeholder_password");

      // Prepare tokens JSONB
      const tokens = {
        web_cookie: webCookie,
        saved_at: cookieData.saved_at,
        expires_at: cookieData.expires_at,
      };

      // Prepare metadata JSONB
      const metadata = {
        source: "enowxai_migration",
        migrated_at: new Date().toISOString(),
        cookie_file: file,
      };

      // Insert into database
      await db`
        INSERT INTO accounts (
          provider,
          email,
          password,
          status,
          tokens,
          metadata,
          created_at,
          updated_at
        ) VALUES (
          'kiro',
          ${email},
          ${encryptedPassword},
          'pending',
          ${JSON.stringify(tokens)}::jsonb,
          ${JSON.stringify(metadata)}::jsonb,
          NOW(),
          NOW()
        )
      `;

      kiroCount++;
      console.log(`✅ Migrated ${email}`);

    } catch (error) {
      errorCount++;
      console.error(`❌ Error processing ${file}:`, error);
    }
  }

  // Bun.sql doesn't have .end() method, connection is auto-managed

  console.log("\n📊 Migration Summary:");
  console.log(`   ✅ Kiro accounts migrated: ${kiroCount}`);
  console.log(`   ⏭️  Skipped (non-Kiro or duplicate): ${skippedCount}`);
  console.log(`   ❌ Errors: ${errorCount}`);
  console.log(`   📁 Total files processed: ${jsonFiles.length}`);
}

// Run migration
migrateCookies().catch((error) => {
  console.error("💥 Migration failed:", error);
  process.exit(1);
});
