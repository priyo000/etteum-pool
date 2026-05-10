#!/usr/bin/env bun
import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq, desc } from "drizzle-orm";

const rows = await db.select({
  id: accounts.id,
  email: accounts.email,
  status: accounts.status,
  quotaRemaining: accounts.quotaRemaining,
  updatedAt: accounts.updatedAt,
  tokens: accounts.tokens,
}).from(accounts)
  .where(eq(accounts.provider, "codebuddy"))
  .orderBy(desc(accounts.updatedAt))
  .limit(10);

for (const r of rows) {
  const t = typeof r.tokens === "string" ? JSON.parse(r.tokens) : r.tokens;
  const keys = Object.keys(t || {});
  const apiKey = t?.api_key || t?.access_token || t?.session_token;
  console.log(`${r.email} | ${r.status} | quota:${r.quotaRemaining} | updated:${r.updatedAt} | keys:[${keys.join(",")}] | hasKey:${!!apiKey}`);
}
