import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { db } from "../../db/index";
import { accounts } from "../../db/schema";
import { eq } from "drizzle-orm";
import { config } from "../../config";
import { decrypt } from "../../utils/crypto";

/**
 * BYOK (Bring Your Own Key) Provider
 *
 * Memungkinkan user menambahkan custom AI provider (OpenRouter, Together, Groq, dll)
 * dengan API key mereka sendiri. Support OpenAI dan Anthropic formats.
 *
 * Storage:
 * - provider: "byok"
 * - email: label/nama provider (e.g., "openrouter", "myrouter")
 * - password: encrypted API key (XOR + base64)
 * - tokens: JSON { base_url, format, models[], model_prefix, headers }
 *
 * Model routing via prefix:
 * - User define label "openrouter" + models ["gpt-4o", "claude-sonnet-4.6"]
 * - Available: "openrouter-gpt-4o", "openrouter-claude-sonnet-4.6"
 * - Request { model: "openrouter-gpt-4o" } → forward ke base_url dengan model "gpt-4o"
 */

interface ByokTokens {
  base_url: string;
  api_key?: string; // kept in tokens for reference only, actual key is in password (encrypted)
  format: "openai" | "anthropic" | "auto";
  models: string[];
  model_prefix: string;
  headers?: Record<string, string>;
}

interface CachedByokAccount {
  account: Account;
  config: ByokTokens;
  expiresAt: number;
}

export class ByokProvider extends BaseProvider {
  name = "byok";
  override supportedModels: ModelInfo[] = [];
  override isFallback = false;
  override nativeFormat: "openai" | "anthropic" = "openai";

  // Synchronous prefix → accounts cache (supports multiple keys per prefix for round-robin)
  private prefixCache = new Map<string, CachedByokAccount>();
  private prefixAccounts = new Map<string, CachedByokAccount[]>(); // all accounts per prefix
  private prefixRoundRobin = new Map<string, number>(); // round-robin index per prefix
  private prefixes: string[] = [];
  private cacheExpiry = 0;
  private readonly CACHE_TTL = 10_000; // 10 seconds
  private refreshPromise: Promise<void> | null = null;

  // ── Cache Management ──────────────────────────────────────────────

  /**
   * Refresh the prefix cache from the database.
   * Deduplicates concurrent calls so only one DB query runs at a time.
   */
  private async refreshCache(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.loadFromDb();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async loadFromDb(): Promise<void> {
    const byokAccounts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.provider, "byok"));

    // Build new data in temporary variables first to avoid race condition
    const newPrefixCache = new Map<string, CachedByokAccount>();
    const newPrefixAccounts = new Map<string, CachedByokAccount[]>();
    const newPrefixes: string[] = [];
    const newSupportedModels: ModelInfo[] = [];
    const seenModelIds = new Set<string>();

    for (const account of byokAccounts) {
      if (!account.enabled) continue;
      // Include error accounts so routing still claims their prefix.
      // The router will handle retries/failures; we must not let their
      // models fall through to the fallback provider (Kiro).
      if (account.status !== "active" && account.status !== "error") continue;

      const tokens = this.parseTokens(account.tokens);
      if (!tokens?.base_url || !tokens.models?.length) continue;

      const prefix = tokens.model_prefix || account.email;
      const expiresAt = Date.now() + this.CACHE_TTL;

      const entry = { account, config: tokens, expiresAt };
      newPrefixCache.set(prefix, entry);
      if (!newPrefixes.includes(prefix)) newPrefixes.push(prefix);

      // Collect all accounts per prefix for round-robin routing
      if (!newPrefixAccounts.has(prefix)) newPrefixAccounts.set(prefix, []);
      newPrefixAccounts.get(prefix)!.push(entry);

      // Deduplicate models: multiple accounts with the same model_prefix
      // share the same models (batch keys). Only register each model once.
      for (const model of tokens.models) {
        const modelId = `${prefix}-${model}`;
        if (seenModelIds.has(modelId)) continue;
        seenModelIds.add(modelId);

        newSupportedModels.push({
          id: modelId,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: `byok:${prefix}`,
          context_window: 200_000,
          max_output: 8192,
        });
      }
    }

