/**
 * Combo (Multi-Provider+Model Fallback) system.
 *
 * When a request for model X fails on provider A, the combo chain automatically
 * retries with a different provider+model pair. For example:
 *
 *   Request: claude-opus-4 (any provider)
 *     → CodeBuddy cb-opus-4.6 (quota exhausted)
 *       → Kiro kr-claude-sonnet-4.5 (error)
 *         → Canva canva-sonnet-4 (success ✅)
 *
 * Rules are stored in the `combo_rules` SQLite table and cached in memory.
 * The cache is invalidated whenever rules are created/updated/deleted via the API.
 */

import { db, client } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComboStep {
  provider: string;  // e.g. "codebuddy", "kiro", "canva"
  model: string;     // e.g. "cb-opus-4.6", "kr-claude-sonnet-4.5"
}

export interface ComboRule {
  id: number;
  name: string;           // human label, e.g. "Opus fallback chain"
  modelId: string;        // custom model name shown in /v1/models (e.g. "best", "fast")
  triggerModel: string;    // incoming model pattern (exact or contains) — also used as fallback modelId
  matchType: "exact" | "contains" | "prefix";
  steps: ComboStep[];     // ordered fallback chain
  maxRetries: number;     // max providers to try (0 = try all steps)
  retryOn: string[];      // conditions: quota_exhausted, rate_limit, error, timeout
  enabled: boolean;
  priority: number;       // lower = evaluated first
  createdAt: Date;
  updatedAt: Date | null;
}

export type NewComboRule = Omit<ComboRule, "id" | "createdAt" | "updatedAt">;

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

const COMBO_ENABLED_SETTING = "combo_enabled";

