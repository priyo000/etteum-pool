import { Hono } from "hono";
import { db } from "../db/index";
import { accounts, requestLogs, vccCards, vccTransactions } from "../db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { NewAccount } from "../db/schema";
import { loginQueue } from "../auth/queue";
import { warmupQueue } from "../auth/warmup-queue";
import { warmupAccount } from "../auth/warmup-runner";
import { pool, type ProviderName } from "../proxy/pool";
import { activateQoderPat } from "../proxy/providers/qoder";

export const accountsRouter = new Hono();

/**
 * GET /api/accounts/warmup-queue - Get warmup progress per provider
 */
accountsRouter.get("/warmup-queue", (c) => {
  return c.json({ data: warmupQueue.getProgressByProvider() });
});

/**
 * GET /api/accounts/models/health - Global health summary across all providers
 * NOTE: Must be defined BEFORE /:id routes to avoid route collision
 */
accountsRouter.get("/models/health", async (c) => {
  try {
    const providerRows = await db
      .select({
        provider: accounts.provider,
        total: sql<number>`count(*)`,
        active: sql<number>`SUM(CASE WHEN status = 'active' AND enabled = 1 THEN 1 ELSE 0 END)`,
        error: sql<number>`SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)`,
        exhausted: sql<number>`SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END)`,
        pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
        disabled: sql<number>`SUM(CASE WHEN enabled = 0 THEN 1 ELSE 0 END)`,
      })
      .from(accounts)
      .groupBy(accounts.provider);

    const providers: Record<string, { active: number; total: number; error: number; exhausted: number; pending: number; disabled: number }> = {};
    let totalActive = 0;
    let totalAccounts = 0;
    let providersWithAccounts = 0;
    let providersWithActive = 0;

    for (const row of providerRows) {
      const active = row.active || 0;
      const total = row.total || 0;
      providers[row.provider] = {
        active,
        total,
        error: row.error || 0,
        exhausted: row.exhausted || 0,
        pending: row.pending || 0,
        disabled: row.disabled || 0,
      };
      totalActive += active;
      totalAccounts += total;
      if (total > 0) {
        providersWithAccounts++;
        if (active >= 1) providersWithActive++;
      }
    }

    let overall: "ok" | "degraded" | "down";
    if (providersWithAccounts === 0 || totalActive === 0) {
      overall = "down";
    } else if (providersWithActive < providersWithAccounts) {
      overall = "degraded";
    } else {
      overall = "ok";
    }

    return c.json({ overall, providers, total_active: totalActive, total_accounts: totalAccounts });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

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
 * POST /api/accounts/:id/test - Test any non-BYOK account
 * Returns { success, latency_ms, diagnosis, model?, error? }
 * NOTE: Must be defined BEFORE /:id routes to avoid route collision
 */
accountsRouter.post("/:id/test", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "invalid id" }, 400);
  }

  const account = await db.select().from(accounts)
    .where(eq(accounts.id, id))
    .get();

  if (!account) {
    return c.json({ error: "Account not found" }, 404);
  }

  if (account.provider === "byok") {
    return c.json({ error: "Use POST /api/accounts/byok/:id/test for BYOK providers" }, 400);
  }

  const tokens = typeof account.tokens === "string"
    ? JSON.parse(account.tokens) as Record<string, unknown>
    : account.tokens as Record<string, unknown> | null;

  // Build provider-specific test request
  type Diagnosis = "AUTH" | "429" | "5XX" | "NET" | "RUNTIME" | null;

  let url: string;
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  let bodyPayload: Record<string, unknown>;
  let testModel: string;

  try {
    switch (account.provider) {
      case "kiro":
      case "kiro-pro": {
        // Kiro/Kiro-Pro: AWS CodeWhisperer endpoint, requires specific AWS headers
        const accessToken = String(tokens?.access_token || "");
        if (!accessToken) {
          return c.json({ success: false, diagnosis: "AUTH" as Diagnosis, error: "No access_token in account", latency_ms: 0 });
        }
        testModel = account.provider === "kiro-pro" ? "kp-haiku-4.5" : "claude-haiku-4.5";
        url = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
        headers = {
          "Content-Type": "application/x-amz-json-1.0",
          "Accept": "application/vnd.amazon.eventstream, application/json, */*",
          "Authorization": `Bearer ${accessToken}`,
          "X-Amz-Target": "AmazonCodeWhisperStreamingService.GenerateAssistantResponse",
          "x-amzn-codewhisper-optout": "true",
          "x-amzn-kiro-agent-mode": "vibe",
          "User-Agent": "KiroIDE/compatible pool-proxy/1.0.0",
          "x-amz-user-agent": "pool-proxy/1.0.0",
        };
        // Use a simple non-streaming payload for health check
        bodyPayload = {
          conversationState: {
            chatTriggerType: "MANUAL",
            currentMessage: { userInputMessage: { content: "Hi", userInputMessageContext: {} } },
            history: [],
          },
        };
        break;
      }
      case "codebuddy": {
        // CodeBuddy: api_key/access_token/session_token as Bearer + optional Cookie + CSRF + browser headers
        const apiKey = String(tokens?.api_key || tokens?.access_token || tokens?.session_token || "");
        const webCookie = String(tokens?.web_cookie || tokens?.cookies || "");
        if (!apiKey && !webCookie) {
          return c.json({ success: false, diagnosis: "AUTH" as Diagnosis, error: "No api_key or cookies in account", latency_ms: 0 });
        }
        testModel = "cb-haiku-4.5";
        url = "https://www.codebuddy.ai/api/chat/completions";
        headers = {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-Conversation-ID": crypto.randomUUID(),
          "X-Conversation-Request-ID": crypto.randomUUID().replace(/-/g, ""),
          "X-Conversation-Message-ID": crypto.randomUUID().replace(/-/g, ""),
          "X-Request-ID": crypto.randomUUID().replace(/-/g, ""),
          "X-Domain": "www.codebuddy.ai",
          "X-Product": "SaaS",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
          headers["X-Api-Key"] = apiKey;
        }
        if (webCookie) headers["Cookie"] = webCookie;
        if (tokens?.csrf_token) headers["X-CSRF-Token"] = String(tokens.csrf_token);
        bodyPayload = { model: "claude-haiku-4.5", messages: [{ role: "user", content: "Hi" }], max_tokens: 1 };
        break;
      }
      case "canva": {
        const accessToken = String(tokens?.access_token || "");
        if (!accessToken) {
          return c.json({ success: false, diagnosis: "AUTH" as Diagnosis, error: "No access_token in account", latency_ms: 0 });
        }
        testModel = "canva-claude-haiku-4.5";
        url = "https://api.canva.com/rest/v1/ai/chat/completions";
        headers["Authorization"] = `Bearer ${accessToken}`;
        bodyPayload = { model: testModel, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 };
        break;
      }
      case "codex": {
        const accessToken = String(tokens?.access_token || "");
        if (!accessToken) {
          return c.json({ success: false, diagnosis: "AUTH" as Diagnosis, error: "No access_token in account", latency_ms: 0 });
        }
        testModel = "gpt-4.1-mini";
        url = "https://api.openai.com/v1/chat/completions";
        headers["Authorization"] = `Bearer ${accessToken}`;
        bodyPayload = { model: testModel, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 };
        break;
      }
      case "qoder": {
        const cookiesRaw = String(tokens?.cookies || tokens?.web_cookie || "");
        if (!cookiesRaw) {
          return c.json({ success: false, diagnosis: "AUTH" as Diagnosis, error: "No cookies in account", latency_ms: 0 });
        }
        testModel = "qoder-claude-haiku";
        url = "https://api.qoder.com/v1/chat/completions";
        headers["Cookie"] = cookiesRaw;
        bodyPayload = { model: testModel, messages: [{ role: "user", content: "Hi" }], max_tokens: 1 };
        break;
      }
      default: {
        return c.json({ error: `Unsupported provider for test: ${account.provider}` }, 400);
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const startTime = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const latencyMs = Date.now() - startTime;

    let diagnosis: Diagnosis = null;
    if (response.status === 401 || response.status === 403) {
      diagnosis = "AUTH";
    } else if (response.status === 429) {
      diagnosis = "429";
    } else if (response.status >= 500 && response.status < 600) {
      diagnosis = "5XX";
    }

    if (diagnosis !== null) {
      const text = await response.text().catch(() => "");
      return c.json({ success: false, latency_ms: latencyMs, diagnosis, model: testModel, error: text.slice(0, 200) });
    }

    return c.json({ success: true, latency_ms: latencyMs, diagnosis: null, model: testModel });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isAbort = msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout");
    return c.json({
      success: false,
      latency_ms: 30000,
      diagnosis: isAbort ? ("NET" as Diagnosis) : ("RUNTIME" as Diagnosis),
      error: msg,
    });
  }
});

/**
 * POST /api/accounts/:id/clear-cooldown - Reset account to active status
 * NOTE: Must be defined BEFORE /:id routes to avoid route collision
 */
accountsRouter.post("/:id/clear-cooldown", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "invalid id" }, 400);
  }

  try {
    const result = await db
      .update(accounts)
      .set({
        status: "active",
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, id))
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Account not found" }, 404);
    }

    const updated = result[0]!;
    pool.invalidate(updated.provider as ProviderName);
    broadcast({
      type: "account_status",
      data: { id: updated.id, status: "active", provider: updated.provider, error: null },
    });

    return c.json({ success: true, id: updated.id, provider: updated.provider, status: "active" });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

