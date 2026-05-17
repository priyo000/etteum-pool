import { config } from "../config";
import { db } from "../db/index";
import { accounts, settings } from "../db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { Account } from "../db/schema";
import { addAuthLog } from "./logs";
import { providers } from "../proxy/router";
import { getVccPoolFromDb, handleCardResult } from "../api/vcc";
import { getNextProxy } from "../services/proxy-pool";

// Process registry for active login processes — allows killing from outside
const activeProcesses = new Map<number, ReturnType<typeof Bun.spawn>>();
const manuallyStoppedIds = new Set<number>();

export function stopLoginProcess(accountId: number): boolean {
  const proc = activeProcesses.get(accountId);
  if (!proc) return false;
  manuallyStoppedIds.add(accountId);
  try {
    const pid = proc.pid;
    // Immediately SIGKILL the process and all its children
    if (pid) {
      // Kill all child processes (browsers, etc) via pkill
      try { Bun.spawnSync(["pkill", "-9", "-P", String(pid)]); } catch {}
      // Kill process group
      try { process.kill(-pid, "SIGKILL"); } catch {}
      // Kill the process itself
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    try { proc.kill("SIGKILL"); } catch {}
  } catch {}
  activeProcesses.delete(accountId);
  return true;
}

export function getActiveProcessIds(): number[] {
  return [...activeProcesses.keys()];
}

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
  browserEngine?: string;
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

async function waitForProcessExit(proc: ReturnType<typeof Bun.spawn>, timeoutMs = config.authProcessTimeoutMs, accountId?: number): Promise<number> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // process may already be gone
      }
      reject(new Error(`Login process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  // Also resolve immediately if manually stopped
  const stoppedCheck = accountId
    ? new Promise<number>((resolve) => {
        const interval = setInterval(() => {
          if (manuallyStoppedIds.has(accountId)) {
            clearInterval(interval);
            resolve(-1);
          }
        }, 200);
        // Cleanup interval when process exits naturally
        proc.exited.then(() => clearInterval(interval)).catch(() => clearInterval(interval));
      })
    : null;

  try {
    const promises: Promise<number>[] = [proc.exited, timeout as any];
    if (stoppedCheck) promises.push(stoppedCheck);
    return await Promise.race(promises);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // process may already be gone
      }
    }
  }
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

async function getKiroProUpgradeEnv(accountId: number): Promise<Record<string, string>> {
  // Check env var first, then fall back to DB settings
  let upgradeEnabled = config.kiroProUpgrade;
  let billingAddress = config.billingAddress;

  if (!upgradeEnabled) {
    const [upgradeSetting] = await db.select().from(settings).where(eq(settings.key, "kiro_pro_upgrade"));
    if (upgradeSetting?.value === "true") upgradeEnabled = true;
  }

  if (!upgradeEnabled) return {};

  // Read billing address from DB settings if not set via env
  if (!process.env.BILLING_ADDRESS) {
    const keys = ["billing_name", "billing_country", "billing_line1", "billing_city", "billing_state", "billing_postal_code"];
    const rows = await db.select().from(settings);
    const map: Record<string, string> = {};
    for (const r of rows) if (keys.includes(r.key) && r.value) map[r.key] = r.value;

    if (Object.keys(map).length > 0) {
      billingAddress = {
        name: map.billing_name || billingAddress.name,
        country: map.billing_country || billingAddress.country,
        line1: map.billing_line1 || billingAddress.line1,
        city: map.billing_city || billingAddress.city,
        state: map.billing_state || billingAddress.state,
        postal_code: map.billing_postal_code || billingAddress.postal_code,
      };
    }
  }

  // Pass full shuffled pool — each process gets a random order to minimize collision
  return {
    BATCHER_KIRO_PRO_UPGRADE: "true",
    BATCHER_VCC_POOL: JSON.stringify(await getVccPoolFromDb()),
    BATCHER_BILLING_ADDRESS: JSON.stringify(billingAddress),
  };
}

/**
 * Run the Python login script for a SINGLE provider.
 * Uses ENOWX_ALLOWED_PROVIDERS env to filter to just the needed provider.
 *
 * The enowxai login.py script accepts:
 *   --email <email> --password <password>
 *
 * And uses env vars:
 *   ENOWX_ALLOWED_PROVIDERS=kiro,codebuddy,canva,zai (comma-separated)
 *   BATCHER_ENABLE_CAMOUFOX=true (for browser automation)
 *   BATCHER_CAMOUFOX_HEADLESS=true
 *   BATCHER_PROXY_URL=<proxy>
 *   BATCHER_CONCURRENT=1
 */
export async function loginAccount(account: Account, options: LoginOptions = {}): Promise<LoginResult> {
  const password = decrypt(account.password);
  const provider = account.provider; // kiro | codebuddy | canva | zai
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

    const kiroProEnv = provider === "kiro-pro"
      ? { BATCHER_BROWSER_ENGINE: options.browserEngine || config.browserEngine, ...(await getKiroProUpgradeEnv(account.id)) }
      : {};

    const proxyUrlForAuth = (await getNextProxy())?.url || "";

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
          ENOWX_ALLOWED_PROVIDERS: provider,
          PYTHONUNBUFFERED: "1",
          BATCHER_ENABLE_CAMOUFOX: "true",
          BATCHER_CAMOUFOX_HEADLESS: headless ? "true" : "false",
          DISPLAY: process.env.DISPLAY || ":0",
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "",
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || "",
          BATCHER_PROXY_URL: proxyUrlForAuth || config.proxyUrl || "",
          HTTP_PROXY: proxyUrlForAuth || config.proxyUrl || "",
          HTTPS_PROXY: proxyUrlForAuth || config.proxyUrl || "",
          BATCHER_CONCURRENT: "1",
          BATCHER_PRIORITY: provider,
          ...kiroProEnv,
        },
        cwd: config.authScriptCwd,
      }
    );

    activeProcesses.set(account.id, proc);

    const streamedEvents: ScriptEvent[] = [];
    const stdoutPromise = readTextStream(proc.stdout, (line) => {
      const event = parseScriptLine(line);
      if (!event) return;

      streamedEvents.push(event);
      if (event.type === "progress") {
        emitProgressLog(account, event);
      } else if (event.type === "upgrade_card_result") {
        // Immediately update card status in DB when declined — so next account won't retry it
        const cardLast4 = (event as any).card_last4;
        const cardStatus = (event as any).card_status;
        if (cardLast4 && cardStatus && cardStatus !== "success") {
          const status = cardStatus === "declined" ? "declined" as const : "error" as const;
          void handleCardResult(account.id, cardLast4, status);
        }
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
    const timeoutMs = (provider === "kiro-pro" && config.kiroProUpgrade)
      ? Math.max(config.authProcessTimeoutMs, 15 * 60 * 1000)
      : config.authProcessTimeoutMs;
    const exitCode = await waitForProcessExit(proc, timeoutMs, account.id);
    const [stdoutResult, stderrResult] = await Promise.allSettled([stdoutPromise, stderrPromise]);
    const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
    const stderr = stderrResult.status === "fulfilled" ? stderrResult.value : String(stderrResult.reason || "");

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

    // Kiro Pro: upgrade must succeed before marking active
    if (provider === "kiro-pro" && config.kiroProUpgrade) {
      const upgradeResult = (providerResult as any).upgrade as
        | { upgrade_success: boolean; upgrade_error?: string; card_last4?: string; quota?: Record<string, unknown> }
        | null
        | undefined;

      if (!upgradeResult || !upgradeResult.upgrade_success) {
        const upgradeError = upgradeResult?.upgrade_error || "upgrade_not_attempted";
        await db
          .update(accounts)
          .set({
            status: "error",
            tokens: credentials as unknown,
            errorMessage: `Login OK but upgrade failed: ${upgradeError}`,
            lastLoginAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(accounts.id, account.id));

        if (upgradeResult?.card_last4) {
          const cardStatus = upgradeError.includes("declined") ? "declined" as const : "error" as const;
          await handleCardResult(account.id, upgradeResult.card_last4, cardStatus);
        }

        const log = addAuthLog({
          type: "login_failed",
          accountId: account.id,
          email: account.email,
          provider,
          error: `Upgrade failed: ${upgradeError}`,
          message: `Upgrade failed: ${upgradeError}`,
        });
        broadcast({
          type: "login_failed",
          data: { logId: log.id, id: account.id, email: account.email, provider, error: `Upgrade failed: ${upgradeError}` },
        });
        return { success: false, error: `Upgrade failed: ${upgradeError}`, noRetry: true };
      }

      // Upgrade succeeded — update card status
      if (upgradeResult.card_last4) {
        await handleCardResult(account.id, upgradeResult.card_last4, "success");
      }
    }

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

    // If manually stopped, don't retry
    if (manuallyStoppedIds.has(account.id)) {
      manuallyStoppedIds.delete(account.id);
      const log = addAuthLog({
        type: "login_failed",
        accountId: account.id,
        email: account.email,
        provider,
        error: "Stopped by user",
        message: "Stopped by user",
      });
      broadcast({
        type: "login_failed",
        data: { logId: log.id, id: account.id, email: account.email, provider, error: "Stopped by user" },
      });
      return { success: false, error: "Stopped by user", noRetry: true };
    }

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

    // For kiro-pro: if we already passed login phase (upgrade/payment steps), don't retry
    const isKiroProUpgrade = provider === "kiro-pro" && config.kiroProUpgrade;
    const reachedUpgradeStep = streamedEvents.some((e) =>
      e.type === "progress" && /upgrade|payment|billing|card|stripe|checkout/i.test((e as any).step || (e as any).message || "")
    );
    if (isKiroProUpgrade && reachedUpgradeStep) {
      return { success: false, error: errorMsg, noRetry: true };
    }

    return { success: false, error: errorMsg };
  } finally {
    activeProcesses.delete(account.id);
  }
}

/**
 * Run login for ALL providers at once for a given email/password.
 * This is more efficient when adding a new account that should be
 * registered across all providers (Kiro, CodeBuddy, Canva, Z.ai, Windsurf).
 */
export async function loginAllProviders(
  email: string,
  password: string
): Promise<Record<string, LoginResult>> {
  try {
    const proxyUrlForAuth = (await getNextProxy())?.url || "";

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
          ENOWX_ALLOWED_PROVIDERS: "kiro,kiro-pro,codebuddy,canva,zai,windsurf,moclaw,codex",
          BATCHER_ENABLE_CAMOUFOX: "true",
          BATCHER_CAMOUFOX_HEADLESS: config.headless ? "true" : "false",
          BATCHER_PROXY_URL: proxyUrlForAuth || config.proxyUrl || "",
          HTTP_PROXY: proxyUrlForAuth || config.proxyUrl || "",
          HTTPS_PROXY: proxyUrlForAuth || config.proxyUrl || "",
          BATCHER_CONCURRENT: "5",
        },
        cwd: config.authScriptCwd,
      }
    );

    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await waitForProcessExit(proc);
    const [stdoutResult, stderrResult] = await Promise.allSettled([stdoutPromise, stderrPromise]);
    const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
    const stderr = stderrResult.status === "fulfilled" ? stderrResult.value : String(stderrResult.reason || "");

    const events = parseScriptOutput(stdout);
    const result = extractResult(events);

    if (!result) {
      const error = stderr.trim() || `No result${exitCode !== 0 ? ` (exit ${exitCode})` : ""}`;
      return {
        kiro: { success: false, error },
        "kiro-pro": { success: false, error },
        codebuddy: { success: false, error },
        canva: { success: false, error },
        zai: { success: false, error },
        windsurf: { success: false, error },
        moclaw: { success: false, error },
        codex: { success: false, error },
      };
    }

    const output: Record<string, LoginResult> = {};

    for (const provider of ["kiro", "kiro-pro", "codebuddy", "canva", "zai", "windsurf", "moclaw", "codex"] as const) {
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
      "kiro-pro": { success: false, error: errorMsg },
      codebuddy: { success: false, error: errorMsg },
      canva: { success: false, error: errorMsg },
      zai: { success: false, error: errorMsg },
      windsurf: { success: false, error: errorMsg },
      moclaw: { success: false, error: errorMsg },
      codex: { success: false, error: errorMsg },
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
