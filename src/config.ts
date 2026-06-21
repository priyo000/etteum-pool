import path from "path";

const projectRoot = path.resolve(import.meta.dir, "..");

export const config = {
  port: Number(process.env.PORT) || 1930,
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 1931,
  apiKey: process.env.API_KEY || "pool-proxy-secret-key",
  databasePath: process.env.DATABASE_PATH || path.join(projectRoot, "data/poolprox3.db"),
  authScriptPath:
    process.env.AUTH_SCRIPT_PATH ||
    path.join(projectRoot, "scripts/auth/login.py"),
  pythonPath:
    process.env.PYTHON_PATH ||
    path.join(
      projectRoot,
      "scripts/auth/.venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    ),
  authScriptCwd:
    process.env.AUTH_SCRIPT_CWD ||
    path.join(projectRoot, "scripts/auth"),
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
  // ── Provider tunables ────────────────────────────────────────────────
  // Defaults are tuned to handle the full task spectrum: short Q&A,
  // multi-minute reasoning, AND multi-hour agentic loops (e.g. autonomous
  // build → test → fix → repeat sessions that legitimately run for hours).
  // The principle: timeouts are SAFETY NETS for stuck infra, not caps on
  // Kiro Pro upgrade settings
  kiroProUpgrade: process.env.KIRO_PRO_UPGRADE === "true",
  billingAddress: JSON.parse(process.env.BILLING_ADDRESS || '{"name":"John Doe","country":"US","line1":"123 Main St","city":"New York","state":"NY","postal_code":"10001"}'),
  browserEngine: process.env.BROWSER_ENGINE || "camoufox",
  captchaService: process.env.CAPTCHA_SERVICE || "none",
  captchaApiKey: process.env.CAPTCHA_API_KEY || "",
  // Providers: kiro, kiro-pro, codebuddy, codebuddy-china, canva, codex, qoder, gitlab-duo, gumloop
  providers: ["kiro", "kiro-pro", "codebuddy", "codebuddy-china", "canva", "codex", "qoder", "gitlab-duo", "gumloop"] as const,

  // ── Gumloop ───────────────────────────────────────────────────────────────
  // Firebase project agenthub-dev (public web API key, exposed in Gumloop JS bundle).
  // Used to refresh the user's Firebase ID token after Google OAuth login so the
  // provider can register a client-generated UUID API key via POST /secret.
  // Set via env var GUMLOOP_FIREBASE_API_KEY (see .env.example).
  gumloopFirebaseApiKey: process.env.GUMLOOP_FIREBASE_API_KEY || "",
  gumloopApiBase: process.env.GUMLOOP_API_BASE || "https://api.gumloop.com",
  gumloopChatBase: process.env.GUMLOOP_CHAT_BASE || "https://ws.gumloop.com",
} as const;

export type Config = typeof config;
export type Provider = (typeof config.providers)[number];
