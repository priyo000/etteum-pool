/**
 * Etteum Pool — Deno Deploy Edge Relay
 *
 * Single-file edge relay that proxies all requests to your pool backend.
 * Supports streaming (SSE), all HTTP methods, passes through headers.
 *
 * Deploy to Deno Deploy:
 *   1. Push this file to a GitHub repo (or use `deployctl`)
 *   2. Set env var POOL_URL = your pool URL
 *   3. Optionally set RELAY_KEY for extra auth
 *   4. Connect repo to dash.deno.com → New Project
 *
 * Or deploy via CLI:
 *   POOL_URL=https://xxx.trycloudflare.com deployctl deploy --project=my-relay relay.ts
 *
 * Usage:
 *   Point Cursor/CLI to: https://your-relay.deno.dev/v1
 *
 * Free tier: 100K requests/day, 100GB bandwidth/month
 */

const POOL_URL = Deno.env.get("POOL_URL") || "";
const RELAY_KEY = Deno.env.get("RELAY_KEY") || "";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding",
  "upgrade", "proxy-connection", "te", "trailer",
]);

Deno.serve({ port: 8000 }, async (req: Request): Promise<Response> => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, x-api-key, x-relay-key",
        "access-control-max-age": "86400",
      },
    });
  }

  if (!POOL_URL) {
    return json({ error: "POOL_URL not configured" }, 503);
  }

  // Optional relay-level auth
  if (RELAY_KEY) {
    const relayAuth = req.headers.get("x-relay-key");
    if (relayAuth !== RELAY_KEY) {
      return json({ error: "Invalid relay key" }, 403);
    }
  }

  // Build target URL
  const url = new URL(req.url);
  const target = `${POOL_URL.replace(/\/$/, "")}${url.pathname}${url.search}`;

  // Forward headers
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "host") {
      headers.set(k, v);
    }
  });

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
    });

    // Build response headers
    const respHeaders = new Headers();
    upstream.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) {
        respHeaders.set(k, v);
      }
    });
    respHeaders.set("access-control-allow-origin", "*");
    respHeaders.set("x-relay", "etteum-deno");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  } catch (err: any) {
    return json(
      { error: { message: `Relay error: ${err.message}`, type: "relay_error" } },
      502
    );
  }
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}
