#!/usr/bin/env bun
/**
 * doctor.ts — Health diagnostic for Etteum Pool installation
 *
 * Run this any time something feels off. It validates every prerequisite,
 * config value, and runtime asset, then prints a remediation hint when
 * something is missing or broken.
 *
 *   bun scripts/doctor.ts           # human-readable report
 *   bun scripts/doctor.ts --json    # machine-readable
 *   bun scripts/doctor.ts --strict  # exit 1 on any warning (CI mode)
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

type Severity = "ok" | "warn" | "fail";
type Check = {
  name: string;
  severity: Severity;
  message: string;
  fix?: string;
};

const ROOT = resolve(import.meta.dir, "..");
const IS_WIN = platform() === "win32";
const checks: Check[] = [];

function pushOk(name: string, message: string) {
  checks.push({ name, severity: "ok", message });
}
function pushWarn(name: string, message: string, fix?: string) {
  checks.push({ name, severity: "warn", message, fix });
}
function pushFail(name: string, message: string, fix?: string) {
  checks.push({ name, severity: "fail", message, fix });
}

function which(cmd: string): string | null {
  const out = spawnSync(IS_WIN ? "where" : "command", IS_WIN ? [cmd] : ["-v", cmd], {
    encoding: "utf8",
    shell: true,
  });
  if (out.status === 0) return (out.stdout || "").trim().split(/\r?\n/)[0] || null;
  return null;
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function parseEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) {
      const k = m[1]!;
      out[k] = m[2] ?? "";
    }
  }
  return out;
}

// ── Checks ─────────────────────────────────────────────────────────────

function checkBun() {
  const path = which("bun");
  if (!path) {
    return pushFail(
      "Bun runtime",
      "bun not found on PATH",
      IS_WIN
        ? 'Reinstall: powershell -c "irm bun.sh/install.ps1 | iex"'
        : "Reinstall: curl -fsSL https://bun.sh/install | bash",
    );
  }
  const v = run("bun", ["--version"]);
  pushOk("Bun runtime", `${v.stdout.trim()} at ${path}`);
}

function checkPython() {
  const env = parseEnv(join(ROOT, ".env"));
  const venvPy = IS_WIN
    ? join(ROOT, "scripts", "auth", ".venv", "Scripts", "python.exe")
    : join(ROOT, "scripts", "auth", ".venv", "bin", "python");

  if (!existsSync(venvPy)) {
    return pushFail(
      "Python venv",
      `Missing: ${venvPy}`,
      "Re-run installer or: python3 -m venv scripts/auth/.venv && scripts/auth/.venv/bin/pip install -r scripts/auth/requirements.txt",
    );
  }
  const v = run(venvPy, ["--version"]);
  if (!v.ok) {
    return pushFail("Python venv", `Cannot execute ${venvPy}`, "Re-run installer to rebuild venv");
  }
  pushOk("Python venv", `${v.stdout.trim() || v.stderr.trim()} at ${venvPy}`);

  // PYTHON_PATH config sanity
  const cfgPath = (env.PYTHON_PATH || "").trim();
  if (cfgPath && !existsSync(cfgPath)) {
    pushWarn(
      "PYTHON_PATH config",
      `PYTHON_PATH=${cfgPath} does not exist`,
      "Clear it (auto-detect): set PYTHON_PATH= in .env",
    );
  }
}

function checkPyPackages() {
  const venvPy = IS_WIN
    ? join(ROOT, "scripts", "auth", ".venv", "Scripts", "python.exe")
    : join(ROOT, "scripts", "auth", ".venv", "bin", "python");
  if (!existsSync(venvPy)) return;
  const required = ["camoufox", "playwright", "aiohttp", "httpx", "cbor2", "pydantic"];
  for (const pkg of required) {
    const r = run(venvPy, ["-c", `import ${pkg}`]);
    if (!r.ok) {
      pushFail(
        `Python pkg: ${pkg}`,
        `Import failed`,
        `Run: scripts/auth/.venv/${IS_WIN ? "Scripts" : "bin"}/pip install -r scripts/auth/requirements.txt`,
      );
    } else {
      pushOk(`Python pkg: ${pkg}`, "import ok");
    }
  }
}

function checkBrowsers() {
  const venvPy = IS_WIN
    ? join(ROOT, "scripts", "auth", ".venv", "Scripts", "python.exe")
    : join(ROOT, "scripts", "auth", ".venv", "bin", "python");
  if (!existsSync(venvPy)) return;

  // Playwright Chromium
  const pw = run(venvPy, [
    "-c",
    "from playwright.sync_api import sync_playwright;\n"
    + "with sync_playwright() as p:\n"
    + "  print(p.chromium.executable_path)",
  ]);
  if (pw.ok && pw.stdout.trim() && existsSync(pw.stdout.trim())) {
    pushOk("Playwright Chromium", "installed");
  } else {
    pushFail(
      "Playwright Chromium",
      "Browser binary missing",
      `Run: ${IS_WIN ? "scripts\\auth\\.venv\\Scripts\\python.exe" : "scripts/auth/.venv/bin/python"} -m playwright install chromium`,
    );
  }

  // Camoufox
  const cf = run(venvPy, ["-c", "import camoufox.utils as u; print(u.installed_verstr() or '')"]);
  if (cf.ok && cf.stdout.trim()) {
    pushOk("Camoufox browser", `installed (${cf.stdout.trim()})`);
  } else {
    pushFail(
      "Camoufox browser",
      "Browser not fetched",
      `Run: ${IS_WIN ? "scripts\\auth\\.venv\\Scripts\\python.exe" : "scripts/auth/.venv/bin/python"} -m camoufox fetch`,
    );
  }
}

function checkDotenv() {
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) {
    return pushFail(".env", "Missing .env", "Copy from .env.example and re-run installer");
  }
  const env = parseEnv(envPath);
  const required = ["PORT", "DASHBOARD_PORT", "API_KEY", "DATABASE_PATH", "ENCRYPTION_KEY", "AUTH_SCRIPT_PATH", "AUTH_SCRIPT_CWD"];
  for (const k of required) {
    if (!(k in env) || !env[k]) {
      pushWarn(`.env: ${k}`, "missing or empty", "Copy from .env.example and re-run installer");
    }
  }
  if (env.ENCRYPTION_KEY === "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6") {
    pushFail(
      ".env: ENCRYPTION_KEY",
      "Still using the example placeholder key — tokens will not survive a re-encrypt",
      "Generate a new key: openssl rand -hex 16, replace ENCRYPTION_KEY in .env, then restart",
    );
  } else if (env.ENCRYPTION_KEY) {
    pushOk(".env: ENCRYPTION_KEY", "custom key set");
  }
  if (env.API_KEY === "pool-proxy-secret-key") {
    pushWarn(
      ".env: API_KEY",
      "Still default — anyone who guesses this can hit your proxy",
      "Set API_KEY in .env to a long random string",
    );
  }
}

function checkDashboardBuild() {
  const dist = join(ROOT, "dashboard", "dist", "index.html");
  if (!existsSync(dist)) {
    return pushFail(
      "Dashboard build",
      "dashboard/dist not found",
      "Run: cd dashboard && bun install && bun run build",
    );
  }
  const age = (Date.now() - statSync(dist).mtimeMs) / 1000 / 60 / 60 / 24;
  if (age > 30) pushWarn("Dashboard build", `Built ${age.toFixed(0)} days ago`, "Consider rebuilding: bun run build");
  else pushOk("Dashboard build", "present");
}

function checkNodeModules() {
  for (const dir of ["node_modules", "dashboard/node_modules"]) {
    if (!existsSync(join(ROOT, dir))) {
      pushFail(
        `${dir}`,
        "missing",
        dir.startsWith("dashboard") ? "Run: cd dashboard && bun install" : "Run: bun install",
      );
    } else {
      pushOk(`${dir}`, "present");
    }
  }
}

function checkDataDir() {
  const env = parseEnv(join(ROOT, ".env"));
  const dbPath = (env.DATABASE_PATH || "./data/poolprox3.db").replace(/^\.\//, "");
  const fullPath = resolve(ROOT, dbPath);
  if (!existsSync(fullPath)) {
    pushWarn("Database", `${dbPath} not found yet (will be created on first start)`, "Run: bun src/db/migrate.ts");
  } else {
    const sizeMb = (statSync(fullPath).size / 1024 / 1024).toFixed(2);
    pushOk("Database", `${dbPath} (${sizeMb} MB)`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const strict = args.includes("--strict");

checkBun();
checkPython();
checkPyPackages();
checkBrowsers();
checkDotenv();
checkNodeModules();
checkDashboardBuild();
checkDataDir();

const okCount = checks.filter((c) => c.severity === "ok").length;
const warnCount = checks.filter((c) => c.severity === "warn").length;
const failCount = checks.filter((c) => c.severity === "fail").length;

if (wantJson) {
  console.log(JSON.stringify({ ok: okCount, warn: warnCount, fail: failCount, checks }, null, 2));
} else {
  const ICON = { ok: "✓", warn: "!", fail: "✗" } as const;
  const COLOR = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m" } as const;
  const RESET = "\x1b[0m";

  console.log(`\n\x1b[1m🩺 Etteum Pool — Doctor Report\x1b[0m\n`);
  for (const c of checks) {
    console.log(`  ${COLOR[c.severity]}${ICON[c.severity]}${RESET}  \x1b[1m${c.name}\x1b[0m — ${c.message}`);
    if (c.fix && c.severity !== "ok") {
      console.log(`     \x1b[2m→ ${c.fix}\x1b[0m`);
    }
  }
  console.log(
    `\n  \x1b[32m${okCount} ok\x1b[0m   \x1b[33m${warnCount} warn\x1b[0m   \x1b[31m${failCount} fail\x1b[0m\n`,
  );
  if (failCount === 0 && warnCount === 0) {
    console.log("  \x1b[32m\x1b[1m✓ All checks passed — you're ready to roll.\x1b[0m\n");
  } else if (failCount === 0) {
    console.log("  \x1b[33mInstallation works but has warnings. Read them above.\x1b[0m\n");
  } else {
    console.log("  \x1b[31m\x1b[1m✗ Installation has errors. Run remediation hints above.\x1b[0m\n");
  }
}

if (failCount > 0) process.exit(1);
if (strict && warnCount > 0) process.exit(2);
