#!/usr/bin/env bun
/**
 * Production start script.
 *
 * 1. Builds dashboard (if needed)
 * 2. Runs backend (serves API + dashboard static files on single port)
 *
 * Usage:
 *   bun run production
 *   bun run scripts/production.ts
 *   bun run scripts/production.ts --skip-build  (skip dashboard rebuild)
 */

const root = new URL("..", import.meta.url).pathname;
const dashboardDir = `${root}/dashboard`;
const dashboardDist = `${dashboardDir}/dist/index.html`;
const skipBuild = process.argv.includes("--skip-build");

async function buildDashboard() {
  const distExists = await Bun.file(dashboardDist).exists();

  if (skipBuild && distExists) {
    console.log("[production] Skipping dashboard build (--skip-build)");
    return;
  }

  if (!skipBuild || !distExists) {
    console.log("[production] Building dashboard...");
    const proc = Bun.spawn(["bun", "run", "build"], {
      cwd: dashboardDir,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        VITE_BACKEND_PORT: process.env.PORT || "1630",
      },
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error("[production] Dashboard build failed!");
      process.exit(1);
    }
    console.log("[production] Dashboard built successfully.");
  }
}

async function startBackend() {
  console.log("[production] Starting backend...");
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
  });

  process.on("SIGINT", () => proc.kill());
  process.on("SIGTERM", () => proc.kill());

  const code = await proc.exited;
  process.exit(code);
}

await buildDashboard();
await startBackend();
