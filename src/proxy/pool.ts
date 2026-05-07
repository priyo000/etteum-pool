import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import type { Account } from "../db/schema";
import { broadcast } from "../ws/index";
import { config } from "../config";

export type ProviderName = "kiro" | "codebuddy" | "canva";

interface PoolState {
  lastIndex: Map<ProviderName, number>;
}

interface ActiveAccountsCacheEntry {
  accounts: Account[];
  expiresAt: number;
  inFlight?: Promise<Account[]>;
}

class AccountPool {
  private state: PoolState = {
    lastIndex: new Map(),
  };

  private activeAccountsCache = new Map<ProviderName, ActiveAccountsCacheEntry>();

  /**
   * Clear cached active accounts after account mutations or status changes.
   */
  invalidate(provider?: ProviderName): void {
    if (provider) {
      this.activeAccountsCache.delete(provider);
      return;
    }

    this.activeAccountsCache.clear();
  }

  /**
   * Get the next available account for a provider using round-robin.
   * Skips exhausted/error accounts.
   */
  async getNextAccount(provider: ProviderName): Promise<Account | null> {
    const activeAccounts = await this.getActiveAccounts(provider);

    if (activeAccounts.length === 0) {
      return null;
    }

    const lastIdx = this.state.lastIndex.get(provider) || 0;
    const nextIdx = (lastIdx + 1) % activeAccounts.length;
    this.state.lastIndex.set(provider, nextIdx);

    return activeAccounts[nextIdx] || null;
  }

  private async getActiveAccounts(provider: ProviderName): Promise<Account[]> {
    const ttlMs = Math.max(0, config.accountCacheTtlMs);
    if (ttlMs === 0) return this.fetchActiveAccounts(provider);

    const now = Date.now();
    const cached = this.activeAccountsCache.get(provider);
    if (cached && cached.expiresAt > now) return cached.accounts;
    if (cached?.inFlight) return cached.inFlight;

    const fetchTime = now;
    const inFlight = this.fetchActiveAccounts(provider)
      .then((activeAccounts) => {
        this.activeAccountsCache.set(provider, {
          accounts: activeAccounts,
          expiresAt: fetchTime + ttlMs,
        });
        return activeAccounts;
      })
      .catch((error) => {
        this.activeAccountsCache.delete(provider);
        throw error;
      });

    this.activeAccountsCache.set(provider, {
      accounts: cached?.accounts || [],
      expiresAt: 0,
      inFlight,
    });

    return inFlight;
  }

  private async fetchActiveAccounts(provider: ProviderName): Promise<Account[]> {
    return db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.provider, provider), eq(accounts.status, "active"))
      );
  }

  /**
   * Get any available account across all providers that support the model.
   */
  async getAccountForModel(model: string): Promise<{ account: Account; provider: ProviderName } | null> {
    // Determine which provider handles this model
    const provider = this.getProviderForModel(model);
    if (!provider) return null;

    const account = await this.getNextAccount(provider);
    if (!account) return null;

    return { account, provider };
  }

  /**
   * Map model name to provider.
   *
   * Kiro (Standard): auto, claude-haiku-4.5, claude-sonnet-4, claude-sonnet-4.5,
   *                  claude-sonnet-4.5-thinking, deepseek-3.2, glm-5,
   *                  glm-5-thinking, minimax-m2.1, minimax-m2.5, qwen3-coder-next
   *
   * CodeBuddy (MAX): claude-opus-4.6, deepseek-v3-2-volc, enowx-default,
   *                  gemini-*, gpt-5.*, kimi-k2.5
   *
   * Canva: canva-image
   */
  getProviderForModel(model: string): ProviderName | null {
    const m = model.toLowerCase().replace("-thinking", "");

    // === CANVA ===
    if (m.includes("canva")) return "canva";

    // === CODEBUDDY (MAX tier) ===
    if (m === "claude-opus-4.6") return "codebuddy";
    if (m.startsWith("gpt-5")) return "codebuddy";
    if (m.startsWith("gemini-")) return "codebuddy";
    if (m === "deepseek-v3-2-volc") return "codebuddy";
    if (m === "enowx-default") return "codebuddy";
    if (m.startsWith("kimi-")) return "codebuddy";

    // === KIRO (Standard tier) ===
    if (m === "auto") return "kiro";
    if (m === "claude-haiku-4.5") return "kiro";
    if (m === "claude-sonnet-4") return "kiro";
    if (m === "claude-sonnet-4.5") return "kiro";
    if (m === "deepseek-3.2") return "kiro";
    if (m === "glm-5") return "kiro";
    if (m.startsWith("minimax-")) return "kiro";
    if (m.startsWith("qwen")) return "kiro";

    // Fallback: any claude model → kiro (standard)
    if (m.includes("claude") || m.includes("sonnet") || m.includes("haiku")) return "kiro";

    // Default to kiro
    return "kiro";
  }

  /**
   * Mark an account as used (update last_used_at)
   */
  async markUsed(accountId: number): Promise<void> {
    await db
      .update(accounts)
      .set({
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  }

  /**
   * Mark an account as exhausted
   */
  async markExhausted(accountId: number): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "exhausted",
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) {
      this.invalidate(account.provider as ProviderName);
      broadcast({
        type: "account_status",
        data: { id: accountId, status: "exhausted", provider: account.provider },
      });
    }
  }

  /**
   * Mark an account as errored
   */
  async markError(accountId: number, errorMessage: string): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "error",
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "error", error: errorMessage },
    });
  }

  async markTransientFailure(accountId: number, errorMessage: string): Promise<void> {
    const [account] = await db
      .update(accounts)
      .set({
        status: "active",
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId))
      .returning();

    if (account) this.invalidate(account.provider as ProviderName);

    broadcast({
      type: "account_status",
      data: { id: accountId, status: "active", warning: errorMessage },
    });
  }

  /**
   * Update account tokens (stored as jsonb)
   */
  async updateTokens(accountId: number, tokens: unknown): Promise<void> {
    await db
      .update(accounts)
      .set({
        tokens,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, accountId));
  }

  /**
   * Get pool statistics
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    exhausted: number;
    error: number;
    pending: number;
    byProvider: Record<string, { active: number; total: number }>;
  }> {
    const [totals, providerRows] = await Promise.all([
      db
        .select({
          total: sql<number>`count(*)`,
          active: sql<number>`SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)`,
          exhausted: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
          error: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
          pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
        })
        .from(accounts),
      db
        .select({
          provider: accounts.provider,
          total: sql<number>`count(*)`,
          active: sql<number>`SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END)`,
        })
        .from(accounts)
        .groupBy(accounts.provider),
    ]);

    const totalRow = totals[0];
    const byProvider: Record<string, { active: number; total: number }> = {};

    for (const row of providerRows) {
      byProvider[row.provider] = {
        active: row.active || 0,
        total: row.total || 0,
      };
    }

    return {
      total: totalRow?.total || 0,
      active: totalRow?.active || 0,
      exhausted: totalRow?.exhausted || 0,
      error: totalRow?.error || 0,
      pending: totalRow?.pending || 0,
      byProvider,
    };
  }
}

export const pool = new AccountPool();
