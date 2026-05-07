import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import { applyPudidilFilters } from "../filters";

interface CodeBuddyTokens {
  api_key?: string;
  access_token?: string;
  refresh_token?: string;
  session_token?: string;
  csrf_token?: string;
  cookies?: string;
  web_cookie?: string;
}

/**
 * CodeBuddy Provider - MAX tier
 * Supports Claude Opus, GPT-5.x, Gemini, DeepSeek, Kimi models
 */
export class CodeBuddyProvider extends BaseProvider {
  name = "codebuddy";
  private baseUrl = "https://www.codebuddy.ai";

  supportedModels: ModelInfo[] = [
    // Credit rates derived from confirmed data point:
    //   claude-opus-4.6 = 6.97 credits / 260,613 tokens = 0.02674 credits/1K tokens
    // Other models estimated from upstream API pricing ratios relative to opus-4.6.
    // Upstream prices ($/M tokens): opus=$5/$25, gpt-5.5=$5/$30, gpt-5.1=$1.25/$10,
    //   gemini-2.5-pro=$1.25/$10, gemini-flash=$0.30/$2.50, deepseek=$0.14/$0.28
    // 1 CodeBuddy credit ≈ $0.01 passthrough.

    // Claude Opus 4.6 — confirmed: 0.02674/1K
    { id: "claude-opus-4.6", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "token", creditRate: 0.027 / 1000, creditSource: "estimated" },
    // DeepSeek V3.2 — upstream ~$0.14/$0.28/M → ~0.002/1K
    { id: "deepseek-v3-2-volc", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: false, vision: false, creditUnit: "token", creditRate: 0.002 / 1000, creditSource: "estimated" },
    // enowx-default — mid-tier estimate
    { id: "enowx-default", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: false, vision: true, creditUnit: "token", creditRate: 0.01 / 1000, creditSource: "estimated" },
    // Gemini 2.5 Flash — upstream ~$0.30/$2.50/M → ~0.003/1K
    { id: "gemini-2.5-flash", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.003 / 1000, creditSource: "estimated" },
    // Gemini 2.5 Pro — upstream ~$1.25/$10/M → ~0.012/1K
    { id: "gemini-2.5-pro", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.012 / 1000, creditSource: "estimated" },
    // Gemini 3.0 Flash — similar to 2.5 flash → ~0.004/1K
    { id: "gemini-3.0-flash", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: false, vision: true, creditUnit: "token", creditRate: 0.004 / 1000, creditSource: "estimated" },
    // Gemini 3.1 Flash Lite — cheapest gemini → ~0.002/1K
    { id: "gemini-3.1-flash-lite", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: false, vision: true, creditUnit: "token", creditRate: 0.002 / 1000, creditSource: "estimated" },
    // Gemini 3.1 Pro — upstream ~$2/$12/M → ~0.015/1K
    { id: "gemini-3.1-pro", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: false, vision: true, creditUnit: "token", creditRate: 0.015 / 1000, creditSource: "estimated" },
    // GPT-5.1 — upstream ~$1.25/$10/M → ~0.012/1K
    { id: "gpt-5.1", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.012 / 1000, creditSource: "estimated" },
    // GPT-5.1 Codex — same tier as 5.1 → ~0.012/1K
    { id: "gpt-5.1-codex", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.012 / 1000, creditSource: "estimated" },
    // GPT-5.1 Codex Max — premium codex → ~0.025/1K
    { id: "gpt-5.1-codex-max", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.025 / 1000, creditSource: "estimated" },
    // GPT-5.1 Codex Mini — upstream ~$0.25/$2/M → ~0.003/1K
    { id: "gpt-5.1-codex-mini", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.003 / 1000, creditSource: "estimated" },
    // GPT-5.2 — upstream ~$1.75/$14/M → ~0.016/1K
    { id: "gpt-5.2", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.016 / 1000, creditSource: "estimated" },
    // GPT-5.2 Codex — same as 5.2 → ~0.016/1K
    { id: "gpt-5.2-codex", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.016 / 1000, creditSource: "estimated" },
    // GPT-5.3 Codex — upstream ~$2.50/$10/M → ~0.013/1K
    { id: "gpt-5.3-codex", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.013 / 1000, creditSource: "estimated" },
    // GPT-5.4 — upstream ~$2.50/$15/M → ~0.018/1K
    { id: "gpt-5.4", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.018 / 1000, creditSource: "estimated" },
    // GPT-5.5 — upstream ~$5/$30/M → ~0.035/1K (most expensive GPT)
    { id: "gpt-5.5", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: true, vision: true, creditUnit: "token", creditRate: 0.035 / 1000, creditSource: "estimated" },
    // Kimi K2.5 — mid-tier Chinese model → ~0.005/1K
    { id: "kimi-k2.5", object: "model", created: Date.now(), owned_by: "codebuddy", tier: "max", thinking: false, vision: false, creditUnit: "token", creditRate: 0.005 / 1000, creditSource: "estimated" },
  ];

