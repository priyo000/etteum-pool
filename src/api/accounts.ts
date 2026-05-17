import { Hono } from "hono";
import { db } from "../db/index";
import { accounts, requestLogs, vccCards, vccTransactions } from "../db/schema";
import { eq } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { NewAccount } from "../db/schema";
import { loginQueue } from "../auth/queue";
import { warmupQueue } from "../auth/warmup-queue";
import { warmupAccount } from "../auth/warmup-runner";
import { pool, type ProviderName } from "../proxy/pool";

export const accountsRouter = new Hono();

/**
 * GET /api/accounts - List all accounts
 */
accountsRouter.get("/", async (c) => {
  const allAccounts = await db.select().from(accounts);

  // Don't expose passwords in response
  const sanitized = allAccounts.map((acc) => ({
    ...acc,
    password: "***",
    tokens: acc.tokens ? "[set]" : null,
  }));

  return c.json({ data: sanitized, total: sanitized.length });
});

/**
 * GET /api/accounts/:id - Get single account
 */
accountsRouter.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id));

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  return c.json({
    ...account,
    password: "***",
    tokens: account.tokens ? "[set]" : null,
  });
});

/**
 * POST /api/accounts - Create new account
 */
accountsRouter.post("/", async (c) => {
  const body = await c.req.json<{
    provider: "kiro" | "kiro-pro" | "codebuddy" | "canva" | "zai" | "moclaw" | "codex";
    email: string;
    password: string;
    tokens?: Record<string, unknown>;
    status?: "active" | "pending";
    browserEngine?: string;
    headless?: boolean;
  }>();

  if (!body.provider || !body.email || !body.password) {
    return c.json(
      { error: "provider, email, and password are required" },
      400
    );
  }

  const encryptedPassword = encrypt(body.password);

  const newAccount: NewAccount = {
    provider: body.provider,
    email: body.email,
    password: encryptedPassword,
    status: body.tokens ? "active" : (body.status || "pending"),
    tokens: body.tokens || null,
  };

  try {
    const result = await db.insert(accounts).values(newAccount).returning();
    const created = result[0]!;
    pool.invalidate(created.provider as ProviderName);

    broadcast({
      type: "account_created",
      data: { id: created.id, provider: created.provider, email: created.email },
    });

    // Immediately queue bot login after adding account from dashboard/API.
    loginQueue.enqueue(created.id, { browserEngine: body.browserEngine, headless: body.headless });

    return c.json(
      { ...created, password: "***", tokens: created.tokens ? "[set]" : null, loginQueued: true },
      201
    );
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("unique") || error.message.includes("duplicate"))
    ) {
      return c.json({ error: "Account with this email already exists for this provider" }, 409);
    }
    throw error;
  }
});

/**
 * POST /api/accounts/instant-login - Instant login via refresh token (bulk)
 * No browser needed — just exchange refresh token for access token
 * Body: { tokens: ["refreshToken1", ...], provider?: "kiro-pro" | "codex" }
 *
 * - kiro-pro (default): tokens are Kiro AWS Identity refresh tokens
 * - codex: tokens are OpenAI OAuth refresh tokens (start with rt_*, ~200 chars)
 */
