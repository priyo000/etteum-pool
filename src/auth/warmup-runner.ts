import { db } from "../db/index";
import { accounts, type Account } from "../db/schema";
import { eq } from "drizzle-orm";
import { providers } from "../proxy/router";
import { pool, type ProviderName } from "../proxy/pool";
import { broadcast } from "../ws/index";
import { addAuthLog } from "./logs";
import type { ProviderHealthKind, ProviderHealthResult, ProviderQuotaSnapshot } from "../proxy/providers/base";

type AccountStatus = "active" | "exhausted" | "error" | "pending" | string;

export interface WarmupResult {
  success: boolean;
  accountId: number;
  provider: string;
  email: string;
  previousStatus: AccountStatus;
  status: AccountStatus;
  kind: ProviderHealthKind;
  quota?: ProviderQuotaSnapshot;
  refreshedTokens?: boolean;
  retryable?: boolean;
  error?: string;
  message?: string;
}

interface AccountWarmupUpdate {
  status: AccountStatus;
  errorMessage: string | null;
  quotaLimit?: number;
  quotaRemaining?: number;
  quotaResetAt?: Date | null;
  freeLimit?: number;
  freeRemaining?: number;
  freeResetAt?: Date | null;
  tokens?: unknown;
  metadata: unknown;
}

// ============================================================================
// Qoder-specific tunables
// ============================================================================
// Qoder uses a custom daily-credit system (200 req/day) that lives in the
// `quotaLimit`/`quotaRemaining` columns. The Qoder server itself reports a
// *different* quota that we must NOT clobber those columns with — but we still
// want to observe it for drift, exhaustion, and debugging. These constants
// govern the safety nets around that observation.

/** How often we may run the qd-Lite inference probe per account. */
const QODER_PROBE_THROTTLE_MS = 60 * 60 * 1000; // 1 hour

/** How long a probe-passed quota override remains trusted before we re-probe. */
const QODER_QUOTA_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Drift thresholds.
 * - vs server (`/quota/usage`): permissive — server commonly reports `0/0`
 *   sentinel for accounts it's not tracking, which would otherwise spam.
 * - vs activity (`/activity` per-model promo): strict — both sides are exact
 *   per-day counters, so meaningful drift implies real bookkeeping bug.
 */
const QODER_DRIFT_VS_SERVER_THRESHOLD = 50;
const QODER_DRIFT_VS_ACTIVITY_THRESHOLD = 5;

// ============================================================================
// Metadata helpers
// ============================================================================

