/**
 * Tunnel API Routes
 *
 * Provides management endpoints for the cloudflared tunnel + edge relay deploy:
 *   GET  /api/relay/tunnel           - Get tunnel status
 *   POST /api/relay/tunnel/enable    - Enable tunnel (download + spawn)
 *   POST /api/relay/tunnel/disable   - Disable tunnel (kill process)
 *   GET  /api/relay/tunnel/download  - Download progress
 *   GET  /api/relay/tunnel/deploy    - Get one-click deploy URLs for edge relays
 *   POST /api/relay/tunnel/edge      - Save deployed edge relay URL
 *   GET  /api/relay/tunnel/edge      - Get saved edge relay config
 */
import { Hono } from "hono";
import { enableTunnel, disableTunnel, getStatus, isTunnelEnabled } from "./manager";
import { getDownloadStatus } from "./cloudflared";
import { config } from "../../config";
import { db } from "../../db/index";
import { settings } from "../../db/schema";
import { eq } from "drizzle-orm";

export const tunnelRouter = new Hono();

// ─── Tunnel Management ───────────────────────────────────────────────────────

/** GET / - Tunnel status + edge relay info */
tunnelRouter.get("/", async (c) => {
  const status = getStatus();
  const edge = await getEdgeConfig();
  return c.json({ ...status, edge });
});

/** POST /enable - Enable the tunnel */
tunnelRouter.post("/enable", async (c) => {
  const body = await c.req.json<{ port?: number }>().catch(() => ({} as { port?: number }));
  const port = body.port || config.port;

  if (isTunnelEnabled()) {
    return c.json({ success: false, error: "Tunnel already enabled", status: getStatus() }, 409);
  }

  const result = await enableTunnel(port);
  if (result.success) {
    return c.json({ success: true, tunnelUrl: result.tunnelUrl, status: getStatus() });
  }
  return c.json({ success: false, error: result.error, status: getStatus() }, 500);
});

/** POST /disable - Disable the tunnel */
tunnelRouter.post("/disable", (c) => {
  disableTunnel();
  return c.json({ success: true, status: getStatus() });
});

/** GET /download - Download status (for progress tracking) */
tunnelRouter.get("/download", (c) => {
  return c.json(getDownloadStatus());
});

// ─── One-Click Deploy URLs ───────────────────────────────────────────────────

/**
 * GET /deploy - Generate one-click deploy URLs for edge relay platforms.
 * Frontend shows these as buttons: "Deploy to Vercel" / "Deploy to Deno" / etc.
 * Pre-fills POOL_URL with the current tunnel URL.
 */
tunnelRouter.get("/deploy", async (c) => {
  const status = getStatus();
  const poolUrl = status.tunnelUrl || `http://localhost:${config.port}`;

  // GitHub repo URL for the relay-edge templates
  // Users should fork/push relay-edge/ to their own repo, or use a template repo
  const repoUrl = c.req.query("repo") || "https://github.com/user/etteum-relay";

  const deployUrls = {
    vercel: buildVercelDeployUrl(poolUrl, repoUrl),
    deno: buildDenoDeployUrl(poolUrl),
    cloudflareWorkers: buildCFWorkerDeployUrl(poolUrl),
  };

  return c.json({
    poolUrl,
    tunnelActive: status.running,
    deployUrls,
    // Also return raw template code for "paste & deploy" approach
    templates: {
      vercel: `/api/relay/tunnel/template/vercel`,
      deno: `/api/relay/tunnel/template/deno`,
      cloudflareWorker: `/api/relay/tunnel/template/cf-worker`,
    },
  });
});

/**
 * GET /template/:platform - Return the relay template code with POOL_URL pre-filled.
 * Frontend can show this in a code block for copy-paste deploy.
 */
tunnelRouter.get("/template/:platform", (c) => {
  const platform = c.req.param("platform");
  const status = getStatus();
  const poolUrl = status.tunnelUrl || `http://localhost:${config.port}`;

  switch (platform) {
    case "vercel":
      return c.text(getVercelTemplate(poolUrl));
    case "deno":
      return c.text(getDenoTemplate(poolUrl));
    case "cf-worker":
      return c.text(getCFWorkerTemplate(poolUrl));
    default:
      return c.json({ error: "Unknown platform. Use: vercel, deno, cf-worker" }, 400);
  }
});

