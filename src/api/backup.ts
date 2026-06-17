import { Hono } from "hono";
import { db } from "../db/index";
import {
  accounts,
  settings,
  filterRules,
  modelMappings,
  proxyPool,
} from "../db/schema";
import { eq } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { NewAccount } from "../db/schema";

export const backupRouter = new Hono();

/**
 * GET /api/backup/export - Export all data as JSON backup
 *
 * Exports: accounts (with decrypted passwords), settings, filter rules,
 * model mappings, proxy pool.
 * Does NOT export: request_logs, usage_summary (too large / ephemeral).
 */
backupRouter.get("/export", async (c) => {
  const [
    allAccounts,
    allSettings,
    allFilterRules,
    allModelMappings,
    allProxyPool,
  ] = await Promise.all([
    db.select().from(accounts),
    db.select().from(settings),
    db.select().from(filterRules),
    db.select().from(modelMappings),
    db.select().from(proxyPool),
  ]);

  // Decrypt passwords for portability
  const exportAccounts = allAccounts.map((a) => ({
    provider: a.provider,
    email: a.email,
    password: (() => {
      try {
        return decrypt(a.password);
      } catch {
        return a.password;
      }
    })(),
    status: a.status,
    enabled: a.enabled,
    tokens: a.tokens,
    quotaLimit: a.quotaLimit,
    quotaRemaining: a.quotaRemaining,
    errorMessage: a.errorMessage,
    metadata: a.metadata,
  }));

  const exportSettings = allSettings.map((s) => ({
    key: s.key,
    value: s.value,
  }));

  const exportFilterRules = allFilterRules.map((r) => ({
    ruleId: r.ruleId,
    pattern: r.pattern,
    replacement: r.replacement,
    isActive: r.isActive,
    isRegex: r.isRegex,
    sortOrder: r.sortOrder,
  }));

  const exportModelMappings = allModelMappings.map((m) => ({
    sourcePattern: m.sourcePattern,
    matchType: m.matchType,
    targetModel: m.targetModel,
    enabled: m.enabled,
    priority: m.priority,
    label: m.label,
  }));

  const exportProxyPool = allProxyPool.map((p) => ({
    url: p.url,
    type: p.type,
    label: p.label,
    status: p.status,
  }));

  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: exportAccounts,
    settings: exportSettings,
    filterRules: exportFilterRules,
    modelMappings: exportModelMappings,
    proxyPool: exportProxyPool,
  };

  return c.json(backup);
});

/**
 * POST /api/backup/import - Import data from JSON backup
 *
 * Body: { ...backup JSON }
 * Query: ?mode=merge (default) | replace
 *   - merge: skip existing accounts (by provider+email), add new ones
 *   - replace: delete all existing data and import fresh
 */
backupRouter.post("/import", async (c) => {
  const mode = c.req.query("mode") || "merge";
  const body = await c.req.json();

  if (!body || !body.version) {
    return c.json({ error: "Invalid backup file. Missing version field." }, 400);
  }

  const results = {
    accounts: { imported: 0, skipped: 0, errors: 0 },
    settings: { imported: 0 },
    filterRules: { imported: 0 },
    modelMappings: { imported: 0 },
    proxyPool: { imported: 0 },
  };

  try {
    // --- Accounts ---
    if (body.accounts && Array.isArray(body.accounts)) {
      if (mode === "replace") {
        await db.delete(accounts);
      }

      for (const acc of body.accounts) {
        if (!acc.email || !acc.provider) {
          results.accounts.errors++;
          continue;
        }

        // Check if account already exists
        const existing = await db
          .select()
          .from(accounts)
          .where(eq(accounts.email, acc.email))
          .then((rows) => rows.find((r) => r.provider === acc.provider));

        if (existing && mode === "merge") {
          results.accounts.skipped++;
          continue;
        }

        try {
          const encryptedPassword = encrypt(acc.password || "");
          await db.insert(accounts).values({
            provider: acc.provider,
            email: acc.email,
            password: encryptedPassword,
            status: acc.status || "pending",
            enabled: acc.enabled !== false,
            tokens: acc.tokens || null,
            quotaLimit: acc.quotaLimit || 0,
            quotaRemaining: acc.quotaRemaining || 0,
            errorMessage: acc.errorMessage || null,
            metadata: acc.metadata || null,
          });
          results.accounts.imported++;
        } catch {
          results.accounts.errors++;
        }
      }
    }

    // --- Settings ---
    if (body.settings && Array.isArray(body.settings)) {
      if (mode === "replace") {
        await db.delete(settings);
      }

      for (const s of body.settings) {
        if (!s.key) continue;
        await db
          .insert(settings)
          .values({ key: s.key, value: s.value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: s.value, updatedAt: new Date() },
          });
        results.settings.imported++;
      }
    }

    // --- Filter Rules ---
    if (body.filterRules && Array.isArray(body.filterRules)) {
      if (mode === "replace") {
        await db.delete(filterRules);
      }

      for (const r of body.filterRules) {
        if (!r.ruleId || !r.pattern) continue;
        try {
          await db
            .insert(filterRules)
            .values({
              ruleId: r.ruleId,
              pattern: r.pattern,
              replacement: r.replacement || "",
              isActive: r.isActive !== false,
              isRegex: r.isRegex === true,
              sortOrder: r.sortOrder || 0,
            })
            .onConflictDoNothing();
          results.filterRules.imported++;
        } catch {
          // skip duplicates
        }
      }
    }

    // --- Model Mappings ---
    if (body.modelMappings && Array.isArray(body.modelMappings)) {
      if (mode === "replace") {
        await db.delete(modelMappings);
      }

      for (const m of body.modelMappings) {
        if (!m.sourcePattern) continue;
        try {
          await db.insert(modelMappings).values({
            sourcePattern: m.sourcePattern,
            matchType: m.matchType || "contains",
            targetModel: m.targetModel || "",
            enabled: m.enabled !== false,
            priority: m.priority || 0,
            label: m.label || null,
          });
          results.modelMappings.imported++;
        } catch {
          // skip
        }
      }
    }

    // --- Proxy Pool ---
    if (body.proxyPool && Array.isArray(body.proxyPool)) {
      if (mode === "replace") {
        await db.delete(proxyPool);
      }

      for (const p of body.proxyPool) {
        if (!p.url) continue;
        try {
          await db.insert(proxyPool).values({
            url: p.url,
            type: p.type || "http",
            label: p.label || null,
            status: p.status || "active",
          });
          results.proxyPool.imported++;
        } catch {
          // skip duplicates
        }
      }
    }

    broadcast({ type: "backup_imported", data: results });

    return c.json({
      message: `Import completed (${mode} mode)`,
      results,
    });
  } catch (err) {
    return c.json(
      { error: `Import failed: ${err instanceof Error ? err.message : String(err)}` },
      500
    );
  }
});
