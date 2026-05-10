#!/usr/bin/env bun
/**
 * Check if CodeBuddy token is still valid by testing different endpoints
 */

import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq, and, gt } from "drizzle-orm";

async function main() {
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
    .limit(1);

  if (availableAccounts.length === 0) {
    console.log("❌ No accounts found");
    process.exit(1);
  }

  const account = availableAccounts[0];
  console.log(`Testing: ${account.email}\n`);

  const tokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : account.tokens;

  const apiKey = tokens.api_key || tokens.access_token || tokens.session_token;

  // Test 1: Check /billing/meter/get-user-resource endpoint
  console.log("1. Testing billing endpoint...");
  const now = new Date();
  const endDate = new Date(now.getTime() + 365 * 20 * 24 * 60 * 60 * 1000);

  const billingResponse = await fetch("https://www.codebuddy.ai/billing/meter/get-user-resource", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: now.toISOString().replace("T", " ").slice(0, 19),
      PackageEndTimeRangeEnd: endDate.toISOString().replace("T", " ").slice(0, 19),
    }),
  });

  console.log(`   Status: ${billingResponse.status}`);
  const billingText = await billingResponse.text();
  console.log(`   Response: ${billingText.slice(0, 200)}\n`);

  // Test 2: Try v1 endpoint instead of v2
  console.log("2. Testing v1/chat/completions endpoint...");
  const v1Response = await fetch("https://www.codebuddy.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hi" }],
      model: "gemini-2.5-flash",
      stream: false,
    }),
  });

  console.log(`   Status: ${v1Response.status}`);
  const v1Text = await v1Response.text();
  console.log(`   Response: ${v1Text.slice(0, 200)}`);
}

main().catch(console.error);
