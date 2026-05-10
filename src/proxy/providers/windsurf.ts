import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderQuotaSnapshot,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import {
  checkHealth,
  getBaseUrl,
  getApiKey,
  getWindsurfAccounts,
  addAccountToWindsurf,
} from "../../services/windsurf";

interface WindsurfTokens {
  auth_token?: string;
  windsurf_url?: string;
  windsurf_api_key?: string;
  windsurf_account_id?: string;
  email?: string;
}

/**
 * Windsurf Provider
 *
 * Forwards requests to a local WindsurfAPI instance (dwgx/WindsurfAPI).
 * WindsurfAPI handles gRPC/protobuf communication with Windsurf cloud,
 * account pooling, and model routing internally.
 *
 * Models are prefixed with "ws-" to distinguish from other providers.
 * The prefix is stripped before forwarding to WindsurfAPI.
 */
export class WindsurfProvider extends BaseProvider {
  name = "windsurf";

  supportedModels: ModelInfo[] = [
    // ── Claude (via Windsurf) ──
    { id: "ws-claude-4-sonnet", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: false, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
    { id: "ws-claude-4-sonnet-thinking", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 3 / 1000, creditSource: "estimated" },
    { id: "ws-claude-4.5-haiku", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },
    { id: "ws-claude-4.5-sonnet", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: false, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
    { id: "ws-claude-4.5-sonnet-thinking", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 3 / 1000, creditSource: "estimated" },
    { id: "ws-claude-4.5-opus", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: false, vision: true, creditUnit: "credit", creditRate: 4 / 1000, creditSource: "estimated" },
    { id: "ws-claude-sonnet-4.6", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: false, vision: true, creditUnit: "credit", creditRate: 4 / 1000, creditSource: "estimated" },
    { id: "ws-claude-sonnet-4.6-thinking", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 6 / 1000, creditSource: "estimated" },
    { id: "ws-claude-opus-4.6", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: false, vision: true, creditUnit: "credit", creditRate: 6 / 1000, creditSource: "estimated" },
    { id: "ws-claude-opus-4.6-thinking", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 8 / 1000, creditSource: "estimated" },
    { id: "ws-claude-opus-4.7", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: false, vision: true, creditUnit: "credit", creditRate: 8 / 1000, creditSource: "estimated" },
    { id: "ws-claude-opus-4.7-thinking", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 10 / 1000, creditSource: "estimated" },

    // ── GPT (via Windsurf) ──
    { id: "ws-gpt-4o", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 16384, thinking: false, vision: true, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },
    { id: "ws-gpt-5", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: true, creditUnit: "credit", creditRate: 0.5 / 1000, creditSource: "estimated" },
    { id: "ws-gpt-5-medium", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: true, vision: true, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },
    { id: "ws-gpt-5-high", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: true, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
    { id: "ws-gpt-5.2", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: true, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
    { id: "ws-gpt-5.4", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: true, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
    { id: "ws-gpt-5.5", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: true, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },

    // ── Gemini (via Windsurf) ──
    { id: "ws-gemini-2.5-pro", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 1000000, max_output: 65536, thinking: true, vision: true, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },
    { id: "ws-gemini-2.5-flash", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 1000000, max_output: 65536, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.5 / 1000, creditSource: "estimated" },
    { id: "ws-gemini-3.0-pro", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 1000000, max_output: 65536, thinking: true, vision: true, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },
    { id: "ws-gemini-3.0-flash", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 1000000, max_output: 65536, thinking: true, vision: true, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },
    { id: "ws-gemini-3.1-pro-high", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 1000000, max_output: 65536, thinking: true, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },

    // ── Grok (via Windsurf) ──
    { id: "ws-grok-3", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 131072, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },
    { id: "ws-grok-3-mini-thinking", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 131072, max_output: 32000, thinking: true, vision: false, creditUnit: "credit", creditRate: 0.125 / 1000, creditSource: "estimated" },
    { id: "ws-grok-code-fast-1", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 131072, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.5 / 1000, creditSource: "estimated" },

    // ── Kimi (via Windsurf) ──
    { id: "ws-kimi-k2", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.5 / 1000, creditSource: "estimated" },
    { id: "ws-kimi-k2.5", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },

    // ── GLM (via Windsurf) ──
    { id: "ws-glm-4.7", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.25 / 1000, creditSource: "estimated" },
    { id: "ws-glm-5", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 1.5 / 1000, creditSource: "estimated" },
    { id: "ws-glm-5.1", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 1.5 / 1000, creditSource: "estimated" },

    // ── SWE (Windsurf's own coding model) ──
    { id: "ws-swe-1.5", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.5 / 1000, creditSource: "estimated" },
    { id: "ws-swe-1.6", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.5 / 1000, creditSource: "estimated" },
    { id: "ws-swe-1.6-fast", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.5 / 1000, creditSource: "estimated" },

    // ── DeepSeek (via Windsurf) ──
    { id: "ws-deepseek-r1", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: true, vision: false, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },

    // ── MiniMax (via Windsurf) ──
    { id: "ws-minimax-m2.5", object: "model", created: Date.now(), owned_by: "windsurf", tier: "max", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "credit", creditRate: 1 / 1000, creditSource: "estimated" },
  ];

  private getTokens(account: Account): WindsurfTokens | null {
    if (!account.tokens) return null;
    try {
      const t =
        typeof account.tokens === "string"
          ? JSON.parse(account.tokens)
          : account.tokens;
      return t as WindsurfTokens;
    } catch {
      return null;
    }
  }

  /**
   * Strip "ws-" prefix from model ID to get the WindsurfAPI model name.
   * e.g. "ws-claude-opus-4.6" → "claude-opus-4.6"
   */
  private resolveUpstreamModel(model: string): string {
    if (model.startsWith("ws-")) {
      return model.slice(3);
    }
    return model;
  }

  /**
   * Get the WindsurfAPI base URL (from account tokens or global config)
   */
  private getUpstreamUrl(tokens: WindsurfTokens | null): string {
    return tokens?.windsurf_url || getBaseUrl();
  }

  /**
   * Get the API key for WindsurfAPI (from account tokens or global config)
   */
  private getUpstreamApiKey(tokens: WindsurfTokens | null): string {
    return tokens?.windsurf_api_key || getApiKey();
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    const baseUrl = this.getUpstreamUrl(tokens);
    const apiKey = this.getUpstreamApiKey(tokens);
    const upstreamModel = this.resolveUpstreamModel(request.model);

    const body = {
      ...request,
      model: upstreamModel,
      stream: false,
    };

    try {
      const response = await this.fetchWithTimeout(
        `${baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `WindsurfAPI HTTP ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMsg = errorJson?.error?.message || errorJson?.error || errorMsg;
        } catch {
          errorMsg = errorText.slice(0, 200) || errorMsg;
        }

        if (response.status === 429) {
          return { success: false, error: errorMsg, quotaExhausted: true };
        }
        if (response.status === 401 || response.status === 403) {
          return { success: false, error: `expired: ${errorMsg}` };
        }
        return { success: false, error: errorMsg };
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const usage = data.usage;

      return {
        success: true,
        response: data,
        promptTokens: usage?.prompt_tokens || 0,
        completionTokens: usage?.completion_tokens || 0,
        tokensUsed: usage?.total_tokens || 0,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("abort") || msg.includes("timeout")) {
        return { success: false, error: `Timeout: ${msg}` };
      }
      return { success: false, error: msg };
    }
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    const baseUrl = this.getUpstreamUrl(tokens);
    const apiKey = this.getUpstreamApiKey(tokens);
    const upstreamModel = this.resolveUpstreamModel(request.model);

    const body = {
      ...request,
      model: upstreamModel,
      stream: true,
    };

    try {
      const response = await this.fetchWithTimeout(
        `${baseUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `WindsurfAPI HTTP ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMsg = errorJson?.error?.message || errorJson?.error || errorMsg;
        } catch {
          errorMsg = errorText.slice(0, 200) || errorMsg;
        }

        if (response.status === 429) {
          return { success: false, error: errorMsg, quotaExhausted: true };
        }
        if (response.status === 401 || response.status === 403) {
          return { success: false, error: `expired: ${errorMsg}` };
        }
        return { success: false, error: errorMsg };
      }

      if (!response.body) {
        return { success: false, error: "No response body for stream" };
      }

      // Pass through the SSE stream directly from WindsurfAPI
      return {
        success: true,
        stream: response.body,
        promptTokens: 0,
        completionTokens: 0,
        tokensUsed: 0,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("abort") || msg.includes("timeout")) {
        return { success: false, error: `Timeout: ${msg}` };
      }
      return { success: false, error: msg };
    }
  }

  async refreshToken(
    account: Account
  ): Promise<{ success: boolean; tokens?: string; error?: string }> {
    // WindsurfAPI handles token refresh internally (Firebase token rotation)
    // We just verify the account is still accessible
    const tokens = this.getTokens(account);
    if (!tokens?.auth_token) {
      return { success: false, error: "No auth token available" };
    }

    // Re-add the token to WindsurfAPI (it will handle refresh)
    const result = await addAccountToWindsurf(
      tokens.auth_token,
      account.email
    );
    if (result.success) {
      return { success: true };
    }
    return { success: false, error: result.error };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    if (!tokens?.auth_token && !tokens?.windsurf_api_key) {
      return false;
    }
    return true;
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    try {
      const accounts = await getWindsurfAccounts();
      const tokens = this.getTokens(account);

      // Try to find matching account in WindsurfAPI
      const wsAccount = accounts.find(
        (a: any) =>
          a.email === account.email ||
          a.id === tokens?.windsurf_account_id
      );

      if (wsAccount) {
        // WindsurfAPI tracks credits per account
        const tier = wsAccount.tier || "unknown";
        const isProTier = tier === "pro";

        return {
          success: true,
          quota: {
            limit: isProTier ? 1500 : 50, // Windsurf Pro ~1500 credits/month
            remaining: isProTier ? 1000 : 25, // Estimated
            used: 0,
            resetAt: null,
          },
        };
      }

      // Fallback: assume healthy with default quota
      return {
        success: true,
        quota: {
          limit: 1500,
          remaining: 1000,
          used: 500,
          resetAt: null,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.auth_token && !tokens?.windsurf_api_key) {
      return {
        kind: "missing_tokens",
        success: false,
        error: "No auth token or API key",
      };
    }

    // Check if WindsurfAPI service is healthy
    const health = await checkHealth();
    if (!health) {
      return {
        kind: "transient_error",
        success: false,
        retryable: true,
        error: "WindsurfAPI service not reachable",
      };
    }

    // Check quota
    const quotaResult = await this.fetchQuota(account);
    if (quotaResult.success && quotaResult.quota) {
      if (quotaResult.quota.remaining <= 0) {
        return {
          kind: "exhausted",
          success: true,
          quota: { ...quotaResult.quota, source: "windsurf.fetchQuota" },
        };
      }
      return {
        kind: "healthy",
        success: true,
        quota: { ...quotaResult.quota, source: "windsurf.fetchQuota" },
      };
    }

    return {
      kind: "healthy",
      success: true,
    };
  }
}
