import { Hono } from "hono";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { pool } from "../proxy/pool";

export const proxySettingsRouter = new Hono();

/**
 * GET /api/settings/providers - List configured providers (source of truth: config.providers)
 */
proxySettingsRouter.get("/providers", async (c) => {
  return c.json({ data: config.providers });
});

/**
 * GET /api/settings - Get all settings
 */
proxySettingsRouter.get("/", async (c) => {
  const allSettings = await db.select().from(settings);
  const settingsMap: Record<string, string | null> = {};
  for (const s of allSettings) {
    settingsMap[s.key] = s.value;
  }
  return c.json({ data: settingsMap });
});

/**
 * GET /api/settings/:key - Get a specific setting
 */
proxySettingsRouter.get("/:key", async (c) => {
  const key = c.req.param("key");
  const [setting] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key));

  if (!setting) {
    return c.json({ error: "Setting not found" }, 404);
  }

  return c.json(setting);
});

/**
 * PUT /api/settings/:key - Set a setting value
 */
proxySettingsRouter.put("/:key", async (c) => {
  const key = c.req.param("key");
  const body = await c.req.json<{ value: string }>();

  if (body.value === undefined) {
    return c.json({ error: "value is required" }, 400);
  }

  // Upsert
  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key));

  if (existing.length > 0) {
    await db
      .update(settings)
      .set({ value: body.value, updatedAt: new Date() })
      .where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value: body.value });
  }

  if (key === "load_balancing_method" || /^provider_.+_lb_method$/.test(key)) {
    pool.invalidateLoadBalancingCache();
  }

  return c.json({ key, value: body.value });
});

/**
 * DELETE /api/settings/:key - Delete a setting
 */
proxySettingsRouter.delete("/:key", async (c) => {
  const key = c.req.param("key");
  const result = await db
    .delete(settings)
    .where(eq(settings.key, key))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Setting not found" }, 404);
  }

  return c.json({ success: true, deleted: key });
});

/**
 * PUT /api/settings - Bulk update settings
 */
proxySettingsRouter.put("/", async (c) => {
  const body = await c.req.json<Record<string, string>>();

  let lbCacheTouched = false;
  for (const [key, value] of Object.entries(body)) {
    const existing = await db
      .select()
      .from(settings)
      .where(eq(settings.key, key));

    if (existing.length > 0) {
      await db
        .update(settings)
        .set({ value, updatedAt: new Date() })
        .where(eq(settings.key, key));
    } else {
      await db.insert(settings).values({ key, value });
    }

    if (key === "load_balancing_method" || /^provider_.+_lb_method$/.test(key)) {
      lbCacheTouched = true;
    }
  }

  if (lbCacheTouched) pool.invalidateLoadBalancingCache();

  return c.json({ success: true, updated: Object.keys(body).length });
});
