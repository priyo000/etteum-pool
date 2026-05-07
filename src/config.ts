export const config = {
  port: Number(process.env.PORT) || 1630,
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 1631,
  apiKey: process.env.API_KEY || "pool-proxy-secret-key",
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/pool_proxy",
  authScriptPath:
    process.env.AUTH_SCRIPT_PATH ||
    "/home/priyo/.local/lib/enowxai/auth/login.py",
  pythonPath:
    process.env.PYTHON_PATH ||
    "/home/priyo/.local/lib/enowxai/auth/.venv/bin/python",
  proxyUrl: process.env.PROXY_URL || "",
  encryptionKey:
    process.env.ENCRYPTION_KEY || "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  headless: process.env.HEADLESS !== "false", // default true
  logBodyEnabled: process.env.POOLPROX_LOG_BODY_ENABLED !== "false",
  logBodyFull: process.env.POOLPROX_LOG_BODY_FULL === "true",
  logBodyMaxBytes: Number(process.env.POOLPROX_LOG_BODY_MAX_BYTES) || 65536,
  accountCacheTtlMs: Number(process.env.POOLPROX_ACCOUNT_CACHE_TTL_MS) || 3000,
  // Providers: kiro, codebuddy, canva
  providers: ["kiro", "codebuddy", "canva"] as const,
} as const;

export type Config = typeof config;
export type Provider = (typeof config.providers)[number];
