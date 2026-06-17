import path from "path";

const projectRoot = path.resolve(import.meta.dir, "..");

function resolveProjectPath(envValue: string | undefined, fallback: string): string {
  const raw = envValue || fallback;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(projectRoot, raw);
}

export const config = {
  port: Number(process.env.PORT) || 1930,
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 1931,
  apiKey: process.env.API_KEY || "pool-proxy-secret-key",
  databasePath: resolveProjectPath(process.env.DATABASE_PATH, "data/poolprox3.db"),
  authScriptPath: resolveProjectPath(process.env.AUTH_SCRIPT_PATH, "scripts/auth/login.py"),
  pythonPath: resolveProjectPath(
    process.env.PYTHON_PATH,
    process.platform === "win32"
      ? "scripts/auth/.venv/Scripts/python.exe"
      : "scripts/auth/.venv/bin/python",
  ),
  authScriptCwd: resolveProjectPath(process.env.AUTH_SCRIPT_CWD, "scripts/auth"),
  proxyUrl: process.env.PROXY_URL || "",
  encryptionKey:
    process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  headless: process.env.HEADLESS !== "false", // default true
  logBodyEnabled: process.env.POOLPROX_LOG_BODY_ENABLED !== "false",
  logBodyFull: process.env.POOLPROX_LOG_BODY_FULL !== "false",
  logBodyRedact: process.env.POOLPROX_LOG_BODY_REDACT === "true",
  logBodyMaxBytes: Number(process.env.POOLPROX_LOG_BODY_MAX_BYTES) || 65536,
  accountCacheTtlMs: Number(process.env.POOLPROX_ACCOUNT_CACHE_TTL_MS) || 3000,
  authProcessTimeoutMs: Number(process.env.POOLPROX_AUTH_PROCESS_TIMEOUT_MS) || 10 * 60 * 1000,
  providerRequestTimeoutMs: Number(process.env.POOLPROX_PROVIDER_REQUEST_TIMEOUT_MS) || 120_000,
  providerQuotaTimeoutMs: Number(process.env.POOLPROX_PROVIDER_QUOTA_TIMEOUT_MS) || 15_000,
  // Kiro Pro upgrade settings
  kiroProUpgrade: process.env.KIRO_PRO_UPGRADE === "true",
  billingAddress: JSON.parse(process.env.BILLING_ADDRESS || '{"name":"John Doe","country":"US","line1":"123 Main St","city":"New York","state":"NY","postal_code":"10001"}'),
  browserEngine: process.env.BROWSER_ENGINE || "camoufox",
  captchaService: process.env.CAPTCHA_SERVICE || "none",
  captchaApiKey: process.env.CAPTCHA_API_KEY || "",
  // Providers: kiro, kiro-pro, codebuddy, canva, codex, qoder
  providers: ["kiro", "kiro-pro", "codebuddy", "canva", "codex", "qoder"] as const,
} as const;

export type Config = typeof config;
export type Provider = (typeof config.providers)[number];
