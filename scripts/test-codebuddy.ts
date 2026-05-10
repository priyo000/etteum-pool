#!/usr/bin/env bun
/**
 * Test script for CodeBuddy provider
 * Tests basic chat completion with a simple prompt
 */

import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { CodeBuddyProvider } from "../src/proxy/providers/codebuddy";

const provider = new CodeBuddyProvider();

async function main() {
  console.log("🧪 Testing CodeBuddy Provider\n");

  // Get a CodeBuddy account from the database
  const codebuddyAccounts = await db
    .select()
    .from(accounts)
    .where(eq(accounts.provider, "codebuddy"))
    .limit(1);

  if (codebuddyAccounts.length === 0) {
    console.error("❌ No CodeBuddy accounts found in database");
    console.log("Add a CodeBuddy account first using the dashboard or API");
    process.exit(1);
  }

  const account = codebuddyAccounts[0];
  console.log(`📧 Using account: ${account.email}`);
  console.log(`💳 Quota: ${account.quotaRemaining}/${account.quotaLimit} credits\n`);

  // Test 1: Health check
  console.log("1️⃣  Testing health check...");
  const health = await provider.healthCheck(account);
  console.log(`   Status: ${health.kind}`);
  console.log(`   Success: ${health.success}`);
  if (health.quota) {
    console.log(`   Quota: ${health.quota.remaining}/${health.quota.limit} (${health.quota.source})`);
  }
  if (health.error) {
    console.log(`   Error: ${health.error}`);
  }
  console.log();

  if (!health.success) {
    console.error("❌ Health check failed, stopping tests");
    process.exit(1);
  }

  // Test 2: Simple chat completion (non-streaming)
  console.log("2️⃣  Testing chat completion (non-streaming)...");
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
  } else {
    console.log(`   ❌ Failed: ${result.error}`);
    if (result.quotaExhausted) {
      console.log(`   ⚠️  Quota exhausted`);
    }
  }
  console.log();

  // Test 3: Streaming chat completion
  console.log("3️⃣  Testing chat completion (streaming)...");
  const streamStartTime = Date.now();

  const streamResult = await provider.chatCompletionStream(account, {
    model: "gemini-2.5-flash",
    messages: [
      { role: "user", content: "Count from 1 to 5, one number per line." }
    ],
    max_tokens: 100,
  });

  if (streamResult.success && streamResult.stream) {
    console.log(`   ✅ Stream started`);

    const reader = streamResult.stream.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";
    let chunkCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split("\n");

        for (const line of lines) {
          if (!line.trim() || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data);
            const content = chunk.choices?.[0]?.delta?.content || "";
            if (content) {
              fullContent += content;
              chunkCount++;
            }
          } catch {
            // Skip malformed chunks
          }
        }
      }

      const streamDuration = Date.now() - streamStartTime;
      console.log(`   Content: ${fullContent.trim()}`);
      console.log(`   Chunks: ${chunkCount}, Duration: ${streamDuration}ms`);
    } catch (error) {
      console.log(`   ❌ Stream error: ${error}`);
    }
  } else {
    console.log(`   ❌ Failed: ${streamResult.error}`);
  }
  console.log();

  // Test 4: Model with thinking (if quota allows)
  if (health.quota && health.quota.remaining > 10) {
    console.log("4️⃣  Testing model with thinking...");
    const thinkingStartTime = Date.now();

    const thinkingResult = await provider.chatCompletion(account, {
      model: "gemini-2.5-pro",
      messages: [
        { role: "user", content: "What is 15 * 23? Show your work." }
      ],
      max_tokens: 200,
    });

    const thinkingDuration = Date.now() - thinkingStartTime;

    if (thinkingResult.success && thinkingResult.response) {
      console.log(`   ✅ Success (${thinkingDuration}ms)`);
      const message = thinkingResult.response.choices[0]?.message;
      console.log(`   Response: ${message?.content?.slice(0, 150) || "(empty)"}...`);
      console.log(`   Tokens: ${thinkingResult.tokensUsed}`);
      console.log(`   Credits: ${thinkingResult.creditsUsed?.toFixed(4)}`);
    } else {
      console.log(`   ❌ Failed: ${thinkingResult.error}`);
    }
    console.log();
  }

  console.log("✅ All tests completed!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