// ─── Edge Relay Config (save deployed URL) ───────────────────────────────────

/** POST /edge - Save the deployed edge relay URL */
tunnelRouter.post("/edge", async (c) => {
  const body = await c.req.json<{
    platform?: string;
    url?: string;
    relayKey?: string;
  }>();

  if (!body.url) return c.json({ error: "url is required" }, 400);

  await saveSetting("edge_platform", body.platform || "unknown");
  await saveSetting("edge_url", body.url);
  if (body.relayKey) await saveSetting("edge_relay_key", body.relayKey);

  return c.json({ success: true, edge: await getEdgeConfig() });
});

/** GET /edge - Get saved edge relay config */
tunnelRouter.get("/edge", async (c) => {
  return c.json(await getEdgeConfig());
});

/** DELETE /edge - Remove saved edge relay config */
tunnelRouter.delete("/edge", async (c) => {
  await deleteSetting("edge_platform");
  await deleteSetting("edge_url");
  await deleteSetting("edge_relay_key");
  return c.json({ success: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getEdgeConfig() {
  return {
    platform: await getSetting("edge_platform"),
    url: await getSetting("edge_url"),
    hasRelayKey: !!(await getSetting("edge_relay_key")),
  };
}

async function getSetting(key: string): Promise<string | null> {
  const fullKey = `tunnel_${key}`;
  const [row] = await db.select().from(settings).where(eq(settings.key, fullKey));
  return row?.value ?? null;
}

async function saveSetting(key: string, value: string): Promise<void> {
  const fullKey = `tunnel_${key}`;
  const existing = await db.select().from(settings).where(eq(settings.key, fullKey));
  if (existing.length > 0) {
    await db.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.key, fullKey));
  } else {
    await db.insert(settings).values({ key: fullKey, value });
  }
}

async function deleteSetting(key: string): Promise<void> {
  const fullKey = `tunnel_${key}`;
  await db.delete(settings).where(eq(settings.key, fullKey));
}

// ─── Deploy URL Builders ─────────────────────────────────────────────────────

function buildVercelDeployUrl(poolUrl: string, repoUrl: string): string {
  const params = new URLSearchParams({
    "repository-url": repoUrl,
    env: "POOL_URL,RELAY_KEY",
    envDescription: "POOL_URL: Your etteum-pool tunnel URL. RELAY_KEY: Optional auth key.",
    envLink: "https://github.com/user/etteum-pool#relay-edge",
    "project-name": "etteum-relay",
    "root-directory": "relay-edge/vercel",
  });
  // Pre-fill POOL_URL value
  params.set("env[POOL_URL]", poolUrl);
  return `https://vercel.com/new/clone?${params.toString()}`;
}

function buildDenoDeployUrl(poolUrl: string): string {
  // Deno Deploy doesn't have a one-click deploy button like Vercel,
  // but we can link to the playground with pre-filled code
  return `https://dash.deno.com/new?env=POOL_URL:${encodeURIComponent(poolUrl)}`;
}

function buildCFWorkerDeployUrl(poolUrl: string): string {
  // CF Workers deploy button (requires wrangler, but we can link to the quick edit)
  return `https://deploy.workers.cloudflare.com/?url=https://github.com/user/etteum-pool/tree/main/relay-edge/cloudflare-worker`;
}

// ─── Template Generators (pre-filled code for copy-paste) ────────────────────

function getVercelTemplate(poolUrl: string): string {
  return `// Etteum Pool — Vercel Edge Relay
// Deploy: paste this as api/[...path].ts in a new Vercel project

export const config = { runtime: "edge" };

const POOL_URL = process.env.POOL_URL || "${poolUrl}";
const RELAY_KEY = process.env.RELAY_KEY || "";

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (!POOL_URL) return json({ error: "POOL_URL not configured" }, 503);
  if (RELAY_KEY && req.headers.get("x-relay-key") !== RELAY_KEY) {
    return json({ error: "Invalid relay key" }, 403);
  }

  const url = new URL(req.url);
  let path = url.pathname;
  if (path.startsWith("/api")) path = path.slice(4);
  const target = POOL_URL.replace(/\\/$/, "") + path + url.search;

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!isHopByHop(k) && k !== "host") headers.set(k, v);
  });

  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      duplex: "half",
    } as any);

    const rh = new Headers();
    res.headers.forEach((v, k) => { if (!isHopByHop(k)) rh.set(k, v); });
    rh.set("x-relay", "etteum-vercel");
    Object.entries(corsHeaders()).forEach(([k, v]) => rh.set(k, v));

    return new Response(res.body, { status: res.status, headers: rh });
  } catch (e: any) {
    return json({ error: { message: "Relay: " + e.message, type: "relay_error" } }, 502);
  }
}

function isHopByHop(k: string) {
  return ["connection","keep-alive","transfer-encoding","upgrade","te","trailer"].includes(k.toLowerCase());
}
function corsHeaders() {
  return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "Authorization,Content-Type,x-api-key,x-relay-key,anthropic-version" };
}
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...corsHeaders() } });
}
`;
}

function getDenoTemplate(poolUrl: string): string {
  return `// Etteum Pool — Deno Deploy Edge Relay
// Deploy: deployctl deploy --project=my-relay relay.ts
// Or paste in Deno Deploy Playground

const POOL_URL = Deno.env.get("POOL_URL") || "${poolUrl}";
const RELAY_KEY = Deno.env.get("RELAY_KEY") || "";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }
  if (!POOL_URL) return json({ error: "POOL_URL not configured" }, 503);
  if (RELAY_KEY && req.headers.get("x-relay-key") !== RELAY_KEY) {
    return json({ error: "Invalid relay key" }, 403);
  }

  const url = new URL(req.url);
  const target = POOL_URL.replace(/\\/$/, "") + url.pathname + url.search;

  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!hop(k) && k !== "host") headers.set(k, v);
  });

  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    const rh = new Headers();
    res.headers.forEach((v, k) => { if (!hop(k)) rh.set(k, v); });
    rh.set("x-relay", "etteum-deno");
    Object.entries(cors()).forEach(([k, v]) => rh.set(k, v));

    return new Response(res.body, { status: res.status, headers: rh });
  } catch (e: any) {
    return json({ error: { message: "Relay: " + e.message, type: "relay_error" } }, 502);
  }
});

function hop(k: string) { return ["connection","keep-alive","transfer-encoding","upgrade"].includes(k.toLowerCase()); }
function cors() { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "Authorization,Content-Type,x-api-key,x-relay-key" }; }
function json(d: unknown, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", ...cors() } }); }
`;
}

function getCFWorkerTemplate(poolUrl: string): string {
  return `// Etteum Pool — Cloudflare Worker Edge Relay
// Deploy: npx wrangler deploy (after setting POOL_URL secret)
// Or paste in CF Workers Quick Edit dashboard

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    const POOL_URL = env.POOL_URL || "${poolUrl}";
    if (!POOL_URL) return json({ error: "POOL_URL not configured" }, 503);
    if (env.RELAY_KEY && req.headers.get("x-relay-key") !== env.RELAY_KEY) {
      return json({ error: "Invalid relay key" }, 403);
    }

    const url = new URL(req.url);
    const target = POOL_URL.replace(/\\/$/, "") + url.pathname + url.search;

    const headers = new Headers();
    req.headers.forEach((v, k) => {
      if (!hop(k) && k !== "host") headers.set(k, v);
    });

    try {
      const res = await fetch(target, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
      });

      const rh = new Headers();
      res.headers.forEach((v, k) => { if (!hop(k)) rh.set(k, v); });
      rh.set("x-relay", "etteum-cf");
      Object.entries(cors()).forEach(([k, v]) => rh.set(k, v));

      return new Response(res.body, { status: res.status, headers: rh });
    } catch (e) {
      return json({ error: { message: "Relay: " + e.message, type: "relay_error" } }, 502);
    }
  }
};

function hop(k) { return ["connection","keep-alive","transfer-encoding","upgrade"].includes(k.toLowerCase()); }
function cors() { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "Authorization,Content-Type,x-api-key,x-relay-key" }; }
function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", ...cors() } }); }
`;
}

