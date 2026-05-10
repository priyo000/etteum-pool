export const API_BASE = import.meta.env.VITE_API_BASE || `http://${window.location.hostname}:${import.meta.env.VITE_BACKEND_PORT || (Number(window.location.port) - 1) || "1630"}`;

export function getWsBase(): string {
  const configured = import.meta.env.VITE_WS_BASE;
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const backendPort = import.meta.env.VITE_BACKEND_PORT || (Number(window.location.port) - 1) || "1630";
  return `${protocol}://${window.location.hostname}:${backendPort}`;
}

function getApiKey(): string {
  return localStorage.getItem("api_key") || "pool-proxy-secret-key";
}

type FetchApiOptions = RequestInit & { timeoutMs?: number };

export async function fetchApi<T = any>(path: string, options?: FetchApiOptions): Promise<T> {
  const { timeoutMs = 30_000, signal, ...fetchOptions } = options || {};
  const controller = new AbortController();
  const abortOnSignal = () => controller.abort(signal?.reason);
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abortOnSignal, { once: true });
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getApiKey()}`,
        ...fetchOptions.headers,
      },
    });

    if (!res.ok) {
      let message = `API error: ${res.status}`;
      try {
        const body = await res.json();
        message = body.error || body.message || message;
      } catch {
        const text = await res.text().catch(() => "");
        if (text) message = text;
      }
      throw new Error(message);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return text ? JSON.parse(text) : (undefined as T);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abortOnSignal);
  }
}

export function clampLimit(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPollingLoop(fn: () => Promise<void>, intervalMs: number, signal: AbortSignal) {
  while (!signal.aborted) {
    await fn().catch(() => {});
    await Promise.race([
      sleep(intervalMs),
      new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    ]);
  }
}

export async function fetchDashboardStats(hours?: number | null, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null && hours !== undefined) params.set("hours", String(hours));
  if (range) params.set("range", range);
  const qs = params.toString();
  return fetchApi(`/api/stats${qs ? `?${qs}` : ""}`);
}

export async function fetchAccounts() {
  return fetchApi("/api/accounts");
}

export async function fetchProviders() {
  return fetchApi("/api/stats/providers");
}

export async function fetchUsage(hours: number | null = 24, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null) params.set("hours", String(hours));
  if (range) params.set("range", range);
  params.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  return fetchApi(`/api/stats/usage?${params.toString()}`);
}

export async function fetchModelUsage(hours?: number | null, range?: string) {
  const params = new URLSearchParams();
  if (hours !== null && hours !== undefined) params.set("hours", String(hours));
  if (range) params.set("range", range);
  const qs = params.toString();
  return fetchApi(`/api/stats/models${qs ? `?${qs}` : ""}`);
}

export async function refreshAccountQuota(accountId: number) {
  return fetchApi(`/api/accounts/${accountId}/refresh-quota`, {
    method: "POST",
  });
}

export async function warmupAccount(accountId: number) {
  return fetchApi(`/api/accounts/${accountId}/warmup`, {
    method: "POST",
  });
}

export async function warmupAccounts(accountIds: number[]) {
  return fetchApi("/api/auth/warmup-bulk", {
    method: "POST",
    body: JSON.stringify({ accountIds }),
  });
}

export async function warmupAllAccounts(options?: { providers?: string[]; statuses?: string[]; includePending?: boolean }) {
  return fetchApi("/api/auth/warmup-all", {
    method: "POST",
    body: JSON.stringify(options || {}),
  });
}

export async function fetchWarmupQueue() {
  return fetchApi("/api/auth/warmup-queue");
}

export async function fetchWarmupEvents(limit: number = 300) {
  return fetchApi(`/api/auth/warmup-events?limit=${clampLimit(limit, 300, 1, 1000)}`);
}

export async function fetchRequests(page: number = 1, limit: number = 50, provider?: string) {
  const safeLimit = clampLimit(limit, 50, 1, 500);
  const safePage = clampLimit(page, 1, 1, 1000);
  const offset = (safePage - 1) * safeLimit;
  const params = new URLSearchParams({ limit: String(safeLimit), offset: String(offset) });
  if (provider && provider !== "all") params.set("provider", provider);
  return fetchApi(`/api/stats/requests?${params.toString()}`);
}

export async function fetchModels() {
  return fetchApi("/v1/models");
}

export async function fetchSettings() {
  return fetchApi("/api/settings");
}

export async function updateSettings(settings: Record<string, string>) {
  return fetchApi("/api/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function fetchProviderList(): Promise<{ data: string[] }> {
  return fetchApi("/api/settings/providers");
}

export async function createAccount(account: { provider: string; email: string; password: string }) {
  return fetchApi("/api/accounts", {
    method: "POST",
    body: JSON.stringify(account),
  });
}

export async function deleteAccount(id: number) {
  return fetchApi(`/api/accounts/${id}`, { method: "DELETE" });
}

export async function loginAccount(id: number, options?: { headless?: boolean }) {
  return fetchApi(`/api/auth/login/${id}`, {
    method: "POST",
    body: JSON.stringify(options || {}),
  });
}

export async function loginAccounts(accountIds: number[], options?: { headless?: boolean }) {
  return fetchApi("/api/auth/login-bulk", {
    method: "POST",
    body: JSON.stringify({ accountIds, ...(options || {}) }),
  });
}

export async function loginAllAccounts(options?: { headless?: boolean }) {
  return fetchApi("/api/auth/login-all", {
    method: "POST",
    body: JSON.stringify(options || {}),
  });
}

export async function importAccounts(text: string, providers: string[], options?: { headless?: boolean; concurrency?: number }) {
  return fetchApi("/api/auth/import", {
    method: "POST",
    body: JSON.stringify({ text, providers, ...(options || {}) }),
  });
}

export async function fetchAuthQueue() {
  return fetchApi("/api/auth/queue");
}

export async function fetchAuthLogs(limit: number = 200) {
  return fetchApi(`/api/auth/logs?limit=${clampLimit(limit, 200, 1, 1000)}`);
}

export async function clearAuthLogs() {
  return fetchApi("/api/auth/logs", { method: "DELETE" });
}

export async function fetchApiKey() {
  return fetchApi("/api/keys");
}

export async function regenerateApiKey() {
  return fetchApi("/api/keys/regenerate", { method: "POST" });
}

export async function setApiKey(key: string) {
  return fetchApi("/api/keys/set", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}

export async function testApiKey(key: string) {
  return fetchApi("/api/keys/test", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
}
