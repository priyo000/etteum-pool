import { Hono } from "hono";
import { db } from "../db/index";
import { accounts } from "../db/schema";
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
    provider: "kiro" | "kiro-pro" | "codebuddy" | "canva" | "zai" | "moclaw";
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
 * POST /api/accounts/instant-login - Kiro Pro instant login via refresh token (bulk)
 * No browser needed — just exchange refresh token for access token
 * Body: { tokens: ["refreshToken1", "refreshToken2", ...] }
 */
accountsRouter.post("/instant-login", async (c) => {
  const body = await c.req.json<{ tokens: string[] }>();

  if (!body.tokens || !Array.isArray(body.tokens) || body.tokens.length === 0) {
    return c.json({ error: "tokens array is required (array of refresh token strings)" }, 400);
  }

  const REFRESH_URL = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
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

      // Extract email from JWT payload (access token is a JWT)
      let email = `kiro-pro-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@instant`;
      try {
        const parts = data.accessToken!.split(".");
        if (parts[1]) {
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
          if (payload.email) email = payload.email;
          else if (payload.sub) email = payload.sub;
        }
      } catch {}

      const tokens = {
        access_token: data.accessToken,
        refresh_token: data.refreshToken || trimmed,
        expires_at: data.expiresAt || null,
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
      provider: "kiro" | "codebuddy" | "canva" | "zai" | "moclaw";
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
    data: { id: updated.id, status: updated.status, provider: updated.provider },
  });

  return c.json({ ...updated, password: "***", tokens: updated.tokens ? "[set]" : null });
});

/**
 * DELETE /api/accounts/:id - Delete account
 */
accountsRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));

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
