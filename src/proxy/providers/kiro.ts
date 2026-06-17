import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderQuotaSnapshot,
  type ProviderResult,
  type StreamChunk,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import {
  decodeAwsEventStream,
  readEventStreamFrames,
  concatBytes,
  extractEventText,
  extractReasoningText,
  isCompleteJson,
  completeJsonSuffix,
  unwrapKiroEvent,
  extractKiroText,
  extractKiroToolCalls,
  extractKiroCredits,
  extractKiroContextTokens,
} from "./kiro/aws-eventstream";
import {
  textFromContent,
  extractImageBlocks,
  hasImages,
  mapTools,
  extractToolResults,
  toolResultsFromContent,
  toolUsesFromMessage,
  normalizeMessages,
  buildHistory,
} from "./kiro/messages";

interface KiroTokens {
  access_token?: string;
  refresh_token?: string;
  profile_arn?: string;
  profileArn?: string;
  expires_at?: string;
  expires_in?: string;
}

/**
 * Kiro Provider - Standard tier
 * Supports Claude, DeepSeek, GLM, MiniMax, Qwen models
 */
/**
 * Pro-tier model catalog. kiro-pro is the SAME upstream (AWS CodeWhisperer) as
 * standard kiro — it differs only by which models it exposes (Opus / krp- ids,
 * served from a separate Pro account pool) and the variant "chip" the dashboard
 * shows. So it is a *variant* of this one provider class, not a subclass.
 */
