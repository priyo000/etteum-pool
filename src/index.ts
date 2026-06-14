import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config";
import { runMigrations } from "./db/migrate";
import { apiRouter } from "./api/index";
import { authRouter } from "./auth/index";
import { proxyRouter } from "./proxy/index";
import { relayApiRouter, relayProxyRouter, autoStartRelay, isRelayTunnelUpgrade, getRelayWebSocketHandler } from "./relay/index";
import { websocketHandler, getClientCount } from "./ws/index";
import { isValidApiKey } from "./api/keys";
import { autoWarmupScheduler } from "./auth/warmup-scheduler";
import { db } from "./db/index";
import { filterRules } from "./db/schema";
import { sql } from "drizzle-orm";
import { PUDIDIL_FILTERS } from "./proxy/filters";
import { loadFilterCache } from "./proxy/filter-cache";
import { ensureModelMappingTable, seedModelMappings, loadModelMappingCache } from "./proxy/model-mapping";
import { refreshByokModels } from "./proxy/providers/registry";

// Run database migrations on startup
await runMigrations();

// Seed filter rules from PUDIDIL_FILTERS if table is empty (first boot only)
try {
  const [row] = await db.select({ count: sql<number>`COUNT(*)` }).from(filterRules);
  if (Number(row?.count || 0) === 0) {
    await db.insert(filterRules).values(
      PUDIDIL_FILTERS.map((r, i) => ({
        ruleId: r.id,
        pattern: r.pattern,
        replacement: r.replacement,
        isActive: r.is_active,
        isRegex: r.is_regex,
        sortOrder: i,
      }))
    );
    console.log(`[DB] Seeded ${PUDIDIL_FILTERS.length} filter rules`);
  }
  await loadFilterCache();
} catch (e) {
  console.error("[DB] Filter rules seed/load skipped:", e instanceof Error ? e.message : e);
}

// Ensure model_mappings table exists (idempotent), seed Claude Code templates
// on first boot, then load the in-memory cache used by the proxy hot path.
try {
  ensureModelMappingTable();
  await seedModelMappings();
  await loadModelMappingCache();
} catch (e) {
  console.error("[DB] Model mapping init skipped:", e instanceof Error ? e.message : e);
}

// Pre-warm BYOK provider cache so ownsModel() works from the first request
try {
  console.log("[BYOK] Warming up cache...");
  await refreshByokModels();
  console.log("[BYOK] Cache warmed up successfully");
} catch (e) {
  console.error("[BYOK] Cache warm-up skipped:", e instanceof Error ? e.message : e);
}

// Start auto-warmup scheduler (reads settings from DB)
await autoWarmupScheduler.start();

// Auto-start relay proxy if configured
await autoStartRelay();

// Create Hono app
const app = new Hono();

// Middleware
app.use("*", cors());
app.use("*", logger());

// API Key authentication middleware for proxy endpoints
app.use("/v1/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const xApiKey = c.req.header("x-api-key");
  const token = authHeader?.replace("Bearer ", "") || xApiKey;

  if (!token) {
    return c.json(
      { error: { message: "Missing Authorization header", type: "auth_error" } },
      401
    );
  }

  if (!(await isValidApiKey(token))) {
    return c.json(
      { error: { message: "Invalid API key", type: "auth_error" } },
      401
    );
  }

  await next();
});

// API Key authentication for relay proxy endpoints (forwarded to tunneled pools)
app.use("/relay/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const xApiKey = c.req.header("x-api-key");
  const token = authHeader?.replace("Bearer ", "") || xApiKey;

  if (!token) {
    return c.json(
      { error: { message: "Missing Authorization header", type: "auth_error" } },
      401
    );
  }

  if (!(await isValidApiKey(token))) {
    return c.json(
      { error: { message: "Invalid API key", type: "auth_error" } },
      401
    );
  }

  await next();
});

// API Key authentication for management API
app.use("/api/*", async (c, next) => {
  // Allow health check, info, and key validation without auth
  if (c.req.path === "/api/health" || c.req.path === "/api/info" || c.req.path === "/api/keys/test") {
    await next();
    return;
  }

  const authHeader = c.req.header("Authorization");
  const apiKeyQuery = c.req.query("api_key");
  const token = authHeader?.replace("Bearer ", "") || apiKeyQuery;

  if (!token || !(await isValidApiKey(token))) {
    return c.json(
      { error: { message: "Unauthorized", type: "auth_error" } },
      401
    );
  }

  await next();
});

// Mount routes
app.route("/", proxyRouter); // /v1/chat/completions, /v1/models
app.route("/api", apiRouter); // /api/accounts, /api/settings, /api/stats
app.route("/api/auth", authRouter); // /api/auth/login, /api/auth/queue
app.route("/api/relay", relayApiRouter); // /api/relay/* (management)
app.route("/relay", relayProxyRouter); // /relay/:tunnelId/* (tunnel HTTP proxy)

