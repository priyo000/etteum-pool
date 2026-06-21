import { Hono } from "hono";
import { db } from "../db/index";
import { accounts, requestLogs, vccCards, vccTransactions, settings } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { NewAccount } from "../db/schema";
import { loginQueue } from "../auth/queue";
import { warmupQueue } from "../auth/warmup-queue";
import { warmupAccount } from "../auth/warmup-runner";
import { pool, type ProviderName } from "../proxy/pool";
import { activateQoderPat } from "../proxy/providers/qoder";
import { activateYouMindKey } from "../proxy/providers/youmind";

export const accountsRouter = new Hono();

type ByokKeyInput = {
  id?: number;
  label?: string;
  key?: string;
  api_key?: string;
  enabled?: boolean;
  weight?: number;
  priority?: number;
};

type ByokTokensShape = {
  base_url?: string;
  api_key?: string;
  format?: "openai" | "anthropic" | "auto";
  models?: string[];
  model_prefix?: string;
  headers?: Record<string, string>;
  key_label?: string;
  weight?: number;
  priority?: number;
  load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
};

const BYOK_PREFIX_RE = /^[a-z0-9-]+$/;
const BYOK_KEY_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

function parseByokTokens(raw: unknown): ByokTokensShape {
  if (!raw) return {};
  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as ByokTokensShape;
  } catch {
    return {};
  }
}

function getByokPrefix(account: { email: string; tokens: unknown }): string {
  const tokens = parseByokTokens(account.tokens);
  return tokens.model_prefix || account.email.split("#")[0] || account.email;
}

function getByokKeyLabel(account: { email: string; tokens: unknown }): string {
  const tokens = parseByokTokens(account.tokens);
  if (tokens.key_label) return tokens.key_label;
  const marker = account.email.indexOf("#");
  return marker >= 0 ? account.email.slice(marker + 1) || "default" : "default";
}

function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return Array.from(new Set(models.map((m) => String(m).trim()).filter(Boolean)));
}

function normalizeByokKeys(apiKeys: unknown, legacyApiKey?: string): Array<{ label: string; key: string; weight?: number; priority?: number }> {
  const rawKeys = Array.isArray(apiKeys)
    ? apiKeys as ByokKeyInput[]
    : legacyApiKey
      ? [{ label: "default", key: legacyApiKey }]
      : [];

  const normalized: Array<{ label: string; key: string; weight?: number; priority?: number }> = [];
  const seen = new Set<string>();
  for (const [index, item] of rawKeys.entries()) {
    const label = String(item.label || `key-${index + 1}`).trim().toLowerCase();
    const key = String(item.key || item.api_key || "").trim();
    if (!key) continue;
    if (!BYOK_KEY_LABEL_RE.test(label)) {
      throw new Error("key label must start with lowercase alphanumeric and contain only lowercase letters, numbers, hyphen, or underscore");
    }
    if (seen.has(label)) throw new Error(`duplicate BYOK key label: ${label}`);
    seen.add(label);
    normalized.push({
      label,
      key,
      weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
      priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : index,
    });
  }
  return normalized;
}

function buildByokEmail(prefix: string, keyLabel: string): string {
  return `${prefix}#${keyLabel}`;
}

function byokLbSettingKey(prefix: string): string {
  return `byok_${prefix}_lb_method`;
}

function normalizeByokLbMethod(value: unknown): "round_robin" | "sequential" | "least_inflight" {
  return value === "sequential" || value === "least_inflight" ? value : "round_robin";
}

async function setByokLbMethod(prefix: string, method: string) {
  const key = byokLbSettingKey(prefix);
  const value = normalizeByokLbMethod(method);
  const existing = await db.select().from(settings).where(eq(settings.key, key));
  if (existing.length > 0) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
  pool.invalidateLoadBalancingCache();
}

async function getByokLbMethods(prefixes: string[]): Promise<Map<string, string>> {
  const wanted = new Set(prefixes.map(byokLbSettingKey));
  const rows = await db.select().from(settings);
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!wanted.has(row.key) || !row.value) continue;
    const prefix = row.key.replace(/^byok_/, "").replace(/_lb_method$/, "");
    result.set(prefix, normalizeByokLbMethod(row.value));
  }
  return result;
}

async function refreshByokRuntime() {
  pool.invalidate("byok" as ProviderName);
  const { refreshByokModels } = await import("../proxy/providers/registry");
  await refreshByokModels();
}

/**
 * GET /api/accounts/warmup-queue - Get warmup progress per provider
 */