/** Create the combo_rules table if it doesn't exist (idempotent). */
export function ensureComboTable(): void {
  client.exec(`
    CREATE TABLE IF NOT EXISTS combo_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      model_id    TEXT NOT NULL DEFAULT '',
      trigger_model TEXT NOT NULL,
      match_type  TEXT NOT NULL DEFAULT 'contains',
      steps       TEXT NOT NULL DEFAULT '[]',
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_on    TEXT NOT NULL DEFAULT '["quota_exhausted","rate_limit","error","timeout"]',
      enabled     INTEGER NOT NULL DEFAULT 1,
      priority    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at  INTEGER
    );
  `);
  // Add model_id column if upgrading from older schema
  try {
    client.exec(`ALTER TABLE combo_rules ADD COLUMN model_id TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists — ignore
  }
  client.exec(
    `CREATE INDEX IF NOT EXISTS combo_rules_priority_idx ON combo_rules (priority);`
  );
}

// ---------------------------------------------------------------------------
// In-memory cache (hot path — must be synchronous reads)
// ---------------------------------------------------------------------------

let cache: ComboRule[] = [];
let masterEnabled = true;

/** Load all combo rules + master toggle into memory. */
export async function loadComboCache(): Promise<void> {
  try {
    const rows = client
      .prepare("SELECT * FROM combo_rules ORDER BY priority ASC, id ASC")
      .all() as any[];

    cache = rows.map(rowToComboRule);

    const [setting] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, COMBO_ENABLED_SETTING));
    masterEnabled = setting?.value == null ? true : setting.value !== "false";
  } catch (err) {
    console.error("[Combo] Failed to load cache:", err);
  }
}

export function invalidateComboCache(): void {
  loadComboCache().catch((e) => console.error("[Combo] reload failed", e));
}

export function getComboCached(): ComboRule[] {
  return cache;
}

export function isComboEnabled(): boolean {
  return masterEnabled;
}

// ---------------------------------------------------------------------------
// Virtual models — combo rules exposed as selectable models in /v1/models
// ---------------------------------------------------------------------------

import type { ModelInfo } from "./providers/base";

/**
 * Return combo rules as virtual ModelInfo entries so they appear in /v1/models.
 * The model id is the triggerModel (e.g. "best", "fall").
 * Only enabled rules are included when the master toggle is on.
 */
export function getComboVirtualModels(): ModelInfo[] {
  if (!masterEnabled) return [];

  return cache
    .filter((r) => r.enabled && r.steps.length > 0)
    .map((rule) => ({
      id: rule.modelId || rule.triggerModel,  // custom model name, fallback to trigger
      object: "model" as const,
      created: Math.floor(rule.createdAt.getTime() / 1000),
      owned_by: "combo",
      context_window: 200000,
      max_output: 64000,
      thinking: true,
      vision: true,
    }));
}

/**
 * Check if a model id is a combo virtual model (exact match on triggerModel).
 */
export function isComboModel(model: string): ComboRule | null {
  if (!masterEnabled) return null;
  const lower = model.toLowerCase();
  for (const rule of cache) {
    if (!rule.enabled || rule.steps.length === 0) continue;
    // Match on custom modelId first, then triggerModel as fallback
    const ruleModelId = (rule.modelId || rule.triggerModel).toLowerCase();
    if (ruleModelId === lower) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Find the first matching combo rule for an incoming model id.
 * Returns null if combo is disabled or no rule matches.
 */
export function findComboForModel(model: string): ComboRule | null {
  if (!masterEnabled) return null;

  const normalizedModel = model.toLowerCase();

  for (const rule of cache) {
    if (!rule.enabled) continue;

    const pattern = rule.triggerModel.toLowerCase();

    switch (rule.matchType) {
      case "exact":
        if (normalizedModel === pattern) return rule;
        break;
      case "prefix":
        if (normalizedModel.startsWith(pattern)) return rule;
        break;
      case "contains":
      default:
        if (normalizedModel.includes(pattern)) return rule;
        break;
    }
  }

  return null;
}

/**
 * Check whether a provider error should trigger a combo retry.
 */
export function shouldComboRetry(
  rule: ComboRule,
  error: string,
  quotaExhausted?: boolean,
  rateLimited?: boolean,
): boolean {
  const retryOn = new Set(rule.retryOn);

  if (quotaExhausted && retryOn.has("quota_exhausted")) return true;
  if (rateLimited && retryOn.has("rate_limit")) return true;

  if (retryOn.has("timeout")) {
    const lower = error.toLowerCase();
    if (
      lower.includes("timeout") ||
      lower.includes("etimedout") ||
      lower.includes("aborted")
    ) {
      return true;
    }
  }

  if (retryOn.has("error")) {
    // Generic error — retry on anything that isn't a content/model issue
    const lower = error.toLowerCase();
    const isContentIssue =
      lower.includes("moderation") ||
      lower.includes("invalid_model") ||
      lower.includes("model_not_found") ||
      lower.includes("sensitive content");
    if (!isContentIssue) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Step cooldown — temporarily disable steps that fail repeatedly
// ---------------------------------------------------------------------------

const COOLDOWN_THRESHOLD = 5;       // consecutive failures before cooldown
const COOLDOWN_DURATION_MS = 10 * 60 * 1000; // 10 minutes

interface StepCooldownEntry {
  failures: number;
  cooledUntil: number; // timestamp ms
}

const stepCooldowns = new Map<string, StepCooldownEntry>();

function stepKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** Record a failure for a combo step. Returns true if the step is now in cooldown. */
export function recordStepFailure(provider: string, model: string): boolean {
  const key = stepKey(provider, model);
  const entry = stepCooldowns.get(key) || { failures: 0, cooledUntil: 0 };
  entry.failures++;
  if (entry.failures >= COOLDOWN_THRESHOLD) {
    entry.cooledUntil = Date.now() + COOLDOWN_DURATION_MS;
    console.log(`[Combo] Step ${key} cooled down for 10m after ${entry.failures} consecutive failures.`);
  }
  stepCooldowns.set(key, entry);
  return entry.cooledUntil > Date.now();
}

/** Record a success for a combo step — resets its failure counter. */
export function recordStepSuccess(provider: string, model: string): void {
  stepCooldowns.delete(stepKey(provider, model));
}

/** Check if a combo step is currently in cooldown. */
export function isStepCooledDown(provider: string, model: string): boolean {
  const entry = stepCooldowns.get(stepKey(provider, model));
  if (!entry) return false;
  if (entry.cooledUntil <= Date.now()) {
    // Cooldown expired — reset
    stepCooldowns.delete(stepKey(provider, model));
    return false;
  }
  return true;
}

/** Get cooldown status for all steps (for dashboard). */
export function getStepCooldowns(): Array<{ step: string; failures: number; cooledUntil: string | null }> {
  const now = Date.now();
  const result: Array<{ step: string; failures: number; cooledUntil: string | null }> = [];
  for (const [key, entry] of stepCooldowns) {
    result.push({
      step: key,
      failures: entry.failures,
      cooledUntil: entry.cooledUntil > now ? new Date(entry.cooledUntil).toISOString() : null,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// CRUD helpers (called from API routes)
// ---------------------------------------------------------------------------

export async function getAllComboRules(): Promise<ComboRule[]> {
  const rows = client
    .prepare("SELECT * FROM combo_rules ORDER BY priority ASC, id ASC")
    .all() as any[];
  return rows.map(rowToComboRule);
}

export async function getComboRule(id: number): Promise<ComboRule | null> {
  const row = client
    .prepare("SELECT * FROM combo_rules WHERE id = ?")
    .get(id) as any;
  return row ? rowToComboRule(row) : null;
}

export async function createComboRule(rule: NewComboRule): Promise<ComboRule> {
  const now = Math.floor(Date.now() / 1000);
  const result = client
    .prepare(
      `INSERT INTO combo_rules (name, model_id, trigger_model, match_type, steps, max_retries, retry_on, enabled, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      rule.name,
      rule.modelId || '',
      rule.triggerModel,
      rule.matchType,
      JSON.stringify(rule.steps),
      rule.maxRetries,
      JSON.stringify(rule.retryOn),
      rule.enabled ? 1 : 0,
      rule.priority,
      now,
    );

  invalidateComboCache();

  return {
    ...rule,
    id: Number(result.lastInsertRowid),
    createdAt: new Date(now * 1000),
    updatedAt: null,
  };
}

export async function updateComboRule(
  id: number,
  updates: Partial<NewComboRule>,
): Promise<ComboRule | null> {
  const existing = await getComboRule(id);
  if (!existing) return null;

  const now = Math.floor(Date.now() / 1000);
  const merged = { ...existing, ...updates };

  client
    .prepare(
      `UPDATE combo_rules
       SET name = ?, model_id = ?, trigger_model = ?, match_type = ?, steps = ?,
           max_retries = ?, retry_on = ?, enabled = ?, priority = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      merged.name,
      merged.modelId || '',
      merged.triggerModel,
      merged.matchType,
      JSON.stringify(merged.steps),
      merged.maxRetries,
      JSON.stringify(merged.retryOn),
      merged.enabled ? 1 : 0,
      merged.priority,
      now,
      id,
    );

  invalidateComboCache();
  return { ...merged, id, updatedAt: new Date(now * 1000) };
}

export async function deleteComboRule(id: number): Promise<boolean> {
  const result = client.prepare("DELETE FROM combo_rules WHERE id = ?").run(id);
  invalidateComboCache();
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Row → object helper
// ---------------------------------------------------------------------------

function normalizeComboStep(step: ComboStep): ComboStep {
  const model = String(step.model || "");
  if (step.provider === "kiro" && model && !model.startsWith("kr-")) {
    return { ...step, model: `kr-${model}` };
  }
  if (step.provider === "kiro-pro") {
    if (model.startsWith("krp-")) return step;
    if (model.startsWith("kp-opus-")) return { ...step, model: `krp-claude-${model.slice(3)}` };
    if (model.startsWith("kp-sonnet-")) return { ...step, model: `krp-claude-${model.slice(3)}` };
    if (model.startsWith("kp-haiku-")) return { ...step, model: `krp-claude-${model.slice(3)}` };
    if (model === "kp-auto") return { ...step, model: "krp-auto" };
    if (model && !model.startsWith("krp-")) return { ...step, model: `krp-${model}` };
  }
  return step;
}

function rowToComboRule(row: any): ComboRule {
  return {
    id: row.id,
    name: row.name || "",
    modelId: row.model_id || "",
    triggerModel: row.trigger_model,
    matchType: row.match_type || "contains",
    steps: safeJsonParse<ComboStep[]>(row.steps, []).map(normalizeComboStep),
    maxRetries: row.max_retries ?? 3,
    retryOn: safeJsonParse(row.retry_on, ["quota_exhausted", "rate_limit", "error", "timeout"]),
    enabled: Boolean(row.enabled),
    priority: row.priority ?? 0,
    createdAt: new Date((row.created_at || 0) * 1000),
    updatedAt: row.updated_at ? new Date(row.updated_at * 1000) : null,
  };
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  try {
    return typeof value === "string" ? JSON.parse(value) : (value as T);
  } catch {
    return fallback;
  }
}
