import { config } from "../config";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { Account } from "../db/schema";
import { addAuthLog } from "./logs";
import { providers } from "../proxy/router";

/**
 * Progress event emitted by the Python login script (one per line)
 */
interface ScriptProgressEvent {
  type: "progress";
  provider: string;
  step: string;
  message: string;
}

/**
 * Error event emitted by the Python login script
 */
interface ScriptErrorEvent {
  type: "error";
  provider: string;
  error: string;
  code?: string;
}

/**
 * Single provider result within the final result
 */
interface ProviderResult {
  success: boolean;
  provider: string;
  credentials?: Record<string, string>;
  quota?: {
    limit?: number;
    remaining?: number;
    remaining_credits?: number;
    total_credits?: number;
    current_usage?: number;
    [key: string]: unknown;
  };
  error?: string;
}

/**
 * Final result event from login.py
 * Format: {"type":"result","kiro":{...},"codebuddy":{...},"canva":{...}}
 */
interface ScriptResultEvent {
  type: "result";
  kiro: ProviderResult;
  codebuddy: ProviderResult;
  canva: ProviderResult;
  [key: string]: unknown;
}

type ScriptEvent = ScriptProgressEvent | ScriptErrorEvent | ScriptResultEvent;

export interface LoginResult {
  success: boolean;
  tokens?: Record<string, string>;
  quota?: Record<string, unknown>;
  error?: string;
}

export interface LoginOptions {
  headless?: boolean;
}

type QuotaSnapshot = { limit: number; remaining: number; used?: number; resetAt?: Date | string | null };

function firstNumeric(...values: unknown[]): number {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function parseQuota(quota: Record<string, unknown>) {
  return {
    limit: firstNumeric(
      quota.total_credits,
      quota.limit,
      quota.credit_capacity_size,
      quota.credit_total_dosage
    ),
    remaining: firstNumeric(
      quota.remaining_credits,
      quota.remaining,
      quota.credit_capacity_remain
    ),
  };
}

async function fetchProviderQuota(account: Account, tokens: Record<string, string>): Promise<QuotaSnapshot | null> {
  const provider = providers[account.provider as keyof typeof providers];
  if (!provider?.fetchQuota) return null;

  const quotaAccount = { ...account, tokens };
  const result = await provider.fetchQuota(quotaAccount);
  return result.success && result.quota ? result.quota : null;
}

/**
 * Parse multi-line JSON output from login.py
 * Each line is a separate JSON object (progress, error, or result)
 */
function parseScriptOutput(stdout: string): ScriptEvent[] {
  const events: ScriptEvent[] = [];
  const lines = stdout.trim().split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(trimmed) as ScriptEvent;
      events.push(parsed);
    } catch {
      // Skip non-JSON lines
    }
  }

  return events;
}

function parseScriptLine(line: string): ScriptEvent | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;

  try {
    return JSON.parse(trimmed) as ScriptEvent;
  } catch {
    return null;
  }
}

async function readTextStream(
  stream: ReadableStream<Uint8Array>,
  onLine?: (line: string) => void
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buffer += chunk;

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) onLine?.(line);
  }

  const rest = decoder.decode();
  if (rest) {
    full += rest;
    buffer += rest;
  }
  if (buffer.trim()) onLine?.(buffer);

  return full;
}

function emitProgressLog(account: Account, event: ScriptProgressEvent) {
  const log = addAuthLog({
    type: "login_progress",
    accountId: account.id,
    email: account.email,
    provider: event.provider,
    step: event.step,
    message: event.message,
  });

  broadcast({
    type: "login_progress",
    data: {
      logId: log.id,
      id: account.id,
      accountId: account.id,
      email: account.email,
      provider: event.provider,
      step: event.step,
      message: event.message,
      timestamp: log.timestamp,
    },
  });
}

/**
 * Extract the final result event from script output
 */
function extractResult(events: ScriptEvent[]): ScriptResultEvent | null {
  // Find the last "result" type event
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "result") {
      return events[i] as ScriptResultEvent;
    }
  }
  return null;
}

/**
 * Run the Python login script for a SINGLE provider.
 * Uses ENOWX_ALLOWED_PROVIDERS env to filter to just the needed provider.
 *
 * The enowxai login.py script accepts:
 *   --email <email> --password <password>
 *
 * And uses env vars:
 *   ENOWX_ALLOWED_PROVIDERS=kiro,codebuddy,canva (comma-separated)
 *   BATCHER_ENABLE_CAMOUFOX=true (for browser automation)
 *   BATCHER_CAMOUFOX_HEADLESS=true
 *   BATCHER_PROXY_URL=<proxy>
 *   BATCHER_CONCURRENT=1
 */