    // Atomically swap in the new data
    this.prefixCache = newPrefixCache;
    this.prefixAccounts = newPrefixAccounts;
    this.prefixes = newPrefixes;
    this.supportedModels = newSupportedModels;
    this.cacheExpiry = Date.now() + this.CACHE_TTL;
  }

  /** Ensure cache is fresh, refreshing if stale. */
  private async ensureCache(): Promise<void> {
    if (Date.now() < this.cacheExpiry) return;
    await this.refreshCache();
  }

  /** Force-refresh cache (called after BYOK CRUD operations). */
  async refreshModelsCache(): Promise<void> {
    this.cacheExpiry = 0;
    await this.refreshCache();
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private parseTokens(raw: unknown): ByokTokens | null {
    if (!raw) return null;
    try {
      const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
      return obj as ByokTokens;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the API key for an account.
   * The real key lives in `password` (XOR-encrypted); tokens.api_key is optional.
   */
  private getApiKey(account: Account): string {
    try {
      return decrypt(account.password);
    } catch {
      // Fallback: try tokens.api_key (shouldn't happen, but defensive)
      const tokens = this.parseTokens(account.tokens);
      return tokens?.api_key || "";
    }
  }

  /**
   * Detect API format from base_url or use explicit setting.
   */
  private detectFormat(config: ByokTokens): "openai" | "anthropic" {
    if (config.format && config.format !== "auto") return config.format;
    const url = config.base_url.toLowerCase();
    if (url.includes("anthropic.com") || url.endsWith("/messages")) return "anthropic";
    return "openai";
  }

  /**
   * Strip the BYOK prefix from a model name.
   * "openrouter-gpt-4o" → "gpt-4o"
   */
  private extractModel(prefixedModel: string, prefix: string): string {
    return prefixedModel.startsWith(`${prefix}-`)
      ? prefixedModel.slice(prefix.length + 1)
      : prefixedModel;
  }

  /** Find which BYOK prefix a model belongs to. */
  private findPrefix(model: string): string | null {
    for (const prefix of this.prefixes) {
      if (model.startsWith(`${prefix}-`)) return prefix;
    }
    return null;
  }

  // ── Routing (synchronous — required by registry) ──────────────────

  /**
   * Synchronous ownsModel check. The cache MUST be pre-populated
   * (refreshed via refreshModelsCache() at startup and after CRUD).
   */
  override ownsModel(model: string): boolean {
    // If cache is stale, trigger a background refresh but still use last-known
    // prefixes so requests don't fall through to the fallback provider (Kiro).
    if (Date.now() >= this.cacheExpiry) {
      // Fire-and-forget: refresh in background, don't block routing
      this.refreshCache().catch(() => {/* swallow — next call will retry */});
    }
    return this.findPrefix(model) !== null;
  }

  /**
   * Find the BYOK account that owns a given model (by prefix).
   * Called by pool.getAccountForModel() for async account selection.
   */
  async findAccountForModel(model: string): Promise<Account | null> {
    await this.ensureCache();
    const prefix = this.findPrefix(model);
    if (!prefix) return null;

    // Round-robin across all accounts sharing this prefix (batch keys)
    const allAccounts = this.prefixAccounts.get(prefix);
    if (!allAccounts || allAccounts.length === 0) {
      return this.prefixCache.get(prefix)?.account ?? null;
    }

    // Filter to only active/enabled accounts
    const active = allAccounts.filter((e) => e.account.status === "active" && e.account.enabled);
    if (active.length === 0) {
      // Fallback: try any account (including error ones for retry)
      return allAccounts[0]?.account ?? null;
    }

    const idx = (this.prefixRoundRobin.get(prefix) || 0) % active.length;
    this.prefixRoundRobin.set(prefix, idx + 1);
    return active[idx]!.account;
  }

  /** Get all BYOK models for /v1/models endpoint. */
  async getAllByokModels(): Promise<ModelInfo[]> {
    await this.ensureCache();
    return this.supportedModels;
  }

  // ── Provider Interface ─────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.parseTokens(account.tokens);
    if (!tokens) return { success: false, error: "Invalid BYOK configuration" };

    const format = this.detectFormat(tokens);
    const actualModel = this.extractModel(request.model, tokens.model_prefix);

    return format === "anthropic"
      ? this.chatCompletionAnthropic(account, tokens, actualModel, request)
      : this.chatCompletionOpenAI(account, tokens, actualModel, request);
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.parseTokens(account.tokens);
    if (!tokens) return { success: false, error: "Invalid BYOK configuration" };

    const format = this.detectFormat(tokens);
    const actualModel = this.extractModel(request.model, tokens.model_prefix);

    return format === "anthropic"
      ? this.chatCompletionStreamAnthropic(account, tokens, actualModel, request)
      : this.chatCompletionStreamOpenAI(account, tokens, actualModel, request);
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: true }; // BYOK keys are static — user manages their own
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.parseTokens(account.tokens);
    return !!(tokens?.base_url && tokens?.models?.length);
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const tokens = this.parseTokens(account.tokens);
    if (!tokens?.base_url) return { success: false, error: "No base_url configured" };

    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const model = tokens.models?.[0];
    if (!model) return { success: true, quota: { limit: -1, remaining: -1, used: 0 } };

    // Send a minimal request to check if the key is valid and extract rate limit headers
    try {
      const url = `${tokens.base_url.replace(/\/$/, "")}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          ...tokens.headers,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      // Extract rate limit info from response headers (many providers send these)
      const limitRequests = Number(response.headers.get("x-ratelimit-limit-requests") || 0);
      const remainingRequests = Number(response.headers.get("x-ratelimit-remaining-requests") || 0);
      const limitTokens = Number(response.headers.get("x-ratelimit-limit-tokens") || 0);
      const remainingTokens = Number(response.headers.get("x-ratelimit-remaining-tokens") || 0);
      const resetAt = response.headers.get("x-ratelimit-reset-requests") || response.headers.get("x-ratelimit-reset") || null;

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `API key invalid or expired (HTTP ${response.status})` };
      }
      if (response.status === 429) {
        return {
          success: true,
          quota: {
            limit: limitRequests || limitTokens || 0,
            remaining: 0,
            used: limitRequests || limitTokens || 0,
            resetAt,
          },
        };
      }

      // Key is valid — return whatever rate limit info we got
      const limit = limitRequests || limitTokens || -1;
      const remaining = remainingRequests || remainingTokens || -1;
      const used = limit > 0 && remaining >= 0 ? limit - remaining : 0;

      return {
        success: true,
        quota: { limit, remaining, used, resetAt },
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── OpenAI-compatible ──────────────────────────────────────────────

  private async chatCompletionOpenAI(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      ...tokens.headers,
    };

    const body: Record<string, unknown> = {
      model: actualModel,
      messages: request.messages,
      stream: false,
    };
    this.appendOptionalParams(body, request);

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      // Check if response is SSE (some providers return SSE even when stream: false)
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        // Parse SSE response - aggregate streaming chunks into single completion
        const text = await response.text();
        const lines = text.split("\n").filter((line) => line.startsWith("data: "));
        
        let aggregatedContent = "";
        let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
        let chunkId = "";
        let chunkModel = "";
        let created = 0;
        let finishReason: string | null = null;
        
        for (const line of lines) {
          const payload = line.slice(6).trim();
          if (payload === "[DONE]" || !payload || payload.startsWith(":")) continue;
          
          try {
            const chunk = JSON.parse(payload);
            
            // Check for error response
            if (chunk.error) {
              return { 
                success: false, 
                error: chunk.error.message || chunk.error.code || "Upstream error"
              };
            }
            
            // Extract metadata from first chunk
            if (!chunkId && chunk.id) chunkId = chunk.id;
            if (!chunkModel && chunk.model) chunkModel = chunk.model;
            if (!created && chunk.created) created = chunk.created;
            
            // Aggregate content from delta
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              aggregatedContent += delta.content;
            }
            
            // Capture finish reason
            if (chunk.choices?.[0]?.finish_reason) {
              finishReason = chunk.choices[0].finish_reason;
            }
            
            // Capture usage from final chunk
            if (chunk.usage) {
              usage = chunk.usage;
            }
          } catch {
            // Skip malformed chunks
          }
        }
        
        if (!aggregatedContent && !usage) {
          return { success: false, error: "No valid data in SSE response" };
        }
        
        // Build non-streaming response object
        const completionResponse: ChatCompletionResponse = {
          id: chunkId || this.generateId(),
          object: "chat.completion",
          created: created || Math.floor(Date.now() / 1000),
          model: request.model, // Return original prefixed model to client
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: aggregatedContent,
            },
            finish_reason: finishReason || "stop",
          }],
          usage: {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || this.estimateTokens(aggregatedContent),
            total_tokens: usage.total_tokens || 0,
          },
        };
        
        const promptTokens = completionResponse.usage.prompt_tokens;
        const completionTokens = completionResponse.usage.completion_tokens;
        
        return {
          success: true,
          response: completionResponse,
          promptTokens,
          completionTokens,
          tokensUsed: promptTokens + completionTokens,
        };
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "No choices in response" };

      const promptTokens = data.usage?.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = data.usage?.completion_tokens || this.estimateTokens(
        typeof choice.message?.content === "string" ? choice.message.content : ""
      );

      // Return original prefixed model to the client
      data.model = request.model;

      return {
        success: true,
        response: data,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamOpenAI(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "text/event-stream",
      ...tokens.headers,
    };

    const body: Record<string, unknown> = {
      model: actualModel,
      messages: request.messages,
      stream: true,
    };
    this.appendOptionalParams(body, request);

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      // Pass upstream stream through, rewriting model and id
      const id = this.generateId();
      const model = request.model;
      const encoder = new TextEncoder();
      const upstream = response.body;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const parts = buffer.split("\n\n");
              buffer = parts.pop() || "";

              for (const part of parts) {
                const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
                if (!dataLine) continue;

                const payload = dataLine.slice(6).trim();
                if (payload === "[DONE]") {
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;
                }

                try {
                  const chunk = JSON.parse(payload);
                  chunk.model = model;
                  chunk.id = id;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                } catch { /* skip malformed */ }
              }
            }

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            try { controller.error(err); } catch { /* already errored */ }
          }
        },
      });

      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Anthropic Messages API ─────────────────────────────────────────

  private async chatCompletionAnthropic(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      ...tokens.headers,
    };

    const body = this.toAnthropicRequest(request, actualModel, false);

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = await response.json();
      const resp = this.fromAnthropicResponse(data, request.model);
      const promptTokens = resp.usage.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = resp.usage.completion_tokens || 0;

      return {
        success: true,
        response: resp,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamAnthropic(
    account: Account,
    tokens: ByokTokens,
    actualModel: string,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    const url = `${tokens.base_url.replace(/\/$/, "")}/messages`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Accept": "text/event-stream",
      ...tokens.headers,
    };

    const body = this.toAnthropicRequest(request, actualModel, true);

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", rateLimited: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const stream = this.transformAnthropicStream(response.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Anthropic Transform Helpers ────────────────────────────────────

  private toAnthropicRequest(
    request: ChatCompletionRequest,
    model: string,
    stream: boolean
  ): Record<string, unknown> {
    const systemParts: string[] = [];
    const messages: Array<{ role: string; content: unknown }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemParts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      } else {
        messages.push({ role: msg.role === "tool" ? "user" : msg.role, content: msg.content });
      }
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.max_tokens || 4096,
      stream,
    };

    if (systemParts.length > 0) body.system = systemParts.join("\n\n");
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;

    return body;
  }

  private fromAnthropicResponse(data: any, originalModel: string): ChatCompletionResponse {
    const content: any[] = data.content || [];
    const textContent = content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text || "")
      .join("");

    const toolCalls = content
      .filter((c: any) => c.type === "tool_use")
      .map((c: any, i: number) => ({
        id: c.id || `call_${i}`,
        type: "function" as const,
        function: { name: c.name || "", arguments: JSON.stringify(c.input || {}) },
      }));

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;

    return {
      id: data.id || this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        } as any,
        finish_reason: data.stop_reason === "tool_use" ? "tool_calls" : "stop",
      }],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  /**
   * Transform Anthropic SSE stream → OpenAI-compatible SSE stream.
   */
  private transformAnthropicStream(
    anthropicStream: ReadableStream<Uint8Array>,
    originalModel: string
  ): ReadableStream<Uint8Array> {
    const reader = anthropicStream.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const id = this.generateId();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let started = false;

    const makeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: originalModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      return encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;

              const payload = dataLine.slice(6).trim();
              if (payload === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              try {
                const event = JSON.parse(payload);

                if (event.type === "message_start") {
                  inputTokens = event.message?.usage?.input_tokens || 0;
                  if (!started) {
                    started = true;
                    controller.enqueue(makeChunk({ role: "assistant" }));
                  }
                }

                if (event.type === "content_block_delta") {
                  const text = event.delta?.text || "";
                  if (text) controller.enqueue(makeChunk({ content: text }));
                }

                if (event.type === "message_delta") {
                  outputTokens = event.usage?.output_tokens || 0;
                }

                if (event.type === "message_stop") {
                  controller.enqueue(makeChunk({}, "stop"));
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;
                }
              } catch { /* skip malformed */ }
            }
          }

          if (!started) controller.enqueue(makeChunk({ role: "assistant", content: "" }));
          controller.enqueue(makeChunk({}, "stop"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try { controller.error(err); } catch { /* already errored */ }
        }
      },
    });
  }

  // ── Shared Utilities ───────────────────────────────────────────────

  private appendOptionalParams(body: Record<string, unknown>, request: ChatCompletionRequest): void {
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice) body.tool_choice = request.tool_choice;
  }
}