const KIRO_PRO_MODELS: ModelInfo[] = [
  { id: "krp-auto", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.018 / 1000, creditSource: "estimated" },
  { id: "krp-claude-opus-4.8", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.022 / 1000, creditSource: "estimated" },
  { id: "krp-claude-opus-4.8-thinking", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.022 / 1000, creditSource: "estimated" },
  { id: "krp-claude-opus-4.7", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.022 / 1000, creditSource: "estimated" },
  { id: "krp-claude-opus-4.7-thinking", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.022 / 1000, creditSource: "estimated" },
  { id: "krp-claude-opus-4.6", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.022 / 1000, creditSource: "estimated" },
  { id: "krp-claude-opus-4.6-thinking", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.022 / 1000, creditSource: "estimated" },
  { id: "krp-claude-opus-4.5", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.018 / 1000, creditSource: "estimated" },
  { id: "krp-claude-sonnet-4.6", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
  { id: "krp-claude-sonnet-4.6-thinking", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.015 / 1000, creditSource: "estimated" },
  { id: "krp-claude-haiku-4.5", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.003 / 1000, creditSource: "estimated" },
  { id: "krp-claude-haiku-4.5-thinking", object: "model", created: Date.now(), owned_by: "kiro-pro", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.004 / 1000, creditSource: "estimated" },
];

/** Map Kiro Pro model IDs to the actual Kiro API model names. Supports legacy kp-* aliases. */
const KIRO_PRO_MODEL_MAP: Record<string, string> = {
  "krp-auto": "auto",
  "krp-claude-opus-4.8": "claude-opus-4.8",
  "krp-claude-opus-4.8-thinking": "claude-opus-4.8-thinking",
  "krp-claude-opus-4.7": "claude-opus-4.7",
  "krp-claude-opus-4.7-thinking": "claude-opus-4.7-thinking",
  "krp-claude-opus-4.6": "claude-opus-4.6",
  "krp-claude-opus-4.6-thinking": "claude-opus-4.6-thinking",
  "krp-claude-opus-4.5": "claude-opus-4.5",
  "krp-claude-sonnet-4.6": "claude-sonnet-4.6",
  "krp-claude-sonnet-4.6-thinking": "claude-sonnet-4.6-thinking",
  "krp-claude-haiku-4.5": "claude-haiku-4.5",
  "krp-claude-haiku-4.5-thinking": "claude-haiku-4.5-thinking",
  // Legacy aliases kept for backward compatibility.
  "kp-auto": "auto",
  "kp-opus-4.8": "claude-opus-4.8",
  "kp-opus-4.8-thinking": "claude-opus-4.8-thinking",
  "kp-opus-4.7": "claude-opus-4.7",
  "kp-opus-4.7-thinking": "claude-opus-4.7-thinking",
  "kp-opus-4.6": "claude-opus-4.6",
  "kp-opus-4.6-thinking": "claude-opus-4.6-thinking",
  "kp-opus-4.5": "claude-opus-4.5",
  "kp-sonnet-4.6": "claude-sonnet-4.6",
  "kp-sonnet-4.6-thinking": "claude-sonnet-4.6-thinking",
  "kp-haiku-4.5": "claude-haiku-4.5",
  "kp-haiku-4.5-thinking": "claude-haiku-4.5-thinking",
};

export type KiroVariant = "standard" | "pro";

export class KiroProvider extends BaseProvider {
  /** "standard" = kiro (kr-* models); "pro" = kiro-pro (krp-* models, Pro pool). */
  readonly variant: KiroVariant;
  name = "kiro";
  // Standard kiro exposes kr-* public model ids and keeps legacy bare aliases
  // for compatibility. It speaks Anthropic natively (AWS CodeWhisperer event-stream).
  // See registry.ts and proxy/index.ts. The "pro" variant resets isFallback and
  // owns only its krp- prefixed models (plus legacy kp-* aliases).
  override isFallback = true;
  override nativeFormat: "openai" | "anthropic" = "anthropic";

  constructor(opts: { variant?: KiroVariant } = {}) {
    super();
    this.variant = opts.variant ?? "standard";
    if (this.variant === "pro") {
      this.name = "kiro-pro";
      this.isFallback = false;
      this.supportedModels = KIRO_PRO_MODELS;
    }
  }

  override ownsModel(model: string): boolean {
    const lower = model.toLowerCase();
    if (this.variant === "pro") return lower.startsWith("krp-") || lower.startsWith("kp-");

    const m = lower.replace("-thinking", "");
    if (this.getModelInfo(model)) return true;
    if (m.startsWith("kr-")) return true;

    // Legacy bare aliases kept for backward compatibility. /v1/models exposes kr-* only.
    if (m === "auto") return true;
    if (m === "deepseek-3.2" || m === "glm-5") return true;
    if (m.startsWith("minimax-") || m.startsWith("qwen")) return true;
    return m.includes("claude") || m.includes("sonnet") || m.includes("haiku");
  }

  /** Resolve public Kiro model ids to the real upstream Kiro API model names. */
  private resolveModel(model: string): string {
    if (this.variant === "pro") return KIRO_PRO_MODEL_MAP[model] || model;
    return model.startsWith("kr-") ? model.slice(3) : model;
  }

  private baseUrl = "https://q.us-east-1.amazonaws.com";
  private refreshUrl =
    "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";

  supportedModels: ModelInfo[] = [
    // Kiro uses CREDIT-BASED billing (fractional credits per request).
    // Kiro sends real credit usage via meteringEvent and context usage via contextUsageEvent.
    // creditRate here is only used as fallback when upstream credits are unavailable.

    // Auto (1.0x baseline)
    { id: "kr-auto", object: "model", created: Date.now(), owned_by: "kiro", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.008 / 1000, creditSource: "estimated" },
    // Claude Haiku 4.5 (0.4x)
    { id: "kr-claude-haiku-4.5", object: "model", created: Date.now(), owned_by: "kiro", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.003 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4 (1.3x)
    { id: "kr-claude-sonnet-4", object: "model", created: Date.now(), owned_by: "kiro", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.010 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4.5 (1.3x)
    { id: "kr-claude-sonnet-4.5", object: "model", created: Date.now(), owned_by: "kiro", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.010 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4.5 Thinking (1.3x with extended thinking)
    { id: "kr-claude-sonnet-4.5-thinking", object: "model", created: Date.now(), owned_by: "kiro", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.013 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4.6 (1.5x)
    { id: "kr-claude-sonnet-4.6", object: "model", created: Date.now(), owned_by: "kiro", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4.6 Thinking (1.5x with extended thinking)
    { id: "kr-claude-sonnet-4.6-thinking", object: "model", created: Date.now(), owned_by: "kiro", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.015 / 1000, creditSource: "estimated" },
    // DeepSeek 3.2 (0.25x)
    { id: "kr-deepseek-3.2", object: "model", created: Date.now(), owned_by: "kiro", context_window: 164000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.002 / 1000, creditSource: "estimated" },
    // GLM-5 (0.5x)
    { id: "kr-glm-5", object: "model", created: Date.now(), owned_by: "kiro", context_window: 200000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.004 / 1000, creditSource: "estimated" },
    // GLM-5 Thinking (0.5x with thinking)
    { id: "kr-glm-5-thinking", object: "model", created: Date.now(), owned_by: "kiro", context_window: 200000, max_output: 64000, thinking: true, vision: false, creditUnit: "credit", creditRate: 0.005 / 1000, creditSource: "estimated" },
    // MiniMax M2.1 (0.15x)
    { id: "kr-minimax-m2.1", object: "model", created: Date.now(), owned_by: "kiro", context_window: 196000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.001 / 1000, creditSource: "estimated" },
    // MiniMax M2.5 (0.25x)
    { id: "kr-minimax-m2.5", object: "model", created: Date.now(), owned_by: "kiro", context_window: 196000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.002 / 1000, creditSource: "estimated" },
    // Qwen3 Coder Next (0.05x)
    { id: "kr-qwen3-coder-next", object: "model", created: Date.now(), owned_by: "kiro", context_window: 256000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.0004 / 1000, creditSource: "estimated" },
  ];

  private getTokens(account: Account): KiroTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string"
        ? JSON.parse(account.tokens)
        : account.tokens;
      return t as KiroTokens;
    } catch {
      return null;
    }
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    request = { ...request, model: this.resolveModel(request.model) };
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) {
      return { success: false, error: "No access token available" };
    }

    try {
      const response = await this.makeRequest(tokens, request, false);

      if (response.status === 401 || response.status === 403) {
        const refreshResult = await this.refreshToken(account);
        if (!refreshResult.success) {
          return { success: false, error: "Token expired and refresh failed" };
        }
        const newTokens = (typeof refreshResult.tokens === "string"
          ? JSON.parse(refreshResult.tokens)
          : refreshResult.tokens) as KiroTokens;
        const retryResponse = await this.makeRequest(newTokens, request, false);
        if (!retryResponse.ok) {
          const errText = await retryResponse.text();
          return { success: false, error: `Kiro API error: ${errText}` };
        }
        const result = await this.parseResponse(retryResponse, request);
        // Return new tokens so router can persist them
        if (result.success) {
          result.tokens = newTokens;
        }
        return result;
      }

      if (response.status === 429) {
        return { success: false, error: "Rate limited", rateLimited: true };
      }

      if (response.status === 402) {
        // Payment required — check if account has PAYG/overage active.
        // If so, this is likely a transient rate-limit, not true exhaustion.
        const overage = this.getAccountOverage(account);
        if (overage?.enabled && overage.remaining > 0) {
          return { success: false, error: "Rate limited (PAYG active)", rateLimited: true };
        }
        return { success: false, error: "Quota exhausted", quotaExhausted: true };
      }

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `Kiro API error (${response.status}): ${errText}` };
      }

      return this.parseResponse(response, request);
    } catch (error) {
      return { success: false, error: `Kiro request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    request = { ...request, model: this.resolveModel(request.model) };
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) {
      return { success: false, error: "No access token available" };
    }

    try {
      const response = await this.makeRequest(tokens, request, true);

      if (response.status === 401 || response.status === 403) {
        const refreshResult = await this.refreshToken(account);
        if (!refreshResult.success) {
          return { success: false, error: "Token expired and refresh failed" };
        }
        const newTokens = (typeof refreshResult.tokens === "string"
          ? JSON.parse(refreshResult.tokens)
          : refreshResult.tokens) as KiroTokens;
        const retryResponse = await this.makeRequest(newTokens, request, true);
        if (!retryResponse.ok) {
          const errText = await retryResponse.text();
          return { success: false, error: `Kiro API error: ${errText}` };
        }
        const result = this.createLiveStreamResponse(retryResponse, request.model);
        // Return new tokens so router can persist them
        if (result.success) {
          result.tokens = newTokens;
        }
        return result;
      }

      if (response.status === 429) {
        return { success: false, error: "Rate limited", rateLimited: true };
      }

      if (response.status === 402) {
        const overage = this.getAccountOverage(account);
        if (overage?.enabled && overage.remaining > 0) {
          return { success: false, error: "Rate limited (PAYG active)", rateLimited: true };
        }
        return { success: false, error: "Quota exhausted", quotaExhausted: true };
      }

      if (!response.ok) {
        const errText = await response.text();
        return { success: false, error: `Kiro API error (${response.status}): ${errText}` };
      }

      return this.createLiveStreamResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `Kiro stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async refreshToken(
    account: Account
  ): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) {
      return { success: false, error: "No refresh token" };
    }

    try {
      const response = await fetch(this.refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: tokens.refresh_token }),
      });

      if (!response.ok) {
        return { success: false, error: `Refresh failed: ${response.status}` };
      }

      const data = (await response.json()) as {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: string;
      };

      const newTokens: KiroTokens = {
        ...tokens,
        access_token: data.accessToken || tokens.access_token,
        refresh_token: data.refreshToken || tokens.refresh_token,
        expires_at: data.expiresAt || tokens.expires_at,
      };

      return { success: true, tokens: JSON.stringify(newTokens) };
    } catch (error) {
      return { success: false, error: `Refresh error: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!(tokens?.access_token && tokens?.refresh_token);
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) {
      return { success: false, error: "No access token available" };
    }

    try {
      const response = await this.fetchUsageLimits(tokens);
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json();
      const quota = this.parseUsageLimits(data);
      return { success: true, quota };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token || !tokens?.refresh_token) {
      return { kind: "missing_tokens", success: false, error: "Missing Kiro access or refresh token" };
    }

    if (!this.getProfileArn(tokens)) {
      return { kind: "auth_error", success: false, error: "Missing Kiro profile ARN" };
    }

    let activeTokens = tokens;
    let refreshedTokens: KiroTokens | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetchUsageLimits(activeTokens);

        if ((response.status === 401 || response.status === 403) && attempt === 0) {
          const refresh = await this.refreshToken(account);
          if (!refresh.success || !refresh.tokens) {
            return { kind: "session_expired", success: false, error: refresh.error || "Kiro session expired; refresh failed" };
          }
          refreshedTokens = typeof refresh.tokens === "string" ? JSON.parse(refresh.tokens) : refresh.tokens as KiroTokens;
          if (!refreshedTokens?.access_token) {
            return { kind: "session_expired", success: false, error: "Kiro refresh returned no access token" };
          }
          activeTokens = refreshedTokens;
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          return { kind: "session_expired", success: false, error: "Kiro session expired; re-login required" };
        }

        if (response.status === 429 || response.status >= 500) {
          return { kind: "transient_error", success: false, retryable: true, error: `Kiro quota API HTTP ${response.status}` };
        }

        if (!response.ok) {
          return { kind: "auth_error", success: false, error: `Kiro quota API HTTP ${response.status}` };
        }

        const data = await response.json();
        const quota = this.parseUsageLimits(data);
        const hasOverageBudget = quota.overage?.enabled && quota.overage.remaining > 0;
        const isExhausted = quota.remaining <= 0 && !hasOverageBudget;
        return {
          kind: isExhausted ? "exhausted" : "healthy",
          success: true,
          quota,
          tokens: refreshedTokens || undefined,
          metadata: { authRefreshed: Boolean(refreshedTokens), overageBudget: hasOverageBudget },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "transient_error", success: false, retryable: true, error: message };
      }
    }

    return { kind: "session_expired", success: false, error: "Kiro session expired" };
  }

  /**
   * Read overage info from account metadata (persisted by warmup).
   * Used during live requests to decide if 402 is truly exhausted or just rate-limited.
   */
  private getAccountOverage(account: Account): { enabled: boolean; remaining: number } | null {
    const meta = account.metadata as Record<string, unknown> | null;
    if (!meta || typeof meta !== "object") return null;
    const overage = meta.overage as { enabled?: boolean; remaining?: number } | null;
    if (!overage || typeof overage !== "object") return null;
    return { enabled: Boolean(overage.enabled), remaining: Number(overage.remaining || 0) };
  }

  private getProfileArn(tokens: KiroTokens): string {
    return tokens.profile_arn || tokens.profileArn || "";
  }

  private async fetchUsageLimits(tokens: KiroTokens): Promise<Response> {
    const profileArn = this.getProfileArn(tokens);
    if (!profileArn) throw new Error("Missing Kiro profile ARN");

    const url = new URL(`${this.baseUrl}/getUsageLimits`);
    url.searchParams.set("origin", "AI_EDITOR");
    url.searchParams.set("resourceType", "AGENTIC_REQUEST");
    url.searchParams.set("profileArn", profileArn);

    return this.fetchWithTimeout(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
        "User-Agent": "KiroIDE/compatible pool-proxy/1.0.0",
        "x-amz-user-agent": "pool-proxy/1.0.0",
      },
    }, config.providerQuotaTimeoutMs);
  }

  private parseUsageLimits(payload: unknown): ProviderQuotaSnapshot {
    const root = payload as any;
    const usageBreakdown = Array.isArray(root?.usageBreakdownList) ? root.usageBreakdownList : [];

    if (usageBreakdown.length > 0) {
      const usage = usageBreakdown[0] || {};
      const usageLimit = Number(usage.usageLimit || 0);
      const currentUsage = Number(usage.currentUsage || 0);
      let totalCredits = usageLimit;
      let totalUsage = currentUsage;
      const freeTrial = usage.freeTrialInfo || {};
      if (String(freeTrial.freeTrialStatus || "").toUpperCase() === "ACTIVE") {
        totalCredits += Number(freeTrial.usageLimit || 0);
        totalUsage += Number(freeTrial.currentUsage || 0);
      }
      for (const bonus of usage.bonuses || []) {
        totalCredits += Number(bonus?.usageLimit || 0);
        totalUsage += Number(bonus?.currentUsage || 0);
      }
      const resetAt = root.nextResetDate || root.next_reset_date || null;

      const overageCfg = root.overageConfiguration || {};
      const subInfo = root.subscriptionInfo || {};
      const overageEnabled = String(overageCfg.overageStatus || "").toUpperCase() === "ENABLED";
      const overageCapable = String(subInfo.overageCapability || "").toUpperCase() === "OVERAGE_CAPABLE";
      const overageCap = Number(usage.overageCap || usage.overageCapWithPrecision || 0);
      const overageUsed = Number(usage.currentOverages || usage.currentOveragesWithPrecision || 0);
      const overageRemaining = Math.max(0, overageCap - overageUsed);

      return {
        limit: totalCredits,
        remaining: Math.max(0, totalCredits - totalUsage),
        used: totalUsage,
        resetAt,
        source: "kiro.getUsageLimits",
        raw: {
          subscriptionType: root.subscriptionType || root.subscription_type || subInfo.type,
          subscriptionTitle: root.subscriptionTitle || root.subscription_title || subInfo.subscriptionTitle,
          daysUntilReset: root.daysUntilReset || root.days_until_reset,
        },
        overage: {
          enabled: overageEnabled,
          capable: overageCapable,
          used: overageUsed,
          cap: overageCap,
          remaining: overageRemaining,
        },
      };
    }

    const candidates = this.flattenObjects(root);
    const selected = candidates.find((item) =>
      String(item.resourceType || item.resource || item.type || "").includes("AGENTIC_REQUEST")
    ) || candidates.find((item) =>
      this.firstNumber(item.remaining, item.available, item.remainingCount, item.limit, item.max, item.quota, item.total) !== undefined
    ) || root;

    const limit = this.firstNumber(
      selected?.limit,
      selected?.max,
      selected?.maxCount,
      selected?.quota,
      selected?.total,
      selected?.capacity,
      selected?.usageLimit,
      selected?.totalCredits,
      selected?.total_credits
    ) ?? 0;
    const used = this.firstNumber(
      selected?.used,
      selected?.usage,
      selected?.currentUsage,
      selected?.consumed,
      selected?.current_usage,
      selected?.totalUsage,
      selected?.total_usage
    ) ?? 0;
    const explicitRemaining = this.firstNumber(
      selected?.remaining,
      selected?.available,
      selected?.remainingCount,
      selected?.remainingCredits,
      selected?.remaining_credits
    );
    const remaining = explicitRemaining ?? Math.max(0, limit - used);
    const resetAt = selected?.resetAt || selected?.resetTime || selected?.refreshAt || selected?.nextResetDate || selected?.next_reset_date || null;

    return {
      limit,
      remaining: Math.max(0, remaining),
      used: used || Math.max(0, limit - remaining),
      resetAt,
      source: "kiro.getUsageLimits",
      raw: this.summarizeUsagePayload(root),
    };
  }

  private flattenObjects(value: any, out: any[] = []): any[] {
    if (!value || typeof value !== "object") return out;
    if (!Array.isArray(value)) out.push(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") this.flattenObjects(child, out);
    }
    return out;
  }

  private firstNumber(...values: unknown[]): number | undefined {
    for (const value of values) {
      if (value === null || value === undefined || value === "") continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
    return undefined;
  }

  private summarizeUsagePayload(payload: any): unknown {
    if (!payload || typeof payload !== "object") return undefined;
    return {
      keys: Object.keys(payload).slice(0, 20),
      subscriptionType: payload.subscriptionType || payload.subscription_type,
      resourceType: payload.resourceType || payload.resource_type,
    };
  }

  private async makeRequest(
    tokens: KiroTokens,
    request: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    if (!tokens.access_token) throw new Error("No access token available");

    const headers: Record<string, string> = {
      "Content-Type": "application/x-amz-json-1.0",
      Accept: "application/vnd.amazon.eventstream, application/json, */*",
      Authorization: `Bearer ${tokens.access_token}`,
      "X-Amz-Target": "AmazonCodeWhisperStreamingService.GenerateAssistantResponse",
      "x-amzn-codewhisper-optout": "true",
      "x-amzn-kiro-agent-mode": "vibe",
      "User-Agent": "KiroIDE/compatible pool-proxy/1.0.0",
      "x-amz-user-agent": "pool-proxy/1.0.0",
    };

    // Handle -thinking suffix or reasoning_effort from request body
    const isThinking = request.model.endsWith("-thinking") || !!request.reasoning_effort || !!request.thinking;
    const actualModel = request.model.endsWith("-thinking") ? request.model.replace("-thinking", "") : request.model;

    // Collect EVERY system message (clients like opencode interleave multiple
    // system-reminders rather than using a single leading system block).
    const systemPrompt = request.messages
      .filter((m) => m.role === "system")
      .map((m) => textFromContent(m.content))
      .filter(Boolean)
      .join("\n\n");

    // Strip system messages before normalizing so that any user turns that were
    // separated only by a system message get merged into one, keeping the
    // user → assistant → user alternation Kiro requires.
    const nonSystem = request.messages.filter((m) => m.role !== "system");
    const messages = normalizeMessages(nonSystem);

    // The current turn is the final message; everything before it is history.
    // Selecting by position (not "last user message") prevents the current turn
    // from leaking into both `history` and `currentMessage` when the request
    // ends with a non-user message → Kiro 400 "Improperly formed request."
    const lastIndex = messages.length - 1;
    const current = lastIndex >= 0 ? messages[lastIndex] : undefined;
    const priorMessages = lastIndex > 0 ? messages.slice(0, lastIndex) : [];

    const conversationId = crypto.randomUUID();
    const tools = mapTools(request.tools);
    const toolResults = toolResultsFromContent(current?.content || "");
    const history = buildHistory(priorMessages, actualModel);
    const context: Record<string, unknown> = { tools };
    if (toolResults.length > 0) context.toolResults = toolResults;

    const userTextContent = textFromContent(current?.content || "");
    const imageBlocks = extractImageBlocks(current?.content || "").slice(0, 10);
    const textContent = [systemPrompt, userTextContent].filter(Boolean).join("\n\n");

    const userInputMessage: Record<string, unknown> = {
      content: textContent,
      modelId: actualModel,
      origin: "AI_EDITOR",
      userInputMessageContext: context,
    };

    if (imageBlocks.length > 0) {
      userInputMessage.images = imageBlocks;
    }

    const body: Record<string, unknown> = {
      conversationState: {
        agentContinuationId: crypto.randomUUID(),
        agentTaskType: "vibe",
        chatTriggerType: "MANUAL",
        conversationId,
        currentMessage: { userInputMessage },
        history,
      },
    };

    if (tokens.profile_arn) body.profileArn = tokens.profile_arn;

    if (isThinking) {
      (body.conversationState as any).reasoning = { effort: "high" };
    }

    // Amazon Q/Kiro endpoint is not OpenAI-compatible. It expects this REST path;
    // using `/` or `/chat/completions` returns UnknownOperationException.
    return this.fetchWithTimeout(`${this.baseUrl}/generateAssistantResponse`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  private async parseResponse(response: Response, request: ChatCompletionRequest): Promise<ProviderResult> {
    const model = request.model;
    let content = "";
    let tokensUsed = 0;
    let upstreamCreditsUsed = 0;

    const bytes = new Uint8Array(await response.arrayBuffer());
    const events = decodeAwsEventStream(bytes);

    if (events.length > 0) {
      content = extractKiroText(events);
      const toolCalls = extractKiroToolCalls(events);
      upstreamCreditsUsed = extractKiroCredits(events);
      if (!content.trim() && toolCalls.length === 0) {
        return { success: false, error: "Kiro returned no assistant content" };
      }

      // Kiro doesn't send token counts directly. Use contextUsagePercentage for total tokens.
      const contextTokens = extractKiroContextTokens(events, this.getModelInfo(model)?.context_window ?? 200000);
      const completionTokens = this.estimateTokens(content || JSON.stringify(toolCalls));
      const promptTokens = contextTokens > completionTokens
        ? contextTokens - completionTokens
        : this.estimateMessagesTokens(request.messages);
      const totalTokens = contextTokens || (promptTokens + completionTokens);

      const data: ChatCompletionResponse = {
        id: this.generateId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
      };
      return {
        success: true,
        response: data,
        tokensUsed: totalTokens,
        promptTokens,
        completionTokens,
        creditsUsed: upstreamCreditsUsed || totalTokens * this.getProviderCreditRate(model),
        creditSource: upstreamCreditsUsed > 0 ? "upstream" : "estimated",
      };
    } else {
      const text = new TextDecoder().decode(bytes);
      try {
        const data = JSON.parse(text) as any;
        const awsType = data.Output?.__type || data.__type;
        const awsMessage = data.Output?.message || data.message;
        if (awsType || awsMessage) {
          return { success: false, error: `Kiro upstream error: ${awsType || "Error"}: ${awsMessage || text}` };
        }
        content = data.choices?.[0]?.message?.content || data.content || data.text || JSON.stringify(data);
        tokensUsed = data.usage?.total_tokens || 0;
      } catch {
        content = text;
      }
    }

    if (!content.trim()) {
      return { success: false, error: "Kiro returned no assistant content" };
    }

    const promptTokens = this.estimateMessagesTokens(request.messages);
    const completionTokens = this.estimateTokens(content);
    const totalTokens = tokensUsed || promptTokens + completionTokens;

    const data: ChatCompletionResponse = {
      id: this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
    };
    return {
      success: true,
      response: data,
      tokensUsed: totalTokens,
      promptTokens,
      completionTokens,
      creditsUsed: upstreamCreditsUsed || totalTokens * this.getProviderCreditRate(model),
      creditSource: upstreamCreditsUsed > 0 ? "upstream" : "estimated",
    };
  }

  private createLiveStreamResponse(response: Response, model: string): ProviderResult {
    const id = this.generateId();
    const encoder = new TextEncoder();
    const contextWindow = this.getModelInfo(model)?.context_window ?? 200000;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = response.body?.getReader();
        if (!reader) { controller.close(); return; }
        let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
        const toolIndexes = new Map<string, number>();
        const toolBuffers = new Map<string, string>();
        const toolInputObjects = new Map<string, Record<string, unknown>>();
        let nextToolIndex = 0;
        const allEvents: Array<{ headers: Record<string, string>; payload: any }> = [];
        let streamedContentLength = 0;

        const enqueue = (delta: any, finish_reason: string | null = null, usage?: any) => {
          const chunk: any = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta, finish_reason }],
          };
          if (usage) chunk.usage = usage;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        try {
          enqueue({ role: "assistant" });
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer = concatBytes(buffer, value as Uint8Array);
            const parsed = readEventStreamFrames(buffer);
            buffer = parsed.remaining;
            for (const event of parsed.events) {
              allEvents.push(event);
              const eventType = event.headers[":event-type"];
              const payload = unwrapKiroEvent(event.payload, eventType);
              if (event.headers[":message-type"] === "error" || event.headers[":message-type"] === "exception") {
                throw new Error(typeof payload === "string" ? payload : payload?.message || event.headers[":error-code"] || "Kiro stream error");
              }
              const reasoning = extractReasoningText(payload, eventType);
              if (reasoning) enqueue({ reasoning_content: reasoning });
              const text = extractEventText(payload, eventType);
              if (text) { streamedContentLength += text.length; enqueue({ content: text }); }
              const tool = payload?.toolUseEvent || (eventType === "toolUseEvent" ? payload : null);
              if (tool?.toolUseId && (tool?.name || toolIndexes.has(tool.toolUseId))) {
                const isFirstChunk = !toolIndexes.has(tool.toolUseId);
                if (isFirstChunk && !tool.name) {
                  // Can't start a tool call without a name — skip
                } else {
                  if (isFirstChunk) toolIndexes.set(tool.toolUseId, nextToolIndex++);
                  const toolIdx = toolIndexes.get(tool.toolUseId)!;

                  // Kiro sends tool.input as either a string fragment or a full object.
                  // For objects: accumulate into toolInputObjects and only stringify on stop.
                  // For strings: accumulate as raw string fragments (OpenAI streaming style).
                  let args = "";
                  if (typeof tool.input === "string") {
                    args = tool.input;
                  } else if (tool.input && typeof tool.input === "object" && Object.keys(tool.input).length > 0) {
                    // Merge object into accumulated input for this tool
                    const prev = toolInputObjects.get(tool.toolUseId) || {};
                    const merged = { ...prev, ...tool.input };
                    toolInputObjects.set(tool.toolUseId, merged);
                    // Don't stream partial object args — wait for stop event
                    args = "";
                  }

                  if (isFirstChunk) {
                    toolBuffers.set(tool.toolUseId, args);
                    enqueue({
                      tool_calls: [{
                        index: toolIdx,
                        id: tool.toolUseId,
                        type: "function",
                        function: { name: tool.name, arguments: args },
                      }],
                    });
                  } else if (args) {
                    toolBuffers.set(tool.toolUseId, (toolBuffers.get(tool.toolUseId) || "") + args);
                    enqueue({
                      tool_calls: [{
                        index: toolIdx,
                        function: { arguments: args },
                      }],
                    });
                  }

                  if (tool.stop === true) {
                    // If we accumulated object input, emit the full JSON now
                    const accumulatedObj = toolInputObjects.get(tool.toolUseId);
                    if (accumulatedObj && Object.keys(accumulatedObj).length > 0) {
                      const fullArgs = JSON.stringify(accumulatedObj);
                      const prevBuffer = toolBuffers.get(tool.toolUseId) || "";
                      toolBuffers.set(tool.toolUseId, prevBuffer + fullArgs);
                      enqueue({
                        tool_calls: [{
                          index: toolIdx,
                          function: { arguments: fullArgs },
                        }],
                      });
                    } else {
                      // String-mode: check if JSON is complete
                      const buffered = toolBuffers.get(tool.toolUseId) || "";
                      if (buffered && !isCompleteJson(buffered)) {
                        const suffix = completeJsonSuffix(buffered);
                        if (suffix) {
                          enqueue({
                            tool_calls: [{
                              index: toolIdx,
                              function: { arguments: suffix },
                            }],
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          // Flush any accumulated object inputs that never received tool.stop
          for (const [toolId, objInput] of toolInputObjects.entries()) {
            if (Object.keys(objInput).length === 0) continue;
            const prevBuffer = toolBuffers.get(toolId) || "";
            // Only emit if we haven't already flushed (check if buffer already has valid JSON)
            if (prevBuffer && isCompleteJson(prevBuffer)) continue;
            const toolIdx = toolIndexes.get(toolId);
            if (toolIdx === undefined) continue;
            const fullArgs = JSON.stringify(objInput);
            toolBuffers.set(toolId, prevBuffer + fullArgs);
            enqueue({
              tool_calls: [{
                index: toolIdx,
                function: { arguments: fullArgs },
              }],
            });
          }

          // Extract real usage from Kiro's contextUsageEvent and meteringEvent
          const totalTokens = extractKiroContextTokens(allEvents, contextWindow);
          const creditsUsed = extractKiroCredits(allEvents);
          const completionTokens = Math.max(1, Math.ceil(streamedContentLength / 4));
          const promptTokens = totalTokens > completionTokens ? totalTokens - completionTokens : 0;
          const usage = totalTokens > 0 || creditsUsed > 0
            ? { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, credits_used: creditsUsed }
            : undefined;
          enqueue({}, toolIndexes.size > 0 ? "tool_calls" : "stop", usage);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message, type: "api_error" } })}\n\n`));
        } finally {
          controller.close();
        }
      },
    });
    return { success: true, stream, tokensUsed: 0 };
  }

  private createStreamResponse(response: Response, model: string): ProviderResult {
    const id = this.generateId();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) { controller.close(); return; }

        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data: ")) continue;
              const data = trimmed.slice(6);

              if (data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const chunk: StreamChunk = {
                  id, object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000), model,
                  choices: [{
                    index: 0,
                    delta: parsed.choices?.[0]?.delta || parsed.delta || {},
                    finish_reason: parsed.choices?.[0]?.finish_reason || null,
                  }],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch { /* skip */ }
            }
          }
        } catch (error) {
          console.error("[Kiro] Stream error:", error);
        } finally {
          controller.close();
        }
      },
    });

    return { success: true, stream, tokensUsed: 0 };
  }
}
