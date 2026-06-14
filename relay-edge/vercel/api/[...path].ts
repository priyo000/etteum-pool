/**
 * Etteum Pool — Vercel Edge Relay
 *
 * Catch-all edge function that proxies ALL requests to your pool backend.
 * Supports streaming (SSE), all HTTP methods, and passes through headers.
 *
 * Deploy:
 *   1. Set env var POOL_URL = your pool URL (cloudflared or direct)
 *   2. Optionally set RELAY_KEY for an extra auth layer
 *   3. `cd relay-edge/vercel && vercel deploy`
 *
 * Usage:
 *   Point Cursor/CLI to: https://your-relay.vercel.app/v1
 */

export const config = { runtime: "edge" };

const POOL_URL = process.env.POOL_URL || "";
const RELAY_KEY = process.env.RELAY_KEY || ""; // optional extra auth

export default async function handler(req: Request): Promise<Response> {
  if (!POOL_URL) {
    return json({ error: "POOL_URL not configured" }, 503);
  }

  // Optional relay-level auth (separate from pool API key)
  if (RELAY_KEY) {
    const relayAuth = req.headers.get("x-relay-key");
    if (relayAuth !== RELAY_KEY) {
      return json({ error: "Invalid relay key" }, 403);
    }
  }

  // Build target URL: strip Vercel's /api prefix if present, keep the rest
  const url = new URL(req.url);
  let path = url.pathname;
  // Vercel routes /api/[...path] so strip /api prefix
  if (path.startsWith("/api")) path = path.slice(4);
  const target = `${POOL_URL.replace(/\/$/, "")}${path}${url.search}`;

  // Forward headers (strip hop-by-hop)
  const headers = new Headers();
  const HOP_BY_HOP = new Set([
    "connection", "keep-alive", "transfer-encoding",
    "upgrade", "proxy-connection", "te", "trailer",
  ]);
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
      // @ts-ignore — Vercel edge supports duplex
      duplex: req.method !== "GET" && req.method !== "HEAD" ? "half" : undefined,
    });

    // Build response headers
    const respHeaders = new Headers();
    upstream.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) {
        respHeaders.set(k, v);
      }
    });
    respHeaders.set("x-relay", "etteum-vercel");

    // Stream the response body through
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
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