export async function loginAccount(account: Account, options: LoginOptions = {}): Promise<LoginResult> {
  const password = decrypt(account.password);
  const provider = account.provider; // kiro | codebuddy | canva
  const headless = options.headless ?? config.headless;

  try {
    const startLog = addAuthLog({
      type: "login_progress",
      accountId: account.id,
      email: account.email,
      provider,
      step: "starting",
      message: `Starting ${provider} login for ${account.email}...`,
    });
    broadcast({
      type: "login_progress",
      data: {
        logId: startLog.id,
        id: account.id,
        email: account.email,
        provider,
        step: "starting",
        message: `Starting ${provider} login for ${account.email}...`,
      },
    });

    const proc = Bun.spawn(
      [
        config.pythonPath,
        config.authScriptPath,
        "--email",
        account.email,
        "--password",
        password,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // Only login the specific provider we need
          ENOWX_ALLOWED_PROVIDERS: provider,
          // Ensure Python progress JSON is flushed line-by-line for live dashboard logs
          PYTHONUNBUFFERED: "1",
          // Enable camoufox browser automation
          BATCHER_ENABLE_CAMOUFOX: "true",
          BATCHER_CAMOUFOX_HEADLESS: headless ? "true" : "false",
          // Proxy configuration
          BATCHER_PROXY_URL: config.proxyUrl || "",
          HTTP_PROXY: config.proxyUrl || "",
          HTTPS_PROXY: config.proxyUrl || "",
          // Run single provider at a time
          BATCHER_CONCURRENT: "1",
          BATCHER_PRIORITY: provider,
        },
        cwd: "/home/priyo/.local/lib/enowxai/auth",
      }
    );

    const streamedEvents: ScriptEvent[] = [];
    const stdoutPromise = readTextStream(proc.stdout, (line) => {
      const event = parseScriptLine(line);
      if (!event) return;

      streamedEvents.push(event);
      if (event.type === "progress") {
        emitProgressLog(account, event);
      } else if (event.type === "error") {
        const log = addAuthLog({
          type: "login_failed",
          accountId: account.id,
          email: account.email,
          provider: event.provider || provider,
          error: event.error,
          message: event.error,
        });
        broadcast({
          type: "login_failed",
          data: { logId: log.id, id: account.id, accountId: account.id, email: account.email, provider: event.provider || provider, error: event.error, timestamp: log.timestamp },
        });
      }
    });
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    // Parse all events from stdout. Most are already streamed, but this fallback
    // preserves compatibility if the script buffers output until exit.
    const events = streamedEvents.length > 0 ? streamedEvents : parseScriptOutput(stdout);
    if (streamedEvents.length === 0) {
      for (const event of events) {
        if (event.type === "progress") emitProgressLog(account, event);
      }
    }

    // Check for non-zero exit code
    if (exitCode !== 0 && events.length === 0) {
      const errorMsg =
        stderr.trim() || `Login script exited with code ${exitCode}`;
      await markAccountError(account.id, errorMsg);
      const log = addAuthLog({
        type: "login_failed",
        accountId: account.id,
        email: account.email,
        provider,
        error: errorMsg,
        message: errorMsg,
      });
      broadcast({
        type: "login_failed",
        data: { logId: log.id, id: account.id, email: account.email, provider, error: errorMsg },
      });
      return { success: false, error: errorMsg };
    }

    // Extract the final result
    const result = extractResult(events);
    if (!result) {
      const errorMsg = "No result received from login script";
      await markAccountError(account.id, errorMsg);
      const log = addAuthLog({
        type: "login_failed",
        accountId: account.id,
        email: account.email,
        provider,
        error: errorMsg,
        message: errorMsg,
      });
      broadcast({
        type: "login_failed",
        data: { logId: log.id, id: account.id, email: account.email, provider, error: errorMsg },
      });
      return { success: false, error: errorMsg };
    }

    // Get the specific provider's result
    const providerResult = result[provider] as ProviderResult | undefined;
    if (!providerResult) {
      const errorMsg = `Provider ${provider} not found in result`;
      await markAccountError(account.id, errorMsg);
      return { success: false, error: errorMsg };
    }

    if (!providerResult.success) {
      const errorMsg = providerResult.error || "Login failed";
      await markAccountError(account.id, errorMsg);
      const log = addAuthLog({
        type: "login_failed",
        accountId: account.id,
        email: account.email,
        provider,
        error: errorMsg,
        message: errorMsg,
      });
      broadcast({
        type: "login_failed",
        data: { logId: log.id, id: account.id, email: account.email, provider, error: errorMsg },
      });
      return { success: false, error: errorMsg };
    }

    // Success! Store credentials and quota
    const credentials = providerResult.credentials || {};
    const quota = providerResult.quota || {};

    let { limit: quotaLimit, remaining: quotaRemaining } = parseQuota(quota);
    let quotaMetadata: Record<string, unknown> = quota;

    if ((quotaLimit <= 0 || quotaRemaining <= 0) && account.provider === "codebuddy") {
      try {
        const syncedQuota = await fetchProviderQuota(account, credentials as Record<string, string>);
        if (syncedQuota) {
          quotaLimit = syncedQuota.limit;
          quotaRemaining = syncedQuota.remaining;
          quotaMetadata = { ...quota, syncedQuota, quotaSource: "provider.fetchQuota" };
        }
      } catch (error) {
        quotaMetadata = {
          ...quota,
          quotaSyncError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    await db
      .update(accounts)
      .set({
        status: "active",
        tokens: credentials as unknown,
        quotaLimit,
        quotaRemaining,
        lastLoginAt: new Date(),
        errorMessage: null,
        metadata: quotaMetadata as unknown,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, account.id));

    const successLog = addAuthLog({
      type: "login_success",
      accountId: account.id,
      email: account.email,
      provider,
      step: "success",
      message: `Login success for ${provider}/${account.email}`,
      data: { quotaLimit, quotaRemaining },
    });

    broadcast({
      type: "login_success",
      data: {
        logId: successLog.id,
        id: account.id,
        email: account.email,
        provider,
        quotaLimit,
        quotaRemaining,
      },
    });

    return { success: true, tokens: credentials, quota };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await markAccountError(account.id, errorMsg);
    const log = addAuthLog({
      type: "login_failed",
      accountId: account.id,
      email: account.email,
      provider,
      error: errorMsg,
      message: errorMsg,
    });
    broadcast({
      type: "login_failed",
      data: { logId: log.id, id: account.id, email: account.email, provider, error: errorMsg },
    });
    return { success: false, error: errorMsg };
  }
}

/**
 * Run login for ALL providers at once for a given email/password.
 * This is more efficient when adding a new account that should be
 * registered across all 3 providers (Kiro, CodeBuddy, Canva).
 */
export async function loginAllProviders(
  email: string,
  password: string
): Promise<Record<string, LoginResult>> {
  try {
    const proc = Bun.spawn(
      [
        config.pythonPath,
        config.authScriptPath,
        "--email",
        email,
        "--password",
        password,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ENOWX_ALLOWED_PROVIDERS: "kiro,codebuddy,canva",
          BATCHER_ENABLE_CAMOUFOX: "true",
          BATCHER_CAMOUFOX_HEADLESS: config.headless ? "true" : "false",
          BATCHER_PROXY_URL: config.proxyUrl || "",
          HTTP_PROXY: config.proxyUrl || "",
          HTTPS_PROXY: config.proxyUrl || "",
          BATCHER_CONCURRENT: "3",
        },
        cwd: "/home/priyo/.local/lib/enowxai/auth",
      }
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const events = parseScriptOutput(stdout);
    const result = extractResult(events);

    if (!result) {
      return {
        kiro: { success: false, error: "No result" },
        codebuddy: { success: false, error: "No result" },
        canva: { success: false, error: "No result" },
      };
    }

    const output: Record<string, LoginResult> = {};

    for (const provider of ["kiro", "codebuddy", "canva"] as const) {
      const pr = result[provider] as ProviderResult | undefined;
      if (!pr || !pr.success) {
        output[provider] = {
          success: false,
          error: pr?.error || "Failed",
        };
      } else {
        output[provider] = {
          success: true,
          tokens: pr.credentials,
          quota: pr.quota,
        };
      }
    }

    return output;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      kiro: { success: false, error: errorMsg },
      codebuddy: { success: false, error: errorMsg },
      canva: { success: false, error: errorMsg },
    };
  }
}

/**
 * Helper to mark an account as errored in the database
 */
async function markAccountError(accountId: number, errorMsg: string) {
  await db
    .update(accounts)
    .set({
      status: "error",
      errorMessage: errorMsg,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));
}
