#!/usr/bin/env bun
/**
 * Test a fresh account with full headers including web_cookie
 */
import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq, desc, gt } from "drizzle-orm";

const rows = await db.select().from(accounts)
  .where(eq(accounts.provider, "codebuddy"))
  .orderBy(desc(accounts.updatedAt))
  .limit(3);

for (const account of rows) {
  const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
  const apiKey = t?.api_key || t?.access_token || t?.session_token;
  const webCookie = t?.web_cookie || t?.cookies;

  console.log(`\n=== ${account.email} ===`);
  console.log(`api_key: ${apiKey ? apiKey.slice(0, 20) + "..." : "NONE"}`);
  console.log(`web_cookie length: ${webCookie?.length || 0}`);
  console.log(`state: ${t?.state ? JSON.stringify(t.state).slice(0, 80) : "none"}`);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["X-Api-Key"] = apiKey;
  }
  if (webCookie) {
    headers["Cookie"] = webCookie;
  }

  const body = {
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "Say hi" }],
    stream: false,
    max_tokens: 50,
  };

  console.log("\nRequest body:", JSON.stringify(body));

  const res = await fetch("https://www.codebuddy.ai/v2/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  console.log(`Status: ${res.status}`);
  const text = await res.text();
  console.log(`Response: ${text.slice(0, 400)}`);
}