/**
 * Canva team-join endpoints
 * NOTE: Defined BEFORE /:id routes to avoid route collision.
 */

/**
 * POST /api/accounts/canva/join-team
 *
 * Bulk-join Canva accounts into a team via an invite link.
 * Body: { invite_url, account_ids[], on_existing?, headless?, concurrency? }
 *
 * Returns 202 immediately; the bulk-join runs in the background and
 * broadcasts progress over WebSocket as `canva_join_progress`.
 */
accountsRouter.post("/canva/join-team", async (c) => {
  const body = await c.req.json<{
    invite_url: string;
    account_ids: number[];
    on_existing?: "switch" | "skip" | "add";
    headless?: boolean;
    concurrency?: number;
  }>();

  if (!body.invite_url || typeof body.invite_url !== "string") {
    return c.json({ error: "invite_url (string) is required" }, 400);
  }
  if (!Array.isArray(body.account_ids) || body.account_ids.length === 0) {
    return c.json({ error: "account_ids[] (non-empty) is required" }, 400);
  }
  if (!/^https?:\/\/(www\.)?canva\.com\/brand\/join/i.test(body.invite_url)) {
    return c.json({ error: "invite_url must be a https://www.canva.com/brand/join?token=... link" }, 400);
  }

  // Validate all referenced accounts exist & are canva
  const ids = body.account_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) {
    return c.json({ error: "no valid account_ids" }, 400);
  }

  const rows = await db.select().from(accounts);
  const valid = rows.filter((a) => ids.includes(a.id) && a.provider === "canva");
  if (valid.length === 0) {
    return c.json({ error: "no canva accounts matched the provided ids" }, 400);
  }

  const onExisting = body.on_existing || "switch";
  // Clamp concurrency 1..5 — same cap the bulk runner enforces.
  const concurrency = Math.max(
    1,
    Math.min(Number.isFinite(body.concurrency) ? Number(body.concurrency) : 1, 5),
  );

  // Lazy import to avoid pulling Python deps at module-load time
  const { bulkJoinCanvaTeam } = await import("../auth/canva-team");

  // Fire and forget — broadcasts progress via WS
  void bulkJoinCanvaTeam(
    valid.map((a) => a.id),
    body.invite_url,
    onExisting,
    { headless: body.headless, concurrency },
  ).catch((err) => {
    console.error("[canva-join] bulk job failed:", err);
  });

  return c.json(
    {
      message: "Bulk join queued",
      queued: valid.length,
      account_ids: valid.map((a) => a.id),
      on_existing: onExisting,
      concurrency,
    },
    202,
  );
});

