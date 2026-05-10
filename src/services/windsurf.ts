import { config } from "../config";
import path from "path";

/**
 * WindsurfAPI Service Manager
 * Manages the lifecycle of the WindsurfAPI Node.js process (dwgx/WindsurfAPI).
 * WindsurfAPI handles gRPC/protobuf communication with Windsurf cloud,
 * exposing OpenAI-compatible endpoints that our provider forwards to.
 */

interface WindsurfServiceConfig {
  port: number;
  apiKey: string;
  dataDir: string;
  servicePath: string;
}

interface WindsurfHealthResponse {
  status: string;
  version?: string;
  uptime?: number;
  accounts?: {
    total?: number;
    active?: number;
    free?: number;
    pro?: number;
  };
}

let serviceProcess: ReturnType<typeof Bun.spawn> | null = null;
let serviceReady = false;
let startPromise: Promise<boolean> | null = null;

function getServiceConfig(): WindsurfServiceConfig {
  const projectRoot = path.resolve(import.meta.dir, "../..");
  return {
    port: config.windsurfApiPort,
    apiKey: config.windsurfApiKey,
    dataDir: path.join(projectRoot, "services/windsurf-api/data"),
    servicePath: path.join(projectRoot, "services/windsurf-api"),
  };
}

/**
 * Check if WindsurfAPI service is healthy
 */
export async function checkHealth(): Promise<WindsurfHealthResponse | null> {
  const cfg = getServiceConfig();
  try {
    const response = await fetch(`http://localhost:${cfg.port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return (await response.json()) as WindsurfHealthResponse;
  } catch {
    return null;
  }
}

/**
 * Start the WindsurfAPI service as a child process
 */
export async function startService(): Promise<boolean> {
  if (startPromise) return startPromise;

  startPromise = (async () => {
    const cfg = getServiceConfig();

    // Check if already running
    const health = await checkHealth();
    if (health) {
      console.log(
        `[WindsurfService] Already running on port ${cfg.port} (v${health.version || "unknown"}, ${health.accounts?.total || 0} accounts)`
      );
      serviceReady = true;
      return true;
    }

    // Check if service directory exists
    const serviceEntry = path.join(cfg.servicePath, "src/server.js");
    const exists = await Bun.file(serviceEntry).exists();
    if (!exists) {
      console.warn(
        `[WindsurfService] Not found at ${cfg.servicePath}. Clone it with: git clone https://github.com/dwgx/WindsurfAPI.git services/windsurf-api`
      );
      serviceReady = false;
      return false;
    }

    console.log(`[WindsurfService] Starting on port ${cfg.port}...`);

    try {
      serviceProcess = Bun.spawn(["node", "src/server.js"], {
        cwd: cfg.servicePath,
        env: {
          ...process.env,
          PORT: String(cfg.port),
          API_KEY: cfg.apiKey,
          DATA_DIR: cfg.dataDir,
          NODE_ENV: "production",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      // Wait for service to become ready (max 30s)
      const maxWait = 30_000;
      const pollInterval = 1000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        await new Promise((r) => setTimeout(r, pollInterval));
        const h = await checkHealth();
        if (h) {
          console.log(
            `[WindsurfService] Ready on port ${cfg.port} (took ${Date.now() - startTime}ms)`
          );
          serviceReady = true;
          return true;
        }
      }

      console.error(
        `[WindsurfService] Failed to start within ${maxWait / 1000}s`
      );
      await stopService();
      return false;
    } catch (error) {
      console.error(`[WindsurfService] Start error:`, error);
      return false;
    }
  })();

  const result = await startPromise;
  startPromise = null;
  return result;
}

/**
 * Stop the WindsurfAPI service
 */
export async function stopService(): Promise<void> {
  if (serviceProcess) {
    try {
      serviceProcess.kill();
      serviceProcess = null;
    } catch {
      // Already dead
    }
  }
  serviceReady = false;
}

/**
 * Check if service is ready to accept requests
 */
export function isReady(): boolean {
  return serviceReady;
}

/**
 * Get the base URL for the WindsurfAPI service
 */
export function getBaseUrl(): string {
  const cfg = getServiceConfig();
  return `http://localhost:${cfg.port}`;
}

/**
 * Get the API key for authenticating with WindsurfAPI
 */
export function getApiKey(): string {
  return getServiceConfig().apiKey;
}

/**
 * Add an account to WindsurfAPI via its /auth/login endpoint
 */
export async function addAccountToWindsurf(
  token: string,
  label?: string
): Promise<{ success: boolean; error?: string; account?: any }> {
  const cfg = getServiceConfig();
  try {
    const response = await fetch(
      `http://localhost:${cfg.port}/auth/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
        },
        body: JSON.stringify({ token, label }),
        signal: AbortSignal.timeout(30000),
      }
    );

    const data = await response.json() as any;
    if (!response.ok) {
      return {
        success: false,
        error: data?.error || data?.message || `HTTP ${response.status}`,
      };
    }
    return { success: true, account: data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get all accounts from WindsurfAPI
 */
export async function getWindsurfAccounts(): Promise<any[]> {
  const cfg = getServiceConfig();
  try {
    const response = await fetch(
      `http://localhost:${cfg.port}/auth/accounts`,
      {
        headers: { "x-api-key": cfg.apiKey },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!response.ok) return [];
    const data = await response.json() as any;
    return Array.isArray(data) ? data : data?.accounts || [];
  } catch {
    return [];
  }
}
