/**
 * Etteum Pool — Cloudflare Worker Edge Relay
 *
 * Edge relay that proxies all requests to your pool backend.
 * Supports streaming (SSE), all HTTP methods, passes through headers.
 *
 * Deploy:
 *   1. `cd relay-edge/cloudflare-worker`
 *   2. `npx wrangler deploy`
 *   3. Set secrets: `npx wrangler secret put POOL_URL`
 *   4. Optionally: `npx wrangler secret put RELAY_KEY`
 *
 * Usage:
 *   Point Cursor/CLI to: https://your-relay.workers.dev/v1
 *
 * Free tier: 100K requests/day, 10ms CPU per request
 */

export interface Env {
  POOL_URL: string;
  RELAY_KEY?: string;
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding",
  "upgrade", "proxy-connection", "te", "trailer",
]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
          "access-control-allow-headers": "Authorization, Content-Type, x-api-key, x-relay-key, anthropic-version",
          "access-control-max-age": "86400",
        },
      });
    }

    const POOL_URL = env.POOL_URL || "";
    if (!POOL_URL) {
      return json({ error: "POOL_URL not configured" }, 503);
    }

    // Optional relay-level auth
    if (env.RELAY_KEY) {
      const relayAuth = req.headers.get("x-relay-key");
      if (relayAuth !== env.RELAY_KEY) {
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
      respHeaders.set("x-relay", "etteum-cf-worker");

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
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}
