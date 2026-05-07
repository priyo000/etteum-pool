import { db } from "../src/db/index";
import { accounts } from "../src/db/schema";
import { eq, and } from "drizzle-orm";

async function reactivateCodeBuddyAccounts() {
  console.log("Reactivating CodeBuddy accounts...");

  const result = await db
    .update(accounts)
    .set({
      status: "active",
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(accounts.provider, "codebuddy"),
        // Reactivate accounts that are in error or exhausted status
      )
    )
    .returning();

  console.log(`✅ Reactivated ${result.length} CodeBuddy account(s):`);
  for (const account of result) {
    console.log(`  - ${account.email} (ID: ${account.id})`);
  }

  process.exit(0);
}

reactivateCodeBuddyAccounts().catch((error) => {
  console.error("❌ Error reactivating accounts:", error);
  process.exit(1);
});
