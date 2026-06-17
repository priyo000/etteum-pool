import { Hono } from "hono";
import { db } from "../db/index";
import { accounts, requestLogs, vccCards, vccTransactions } from "../db/schema";
import { and, eq, sql } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { NewAccount } from "../db/schema";
import { loginQueue } from "../auth/queue";
import { warmupQueue } from "../auth/warmup-queue";
import { warmupAccount } from "../auth/warmup-runner";
import { pool, type ProviderName } from "../proxy/pool";
import { activateQoderPat } from "../proxy/providers/qoder";
import { byokBatchRouter } from "./byok-batch";

export const accountsRouter = new Hono();

// Mount batch BYOK sub-router (must be before /:id routes)
accountsRouter.route("/byok/batch", byokBatchRouter);

/**
 * GET /api/accounts/warmup-queue - Get warmup progress per provider
 */
accountsRouter.get("/warmup-queue", (c) => {
  return c.json({ data: warmupQueue.getProgressByProvider() });
});

/**
 * GET /api/accounts - List accounts with optional server-side filtering.
 * Query params:
 *   provider - filter by provider (e.g. "kiro", "codebuddy")
 *   status   - filter by status (e.g. "active", "exhausted", "error")
 *   limit    - max rows (default: all; use for pagination)
 *   offset   - skip rows (default: 0)
 *   summary  - if "true", return only counts per provider (fast overview)
 */
accountsRouter.get("/", async (c) => {
  const providerFilter = c.req.query("provider");
  const statusFilter = c.req.query("status");
  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");
  const summaryMode = c.req.query("summary") === "true";

  // Fast summary mode: return counts per provider without loading all rows
  if (summaryMode) {
    const rows = await db
      .select({
        provider: accounts.provider,
        status: accounts.status,
        count: sql<number>`COUNT(*)`,
        totalQuotaRemaining: sql<number>`COALESCE(SUM(${accounts.quotaRemaining}), 0)`,
        totalQuotaLimit: sql<number>`COALESCE(SUM(${accounts.quotaLimit}), 0)`,
      })
      .from(accounts)
      .groupBy(accounts.provider, accounts.status);
    return c.json({ summary: rows });
  }

  // Build WHERE conditions
  const conditions = [];
  if (providerFilter) conditions.push(eq(accounts.provider, providerFilter));
  if (statusFilter) conditions.push(eq(accounts.status, statusFilter));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Query with optional limit/offset
  let query = db.select().from(accounts);
  if (where) query = query.where(where) as any;

  const limit = limitParam ? Math.min(Math.max(1, Number(limitParam) || 500), 2000) : undefined;
  const offset = offsetParam ? Math.max(0, Number(offsetParam) || 0) : 0;

  if (limit) query = (query as any).limit(limit).offset(offset);

  const allAccounts = await query;

  // Don't expose passwords in response (except BYOK where key is shown)
  const sanitized = allAccounts.map((acc) => {
    let apiKeyPreview: string | undefined;
    if (acc.provider === "byok") {
      try { apiKeyPreview = decrypt(acc.password); } catch { /* ignore */ }
    }
    return {
      ...acc,
      password: "***",
      tokens: acc.tokens ? "[set]" : null,
      apiKeyPreview,
    };
  });

  return c.json({ data: sanitized, total: sanitized.length });
});

/**
 * BYOK (Bring Your Own Key) Management Endpoints
 * NOTE: Must be defined BEFORE /:id routes to avoid route collision
 */

/**
 * POST /api/accounts/byok - Create BYOK provider
 */
