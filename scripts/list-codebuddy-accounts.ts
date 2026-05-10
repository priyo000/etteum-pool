#!/usr/bin/env bun
import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";

const codebuddyAccounts = await db
  .select()
  .from(accounts)
  .where(eq(accounts.provider, "codebuddy"))
  .orderBy(accounts.quotaRemaining);

console.log(`Found ${codebuddyAccounts.length} CodeBuddy accounts:\n`);

for (const acc of codebuddyAccounts) {
  console.log(`ID: ${acc.id}`);
  console.log(`Email: ${acc.email}`);
  console.log(`Status: ${acc.status}`);
  console.log(`Quota: ${acc.quotaRemaining}/${acc.quotaLimit}`);
  console.log(`Last used: ${acc.lastUsedAt || "never"}`);
  console.log("---");
}
