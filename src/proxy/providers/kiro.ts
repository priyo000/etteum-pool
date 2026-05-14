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
export class KiroProvider extends BaseProvider {
  name = "kiro";
  private baseUrl = "https://q.us-east-1.amazonaws.com";
  private refreshUrl =
    "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";

  supportedModels: ModelInfo[] = [
    // Kiro uses CREDIT-BASED billing (fractional credits per request).
    // Kiro sends real credit usage via meteringEvent and context usage via contextUsageEvent.
    // creditRate here is only used as fallback when upstream credits are unavailable.

    // Auto (1.0x baseline)
    { id: "auto", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.008 / 1000, creditSource: "estimated" },
    // Claude Haiku 4.5 (0.4x)
    { id: "claude-haiku-4.5", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.003 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4 (1.3x)
    { id: "claude-sonnet-4", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.010 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4.5 (1.3x)
    { id: "claude-sonnet-4.5", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.010 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4.5 Thinking (1.3x with extended thinking)
    { id: "claude-sonnet-4.5-thinking", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.013 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4.6 (1.5x)
    { id: "claude-sonnet-4.6", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
    // Claude Sonnet 4.6 Thinking (1.5x with extended thinking)
    { id: "claude-sonnet-4.6-thinking", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.015 / 1000, creditSource: "estimated" },
    // DeepSeek 3.2 (0.25x)
    { id: "deepseek-3.2", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 164000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.002 / 1000, creditSource: "estimated" },
    // GLM-5 (0.5x)
    { id: "glm-5", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 200000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.004 / 1000, creditSource: "estimated" },
    // GLM-5 Thinking (0.5x with thinking)
    { id: "glm-5-thinking", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: false, creditUnit: "credit", creditRate: 0.005 / 1000, creditSource: "estimated" },
    // MiniMax M2.1 (0.15x)
    { id: "minimax-m2.1", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 196000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.001 / 1000, creditSource: "estimated" },
    // MiniMax M2.5 (0.25x)
    { id: "minimax-m2.5", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 196000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.002 / 1000, creditSource: "estimated" },
    // Qwen3 Coder Next (0.05x)
    { id: "qwen3-coder-next", object: "model", created: Date.now(), owned_by: "kiro", tier: "standard", context_window: 256000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 0.0004 / 1000, creditSource: "estimated" },
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

  private textFromContent(content: ChatCompletionRequest["messages"][number]["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block: any) => {
        if (block?.type === "text") return block.text || "";
        if (block?.type === "tool_result") return typeof block.content === "string" ? block.content : JSON.stringify(block.content || "");
        // Skip image blocks here — they are handled separately via contentBlocks
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  /** Extract image blocks from OpenAI-format content array for Kiro API.
   *  Kiro expects: [{ format: "png", source: { bytes: "<base64>" } }]
   *  (flat list, no wrapping "image" key — matches native Kiro IDE format)
   */
  private extractImageBlocks(content: any): any[] {
    if (!Array.isArray(content)) return [];
    const images: any[] = [];
    for (const block of content) {
      if (block?.type === "image_url" && block.image_url?.url) {
        const url: string = block.image_url.url;
        // Handle base64 data URLs: data:image/png;base64,<data>
        const dataMatch = url.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
        if (dataMatch) {
          const format = dataMatch[1] === "jpg" ? "jpeg" : dataMatch[1];
          images.push({ format, source: { bytes: dataMatch[2] } });
        }
      }
      // Anthropic-style image block: { type: "image", source: { type: "base64", media_type, data } }
      if (block?.type === "image" && block.source?.data) {
        const format = (block.source.media_type || "image/png").replace("image/", "").replace("jpg", "jpeg");
        images.push({ format, source: { bytes: block.source.data } });
      }
    }
    return images;
  }

  /** Check if content array contains image blocks */
  private hasImages(content: any): boolean {
    if (!Array.isArray(content)) return false;
    return content.some((block: any) => block?.type === "image_url" || block?.type === "image");
  }

  private mapTools(tools: any[] | undefined): any[] {
    return (tools || [])
      .map((tool) => {
        const fn = tool?.function || tool;
        const name = fn?.name || tool?.name || tool?.id;
        if (!name) return null;
        const schema = fn?.parameters || fn?.input_schema || fn?.schema || { type: "object", properties: {} };
        return {
          toolSpecification: {
            name: String(name).slice(0, 64),
            description: String(fn?.description || tool?.description || "").slice(0, 10000),
            inputSchema: { json: this.sanitizeJsonSchema(schema) },
          },
        };
      })
      .filter(Boolean);
  }

  private sanitizeJsonSchema(schema: any): any {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
    const clone: any = { ...schema };
    for (const key of ["$schema", "$id", "$comment", "$defs", "definitions", "propertyNames"]) delete clone[key];
    if (!clone.type) clone.type = "object";
    if (clone.type === "object" && (!clone.properties || typeof clone.properties !== "object")) clone.properties = {};
    if (clone.required && !Array.isArray(clone.required)) delete clone.required;
    return clone;
  }

  private extractToolResults(messages: ChatCompletionRequest["messages"]): any[] {
    const results: any[] = [];
    for (const message of messages) {
      if (message.role !== "user" || !Array.isArray(message.content)) continue;
      for (const block of message.content as any[]) {
        if (block?.type !== "tool_result" || !block.tool_use_id) continue;
        results.push({
          toolUseId: block.tool_use_id,
          content: [{ text: typeof block.content === "string" ? block.content : JSON.stringify(block.content || "") }],
          status: block.is_error ? "error" : "success",
        });
      }
    }
    return results;
  }

  private toolResultsFromContent(content: ChatCompletionRequest["messages"][number]["content"]): any[] {
    if (!Array.isArray(content)) return [];
    return (content as any[])
      .filter((block) => block?.type === "tool_result" && block.tool_use_id)
      .map((block) => ({
        toolUseId: block.tool_use_id,
        content: [{ text: typeof block.content === "string" ? block.content : JSON.stringify(block.content || "") }],
        status: block.is_error ? "error" : "success",
      }));
  }

  private toolUsesFromMessage(message: ChatCompletionRequest["messages"][number]): any[] {
    const uses: any[] = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content as any[]) {
        if (block?.type !== "tool_use" || !block.id || !block.name) continue;
        uses.push({ toolUseId: block.id, name: block.name, input: block.input || {} });
      }
    }
    for (const call of message.tool_calls || []) {
      let input = call?.function?.arguments || {};
      if (typeof input === "string") {
        try { input = JSON.parse(input); } catch { input = {}; }
      }
      if (call.id && call?.function?.name) uses.push({ toolUseId: call.id, name: call.function.name, input });
    }
    return uses;
  }

  private buildHistory(messages: ChatCompletionRequest["messages"], modelId: string): any[] {
    const history: any[] = [];
    const priorMessages = messages.slice(0, -1).filter((message) => message.role !== "system");
    for (const message of priorMessages) {
      if (message.role === "user") {
        const toolResults = this.toolResultsFromContent(message.content);
        history.push({
          userInputMessage: {
            content: this.textFromContent(message.content),
            modelId,
            origin: "AI_EDITOR",
            userInputMessageContext: toolResults.length > 0 ? { toolResults } : { tools: [] },
          },
        });
      } else if (message.role === "assistant") {
        const toolUses = this.toolUsesFromMessage(message);
        history.push({
          assistantResponseMessage: {
            content: this.textFromContent(message.content),
            ...(toolUses.length > 0 ? { toolUses } : {}),
          },
        });
      }
    }
    return history;
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
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
        return { success: false, error: "Rate limited / quota exhausted", quotaExhausted: true };
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
        return { success: false, error: "Rate limited / quota exhausted", quotaExhausted: true };
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
        return {
          kind: quota.remaining <= 0 ? "exhausted" : "healthy",
          success: true,
          quota,
          tokens: refreshedTokens || undefined,
          metadata: { authRefreshed: Boolean(refreshedTokens) },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "transient_error", success: false, retryable: true, error: message };
      }
    }

    return { kind: "session_expired", success: false, error: "Kiro session expired" };
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
      return {
        limit: totalCredits,
        remaining: Math.max(0, totalCredits - totalUsage),
        used: totalUsage,
        resetAt,
        source: "kiro.getUsageLimits",
        raw: {
          subscriptionType: root.subscriptionType || root.subscription_type,
          subscriptionTitle: root.subscriptionTitle || root.subscription_title,
          daysUntilReset: root.daysUntilReset || root.days_until_reset,
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

    const lastUser = [...request.messages].reverse().find((m) => m.role === "user");
    const systemPrompt = this.textFromContent(request.messages.find((m) => m.role === "system")?.content || "");
    const conversationId = crypto.randomUUID();
    const tools = this.mapTools(request.tools);
    const toolResults = this.toolResultsFromContent(lastUser?.content || "");
    const history = this.buildHistory(request.messages, actualModel);
    const context: Record<string, unknown> = { tools };
    if (toolResults.length > 0) context.toolResults = toolResults;

    const userTextContent = this.textFromContent(lastUser?.content || "");
    const imageBlocks = this.extractImageBlocks(lastUser?.content || "").slice(0, 10);
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
    const events = this.decodeAwsEventStream(bytes);

    if (events.length > 0) {
      content = this.extractKiroText(events);
      const toolCalls = this.extractKiroToolCalls(events);
      upstreamCreditsUsed = this.extractKiroCredits(events);
      if (!content.trim() && toolCalls.length === 0) {
        return { success: false, error: "Kiro returned no assistant content" };
      }

      // Kiro doesn't send token counts directly. Use contextUsagePercentage for total tokens.
      const contextTokens = this.extractKiroContextTokens(events, model);
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

  private decodeAwsEventStream(bytes: Uint8Array): Array<{ headers: Record<string, string>; payload: any }> {
    const events: Array<{ headers: Record<string, string>; payload: any }> = [];
    let offset = 0;
    const decoder = new TextDecoder();

    const readU32 = (pos: number) =>
      ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0;
    const readU16 = (pos: number) => (bytes[pos]! << 8) | bytes[pos + 1]!;

    while (offset + 16 <= bytes.length) {
      const totalLen = readU32(offset);
      const headersLen = readU32(offset + 4);
      if (totalLen <= 16 || offset + totalLen > bytes.length) break;

      // Validate prelude CRC. Some runtimes prepend bytes before the first event;
      // if this offset is not a valid event, shift forward until one is found.
      const expectedPreludeCrc = readU32(offset + 8);
      const actualPreludeCrc = this.crc32(bytes.slice(offset, offset + 8));
      if (expectedPreludeCrc !== actualPreludeCrc) {
        offset++;
        continue;
      }

      const headers: Record<string, string> = {};
      let h = offset + 12;
      const headersEnd = h + headersLen;
      while (h < headersEnd) {
        const nameLen = bytes[h++]!;
        const name = decoder.decode(bytes.slice(h, h + nameLen));
        h += nameLen;
        const type = bytes[h++]!;
        if (type === 7) {
          const valueLen = readU16(h);
          h += 2;
          headers[name] = decoder.decode(bytes.slice(h, h + valueLen));
          h += valueLen;
        } else {
          break;
        }
      }

      const payloadStart = offset + 12 + headersLen;
      const payloadEnd = offset + totalLen - 4;
      const payloadText = decoder.decode(bytes.slice(payloadStart, payloadEnd));
      let payload: any = payloadText;
      try { payload = JSON.parse(payloadText); } catch { /* keep text */ }
      events.push({ headers, payload });
      offset += totalLen;
    }

    return events;
  }

  private createLiveStreamResponse(response: Response, model: string): ProviderResult {
    const id = this.generateId();
    const encoder = new TextEncoder();
    const extractCreditsRef = this.extractKiroCredits.bind(this);
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = response.body?.getReader();
        if (!reader) { controller.close(); return; }
        let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
        const toolIndexes = new Map<string, number>();
        const toolBuffers = new Map<string, string>();
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
            buffer = this.concatBytes(buffer, value as Uint8Array);
            const parsed = this.readEventStreamFrames(buffer);
            buffer = parsed.remaining;
            for (const event of parsed.events) {
              allEvents.push(event);
              const eventType = event.headers[":event-type"];
              const payload = this.unwrapKiroEvent(event.payload, eventType);
              if (event.headers[":message-type"] === "error" || event.headers[":message-type"] === "exception") {
                throw new Error(typeof payload === "string" ? payload : payload?.message || event.headers[":error-code"] || "Kiro stream error");
              }
              const text = this.extractEventText(payload, eventType);
              if (text) { streamedContentLength += text.length; enqueue({ content: text }); }
              const tool = payload?.toolUseEvent || (eventType === "toolUseEvent" ? payload : null);
              if (tool?.toolUseId && (tool?.name || toolIndexes.has(tool.toolUseId))) {
                const isFirstChunk = !toolIndexes.has(tool.toolUseId);
                if (isFirstChunk && !tool.name) {
                  // Can't start a tool call without a name — skip
                } else {
                  if (isFirstChunk) toolIndexes.set(tool.toolUseId, nextToolIndex++);
                  const toolIdx = toolIndexes.get(tool.toolUseId)!;
                  const args = typeof tool.input === "string" ? tool.input : tool.input && Object.keys(tool.input).length > 0 ? JSON.stringify(tool.input) : "";
                  if (isFirstChunk) {
                    // First chunk: include id, type, and function name
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
                    // Subsequent chunks: only index and arguments delta
                    toolBuffers.set(tool.toolUseId, (toolBuffers.get(tool.toolUseId) || "") + args);
                    enqueue({
                      tool_calls: [{
                        index: toolIdx,
                        function: { arguments: args },
                      }],
                    });
                  }
                  if (tool.stop === true) {
                    const buffered = toolBuffers.get(tool.toolUseId) || "";
                    if (buffered && !this.isCompleteJson(buffered)) {
                      const suffix = this.completeJsonSuffix(buffered);
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
          // Extract real usage from Kiro's contextUsageEvent and meteringEvent
          const totalTokens = this.extractKiroContextTokens(allEvents, model);
          const creditsUsed = extractCreditsRef(allEvents);
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

  private concatBytes(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  private readEventStreamFrames(bytes: Uint8Array<ArrayBufferLike>): { events: Array<{ headers: Record<string, string>; payload: any }>; remaining: Uint8Array<ArrayBufferLike> } {
    let offset = 0;
    const events: Array<{ headers: Record<string, string>; payload: any }> = [];
    const readU32 = (pos: number) => ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0;
    while (offset + 16 <= bytes.length) {
      const totalLen = readU32(offset);
      if (totalLen <= 16) { offset += 1; continue; }
      if (offset + totalLen > bytes.length) break;
      const frame = bytes.slice(offset, offset + totalLen);
      const decoded = this.decodeAwsEventStream(frame);
      events.push(...decoded);
      offset += totalLen;
    }
    return { events, remaining: new Uint8Array(bytes.slice(offset)) };
  }

  private extractEventText(payload: any, eventType?: string): string {
    if (!payload || typeof payload !== "object") return "";
    if (eventType && !/assistant|response|text|content/i.test(eventType)) return "";
    return typeof payload.content === "string" ? payload.content : typeof payload.text === "string" ? payload.text : typeof payload.delta === "string" ? payload.delta : "";
  }

  private isCompleteJson(value: string): boolean {
    try { JSON.parse(value); return true; } catch { return false; }
  }

  private completeJsonSuffix(value: string): string {
    const openBraces = (value.match(/\{/g) || []).length - (value.match(/\}/g) || []).length;
    const openBrackets = (value.match(/\[/g) || []).length - (value.match(/\]/g) || []).length;
    const quoteCount = (value.match(/(?<!\\)"/g) || []).length;
    return `${quoteCount % 2 === 1 ? '"' : ""}${"]".repeat(Math.max(0, openBrackets))}${"}".repeat(Math.max(0, openBraces))}`;
  }

  private crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  private extractKiroText(events: Array<{ payload: any }>): string {
    const parts: string[] = [];
    const visit = (value: any) => {
      if (!value) return;
      if (typeof value === "string") return;
      if (Array.isArray(value)) return value.forEach(visit);
      if (typeof value !== "object") return;

      for (const key of ["content", "text", "delta"]) {
        if (typeof value[key] === "string") parts.push(value[key]);
      }
      for (const key of Object.keys(value)) visit(value[key]);
    };
    for (const event of events) visit(event.payload);
    return [...new Set(parts)].join("");
  }

  private extractKiroToolCalls(events: Array<{ headers: Record<string, string>; payload: any }>): any[] {
    const calls = new Map<string, { id: string; name: string; arguments: string }>();
    for (const event of events) {
      const payload = this.unwrapKiroEvent(event.payload, event.headers[":event-type"]);
      const tool = payload?.toolUseEvent || payload;
      if (!tool || typeof tool !== "object") continue;
      const id = tool.toolUseId || tool.id;
      const name = tool.name;
      if (!id || !name) continue;
      const existing = calls.get(id) || { id, name, arguments: "" };
      if (typeof tool.input === "string") existing.arguments += tool.input;
      else if (tool.input && typeof tool.input === "object") existing.arguments += JSON.stringify(tool.input);
      calls.set(id, existing);
    }
    return [...calls.values()].map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
  }

  private unwrapKiroEvent(payload: any, eventType?: string): any {
    if (!payload || typeof payload !== "object") return payload;
    if (eventType && payload[eventType]) return payload[eventType];
    for (const key of ["assistantResponseEvent", "toolUseEvent", "messageMetadataEvent", "metadataEvent", "meteringEvent"]) {
      if (payload[key]) return payload[key];
    }
    return payload;
  }

  private extractKiroCredits(events: Array<{ payload: any }>): number {
    let credits = 0;
    const visit = (value: any) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.usage === "number" && (value.unit === "credit" || value.unitPlural === "credits")) {
        credits += value.usage;
      }
      if (typeof value.creditsUsed === "number") credits += value.creditsUsed;
      for (const key of Object.keys(value)) visit(value[key]);
    };
    for (const event of events) visit(event.payload);
    return credits;
  }

  /**
   * Extract total token count from Kiro's contextUsageEvent.
   * Kiro sends `contextUsagePercentage` which represents the % of context window used.
   * We convert this to an approximate token count using the model's context_window size.
   */
  private extractKiroContextTokens(events: Array<{ payload: any }>, model: string): number {
    let contextPercentage = 0;
    for (const event of events) {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") continue;
      // Direct field
      if (typeof payload.contextUsagePercentage === "number") {
        contextPercentage = Math.max(contextPercentage, payload.contextUsagePercentage);
      }
      // Nested in contextUsageEvent
      if (payload.contextUsageEvent && typeof payload.contextUsageEvent.contextUsagePercentage === "number") {
        contextPercentage = Math.max(contextPercentage, payload.contextUsageEvent.contextUsagePercentage);
      }
    }
    if (contextPercentage <= 0) return 0;
    const modelInfo = this.getModelInfo(model);
    const contextWindow = modelInfo?.context_window || 200000;
    return Math.round((contextPercentage / 100) * contextWindow);
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
