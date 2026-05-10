#!/usr/bin/env bun
/**
 * Test minimal CodeBuddy request with different field combinations
 */

import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq, and, gt } from "drizzle-orm";

async function testRequest(apiKey: string, body: any, label: string) {
  console.log(`\n${label}:`);
  console.log(JSON.stringify(body, null, 2));

  const response = await fetch("https://www.codebuddy.ai/v2/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  console.log(`Status: ${response.status}`);
  const text = await response.text();
  console.log(`Response: ${text.slice(0, 300)}\n`);

  return response.status === 200;
}

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
  console.log(`Testing: ${account.email}`);

  const tokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : account.tokens;

  const apiKey = tokens.api_key || tokens.access_token || tokens.session_token;

  // Test 1: Absolute minimal
  await testRequest(apiKey, {
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "Hi" }],
  }, "Test 1: Minimal (no stream field)");

  // Test 2: With max_tokens
  await testRequest(apiKey, {
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 100,
  }, "Test 2: With max_tokens");

  // Test 3: With temperature
  await testRequest(apiKey, {
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "Hi" }],
    temperature: 1,
  }, "Test 3: With temperature");

  // Test 4: Different model
  await testRequest(apiKey, {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "Hi" }],
  }, "Test 4: Different model (gpt-5.5)");
}

main().catch(console.error);
