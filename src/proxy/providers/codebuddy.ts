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


/**
 * Detect if a system prompt belongs to a known AI agent/CLI tool.
 * Uses broad pattern matching to catch current and future variations.
 */
const AGENT_SYSTEM_PROMPT_PATTERNS: RegExp[] = [
  // Claude Code (various phrasings)
  /you are claude code/i,
  /claude.?code.+official.+cli/i,
  /anthropic.+official.+cli/i,
  /anxthxropic.+official.+cli/i,
  // Cursor / Windsurf / Cline / Aider / other coding agents
  /you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)/i,
  // Generic agent identity patterns
  /you are an? (?:ai )?(?:coding |code )?agent/i,
  // Claude Code specific markers that appear in system prompts
  /cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)/i,
  /claude.?code.+issues/i,
  /give feedback.+claude.?code/i,
  // OpenCode / OhMyOpenCode / Sisyphus agent
  /you are .{0,30}(?:powerful )?ai agent/i,
  /orchestration capabilities/i,
  /OhMyOpenCode/i,
  // Generic: any system prompt with agent-like XML tags
  /<agent-identity>/i,
  /<Role>/i,
  /<Behavior_Instructions>/i,
  // Generic: very long system prompts (>2000 chars) are almost always agent prompts
];

function isAgentSystemPrompt(content: string): boolean {
  if (content.length > 2000) return true;
  return AGENT_SYSTEM_PROMPT_PATTERNS.some((pattern) => pattern.test(content));
}

interface CodeBuddyTokens {
  api_key?: string;
  access_token?: string;
  refresh_token?: string;
  session_token?: string;
  csrf_token?: string;
  cookies?: string;
  web_cookie?: string;
}

/** Map cb- prefixed model IDs to the actual CodeBuddy API model names. */
const CB_MODEL_MAP: Record<string, string> = {
  // Claude
  "cb-opus-4.6": "claude-opus-4.6",
  "cb-opus-4.7": "claude-opus-4.7",
  "cb-opus-4.7-1m": "claude-opus-4.7-1m",
  "cb-opus-4.8": "claude-opus-4.8",
  "cb-opus-4.8-1m": "claude-opus-4.8-1m",
  "cb-sonnet-4.6": "claude-sonnet-4.6",
  "cb-haiku-4.5": "claude-haiku-4.5",
  // GPT
  "cb-gpt-5.1": "gpt-5.1",
  "cb-gpt-5.1-codex": "gpt-5.1-codex",
  "cb-gpt-5.1-codex-max": "gpt-5.1-codex-max",
  "cb-gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
  "cb-gpt-5.2": "gpt-5.2",
  "cb-gpt-5.2-codex": "gpt-5.2-codex",
  "cb-gpt-5.3-codex": "gpt-5.3-codex",
  "cb-gpt-5.4": "gpt-5.4",
  "cb-gpt-5.5": "gpt-5.5",
  "cb-gpt-5.5-xhigh": "gpt-5.5-xhigh",
  // Gemini
  "cb-gemini-2.5-flash": "gemini-2.5-flash",
  "cb-gemini-2.5-pro": "gemini-2.5-pro",
  "cb-gemini-3.0-flash": "gemini-3.0-flash",
  "cb-gemini-3.1-flash-lite": "gemini-3.1-flash-lite",
  "cb-gemini-3.1-pro": "gemini-3.1-pro",
  "cb-gemini-3.5-flash": "gemini-3.5-flash",
  // DeepSeek
  "cb-deepseek-v3-2": "deepseek-v3-2-volc",
  // Kimi
  "cb-kimi-k2.5": "kimi-k2.5",
  // Other
  "cb-enowx": "enowx-default",
};

/**
 * CodeBuddy Provider - MAX tier
 * Supports Claude Opus, GPT-5.x, Gemini, DeepSeek, Kimi models
 */
export class CodeBuddyProvider extends BaseProvider {
  name = "codebuddy";