  private getTokens(account: Account): CodeBuddyTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string"
        ? JSON.parse(account.tokens)
        : account.tokens;
      return t as CodeBuddyTokens;
    } catch {
      return null;
    }
  }

  private normalizeTools(tools: any[] | undefined): any[] {
    if (!tools || tools.length === 0) return [];

    return tools.map((tool) => {
      // If already in OpenAI format, return as-is
      if (tool.type === "function" && tool.function) {
        return tool;
      }

      // Convert Anthropic/Claude format to OpenAI format
      const fn = tool.function || tool;
      const name = fn?.name || tool?.name;
      const description = fn?.description || tool?.description || "";
      const parameters = fn?.parameters || fn?.input_schema || { type: "object", properties: {} };

      return {
        type: "function",
        function: {
          name,
          description,
          parameters: this.sanitizeToolSchema(parameters),
        },
      };
    }).filter(t => t.function?.name);
  }

  private sanitizeToolSchema(schema: any): any {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return { type: "object", properties: {} };
    }

    const clone: any = { ...schema };

    // Remove unsupported JSON Schema fields
    for (const key of ["$schema", "$id", "$comment", "$defs", "definitions"]) {
      delete clone[key];
    }

    // Ensure type is set
    if (!clone.type) clone.type = "object";

    // Ensure properties exists for object types
    if (clone.type === "object" && !clone.properties) {
      clone.properties = {};
    }

    // Ensure required is an array if present
    if (clone.required && !Array.isArray(clone.required)) {
      delete clone.required;
    }

    return clone;
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) {
      return { success: false, error: "No tokens available" };
    }

    try {
      const response = await this.makeRequest(tokens, request, false);

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: "Session expired, re-login required" };
      }

      if (response.status === 429) {
        return { success: false, error: "Rate limited / quota exhausted", quotaExhausted: true };
      }

      if (!response.ok) {
        const errText = await response.text();
        // Detect Chinese content moderation error and translate
        if (errText.includes("敏感内容") || errText.includes("系统检测到")) {
          return {
            success: false,
            error: "Content moderation: Your input was flagged as potentially sensitive. Please rephrase your message."
          };
        }
        return { success: false, error: `CodeBuddy API error (${response.status}): ${errText}` };
      }

      return this.parseResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `CodeBuddy request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) {
      return { success: false, error: "No tokens available" };
    }

    try {
      const response = await this.makeRequest(tokens, request, true);

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: "Session expired" };
      }

      if (response.status === 429) {
        return { success: false, error: "Rate limited", quotaExhausted: true };
      }

      if (!response.ok) {
        const errText = await response.text();
        // Detect Chinese content moderation error and translate
        if (errText.includes("敏感内容") || errText.includes("系统检测到")) {
          return {
            success: false,
            error: "Content moderation: Your input was flagged as potentially sensitive. Please rephrase your message."
          };
        }
        return { success: false, error: `CodeBuddy API error (${response.status}): ${errText}` };
      }

      return this.createStreamResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `CodeBuddy stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async refreshToken(
    _account: Account
  ): Promise<{ success: boolean; tokens?: string; error?: string }> {
    // CodeBuddy doesn't support token refresh - requires re-login
    return { success: false, error: "CodeBuddy requires re-login" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!(tokens?.api_key || tokens?.access_token || tokens?.session_token || tokens?.web_cookie);
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens) {
      return { success: false, error: "No tokens available" };
    }

    try {
      const response = await this.fetchUserResource(tokens);

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      if (data.code !== 0) {
        return { success: false, error: `API error code ${data.code}` };
      }

      return { success: true, quota: this.parseResourceQuota(data) };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const tokens = this.getTokens(account);
    if (!tokens || !this.hasUsableAuth(tokens)) {
      return { kind: "missing_tokens", success: false, error: "No CodeBuddy tokens or cookies available" };
    }

    // The only source of truth: can this account make actual API requests?
    const apiStatus = await this.validateApiKey(tokens);

    if (apiStatus === "ok") {
      // API works - account is healthy. Try billing for credit info (best-effort).
      const quota = await this.fetchQuota(account);
      if (quota.success && quota.quota) {
        return {
          kind: quota.quota.remaining <= 0 ? "exhausted" : "healthy",
          success: true,
          quota: { ...quota.quota, source: "codebuddy.get-user-resource" },
        };
      }
      // Billing failed but API works - use stored quota, account is healthy
      const storedQuota = Number(account.quotaRemaining || 0);
      const storedLimit = Number(account.quotaLimit || 0);
      return {
        kind: "healthy",
        success: true,
        quota: storedLimit > 0
          ? { limit: storedLimit, remaining: storedQuota, used: storedLimit - storedQuota, source: "tracked" }
          : undefined,
        message: `API key valid. Credit: ${storedQuota.toFixed(1)}/${storedLimit.toFixed(1)} (tracked)`,
      };
    }

    if (apiStatus === "quota_exhausted") {
      return { kind: "exhausted", success: true, error: "Provider returned 429 - quota exhausted" };
    }

    // API returned 401/403 - truly expired
    return {
      kind: "session_expired",
      success: false,
      error: "CodeBuddy API returned 401/403 - session expired, re-login required",
    };
  }

  /**
   * Check if the api_key can make actual requests to the provider.
   * Uses stream: true and aborts immediately after HTTP status to avoid consuming quota.
   * Returns: "ok" | "quota_exhausted" | "expired"
   */
  private async validateApiKey(tokens: CodeBuddyTokens): Promise<"ok" | "quota_exhausted" | "expired"> {
    const apiKey = tokens.api_key || tokens.access_token || tokens.session_token;
    if (!apiKey) return "expired";

    const controller = new AbortController();
    try {
      const response = await fetch(`${this.baseUrl}/v2/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 100,
          stream: true,
        }),
      });

      // Got HTTP status - abort immediately to avoid consuming tokens
      controller.abort();

      if (response.status === 401 || response.status === 403) return "expired";
      if (response.status === 429) return "quota_exhausted";
      return "ok";
    } catch (err: any) {
      // AbortError is expected (we aborted on purpose after getting status)
      if (err?.name === "AbortError") return "ok";
      // Network error - assume ok to avoid false negatives
      return "ok";
    }
  }

  // Dead code below kept for reference - the old fallback path
  private async _legacyHealthCheckFallback(_account: Account, _tokens: any, _quota: any, session: any, accountStatus: any): Promise<ProviderHealthResult> {
    const normalizedQuota = _quota.quota
      ? { ..._quota.quota, source: "codebuddy.get-user-resource" }
      : undefined;

    return {
      kind: normalizedQuota && normalizedQuota.remaining <= 0 ? "exhausted" : "healthy",
      success: true,
      quota: normalizedQuota,
      metadata: {
        session: session.metadata,
        accountStatus: accountStatus.metadata,
      },
    };
  }

  private hasUsableAuth(tokens: CodeBuddyTokens): boolean {
    return Boolean(tokens.api_key || tokens.access_token || tokens.session_token || tokens.web_cookie || tokens.cookies);
  }

  private buildAuthHeaders(tokens: CodeBuddyTokens, json = true): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    if (json) headers["Content-Type"] = "application/json";

    const apiKey = tokens.api_key || tokens.access_token || tokens.session_token;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (tokens.web_cookie) headers.Cookie = tokens.web_cookie;
    else if (tokens.cookies) headers.Cookie = tokens.cookies;
    if (tokens.csrf_token) headers["X-CSRF-Token"] = tokens.csrf_token;
    return headers;
  }

  private async fetchUserResource(tokens: CodeBuddyTokens): Promise<Response> {
    const now = new Date();
    const endDate = new Date(now.getTime() + 365 * 20 * 24 * 60 * 60 * 1000);
    const payload = {
      PageNumber: 1,
      PageSize: 100,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      PackageEndTimeRangeBegin: now.toISOString().replace("T", " ").slice(0, 19),
      PackageEndTimeRangeEnd: endDate.toISOString().replace("T", " ").slice(0, 19),
    };

    return this.fetchWithTimeout(`${this.baseUrl}/billing/meter/get-user-resource`, {
      method: "POST",
      headers: this.buildAuthHeaders(tokens),
      body: JSON.stringify(payload),
    }, config.providerQuotaTimeoutMs);
  }

  private parseResourceQuota(data: any): { limit: number; remaining: number; used: number } {
    const responseData = data.data?.Response?.Data || {};
    const totalDosage = Number(responseData.TotalDosage || 0);
    const resourceAccounts = Array.isArray(responseData.Accounts) ? responseData.Accounts : [];
    let totalRemain = 0;
    let totalUsed = 0;
    let totalSize = 0;

    for (const acct of resourceAccounts) {
      totalRemain += Number(acct.CapacityRemain || 0);
      totalUsed += Number(acct.CapacityUsed || 0);
      totalSize += Number(acct.CapacitySize || 0);
    }

    const limit = totalSize || totalDosage || totalRemain + totalUsed;
    const remaining = totalRemain;
    const used = totalUsed || Math.max(0, limit - remaining);
    return { limit, remaining, used };
  }

  private async validateSessionRemote(tokens: CodeBuddyTokens): Promise<{ kind: "healthy" | "session_expired" | "banned" | "transient_error"; error?: string; metadata?: Record<string, unknown> }> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/console/validate/refresh-token`, {
        method: "GET",
        headers: this.buildAuthHeaders(tokens, false),
      }, Math.min(config.providerQuotaTimeoutMs, 10_000));
      const text = await response.text();
      const payload = this.safeJson(text);
      const body = text.toLowerCase();

      if (this.isBannedPayload(payload) || /banned|disabled|suspended|no-permission|no-client-author/i.test(body)) {
        return { kind: "banned", error: "CodeBuddy account appears banned or disabled", metadata: { status: response.status } };
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: "session_expired", error: `CodeBuddy session validation HTTP ${response.status}`, metadata: { status: response.status } };
      }
      if (response.status === 429 || response.status >= 500) {
        return { kind: "transient_error", error: `CodeBuddy session validation HTTP ${response.status}`, metadata: { status: response.status } };
      }
      if (payload && typeof payload === "object" && "code" in payload && Number((payload as any).code) !== 0) {
        return { kind: "session_expired", error: `CodeBuddy session validation code ${(payload as any).code}`, metadata: { status: response.status, code: (payload as any).code } };
      }
      return { kind: "healthy", metadata: { status: response.status, code: payload?.code } };
    } catch (error) {
      return { kind: "transient_error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async fetchConsoleAccounts(tokens: CodeBuddyTokens): Promise<{ kind: "healthy" | "session_expired" | "banned" | "transient_error"; error?: string; metadata?: Record<string, unknown> }> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/console/accounts`, {
        method: "GET",
        headers: this.buildAuthHeaders(tokens, false),
      }, Math.min(config.providerQuotaTimeoutMs, 10_000));
      const text = await response.text();
      const payload = this.safeJson(text);
      const body = text.toLowerCase();
      if (this.isBannedPayload(payload) || /banned|disabled|suspended|no-permission|no-client-author/i.test(body)) {
        return { kind: "banned", error: "CodeBuddy console account appears banned or disabled", metadata: { status: response.status } };
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: "session_expired", error: `CodeBuddy console accounts HTTP ${response.status}`, metadata: { status: response.status } };
      }
      if (response.status === 429 || response.status >= 500) {
        return { kind: "transient_error", error: `CodeBuddy console accounts HTTP ${response.status}`, metadata: { status: response.status } };
      }
      return { kind: "healthy", metadata: { status: response.status, code: payload?.code, accounts: payload?.data?.accounts?.length } };
    } catch (error) {
      return { kind: "transient_error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private safeJson(text: string): any {
    try { return JSON.parse(text); } catch { return null; }
  }

  private isBannedPayload(value: any): boolean {
    if (!value || typeof value !== "object") return false;
    const text = JSON.stringify(value).toLowerCase();
    return /banned|disabled|suspended|no-permission|no-client-author/.test(text);
  }

  private async makeRequest(
    tokens: CodeBuddyTokens,
    request: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Accept": stream ? "text/event-stream, application/json, */*" : "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Conversation-ID": crypto.randomUUID(),
      "X-Conversation-Request-ID": crypto.randomUUID().replace(/-/g, ""),
      "X-Conversation-Message-ID": crypto.randomUUID().replace(/-/g, ""),
      "X-Request-ID": crypto.randomUUID().replace(/-/g, ""),
      "X-Domain": "www.codebuddy.ai",
      "X-Product": "SaaS",
      // Use browser-like User-Agent to avoid stricter content moderation for CLI/Agent traffic
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };

    const apiKey = tokens.api_key || tokens.access_token || tokens.session_token;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
      headers["X-Api-Key"] = apiKey;
    }

    // Use cookies if available
    if (tokens.web_cookie) {
      headers["Cookie"] = tokens.web_cookie;
    } else if (tokens.cookies) {
      headers["Cookie"] = tokens.cookies;
    }

    if (tokens.csrf_token) {
      headers["X-CSRF-Token"] = tokens.csrf_token;
    }

    // Handle -thinking suffix
    const isThinking = request.model.endsWith("-thinking");
    const actualModel = isThinking ? request.model.replace("-thinking", "") : request.model;

    // Clean messages: convert Anthropic format to OpenAI format for CodeBuddy API
    // Apply pudidil filters to remove Claude Code CLI detection patterns
    const cleanedMessages: any[] = [];

    for (const msg of request.messages) {
      let content = msg.content;

      if (typeof content === "string") {
        // Apply pudidil filters to remove detection patterns (same as enowxai)
        // Keeps the rest of the system prompt intact (CLAUDE.md, tools, environment, etc.)
        cleanedMessages.push({
          ...msg,
          content: applyPudidilFilters(content),
        });
        continue;
      }

      // If content is an array, convert to OpenAI format
      if (Array.isArray(content)) {
        const hasToolUse = content.some((block: any) => block.type === "tool_use");
        const hasToolResult = content.some((block: any) => block.type === "tool_result");

        // For assistant messages with tool_use, convert to OpenAI tool_calls format
        if (msg.role === "assistant" && hasToolUse) {
          const textBlocks = content.filter((block: any) => block.type === "text");
          const toolUseBlocks = content.filter((block: any) => block.type === "tool_use");

          const textContent = textBlocks
            .map((block: any) => block.text || "")
            .filter(Boolean)
            .join("\n");

          const tool_calls = toolUseBlocks.map((block: any) => ({
            id: block.id || crypto.randomUUID(),
            type: "function",
            function: {
              name: block.name || "",
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input || {}),
            },
          }));

          cleanedMessages.push({
            role: msg.role,
            content: applyPudidilFilters(textContent || ""),
            tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
          });
          continue;
        }

        // For user messages with tool_result, convert to OpenAI tool message format
        // Split into separate messages: one for text, one for each tool result
        if (msg.role === "user" && hasToolResult) {
          const toolResults = content.filter((block: any) => block.type === "tool_result");
          const textBlocks = content.filter((block: any) => block.type === "text");

          // Add each tool result as a separate tool message FIRST
          for (const toolResult of toolResults) {
            const resultContent = typeof toolResult.content === "string"
              ? toolResult.content
              : Array.isArray(toolResult.content)
                ? toolResult.content.map((c: any) => c.text || "").join("\n")
                : JSON.stringify(toolResult.content || "");

            cleanedMessages.push({
              role: "tool",
              tool_call_id: toolResult.tool_use_id || crypto.randomUUID(),
              content: resultContent,
            });
          }

          // Add text content after tool results if present
          const textContent = textBlocks
            .map((block: any) => block.text || "")
            .filter(Boolean)
            .join("\n");

          if (textContent) {
            cleanedMessages.push({
              role: "user",
              content: applyPudidilFilters(textContent),
            });
          }
          continue;
        }

        // Default: keep text and image_url blocks, drop unknown types
        const supportedBlocks = content.filter(
          (block: any) => block.type === "text" || block.type === "image_url" || block.type === "image"
        );

        // If there are image blocks, keep as array (OpenAI multimodal format)
        const hasImages = supportedBlocks.some((b: any) => b.type === "image_url" || b.type === "image");
        if (hasImages) {
          // Convert Anthropic-style image blocks to OpenAI image_url format
          const openAIBlocks = supportedBlocks.map((block: any) => {
            if (block.type === "text") {
              return { type: "text", text: applyPudidilFilters(block.text || "") };
            }
            if (block.type === "image_url") return block;
            // Anthropic format: { type: "image", source: { type: "base64", media_type, data } }
            if (block.type === "image" && block.source?.data) {
              return {
                type: "image_url",
                image_url: { url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}` },
              };
            }
            return block;
          });
          cleanedMessages.push({ ...msg, content: openAIBlocks });
        } else {
          const textContent = supportedBlocks
            .map((block: any) => block.text || "")
            .filter(Boolean)
            .join("\n");
          cleanedMessages.push({ ...msg, content: applyPudidilFilters(textContent || "") });
        }
        continue;
      }

      // Fallback: keep message as-is
      cleanedMessages.push(msg);
    }

    // Build minimal request body matching enowxai's approach:
    // Only include model, max_tokens, messages, and stream.
    // Avoid sending tools/temperature/extras that can trigger CodeBuddy moderation.
    const body: Record<string, unknown> = {
      model: actualModel,
      max_tokens: Math.max(request.max_tokens || 32000, 128),
      messages: cleanedMessages,
      stream,
    };

    // Only include temperature if explicitly set by client (not default)
    if (request.temperature !== undefined && request.temperature !== null) {
      body.temperature = request.temperature;
    }

    // Forward tools — CodeBuddy supports them but they may increase moderation risk.
    // Only include when the client explicitly sends tools.
    if (request.tools && request.tools.length > 0) {
      body.tools = this.normalizeTools(request.tools);
    }
    if (request.tool_choice) {
      body.tool_choice = request.tool_choice;
    }

    if (isThinking) {
      body.reasoning = { effort: "high" };
    }

    return this.fetchWithTimeout(`${this.baseUrl}/v2/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  private async parseResponse(response: Response, model: string): Promise<ProviderResult> {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream") || contentType.includes("text/plain")) {
      const data = await this.aggregateStreamResponse(response, model);
      const promptTokens = data.usage.prompt_tokens || 0;
      const completionTokens = data.usage.completion_tokens || 0;
      const totalTokens = data.usage.total_tokens || 0;
      return {
        success: true,
        response: data,
        tokensUsed: totalTokens,
        promptTokens,
        completionTokens,
        creditsUsed: totalTokens > 0 ? totalTokens * this.getProviderCreditRate(model) : 0,
        creditSource: "estimated",
      };
    }

    const data = (await response.json()) as any;
    const completionResponse: ChatCompletionResponse = {
      id: data.id || this.generateId(),
      object: "chat.completion",
      created: data.created || Math.floor(Date.now() / 1000),
      model,
      choices: data.choices || [],
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    const promptTokens = Number(
      completionResponse.usage.prompt_tokens ||
      data.usage?.input_tokens ||
      data.usage?.inputTokens ||
      0
    );
    const completionTokens = Number(
      completionResponse.usage.completion_tokens ||
      data.usage?.output_tokens ||
      data.usage?.outputTokens ||
      0
    );
    const totalTokens = Number(
      completionResponse.usage.total_tokens ||
      data.usage?.totalTokens ||
      data.usage?.total_tokens ||
      promptTokens + completionTokens ||
      0
    );
    completionResponse.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens };

    // Extract credits if available from response
    let creditsUsed = 0;
    if (typeof data.credits_used === "number") {
      creditsUsed = data.credits_used;
    } else if (typeof data.creditsUsed === "number") {
      creditsUsed = data.creditsUsed;
    } else if (data.usage?.credits_used) {
      creditsUsed = Number(data.usage.credits_used);
    } else {
      // Fallback: estimate from tokens
      creditsUsed = totalTokens > 0 ? totalTokens * this.getProviderCreditRate(model) : 0;
    }

    return {
      success: true,
      response: completionResponse,
      tokensUsed: totalTokens,
      promptTokens,
      completionTokens,
      creditsUsed,
      creditSource: data.credits_used || data.creditsUsed || data.usage?.credits_used ? "upstream" : "estimated",
    };
  }

  private async aggregateStreamResponse(response: Response, model: string): Promise<ChatCompletionResponse> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let toolCalls: any[] = [];
    let id = this.generateId();
    let finishReason: string | null = "stop";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let creditsUsed = 0;

    if (!reader) {
      return {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
        usage,
      };
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          id = chunk.id || id;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta || {};
          const deltaContent = this.extractDeltaContent(chunk, choice);

          // Detect content moderation error in Chinese
          if (deltaContent.includes("敏感内容") || deltaContent.includes("系统检测到")) {
            content = "Content moderation: Your input was flagged as potentially sensitive by the provider. This may be a false positive. Please try rephrasing your message or use a different model.";
            finishReason = "content_filter";
            break;
          }

          content += deltaContent;

          // Accumulate tool calls
          if (delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              const index = toolCall.index ?? 0;
              if (!toolCalls[index]) {
                toolCalls[index] = {
                  id: toolCall.id || crypto.randomUUID(),
                  type: toolCall.type || "function",
                  function: { name: "", arguments: "" },
                };
              }
              if (toolCall.id) toolCalls[index].id = toolCall.id;
              if (toolCall.type) toolCalls[index].type = toolCall.type;
              if (toolCall.function?.name) {
                toolCalls[index].function.name = toolCall.function.name;
              }
              if (toolCall.function?.arguments) {
                toolCalls[index].function.arguments += toolCall.function.arguments;
              }
            }
          }

          if (choice?.finish_reason) finishReason = choice.finish_reason === "" ? null : choice.finish_reason;

          // If we have tool_calls and finish_reason is stop, change it to tool_calls
          if (toolCalls.length > 0 && finishReason === "stop") {
            finishReason = "tool_calls";
          }

          if (chunk.usage) {
            usage = {
              prompt_tokens: Number(chunk.usage.prompt_tokens || chunk.usage.input_tokens || usage.prompt_tokens || 0),
              completion_tokens: Number(chunk.usage.completion_tokens || chunk.usage.output_tokens || usage.completion_tokens || 0),
              total_tokens: Number(chunk.usage.total_tokens || usage.total_tokens || 0),
            };
          }

          // Extract credits if available (some providers return this)
          if (typeof chunk.credits_used === "number") {
            creditsUsed = chunk.credits_used;
          } else if (typeof chunk.creditsUsed === "number") {
            creditsUsed = chunk.creditsUsed;
          } else if (chunk.usage?.credits_used) {
            creditsUsed = Number(chunk.usage.credits_used);
          }
        } catch {
          // skip malformed chunk
        }
      }
    }

    if (!usage.completion_tokens) usage.completion_tokens = this.estimateTokens(content);
    if (!usage.prompt_tokens) usage.prompt_tokens = 0;
    if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    const message: any = { role: "assistant", content };
    const validToolCalls = toolCalls.filter(tc => tc && tc.function?.name);
    if (validToolCalls.length > 0) {
      message.tool_calls = validToolCalls;
      // Ensure content is null when tool_calls are present (OpenAI format requirement)
      if (!content || content.trim() === "") {
        message.content = null;
      }
      // Override finish_reason to tool_calls if we have valid tool calls
      if (finishReason === "stop") {
        finishReason = "tool_calls";
      }
    }

    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason || "stop" }],
      usage,
    };
  }

  private extractDeltaContent(chunk: any, choice: any): string {
    return String(
      choice?.delta?.content ??
      choice?.message?.content ??
      choice?.text ??
      chunk?.delta?.content ??
      chunk?.content ??
      chunk?.text ??
      ""
    );
  }

  private createStreamResponse(response: Response, model: string): ProviderResult {
    const id = this.generateId();
    const encoder = new TextEncoder();
    let capturedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) { controller.close(); return; }

        const decoder = new TextDecoder();
        let buffer = "";
        let contentModerationDetected = false;
        let hasToolCalls = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;
              const data = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);

              if (data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const choice = parsed.choices?.[0];
                const delta = choice?.delta || parsed.delta || {};
                const deltaContent = delta.content || "";

                // Detect content moderation error in Chinese
                if (deltaContent.includes("敏感内容") || deltaContent.includes("系统检测到")) {
                  contentModerationDetected = true;
                  const errorChunk: StreamChunk = {
                    id, object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{
                      index: 0,
                      delta: { content: "Content moderation: Your input was flagged as potentially sensitive by the provider. This may be a false positive. Please try rephrasing your message or use a different model." },
                      finish_reason: null,
                    }],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
                  const doneChunk: StreamChunk = {
                    id, object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
                  };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  break;
                }

                // Track if we've seen tool calls
                if (delta.tool_calls && delta.tool_calls.length > 0) {
                  hasToolCalls = true;
                }

                // Fix finish_reason if we have tool calls
                let finishReason = choice?.finish_reason || null;
                if (finishReason === "stop" && hasToolCalls) {
                  finishReason = "tool_calls";
                }

                // Forward the chunk with corrected finish_reason
                const chunk: StreamChunk = {
                  id: parsed.id || id,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{
                    index: choice?.index ?? 0,
                    delta,
                    finish_reason: finishReason,
                  }],
                };

                // Include usage if present and capture it
                if (parsed.usage) {
                  chunk.usage = parsed.usage;
                  capturedUsage = {
                    prompt_tokens: Number(parsed.usage.prompt_tokens || parsed.usage.input_tokens || capturedUsage.prompt_tokens || 0),
                    completion_tokens: Number(parsed.usage.completion_tokens || parsed.usage.output_tokens || capturedUsage.completion_tokens || 0),
                    total_tokens: Number(parsed.usage.total_tokens || capturedUsage.total_tokens || 0),
                  };
                }

                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch (parseError) {
                // Skip malformed chunks but continue streaming
                console.error("[CodeBuddy] Failed to parse chunk:", parseError);
              }
            }

            if (contentModerationDetected) break;
          }
        } catch (error) {
          console.error("[CodeBuddy] Stream error:", error);
        } finally {
          controller.close();
        }
      },
    });

    return {
      success: true,
      stream,
      tokensUsed: capturedUsage.total_tokens,
      promptTokens: capturedUsage.prompt_tokens,
      completionTokens: capturedUsage.completion_tokens,
      creditsUsed: capturedUsage.total_tokens > 0 ? capturedUsage.total_tokens * this.getProviderCreditRate(model) : 0,
      creditSource: "estimated",
    };
  }
}
