#!/usr/bin/env bun
/**
 * Production start script.
 *
 * 1. Builds dashboard (if needed)
 * 2. Starts backend (API + proxy on PORT)
 * 3. Starts dashboard static server (on DASHBOARD_PORT)
 *
 * Both are lightweight Bun processes. No Vite dev server.
 *
 * Usage:
 *   bun run production
 *   bun run scripts/production.ts
 *   bun run scripts/production.ts --skip-build
 */

import { resolve } from "path";

const root = resolve(import.meta.dir, "..");
const dashboardDir = resolve(root, "dashboard");
const dashboardDist = resolve(dashboardDir, "dist", "index.html");
const skipBuild = process.argv.includes("--skip-build");

const port = process.env.PORT || "1930";
const dashboardPort = process.env.DASHBOARD_PORT || "1931";

async function buildDashboard() {
  const distExists = await Bun.file(dashboardDist).exists();

  if (skipBuild && distExists) {
    console.log("[production] Skipping dashboard build (--skip-build)");
    return;
  }

  if (!skipBuild || !distExists) {
    console.log("[production] Building dashboard...");
    const proc = Bun.spawn([process.execPath, "run", "build"], {
      cwd: dashboardDir,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        VITE_BACKEND_PORT: port,
      },
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error("[production] Dashboard build failed!");
      process.exit(1);
    }
    console.log("[production] Dashboard built successfully.\n");
  }
}

await buildDashboard();

console.log(`╔══════════════════════════════════════╗`);
console.log(`║   Pool Proxy — Production Mode       ║`);
console.log(`╠══════════════════════════════════════╣`);
console.log(`║  Backend:   http://localhost:${port}    ║`);
console.log(`║  Dashboard: http://localhost:${dashboardPort}    ║`);
console.log(`╚══════════════════════════════════════╝\n`);

// Start backend
const backend = Bun.spawn([process.execPath, "src/index.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    PORT: port,
    NODE_ENV: "production",
  },
});

// Start dashboard static server
const dashboard = Bun.spawn([process.execPath, "run", "scripts/serve-dashboard.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    DASHBOARD_PORT: dashboardPort,
    NODE_ENV: "production",
  },
});

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  backend.kill();
  dashboard.kill();
  setTimeout(() => process.exit(code), 300).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// If either process dies, shut down both
backend.exited.then((code) => {
  if (!shuttingDown) {
    console.error(`[production] Backend exited with code ${code}`);
    shutdown(code || 1);
  }
});

dashboard.exited.then((code) => {
  if (!shuttingDown) {
    console.error(`[production] Dashboard exited with code ${code}`);
    shutdown(code || 1);
  }
});

await new Promise(() => {});
