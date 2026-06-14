import { db } from "../db/index";
import { proxyPool, settings } from "../db/schema";
import { eq, sql, inArray } from "drizzle-orm";

interface CachedProxy {
  id: number;
  url: string;
  type: string;
}

// ── Proxy list cache ────────────────────────────────────────────────
let cachedProxies: CachedProxy[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000;

async function refreshCache(): Promise<CachedProxy[]> {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL_MS && cachedProxies.length > 0) {
    return cachedProxies;
  }

  const rows = await db
    .select({ id: proxyPool.id, url: proxyPool.url, type: proxyPool.type })
    .from(proxyPool)
    .where(eq(proxyPool.status, "active"));

  cachedProxies = rows;
  cacheTimestamp = now;
  return cachedProxies;
}

export function invalidateProxyCache() {
  cacheTimestamp = 0;
}

// ── Proxy pool settings cache ───────────────────────────────────────
type ProxyUsage = "all" | "model" | "auth";
type ProxyRotation = "round_robin" | "sequential";

interface ProxyPoolSettings {
  usage: ProxyUsage;
  rotation: ProxyRotation;
}

let settingsCache: ProxyPoolSettings = { usage: "all", rotation: "round_robin" };
let settingsCacheTs = 0;
const SETTINGS_CACHE_TTL_MS = 10_000;

async function getProxyPoolSettings(): Promise<ProxyPoolSettings> {
  const now = Date.now();
  if (now - settingsCacheTs < SETTINGS_CACHE_TTL_MS) return settingsCache;

  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, ["proxy_pool_usage", "proxy_pool_rotation"]));

  let usage: ProxyUsage = "all";
  let rotation: ProxyRotation = "round_robin";

  for (const row of rows) {
    if (row.key === "proxy_pool_usage" && (row.value === "all" || row.value === "model" || row.value === "auth")) {
      usage = row.value;
    }
    if (row.key === "proxy_pool_rotation" && (row.value === "round_robin" || row.value === "sequential")) {
      rotation = row.value;
    }
  }

  settingsCache = { usage, rotation };
  settingsCacheTs = now;
  return settingsCache;
}

export function invalidateProxySettingsCache() {
  settingsCacheTs = 0;
}

// ── Rotation state ──────────────────────────────────────────────────
let roundRobinIndex = 0;
let sequentialIndex = 0;

// ── Core: get next proxy ────────────────────────────────────────────
/**
 * Get the next proxy from the pool.
 *
 * @param purpose - What the proxy will be used for: `"model"` (upstream API
 *   calls) or `"auth"` (login automation). If the pool's usage setting
 *   doesn't include this purpose, returns `null`.
 * @param type - Optional protocol filter (`"http"` or `"socks5"`).
 */
export async function getNextProxy(
  purpose: "model" | "auth" = "model",
  type?: "http" | "socks5",
): Promise<{ id: number; url: string } | null> {
  const cfg = await getProxyPoolSettings();

  // Check if proxy pool is enabled for this purpose
  if (cfg.usage !== "all" && cfg.usage !== purpose) return null;

  const proxies = await refreshCache();
  const filtered = type ? proxies.filter((p) => p.type === type) : proxies;
  if (filtered.length === 0) return null;

  let proxy: CachedProxy | undefined;

  if (cfg.rotation === "sequential") {
    // Sequential: stick with current index, only advance on failure
    if (sequentialIndex >= filtered.length) sequentialIndex = 0;
    proxy = filtered[sequentialIndex];
  } else {
    // Round-robin (default)
    const index = roundRobinIndex % filtered.length;
    roundRobinIndex = (roundRobinIndex + 1) % Number.MAX_SAFE_INTEGER;
    proxy = filtered[index];
  }

  if (!proxy) return null;

  // Update lastUsedAt in background
  void db
    .update(proxyPool)
    .set({ lastUsedAt: new Date() })
    .where(eq(proxyPool.id, proxy.id));

  return { id: proxy.id, url: proxy.url };
}

/**
 * Advance the sequential index (call on proxy failure so the next call
 * picks a different proxy).
 */
export function advanceSequentialIndex() {
  sequentialIndex++;
}

// ── Success / Fail tracking ─────────────────────────────────────────
export async function markProxySuccess(id: number) {
  await db
    .update(proxyPool)
    .set({ successCount: sql`${proxyPool.successCount} + 1`, updatedAt: new Date() })
    .where(eq(proxyPool.id, id));
}

export async function markProxyFail(id: number, error?: string) {
  await db
    .update(proxyPool)
    .set({
      failCount: sql`${proxyPool.failCount} + 1`,
      errorMessage: error || null,
      updatedAt: new Date(),
    })
    .where(eq(proxyPool.id, id));

  // In sequential mode, advance to next proxy on failure
  advanceSequentialIndex();
}

// ── Health check ────────────────────────────────────────────────────
export async function checkProxyHealth(proxyUrl: string): Promise<{ ok: boolean; latencyMs: number; error?: string; ip?: string }> {
  const start = Date.now();
  try {
    const res = await fetch("https://httpbin.org/ip", {
      proxy: proxyUrl,
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }

    const body = await res.json() as { origin?: string };
    return { ok: true, latencyMs, ip: body.origin };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}