accountsRouter.get("/warmup-queue", (c) => {
  return c.json({ data: warmupQueue.getProgressByProvider() });
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
 * POST /api/accounts/byok - Create BYOK provider group with one or more API keys.
 * Backward compatible: accepts either `api_key` or `api_keys[]`.
 */
accountsRouter.post("/byok", async (c) => {
  const body = await c.req.json<{
    label: string;
    base_url: string;
    api_key?: string;
    api_keys?: ByokKeyInput[];
    format?: "openai" | "anthropic" | "auto";
    models: string[];
    headers?: Record<string, string>;
    load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  }>();

  const label = String(body.label || "").trim().toLowerCase();
  const baseUrl = String(body.base_url || "").trim().replace(/\/$/, "");
  const models = normalizeModels(body.models);

  if (!label || !baseUrl || models.length === 0) {
    return c.json({ error: "label, base_url, and models[] are required" }, 400);
  }
  if (!BYOK_PREFIX_RE.test(label)) {
    return c.json({ error: "label must be lowercase alphanumeric with hyphens only" }, 400);
  }

  let keyInputs: Array<{ label: string; key: string; weight?: number; priority?: number }>;
  try {
    keyInputs = normalizeByokKeys(body.api_keys, body.api_key);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (keyInputs.length === 0) {
    return c.json({ error: "At least one API key is required" }, 400);
  }

  const existingByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
  if (existingByok.some((acc) => getByokPrefix(acc) === label)) {
    return c.json({ error: "BYOK provider with this label already exists" }, 409);
  }

  try {
    const createdRows = [];
    for (const [index, keyInput] of keyInputs.entries()) {
      const tokens: ByokTokensShape = {
        base_url: baseUrl,
        format: body.format || "auto",
        models,
        model_prefix: label,
        headers: body.headers || {},
        key_label: keyInput.label,
        weight: keyInput.weight,
        priority: keyInput.priority ?? index,
        load_balancing_method: normalizeByokLbMethod(body.load_balancing_method),
      };

      const result = await db.insert(accounts).values({
        provider: "byok",
        email: buildByokEmail(label, keyInput.label),
        password: encrypt(keyInput.key),
        status: "active",
        enabled: true,
        tokens,
        quotaLimit: -1,
        quotaRemaining: -1,
      }).returning();
      if (result[0]) createdRows.push(result[0]);
    }

    await setByokLbMethod(label, normalizeByokLbMethod(body.load_balancing_method));
    await refreshByokRuntime();
    broadcast({
      type: "byok_created",
      data: { id: createdRows[0]?.id, label, keyCount: createdRows.length },
    });

    return c.json({
      success: true,
      id: createdRows[0]?.id,
      label,
      key_count: createdRows.length,
      models: models.map((m) => `${label}-${m}`),
    }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

/**
 * GET /api/accounts/byok - List BYOK provider groups with masked key metadata.
 */
accountsRouter.get("/byok", async (c) => {
  const byokAccounts = await db.select().from(accounts)
    .where(eq(accounts.provider, "byok"));

  const lbMethods = await getByokLbMethods(Array.from(new Set(byokAccounts.map((acc) => getByokPrefix(acc)))));

  const groups = new Map<string, {
    id: number;
    label: string;
    base_url: string;
    format: "openai" | "anthropic" | "auto";
    models: string[];
    model_prefix: string;
    headers?: Record<string, string>;
    status: string;
    enabled: boolean;
    available_models: string[];
    key_count: number;
    active_key_count: number;
    load_balancing_method: string;
    keys: Array<{
      id: number;
      label: string;
      status: string;
      enabled: boolean;
      weight?: number;
      priority?: number;
      lastUsedAt?: Date | null;
      errorMessage?: string | null;
    }>;
  }>();

  for (const acc of byokAccounts) {
    const tokens = parseByokTokens(acc.tokens);
    const prefix = tokens.model_prefix || getByokPrefix(acc);
    const keyLabel = getByokKeyLabel(acc);
    const models = normalizeModels(tokens.models || []);
    const existing = groups.get(prefix);

    if (!existing) {
      groups.set(prefix, {
        id: acc.id,
        label: prefix,
        base_url: tokens.base_url || "",
        format: tokens.format || "auto",
        models,
        model_prefix: prefix,
        headers: tokens.headers || {},
        status: acc.status,
        enabled: Boolean(acc.enabled),
        available_models: models.map((m) => `${prefix}-${m}`),
        key_count: 0,
        active_key_count: 0,
        load_balancing_method: lbMethods.get(prefix) || tokens.load_balancing_method || "round_robin",
        keys: [],
      });
    } else {
      const modelSet = new Set(existing.models);
      for (const model of models) modelSet.add(model);
      existing.models = Array.from(modelSet);
      existing.available_models = existing.models.map((m) => `${prefix}-${m}`);
      existing.enabled = existing.enabled || Boolean(acc.enabled);
      existing.status = existing.status === "active" || acc.status !== "active" ? existing.status : "active";
    }

    const group = groups.get(prefix)!;
    group.key_count += 1;
    if (acc.enabled && acc.status === "active") group.active_key_count += 1;
    group.keys.push({
      id: acc.id,
      label: keyLabel,
      status: acc.status,
      enabled: Boolean(acc.enabled),
      weight: tokens.weight,
      priority: tokens.priority,
      lastUsedAt: acc.lastUsedAt,
      errorMessage: acc.errorMessage,
    });
  }

  const providers = Array.from(groups.values()).map((group) => ({
    ...group,
    keys: group.keys.sort((a, b) => (Number(a.priority ?? 9999) - Number(b.priority ?? 9999)) || a.id - b.id),
  })).sort((a, b) => a.label.localeCompare(b.label));

  return c.json({ providers, total: providers.length });
});

/**
 * POST /api/accounts/byok/:id/reveal - Reveal a stored BYOK key secret.
 *
 * The list endpoint intentionally keeps secrets masked. This endpoint is called
 * only on an explicit eye-icon action from the authenticated dashboard so the
 * secret is not sent with normal page loads or websocket refreshes.
 */
accountsRouter.post("/byok/:id/reveal", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid BYOK key id" }, 400);

  const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK key not found" }, 404);
  }

  try {
    return c.json({
      success: true,
      id: account.id,
      label: getByokKeyLabel(account),
      key: decrypt(account.password),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to decrypt BYOK key" }, 500);
  }
});

/**
 * PATCH /api/accounts/byok/:id - Update a BYOK provider group.
 * If `api_keys` is provided it becomes the desired key set: existing keys can be
 * referenced by id/label and omitted keys are deleted from the group.
 */
accountsRouter.patch("/byok/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    base_url?: string;
    api_key?: string;
    api_keys?: ByokKeyInput[];
    format?: "openai" | "anthropic" | "auto";
    models?: string[];
    headers?: Record<string, string>;
    load_balancing_method?: "round_robin" | "sequential" | "least_inflight";
  }>();

  const account = await db.select().from(accounts)
    .where(eq(accounts.id, id))
    .get();

  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  const prefix = getByokPrefix(account);
  const allByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
  const groupAccounts = allByok.filter((acc) => getByokPrefix(acc) === prefix);
  const currentTokens = parseByokTokens(account.tokens);
  const nextBaseUrl = body.base_url?.trim().replace(/\/$/, "") || currentTokens.base_url || "";
  const nextFormat = body.format || currentTokens.format || "auto";
  const nextModels = body.models ? normalizeModels(body.models) : normalizeModels(currentTokens.models || []);
  const nextHeaders = body.headers ?? currentTokens.headers ?? {};

  if (!nextBaseUrl || nextModels.length === 0) {
    return c.json({ error: "base_url and at least one model are required" }, 400);
  }

  try {
    const keyPayloadProvided = Array.isArray(body.api_keys);
    const desiredKeys = keyPayloadProvided ? (body.api_keys || []) : [];
    const touchedIds = new Set<number>();

    if (keyPayloadProvided) {
      const seenLabels = new Set<string>();
      for (const [index, keyInput] of desiredKeys.entries()) {
        const keyLabel = String(keyInput.label || `key-${index + 1}`).trim().toLowerCase();
        const keySecret = String(keyInput.key || keyInput.api_key || "").trim();
        if (!BYOK_KEY_LABEL_RE.test(keyLabel)) {
          return c.json({ error: "key label must start with lowercase alphanumeric and contain only lowercase letters, numbers, hyphen, or underscore" }, 400);
        }
        if (seenLabels.has(keyLabel)) return c.json({ error: `duplicate BYOK key label: ${keyLabel}` }, 400);
        seenLabels.add(keyLabel);

        const existing = groupAccounts.find((acc) =>
          (keyInput.id && acc.id === keyInput.id) || getByokKeyLabel(acc) === keyLabel
        );
        const tokens: ByokTokensShape = {
          ...parseByokTokens(existing?.tokens),
          base_url: nextBaseUrl,
          format: nextFormat,
          models: nextModels,
          model_prefix: prefix,
          headers: nextHeaders,
          key_label: keyLabel,
          weight: Number.isFinite(Number(keyInput.weight)) ? Number(keyInput.weight) : undefined,
          priority: Number.isFinite(Number(keyInput.priority)) ? Number(keyInput.priority) : index,
          load_balancing_method: normalizeByokLbMethod(body.load_balancing_method || currentTokens.load_balancing_method),
        };

        if (existing) {
          const updateData: Record<string, unknown> = {
            email: buildByokEmail(prefix, keyLabel),
            tokens,
            enabled: typeof keyInput.enabled === "boolean" ? keyInput.enabled : existing.enabled,
            updatedAt: new Date(),
          };
          if (keySecret) updateData.password = encrypt(keySecret);
          await db.update(accounts).set(updateData).where(eq(accounts.id, existing.id));
          touchedIds.add(existing.id);
        } else {
          if (!keySecret) return c.json({ error: `new key "${keyLabel}" requires a secret` }, 400);
          const inserted = await db.insert(accounts).values({
            provider: "byok",
            email: buildByokEmail(prefix, keyLabel),
            password: encrypt(keySecret),
            status: "active",
            enabled: keyInput.enabled ?? true,
            tokens,
            quotaLimit: -1,
            quotaRemaining: -1,
          }).returning();
          if (inserted[0]) touchedIds.add(inserted[0].id);
        }
      }

      const toDelete = groupAccounts.filter((acc) => !touchedIds.has(acc.id));
      for (const acc of toDelete) {
        await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, acc.id));
        await db.delete(accounts).where(eq(accounts.id, acc.id));
      }
    } else {
      for (const acc of groupAccounts) {
        const tokens = parseByokTokens(acc.tokens);
        const updateData: Record<string, unknown> = {
          tokens: {
            ...tokens,
            base_url: nextBaseUrl,
            format: nextFormat,
            models: nextModels,
            model_prefix: prefix,
            headers: nextHeaders,
            load_balancing_method: normalizeByokLbMethod(body.load_balancing_method || tokens.load_balancing_method),
          },
          updatedAt: new Date(),
        };
        if (body.api_key && acc.id === id) updateData.password = encrypt(body.api_key);
        await db.update(accounts).set(updateData).where(eq(accounts.id, acc.id));
      }
    }

    await setByokLbMethod(prefix, normalizeByokLbMethod(body.load_balancing_method || currentTokens.load_balancing_method));
    await refreshByokRuntime();
    broadcast({ type: "byok_updated", data: { id, label: prefix } });

    return c.json({
      success: true,
      id,
      label: prefix,
      models: nextModels.map((m) => `${prefix}-${m}`),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
  }
});

/**
 * DELETE /api/accounts/byok/:id - Delete a BYOK provider group and all keys in it.
 */
accountsRouter.delete("/byok/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();

  if (!account || account.provider !== "byok") {
    return c.json({ error: "BYOK provider not found" }, 404);
  }

  const prefix = getByokPrefix(account);
  const allByok = await db.select().from(accounts).where(eq(accounts.provider, "byok"));
  const groupAccounts = allByok.filter((acc) => getByokPrefix(acc) === prefix);
  const deletedIds: number[] = [];

  for (const acc of groupAccounts) {
    await db.update(requestLogs).set({ accountId: null }).where(eq(requestLogs.accountId, acc.id));
    const result = await db.delete(accounts).where(eq(accounts.id, acc.id)).returning();
    if (result[0]) deletedIds.push(result[0].id);
  }

  await refreshByokRuntime();
  broadcast({ type: "byok_deleted", data: { id, label: prefix, deletedIds } });

  return c.json({ success: true, deleted: id, deletedIds, label: prefix });
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
/*  */
/**
 * ============================================================================
 * GitLab Duo Management Endpoints
 * NOTE: Must be defined BEFORE /:id routes to avoid route collision.
 * ============================================================================
 */

/**
 * Create a GitLab Duo account from a PAT — pure function, callable from both
 * the HTTP route AND the bot runner (after Camoufox finishes the OAuth flow
 * and obtains a fresh PAT). Performs PAT validation → namespace resolve →
 * models lookup → row insert (or update of an existing pending row).
 *
 * Pass `existingAccountId` when called from the bot path to UPDATE the
 * pending row created at queue time (preserves email + log history) instead
 * of inserting a duplicate.
 */
export type CreateGitlabDuoInput = {
  gitlabBaseUrl?: string;
  pat: string;
  label?: string;
  existingAccountId?: number;
  /**
   * When set, the bot's original Gmail credentials are persisted alongside
   * the PAT so future flows (re-login, trial extend) can re-use them.
   */
  gmailEmail?: string;
  gmailPassword?: string;
};

export type CreateGitlabDuoOk = {
  ok: true;
  id: number;
  label: string;
  username: string;
  namespacePath: string;
  defaultModel: string;
  modelsCount: number;
};

export type CreateGitlabDuoErr = {
  ok: false;
  status: number;
  error: string;
};

export async function createGitlabDuoAccount(
  input: CreateGitlabDuoInput
): Promise<CreateGitlabDuoOk | CreateGitlabDuoErr> {
  const baseUrl = (input.gitlabBaseUrl || "https://gitlab.com").replace(/\/$/, "");
  const pat = input.pat?.trim();
  if (!pat) return { ok: false, status: 400, error: "pat is required" };

  // PAT auth — match the official duo-cli (which uses `Private-Token` for
  // PAT and reserves `Authorization: Bearer …` for OAuth tokens).
  const headers = {
    "Private-Token": pat,
    "Content-Type": "application/json",
    "User-Agent": "etteum-pool/gitlab-duo",
    "X-Gitlab-Client-Name": "Duo CLI",
    "X-Gitlab-Client-Version": "8.104.0",
  };

  // 1. Validate PAT — must have `api` scope and not be revoked.
  try {
    const r = await fetch(`${baseUrl}/api/v4/personal_access_tokens/self`, { headers });
    if (!r.ok) return { ok: false, status: 400, error: `PAT invalid (HTTP ${r.status})` };
    const j = (await r.json()) as { scopes?: string[]; revoked?: boolean };
    if (j.revoked) return { ok: false, status: 400, error: "PAT is revoked" };
    if (!Array.isArray(j.scopes) || !j.scopes.includes("api")) {
      return { ok: false, status: 400, error: "PAT must have `api` scope" };
    }
  } catch (e) {
    return { ok: false, status: 502, error: `Cannot reach GitLab: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 2. Resolve user + duo-default namespace via GraphQL.
  let username = "";
  let userId = 0;
  let namespacePath = "";
  let namespaceId = 0;
  try {
    const gqlBody = {
      operationName: "getUser",
      query: `query getUser {
        currentUser {
          id
          username
          userPreferences { duoDefaultNamespace { id fullPath } }
          groups(first: 1, permissionScope: CREATE_PROJECTS) {
            nodes { id fullPath }
          }
        }
      }`,
      variables: {},
    };
    const r = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify(gqlBody),
    });
    const json = (await r.json()) as any;
    if (json.errors) return { ok: false, status: 400, error: `GraphQL: ${JSON.stringify(json.errors)}` };
    const cu = json.data?.currentUser;
    if (!cu) return { ok: false, status: 400, error: "currentUser is null — PAT lacks read_user scope?" };

    const duoNs = cu.userPreferences?.duoDefaultNamespace;
    const fallbackNs = cu.groups?.nodes?.[0];
    const ns = duoNs ?? fallbackNs;
    if (!ns) {
      return {
        ok: false,
        status: 400,
        error: "Cannot resolve a namespace for this PAT. Either set a default namespace in GitLab → Preferences → Duo, or grant the user access to at least one group.",
      };
    }
    username = cu.username;
    userId = Number(String(cu.id).split("/").pop());
    namespacePath = ns.fullPath;
    namespaceId = Number(String(ns.id).split("/").pop());
  } catch (e) {
    return { ok: false, status: 502, error: `GraphQL fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 3. List available models for that namespace.
  let defaultModel = "claude_sonnet_4_6_vertex";
  let availableModels: Array<{ name: string; ref: string }> = [];
  let gitlabVersion = "";
  try {
    const gqlBody = {
      operationName: "lsp_aiChatAvailableModels",
      query: `query lsp_aiChatAvailableModels($rootNamespaceId: GroupID!) {
        metadata { version }
        aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
          defaultModel { name ref }
          selectableModels { name ref }
        }
      }`,
      variables: { rootNamespaceId: `gid://gitlab/Group/${namespaceId}` },
    };
    const r = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify(gqlBody),
    });
    const json = (await r.json()) as any;
    gitlabVersion = json.data?.metadata?.version ?? "";
    const dm = json.data?.aiChatAvailableModels?.defaultModel;
    const sm = json.data?.aiChatAvailableModels?.selectableModels;
    if (dm?.ref) defaultModel = dm.ref;
    if (Array.isArray(sm)) availableModels = sm;
  } catch {
    // Non-fatal — fall back to bundled defaults.
  }

  const label = input.label?.trim() || username;
  const tokens = {
    gitlabBaseUrl: baseUrl,
    namespaceId,
    namespacePath,
    userId,
    ...(input.gmailEmail ? { gmailEmail: input.gmailEmail } : {}),
  };
  const metadata: Record<string, unknown> = {
    defaultModel,
    availableModels,
    gitlabVersion,
  };
  if (input.gmailPassword) {
    // Encrypt the Gmail password again under metadata so it survives PAT
    // rotation without leaking outside `password` (which holds the PAT).
    metadata.gmailPasswordEncrypted = encrypt(input.gmailPassword);
  }

  // 3.5. Pull live GitLab Credits (trial wallet) — every trial seat gets
  // ~24 credits over the 30-day window. We hit `trialUsage.usersUsage.users`
  // and pick the row matching our user's gid; falls back to the first node.
  let quotaLimit = 0;
  let quotaRemaining = 0;
  let quotaResetAt: Date | null = null;
  try {
    const r = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: "getTrialUsage",
        query: `query getTrialUsage($namespacePath: ID) {
          trialUsage(namespacePath: $namespacePath) {
            activeTrial { startDate endDate }
            usersUsage {
              users(first: 50) {
                nodes { id username usage { creditsUsed totalCredits } }
              }
            }
          }
        }`,
        variables: { namespacePath },
      }),
    });
    if (r.ok) {
      const j = (await r.json()) as any;
      const trial = j?.data?.trialUsage;
      const nodes: Array<{ id?: string; username?: string; usage?: { creditsUsed?: number; totalCredits?: number } }> =
        trial?.usersUsage?.users?.nodes ?? [];
      const ourGid = userId ? `gid://gitlab/User/${userId}` : null;
      const me =
        nodes.find((n) => ourGid && n.id === ourGid) ??
        nodes.find((n) => n.username && username && n.username.toLowerCase() === username.toLowerCase()) ??
        nodes[0];
      const used = me?.usage?.creditsUsed;
      const total = me?.usage?.totalCredits;
      if (typeof used === "number" && typeof total === "number") {
        quotaLimit = total;
        quotaRemaining = Math.max(0, total - used);
      }
      const endDate = trial?.activeTrial?.endDate ? new Date(trial.activeTrial.endDate) : null;
      if (endDate && !isNaN(endDate.getTime())) quotaResetAt = endDate;
    }
  } catch {
    // Non-fatal: leave quota at 0/0; the periodic warmup will fill it later.
  }

  // 4. Insert OR update existing pending row (bot path).
  try {
    if (input.existingAccountId) {
      // Update path — bot already inserted a pending row at queue time. Same
      // (provider, email) unique constraint already passed; just complete the
      // row with real PAT/tokens/metadata.
      const updated = await db.update(accounts)
        .set({
          password: encrypt(pat),
          status: "active",
          enabled: true,
          tokens,
          metadata,
          quotaLimit,
          quotaRemaining,
          quotaResetAt,
          errorMessage: null,
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, input.existingAccountId))
        .returning();
      const row = updated[0];
      if (!row) return { ok: false, status: 404, error: "Pending account row not found" };
      pool.invalidate("gitlab-duo" as ProviderName);
      const { refreshGitlabDuoModels } = await import("../proxy/providers/registry");
      await refreshGitlabDuoModels();
      broadcast({
        type: "account_updated",
        data: { id: row.id, provider: "gitlab-duo", email: row.email, status: "active" },
      });
      return {
        ok: true,
        id: row.id,
        label: row.email,
        username,
        namespacePath,
        defaultModel,
        modelsCount: availableModels.length,
      };
    }

    // Standard insert path (manual PAT add via dashboard).
    const existing = await db.select().from(accounts)
      .where(eq(accounts.email, label))
      .then((rows) => rows.find((r) => r.provider === "gitlab-duo"));
    if (existing) {
      return { ok: false, status: 409, error: "GitLab Duo account with this label already exists" };
    }

    const result = await db.insert(accounts).values({
      provider: "gitlab-duo",
      email: label,
      password: encrypt(pat),
      status: "active",
      enabled: true,
      tokens,
      metadata,
      quotaLimit,
      quotaRemaining,
      quotaResetAt,
    } as NewAccount).returning();
    const created = result[0]!;
    pool.invalidate("gitlab-duo" as ProviderName);

    const { refreshGitlabDuoModels } = await import("../proxy/providers/registry");
    await refreshGitlabDuoModels();

    broadcast({
      type: "account_created",
      data: { id: created.id, provider: "gitlab-duo", email: label },
    });

    return {
      ok: true,
      id: created.id,
      label,
      username,
      namespacePath,
      defaultModel,
      modelsCount: availableModels.length,
    };
  } catch (e) {
    return { ok: false, status: 500, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * POST /api/accounts/gitlab-duo - Create a GitLab Duo account from a PAT.
 *
 * Body: { gitlab_base_url?: string, pat: string, label?: string }
 *
 * Thin wrapper over `createGitlabDuoAccount()`.
 */
accountsRouter.post("/gitlab-duo", async (c) => {
  const body = await c.req.json<{
    gitlab_base_url?: string;
    gitlabBaseUrl?: string;
    pat: string;
    label?: string;
    gmail_email?: string;
    gmailEmail?: string;
    gmail_password?: string;
    gmailPassword?: string;
  }>();
  const result = await createGitlabDuoAccount({
    gitlabBaseUrl: body.gitlab_base_url ?? body.gitlabBaseUrl,
    pat: body.pat,
    label: body.label,
    gmailEmail: body.gmail_email ?? body.gmailEmail,
    gmailPassword: body.gmail_password ?? body.gmailPassword,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as any);
  return c.json({
    success: true,
    id: result.id,
    label: result.label,
    username: result.username,
    namespacePath: result.namespacePath,
    defaultModel: result.defaultModel,
    modelsCount: result.modelsCount,
  }, 201);
});

/**
 * POST /api/accounts/gitlab-duo/:id/refresh - Re-resolve namespace + models for
 * an existing account. Useful after the user changes their default namespace
 * or when GitLab adds new selectable models to your tier.
 */
accountsRouter.post("/gitlab-duo/:id/refresh", async (c) => {
  const id = Number(c.req.param("id"));
  const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!account || account.provider !== "gitlab-duo") {
    return c.json({ error: "Not a GitLab Duo account" }, 404);
  }

  const tokens = (typeof account.tokens === "string"
    ? JSON.parse(account.tokens)
    : account.tokens) as { gitlabBaseUrl: string; namespaceId?: number };
  const oldMeta = (typeof account.metadata === "string"
    ? JSON.parse(account.metadata)
    : account.metadata) ?? {};
  const pat = decrypt(account.password);
  const baseUrl = tokens.gitlabBaseUrl;

  const headers = {
    "Private-Token": pat,
    "Content-Type": "application/json",
    "User-Agent": "etteum-pool/gitlab-duo",
  };

  try {
    // 1. Re-resolve duoDefaultNamespace (it can change in GitLab Preferences UI),
    //    or fall back to the user's first writable group.
    const userR = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: "getUser",
        query: `query getUser {
          currentUser {
            userPreferences { duoDefaultNamespace { id fullPath } }
            groups(first: 1, permissionScope: CREATE_PROJECTS) {
              nodes { id fullPath }
            }
          }
        }`,
        variables: {},
      }),
    });
    const userJson = (await userR.json()) as any;
    const cu = userJson.data?.currentUser;
    const duoNs = cu?.userPreferences?.duoDefaultNamespace;
    const fallbackNs = cu?.groups?.nodes?.[0];
    const ns = duoNs ?? fallbackNs;
    if (!ns) return c.json({ error: "no namespace resolvable for this PAT" }, 400);

    const namespaceId = Number(String(ns.id).split("/").pop());
    const namespacePath = ns.fullPath;

    // 2. Re-fetch the available models for that namespace
    const modelsR = await fetch(`${baseUrl}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: "lsp_aiChatAvailableModels",
        query: `query lsp_aiChatAvailableModels($rootNamespaceId: GroupID!) {
          metadata { version }
          aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
            defaultModel { name ref }
            selectableModels { name ref }
          }
        }`,
        variables: { rootNamespaceId: `gid://gitlab/Group/${namespaceId}` },
      }),
    });
    const modelsJson = (await modelsR.json()) as any;
    const dm = modelsJson.data?.aiChatAvailableModels?.defaultModel;
    const sm = modelsJson.data?.aiChatAvailableModels?.selectableModels;
    const gitlabVersion = modelsJson.data?.metadata?.version ?? oldMeta.gitlabVersion ?? "";

    const nextTokens = { ...tokens, namespaceId, namespacePath };
    const nextMeta = {
      ...oldMeta,
      defaultModel: dm?.ref ?? oldMeta.defaultModel ?? "claude_sonnet_4_6_vertex",
      availableModels: Array.isArray(sm) ? sm : oldMeta.availableModels ?? [],
      gitlabVersion,
    };

    // 3. Pull current GitLab Credits balance via trialUsage so quota columns
    //    reflect the live wallet (creditsUsed / totalCredits per user).
    let quotaLimit = account.quotaLimit ?? 0;
    let quotaRemaining = account.quotaRemaining ?? 0;
    let quotaResetAt: Date | null = account.quotaResetAt ?? null;
    try {
      const { providers } = await import("../proxy/router");
      const duoProvider = providers["gitlab-duo"];
      if (duoProvider) {
        const probe = await duoProvider.fetchQuota({
          ...account,
          tokens: nextTokens,
          metadata: nextMeta,
        });
        if (probe.success && probe.quota && probe.quota.limit >= 0) {
          quotaLimit = probe.quota.limit;
          quotaRemaining = probe.quota.remaining;
          if (probe.quota.resetAt instanceof Date) quotaResetAt = probe.quota.resetAt;
        }
      }
    } catch {
      // Non-fatal — keep stored quota values.
    }

    await db.update(accounts)
      .set({
        tokens: nextTokens,
        metadata: nextMeta,
        quotaLimit,
        quotaRemaining,
        quotaResetAt,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, id));

    // Trigger provider cache refresh so the new model list is routable immediately
    const { refreshGitlabDuoModels } = await import("../proxy/providers/registry");
    await refreshGitlabDuoModels();

    return c.json({
      success: true,
      namespacePath,
      namespaceId,
      defaultModel: nextMeta.defaultModel,
      modelsCount: nextMeta.availableModels.length,
      quotaLimit,
      quotaRemaining,
      quotaResetAt,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
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
    provider: "kiro" | "kiro-pro" | "codebuddy" | "codebuddy-china" | "canva" | "codex" | "qoder";
    email?: string;
    password?: string;
    personalToken?: string;
    apiKey?: string;
    apiKeys?: string; // CodeBuddy China bulk: newline-separated ck_... keys
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


  // ── CodeBuddy China: Bulk API key flow (ck_...) ─────────────────────
  // Accept multiple API keys (one per line), validate format, and create
  // account per key with auto-generated email label.
  if (body.provider === "codebuddy-china" && body.apiKeys) {
    const keys = body.apiKeys
      .split("\n")
      .map((k: string) => k.trim())
      .filter((k: string) => k.length > 0);

    if (keys.length === 0) {
      return c.json({ error: "apiKeys is empty" }, 400);
    }

    // Validate format
    for (const key of keys) {
      if (!key.startsWith("ck_")) {
        return c.json({ error: `Invalid API key format: ${key.substring(0, 20)}... (must start with ck_)` }, 400);
      }
    }

    const created: Array<{ id: number; email: string }> = [];
    const existingCount = await db.select().from(accounts)
      .where(eq(accounts.provider, "codebuddy-china"))
      .then((rows) => rows.length);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const email = `cbc-account-${existingCount + i + 1}`;
      const encryptedKey = encrypt(key);

      // Store API key in BOTH password (for encryption) and tokens (for provider to read)
      const tokens = JSON.stringify({ api_key: key });

      const inserted = await db.insert(accounts).values({
        provider: "codebuddy-china",
        email,
        password: encryptedKey,
        status: "active",
        tokens,
        quotaLimit: -1,
        quotaRemaining: -1,
        lastLoginAt: new Date(),
      }).returning();

      if (inserted[0]) {
        created.push({ id: inserted[0].id, email });
      }
    }

    pool.invalidate("codebuddy-china" as any);
    broadcast({ type: "account_created", data: { provider: "codebuddy-china", count: created.length } });

    return c.json({
      success: true,
      count: created.length,
      accounts: created,
    }, 201);
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
 * POST /api/accounts/bulk-delete - Delete multiple accounts at once.
 *
 * Works for every provider (the row shape is identical). Defined BEFORE the
 * dynamic `/:id` route so Hono matches the literal path first.
 *
 * Body: { ids: number[] }
 * Returns: { success, requested, deleted, providers, notFound }
 */
accountsRouter.post("/bulk-delete", async (c) => {
  const body = await c.req.json<{ ids?: Array<number | string> }>().catch(() => ({} as { ids?: Array<number | string> }));

  // Coerce + dedupe + drop anything non-numeric so a malformed entry can't
  // widen the delete (e.g. NaN turning into "delete everything").
  const ids = Array.from(
    new Set(
      (body.ids ?? [])
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  );

  if (ids.length === 0) {
    return c.json({ error: "ids must be a non-empty array of account ids" }, 400);
  }

  // Resolve providers up front so we can invalidate exactly the affected pools.
  const targets = await db
    .select({ id: accounts.id, provider: accounts.provider })
    .from(accounts)
    .where(inArray(accounts.id, ids));

  if (targets.length === 0) {
    return c.json({ error: "No matching accounts found" }, 404);
  }

  const foundIds = targets.map((t) => t.id);
  const providersAffected = Array.from(new Set(targets.map((t) => t.provider)));

  // Nullify / clean foreign keys before the delete (mirrors DELETE /:id).
  await db.update(requestLogs).set({ accountId: null }).where(inArray(requestLogs.accountId, foundIds));
  await db.update(vccCards).set({ usedByAccountId: null }).where(inArray(vccCards.usedByAccountId, foundIds));
  await db.delete(vccTransactions).where(inArray(vccTransactions.accountId, foundIds));

  const result = await db.delete(accounts).where(inArray(accounts.id, foundIds)).returning();
  const deletedIds = result.map((r) => r.id);

  for (const provider of providersAffected) {
    pool.invalidate(provider as ProviderName);
  }
  // Mirror single-delete's broadcast shape per id so existing dashboard
  // listeners (`account_deleted`) keep working without changes, then send
  // one summary frame for clients that prefer the bulk signal.
  for (const id of deletedIds) {
    broadcast({ type: "account_deleted", data: { id } });
  }
  broadcast({ type: "accounts_deleted", data: { ids: deletedIds, providers: providersAffected } });

  const notFound = ids.filter((id) => !foundIds.includes(id));
  return c.json({
    success: true,
    requested: ids.length,
    deleted: deletedIds.length,
    deletedIds,
    providers: providersAffected,
    notFound,
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
