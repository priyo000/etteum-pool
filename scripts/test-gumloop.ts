/**
 * E2E test for Gumloop provider.
 *
 * Usage:
 *   GUMLOOP_FIREBASE_API_KEY=*** scripts/test-gumloop.ts
 *
 * Reads test account from /tmp/gumloop_result.json (created by the
 * Playwright live-verify session). If that file is missing, falls back to
 * env vars GUMLOOP_TEST_UID + GUMLOOP_TEST_REFRESH_TOKEN + GUMLOOP_TEST_API_KEY.
 *
 * Tests:
 *   1. validateAccount (refresh Firebase idToken)
 *   2. chatCompletion (non-stream, "Say hello in one word.")
 *   3. chatCompletionStream (stream, "Count from 1 to 5.")
 *   4. chatCompletion with tool call (get_weather)
 */
import { readFileSync, existsSync } from "node:fs";
import { GumloopProvider } from "../src/proxy/providers/gumloop";
import { config } from "../src/config";
import type { Account } from "../src/db/schema";

interface ResultFile {
  uid: string;
  api_key?: string;
  registered?: boolean;
}

function loadTestAccount(): Account {
  // Try /tmp/gumloop_result.json first
  const resultFile = "/tmp/gumloop_result.json";
  if (existsSync(resultFile)) {
    const data = JSON.parse(readFileSync(resultFile, "utf8")) as ResultFile;
    if (data.uid && data.api_key) {
      console.log(`✓ Loaded test account from ${resultFile}`);
      console.log(`  uid: ${data.uid}`);
      console.log(`  api_key: ${data.api_key.slice(0, 8)}...${data.api_key.slice(-4)} (pre-registered)`);
      return {
        id: 999999,
        provider: "gumloop",
        email: `test-${data.uid.slice(0, 8)}@firebase`,
        password: "",
        status: "active",
        enabled: true,
        tokens: {
          uid: data.uid,
          refresh_token: process.env.GUMLOOP_TEST_REFRESH_TOKEN || "",
          api_key: data.api_key,
        },
        quotaLimit: -1,
        quotaRemaining: -1,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as Account;
    }
  }

  // Fallback to env vars
  const uid = process.env.GUMLOOP_TEST_UID;
  const refreshToken = process.env.GUMLOOP_TEST_REFRESH_TOKEN;
  const apiKey = process.env.GUMLOOP_TEST_API_KEY;
  if (!uid || !refreshToken) {
    console.error("✗ No test account found.");
    console.error(`  Either create ${resultFile} (via Playwright live test)`);
    console.error("  Or set env vars: GUMLOOP_TEST_UID, GUMLOOP_TEST_REFRESH_TOKEN, [GUMLOOP_TEST_API_KEY]");
    process.exit(1);
  }
  console.log(`✓ Loaded test account from env vars`);
  console.log(`  uid: ${uid}`);
  console.log(`  api_key: ${apiKey ? apiKey.slice(0, 8) + "..." + apiKey.slice(-4) : "(will auto-register)"}`);
  return {
    id: 999999,
    provider: "gumloop",
    email: `test-${uid.slice(0, 8)}@firebase`,
    password: "",
    status: "active",
    enabled: true,
    tokens: { uid, refresh_token: refreshToken, api_key: apiKey },
    quotaLimit: -1,
    quotaRemaining: -1,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Account;
}

async function main() {
  console.log("=".repeat(60));
  console.log("GUMLOOP PROVIDER E2E TEST");
  console.log("=".repeat(60));

  if (!config.gumloopFirebaseApiKey) {
    console.error("✗ GUMLOOP_FIREBASE_API_KEY not set in env");
    console.error("  Set it to the Gumloop Firebase web API key (project agenthub-dev, public)");
    process.exit(1);
  }
  console.log(`Firebase API key: ${config.gumloopFirebaseApiKey.slice(0, 10)}...`);
  console.log();

  const account = loadTestAccount();
  const provider = new GumloopProvider();

  // ── Test 1: validateAccount ─────────────────────────────────────────
  console.log("=".repeat(60));
  console.log("TEST 1: validateAccount (refresh Firebase idToken)");
  console.log("=".repeat(60));
  const valid = await provider.validateAccount(account);
  console.log(`Result: ${valid ? "✓ VALID" : "✗ INVALID"}`);
  if (!valid) {
    console.error("Account validation failed. Check refresh_token & Firebase API key.");
    process.exit(1);
  }
  console.log();

  // ── Test 2: chatCompletion (non-stream) ─────────────────────────────
  console.log("=".repeat(60));
  console.log('TEST 2: chatCompletion (non-stream) — "Say hello in one word."');
  console.log("=".repeat(60));
  const t1Start = Date.now();
  const r1 = await provider.chatCompletion(account, {
    model: "gl-claude-sonnet-4.5",
    messages: [{ role: "user", content: "Say hello in one word." }],
    stream: false,
  });
  console.log(`Duration: ${Date.now() - t1Start}ms`);
  console.log(`Success: ${r1.success}`);
  if (r1.error) console.log(`Error: ${r1.error}`);
  if (r1.response) {
    const content = r1.response.choices?.[0]?.message?.content;
    const usage = r1.response.usage;
    console.log(`Content: ${JSON.stringify(content)}`);
    console.log(`Usage: prompt=${usage?.prompt_tokens} completion=${usage?.completion_tokens} total=${usage?.total_tokens}`);
  }
  console.log();

  // ── Test 3: chatCompletionStream ────────────────────────────────────
  console.log("=".repeat(60));
  console.log('TEST 3: chatCompletionStream — "Count from 1 to 5."');
  console.log("=".repeat(60));
  const t2Start = Date.now();
  const r2 = await provider.chatCompletionStream(account, {
    model: "gl-claude-sonnet-4.5",
    messages: [{ role: "user", content: "Count from 1 to 5." }],
    stream: true,
  });
  console.log(`Duration: ${Date.now() - t2Start}ms (to first byte)`);
  console.log(`Success: ${r2.success}`);
  if (r2.error) console.log(`Error: ${r2.error}`);
  if (r2.stream) {
    console.log("Streaming response:");
    const reader = r2.stream.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let chunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      fullText += text;
      chunkCount++;
      // Print first 5 chunks in detail
      if (chunkCount <= 5) {
        console.log(`  [chunk ${chunkCount}] ${text.slice(0, 200).replace(/\n/g, "\\n")}`);
      }
    }
    console.log(`  ... total ${chunkCount} chunks, ${fullText.length} bytes`);
    console.log(`  Stream usage: prompt=${r2.promptTokens} completion=${r2.completionTokens} total=${r2.tokensUsed}`);
  }
  console.log();

  // ── Test 4: Tool call ───────────────────────────────────────────────
  console.log("=".repeat(60));
  console.log("TEST 4: chatCompletion with tool call (get_weather)");
  console.log("=".repeat(60));
  const t3Start = Date.now();
  const r3 = await provider.chatCompletion(account, {
    model: "gl-claude-sonnet-4.5",
    messages: [{ role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." }],
    stream: false,
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather for a location",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
          required: ["location"],
        },
      },
    }],
  });
  console.log(`Duration: ${Date.now() - t3Start}ms`);
  console.log(`Success: ${r3.success}`);
  if (r3.error) console.log(`Error: ${r3.error}`);
  if (r3.response) {
    const choice = r3.response.choices?.[0];
    console.log(`finish_reason: ${choice?.finish_reason}`);
    console.log(`content: ${JSON.stringify(choice?.message?.content)}`);
    if (choice?.message?.tool_calls) {
      console.log(`tool_calls:`);
      for (const tc of choice.message.tool_calls) {
        console.log(`  - id: ${tc.id}`);
        console.log(`    type: ${tc.type}`);
        console.log(`    function: ${tc.function?.name}(${tc.function?.arguments})`);
      }
    }
    const usage = r3.response.usage;
    console.log(`Usage: prompt=${usage?.prompt_tokens} completion=${usage?.completion_tokens} total=${usage?.total_tokens}`);
  }
  console.log();

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Test 1 (validateAccount):    ${valid ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`Test 2 (non-stream chat):     ${r1.success ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`Test 3 (stream chat):         ${r2.success ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`Test 4 (tool call):           ${r3.success ? "✓ PASS" : "✗ FAIL"}`);
  const allPass = valid && r1.success && r2.success && r3.success;
  console.log();
  console.log(`Overall: ${allPass ? "✓ ALL TESTS PASSED" : "✗ SOME TESTS FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
