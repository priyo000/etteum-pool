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
  // Kiro Pro upgrade settings
  kiroProUpgrade: process.env.KIRO_PRO_UPGRADE === "true",
  billingAddress: JSON.parse(process.env.BILLING_ADDRESS || '{"name":"John Doe","country":"US","line1":"123 Main St","city":"New York","state":"NY","postal_code":"10001"}'),
  browserEngine: process.env.BROWSER_ENGINE || "camoufox",
  captchaService: process.env.CAPTCHA_SERVICE || "none",
  captchaApiKey: process.env.CAPTCHA_API_KEY || "",
  // Relay Proxy settings
  relayMode: process.env.RELAY_MODE || "disabled", // disabled | client | server | both
  relayServerUrl: process.env.RELAY_SERVER_URL || "", // ws(s)://relay-server.com/relay/tunnel
  relaySecret: process.env.RELAY_SECRET || "", // shared secret for tunnel auth
  relayPeerName: process.env.RELAY_PEER_NAME || "", // human-readable name for this pool
  relayPublicBaseUrl: process.env.RELAY_PUBLIC_BASE_URL || "", // public URL for relay server
  relayMaxTunnels: Number(process.env.RELAY_MAX_TUNNELS) || 50,
  relayAutoStart: process.env.RELAY_AUTO_START || "false",
  // Providers: kiro, kiro-pro, codebuddy, canva, codex, qoder
  providers: ["kiro", "kiro-pro", "codebuddy", "canva", "codex", "qoder"] as const,
} as const;

export type Config = typeof config;
export type Provider = (typeof config.providers)[number];
