/**
 * Tunnel Manager
 *
 * Lifecycle management for the cloudflared tunnel:
 * - Enable/disable
 * - Health checking
 * - Auto-reconnect on unexpected exit
 * - Status reporting
 */
import {
  spawnQuickTunnel,
  killCloudflared,
  isCloudflaredRunning,
  wasIntentionalKill,
  getCloudflaredProcess,
  getDownloadStatus,
  type SpawnResult,
} from "./cloudflared";
import { config } from "../../config";
import { broadcast } from "../../ws/index";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TunnelStatus {
  enabled: boolean;
  running: boolean;
  tunnelUrl: string | null;
  publicUrl: string | null;
  connectedAt: number | null;
  lastHealthCheck: number | null;
  healthy: boolean;
  reconnecting: boolean;
  error: string | null;
  download: { downloading: boolean; progress: number; error: string | null };
}

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  enabled: false,
  tunnelUrl: null as string | null,
  connectedAt: null as number | null,
  lastHealthCheck: null as number | null,
  healthy: false,
  reconnecting: false,
  error: null as string | null,
  localPort: 0,
};

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

const HEALTH_CHECK_INTERVAL = 30_000; // 30s
const HEALTH_CHECK_TIMEOUT = 5_000;   // 5s
const WATCHDOG_INTERVAL = 10_000;     // 10s
const RECONNECT_COOLDOWN = 5_000;     // 5s between reconnect attempts
let lastReconnectAt = 0;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Enable the tunnel — download cloudflared if needed, spawn quick tunnel.
 */
export async function enableTunnel(localPort?: number): Promise<{ success: boolean; tunnelUrl?: string; error?: string }> {
  const port = localPort || config.port;
  state.localPort = port;
  state.enabled = true;
  state.error = null;
  state.reconnecting = false;

  try {
    console.log(`[Tunnel] Enabling tunnel for port ${port}...`);
    const result = await spawnQuickTunnel(port);

    state.tunnelUrl = result.tunnelUrl;
    state.connectedAt = Date.now();
    state.healthy = true;
    state.error = null;

    console.log(`[Tunnel] ✓ Tunnel active: ${result.tunnelUrl}`);

    // Start health check & watchdog
    startHealthCheck();
    startWatchdog(result);

    broadcast({ type: "tunnel_status", data: getStatus() });

    return { success: true, tunnelUrl: result.tunnelUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.error = msg;
    state.healthy = false;
    console.error(`[Tunnel] Failed to enable:`, msg);
    broadcast({ type: "tunnel_status", data: getStatus() });
    return { success: false, error: msg };
  }
}

/**
 * Disable the tunnel — kill cloudflared, stop health checks.
 */
export function disableTunnel(): { success: boolean } {
  state.enabled = false;
  state.reconnecting = false;
  stopHealthCheck();
  stopWatchdog();
  killCloudflared();

  state.tunnelUrl = null;
  state.connectedAt = null;
  state.healthy = false;
  state.error = null;

  console.log("[Tunnel] Disabled");
  broadcast({ type: "tunnel_status", data: getStatus() });
  return { success: true };
}

/**
 * Get current tunnel status.
 */
export function getStatus(): TunnelStatus {
  return {
    enabled: state.enabled,
    running: isCloudflaredRunning(),
    tunnelUrl: state.tunnelUrl,
    publicUrl: state.tunnelUrl, // same for quick tunnels
    connectedAt: state.connectedAt,
    lastHealthCheck: state.lastHealthCheck,
    healthy: state.healthy,
    reconnecting: state.reconnecting,
    error: state.error,
    download: getDownloadStatus(),
  };
}

/**
 * Check if tunnel is manually disabled.
 */
export function isTunnelEnabled(): boolean {
  return state.enabled;
}

// ─── Health Check ────────────────────────────────────────────────────────────

function startHealthCheck(): void {
  stopHealthCheck();
  healthCheckTimer = setInterval(async () => {
    if (!state.tunnelUrl || !state.enabled) return;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

      const res = await fetch(`${state.tunnelUrl}/api/health`, {
        signal: controller.signal,
        headers: { "x-api-key": config.apiKey },
      });
      clearTimeout(timeout);

      state.lastHealthCheck = Date.now();
      state.healthy = res.ok;

      if (!res.ok) {
        console.warn(`[Tunnel] Health check failed: HTTP ${res.status}`);
      }
    } catch (err) {
      state.lastHealthCheck = Date.now();
      state.healthy = false;
      // Don't log every failed health check — watchdog handles reconnection
    }
  }, HEALTH_CHECK_INTERVAL);
}

function stopHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// ─── Watchdog (auto-reconnect) ───────────────────────────────────────────────

function startWatchdog(spawnResult: SpawnResult): void {
  stopWatchdog();

  // Monitor process exit
  const proc = getCloudflaredProcess();
  if (proc) {
    proc.exited.then((code) => {
      if (!state.enabled || wasIntentionalKill()) return;
      console.warn(`[Tunnel] Cloudflared exited unexpectedly (code=${code}), will reconnect...`);
      state.healthy = false;
      state.tunnelUrl = null;
      scheduleReconnect();
    });
  }

  // Periodic watchdog: check if process is still alive
  watchdogTimer = setInterval(() => {
    if (!state.enabled) return;
    if (!isCloudflaredRunning() && !state.reconnecting) {
      console.warn("[Tunnel] Watchdog: cloudflared not running, reconnecting...");
      scheduleReconnect();
    }
  }, WATCHDOG_INTERVAL);
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

async function scheduleReconnect(): Promise<void> {
  if (!state.enabled || state.reconnecting) return;

  const now = Date.now();
  if (now - lastReconnectAt < RECONNECT_COOLDOWN) return;

  state.reconnecting = true;
  lastReconnectAt = now;
  broadcast({ type: "tunnel_status", data: getStatus() });

  // Wait a bit before reconnecting
  await new Promise(r => setTimeout(r, RECONNECT_COOLDOWN));

  if (!state.enabled) { state.reconnecting = false; return; }

  try {
    console.log("[Tunnel] Reconnecting...");
    const result = await spawnQuickTunnel(state.localPort);
    state.tunnelUrl = result.tunnelUrl;
    state.connectedAt = Date.now();
    state.healthy = true;
    state.reconnecting = false;
    state.error = null;

    console.log(`[Tunnel] ✓ Reconnected: ${result.tunnelUrl}`);
    startWatchdog(result);
    broadcast({ type: "tunnel_status", data: getStatus() });
  } catch (err) {
    state.reconnecting = false;
    state.error = err instanceof Error ? err.message : String(err);
    console.error("[Tunnel] Reconnect failed:", state.error);
    broadcast({ type: "tunnel_status", data: getStatus() });

    // Try again after cooldown
    if (state.enabled) {
      setTimeout(() => scheduleReconnect(), RECONNECT_COOLDOWN * 2);
    }
  }
}
