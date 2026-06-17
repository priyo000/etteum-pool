#!/usr/bin/env bun
/**
 * Lightweight static file server for dashboard/dist.
 * No Vite, no HMR, no dev overhead. Just serves pre-built files.
 *
 * Usage:
 *   bun run scripts/serve-dashboard.ts
 *
 * Env:
 *   DASHBOARD_PORT (default: 1931)
 */

import { fileURLToPath } from "node:url";

const port = Number(process.env.DASHBOARD_PORT) || 1931;
const backendPort = Number(process.env.PORT) || 1930;
const backendUrl = `http://localhost:${backendPort}`;
const distDir = fileURLToPath(new URL("../dashboard/dist", import.meta.url));
const indexFile = `${distDir}/index.html`;

// Check if dashboard is built
if (!(await Bun.file(indexFile).exists())) {
  console.error("[dashboard] dashboard/dist not found. Run: cd dashboard && bun run build");
  process.exit(1);
}

// MIME types for common static assets
const mimeTypes: Record<string, string> = {
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

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return mimeTypes[ext] || "application/octet-stream";
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // Proxy API, v1, and WebSocket requests to backend
    if (pathname.startsWith("/v1/") || pathname.startsWith("/api/") || pathname === "/ws") {
      const target = `${backendUrl}${pathname}${url.search}`;
      try {
        const proxyHeaders = new Headers(req.headers);
        proxyHeaders.set("Host", `localhost:${backendPort}`);
        const proxyRes = await fetch(target, {
          method: req.method,
          headers: proxyHeaders,
          body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
          // @ts-ignore - duplex needed for streaming
          duplex: "half",
        });
        return new Response(proxyRes.body, {
          status: proxyRes.status,
          statusText: proxyRes.statusText,
          headers: proxyRes.headers,
        });
      } catch {
        return new Response(JSON.stringify({ error: "Backend unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Try to serve the exact file
    let filePath = `${distDir}${pathname}`;
    let file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": getMimeType(pathname) },
      });
    }

    // Try with /index.html appended (for directories)
    if (!pathname.includes(".")) {
      filePath = `${distDir}${pathname}/index.html`;
      file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // SPA fallback: serve index.html for any non-file route
    return new Response(Bun.file(indexFile), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`[dashboard] Serving production build on http://localhost:${port}`);
