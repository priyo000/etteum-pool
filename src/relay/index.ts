/**
 * Relay Proxy API Routes & HTTP Handler
 *
 * Provides:
 * 1. Management API (/api/relay/*) - start/stop/status/config
 * 2. Tunnel HTTP endpoint (/relay/:tunnelId/*) - forwards requests through tunnels
 * 3. Tunnel WebSocket endpoint (/relay/tunnel) - accepts tunnel connections
 */
import { Hono } from "hono";
import { getRelayClient, startRelayClient, stopRelayClient, type RelayClientConfig } from "./client";
import { getRelayServer, startRelayServer, stopRelayServer, type RelayServerConfig } from "./server";
import { tunnelRouter } from "./tunnel/index";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { broadcast } from "../ws/index";
import { getAllModels } from "../proxy/router";

export const relayApiRouter = new Hono();
export const relayProxyRouter = new Hono();

// Mount cloudflared tunnel sub-router
relayApiRouter.route("/tunnel", tunnelRouter);

// ─── Settings Helpers ────────────────────────────────────────────────────────

const RELAY_SETTINGS_PREFIX = "relay_";

async function getRelaySetting(key: string): Promise<string | null> {
  const fullKey = `${RELAY_SETTINGS_PREFIX}${key}`;
  const [row] = await db.select().from(settings).where(eq(settings.key, fullKey));
  return row?.value ?? null;
}

async function setRelaySetting(key: string, value: string): Promise<void> {
  const fullKey = `${RELAY_SETTINGS_PREFIX}${key}`;
  const existing = await db.select().from(settings).where(eq(settings.key, fullKey));
  if (existing.length > 0) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, fullKey));
  } else {
    await db.insert(settings).values({ key: fullKey, value });
  }
}

async function getRelayConfig(): Promise<{
  mode: string;
  serverUrl: string;
  secret: string;
  peerName: string;
  publicBaseUrl: string;
  maxTunnels: number;
  autoStart: boolean;
}> {
  return {
    mode: (await getRelaySetting("mode")) || config.relayMode || "disabled",
    serverUrl: (await getRelaySetting("server_url")) || config.relayServerUrl || "",
    secret: (await getRelaySetting("secret")) || config.relaySecret || "",
    peerName: (await getRelaySetting("peer_name")) || config.relayPeerName || "",
    publicBaseUrl: (await getRelaySetting("public_base_url")) || config.relayPublicBaseUrl || "",
    maxTunnels: Number((await getRelaySetting("max_tunnels")) || config.relayMaxTunnels || 50),
    autoStart: ((await getRelaySetting("auto_start")) || config.relayAutoStart || "false") === "true",
  };
}

// ─── Management API (/api/relay) ─────────────────────────────────────────────

/** GET /api/relay - Get relay status and config */
relayApiRouter.get("/", async (c) => {
  const cfg = await getRelayConfig();
  const client = getRelayClient();
  const server = getRelayServer();

  return c.json({
    config: {
      mode: cfg.mode,
      serverUrl: cfg.serverUrl,
      secret: cfg.secret ? "***" : "",
      peerName: cfg.peerName,
      publicBaseUrl: cfg.publicBaseUrl,
      maxTunnels: cfg.maxTunnels,
      autoStart: cfg.autoStart,
    },
    client: client?.getStatus() || null,
    server: server?.getStatus() || null,
  });
});

/** PUT /api/relay/config - Update relay configuration */
relayApiRouter.put("/config", async (c) => {
  const body = await c.req.json<{
    mode?: string;
    serverUrl?: string;
    secret?: string;
    peerName?: string;
    publicBaseUrl?: string;
    maxTunnels?: number;
    autoStart?: boolean;
  }>();

  if (body.mode !== undefined) {
    if (!["disabled", "client", "server", "both"].includes(body.mode)) {
      return c.json({ error: "mode must be: disabled, client, server, or both" }, 400);
    }
    await setRelaySetting("mode", body.mode);
  }
  if (body.serverUrl !== undefined) await setRelaySetting("server_url", body.serverUrl);
  if (body.secret !== undefined) await setRelaySetting("secret", body.secret);
  if (body.peerName !== undefined) await setRelaySetting("peer_name", body.peerName);
  if (body.publicBaseUrl !== undefined) await setRelaySetting("public_base_url", body.publicBaseUrl);
  if (body.maxTunnels !== undefined) await setRelaySetting("max_tunnels", String(body.maxTunnels));
  if (body.autoStart !== undefined) await setRelaySetting("auto_start", String(body.autoStart));

  const cfg = await getRelayConfig();
  broadcast({ type: "relay_config_updated", data: cfg });

  return c.json({ success: true, config: cfg });
});

