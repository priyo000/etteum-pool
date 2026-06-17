import type { ChatCompletionRequest, ProviderResult } from "./providers/base";
import { providers, getAllModels, type ProviderName } from "./providers/registry";
import { isNonAccountRequestError, isTransientError } from "./errors";
import { applyPudidilFilters } from "./filters";
import { pool } from "./pool";
import type { Account } from "../db/schema";
import {
  compressRequest,
  getCompressionConfig,
  type CompressionStats,
} from "./compression";
import {
  findComboForModel,
  shouldComboRetry,
  isComboModel,
  isStepCooledDown,
  recordStepFailure,
  recordStepSuccess,
} from "./combo";

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  provider: ProviderName;
  durationMs: number;
  compressionStats?: CompressionStats;
  /** When a combo fallback was used, records which step succeeded. */
  comboInfo?: {
    ruleName: string;
    originalModel: string;
    usedStep: number;
    usedProvider: string;
    usedModel: string;
    attemptedSteps: string[];
  };
}

/** Check if a request contains image content blocks */
function requestHasImages(request: ChatCompletionRequest): boolean {
  return request.messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return (msg.content as any[]).some(
      (block) => block?.type === "image_url" || block?.type === "image"
    );
  });
}

/**
 * Sanitize request by applying pudidil filters to all text content.
 */
function sanitizeRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  const sanitized = { ...request };

  sanitized.messages = request.messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg, content: applyPudidilFilters(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: (msg.content as any[]).map((block) => {
          if (block?.type === "text" && typeof block.text === "string") {
            return { ...block, text: applyPudidilFilters(block.text) };
          }
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") {
              return { ...block, content: applyPudidilFilters(block.content) };
            }
            if (Array.isArray(block.content)) {
              return {
                ...block,
                content: block.content.map((inner: any) =>
                  inner?.type === "text" && typeof inner.text === "string"
                    ? { ...inner, text: applyPudidilFilters(inner.text) }
                    : inner
                ),
              };
            }
          }
          return block;
        }),
      };
    }
    return msg;
  });

  if (sanitized.tools) {
    sanitized.tools = request.tools!.map((tool: any) => {
      if (tool?.function?.description) {
        return {
          ...tool,
          function: {
            ...tool.function,
            description: applyPudidilFilters(tool.function.description),
          },
        };
      }
      return tool;
    });
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// tryProvider — attempt a request against a single provider+model
// ---------------------------------------------------------------------------

async function tryProvider(
  sanitizedRequest: ChatCompletionRequest,
  targetModel: string,
  providerName: ProviderName,
  stream: boolean,
): Promise<RouteResult> {
  const hasImages = requestHasImages(sanitizedRequest);
  const modelRequest = { ...sanitizedRequest, model: targetModel };

  let compressedRequest = modelRequest;
  let compressionStats: CompressionStats | undefined;
  try {
    const cfg = await getCompressionConfig();
    const out = compressRequest(modelRequest, cfg, providerName);
    compressedRequest = out.request;
    compressionStats = out.stats;
  } catch (err) {
    console.error("[Compression] Failed, passing request through unchanged:", err);
  }

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  if (hasImages) {
    const modelInfo = provider.getModelInfo(targetModel);
    if (modelInfo && !modelInfo.vision) {
      throw new Error(
        `Model "${targetModel}" does not support image/vision inputs. Use a vision-capable model instead.`
      );
    }
  }

  const maxRetries = 3;
  let lastError = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const account = providerName === "byok"
      ? (await pool.getAccountForModel(compressedRequest.model))?.account ?? null
      : await pool.getNextAccount(providerName);
    if (!account) {
      throw new Error(
        `No active accounts available for provider: ${providerName}`
      );
    }

    const startTime = Date.now();
    let tracked = false;

    try {
      pool.trackRequestStart(account.id);
      tracked = true;
      const result = stream
        ? await provider.chatCompletionStream(account, compressedRequest)
        : await provider.chatCompletion(account, compressedRequest);

      const durationMs = Date.now() - startTime;

      if (result.success) {
        if (result.tokens) {
          await pool.updateTokens(account.id, result.tokens);
        }
        await pool.markUsed(account.id);
        return { result, account, provider: providerName, durationMs, compressionStats };
      }

      pool.trackRequestEnd(account.id);
      tracked = false;

      if (isNonAccountRequestError(result.error)) {
        throw new Error(result.error || `Invalid model: ${compressedRequest.model}`);
      }

      if (result.rateLimited) {
        lastError = result.error || "Rate limited";
        continue;
      }

      if (result.quotaExhausted) {
        // Recheck quota in real-time before marking exhausted — avoids false positives
        // from transient 429s or stale local quota data.
        try {
          const quotaCheck = await provider.fetchQuota(account);
          if (quotaCheck.success && quotaCheck.quota && quotaCheck.quota.remaining > 0) {
            // Quota still available — this was a transient rate limit, not real exhaustion
            console.log(
              `[Router] ${account.email}: quotaExhausted signal but real quota is ${quotaCheck.quota.remaining}/${quotaCheck.quota.limit}. Treating as transient.`
            );
            await pool.markTransientFailure(account.id, result.error || "Transient rate limit (quota still available)");
            lastError = result.error || "Transient rate limit";
            continue;
          }
        } catch {
          // Quota check failed — proceed with marking exhausted
        }
        await pool.markExhausted(account.id);
        lastError = result.error || "Quota exhausted";
        continue;
      }

      if (
        result.error?.includes("expired") ||
        result.error?.includes("401")
      ) {
        const refreshResult = await provider.refreshToken(account);
        if (refreshResult.success && refreshResult.tokens) {
          let parsedTokens: unknown;
          try {
            parsedTokens = JSON.parse(refreshResult.tokens);
          } catch {
            parsedTokens = refreshResult.tokens;
          }
          await pool.updateTokens(account.id, parsedTokens);
          pool.trackRequestStart(account.id);
          tracked = true;
          const retryResult = stream
            ? await provider.chatCompletionStream(account, compressedRequest)
            : await provider.chatCompletion(account, compressedRequest);

          if (retryResult.success) {
            await pool.markUsed(account.id);
            return {
              result: retryResult,
              account,
              provider: providerName,
              durationMs: Date.now() - startTime,
              compressionStats,
            };
          }
          pool.trackRequestEnd(account.id);
          tracked = false;
        }
        await pool.markTransientFailure(account.id, result.error || "Auth failed");
        lastError = result.error || "Auth failed";
        continue;
      }

      if (isTransientError(result.error || "")) {
        await pool.markTransientFailure(account.id, result.error || "Transient error");
      } else {
        await pool.markError(account.id, result.error || "Unknown error");
      }
      lastError = result.error || "Unknown error";
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      if (tracked) {
        pool.trackRequestEnd(account.id);
        tracked = false;
      }
      if (isNonAccountRequestError(errMsg)) {
        throw error;
      }
      if (errMsg.includes("expired") || errMsg.includes("401")) {
        await pool.markTransientFailure(account.id, errMsg);
      } else if (isTransientError(errMsg)) {
        await pool.markTransientFailure(account.id, errMsg);
      } else {
        await pool.markError(account.id, errMsg);
      }
      lastError = errMsg;
    }
  }

  throw new Error(
    `All accounts failed for ${providerName}. Last error: ${lastError}`
  );
}

// ---------------------------------------------------------------------------
// routeRequest — main entry point with combo fallback
// ---------------------------------------------------------------------------

/**
 * Route a chat completion request to the appropriate provider/account.
 * Implements retry logic with fallback to next account, and combo
 * (multi-provider+model) fallback when a combo rule matches.
 */
