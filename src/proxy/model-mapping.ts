/**
 * Model mapping for CLI integration (Claude Code, etc.).
 *
 * Popular CLIs (notably Claude Code) hardcode their own model ids — e.g.
 * "claude-3-5-haiku-20241022", "claude-sonnet-4-20250514". The user only sets a
 * base URL + API key; the CLI keeps calling those Anthropic model ids. This
 * module rewrites the incoming model id at the proxy edge to a target model
 * actually available in the pool, configured from the dashboard.
 *
 * Rules are read from an in-memory cache (DB-backed), mirroring filter-cache.ts.
 * resolveModelAlias() runs on the request hot path so it must stay synchronous.
 */
import { db, client } from "../db/index";
import { modelMappings, settings, type ModelMapping } from "../db/schema";
import { asc, eq } from "drizzle-orm";

const MAPPING_ENABLED_SETTING = "model_mapping_enabled";

let cache: ModelMapping[] = [];
let masterEnabled = true;

/**
 * Default mappings seeded on first boot. Templates for Claude Code's three
 * model classes (haiku / sonnet / opus). They start disabled with an empty
 * target so nothing changes until the user wires them up in the dashboard.
 */
export const DEFAULT_MODEL_MAPPINGS: Array<{
  sourcePattern: string;
  matchType: string;
  targetModel: string;
  enabled: boolean;
  priority: number;
  label: string;
}> = [
  { sourcePattern: "haiku", matchType: "contains", targetModel: "", enabled: false, priority: 0, label: "Claude Code · Haiku (small/fast)" },
  { sourcePattern: "sonnet", matchType: "contains", targetModel: "", enabled: false, priority: 1, label: "Claude Code · Sonnet (main)" },
  { sourcePattern: "opus", matchType: "contains", targetModel: "", enabled: false, priority: 2, label: "Claude Code · Opus (heavy)" },
  { sourcePattern: "fable", matchType: "contains", targetModel: "", enabled: false, priority: 3, label: "the assistant · Fable (mythos-class, safeguarded)" },
  { sourcePattern: "mythos", matchType: "contains", targetModel: "", enabled: false, priority: 4, label: "the assistant · Mythos (mythos-class, unrestricted)" }
];

/**
 * Create the table out-of-band. The drizzle file-migration journal in this repo
 * is inconsistent (only 0000 is registered), so we guarantee the table exists at
 * runtime with an idempotent CREATE rather than relying on the migrator alone.
 */
export function ensureModelMappingTable(): void {
  client.exec(`
    CREATE TABLE IF NOT EXISTS model_mappings (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      source_pattern text NOT NULL,
      match_type text DEFAULT 'contains' NOT NULL,
      target_model text DEFAULT '' NOT NULL,
      enabled integer DEFAULT 1 NOT NULL,
      priority integer DEFAULT 0 NOT NULL,
      label text,
      created_at integer NOT NULL,
      updated_at integer
    );
  `);
  client.exec(
    `CREATE INDEX IF NOT EXISTS model_mappings_priority_idx ON model_mappings (priority);`
  );
}

/** Seed default mappings if the table is empty (first boot only). */
export async function seedModelMappings(): Promise<void> {
  const [row] = await db
    .select({ count: modelMappings.id })
    .from(modelMappings)
    .limit(1);
  if (row) return; // already has rows
  await db.insert(modelMappings).values(
    DEFAULT_MODEL_MAPPINGS.map((m) => ({
      sourcePattern: m.sourcePattern,
      matchType: m.matchType,
      targetModel: m.targetModel,
      enabled: m.enabled,
      priority: m.priority,
      label: m.label,
    }))
  );
}

/** Load mappings + master toggle into the in-memory cache. */
export async function loadModelMappingCache(): Promise<void> {
  cache = await db.select().from(modelMappings).orderBy(asc(modelMappings.priority));
  const [setting] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, MAPPING_ENABLED_SETTING));
  // Default ON when the setting was never written.
  masterEnabled = setting?.value == null ? true : setting.value !== "false";
}

export function invalidateModelMappingCache(): void {
  loadModelMappingCache().catch((e) => console.error("[ModelMapping] reload failed", e));
}

export function getModelMappingsCached(): ModelMapping[] {
  return cache;
}

export function isModelMappingEnabled(): boolean {
  return masterEnabled;
}

function matchesPattern(model: string, rule: ModelMapping): boolean {
  const source = rule.sourcePattern;
  if (!source) return false;
  switch (rule.matchType) {
    case "exact":
      return model.toLowerCase() === source.toLowerCase();
    case "regex":
      try {
        return new RegExp(source, "i").test(model);
      } catch (e) {
        console.error(`[ModelMapping] invalid regex "${source}":`, e);
        return false;
      }
    case "contains":
    default:
      return model.toLowerCase().includes(source.toLowerCase());
  }
}

/**
 * Model ids that are native to a specific in-pool provider (not Claude Code's
 * generic anthropic ids) should bypass mapping entirely — otherwise calling
 * `claude_sonnet_4_6_vertex` directly gets rewritten by the "sonnet" template.
 *
 * Claude Code only ever sends DASHED ids ("claude-3-5-sonnet-..."), so using
 * underscore presence as the discriminator is a safe and zero-config rule.
 */
function isNativeProviderId(model: string): boolean {
  // Native ids using underscore convention: claude_sonnet_4_6, gpt_5_codex, gemini_3_5_flash, …
  if (/^(claude|gpt|gemini)_/.test(model)) return true;
  // Explicit alias prefixes used by routed providers:
  if (model.startsWith("gl-")) return true;          // Gumloop
  if (model.startsWith("ym-")) return true;          // YouMind
  if (model.startsWith("qd-")) return true;          // Qoder
  if (model.startsWith("cb-")) return true;          // CodeBuddy
  if (model.startsWith("canva-")) return true;       // Canva
  if (model.startsWith("kiro:")) return true;        // Kiro Pro variant
  return false;
}

/**
 * Rewrite an incoming model id to its mapped target, if any. Single pass (no
 * recursive remapping). Returns the original model when mapping is disabled,
 * no rule matches, the target is empty/identical, or the id is a native
 * in-pool provider id (which is never the target of a generic Claude Code
 * mapping).
 */
export function resolveModelAlias(model: string): string {
  if (!model || !masterEnabled) return model;
  if (isNativeProviderId(model)) return model;
  for (const rule of cache) {
    if (!rule.enabled) continue;
    if (!rule.targetModel) continue;
    if (matchesPattern(model, rule)) {
      return rule.targetModel === model ? model : rule.targetModel;
    }
  }
  return model;
}
