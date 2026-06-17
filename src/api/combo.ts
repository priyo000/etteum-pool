import { Hono } from "hono";
import {
  getAllComboRules,
  getComboRule,
  createComboRule,
  updateComboRule,
  deleteComboRule,
  isComboEnabled,
  invalidateComboCache,
  getStepCooldowns,
  type NewComboRule,
} from "../proxy/combo";
import { db } from "../db/index";
import { requestLogs, settings } from "../db/schema";
import { desc, eq } from "drizzle-orm";
import { getAllModels, routeRequest } from "../proxy/router";
import type { ChatCompletionRequest } from "../proxy/providers/base";

export const comboRouter = new Hono();

/**
 * GET /api/combo - List all combo rules
 */
comboRouter.get("/", async (c) => {
  const rules = await getAllComboRules();
  return c.json({
    data: rules,
    enabled: isComboEnabled(),
    cooldowns: getStepCooldowns(),
  });
});

/**
 * GET /api/combo/models - List all available provider+model pairs for combo steps
 */
comboRouter.get("/models", async (c) => {
  const models = getAllModels();
  // Group by provider (owned_by)
  const grouped: Record<string, { id: string; name: string }[]> = {};
  for (const m of models) {
    const provider = m.owned_by || "unknown";
    if (!grouped[provider]) grouped[provider] = [];
    grouped[provider].push({ id: m.id, name: m.id });
  }
  return c.json({ data: grouped });
});

/**
 * GET /api/combo/stats - Basic combo usage analytics from request logs.
 */
comboRouter.get("/stats", async (c) => {
  const rows = await db
    .select({
      id: requestLogs.id,
      provider: requestLogs.provider,
      model: requestLogs.model,
      status: requestLogs.status,
      durationMs: requestLogs.durationMs,
      requestBody: requestLogs.requestBody,
      createdAt: requestLogs.createdAt,
    })
    .from(requestLogs)
    .orderBy(desc(requestLogs.createdAt))
    .limit(500);

  const stats: Record<string, any> = {};
  const recent: any[] = [];

  for (const row of rows) {
    const combo = (row.requestBody as any)?._poolprox?.combo;
    if (!combo) continue;

    const key = combo.ruleName || combo.requestedModel || "unknown";
    if (!stats[key]) {
      stats[key] = {
        ruleName: key,
        total: 0,
        success: 0,
        error: 0,
        steps: {},
        avgDurationMs: 0,
        totalDurationMs: 0,
      };
    }

    stats[key].total++;
    stats[key][row.status === "success" ? "success" : "error"]++;
    stats[key].totalDurationMs += Number(row.durationMs || 0);

    const stepKey = `${combo.usedProvider}/${combo.usedModel}`;
    stats[key].steps[stepKey] = (stats[key].steps[stepKey] || 0) + 1;

    recent.push({
      id: row.id,
      createdAt: row.createdAt,
      status: row.status,
      provider: row.provider,
      model: row.model,
      durationMs: row.durationMs,
      combo,
    });
  }

  const data = Object.values(stats).map((s: any) => ({
    ...s,
    avgDurationMs: s.total ? Math.round(s.totalDurationMs / s.total) : 0,
    steps: Object.entries(s.steps).map(([step, count]) => ({ step, count })),
  }));

  return c.json({ data, recent: recent.slice(0, 50) });
});

/**
 * GET /api/combo/export - Export combo rules as JSON.
 */
comboRouter.get("/export", async (c) => {
  const rules = await getAllComboRules();
  return c.json({ version: 1, exportedAt: new Date().toISOString(), rules });
});

/**
 * POST /api/combo/import - Import combo rules from JSON.
 */
comboRouter.post("/import", async (c) => {
  const body = await c.req.json<{ rules?: Partial<NewComboRule>[]; replace?: boolean }>();
  const incoming = Array.isArray(body.rules) ? body.rules : [];

  if (body.replace) {
    const existing = await getAllComboRules();
    for (const rule of existing) await deleteComboRule(rule.id);
  }

  const created = [];
  for (const rule of incoming) {
    if (!rule.triggerModel || !Array.isArray(rule.steps) || rule.steps.length === 0) continue;
    created.push(await createComboRule({
      name: rule.name || "",
      modelId: rule.modelId || "",
      triggerModel: rule.triggerModel,
      matchType: rule.matchType || "contains",
      steps: rule.steps as any,
      maxRetries: rule.maxRetries ?? 3,
      retryOn: rule.retryOn || ["quota_exhausted", "rate_limit", "error", "timeout"],
      enabled: rule.enabled ?? true,
      priority: rule.priority ?? 0,
    }));
  }

  return c.json({ imported: created.length, data: created });
});