/** POST /api/relay/start - Start relay (client or server based on mode) */
relayApiRouter.post("/start", async (c) => {
  const cfg = await getRelayConfig();

  if (cfg.mode === "disabled") {
    return c.json({ error: "Relay mode is disabled. Set mode to 'client', 'server', or 'both' first." }, 400);
  }

  if (!cfg.secret) {
    return c.json({ error: "Relay secret is not configured" }, 400);
  }

  const results: { client?: any; server?: any } = {};

  // Start client mode
  if (cfg.mode === "client" || cfg.mode === "both") {
    if (!cfg.serverUrl) {
      return c.json({ error: "Relay server URL is required for client mode" }, 400);
    }

    const models = getAllModels().map((m) => m.id);
    const clientCfg: RelayClientConfig = {
      serverUrl: cfg.serverUrl,
      secret: cfg.secret,
      peerName: cfg.peerName || `etteum-pool@${config.port}`,
      models,
      reconnect: true,
    };

    startRelayClient(clientCfg);
    results.client = "started";
  }

  // Start server mode
  if (cfg.mode === "server" || cfg.mode === "both") {
    const serverCfg: RelayServerConfig = {
      secret: cfg.secret,
      port: config.port,
      maxTunnels: cfg.maxTunnels,
      publicBaseUrl: cfg.publicBaseUrl || `http://localhost:${config.port}`,
    };

    startRelayServer(serverCfg);
    results.server = "started";
  }

  return c.json({ success: true, ...results });
});

/** POST /api/relay/stop - Stop relay */
relayApiRouter.post("/stop", async (c) => {
  stopRelayClient();
  stopRelayServer();
  return c.json({ success: true, message: "Relay stopped" });
});

/** POST /api/relay/client/start - Start only the relay client */
relayApiRouter.post("/client/start", async (c) => {
  const body = await c.req.json<{ serverUrl?: string; secret?: string; peerName?: string }>().catch(() => ({} as { serverUrl?: string; secret?: string; peerName?: string }));
  const cfg = await getRelayConfig();

  const serverUrl = body.serverUrl || cfg.serverUrl;
  const secret = body.secret || cfg.secret;

  if (!serverUrl) return c.json({ error: "serverUrl is required" }, 400);
  if (!secret) return c.json({ error: "secret is required" }, 400);

  const models = getAllModels().map((m) => m.id);
  const clientCfg: RelayClientConfig = {
    serverUrl,
    secret,
    peerName: body.peerName || cfg.peerName || `etteum-pool@${config.port}`,
    models,
    reconnect: true,
  };

  startRelayClient(clientCfg);
  return c.json({ success: true, message: "Relay client started" });
});

/** POST /api/relay/client/stop - Stop only the relay client */
relayApiRouter.post("/client/stop", async (_c) => {
  stopRelayClient();
  return _c.json({ success: true, message: "Relay client stopped" });
});

/** POST /api/relay/server/start - Start only the relay server */
relayApiRouter.post("/server/start", async (c) => {
  const body = await c.req.json<{ secret?: string; publicBaseUrl?: string; maxTunnels?: number }>().catch(() => ({} as { secret?: string; publicBaseUrl?: string; maxTunnels?: number }));
  const cfg = await getRelayConfig();

  const secret = body.secret || cfg.secret;
  if (!secret) return c.json({ error: "secret is required" }, 400);

  const serverCfg: RelayServerConfig = {
    secret,
    port: config.port,
    maxTunnels: body.maxTunnels || cfg.maxTunnels,
    publicBaseUrl: body.publicBaseUrl || cfg.publicBaseUrl || `http://localhost:${config.port}`,
  };

  startRelayServer(serverCfg);
  return c.json({ success: true, message: "Relay server started" });
});

