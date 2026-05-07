import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config";
import { runMigrations } from "./db/migrate";
import { apiRouter } from "./api/index";
import { authRouter } from "./auth/index";
import { proxyRouter } from "./proxy/index";
import { websocketHandler, getClientCount } from "./ws/index";
import { isValidApiKey } from "./api/keys";

// Run database migrations on startup
await runMigrations();

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

// API Key authentication for management API
app.use("/api/*", async (c, next) => {
  // Allow health check without auth
  if (c.req.path === "/api/health") {
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

// --- Production: serve dashboard static files from dashboard/dist ---
const dashboardDistPath = new URL("../dashboard/dist", import.meta.url).pathname;
const dashboardIndexPath = `${dashboardDistPath}/index.html`;
const hasDashboardBuild = await Bun.file(dashboardIndexPath).exists();

if (hasDashboardBuild) {
  // Serve static assets (js, css, images, etc.)
  app.get("/assets/*", async (c) => {
    const filePath = `${dashboardDistPath}${c.req.path}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }
    return c.notFound();
  });

  // Serve other static files (favicon, manifest, etc.)
  app.get("/vite.svg", async (c) => {
    const file = Bun.file(`${dashboardDistPath}/vite.svg`);
    if (await file.exists()) return new Response(file);
    return c.notFound();
  });

  // SPA fallback: serve index.html for non-API/non-WS routes
  app.get("*", async (c) => {
    const path = c.req.path;
    // Skip API, proxy, and websocket paths
    if (path.startsWith("/v1") || path.startsWith("/api") || path === "/ws") {
      return c.notFound();
    }
    return new Response(Bun.file(dashboardIndexPath), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  console.log(`[Dashboard] Serving production build from dashboard/dist`);
} else {
  // No dashboard build — show API info at root
  app.get("/", (c) => {
    return c.json({
      name: "pool-proxy",
      version: "1.0.0",
      status: "running",
      dashboard: "Not built. Run: cd dashboard && bun run build",
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
}

// Start server with WebSocket support
const server = Bun.serve({
  port: config.port,
  idleTimeout: 255,
  fetch(req, server) {
    // Handle WebSocket upgrade
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, { data: {} });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Handle Hono routes
    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: websocketHandler,
});

console.log(`
╔══════════════════════════════════════════════════╗
║           🔄 Pool Proxy Server                   ║
╠══════════════════════════════════════════════════╣
║  HTTP:      http://localhost:${config.port}               ║
║  WebSocket: ws://localhost:${config.port}/ws              ║
║  Database:  PostgreSQL                           ║
║  Dashboard: ${hasDashboardBuild ? `http://localhost:${config.port}` : "not built"}               ║
╠══════════════════════════════════════════════════╣
║  Endpoints:                                      ║
║    POST /v1/chat/completions  (proxy)            ║
║    POST /v1/messages          (Anthropic)        ║
║    GET  /v1/models            (models)           ║
║    GET  /api/accounts         (management)       ║
║    GET  /api/stats            (statistics)       ║
║    WS   /ws                   (real-time)        ║
╚══════════════════════════════════════════════════╝
`);

export default server;