export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean
): Promise<RouteResult> {
  const sanitizedRequest = sanitizeRequest(request);

  const originalModel = sanitizedRequest.model;

  // ── Check if this is a combo virtual model (exact match) ──
  // When the client selects a combo model (e.g. "best"), we skip the normal
  // provider lookup and go straight into the combo chain from step 1.
  const directCombo = isComboModel(originalModel);
  if (directCombo) {
    return runComboChain(sanitizedRequest, originalModel, directCombo, stream, []);
  }

  // ── Normal routing: find provider for this model ──
  const providerName = pool.getProviderForModel(originalModel);
  if (!providerName) {
    throw new Error(`No provider found for model: ${originalModel}`);
  }

  // ── First attempt: original provider + model ──
  try {
    return await tryProvider(sanitizedRequest, originalModel, providerName, stream);
  } catch (primaryError) {
    const primaryMsg = primaryError instanceof Error ? primaryError.message : String(primaryError);

    // Content/model errors should not trigger combo fallback
    if (isNonAccountRequestError(primaryMsg)) {
      throw primaryError;
    }

    // ── Combo fallback (pattern match) ──
    const comboRule = findComboForModel(originalModel);
    if (!comboRule || comboRule.steps.length === 0) {
      throw primaryError; // No combo rule — propagate original error
    }

    const maxSteps = comboRule.maxRetries > 0
      ? Math.min(comboRule.maxRetries, comboRule.steps.length)
      : comboRule.steps.length;

    const attemptedSteps: string[] = [`${providerName}/${originalModel}`];

    console.log(
      `[Combo] Primary provider ${providerName}/${originalModel} failed: ${primaryMsg}. ` +
      `Trying combo "${comboRule.name}" (${maxSteps} steps)…`
    );

    let lastComboError = primaryMsg;

    for (let i = 0; i < maxSteps; i++) {
      const step = comboRule.steps[i]!;

      // Skip if this step is the same as what we already tried
      if (step.provider === providerName && step.model === originalModel) {
        continue;
      }

      // Check if the error type should trigger a retry for this rule
      if (!shouldComboRetry(comboRule, lastComboError)) {
        console.log(`[Combo] Error type not retryable for rule "${comboRule.name}", stopping.`);
        break;
      }

      const stepProvider = step.provider as ProviderName;
      if (!providers[stepProvider]) {
        console.warn(`[Combo] Unknown provider "${step.provider}" in step ${i}, skipping.`);
        continue;
      }

      // Cooldown check
      if (isStepCooledDown(step.provider, step.model)) {
        console.log(`[Combo] Step ${i + 1} (${step.provider}/${step.model}) is in cooldown, skipping.`);
        continue;
      }

      // Health-aware skip
      const hasAccounts = await pool.hasActiveAccounts(stepProvider);
      if (!hasAccounts) {
        console.log(`[Combo] Step ${i + 1} (${step.provider}/${step.model}) has no active accounts, skipping.`);
        continue;
      }

      attemptedSteps.push(`${step.provider}/${step.model}`);
      console.log(`[Combo] Step ${i + 1}/${maxSteps}: trying ${step.provider}/${step.model}…`);

      try {
        const result = await withTimeout(
          tryProvider(sanitizedRequest, step.model, stepProvider, stream),
          COMBO_STEP_TIMEOUT_MS,
          `${step.provider}/${step.model}`,
        );

        recordStepSuccess(step.provider, step.model);

        // Success — attach combo metadata
        result.comboInfo = {
          ruleName: comboRule.name,
          originalModel,
          usedStep: i,
          usedProvider: step.provider,
          usedModel: step.model,
          attemptedSteps,
        };

        console.log(
          `[Combo] ✓ Success on step ${i + 1} (${step.provider}/${step.model}) ` +
          `after ${attemptedSteps.length} attempts.`
        );

        return result;
      } catch (stepError) {
        lastComboError = stepError instanceof Error ? stepError.message : String(stepError);
        console.log(`[Combo] Step ${i + 1} failed: ${lastComboError}`);

        recordStepFailure(step.provider, step.model);

        if (isNonAccountRequestError(lastComboError)) {
          continue; // Model/content error on this step — skip to next
        }
      }
    }

    // All combo steps exhausted (pattern-match fallback)
    throw new Error(
      `Combo "${comboRule.name}" exhausted all ${attemptedSteps.length} steps. ` +
      `Tried: ${attemptedSteps.join(" → ")}. Last error: ${lastComboError}`
    );
  }
}

