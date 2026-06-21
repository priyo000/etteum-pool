/**
 * E2E live test for Gumloop provider.
 *
 * Usage:
 *   bun run scripts/test-gumloop-live.ts
 *
 * Prerequisites:
 *   - .env contains GUMLOOP_FIREBASE_API_KEY
 *   - /tmp/gumloop_result.json contains uid + refresh_token + api_key from Playwright login
 */
import { GumloopProvider } from "../src/proxy/providers/gumloop";
import type { Account } from "../src/db/schema";

interface TestResult {
  step: string;
  status: "pass" | "fail";
  detail: string;
}

const results: TestResult[] = [];

function log(step: string, status: "pass" | "fail", detail: string) {
  const icon = status === "pass" ? "✅" : "❌";
  console.log(`${icon} ${step}: ${detail}`);
  results.push({ step, status, detail });
}

// Read credentials from result.json
const fs = await import("fs");
const resultPath = "/tmp/gumloop_result.json";
if (!fs.existsSync(resultPath)) {
  console.error("❌ /tmp/gumloop_result.json not found. Run gumloop_playwright.cjs first.");
  process.exit(1);
}
const cred = JSON.parse(fs.readFileSync(resultPath, "utf8"));

if (!cred.uid || !cred.refresh_token) {
  console.error("❌ Missing uid or refresh_token in result.json");
  process.exit(1);
}

// Build a dummy Account object (bypasses DB)
// Use `as unknown as Account` to avoid listing all 15+ schema columns
const dummyAccount = {
  id: 99999,
  provider: "gumloop",
  email: `gumloop-${cred.uid.slice(0, 8)}@firebase`,
  password: "", // refresh_token is in tokens
  tokens: JSON.stringify({
    uid: cred.uid,
    refresh_token: cred.refresh_token,
    api_key: cred.api_key, // may be the 403 key — provider will auto-fetch the active one
  }),
  status: "active",
} as unknown as Account;

const provider = new GumloopProvider();
console.log("=".repeat(60));
console.log("Gumloop Provider E2E Live Test");
console.log("=".repeat(60));
console.log(`uid: ${cred.uid}`);
console.log(`cached api_key: ${cred.api_key?.slice(0, 8)}...`);
console.log();

// ── Test 1: validateAccount (Firebase refresh) ────────────────────────
console.log("─".repeat(60));
console.log("TEST 1: validateAccount (Firebase refresh_token check)");
console.log("─".repeat(60));
try {
  const valid = await provider.validateAccount(dummyAccount);
  log("validateAccount", valid ? "pass" : "fail", valid ? "refresh_token is valid" : "refresh_token invalid");
} catch (err: any) {
  log("validateAccount", "fail", err.message);
}

// ── Test 2: refreshToken ──────────────────────────────────────────────
console.log("\n" + "─".repeat(60));
console.log("TEST 2: refreshToken (get fresh Firebase idToken)");
console.log("─".repeat(60));
try {
  const r = await provider.refreshToken(dummyAccount);
  log("refreshToken", r.success ? "pass" : "fail", r.success ? `new tokens saved (${r.tokens?.length} chars)` : r.error || "failed");
} catch (err: any) {
  log("refreshToken", "fail", err.message);
}

// ── Test 3: Non-streaming chat ────────────────────────────────────────
console.log("\n" + "─".repeat(60));
console.log("TEST 3: Non-streaming chat (gl-claude-sonnet-4.5)");
console.log("─".repeat(60));
try {
  const r = await provider.chatCompletion(dummyAccount, {
    model: "gl-claude-sonnet-4.5",
    messages: [{ role: "user", content: "Say hello in one word." }],
    stream: false,
  });
  if (r.success && r.response) {
    const content = r.response.choices?.[0]?.message?.content || "";
    log("chatCompletion", "pass", `response: "${content}" | tokens: ${r.tokensUsed}`);
  } else {
    log("chatCompletion", "fail", r.error || "unknown error");
  }
} catch (err: any) {
  log("chatCompletion", "fail", err.message);
}

// ── Test 4: Streaming chat ────────────────────────────────────────────
console.log("\n" + "─".repeat(60));
console.log("TEST 4: Streaming chat (gl-claude-sonnet-4.5)");
console.log("─".repeat(60));
try {
  const r = await provider.chatCompletionStream(dummyAccount, {
    model: "gl-claude-sonnet-4.5",
    messages: [{ role: "user", content: "Count from 1 to 5." }],
    stream: true,
  });
  if (r.success && r.stream) {
    const reader = r.stream.getReader();
    const decoder = new TextDecoder();
    let chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const fullText = chunks.join("");
    log("chatCompletionStream", "pass", `received ${chunks.length} chunks, ${fullText.length} bytes | tokens: ${r.tokensUsed}`);
  } else {
    log("chatCompletionStream", "fail", r.error || "unknown error");
  }
} catch (err: any) {
  log("chatCompletionStream", "fail", err.message);
}

// ── Test 5: Tool call ─────────────────────────────────────────────────
console.log("\n" + "─".repeat(60));
console.log("TEST 5: Tool call (get_weather)");
console.log("─".repeat(60));
try {
  const r = await provider.chatCompletion(dummyAccount, {
    model: "gl-claude-sonnet-4.5",
    messages: [{ role: "user", content: "What is the weather in Tokyo? Use the get_weather tool." }],
    stream: false,
    tools: [{
      type: "function" as const,
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
  if (r.success && r.response) {
    const toolCalls = r.response.choices?.[0]?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      log("toolCall", "pass", `tool: ${toolCalls[0].function.name} | args: ${toolCalls[0].function.arguments}`);
    } else {
      log("toolCall", "fail", "no tool_calls in response");
    }
  } else {
    log("toolCall", "fail", r.error || "unknown error");
  }
} catch (err: any) {
  log("toolCall", "fail", err.message);
}

// ── Summary ───────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log("SUMMARY");
console.log("=".repeat(60));
const passed = results.filter((r) => r.status === "pass").length;
const failed = results.filter((r) => r.status === "fail").length;
console.log(`Total: ${results.length} | Pass: ${passed} | Fail: ${failed}`);
for (const r of results) {
  const icon = r.status === "pass" ? "✅" : "❌";
  console.log(`  ${icon} ${r.step}: ${r.detail}`);
}
process.exit(failed > 0 ? 1 : 0);