/**
 * POST /api/combo/test - Run a small non-streaming test request against a combo model.
 */
comboRouter.post("/test", async (c) => {
  const body = await c.req.json<{ model: string; prompt?: string; maxTokens?: number }>();
  if (!body.model) return c.json({ error: "model is required" }, 400);

  const request: ChatCompletionRequest = {
    model: body.model,
    messages: [{ role: "user", content: body.prompt || "Reply with OK only." }],
    max_tokens: body.maxTokens || 64,
    stream: false,
  };

  const startedAt = Date.now();
  const routed = await routeRequest(request, false);
  return c.json({
    success: true,
    durationMs: Date.now() - startedAt,
    provider: routed.provider,
    accountEmail: routed.account.email,
    responseModel: routed.result.response?.model,
    content: routed.result.response?.choices?.[0]?.message?.content || "",
    comboInfo: routed.comboInfo || null,
  });
});

/**
 * PUT /api/combo/toggle - Enable/disable combo globally
 */
comboRouter.put("/toggle", async (c) => {
  const body = await c.req.json<{ enabled: boolean }>();

  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, "combo_enabled"));

  const value = body.enabled ? "true" : "false";

  if (existing.length > 0) {
    await db
      .update(settings)
      .set({ value, updatedAt: new Date() })
      .where(eq(settings.key, "combo_enabled"));
  } else {
    await db.insert(settings).values({ key: "combo_enabled", value });
  }

  invalidateComboCache();
  return c.json({ enabled: body.enabled });
});

/**
 * GET /api/combo/:id - Get a single combo rule
 */
comboRouter.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const rule = await getComboRule(id);
  if (!rule) return c.json({ error: "Combo rule not found" }, 404);

  return c.json({ data: rule });
});

/**
 * POST /api/combo - Create a new combo rule
 */
comboRouter.post("/", async (c) => {
  const body = await c.req.json<Partial<NewComboRule>>();

  if (!body.triggerModel) {
    return c.json({ error: "triggerModel is required" }, 400);
  }
  if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
    return c.json({ error: "steps array is required and must not be empty" }, 400);
  }

  // Validate each step has provider + model
  for (const step of body.steps) {
    if (!step.provider || !step.model) {
      return c.json({ error: "Each step must have provider and model" }, 400);
    }
  }

  const rule = await createComboRule({
    name: body.name || "",
    modelId: body.modelId || "",
    triggerModel: body.triggerModel,
    matchType: body.matchType || "contains",
    steps: body.steps,
    maxRetries: body.maxRetries ?? 3,
    retryOn: body.retryOn || ["quota_exhausted", "rate_limit", "error", "timeout"],
    enabled: body.enabled ?? true,
    priority: body.priority ?? 0,
  });

  return c.json({ data: rule }, 201);
});

/**
 * PUT /api/combo/:id - Update a combo rule
 */
comboRouter.put("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const body = await c.req.json<Partial<NewComboRule>>();

  // Validate steps if provided
  if (body.steps) {
    if (!Array.isArray(body.steps) || body.steps.length === 0) {
      return c.json({ error: "steps must be a non-empty array" }, 400);
    }
    for (const step of body.steps) {
      if (!step.provider || !step.model) {
        return c.json({ error: "Each step must have provider and model" }, 400);
      }
    }
  }

  const updated = await updateComboRule(id, body);
  if (!updated) return c.json({ error: "Combo rule not found" }, 404);

  return c.json({ data: updated });
});

/**
 * DELETE /api/combo/:id - Delete a combo rule
 */
comboRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);

  const deleted = await deleteComboRule(id);
  if (!deleted) return c.json({ error: "Combo rule not found" }, 404);

  return c.json({ success: true });
});