// ---------------------------------------------------------------------------
// runComboChain — used when the model IS a combo virtual model
// ---------------------------------------------------------------------------

import type { ComboRule } from "./combo";

/** Per-step timeout for combo chain (30 seconds per step). */
const COMBO_STEP_TIMEOUT_MS = 30_000;

/** Wrap a promise with a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function runComboChain(
  sanitizedRequest: ChatCompletionRequest,
  originalModel: string,
  comboRule: ComboRule,
  stream: boolean,
  priorSteps: string[],
): Promise<RouteResult> {
  const maxSteps = comboRule.maxRetries > 0
    ? Math.min(comboRule.maxRetries, comboRule.steps.length)
    : comboRule.steps.length;

  const attemptedSteps: string[] = [...priorSteps];
  let lastComboError = "";

  console.log(
    `[Combo] Direct combo model "${originalModel}" → running chain "${comboRule.name}" (${maxSteps} steps)…`
  );

  for (let i = 0; i < maxSteps; i++) {
    const step = comboRule.steps[i]!;
    const stepProvider = step.provider as ProviderName;

    if (!providers[stepProvider]) {
      console.warn(`[Combo] Unknown provider "${step.provider}" in step ${i}, skipping.`);
      continue;
    }

    // ── Cooldown check: skip steps that failed too many times recently ──
    if (isStepCooledDown(step.provider, step.model)) {
      console.log(`[Combo] Step ${i + 1} (${step.provider}/${step.model}) is in cooldown, skipping.`);
      continue;
    }

    // ── Health-aware skip: check if provider has any active accounts ──
    const hasAccounts = await pool.hasActiveAccounts(stepProvider);
    if (!hasAccounts) {
      console.log(`[Combo] Step ${i + 1} (${step.provider}/${step.model}) has no active accounts, skipping.`);
      continue;
    }

    attemptedSteps.push(`${step.provider}/${step.model}`);
    console.log(`[Combo] Step ${i + 1}/${maxSteps}: trying ${step.provider}/${step.model}…`);

    try {
      // ── Per-step timeout: don't let one slow provider block the whole chain ──
      const result = await withTimeout(
        tryProvider(sanitizedRequest, step.model, stepProvider, stream),
        COMBO_STEP_TIMEOUT_MS,
        `${step.provider}/${step.model}`,
      );

      // Success — reset cooldown and attach combo metadata
      recordStepSuccess(step.provider, step.model);

      result.comboInfo = {
        ruleName: comboRule.name,
        originalModel,
        usedStep: i,
        usedProvider: step.provider,
        usedModel: step.model,
        attemptedSteps,
      };

      console.log(
        `[Combo] ✓ Success on step ${i + 1} (${step.provider}/${step.model}) ` +
        `after ${attemptedSteps.length} attempts.`
      );

      return result;
    } catch (stepError) {
      lastComboError = stepError instanceof Error ? stepError.message : String(stepError);
      console.log(`[Combo] Step ${i + 1} failed: ${lastComboError}`);

      // Record failure for cooldown tracking
      recordStepFailure(step.provider, step.model);

      // Check retry conditions (skip for first step — always try at least step 1)
      if (i > 0 && !shouldComboRetry(comboRule, lastComboError)) {
        console.log(`[Combo] Error type not retryable, stopping.`);
        break;
      }

      if (isNonAccountRequestError(lastComboError)) {
        continue; // Model/content error — skip to next step
      }
    }
  }

  throw new Error(
    `Combo "${comboRule.name}" exhausted all ${attemptedSteps.length} steps. ` +
    `Tried: ${attemptedSteps.join(" → ")}. Last error: ${lastComboError}`
  );
}

// Re-exported from the provider registry (single source of truth). Kept as
// named exports here so existing import sites (proxy/index.ts, api/stats.ts,
// auth/runner.ts, api/image-studio.ts, auth/warmup-runner.ts) stay unchanged.
export { providers, getAllModels, type ProviderName };