/**
 * POST /api/accounts/bulk-delete
 *
 * Atomically delete many accounts at once. Mirrors DELETE /:id but for an
 * array of ids: nullifies FK references, deletes rows, broadcasts WS events.
 *
 * Body: { ids: number[] }
 * Returns: { deleted: number[], notFound: number[], totalDeleted }
 *
 * Registered BEFORE /:id routes to avoid any chance of segment collision.
 */
accountsRouter.post("/bulk-delete", async (c) => {
  const body = await c.req.json<{ ids: number[] }>().catch(() => ({ ids: [] as number[] }));
  const ids = (Array.isArray(body.ids) ? body.ids : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

  if (ids.length === 0) {
    return c.json({ error: "ids[] (non-empty array of positive integers) is required" }, 400);
  }

  // Cap to prevent accidental nukes from a runaway client
  if (ids.length > 500) {
    return c.json({ error: "too many ids (max 500 per request)" }, 400);
  }

  // Nullify foreign-key references first (same order as single DELETE /:id)
  await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, ids));
  await db.update(vccCards).set({ usedByAccountId: null }).where(inArray(vccCards.usedByAccountId, ids));
  await db.delete(vccTransactions).where(inArray(vccTransactions.accountId, ids));

  const deletedRows = await db
    .delete(accounts)
    .where(inArray(accounts.id, ids))
    .returning();

  const deletedIds = deletedRows.map((r) => r.id);
  const notFound = ids.filter((id) => !deletedIds.includes(id));

  // Invalidate pool for every affected provider (dedup)
  const affectedProviders = new Set(deletedRows.map((r) => r.provider));
  for (const provider of affectedProviders) {
    pool.invalidate(provider as ProviderName);
  }

  // Per-id WS broadcast so the dashboard can drop rows individually
  for (const id of deletedIds) {
    broadcast({ type: "account_deleted", data: { id } });
  }

  return c.json({
    success: true,
    deleted: deletedIds,
    notFound,
    totalDeleted: deletedIds.length,
  });
});