function shortError(value?: string) {
  if (!value) return null;
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getWarmupMeta(account: Account): Record<string, unknown> {
  const meta = asObject(account.metadata);
  return asObject(meta.warmup);
}

/**
 * Build the next `metadata` blob for the account.
 *
 * Strategy:
 *  - Spread `existing` first so untouched fields survive.
 *  - Spread provider-supplied `health.metadata` next (e.g. inferenceProbe).
 *  - Then write our authoritative `warmup` and `serverQuota` blocks last so
 *    they always reflect the current tick.
 */
function mergeWarmupMetadata(
  account: Account,
  health: ProviderHealthResult,
  extras: { lastProbeAt?: string; quotaOverride?: { active: boolean; until: string } | null } = {},
) {
  const existing = asObject(account.metadata);
  const prevWarmup = asObject(existing.warmup);
  const now = new Date().toISOString();

  // Always preserve the *server's* view of the quota in metadata, even when we
  // intentionally skip writing the DB columns (Qoder custom-credit case).
  // This lets the dashboard surface drift between custom-daily vs server.
  const serverQuota = health.quota
    ? {
        limit: Number(health.quota.limit ?? 0) || 0,
        remaining: Number(health.quota.remaining ?? 0) || 0,
        used: Number(health.quota.used ?? 0) || 0,
        resetAt: health.quota.resetAt
          ? new Date(health.quota.resetAt as unknown as string | number | Date).toISOString()
          : null,
        source: health.quota.source ?? null,
        reportedExhausted: health.kind === "exhausted",
        reportedAt: now,
      }
    : (existing.serverQuota ?? null);

  // Carry quotaOverride forward unless explicitly replaced; expire if past TTL.
  let quotaOverride = extras.quotaOverride;
  if (quotaOverride === undefined) {
    const prev = asObject(prevWarmup.quotaOverride);
    if (prev.until && typeof prev.until === "string") {
      const until = Date.parse(prev.until);
      quotaOverride = Number.isFinite(until) && until > Date.now()
        ? (prev as { active: boolean; until: string })
        : null;
    } else {
      quotaOverride = null;
    }
  }

  // Hoist activityQuota explicitly so consumers (dashboard, drift detection)
  // get a typed top-level field instead of relying on `...health.metadata`
  // spread order. Carry forward the previous snapshot when this tick failed
  // to fetch — stale data is more useful than missing data, and the error
  // breadcrumb (`activityQuotaError`) flags freshness.
  const incomingActivity = (health.metadata as Record<string, unknown> | undefined)?.activityQuota;
  const activityQuota = incomingActivity != null ? incomingActivity : (existing.activityQuota ?? null);

  return {
    ...existing,
    ...(health.metadata || {}),
    warmup: {
      lastCheckedAt: now,
      kind: health.kind,
      success: health.success,
      retryable: Boolean(health.retryable),
      quotaSource: health.quota?.source ?? null,
      authRefreshed: Boolean(health.tokens),
      lastError: shortError(health.error || health.message),
      lastProbeAt: extras.lastProbeAt ?? (prevWarmup.lastProbeAt as string | undefined) ?? null,
      quotaOverride: quotaOverride ?? null,
    },
    serverQuota,
    activityQuota,
    overage: health.quota?.overage || existing.overage || null,
  };
}

/**
 * Find the activity bucket that maps to a given upstream model key (e.g.
 * `qmodel_latest` → qd-Qwen3.7-Max). Used by drift detection and message
 * formatting; safe to return `null` when the activity payload is missing or
 * the model isn't covered by any promo.
 */
function findActivityForModelKey(
  activity: unknown,
  modelKey: string,
): { limit: number; remaining: number; used: number; eligible: boolean; resetAt: number | null } | null {
  const obj = asObject(activity);
  const list = Array.isArray(obj.activities) ? (obj.activities as unknown[]) : [];
  for (const entry of list) {
    const e = asObject(entry);
    const keys = Array.isArray(e.modelKeys) ? (e.modelKeys as unknown[]).map(String) : [];
    if (keys.includes(modelKey)) {
      const resetAtRaw = Number(e.resetAt);
      return {
        limit: Number(e.limit ?? 0) || 0,
        remaining: Number(e.remaining ?? 0) || 0,
        used: Number(e.used ?? 0) || 0,
        eligible: e.eligible === true,
        resetAt: Number.isFinite(resetAtRaw) && resetAtRaw > 0 ? resetAtRaw : null,
      };
    }
  }
  return null;
}

// ============================================================================
// Qoder-specific health policy
// ============================================================================

interface QoderPolicy {
  /** Skip writing `status`/`errorMessage` (preserve custom credit state). */
  skipStatusUpdate: boolean;
  /** Skip writing quota columns (preserve custom 200/day credits). */
  skipQuotaColumns: boolean;
}

/**
 * Qoder uses Qoder's own quota as the source of truth on every warmup. We
 * override DB counters with real data from `/quota/usage` (All) and
 * `/activity` bucket `qmodel_latest` (Free) every cycle.
 *
 * Status flip rules:
 *   - auth/session/banned: honored (require human).
 *   - probe-confirmed exhaustion: honored.
 *   - server "exhausted" alone: NOT honored unless probe agrees (Qoder
 *     OpenAPI sometimes reports 0/0 for accounts that still serve).
 *   - healthy: always allow status flip back to active (auto-recovery).
 */
function decideQoderPolicy(account: Account, health: ProviderHealthResult): QoderPolicy {
  if (account.provider !== "qoder") {
    return { skipStatusUpdate: false, skipQuotaColumns: false };
  }

  // Auth/session failures are always honored — they require human action.
  const isAuthFailure =
    health.kind === "session_expired" ||
    health.kind === "auth_error" ||
    health.kind === "banned" ||
    health.kind === "missing_tokens";
  if (isAuthFailure) {
    // Quota columns still get overridden when present (data is data).
    return { skipStatusUpdate: false, skipQuotaColumns: false };
  }

  const probe = (health.metadata as Record<string, unknown> | undefined)?.inferenceProbe;

  // Probe-confirmed exhaustion: trust it.
  if (probe === "quota_exhausted") {
    return { skipStatusUpdate: false, skipQuotaColumns: false };
  }

  // Server reports exhausted but probe didn't confirm — don't flip status
  // (false-exhaustion case), but still override quota columns with real data.
  if (health.kind === "exhausted" && probe !== "healthy") {
    return { skipStatusUpdate: true, skipQuotaColumns: false };
  }

  // Healthy or recoverable: full override allowed.
  return { skipStatusUpdate: false, skipQuotaColumns: false };
}

// ============================================================================
// Mapping health → DB update
// ============================================================================

export function mapHealthToAccountUpdate(account: Account, health: ProviderHealthResult): AccountWarmupUpdate {
  const policy = decideQoderPolicy(account, health);

  let status: AccountStatus = account.status;
  let errorMessage: string | null = account.errorMessage || null;

  switch (health.kind) {
    case "healthy":
      if (!policy.skipStatusUpdate) {
        status = "active";
        errorMessage = null;
      }
      break;
    case "exhausted":
      if (!policy.skipStatusUpdate) {
        status = "exhausted";
        errorMessage = "Quota exhausted";
      }
      break;
    case "banned":
      status = "error";
      errorMessage = health.error || "Account banned or disabled";
      break;
    case "session_expired":
      status = "error";
      errorMessage = health.error || "Session expired; re-login required";
      break;
    case "auth_error":
      status = "error";
      errorMessage = health.error || "Authentication error";
      break;
    case "missing_tokens":
      status = account.status === "pending" ? "pending" : "error";
      errorMessage = health.error || "No tokens available; login required";
      break;
    case "transient_error":
      status = account.status;
      errorMessage = health.error || health.message || account.errorMessage || "Transient warmup error";
      break;
    case "unsupported":
      status = account.status;
      errorMessage = health.message || health.error || account.errorMessage || null;
      break;
  }

  const update: AccountWarmupUpdate = {
    status,
    errorMessage,
    metadata: mergeWarmupMetadata(account, health),
  };

  if (!policy.skipQuotaColumns) {
    // Qoder is the source of truth — we just mirror what it says, period.
    // No reconciliation, no min(), no local-vs-server arbitration. If a
    // request lands and the Qoder counter is stale, we'll find out when
    // the upstream returns 403 and exhaust the account on the spot
    // (handled at the proxy layer). Warmup will flip it back to active
    // when Qoder reports remaining > 0 again (i.e. real reset).
    if (health.quota) {
      const rawLimit = Number(health.quota.limit);
      const rawRemaining = Number(health.quota.remaining);
      // Sentinel `-1` means "unknown / unlimited" — preserve whatever the
      // provider already wrote into the DB instead of clobbering it with the
      // sentinel.
      if (Number.isFinite(rawLimit) && rawLimit >= 0) {
        update.quotaLimit = rawLimit;
        update.quotaRemaining = Math.max(0, Number.isFinite(rawRemaining) ? rawRemaining : 0);
        if (health.kind === "exhausted") update.quotaRemaining = 0;
      }
      if (health.quota.resetAt) {
        const resetAt = new Date(health.quota.resetAt);
        if (!Number.isNaN(resetAt.getTime())) update.quotaResetAt = resetAt;
      }
    } else if (health.kind === "exhausted") {
      update.quotaRemaining = 0;
    }

    // Free counter mirrors /activity bucket qmodel_latest.
    if (account.provider === "qoder") {
      const meta = (health.metadata as Record<string, unknown> | undefined) ?? {};
      const freeBucket = findActivityForModelKey(meta.activityQuota, "qmodel_latest");
      if (freeBucket) {
        update.freeLimit = freeBucket.limit;
        update.freeRemaining = Math.max(0, freeBucket.remaining);
        update.freeResetAt = freeBucket.resetAt != null ? new Date(freeBucket.resetAt) : null;
      } else {
        update.freeLimit = 0;
        update.freeRemaining = 0;
        update.freeResetAt = null;
      }
    }
  }

  if (health.tokens) update.tokens = health.tokens;
  return update;
}

// ============================================================================
// Inference probes (kiro overage + qoder false-exhaustion)
// ============================================================================

type ProviderLike = (typeof providers)[keyof typeof providers];

/**
 * Run the kiro/kiro-pro overage probe. Mutates `health` in place when the probe
 * determines the account can still serve requests via PAYG overage.
 */
async function runKiroOverageProbe(provider: ProviderLike, account: Account, health: ProviderHealthResult): Promise<void> {
  if (health.kind !== "exhausted") return;
  if (!account.provider.startsWith("kiro")) return;
  if (!health.quota?.overage?.enabled) return;

  try {
    const probeResult = await provider.chatCompletion(account, {
      model: account.provider === "kiro-pro" ? "claude-sonnet-4.6" : "auto",
      messages: [{ role: "user", content: "Say OK" }],
      max_tokens: 4,
    });
    if (probeResult.success) {
      health.kind = "healthy";
      health.success = true;
      health.metadata = { ...health.metadata, inferenceProbe: "passed", overageBudget: true };
    } else if (probeResult.quotaExhausted) {
      health.metadata = { ...health.metadata, inferenceProbe: "quota_exhausted" };
    } else {
      health.metadata = { ...health.metadata, inferenceProbe: "failed", probeError: probeResult.error?.slice(0, 100) };
    }
  } catch (e) {
    health.metadata = {
      ...health.metadata,
      inferenceProbe: "error",
      probeError: (e instanceof Error ? e.message : String(e)).slice(0, 100),
    };
  }
}

interface QoderProbeOutcome {
  ranProbe: boolean;
  probeAt?: string;
  override?: { active: boolean; until: string } | null;
}

/**
 * Run the Qoder false-exhaustion probe.
 *
 * The Qoder OpenAPI sometimes reports `userQuota.remaining=0` for accounts that
 * can still serve requests. We confirm with the cheapest model (qd-Lite,
 * price_factor=0). Throttled to once per `QODER_PROBE_THROTTLE_MS` per account
 * to avoid hammering the upstream.
 *
 * On success we set `quotaOverride` with a TTL so a stale "passed" verdict
 * cannot mask a real ban indefinitely — the next tick after the TTL expires
 * will re-probe.
 */
async function runQoderFalseExhaustionProbe(
  provider: ProviderLike,
  account: Account,
  health: ProviderHealthResult,
): Promise<QoderProbeOutcome> {
  if (health.kind !== "exhausted") return { ranProbe: false };
  if (account.provider !== "qoder") return { ranProbe: false };

  const prevWarmup = getWarmupMeta(account);
  const lastProbeAt = typeof prevWarmup.lastProbeAt === "string" ? Date.parse(prevWarmup.lastProbeAt) : NaN;
  const throttled = Number.isFinite(lastProbeAt) && Date.now() - lastProbeAt < QODER_PROBE_THROTTLE_MS;

  // Honor an unexpired probe-passed override so we don't probe every tick.
  const prevOverride = asObject(prevWarmup.quotaOverride);
  const overrideValidUntil = typeof prevOverride.until === "string" ? Date.parse(prevOverride.until) : NaN;
  const overrideStillValid = prevOverride.active === true && Number.isFinite(overrideValidUntil) && overrideValidUntil > Date.now();

  if (throttled || overrideStillValid) {
    health.metadata = {
      ...health.metadata,
      inferenceProbe: overrideStillValid ? "skipped_override" : "skipped_throttle",
    };
    if (overrideStillValid) {
      // Override still trusted — flip back to healthy so downstream pool isn't poisoned.
      health.kind = "healthy";
      health.success = true;
    }
    return { ranProbe: false };
  }

  const probeAt = new Date().toISOString();
  try {
    const probeResult = await provider.chatCompletion(account, {
      model: "qd-Lite",
      messages: [{ role: "user", content: "Say OK" }],
      max_tokens: 4,
    });
    if (probeResult.success) {
      health.kind = "healthy";
      health.success = true;
      const until = new Date(Date.now() + QODER_QUOTA_OVERRIDE_TTL_MS).toISOString();
      health.metadata = { ...health.metadata, inferenceProbe: "passed" };
      return { ranProbe: true, probeAt, override: { active: true, until } };
    }
    if (probeResult.quotaExhausted) {
      health.metadata = { ...health.metadata, inferenceProbe: "quota_exhausted" };
      return { ranProbe: true, probeAt, override: null };
    }
    health.metadata = {
      ...health.metadata,
      inferenceProbe: "failed",
      probeError: probeResult.error?.slice(0, 100),
    };
    return { ranProbe: true, probeAt };
  } catch (e) {
    health.metadata = {
      ...health.metadata,
      inferenceProbe: "error",
      probeError: (e instanceof Error ? e.message : String(e)).slice(0, 100),
    };
    return { ranProbe: true, probeAt };
  }
}

// ============================================================================
// Log message formatting
// ============================================================================

function eventTypeFor(kind: ProviderHealthKind) {
  if (kind === "healthy") return "warmup_success";
  if (kind === "exhausted") return "warmup_exhausted";
  if (kind === "transient_error") return "warmup_transient_error";
  if (kind === "unsupported") return "warmup_unsupported";
  return "warmup_auth_error";
}

function messageFor(result: WarmupResult, account: Account, healthMeta?: Record<string, unknown>): string {
  const isQoder = result.provider === "qoder";

  if (isQoder) {
    const dailyRem = account.quotaRemaining ?? "?";
    const dailyLim = account.quotaLimit ?? "?";
    const serverRem = result.quota?.remaining ?? "n/a";
    const serverLim = result.quota?.limit ?? "n/a";
    const probe = healthMeta?.inferenceProbe;
    const probeTag = typeof probe === "string" ? ` probe=${probe}` : "";

    // Free quota — surfaces the qmodel_latest promo bucket if present.
    const bucket = findActivityForModelKey(healthMeta?.activityQuota, "qmodel_latest");
    const freeTag = bucket
      ? `, free[qmodel_latest] ${bucket.remaining}/${bucket.limit}${bucket.eligible ? "" : " (ineligible)"}`
      : healthMeta?.activityQuotaError
        ? `, free=err`
        : "";

    if (result.kind === "healthy") {
      return `WarmUp healthy — daily ${dailyRem}/${dailyLim}, server ${serverRem}/${serverLim}${freeTag}${probeTag}`;
    }
    if (result.kind === "exhausted") {
      return `WarmUp exhausted — daily ${dailyRem}/${dailyLim}, server ${serverRem}/${serverLim}${freeTag}`;
    }
  }

  if (result.kind === "healthy") return `WarmUp healthy: ${result.quota?.remaining ?? "unknown"} credits remaining`;
  if (result.kind === "exhausted") return "WarmUp detected exhausted quota";
  if (result.kind === "transient_error") return `WarmUp transient error: ${result.error || result.message || "unknown"}`;
  if (result.kind === "unsupported") return result.message || "WarmUp unsupported for provider";
  return result.error || result.message || `WarmUp ${result.kind}`;
}

// ============================================================================
// Drift detection (Qoder)
// ============================================================================

/**
 * Drift detection for Qoder.
 *
 * Strategy:
 *   1. If `/activity` returned a per-model bucket matching our `qmodel_latest`
 *      mapping, compare DB daily-remaining against it (strict threshold).
 *      This is the preferred signal — both sides are exact per-day counters.
 *   2. Otherwise fall back to comparing against `/quota/usage` (lenient
 *      threshold), skipping the `0/0` sentinel.
 *
 * One log per drift source — both can fire if both sources exist and disagree.
 */
function emitQoderDriftWarningIfAny(account: Account, health: ProviderHealthResult): void {
  if (account.provider !== "qoder") return;
  const dailyRem = Number(account.quotaRemaining ?? NaN);
  if (!Number.isFinite(dailyRem)) return;

  // --- Activity-based drift (preferred) ---
  const activity = (health.metadata as Record<string, unknown> | undefined)?.activityQuota;
  // qmodel_latest is the upstream key we care about (qd-Qwen3.7-Max promo).
  const bucket = findActivityForModelKey(activity, "qmodel_latest");
  if (bucket && bucket.limit > 0) {
    const drift = dailyRem - bucket.remaining;
    if (Math.abs(drift) >= QODER_DRIFT_VS_ACTIVITY_THRESHOLD) {
      addAuthLog({
        type: "warmup_drift_warning",
        accountId: account.id,
        email: account.email,
        provider: account.provider,
        step: "drift_activity",
        message: `Qoder drift vs activity[qmodel_latest]: daily=${dailyRem}, activity=${bucket.remaining}, diff=${drift}`,
        data: {
          source: "activity",
          modelKey: "qmodel_latest",
          dailyRemaining: dailyRem,
          activityRemaining: bucket.remaining,
          activityLimit: bucket.limit,
          drift,
        },
      });
    }
  }

  // --- Server-quota drift (fallback / additional signal) ---
  if (health.quota) {
    const serverRem = Number(health.quota.remaining ?? NaN);
    if (Number.isFinite(serverRem)) {
      const serverLim = Number(health.quota.limit ?? 0) || 0;
      // 0/0 from /quota/usage is the "no data" sentinel — skip.
      const isSentinel = serverLim === 0 && serverRem === 0;
      if (!isSentinel) {
        const drift = dailyRem - serverRem;
        if (Math.abs(drift) >= QODER_DRIFT_VS_SERVER_THRESHOLD) {
          addAuthLog({
            type: "warmup_drift_warning",
            accountId: account.id,
            email: account.email,
            provider: account.provider,
            step: "drift_server",
            message: `Qoder drift vs server: daily=${dailyRem}, server=${serverRem}, diff=${drift}`,
            data: { source: "server", dailyRemaining: dailyRem, serverRemaining: serverRem, drift },
          });
        }
      }
    }
  }
}

// ============================================================================
// Public entry point
// ============================================================================

export async function warmupAccount(account: Account): Promise<WarmupResult> {
  const provider = providers[account.provider as keyof typeof providers];
  if (!provider) {
    return {
      success: false,
      accountId: account.id,
      provider: account.provider,
      email: account.email,
      previousStatus: account.status,
      status: "error",
      kind: "unsupported",
      error: `Provider not configured: ${account.provider}`,
    };
  }

  const startLog = addAuthLog({
    type: "warmup_processing",
    accountId: account.id,
    email: account.email,
    provider: account.provider,
    step: "checking",
    message: `WarmUp checking ${account.provider}/${account.email}`,
  });

  broadcast({
    type: "warmup_processing",
    data: {
      logId: startLog.id,
      id: account.id,
      accountId: account.id,
      email: account.email,
      provider: account.provider,
      step: "checking",
      message: startLog.message,
      timestamp: startLog.timestamp,
    },
  });

  const health: ProviderHealthResult = await provider.healthCheck(account);

  // Probes — each may mutate `health` in place.
  await runKiroOverageProbe(provider, account, health);
  const qoderProbe = await runQoderFalseExhaustionProbe(provider, account, health);

  // Drift detection runs against the (now possibly probe-adjusted) `health`.
  emitQoderDriftWarningIfAny(account, health);

  // Build the DB update (status/quota policy lives inside this).
  const update = mapHealthToAccountUpdate(account, health);

  // Reconcile metadata with probe outcomes (lastProbeAt + quotaOverride).
  // We re-merge here so the metadata reflects probe bookkeeping, not just the
  // raw health response.
  if (account.provider === "qoder" && qoderProbe.ranProbe) {
    update.metadata = mergeWarmupMetadata(account, health, {
      lastProbeAt: qoderProbe.probeAt,
      quotaOverride: qoderProbe.override ?? null,
    });
  }

  const dbUpdate: Record<string, unknown> = {
    status: update.status,
    errorMessage: update.errorMessage,
    metadata: update.metadata,
    updatedAt: new Date(),
  };
  if (update.quotaLimit !== undefined) dbUpdate.quotaLimit = update.quotaLimit;
  if (update.quotaRemaining !== undefined) dbUpdate.quotaRemaining = update.quotaRemaining;
  if (update.quotaResetAt !== undefined) dbUpdate.quotaResetAt = update.quotaResetAt;
  if (update.freeLimit !== undefined) dbUpdate.freeLimit = update.freeLimit;
  if (update.freeRemaining !== undefined) dbUpdate.freeRemaining = update.freeRemaining;
  if (update.freeResetAt !== undefined) dbUpdate.freeResetAt = update.freeResetAt;
  if (update.tokens !== undefined) dbUpdate.tokens = update.tokens;

  await db.update(accounts).set(dbUpdate).where(eq(accounts.id, account.id));
  pool.invalidate(account.provider as ProviderName);

  const result: WarmupResult = {
    success: health.kind === "healthy" || health.kind === "exhausted",
    accountId: account.id,
    provider: account.provider,
    email: account.email,
    previousStatus: account.status,
    status: update.status,
    kind: health.kind,
    quota: health.quota,
    refreshedTokens: Boolean(health.tokens),
    retryable: Boolean(health.retryable),
    error: health.error,
    message: health.message,
  };

  const type = eventTypeFor(health.kind);
  const log = addAuthLog({
    type,
    accountId: account.id,
    email: account.email,
    provider: account.provider,
    step: health.kind,
    message: messageFor(result, account, health.metadata as Record<string, unknown> | undefined),
    error: health.kind === "healthy" || health.kind === "exhausted" ? undefined : health.error,
    data: {
      kind: health.kind,
      status: update.status,
      quotaLimit: update.quotaLimit,
      quotaRemaining: update.quotaRemaining,
      retryable: health.retryable,
      refreshedTokens: Boolean(health.tokens),
      // Qoder-only diagnostics
      ...(account.provider === "qoder"
        ? (() => {
            const meta = health.metadata as Record<string, unknown> | undefined;
            const bucket = findActivityForModelKey(meta?.activityQuota, "qmodel_latest");
            return {
              serverQuotaLimit: health.quota?.limit ?? null,
              serverQuotaRemaining: health.quota?.remaining ?? null,
              inferenceProbe: meta?.inferenceProbe ?? null,
              freeQuota: bucket
                ? {
                    modelKey: "qmodel_latest",
                    limit: bucket.limit,
                    remaining: bucket.remaining,
                    eligible: bucket.eligible,
                  }
                : null,
              activityQuotaError: meta?.activityQuotaError ?? null,
            };
          })()
        : {}),
    },
  });

  broadcast({
    type,
    data: {
      logId: log.id,
      id: account.id,
      accountId: account.id,
      email: account.email,
      provider: account.provider,
      status: update.status,
      kind: health.kind,
      quotaLimit: update.quotaLimit,
      quotaRemaining: update.quotaRemaining,
      retryable: health.retryable,
      refreshedTokens: Boolean(health.tokens),
      message: log.message,
      error: log.error,
      timestamp: log.timestamp,
    },
  });

  broadcast({
    type: "account_status",
    data: {
      id: account.id,
      status: update.status,
      provider: account.provider,
      error: update.errorMessage,
      quotaLimit: update.quotaLimit,
      quotaRemaining: update.quotaRemaining,
    },
  });

  return result;
}
