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

// import.meta.url.pathname encodes spaces as %20 on Windows, which breaks
// Bun.file / Bun.spawn. Decode it back and strip leading slash on Windows.
const _rootUrl = new URL("..", import.meta.url);
let root = decodeURIComponent(_rootUrl.pathname);
// On Windows, URL.pathname returns "/C:/..." but Bun expects "C:/..."
if (process.platform === "win32" && root.startsWith("/") && root.length > 2 && root.charAt(2) === ":") {
  root = root.slice(1);
}
const dashboardDir = `${root}/dashboard`;
const dashboardDist = `${dashboardDir}/dist/index.html`;
const skipBuild = process.argv.includes("--skip-build");

const port = process.env.PORT || "1930";
const dashboardPort = process.env.DASHBOARD_PORT || "1931";

// Resolve bun executable — process.execPath may fail to spawn on Windows
// when launched via Start-Process with redirected IO (PATH not inherited).
const bunExe = (() => {
  const exe = process.execPath;
  if (exe && exe !== "bun") return exe;
  // Fallback: try common install locations
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    `${home}/.bun/bin/bun.exe`,
    `${home}/.bun/bin/bun`,
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  ];
  for (const c of candidates) {
    try {
      Bun.file(c).size; // sync stat-like check
      return c;
    } catch {}
  }
  return "bun"; // last resort: rely on PATH
})();

async function buildDashboard() {
  const distExists = await Bun.file(dashboardDist).exists();

  if (distExists) {
    console.log("[production] Dashboard already built, skipping.");
    return;
  }

  console.log("[production] Building dashboard...");
  const proc = Bun.spawn([bunExe, "run", "build"], {
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

await buildDashboard();

console.log(`
${"\x1b[36m"}  _____ _   _                       ${"\x1b[0m"}
${"\x1b[36m"} | ____| |_| |_ ___ _   _ _ __ ___   ${"\x1b[0m"}
${"\x1b[36m"} |  _| | __| __/ _ \\ | | | '_ \` _ \\  ${"\x1b[0m"}
${"\x1b[36m"} | |___| |_| ||  __/ |_| | | | | | | ${"\x1b[0m"}
${"\x1b[36m"} |_____|\\__|\\__\\___|\\__,_|_| |_| |_| ${"\x1b[0m"}

  ${"\x1b[33m"}⚡ PRODUCTION MODE${"\x1b[0m"}
  ${"\x1b[2m"}─────────────────────────────────────${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} Backend    ${"\x1b[36m"}http://localhost:${port}${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} Dashboard  ${"\x1b[36m"}http://localhost:${dashboardPort}${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} API Key    ${"\x1b[33m"}${process.env.API_KEY || "pool-proxy-secret-key"}${"\x1b[0m"}
  ${"\x1b[2m"}─────────────────────────────────────${"\x1b[0m"}
`);

// Start backend
const backend = Bun.spawn([bunExe, "src/index.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    PORT: port,
    NODE_ENV: "production",
    SUPPRESS_BANNER: "1",
  },
});

// Start dashboard static server
const dashboard = Bun.spawn([bunExe, "run", "scripts/serve-dashboard.ts"], {
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