  /** Cache for resolved tool schemas — Claude Code sends the same tools every request */
  private schemaCache = new Map<string, any>();
  private static readonly SCHEMA_CACHE_MAX = 200;

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("cb-");
  }

  /** Resolve cb- prefixed model IDs to actual CodeBuddy API model names. */
  private resolveModel(model: string): string {
    // Strip -thinking suffix first for lookup, re-apply after
    const isThinking = model.endsWith("-thinking");
    const base = isThinking ? model.replace(/-thinking$/, "") : model;
    const resolved = CB_MODEL_MAP[base.toLowerCase()] || base;
    return isThinking ? `${resolved}-thinking` : resolved;
  }

  private baseUrl = "https://www.codebuddy.ai";

  supportedModels: ModelInfo[] = [
    // Credit rates derived from confirmed data point:
    //   claude-opus-4.6 = 6.97 credits / 260,613 tokens = 0.02674 credits/1K tokens
    // Other models estimated from upstream API pricing ratios relative to opus-4.6.
    // Upstream prices ($/M tokens): opus=$5/$25, gpt-5.5=$5/$30, gpt-5.1=$1.25/$10,
    //   gemini-2.5-pro=$1.25/$10, gemini-flash=$0.30/$2.50, deepseek=$0.14/$0.28
    // 1 CodeBuddy credit ≈ $0.01 passthrough.

    // All models exposed with cb- prefix only
    { id: "cb-opus-4.8", object: "model", created: Date.now(), owned_by: "codebuddy", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "token", creditRate: 0.027 / 1000, creditSource: "estimated" },
    { id: "cb-opus-4.8-1m", object: "model", created: Date.now(), owned_by: "codebuddy", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "token", creditRate: 0.030 / 1000, creditSource: "estimated" },
    { id: "cb-opus-4.7", object: "model", created: Date.now(), owned_by: "codebuddy", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "token", creditRate: 0.027 / 1000, creditSource: "estimated" },
    { id: "cb-opus-4.7-1m", object: "model", created: Date.now(), owned_by: "codebuddy", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "token", creditRate: 0.030 / 1000, creditSource: "estimated" },
    { id: "cb-opus-4.6", object: "model", created: Date.now(), owned_by: "codebuddy", context_window: 1000000, max_output: 64000, thinking: true, vision: true, creditUnit: "token", creditRate: 0.027 / 1000, creditSource: "estimated" },
    { id: "cb-sonnet-4.6", object: "model", created: Date.now(), owned_by: "codebuddy", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "token", creditRate: 0.015 / 1000, creditSource: "estimated" },
    { id: "cb-haiku-4.5", object: "model", created: Date.now(), owned_by: "codebuddy", context_window: 200000, max_output: 8192, thinking: true, vision: true, creditUnit: "token", creditRate: 0.005 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.1", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.1-codex", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.1-codex-max", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.025 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.1-codex-mini", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.003 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.2", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.016 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.2-codex", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.016 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.3-codex", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.013 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.4", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.018 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.5", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.035 / 1000, creditSource: "estimated" },
    { id: "cb-gpt-5.5-xhigh", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.045 / 1000, creditSource: "estimated" },
    { id: "cb-gemini-2.5-flash", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.003 / 1000, creditSource: "estimated" },
    { id: "cb-gemini-2.5-pro", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "cb-gemini-3.0-flash", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: false, vision: true, creditUnit: "token", creditRate: 0.004 / 1000, creditSource: "estimated" },
    { id: "cb-gemini-3.1-flash-lite", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: false, vision: true, creditUnit: "token", creditRate: 0.002 / 1000, creditSource: "estimated" },
    { id: "cb-gemini-3.1-pro", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: false, vision: true, creditUnit: "token", creditRate: 0.015 / 1000, creditSource: "estimated" },
    { id: "cb-gemini-3.5-flash", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: true, vision: true, creditUnit: "token", creditRate: 0.004 / 1000, creditSource: "estimated" },
    { id: "cb-deepseek-v3-2", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: false, vision: false, creditUnit: "token", creditRate: 0.002 / 1000, creditSource: "estimated" },
    { id: "cb-kimi-k2.5", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: false, vision: false, creditUnit: "token", creditRate: 0.005 / 1000, creditSource: "estimated" },
    { id: "cb-enowx", object: "model", created: Date.now(), owned_by: "codebuddy", thinking: false, vision: true, creditUnit: "token", creditRate: 0.01 / 1000, creditSource: "estimated" },
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
      // If already in OpenAI format, extract and re-normalize
      // Note: tool descriptions are already filtered by router.sanitizeRequest()
      if (tool.type === "function" && tool.function) {
        return {
          type: "function",
          function: {
            name: tool.function.name,
            description: tool.function.description || "",
            parameters: this.sanitizeToolSchema(tool.function.parameters),
          },
        };
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

  /**
   * Resolve all $ref references in a JSON Schema by inlining definitions.
   * This is necessary because CodeBuddy's API doesn't support $ref/$defs.
   */
  private resolveSchemaRefs(schema: any, defs: Record<string, any>, seen = new Set<string>()): any {
    if (!schema || typeof schema !== "object") return schema;
    if (Array.isArray(schema)) return schema.map(item => this.resolveSchemaRefs(item, defs, seen));

    // Handle $ref
    if (schema.$ref && typeof schema.$ref === "string") {
      const refPath = schema.$ref.replace(/^#\/\$defs\//, "").replace(/^#\/definitions\//, "");
      if (seen.has(refPath)) {
        // Circular reference — return a generic object to avoid infinite loop
        return { type: "object", description: `(circular ref: ${refPath})` };
      }
      const resolved = defs[refPath];
      if (resolved) {
        seen.add(refPath);
        const result = this.resolveSchemaRefs({ ...resolved }, defs, seen);
        seen.delete(refPath);
        return result;
      }
      // Unresolvable ref — return generic
      return { type: "object" };
    }

    // Recursively resolve all nested objects
    const clone: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$defs" || key === "definitions") continue; // skip defs themselves
      clone[key] = this.resolveSchemaRefs(value, defs, seen);
    }
    return clone;
  }

  private sanitizeToolSchema(schema: any): any {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return { type: "object", properties: {} };
    }

    // Cache lookup — Claude Code sends identical tool schemas every request,
    // so we avoid re-resolving $ref on every call.
    const cacheKey = JSON.stringify(schema);
    const cached = this.schemaCache.get(cacheKey);
    if (cached) return cached;

    // Extract $defs/definitions before removing them, so we can resolve $ref inline
    const defs = { ...(schema.$defs || {}), ...(schema.definitions || {}) };

    // Resolve all $ref references inline
    let resolved = Object.keys(defs).length > 0 || this.hasRefs(schema)
      ? this.resolveSchemaRefs(schema, defs)
      : { ...schema };

    // Remove unsupported JSON Schema meta fields
    for (const key of ["$schema", "$id", "$comment", "$defs", "definitions"]) {
      delete resolved[key];
    }

    // Ensure type is set
    if (!resolved.type) resolved.type = "object";

    // Ensure properties exists for object types
    if (resolved.type === "object" && !resolved.properties) {
      resolved.properties = {};
    }

    // Ensure required is an array if present
    if (resolved.required && !Array.isArray(resolved.required)) {
      delete resolved.required;
    }

    // Store in cache (evict all if cache grows too large)
    if (this.schemaCache.size >= CodeBuddyProvider.SCHEMA_CACHE_MAX) {
      this.schemaCache.clear();
    }
    this.schemaCache.set(cacheKey, resolved);

    return resolved;
  }

  /** Check if a schema object contains any $ref anywhere (deep check) */
  private hasRefs(obj: any): boolean {
    if (!obj || typeof obj !== "object") return false;
    if (Array.isArray(obj)) return obj.some(item => this.hasRefs(item));
    if ("$ref" in obj) return true;
    return Object.values(obj).some(value => this.hasRefs(value));
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
      // Always request as stream — CodeBuddy no longer supports non-stream responses.
      // We aggregate the stream into a single ChatCompletionResponse for the client.
      const response = await this.makeRequest(tokens, request, true);

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

      // Aggregate stream into a single response
      const data = await this.aggregateStreamResponse(response, request.model);
      const promptTokens = data.usage.prompt_tokens || 0;
      const completionTokens = data.usage.completion_tokens || 0;
      const totalTokens = data.usage.total_tokens || 0;
      // Use real credit from CodeBuddy if available, otherwise estimate
      const realCredit = (data as any)._realCredit;
      const creditsUsed = realCredit != null ? realCredit : (totalTokens > 0 ? totalTokens * this.getProviderCreditRate(request.model) : 0);
      const creditSource: "upstream" | "estimated" = realCredit != null ? "upstream" : "estimated";
      // Remove internal field before sending to client
      delete (data as any)._realCredit;
      return {
        success: true,
        response: data,
        tokensUsed: totalTokens,
        promptTokens,
        completionTokens,
        creditsUsed,
        creditSource,
      };
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

    // Primary check: fetch real billing data via /v2/billing/meter/get-user-resource
    // This endpoint works with API key and gives us both auth validation AND real credit data.
    const quota = await this.fetchQuota(account);
    if (quota.success && quota.quota) {
      return {
        kind: quota.quota.remaining <= 0 ? "exhausted" : "healthy",
        success: true,
        quota: { ...quota.quota, source: "codebuddy.get-user-resource" },
        metadata: {
          credit_total_dosage: quota.quota.limit,
          credit_capacity_remain: quota.quota.remaining,
          credit_capacity_used: quota.quota.used,
          credit_capacity_size: quota.quota.limit,
          lastRealBillingSync: new Date().toISOString(),
        },
      };
    }

    // Billing API failed — check if it's an auth issue or transient error
    if (quota.error?.includes("401") || quota.error?.includes("403")) {
      return {
        kind: "session_expired",
        success: false,
        error: "CodeBuddy API key expired or revoked (billing returned 401/403)",
      };
    }

    // Fallback 1: try cookie-based billing endpoint (different endpoint, may work when /v2/ is down)
    const cookieQuota = await this.fetchQuotaViaCookie(tokens);
    if (cookieQuota) {
      return {
        kind: cookieQuota.remaining <= 0 ? "exhausted" : "healthy",
        success: true,
        quota: { ...cookieQuota, source: "codebuddy.cookie-billing" },
        metadata: {
          credit_total_dosage: cookieQuota.limit,
          credit_capacity_remain: cookieQuota.remaining,
          credit_capacity_used: cookieQuota.used,
          credit_capacity_size: cookieQuota.limit,
          lastRealBillingSync: new Date().toISOString(),
        },
      };
    }

    // Fallback 2: validate via chat completions endpoint
    const apiStatus = await this.validateApiKey(tokens);

    if (apiStatus === "ok") {
      // API works but billing failed (transient) — report as healthy with stored quota
      const storedQuota = Number(account.quotaRemaining || 0);
      const storedLimit = Number(account.quotaLimit || 0);
      return {
        kind: "healthy",
        success: true,
        quota: storedLimit > 0
          ? { limit: storedLimit, remaining: storedQuota, used: storedLimit - storedQuota, source: "tracked" }
          : undefined,
        message: `Billing API transient error (${quota.error}). Using tracked credit: ${storedQuota.toFixed(1)}/${storedLimit.toFixed(1)}`,
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
   * Uses the billing API endpoint which validates the API key without consuming credits.
   * Falls back to chat completions endpoint if billing check fails.
   * Returns: "ok" | "quota_exhausted" | "expired"
   */
  private async validateApiKey(tokens: CodeBuddyTokens): Promise<"ok" | "quota_exhausted" | "expired"> {
    const apiKey = tokens.api_key || tokens.access_token || tokens.session_token;
    if (!apiKey) return "expired";

    // Primary: use billing API to validate — doesn't consume credits and gives definitive auth status
    try {
      const response = await this.fetchUserResource(tokens);
      if (response.status === 401 || response.status === 403) return "expired";
      if (response.status === 429) return "quota_exhausted";
      if (response.ok) {
        const data = await response.json() as any;
        if (data.code === 0) return "ok";
        // Non-zero code but HTTP 200 — API key is valid, just a business logic error
        return "ok";
      }
      // Other HTTP errors — fall through to chat endpoint check
    } catch {
      // Network error on billing — fall through to chat endpoint check
    }

    // Fallback: use chat completions endpoint (abort immediately after status)
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

    // Use /v2/billing/meter/get-user-resource which works with API key (Bearer token).
    // The old /billing/meter/get-user-resource requires web session cookies that expire.
    const apiKey = tokens.api_key || tokens.access_token || tokens.session_token;
    const headers: Record<string, string> = {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    return this.fetchWithTimeout(`${this.baseUrl}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, config.providerQuotaTimeoutMs);
  }

  /**
   * Fetch quota using web session cookies via the old /billing/meter/get-user-resource endpoint.
   * This is a fallback when the /v2/ Bearer-token endpoint fails (e.g. HTTP 500).
   */
  private async fetchQuotaViaCookie(tokens: CodeBuddyTokens): Promise<{ limit: number; remaining: number; used: number } | null> {
    const cookieHeader = tokens.web_cookie;
    if (!cookieHeader) return null;

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

    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/billing/meter/get-user-resource`, {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "Cookie": cookieHeader,
          "X-Requested-With": "XMLHttpRequest",
          "Referer": `${this.baseUrl}/profile/usage`,
          "Origin": this.baseUrl,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        body: JSON.stringify(payload),
      }, config.providerQuotaTimeoutMs);

      if (!response.ok) return null;
      const data = await response.json() as any;
      if (data.code !== 0) return null;
      return this.parseResourceQuota(data);
    } catch {
      return null;
    }
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

    // Resolve cb- prefix and handle -thinking suffix
    const resolved = this.resolveModel(request.model);
    const isThinking = resolved.endsWith("-thinking");
    const actualModel = isThinking ? resolved.replace(/-thinking$/, "") : resolved;

    // Clean messages: convert Anthropic format to OpenAI format for CodeBuddy API
    // Apply pudidil filters to remove Claude Code CLI detection patterns
    const cleanedMessages: any[] = [];

    for (const msg of request.messages) {
      let content = msg.content;

      if (typeof content === "string") {
        // Detect and replace Claude Code / agent system prompts entirely
        // Use broad detection to catch variations and newer versions
        if (msg.role === "system" && isAgentSystemPrompt(content)) {
          // Replace entire agent system prompt with a clean, generic one
          cleanedMessages.push({
            role: "system",
            content: "You are a helpful AI assistant that helps with software engineering tasks.",
          });
          continue;
        }

        // Simple string content — already filtered by router.sanitizeRequest()
        cleanedMessages.push({
          ...msg,
          content,
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
            content: textContent || "",
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
              content: textContent,
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
              return { type: "text", text: block.text || "" };
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
          cleanedMessages.push({ ...msg, content: textContent || "" });
        }
        continue;
      }

      // Fallback: keep message as-is
      cleanedMessages.push(msg);
    }

    // CodeBuddy requires a system message — inject one if missing to avoid "Parse message failed"
    const hasSystemMsg = cleanedMessages.some((m: any) => m.role === "system");
    if (!hasSystemMsg) {
      cleanedMessages.unshift({ role: "system", content: "You are a helpful AI assistant." });
    }

    const body: Record<string, unknown> = {
      messages: cleanedMessages,
      model: actualModel,
      stream,
    };

    // Only add max_tokens if explicitly provided and reasonable
    if (request.max_tokens && request.max_tokens > 0) {
      body.max_tokens = Math.min(request.max_tokens, 32000);
    }

    // Normalize and forward tools if provided
    if (request.tools && request.tools.length > 0) {
      body.tools = this.normalizeTools(request.tools);
    }
    if (request.tool_choice) {
      body.tool_choice = request.tool_choice;
    }

    if (isThinking) {
      body.reasoning = { effort: "high" };
    }

    // Use a longer timeout for streaming requests — large context (Claude Code)
    // can cause CodeBuddy to take > 2 minutes before the first token arrives.
    const timeoutMs = stream ? 300_000 : config.providerRequestTimeoutMs;

    return this.fetchWithTimeout(`${this.baseUrl}/v2/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  private async aggregateStreamResponse(response: Response, model: string): Promise<ChatCompletionResponse & { _realCredit?: number }> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let toolCalls: any[] = [];
    let id = this.generateId();
    let finishReason: string | null = "stop";
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let realCredit: number | null = null; // Real credit from CodeBuddy usage.credit field

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
            // Capture real credit from CodeBuddy's usage.credit field
            if (chunk.usage.credit != null && Number(chunk.usage.credit) > 0) {
              realCredit = Number(chunk.usage.credit);
            }
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
      ...(realCredit != null ? { _realCredit: realCredit } : {}),
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
    let capturedRealCredit: number | null = null; // Real credit from CodeBuddy usage.credit

    const STREAM_READ_TIMEOUT = 300_000; // 5 minutes per read — generous for thinking models

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
            // Race each read against a timeout to detect stalled streams
            const readPromise = reader.read();
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("Stream read timeout")), STREAM_READ_TIMEOUT);
            });
            const { done, value } = await Promise.race([readPromise, timeoutPromise]);
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
                  // Capture real credit from CodeBuddy's usage.credit field
                  if (parsed.usage.credit != null && Number(parsed.usage.credit) > 0) {
                    capturedRealCredit = Number(parsed.usage.credit);
                  }
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
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error("[CodeBuddy] Stream error:", errMsg);
          // Send an error chunk to the client so it knows what happened
          try {
            const errorChunk: StreamChunk = {
              id, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model,
              choices: [{
                index: 0,
                delta: { content: `\n\n[Stream error: ${errMsg}]` },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch {
            // Controller may already be closed
          }
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return {
      success: true,
      stream,
      tokensUsed: capturedUsage.total_tokens,
      promptTokens: capturedUsage.prompt_tokens,
      completionTokens: capturedUsage.completion_tokens,
      // Note: For streaming, the real credit is captured by the stream finalizer in index.ts
      // via extractUsageFromSsePayload() which reads usage.credit from the last SSE chunk.
      // These fallback values are used only if the finalizer doesn't find usage in the stream.
      creditsUsed: 0,
      creditSource: "estimated" as const,
    };
  }
}
