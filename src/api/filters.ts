import { Hono } from "hono";
import { db } from "../db/index";
import { filterRules } from "../db/schema";
import { eq, asc, sql } from "drizzle-orm";
import { invalidateFilterCache } from "../proxy/filter-cache";
import { broadcast } from "../ws/index";

export const filtersRouter = new Hono();

filtersRouter.get("/", async (c) => {
  const rules = await db.select().from(filterRules).orderBy(asc(filterRules.sortOrder));
  return c.json({ count: rules.length, activeCount: rules.filter((r) => r.isActive).length, rules });
});

filtersRouter.post("/", async (c) => {
  const body = await c.req.json<{
    pattern: string;
    replacement?: string;
    isRegex?: boolean;
    isActive?: boolean;
    ruleId?: string;
  }>();
  if (!body.pattern || typeof body.pattern !== "string") {
    return c.json({ error: "pattern is required" }, 400);
  }
  if (body.isRegex) {
    try { new RegExp(body.pattern); } catch (e) {
      return c.json({ error: `Invalid regex: ${(e as Error).message}` }, 400);
    }
  }

  const [maxRow] = await db
    .select({ maxOrder: sql<number>`COALESCE(MAX(${filterRules.sortOrder}), 0)` })
    .from(filterRules);

  const ruleId = body.ruleId?.trim() || `rule_${crypto.randomUUID().slice(0, 8)}`;

  const [created] = await db
    .insert(filterRules)
    .values({
      ruleId,
      pattern: body.pattern,
      replacement: body.replacement ?? "",
      isRegex: Boolean(body.isRegex),
      isActive: body.isActive !== false,
      sortOrder: Number(maxRow?.maxOrder || 0) + 1,
    })
    .returning();

  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: {} });
  return c.json(created, 201);
});

filtersRouter.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    pattern?: string;
    replacement?: string;
    isRegex?: boolean;
    isActive?: boolean;
    sortOrder?: number;
  }>();

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.pattern === "string") {
    if (body.isRegex ?? false) {
      try { new RegExp(body.pattern); } catch (e) {
        return c.json({ error: `Invalid regex: ${(e as Error).message}` }, 400);
      }
    }
    updates.pattern = body.pattern;
  }
  if (typeof body.replacement === "string") updates.replacement = body.replacement;
  if (typeof body.isRegex === "boolean") updates.isRegex = body.isRegex;
  if (typeof body.isActive === "boolean") updates.isActive = body.isActive;
  if (typeof body.sortOrder === "number") updates.sortOrder = body.sortOrder;

  const [updated] = await db
    .update(filterRules)
    .set(updates)
    .where(eq(filterRules.id, id))
    .returning();

  if (!updated) return c.json({ error: "Not found" }, 404);

  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: {} });
  return c.json(updated);
});

filtersRouter.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const result = await db.delete(filterRules).where(eq(filterRules.id, id)).returning();
  if (result.length === 0) return c.json({ error: "Not found" }, 404);

  invalidateFilterCache();
  broadcast({ type: "filter_rules_updated", data: {} });
  return c.json({ success: true });
});