// Health/info endpoint (moved from / to /api/health)
app.get("/api/info", (c) => {
  return c.json({
    name: "pool-proxy",
    version: "1.0.0",
    status: "running",
    endpoints: {
      proxy: "/v1/chat/completions",
      anthropic: "/v1/messages",
      models: "/v1/models",
      accounts: "/api/accounts",
      stats: "/api/stats",
      settings: "/api/settings",
      auth: "/api/auth",
      health: "/api/health",
      websocket: "/ws",
    },
    wsClients: getClientCount(),
  });
});

// Serve dashboard static files (SPA fallback)
const dashboardDist = decodeURIComponent(new URL("../dashboard/dist", import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1"));
const dashboardIndex = `${dashboardDist}/index.html`;

const staticMimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// Start server with WebSocket support
const server = Bun.serve({
  port: config.port,
  idleTimeout: 255,
  async fetch(req, server) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: { type: "dashboard" } } as any);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Handle relay tunnel WebSocket upgrade
    if (isRelayTunnelUpgrade(req)) {
      const upgraded = server.upgrade(req, { data: { type: "relay_tunnel", authenticated: false } } as any);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Try Hono routes first (API, proxy, etc.)
    const response = await app.fetch(req, { ip: server.requestIP(req) });
    if (response.status !== 404) return response;

    // Fallback: serve dashboard static files
    const pathname = url.pathname;
    const filePath = `${dashboardDist}${pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const ext = pathname.slice(pathname.lastIndexOf("."));
      return new Response(file, {
        headers: { "Content-Type": staticMimeTypes[ext] || "application/octet-stream" },
      });
    }

    // SPA fallback: serve index.html for non-file routes
    const indexFile = Bun.file(dashboardIndex);
    if (await indexFile.exists()) {
      return new Response(indexFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const data = ws.data as any;
      if (data?.type === "relay_tunnel") {
        const handler = getRelayWebSocketHandler();
        if (handler) handler.open(ws as any);
      } else {
        websocketHandler.open(ws as any);
      }
    },
    message(ws, message) {
      const data = ws.data as any;
      if (data?.type === "relay_tunnel") {
        const handler = getRelayWebSocketHandler();
        if (handler) handler.message(ws as any, message);
      } else {
        websocketHandler.message(ws as any, message);
      }
    },
    close(ws) {
      const data = ws.data as any;
      if (data?.type === "relay_tunnel") {
        const handler = getRelayWebSocketHandler();
        if (handler) handler.close(ws as any);
      } else {
        websocketHandler.close(ws as any);
      }
    },
    drain(ws) {
      const data = ws.data as any;
      if (data?.type !== "relay_tunnel") {
        websocketHandler.drain(ws as any);
      }
    },
  },
});

if (!process.env.SUPPRESS_BANNER) {
  console.log(`
${"\x1b[36m"}  _____ _   _                       ${"\x1b[0m"}
${"\x1b[36m"} | ____| |_| |_ ___ _   _ _ __ ___   ${"\x1b[0m"}
${"\x1b[36m"} |  _| | __| __/ _ \\ | | | '_ \` _ \\  ${"\x1b[0m"}
${"\x1b[36m"} | |___| |_| ||  __/ |_| | | | | | | ${"\x1b[0m"}
${"\x1b[36m"} |_____|\\__|\\__\\___|\\__,_|_| |_| |_| ${"\x1b[0m"}

  ${"\x1b[2m"}────────────────────────────────────────────────────${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} HTTP       ${"\x1b[36m"}http://localhost:${config.port}${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} WebSocket  ${"\x1b[36m"}ws://localhost:${config.port}/ws${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} Dashboard  ${"\x1b[36m"}http://localhost:${config.dashboardPort}${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} Database   ${"\x1b[37m"}SQLite${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} API Key    ${"\x1b[33m"}${config.apiKey}${"\x1b[0m"}
  ${"\x1b[2m"}────────────────────────────────────────────────────${"\x1b[0m"}

  ${"\x1b[2m"}Endpoints${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} POST ${"\x1b[37m"}/v1/chat/completions${"\x1b[0m"}   ${"\x1b[2m"}proxy${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} POST ${"\x1b[37m"}/v1/messages${"\x1b[0m"}            ${"\x1b[2m"}anthropic${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} GET  ${"\x1b[37m"}/v1/models${"\x1b[0m"}              ${"\x1b[2m"}models${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} GET  ${"\x1b[37m"}/api/accounts${"\x1b[0m"}           ${"\x1b[2m"}management${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} GET  ${"\x1b[37m"}/api/stats${"\x1b[0m"}              ${"\x1b[2m"}statistics${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} WS   ${"\x1b[37m"}/ws${"\x1b[0m"}                     ${"\x1b[2m"}real-time${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} WS   ${"\x1b[37m"}/relay/tunnel${"\x1b[0m"}           ${"\x1b[2m"}ws relay${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} ALL  ${"\x1b[37m"}/relay/:id/v1/*${"\x1b[0m"}         ${"\x1b[2m"}relay proxy${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} POST ${"\x1b[37m"}/api/relay/tunnel/*${"\x1b[0m"}     ${"\x1b[2m"}cloudflared${"\x1b[0m"}
  ${"\x1b[2m"}────────────────────────────────────────────────────${"\x1b[0m"}
`);
}

export default server;
