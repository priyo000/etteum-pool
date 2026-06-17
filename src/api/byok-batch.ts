/**
 * Batch BYOK endpoint — extracted to avoid file-edit issues with the large accounts.ts.
 * Registered in accounts.ts via import.
 */
import { Hono } from "hono";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { encrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import { pool, type ProviderName } from "../proxy/pool";

export const byokBatchRouter = new Hono();

/**
 * POST /api/accounts/byok/batch - Batch create BYOK accounts with multiple API keys.
 * Each key becomes a separate account sharing the same label, base_url, format, models.
 * Keys are rotated round-robin like any other provider accounts.
 */
byokBatchRouter.post("/", async (c) => {
  const body = await c.req.json() as {
    label: string;
    base_url: string;
    api_keys: string | string[];
    format?: "openai" | "anthropic" | "auto";
    models: string[];
    headers?: Record<string, string>;
  };

  if (!body.label || !body.base_url || !body.models || body.models.length === 0) {
    return c.json({ error: "label, base_url, and models[] are required" }, 400);
  }
  if (!/^[a-z0-9-]+$/.test(body.label)) {
    return c.json({ error: "label must be lowercase alphanumeric with hyphens only" }, 400);
  }

  const rawKeys: string[] = Array.isArray(body.api_keys)
    ? body.api_keys
    : String(body.api_keys || "").split(/[\n\r]+/);
  const keys = [...new Set(rawKeys.map((k) => k.trim()).filter(Boolean))];

  if (keys.length === 0) {
    return c.json({ error: "At least one API key is required" }, 400);
  }

  const created: Array<{ id: number; label: string }> = [];
  const errors: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const accountLabel = keys.length === 1 ? body.label : `${body.label}-${i + 1}`;

    const existing = await db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.email, accountLabel), eq(accounts.provider, "byok")))
      .limit(1);

    if (existing.length > 0) {
      errors.push({ index: i + 1, error: `Label "${accountLabel}" already exists` });
      continue;
    }

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
        email: accountLabel,
        password: encrypt(key),
        status: "active",
        enabled: true,
        tokens,
        quotaLimit: -1,
        quotaRemaining: -1,
      }).returning();

      created.push({ id: result[0]!.id, label: accountLabel });
    } catch (err) {
      errors.push({ index: i + 1, error: err instanceof Error ? err.message : String(err) });
    }
  }

  pool.invalidate("byok" as ProviderName);
  broadcast({ type: "byok_created", data: { batch: true, count: created.length } });

  const { refreshByokModels } = await import("../proxy/providers/registry");
  await refreshByokModels();

  return c.json({
    success: true,
    created: created.length,
    errors: errors.length,
    accounts: created,
    errorDetails: errors,
    models: body.models.map((m: string) => `${body.label}-${m}`),
  }, 201);
});