/**
 * GET /api/accounts/canva/teams/:id
 *
 * List the Canva teams (brands) a given account is a member of. Returns
 * `{ ok: true, brands: [{ id, displayName, personal, memberCount, plan }] }`.
 *
 * Wrapped under `/canva/teams/:id` (not `/:id/canva/teams`) so it sits in
 * the static-prefix bucket and never collides with `GET /:id`.
 */
accountsRouter.get("/canva/teams/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "invalid id" }, 400);
  }

  const { listCanvaTeams } = await import("../auth/canva-team");
  const result = await listCanvaTeams(id);

  if (!result.ok) {
    const status = result.code === "input_invalid"
      ? 400
      : result.code === "session_expired"
        ? 401
        : 502;
    return c.json({ error: result.error, code: result.code }, status);
  }

  return c.json({
    ok: true,
    accountId: id,
    brands: result.brands || [],
    count: (result.brands || []).length,
  });
});

/**
 * POST /api/accounts/canva/switch/:id
 *
 * Switch the active brand (CB cookie) for a Canva account. Body:
 *   { "target_brand_id": "BAHK3S9zIOo" }
 *
 * Returns `{ ok: true, previous_brand_id, brand_id }` on success.
 * The account must already be a member of `target_brand_id` — the
 * Python script will detect a no-op (CB unchanged) and report
 * `switch_failed`.
 */
accountsRouter.post("/canva/switch/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "invalid id" }, 400);
  }

  let body: { target_brand_id?: string };
  try {
    body = await c.req.json<{ target_brand_id: string }>();
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }

  const targetBrandId = String(body?.target_brand_id || "").trim();
  if (!targetBrandId || !/^BA[A-Za-z0-9_\-]{8,}$/.test(targetBrandId)) {
    return c.json(
      { error: "target_brand_id required (shape BA…)", code: "input_invalid" },
      400,
    );
  }

  const { switchCanvaBrand } = await import("../auth/canva-team");
  const result = await switchCanvaBrand(id, targetBrandId);

  if (!result.ok) {
    const status = result.code === "input_invalid"
      ? 400
      : result.code === "session_expired"
        ? 401
        : 502;
    return c.json(
      { error: result.error, code: result.code },
      status,
    );
  }

  return c.json({
    ok: true,
    accountId: id,
    previous_brand_id: result.previous_brand_id,
    brand_id: result.brand_id,
  });
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
 * POST /api/accounts/refresh-all - Refresh quota/usage for all active accounts
 */
accountsRouter.post("/refresh-all", async (c) => {
  const allAccounts = await db.select().from(accounts).where(eq(accounts.enabled, true));
  const nonByok = allAccounts.filter((a) => a.provider !== "byok" && a.status !== "pending");

  if (nonByok.length === 0) {
    return c.json({ message: "No accounts to refresh", queued: 0 });
  }

  for (const acc of nonByok) {
    warmupQueue.enqueue(acc.id);
  }

  return c.json({ message: "Refresh queued for all accounts", queued: nonByok.length });
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
