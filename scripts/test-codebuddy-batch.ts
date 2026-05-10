#!/usr/bin/env bun
/**
 * Batch test CodeBuddy accounts with available quota
 */

import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { CodeBuddyProvider } from "../src/proxy/providers/codebuddy";

const provider = new CodeBuddyProvider();

async function main() {
  console.log("🔍 Finding CodeBuddy accounts with quota...\n");

  // Get accounts with quota > 10 credits, ordered by most quota first
  const availableAccounts = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.provider, "codebuddy"),
        eq(accounts.status, "active"),
        gt(accounts.quotaRemaining, 10)
      )
    )
    .orderBy(accounts.quotaRemaining)
    .limit(5);

  if (availableAccounts.length === 0) {
    console.log("❌ No accounts with sufficient quota found");
    process.exit(1);
  }

  console.log(`Found ${availableAccounts.length} accounts with quota:\n`);

  for (const account of availableAccounts) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📧 Testing: ${account.email}`);
    console.log(`💳 Quota: ${account.quotaRemaining}/${account.quotaLimit} credits`);
    console.log(`${"=".repeat(60)}\n`);

    // Test 1: Simple completion
    console.log("1️⃣  Testing simple completion...");
    const startTime = Date.now();

    const result = await provider.chatCompletion(account, {
      model: "gemini-2.5-flash",
      messages: [
        { role: "user", content: "Say 'Hello from CodeBuddy!' and nothing else." }
      ],
      max_tokens: 50,
    });

    const duration = Date.now() - startTime;

    if (result.success && result.response) {
      console.log(`   ✅ Success (${duration}ms)`);
      console.log(`   Response: ${result.response.choices[0]?.message?.content || "(empty)"}`);
      console.log(`   Tokens: ${result.tokensUsed} (prompt: ${result.promptTokens}, completion: ${result.completionTokens})`);
      console.log(`   Credits: ${result.creditsUsed?.toFixed(4)} (${result.creditSource})`);

      // Test passed, break after first successful account
      console.log(`\n✅ Test completed successfully with ${account.email}`);
      break;
    } else {
      console.log(`   ❌ Failed: ${result.error}`);
      if (result.quotaExhausted) {
        console.log(`   ⚠️  Quota exhausted, trying next account...`);
      }
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
