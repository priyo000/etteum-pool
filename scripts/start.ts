#!/usr/bin/env bun
/**
 * Development start script (watch-mode).
 *
 * Spawns:
 *   - Backend with `bun --hot src/index.ts` for in-process module hot-swap.
 *     WebSocket clients, the BYOK cache, the login queue, and any other
 *     in-memory state survive backend code changes.
 *   - Vite dev server in `dashboard/` for instant React HMR.
 *
 * Production (build-once) lives in `scripts/production.ts`.
 *
 * Triggered by:
 *   etteum start --watch     (or: --dev, -w)
 *   bun run dev
 *   bun scripts/start.ts
 */

// import.meta.url.pathname encodes spaces as %20 on Windows and adds a
// leading slash before the drive letter. Decode + strip both.
const _rawRoot = new URL("..", import.meta.url).pathname;
let root = decodeURIComponent(_rawRoot);
if (
  process.platform === "win32" &&
  root.startsWith("/") &&
  root.length > 2 &&
  root.charAt(2) === ":"
) {
  root = root.slice(1);
}

const port = process.env.PORT || "1930";
const dashboardPort = process.env.DASHBOARD_PORT || "1931";

// Resolve bun executable — process.execPath is most reliable when launched
// from `npm run` / `bunx` / nested spawn chains where PATH might be missing.
const bunExe = (() => {
  const exe = process.execPath;
  if (exe && exe !== "bun") return exe;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    `${home}/.bun/bin/bun.exe`,
    `${home}/.bun/bin/bun`,
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  ];
  for (const c of candidates) {
    try {
      Bun.file(c).size;
      return c;
    } catch {}
  }
  return "bun";
})();

let shuttingDown = false;
const children: ReturnType<typeof Bun.spawn>[] = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(); } catch {}
  }
  setTimeout(() => process.exit(code), 200).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function streamWithPrefix(stream: ReadableStream<Uint8Array>, prefix: string) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim().length > 0) console.log(`${prefix} ${line}`);
    }
  }
  if (buffer.trim().length > 0) console.log(`${prefix} ${buffer}`);
}

function spawnLogged(
  name: string,
  command: string[],
  cwd = root,
  extraEnv: Record<string, string> = {},
) {
  const proc = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      PORT: port,
      DASHBOARD_PORT: dashboardPort,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const prefix = `[${name}]`;
  void streamWithPrefix(proc.stdout, prefix);
  void streamWithPrefix(proc.stderr, prefix);

  proc.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`${prefix} exited with code ${code}`);
      shutdown(code || 1);
    }
  });

  return proc;
}

console.log(`
${"\x1b[36m"}  _____ _   _                       ${"\x1b[0m"}
${"\x1b[36m"} | ____| |_| |_ ___ _   _ _ __ ___   ${"\x1b[0m"}
${"\x1b[36m"} |  _| | __| __/ _ \\ | | | '_ \` _ \\  ${"\x1b[0m"}
${"\x1b[36m"} | |___| |_| ||  __/ |_| | | | | | | ${"\x1b[0m"}
${"\x1b[36m"} |_____|\\__|\\__\\___|\\__,_|_| |_| |_| ${"\x1b[0m"}

  ${"\x1b[33m"}🔥 DEV MODE — hot-reload enabled${"\x1b[0m"}
  ${"\x1b[2m"}─────────────────────────────────────${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} Backend     ${"\x1b[36m"}http://localhost:${port}${"\x1b[0m"} ${"\x1b[2m"}(bun --hot)${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} Dashboard   ${"\x1b[36m"}http://localhost:${dashboardPort}${"\x1b[0m"} ${"\x1b[2m"}(vite HMR)${"\x1b[0m"}
  ${"\x1b[32m"}▸${"\x1b[0m"} API Key     ${"\x1b[33m"}${process.env.API_KEY || "pool-proxy-secret-key"}${"\x1b[0m"}
  ${"\x1b[2m"}─────────────────────────────────────${"\x1b[0m"}
  ${"\x1b[2m"}Edit src/** → backend hot-swaps in place${"\x1b[0m"}
  ${"\x1b[2m"}Edit dashboard/src/** → Vite HMR refresh${"\x1b[0m"}
`);

// 1. Backend with hot-reload — module re-evaluation in-process.
//    Crucially, this preserves WS connections, BYOK cache, login queue, etc.
children.push(
  spawnLogged("backend", [bunExe, "--hot", "src/index.ts"], root, {
    NODE_ENV: "development",
    SUPPRESS_BANNER: "1",
  }),
);

// 2. Vite dev server — React HMR + automatic API/WS proxy to the backend.
children.push(
  spawnLogged(
    "dashboard",
    [bunExe, "x", "vite", "--host", "0.0.0.0", "--port", dashboardPort],
    `${root}/dashboard`,
  ),
);

await new Promise(() => {});
