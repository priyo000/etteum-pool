import { db } from "../db/index";
import { proxyPool } from "../db/schema";
import { eq, sql } from "drizzle-orm";

interface CachedProxy {
  id: number;
  url: string;
  type: string;
}

let cachedProxies: CachedProxy[] = [];
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000;
let roundRobinIndex = 0;

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

export async function getNextProxy(type?: "http" | "socks5"): Promise<{ id: number; url: string } | null> {
  const proxies = await refreshCache();
  const filtered = type ? proxies.filter((p) => p.type === type) : proxies;

  if (filtered.length === 0) return null;

  const index = roundRobinIndex % filtered.length;
  roundRobinIndex = (roundRobinIndex + 1) % Number.MAX_SAFE_INTEGER;
  const proxy = filtered[index];

  // Update lastUsedAt in background
  void db
    .update(proxyPool)
    .set({ lastUsedAt: new Date() })
    .where(eq(proxyPool.id, proxy.id));

  return { id: proxy.id, url: proxy.url };
}

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
}

export async function checkProxyHealth(proxyUrl: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const response = await fetch("https://httpbin.org/ip", {
      proxy: proxyUrl,
      signal: AbortSignal.timeout(10000),
    } as any);

    if (!response.ok) {
      return { ok: false, latencyMs: Date.now() - start, error: `HTTP ${response.status}` };
    }

    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}