accountsRouter.post("/byok", async (c) => {
  const body = await c.req.json<{
    label: string;
    base_url: string;
    api_key: string;
    format?: "openai" | "anthropic" | "auto";
    models: string[];
    headers?: Record<string, string>;
  }>();

  if (!body.label || !body.base_url || !body.api_key || !body.models || body.models.length === 0) {
    return c.json({ error: "label, base_url, api_key, and models[] are required" }, 400);
  }

  // Validate label format (lowercase alphanumeric + hyphens)
  if (!/^[a-z0-9-]+$/.test(body.label)) {
    return c.json({ error: "label must be lowercase alphanumeric with hyphens only" }, 400);
  }

  // Check uniqueness
  const existing = await db.select().from(accounts)
    .where(eq(accounts.email, body.label))
    .then((rows) => rows.find((r) => r.provider === "byok"));

  if (existing) {
    return c.json({ error: "BYOK provider with this label already exists" }, 409);
  }

  // Encrypt API key
  const encryptedKey = encrypt(body.api_key);

  // Build tokens JSON
  const tokens = {
    base_url: body.base_url,
    format: body.format || "auto",
    models: body.models,
    model_prefix: body.label,
    headers: body.headers || {},
  };

  try {
    const result = await db.insert(accounts).values({
      provider: "byok",
      email: body.label,
      password: encryptedKey,
      status: "active",
      enabled: true,
      tokens: tokens,
      quotaLimit: -1,
      quotaRemaining: -1,
    }).returning();

    const created = result[0]!;
    pool.invalidate("byok" as ProviderName);

    broadcast({
      type: "byok_created",
      data: { id: created.id, label: body.label },
    });

    // Refresh BYOK model cache
    const { refreshByokModels } = await import("../proxy/providers/registry");
    await refreshByokModels();

    return c.json({
      success: true,
      id: created.id,
      label: body.label,
      models: body.models.map((m) => `${body.label}-${m}`),
    }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

/**
 * GET /api/accounts/byok - List all BYOK providers
 */
accountsRouter.get("/byok", async (c) => {
  const byokAccounts = await db.select().from(accounts)
    .where(eq(accounts.provider, "byok"));

  const providers = byokAccounts.map((acc) => {
    const tokens = typeof acc.tokens === "string"
      ? JSON.parse(acc.tokens)
      : acc.tokens;
    // Decrypt API key for display (local tool)
    let apiKey = ""; try { apiKey = decrypt(acc.password); } catch { /* ignore */ }


    return {
      id: acc.id,
      label: acc.email,
      base_url: tokens?.base_url || "",
      api_key: apiKey,
      format: tokens?.format || "auto",
      models: tokens?.models || [],
      model_prefix: tokens?.model_prefix || acc.email,
      status: acc.status,
      enabled: acc.enabled,
      available_models: (tokens?.models || []).map((m: string) => `${tokens?.model_prefix || acc.email}-${m}`),
    };
  });

  return c.json({ providers, total: providers.length });
});

/**
 * PATCH /api/accounts/byok/:id - Update BYOK provider
 */
accountsRouter.patch("/byok/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    base_url?: string;
    api_key?: string;
    format?: "openai" | "anthropic" | "auto";
    models?: string[];
    headers?: Record<string, string>;
  }>();

  const account = await db.select().from(accounts)
    .where(eq(accounts.id, id))
    .get();

  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  const tokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : account.tokens || {};

  // Update fields
  if (body.base_url) tokens.base_url = body.base_url;
  if (body.format) tokens.format = body.format;
  if (body.models) tokens.models = body.models;
  if (body.headers) tokens.headers = body.headers;

  const updateData: Record<string, unknown> = {
    tokens: tokens,
    updatedAt: new Date(),
  };

  if (body.api_key) {
    updateData.password = encrypt(body.api_key);
  }

  await db.update(accounts)
    .set(updateData)
    .where(eq(accounts.id, id));

  pool.invalidate("byok" as ProviderName);

  broadcast({
    type: "byok_updated",
    data: { id },
  });

  // Refresh BYOK model cache
  const { refreshByokModels } = await import("../proxy/providers/registry");
  await refreshByokModels();

  return c.json({
    success: true,
    id,
    label: account.email,
    models: (tokens.models || []).map((m: string) => `${tokens.model_prefix || account.email}-${m}`),
  });
});

/**
 * DELETE /api/accounts/byok/:id - Delete BYOK provider
 */
accountsRouter.delete("/byok/:id", async (c) => {
  const id = Number(c.req.param("id"));

  // Nullify foreign key references
  await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));

  const result = await db.delete(accounts)
    .where(eq(accounts.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  pool.invalidate("byok" as ProviderName);

  broadcast({
    type: "byok_deleted",
    data: { id },
  });

  // Refresh BYOK model cache
  const { refreshByokModels } = await import("../proxy/providers/registry");
  await refreshByokModels();

  return c.json({ success: true, deleted: id });
});

/**
 * Helper: Auto-fix account if in error state after successful test
 */
async function autoFixAccountIfError(accountId: number, accountStatus: string) {
  if (accountStatus === 'error') {
    await db.update(accounts)
      .set({
        status: 'active',
        errorMessage: null,
        updatedAt: new Date()
      })
      .where(eq(accounts.id, accountId));
    pool.invalidate('byok');
    const { refreshByokModels } = await import("../proxy/providers/registry");
    await refreshByokModels();
    broadcast({
      type: 'account_status',
      data: { id: accountId, status: 'active' }
    });
    return true;
  }
  return false;
}

/**
 * POST /api/accounts/byok/:id/test - Test BYOK connection
 * Accepts optional { model?: string } body to test a specific model.
 * Returns latency_ms and auto_fixed status.
 */
accountsRouter.post("/byok/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  const reqBody = await c.req.json().catch(() => ({})) as { model?: string };

  const account = await db.select().from(accounts)
    .where(eq(accounts.id, id))
    .get();

  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  const tokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : account.tokens;

  if (!tokens?.base_url || !tokens?.models || tokens.models.length === 0) {
    return c.json({ success: false, error: "Invalid BYOK configuration" });
  }

  const apiKey = decrypt(account.password);
  const format = tokens.format || "auto";
  const testModel = reqBody.model || tokens.models[0];

  // Validate model if provided
  if (reqBody.model && !tokens.models.includes(reqBody.model)) {
    return c.json({
      success: false,
      error: `Model "${reqBody.model}" not found in provider configuration`
    }, 400);
  }

  // Determine endpoint based on format
  const isAnthropic = format === "anthropic" ||
    (format === "auto" && (tokens.base_url.includes("anthropic.com") || tokens.base_url.includes("/v1/messages")));

  const url = isAnthropic
    ? `${tokens.base_url}/messages`
    : `${tokens.base_url}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(tokens.headers || {}),
  };

  const body = isAnthropic
    ? {
        model: testModel,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      }
    : {
        model: testModel,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
      };

  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const startTime = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - startTime;

    if (response.status === 401 || response.status === 403) {
      return c.json({ success: false, error: "Authentication failed", latency_ms: latencyMs });
    }

    if (response.status === 429) {
      const autoFixed = await autoFixAccountIfError(id, account.status);
      return c.json({
        success: true,
        warning: "Rate limited but authentication works",
        latency_ms: latencyMs,
        auto_fixed: autoFixed
      });
    }

    if (!response.ok) {
      const text = await response.text();
      return c.json({ success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}`, latency_ms: latencyMs });
    }

    const autoFixed = await autoFixAccountIfError(id, account.status);
    return c.json({
      success: true,
      message: "Connection test passed",
      model: testModel,
      format: isAnthropic ? "anthropic" : "openai",
      latency_ms: latencyMs,
      auto_fixed: autoFixed
    });
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    });
  }
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
    provider: "kiro" | "kiro-pro" | "codebuddy" | "canva" | "codex" | "qoder";
    email?: string;
    password?: string;
    personalToken?: string;
    tokens?: Record<string, unknown>;
    status?: "active" | "pending";
    browserEngine?: string;
    headless?: boolean;
  }>();

  if (!body.provider) {
    return c.json({ error: "provider is required" }, 400);
  }

  if (body.provider === "qoder" && body.personalToken) {
    const trimmed = body.personalToken.trim();
    if (!trimmed) return c.json({ error: "personalToken is empty" }, 400);

    try {
      const { tokens, jobToken } = await activateQoderPat(trimmed);
      const email = jobToken.email || jobToken.name || `qoder-${tokens.userId || Date.now()}@pat`;

      const existing = await db.select().from(accounts)
        .where(eq(accounts.email, email))
        .then((rows) => rows.find((r) => r.provider === "qoder"));

      if (existing) {
        await db.update(accounts).set({
          status: "active",
          tokens: tokens as unknown,
          errorMessage: null,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(accounts.id, existing.id));
        pool.invalidate("qoder");
        broadcast({ type: "account_updated", data: { id: existing.id, provider: "qoder", status: "active" } });
        return c.json({ id: existing.id, provider: "qoder", email, status: "active", updated: true }, 200);
      }

      const inserted = await db.insert(accounts).values({
        provider: "qoder",
        email,
        password: encrypt("pat-login"),
        status: "active",
        tokens: tokens as unknown,
        lastLoginAt: new Date(),
      }).returning();
      const created = inserted[0]!;
      pool.invalidate("qoder");
      broadcast({ type: "account_created", data: { id: created.id, provider: "qoder", email } });
      return c.json({ ...created, password: "***", tokens: "[set]" }, 201);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return c.json({ error: `Qoder PAT activation failed: ${msg}` }, 400);
    }
  }

  if (!body.email || !body.password) {
    return c.json(
      { error: "email and password are required" },
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

    if (!body.tokens) {
      loginQueue.enqueue(created.id, { browserEngine: body.browserEngine, headless: body.headless });
    }

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
      provider: "kiro" | "codebuddy" | "canva" | "codex";
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
 * POST /api/accounts/filter - Filter accounts that don't exist yet
 *
 * Body: { emails: ["email:password", ...] }
 * Returns per-provider breakdown of which accounts are missing.
 */
accountsRouter.post("/filter", async (c) => {
  const body = await c.req.json<{ emails: string[] }>();

  if (!body.emails || !Array.isArray(body.emails)) {
    return c.json({ error: "emails array is required" }, 400);
  }

  // Parse email:password pairs
  const parsed: Array<{ email: string; password: string }> = [];
  for (const line of body.emails) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf(":");
    if (sepIdx === -1) continue;
    const email = trimmed.slice(0, sepIdx).trim().toLowerCase();
    const password = trimmed.slice(sepIdx + 1).trim();
    if (email && password) {
      parsed.push({ email, password });
    }
  }

  if (parsed.length === 0) {
    return c.json({ error: "No valid email:password pairs found" }, 400);
  }

  // Get all existing accounts
  const allAccounts = await db.select({ email: accounts.email, provider: accounts.provider }).from(accounts);

  // Build a set of "provider:email" for fast lookup
  const existingSet = new Set(allAccounts.map((a) => `${a.provider}:${a.email.toLowerCase()}`));

  const allProviders = ["kiro", "kiro-pro", "codebuddy", "canva", "codex", "qoder"];

  // For each provider, find which emails are missing
  const result: Record<string, Array<{ email: string; password: string }>> = {};
  let totalMissing = 0;

  for (const provider of allProviders) {
    const missing: Array<{ email: string; password: string }> = [];
    for (const { email, password } of parsed) {
      if (!existingSet.has(`${provider}:${email}`)) {
        missing.push({ email, password });
      }
    }
    result[provider] = missing;
    totalMissing += missing.length;
  }

  return c.json({
    totalInput: parsed.length,
    totalMissing,
    providers: result,
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
 * POST /api/accounts/toggle-all - Bulk toggle enabled for all accounts of a provider
 * Body: { provider: string, enabled: boolean }
 */
accountsRouter.post("/toggle-all", async (c) => {
  const body = await c.req.json<{ provider: string; enabled: boolean }>();

  if (!body.provider) {
    return c.json({ error: "provider is required" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled (boolean) is required" }, 400);
  }

  const count = await pool.setEnabledByProvider(body.provider as ProviderName, body.enabled);
  return c.json({ provider: body.provider, enabled: body.enabled, count });
});

/**
 * DELETE /api/accounts/provider/:provider - Delete all accounts for a provider
 */
accountsRouter.delete("/provider/:provider", async (c) => {
  const provider = c.req.param("provider") as ProviderName;

  if (!provider) {
    return c.json({ error: "provider is required" }, 400);
  }

  const providerAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.provider, provider));

  const ids = providerAccounts.map((account) => account.id);
  if (ids.length === 0) {
    return c.json({ provider, deleted: 0, success: true });
  }

  for (const id of ids) {
    await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));
    await db.update(vccCards).set({ usedByAccountId: null }).where(eq(vccCards.usedByAccountId, id));
    await db.delete(vccTransactions).where(eq(vccTransactions.accountId, id));
  }

  const deleted = await db
    .delete(accounts)
    .where(eq(accounts.provider, provider))
    .returning({ id: accounts.id });

  pool.invalidate(provider);
  broadcast({ type: "accounts_updated", data: { provider, deleted: deleted.length } });

  return c.json({ provider, deleted: deleted.length, success: true });
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

const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_SCOPE = "openid profile email offline_access";

export function decodeJwtPayload(token: string): Record<string, any> {
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

async function upsertCodexAccount(email: string, tokens: Record<string, unknown>) {
  const existing = await db.select().from(accounts)
    .where(eq(accounts.email, email))
    .then((rows) => rows.find((r) => r.provider === "codex"));

  if (existing) {
    await db.update(accounts).set({
      status: "active",
      tokens: tokens as unknown,
      errorMessage: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(accounts.id, existing.id));
    return existing.id;
  }

  const inserted = await db.insert(accounts).values({
    provider: "codex",
    email,
    password: encrypt("instant-login"),
    status: "active",
    tokens: tokens as unknown,
    lastLoginAt: new Date(),
  }).returning();

  return inserted[0]!.id;
}

export async function importCodexAccessToken(accessToken: string, name?: string) {
  const token = accessToken.trim();
  if (!token) {
    throw new Error("Access token is required");
  }

  const claims = decodeJwtPayload(token);
  const authClaim = claims["https://api.openai.com/auth"];
  const profileClaim = claims["https://api.openai.com/profile"];

  let email = String(profileClaim?.email || claims.email || claims.preferred_username || "");
  let accountId = String(
    authClaim?.chatgpt_account_id || authClaim?.account_id || authClaim?.user_id || claims.chatgpt_account_id || claims.account_id || ""
  );
  const planType = String(authClaim?.chatgpt_plan_type || claims.plan_type || "");
  const jwtExp = claims.exp ? Number(claims.exp) : null;

  if (!email || !accountId) {
    try {
      const usageResp = await fetch(CODEX_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "codex_cli_rs/0.1.0",
        },
      });
      if (usageResp.ok) {
        const usage = await usageResp.json() as any;
        if (!email) email = String(usage.email || "");
        if (!accountId) accountId = String(usage.account_id || usage.chatgpt_account_id || "");
      }
    } catch {}
  }

  if (!email) {
    email = name?.trim() || `codex-${token.slice(-8)}@token.local`;
  }

  const newTokens = {
    access_token: token,
    refresh_token: "",
    id_token: "",
    expires_at: jwtExp ? String(jwtExp) : "",
    email,
    account_id: accountId,
    method: "access_token",
    plan_type: planType,
  };

  const id = await upsertCodexAccount(email, newTokens);
  pool.invalidate("codex" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "codex", count: 1 } });

  return {
    id,
    provider: "codex",
    email,
    name: name?.trim() || email,
    workspace: accountId || null,
    plan: planType || null,
  };
}

export async function exchangeCodexAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: CODEX_CLIENT_ID,
    code_verifier: input.codeVerifier,
  });

  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token exchange failed (${response.status}): ${text.slice(0, 200)}`);
  }

  const data = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("Codex token exchange returned no access_token");
  }

  const claims = data.id_token ? decodeJwtPayload(data.id_token) : {};
  let email = String(claims.email || "");
  let accountId = "";
  const authClaim = claims["https://api.openai.com/auth"];
  const profileClaim = claims["https://api.openai.com/profile"];
  const planType = String(authClaim?.chatgpt_plan_type || claims.plan_type || "");

  if (profileClaim && typeof profileClaim === "object") {
    email = String(profileClaim.email || email || "");
  }

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
          Authorization: `Bearer ${data.access_token}`,
          "User-Agent": "codex_cli_rs/0.1.0",
        },
      });
      if (usageResp.ok) {
        const usage = await usageResp.json() as any;
        if (!email) email = String(usage.email || "");
        if (!accountId) accountId = String(usage.account_id || usage.chatgpt_account_id || "");
      }
    } catch {}
  }

  if (!email) {
    email = `codex-${input.code.slice(-8)}@oauth.local`;
  }

  const expiresIn = Number(data.expires_in) || 3600;
  const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);
  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || "",
    id_token: data.id_token || "",
    expires_at: expiresAt,
    email,
    account_id: accountId,
    method: "authorization_code",
    plan_type: planType,
  };

  const id = await upsertCodexAccount(email, newTokens);
  pool.invalidate("codex" as ProviderName);
  broadcast({ type: "accounts_updated", data: { provider: "codex", count: 1 } });

  return {
    id,
    provider: "codex",
    email,
    name: email,
    workspace: accountId || null,
    plan: planType || null,
  };
}

export async function exchangeCodexRefreshTokens(tokens: string[]) {
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
        scope: CODEX_SCOPE,
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

      await upsertCodexAccount(email, newTokens);
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

  return { success, failed, errors: errors.length > 0 ? errors : undefined };
}

async function handleCodexInstantLogin(c: any, tokens: string[]) {
  const result = await exchangeCodexRefreshTokens(tokens);
  return c.json(result);
}

/**
 * BYOK (Bring Your Own Key) Management Endpoints
 */

/**
 * POST /api/accounts/byok - Create BYOK provider
 */
accountsRouter.post("/byok", async (c) => {
  const body = await c.req.json<{
    label: string;
    base_url: string;
    api_key: string;
    format?: "openai" | "anthropic" | "auto";
    models: string[];
    headers?: Record<string, string>;
  }>();

  if (!body.label || !body.base_url || !body.api_key || !body.models || body.models.length === 0) {
    return c.json({ error: "label, base_url, api_key, and models[] are required" }, 400);
  }

  // Validate label format (lowercase alphanumeric + hyphens)
  if (!/^[a-z0-9-]+$/.test(body.label)) {
    return c.json({ error: "label must be lowercase alphanumeric with hyphens only" }, 400);
  }

  // Check uniqueness
  const existing = await db.select().from(accounts)
    .where(eq(accounts.email, body.label))
    .then((rows) => rows.find((r) => r.provider === "byok"));

  if (existing) {
    return c.json({ error: "BYOK provider with this label already exists" }, 409);
  }

  // Encrypt API key
  const encryptedKey = encrypt(body.api_key);

  // Build tokens JSON
  const tokens = {
    base_url: body.base_url,
    format: body.format || "auto",
    models: body.models,
    model_prefix: body.label,
    headers: body.headers || {},
  };

  try {
    const result = await db.insert(accounts).values({
      provider: "byok",
      email: body.label,
      password: encryptedKey,
      status: "active",
      enabled: true,
      tokens: tokens,
      quotaLimit: -1,
      quotaRemaining: -1,
    }).returning();

    const created = result[0]!;
    pool.invalidate("byok" as ProviderName);

    broadcast({
      type: "byok_created",
      data: { id: created.id, label: body.label },
    });

    // Refresh BYOK model cache
    const { refreshByokModels } = await import("../proxy/providers/registry");
    await refreshByokModels();

    return c.json({
      success: true,
      id: created.id,
      label: body.label,
      models: body.models.map((m) => `${body.label}-${m}`),
    }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

/**
 * GET /api/accounts/byok - List all BYOK providers
 */
accountsRouter.get("/byok", async (c) => {
  const byokAccounts = await db.select().from(accounts)
    .where(eq(accounts.provider, "byok"));

  const providers = byokAccounts.map((acc) => {
    const tokens = typeof acc.tokens === "string"
      ? JSON.parse(acc.tokens)
      : acc.tokens;

    return {
      id: acc.id,
      label: acc.email,
      base_url: tokens?.base_url || "",
      format: tokens?.format || "auto",
      models: tokens?.models || [],
      model_prefix: tokens?.model_prefix || acc.email,
      status: acc.status,
      enabled: acc.enabled,
      available_models: (tokens?.models || []).map((m: string) => `${tokens?.model_prefix || acc.email}-${m}`),
    };
  });

  return c.json({ providers, total: providers.length });
});

/**
 * PATCH /api/accounts/byok/:id - Update BYOK provider
 */
accountsRouter.patch("/byok/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    base_url?: string;
    api_key?: string;
    format?: "openai" | "anthropic" | "auto";
    models?: string[];
    headers?: Record<string, string>;
  }>();

  const account = await db.select().from(accounts)
    .where(eq(accounts.id, id))
    .get();

  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  const tokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : account.tokens || {};

  // Update fields
  if (body.base_url) tokens.base_url = body.base_url;
  if (body.format) tokens.format = body.format;
  if (body.models) tokens.models = body.models;
  if (body.headers) tokens.headers = body.headers;

  const updateData: Record<string, unknown> = {
    tokens: tokens,
    updatedAt: new Date(),
  };

  if (body.api_key) {
    updateData.password = encrypt(body.api_key);
  }

  await db.update(accounts)
    .set(updateData)
    .where(eq(accounts.id, id));

  pool.invalidate("byok" as ProviderName);

  broadcast({
    type: "byok_updated",
    data: { id },
  });

  // Refresh BYOK model cache
  const { refreshByokModels } = await import("../proxy/providers/registry");
  await refreshByokModels();

  return c.json({
    success: true,
    id,
    label: account.email,
    models: (tokens.models || []).map((m: string) => `${tokens.model_prefix || account.email}-${m}`),
  });
});

/**
 * DELETE /api/accounts/byok/:id - Delete BYOK provider
 */
accountsRouter.delete("/byok/:id", async (c) => {
  const id = Number(c.req.param("id"));

  // Nullify foreign key references
  await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, id));

  const result = await db.delete(accounts)
    .where(eq(accounts.id, id))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  pool.invalidate("byok" as ProviderName);

  broadcast({
    type: "byok_deleted",
    data: { id },
  });

  // Refresh BYOK model cache
  const { refreshByokModels } = await import("../proxy/providers/registry");
  await refreshByokModels();

  return c.json({ success: true, deleted: id });
});

/**
 * POST /api/accounts/:id/open-panel - Open web panel in browser with auto-login
 * Supports: kiro, kiro-pro, qoder
 */
accountsRouter.post("/:id/open-panel", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, id));

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  const tokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : account.tokens;

  if (!tokens) {
    return c.json({ error: "No tokens available" }, 400);
  }

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();

    if (account.provider.startsWith("kiro")) {
      if (!tokens.refresh_token) {
        await browser.close();
        return c.json({ error: "No refresh token available" }, 400);
      }

      // Refresh to get fresh access token
      const refreshResp = await fetch("https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refresh_token }),
      });

      if (!refreshResp.ok) {
        await browser.close();
        return c.json({ error: `Token refresh failed: ${refreshResp.status}` }, 500);
      }

      const refreshData = (await refreshResp.json()) as {
        accessToken?: string;
        refreshToken?: string;
        profileArn?: string;
      };

      const accessToken = refreshData.accessToken;
      const refreshToken = refreshData.refreshToken || tokens.refresh_token;
      const profileArn = tokens.profile_arn || tokens.profileArn || refreshData.profileArn || "";

      // Extract userId from getUsageLimits response (cached in metadata or from profileArn)
      const meta = (account.metadata || {}) as Record<string, unknown>;
      let userId = (meta.kiroUserId as string) || "";
      if (!userId) {
        // Try to fetch userId from getUsageLimits
        try {
          const url = new URL("https://q.us-east-1.amazonaws.com/getUsageLimits");
          url.searchParams.set("origin", "AI_EDITOR");
          url.searchParams.set("resourceType", "AGENTIC_REQUEST");
          url.searchParams.set("profileArn", profileArn);
          const usageResp = await fetch(url.toString(), {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": "KiroIDE/compatible pool-proxy/1.0.0",
            },
          });
          if (usageResp.ok) {
            const usageData = (await usageResp.json()) as { userInfo?: { userId?: string } };
            userId = usageData.userInfo?.userId || "";
          }
        } catch { /* ignore */ }
      }

      await context.addCookies([
        { name: "AccessToken", value: accessToken || "", domain: "app.kiro.dev", path: "/" },
        { name: "RefreshToken", value: refreshToken, domain: "app.kiro.dev", path: "/" },
        { name: "UserId", value: userId, domain: "app.kiro.dev", path: "/" },
        { name: "Idp", value: "Google", domain: "app.kiro.dev", path: "/" },
      ]);

      const page = await context.newPage();
      await page.goto("https://app.kiro.dev/settings/account");

      return c.json({ success: true, message: `Browser opened for ${account.email}` });
    } else if (account.provider === "qoder") {
      // Qoder: inject stored web cookies
      const webCookie = tokens.web_cookie as string | undefined;
      if (!webCookie) {
        await browser.close();
        return c.json({ error: "No web_cookie available for Qoder account" }, 400);
      }

      // Parse cookie string into array
      const cookies = webCookie.split("; ").map((pair) => {
        const idx = pair.indexOf("=");
        if (idx === -1) return null;
        const name = pair.slice(0, idx);
        const value = pair.slice(idx + 1);
        return { name, value };
      }).filter((c): c is { name: string; value: string } => c !== null);

      // Filter to qoder.com-relevant cookies and add domain
      const qoderCookies = cookies
        .filter((c) => {
          // Include qoder-specific cookies
          if (c.name.startsWith("qoder_") || c.name === "tfstk" || c.name === "cbc" || c.name === "test_cookie") {
            return true;
          }
          // Include tracking cookies
          if (c.name.startsWith("_ga") || c.name.startsWith("_gcl") || c.name.startsWith("_nb")) {
            return true;
          }
          // Include other misc cookies
          if (c.name === "OTZ" || c.name.startsWith("_c_")) {
            return true;
          }
          return false;
        })
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: "qoder.com",
          path: "/",
        }));

      if (qoderCookies.length === 0) {
        await browser.close();
        return c.json({ error: "No valid Qoder cookies found in web_cookie" }, 400);
      }

      await context.addCookies(qoderCookies);

      const page = await context.newPage();
      await page.goto("https://qoder.com/account/profile");

      return c.json({
        success: true,
        message: `Browser opened for ${account.email}`,
        cookiesInjected: qoderCookies.length,
      });
    } else {
      await browser.close();
      return c.json({
        error: `Open panel not supported for provider: ${account.provider}`,
      }, 400);
    }
  } catch (error) {
    return c.json({
      error: `Failed to open browser: ${error instanceof Error ? error.message : String(error)}`,
    }, 500);
  }
});