/** POST /api/relay/server/stop - Stop only the relay server */
relayApiRouter.post("/server/stop", async (_c) => {
  stopRelayServer();
  return _c.json({ success: true, message: "Relay server stopped" });
});

/** GET /api/relay/tunnels - List connected tunnels (server mode) */
relayApiRouter.get("/tunnels", async (c) => {
  const server = getRelayServer();
  if (!server) {
    return c.json({ tunnels: [], message: "Relay server not running" });
  }
  const status = server.getStatus();
  return c.json({ tunnels: status.tunnels, totalRequests: status.totalRequests });
});

// ─── Tunnel HTTP Proxy (/relay/:tunnelId/*) ──────────────────────────────────

/**
 * Forward requests to connected tunnels.
 * URL pattern: /relay/:tunnelId/v1/chat/completions
 *              /relay/:tunnelId/v1/messages
 *              /relay/:tunnelId/v1/models
 *              /relay/auto/v1/... (auto-route to first available tunnel)
 */
relayProxyRouter.all("/:tunnelId/*", async (c) => {
  const server = getRelayServer();
  if (!server) {
    return c.json(
      { error: { message: "Relay server not running", type: "relay_error" } },
      503
    );
  }

  const tunnelId = c.req.param("tunnelId");
  const fullPath = c.req.path;

  // Extract the path after /relay/:tunnelId
  const pathPrefix = `/relay/${tunnelId}`;
  const forwardPath = fullPath.slice(pathPrefix.length) || "/";

  // "auto" means auto-route to any available tunnel
  const targetTunnelId = tunnelId === "auto" ? null : tunnelId;

  try {
    const response = await server.forwardRequest(targetTunnelId, c.req.raw, forwardPath);
    return response;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: { message: `Relay error: ${errorMsg}`, type: "relay_error" } },
      502
    );
  }
});

// ─── Auto-Start ──────────────────────────────────────────────────────────────

/**
 * Auto-start relay based on saved config.
 * Called during server boot.
 */
export async function autoStartRelay(): Promise<void> {
  try {
    const cfg = await getRelayConfig();

    if (!cfg.autoStart || cfg.mode === "disabled") {
      console.log("[Relay] Auto-start disabled or mode=disabled, skipping");
      return;
    }

    if (!cfg.secret) {
      console.log("[Relay] No secret configured, skipping auto-start");
      return;
    }

    console.log(`[Relay] Auto-starting in ${cfg.mode} mode...`);

    if (cfg.mode === "client" || cfg.mode === "both") {
      if (cfg.serverUrl) {
        const models = getAllModels().map((m) => m.id);
        startRelayClient({
          serverUrl: cfg.serverUrl,
          secret: cfg.secret,
          peerName: cfg.peerName || `etteum-pool@${config.port}`,
          models,
          reconnect: true,
        });
      } else {
        console.warn("[Relay] Client mode requires serverUrl, skipping client");
      }
    }

    if (cfg.mode === "server" || cfg.mode === "both") {
      startRelayServer({
        secret: cfg.secret,
        port: config.port,
        maxTunnels: cfg.maxTunnels,
        publicBaseUrl: cfg.publicBaseUrl || `http://localhost:${config.port}`,
      });
    }
  } catch (err) {
    console.error("[Relay] Auto-start failed:", err);
  }
}

// ─── WebSocket Upgrade Handler ───────────────────────────────────────────────

/**
 * Check if a request is a relay tunnel WebSocket upgrade.
 * Used by the main server to route WS upgrades to the relay server.
 */
export function isRelayTunnelUpgrade(req: Request): boolean {
  const url = new URL(req.url);
  return url.pathname === "/relay/tunnel" &&
    req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Get the relay server's WebSocket handler for Bun.serve.
 */
export function getRelayWebSocketHandler() {
  const server = getRelayServer();
  return server?.getWebSocketHandler() || null;
}
