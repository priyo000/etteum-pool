/**
 * Saved filter presets stored in localStorage.
 *
 * A preset is a snapshot of the AccountList filter state. The user gives
 * it a name and can recall it later in one click. Presets are local to
 * the browser — no server persistence — so they survive reload but not
 * device migration.
 */

const STORAGE_KEY = "etteum.account_filter_presets.v1";

export interface AccountFilterState {
  /** Free-text email search. */
  search?: string;
  /** Statuses to show. Empty/undefined = all. */
  statuses?: string[];
  /** "all" | "enabled" | "disabled". Undefined = all. */
  enabledFilter?: "all" | "enabled" | "disabled";
  /** Min quotaRemaining (inclusive). */
  quotaMin?: number;
  /** Max quotaRemaining (inclusive). */
  quotaMax?: number;
  /** Provider filter (only relevant on the global page). */
  providers?: string[];
}

export interface AccountFilterPreset {
  id: string;
  name: string;
  scope: "per-provider" | "global";
  state: AccountFilterState;
  createdAt: string;
}

function readAll(): AccountFilterPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(presets: AccountFilterPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Quota exceeded or storage disabled — silently fail.
  }
}

export function listPresets(scope?: AccountFilterPreset["scope"]): AccountFilterPreset[] {
  const all = readAll();
  return scope ? all.filter((p) => p.scope === scope) : all;
}

export function savePreset(
  name: string,
  scope: AccountFilterPreset["scope"],
  state: AccountFilterState,
): AccountFilterPreset {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("preset name is required");

  const all = readAll();
  // If a preset with the same name+scope exists, overwrite it. Otherwise add new.
  const idx = all.findIndex((p) => p.name === trimmed && p.scope === scope);
  const preset: AccountFilterPreset = {
    id: idx >= 0 ? all[idx].id : `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    scope,
    state,
    createdAt: idx >= 0 ? all[idx].createdAt : new Date().toISOString(),
  };
  if (idx >= 0) all[idx] = preset;
  else all.push(preset);
  writeAll(all);
  return preset;
}

export function deletePreset(id: string): void {
  writeAll(readAll().filter((p) => p.id !== id));
}

export function getPreset(id: string): AccountFilterPreset | undefined {
  return readAll().find((p) => p.id === id);
}