accountsRouter.post("/instant-login", async (c) => {
  const body = await c.req.json<{ tokens: string[]; provider?: "kiro-pro" | "codex" }>();
  const provider = body.provider || "kiro-pro";

  if (!body.tokens || !Array.isArray(body.tokens) || body.tokens.length === 0) {
    return c.json({ error: "tokens array is required (array of refresh token strings)" }, 400);
  }

  if (provider === "codex") {
    return await handleCodexInstantLogin(c, body.tokens);
  }

  const REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
  const KIRO_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK";
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const refreshToken of body.tokens) {
    const trimmed = refreshToken.trim();
    if (!trimmed) { failed++; continue; }

    try {
      const response = await fetch(REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: trimmed }),
      });

      if (!response.ok) {
        errors.push(`token ...${trimmed.slice(-8)}: refresh failed (${response.status})`);
        failed++;
        continue;
      }

      const data = await response.json() as {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: string;
      };

      if (!data.accessToken) {
        errors.push(`token ...${trimmed.slice(-8)}: no access token received`);
        failed++;
        continue;
      }

      // Generate email identifier from token (Kiro tokens are not JWT, can't extract email)
      // Use a hash of the refresh token as unique identifier
      const tokenHash = trimmed.slice(10, 18);
      let email = `kiro-${tokenHash}@token.local`;

      const tokens = {
        access_token: data.accessToken,
        refresh_token: data.refreshToken || trimmed,
        expires_at: data.expiresAt || null,
        profile_arn: KIRO_PROFILE_ARN,
      };

      // Create or update account as active with tokens
      const existing = await db.select().from(accounts)
        .where(eq(accounts.email, email))
        .then((rows) => rows.find((r) => r.provider === "kiro-pro"));

      if (existing) {
        await db.update(accounts).set({
          status: "active",
          tokens: tokens as unknown,
          errorMessage: null,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(accounts.id, existing.id));
      } else {
        await db.insert(accounts).values({
          provider: "kiro-pro",
          email,
          password: encrypt("instant-login"),
          status: "active",
          tokens: tokens as unknown,
          lastLoginAt: new Date(),
        });
      }
      success++;
    } catch (err) {
      errors.push(`token ...${trimmed.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  pool.invalidate("kiro-pro" as ProviderName);
  if (success > 0) {
    broadcast({ type: "accounts_updated", data: { provider: "kiro-pro", count: success } });
  }

  return c.json({ success, failed, errors: errors.length > 0 ? errors : undefined });
});

/**
 * POST /api/accounts/bulk - Create multiple accounts
 */
accountsRouter.post("/bulk", async (c) => {
  const body = await c.req.json<{
    accounts: Array<{
      provider: "kiro" | "codebuddy" | "canva" | "zai" | "moclaw" | "codex";
      email: string;
      password: string;
    }>;
  }>();

  if (!body.accounts || !Array.isArray(body.accounts)) {
    return c.json({ error: "accounts array is required" }, 400);
  }

  const results: Array<{ email: string; success: boolean; error?: string }> = [];

  for (const acc of body.accounts) {
    try {
      await db.insert(accounts).values({
        provider: acc.provider,
        email: acc.email,
        password: encrypt(acc.password),
        status: "pending",
      });
      results.push({ email: acc.email, success: true });
    } catch (error) {
      results.push({
        email: acc.email,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  pool.invalidate();
  broadcast({ type: "accounts_bulk_created", data: { count: results.filter((r) => r.success).length } });

  return c.json({
    total: body.accounts.length,
    success: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  });
});

/**
 * PATCH /api/accounts/:id - Update account
 */
accountsRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Partial<{
    status: "active" | "exhausted" | "error" | "pending";
    enabled: boolean;
    tokens: Record<string, unknown>;
    password: string;
    quotaLimit: number;
    quotaRemaining: number;
    quotaResetAt: string;
    errorMessage: string | null;
  }>>();

  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (body.status) updateData.status = body.status;
  if (typeof body.enabled === "boolean") updateData.enabled = body.enabled;
  if (body.tokens) updateData.tokens = body.tokens;
  if (body.password) updateData.password = encrypt(body.password);
  if (body.quotaLimit !== undefined) updateData.quotaLimit = body.quotaLimit;
  if (body.quotaRemaining !== undefined) updateData.quotaRemaining = body.quotaRemaining;
  if (body.quotaResetAt) updateData.quotaResetAt = new Date(body.quotaResetAt);
  if (body.errorMessage !== undefined) updateData.errorMessage = body.errorMessage;

  const result = await db
    .update(accounts)
    .set(updateData)
    .where(eq(accounts.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Account not found" }, 404);
  }

  const updated = result[0]!;
  pool.invalidate(updated.provider as ProviderName);
  broadcast({
    type: "account_updated",
    data: { id: updated.id, status: updated.status, enabled: updated.enabled, provider: updated.provider },
  });

  return c.json({ ...updated, password: "***", tokens: updated.tokens ? "[set]" : null });
});

/**
 * POST /api/accounts/:id/toggle - Toggle account enabled flag
 */
accountsRouter.post("/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }));

  const [current] = await db
    .select({ enabled: accounts.enabled })
    .from(accounts)
    .where(eq(accounts.id, id));

  if (!current) {
    return c.json({ error: "Account not found" }, 404);
  }

  const next = typeof body.enabled === "boolean" ? body.enabled : !current.enabled;
  const updated = await pool.setEnabled(id, next);

  if (!updated) {
    return c.json({ error: "Account not found" }, 404);
  }

  return c.json({
    id: updated.id,
    enabled: updated.enabled,
    status: updated.status,
    provider: updated.provider,
  });
});

/**
 * DELETE /api/accounts/:id - Delete account
 */
accountsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));

  // Nullify foreign key references before deleting
  await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));
  await db.update(vccCards).set({ usedByAccountId: null }).where(eq(vccCards.usedByAccountId, id));
  await db.delete(vccTransactions).where(eq(vccTransactions.accountId, id));

  const result = await db
    .delete(accounts)
    .where(eq(accounts.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Account not found" }, 404);
  }

  const deleted = result[0]!;
  pool.invalidate(deleted.provider as ProviderName);
  broadcast({ type: "account_deleted", data: { id } });

  return c.json({ success: true, deleted: id });
});

/**
 * POST /api/accounts/:id/login - Trigger login for account
 */
accountsRouter.post("/:id/login", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id));

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  // Import auth runner dynamically to avoid circular deps
  const { loginAccount } = await import("../auth/runner");
  const result = await loginAccount(account);

  return c.json(result);
});

/**
 * POST /api/accounts/:id/refresh-quota - Refresh quota for account
 */
accountsRouter.post("/:id/refresh-quota", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id));

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  const result = await warmupAccount(account);
  if (!result.success && !result.retryable && result.kind !== "unsupported") {
    return c.json(result, 500);
  }

  return c.json(result);
});

/**
 * POST /api/accounts/:id/warmup - Queue non-login WarmUp for account
 */
accountsRouter.post("/:id/warmup", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id));

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  warmupQueue.enqueue(id);
  return c.json({ message: "WarmUp queued", accountId: id });
});

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function decodeJwtPayload(token: string): Record<string, any> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const padded = parts[1]! + "=".repeat((4 - parts[1]!.length % 4) % 4);
    const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return {};
  }
}

async function handleCodexInstantLogin(c: any, tokens: string[]) {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const refreshToken of tokens) {
    const trimmed = refreshToken.trim();
    if (!trimmed) { failed++; continue; }

    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: trimmed,
        client_id: CODEX_CLIENT_ID,
        scope: "openid profile email offline_access",
      });

      const response = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        errors.push(`token ...${trimmed.slice(-8)}: refresh failed (${response.status}): ${text.slice(0, 100)}`);
        failed++;
        continue;
      }

      const data = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        expires_in?: number;
      };

      if (!data.access_token) {
        errors.push(`token ...${trimmed.slice(-8)}: no access_token in response`);
        failed++;
        continue;
      }

      const claims = data.id_token ? decodeJwtPayload(data.id_token) : {};
      let email = String(claims.email || "");
      let accountId = "";
      const authClaim = claims["https://api.openai.com/auth"];
      if (authClaim && typeof authClaim === "object") {
        accountId = String(
          authClaim.chatgpt_account_id || authClaim.account_id || authClaim.user_id || ""
        );
      }
      if (!accountId) {
        accountId = String(claims.chatgpt_account_id || claims.account_id || "");
      }

      if (!email || !accountId) {
        try {
          const usageResp = await fetch(CODEX_USAGE_URL, {
            headers: {
              "Authorization": `Bearer ${data.access_token}`,
              "User-Agent": "codex_cli_rs/0.1.0",
            },
          });
          if (usageResp.ok) {
            const usage = await usageResp.json() as any;
            if (!email) email = usage.email || "";
            if (!accountId) {
              accountId = String(usage.account_id || usage.chatgpt_account_id || "");
            }
          }
        } catch {}
      }

      if (!email) email = `codex-${trimmed.slice(-8)}@token.local`;

      const expiresIn = Number(data.expires_in) || 3600;
      const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);

      const newTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || trimmed,
        id_token: data.id_token || "",
        expires_at: expiresAt,
        email,
        account_id: accountId,
        method: "refresh_token",
      };

      const existing = await db.select().from(accounts)
        .where(eq(accounts.email, email))
        .then((rows) => rows.find((r) => r.provider === "codex"));

      if (existing) {
        await db.update(accounts).set({
          status: "active",
          tokens: newTokens as unknown,
          errorMessage: null,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(accounts.id, existing.id));
      } else {
        await db.insert(accounts).values({
          provider: "codex",
          email,
          password: encrypt("instant-login"),
          status: "active",
          tokens: newTokens as unknown,
          lastLoginAt: new Date(),
        });
      }
      success++;
    } catch (err) {
      errors.push(`token ...${trimmed.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  pool.invalidate("codex" as ProviderName);
  if (success > 0) {
    broadcast({ type: "accounts_updated", data: { provider: "codex", count: success } });
  }

  return c.json({ success, failed, errors: errors.length > 0 ? errors : undefined });
}
