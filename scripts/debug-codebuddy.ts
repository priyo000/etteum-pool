#!/usr/bin/env bun
/**
 * Debug CodeBuddy request to see what's being sent
 */

import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq, and, gt } from "drizzle-orm";

async function main() {
  console.log("🔍 Finding one CodeBuddy account with quota...\n");

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
  console.log(`Quota: ${account.quotaRemaining}/${account.quotaLimit}\n`);

  // Parse tokens
  const tokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : account.tokens;

  const apiKey = tokens.api_key || tokens.access_token || tokens.session_token;

  // Build request body - try with claude-opus-4.6 which is confirmed working model
  const body = {
    messages: [
      { role: "user", content: "Say 'Hello from CodeBuddy!' and nothing else." }
    ],
    model: "claude-opus-4.6",
    stream: false,
  };

  console.log("Request body:");
  console.log(JSON.stringify(body, null, 2));
  console.log();

  // Make request
  const response = await fetch("https://www.codebuddy.ai/v2/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-Api-Key": apiKey,
      "Accept": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: JSON.stringify(body),
  });

  console.log(`Response status: ${response.status}`);
  const text = await response.text();
  console.log("Response body:");
  console.log(text);
}

main().catch(console.error);
