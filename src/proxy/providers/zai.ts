import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";

interface ZaiTokens {
  jwt_token?: string;
  session_token?: string;
  user_id?: string;
}

interface ZaiSSEEvent {
  type?: string;
  data:
    | string
    | {
        delta_content?: string;
        content?: string;
        edit_content?: string;
        edit_index?: number;
        phase?: "thinking" | "answer" | "other" | "done";
        done?: boolean;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        };
        error?: {
          code?: string | number;
          detail?: string;
        };
      };
}

/** Map from our exposed model ID (zai-xxx) to the upstream Z.ai model ID */
const MODEL_MAP: Record<string, string> = {
  "zai-glm-5.1": "GLM-5.1",
  "zai-glm-5-turbo": "GLM-5-Turbo",
  "zai-glm-5v-turbo": "GLM-5v-Turbo",
  "zai-glm-5": "glm-5",
  "zai-glm-4.7": "glm-4.7",
  "zai-glm-4.6v": "glm-4.6v",
  "zai-glm-4.5-air": "0727-106B-API",
  "zai-glm-4.5": "0727-360B-API",
  "zai-z1-32b": "zero",
  "zai-glm-4-32b": "glm-4-air-250414",
};

const FE_VERSION = "prod-fe-1.0.272";
const SIGNING_SECRET = "key-@@@@)))()((9))-xxxx&&&%%%%%";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Z.ai Provider — based on zai2api approach
 *
 * Key design:
 * 1. Flatten all messages into a single prompt string (with tool history markers)
 * 2. Create a fresh chat per request via /api/v1/chats/new
 * 3. Use HMAC-SHA256 signature + query params for auth
 * 4. Stream thinking as reasoning_content, answer as content
 * 5. Tool calls are serialized as text history — model responds with text
 */
export class ZaiProvider extends BaseProvider {
  name = "zai";
  private baseUrl = "https://chat.z.ai";

  supportedModels: ModelInfo[] = [
    { id: "zai-glm-5.1", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 32000, thinking: true, vision: false, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
    { id: "zai-glm-5-turbo", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 32000, thinking: true, vision: false, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
    { id: "zai-glm-5v-turbo", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 32000, thinking: true, vision: true, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
    { id: "zai-glm-5", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 32000, thinking: true, vision: false, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
    { id: "zai-glm-4.7", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 40000, thinking: true, vision: false, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
    { id: "zai-glm-4.6v", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 16000, thinking: true, vision: true, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
    { id: "zai-glm-4.5-air", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 80000, thinking: true, vision: false, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
    { id: "zai-glm-4.5", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 32000, thinking: true, vision: false, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
    { id: "zai-z1-32b", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
    { id: "zai-glm-4-32b", object: "model", created: Date.now(), owned_by: "zai", tier: "standard", context_window: 128000, max_output: 32000, thinking: false, vision: false, creditUnit: "token", creditRate: 0.001 / 1000, creditSource: "estimated" },
  ];

  private getTokens(account: Account): ZaiTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as ZaiTokens;
    } catch {
      return null;
    }
  }

  private resolveUpstreamModel(model: string): string {
    const mapped = MODEL_MAP[model.toLowerCase()];
    if (mapped) return mapped;
    if (model.toLowerCase().startsWith("zai-")) {
      const stripped = model.slice(4);
      return MODEL_MAP[`zai-${stripped.toLowerCase()}`] || stripped;
    }
    return model;
  }

  // ─── Prompt Assembly (from zai2api) ───────────────────────────────────

  /**
   * Flatten OpenAI messages array into a single prompt string.
   * Tool calls and tool results are serialized as text markers.
   */
  private assemblePrompt(messages: ChatMessage[]): string {
    const normalized = this.normalizeMessages(messages);
    const merged = this.mergeAdjacentSameRole(normalized);
    return this.renderPrompt(merged);
  }

  private normalizeMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
    const result: Array<{ role: string; content: string }> = [];
    let toolCallIndex = 1;

    for (const msg of messages) {
      const role = this.normalizeRole(msg.role);
      const textContent = this.extractTextContent(msg.content);

      if (role === "assistant") {
        const parts: string[] = [];
        if (textContent) parts.push(textContent);
        // Serialize tool_calls as history markers
        for (const tc of msg.tool_calls || []) {
          parts.push(this.formatToolCallHistory(tc, toolCallIndex++));
        }
        if (parts.length > 0) {
          result.push({ role: "assistant", content: parts.join("\n\n") });
        }
        continue;
      }

      // Tool results → user message with marker
      if (role === "tool" || role === "function") {
        result.push({ role: "user", content: this.formatToolResultHistory(msg, textContent) });
        continue;
      }

      if (textContent) {
        result.push({ role, content: textContent });
      }
    }

    return result;
  }

  private mergeAdjacentSameRole(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
    const merged: Array<{ role: string; content: string }> = [];
    for (const msg of messages) {
      if (merged.length > 0 && merged[merged.length - 1]!.role === msg.role) {
        merged[merged.length - 1]!.content += "\n\n" + msg.content;
      } else {
        merged.push({ ...msg });
      }
    }
    return merged;
  }

  private renderPrompt(messages: Array<{ role: string; content: string }>): string {
    const parts: string[] = [];
    let firstNonAssistant = true;

    for (const msg of messages) {
      if (msg.role === "assistant") {
        parts.push(`<｜Assistant｜>${msg.content}<｜end▁of▁sentence｜>`);
        continue;
      }
      if (firstNonAssistant) {
        parts.push(msg.content);
        firstNonAssistant = false;
      } else {
        parts.push(`<｜User｜>${msg.content}`);
      }
    }

    return parts.filter(Boolean).join("\n\n").trim();
  }

  private normalizeRole(role: string): string {
    const r = (role || "user").trim().toLowerCase();
    if (r === "developer") return "system";
    if (["system", "user", "assistant", "tool", "function"].includes(r)) return r;
    return "user";
  }

  private extractTextContent(content: string | any[] | undefined | null): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((block: any) => block?.type === "text" || block?.type === "input_text" || block?.type === "output_text")
        .map((block: any) => block.text || block.content || "")
        .filter(Boolean)
        .join("\n");
    }
    return String(content);
  }

  private formatToolCallHistory(toolCall: any, fallbackIndex: number): string {
    const fn = toolCall?.function || {};
    const id = toolCall?.id || `call_${fallbackIndex}`;
    const name = fn.name || toolCall?.name || "unknown";
    let args = fn.arguments || toolCall?.arguments || toolCall?.input || "{}";
    if (typeof args !== "string") args = JSON.stringify(args);
    return (
      `[TOOL_CALL_HISTORY]\n` +
      `status: already_called\n` +
      `origin: assistant\n` +
      `not_user_input: true\n` +
      `tool_call_id: ${id}\n` +
      `function.name: ${name}\n` +
      `function.arguments: ${args}\n` +
      `[/TOOL_CALL_HISTORY]`
    );
  }

  private formatToolResultHistory(msg: any, textContent: string): string {
    const id = msg.tool_call_id || msg.id || "unknown";
    const name = msg.name || msg.tool_name || "unknown";
    const content = textContent || "null";
    return (
      `[TOOL_RESULT_HISTORY]\n` +
      `status: already_returned\n` +
      `origin: tool_runtime\n` +
      `not_user_input: true\n` +
      `tool_call_id: ${id}\n` +
      `name: ${name}\n` +
      `content: ${content}\n` +
      `[/TOOL_RESULT_HISTORY]`
    );
  }

  // ─── HMAC Signature ───────────────────────────────────────────────────

  private signPrompt(requestId: string, timestampMs: string, userId: string, prompt: string): string {
    const payload: Record<string, string> = { requestId, timestamp: timestampMs, user_id: userId };
    const sortedPayload = Object.entries(payload)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k},${v}`)
      .join(",");
    const promptB64 = Buffer.from(prompt).toString("base64");
    const bucket = String(Math.floor(parseInt(timestampMs) / (5 * 60 * 1000)));

    const key1 = this.hmacSha256(SIGNING_SECRET, bucket);
    return this.hmacSha256(key1, `${sortedPayload}|${promptB64}|${timestampMs}`);
  }

  private hmacSha256(key: string, data: string): string {
    const crypto = globalThis.crypto || require("crypto");
    // Use Bun's native crypto
    const encoder = new TextEncoder();
    const hmac = new Bun.CryptoHasher("sha256", encoder.encode(key));
    hmac.update(encoder.encode(data));
    return hmac.digest("hex");
  }

  private buildQueryParams(sessionToken: string, userId: string, requestId: string, timestampMs: string): Record<string, string> {
    return {
      requestId, timestamp: timestampMs, user_id: userId,
      version: "0.0.1", platform: "web", token: sessionToken,
      user_agent: USER_AGENT, language: "en-US", languages: "en-US,en",
      timezone: "Asia/Jakarta", cookie_enabled: "true",
      screen_width: "1920", screen_height: "1080", screen_resolution: "1920x1080",
      viewport_height: "1080", viewport_width: "1920", viewport_size: "1920x1080",
      color_depth: "24", pixel_ratio: "1",
      current_url: "https://chat.z.ai/", pathname: "/", search: "", hash: "",
      host: "chat.z.ai", hostname: "chat.z.ai", protocol: "https:",
      referrer: "https://chat.z.ai/",
      title: "Z.ai - Free AI Chatbot & Agent powered by GLM-5.1 & GLM-5",
      timezone_offset: "-420", is_mobile: "false", is_touch: "false",
      max_touch_points: "0", browser_name: "Chrome", os_name: "Linux",
    };
  }

  // ─── Session & Chat Management ────────────────────────────────────────

  private async ensureSessionToken(tokens: ZaiTokens): Promise<string> {
    // If we have a session_token, use it directly
    if (tokens.session_token) return tokens.session_token;
    // Otherwise, exchange JWT for session token
    if (!tokens.jwt_token) throw new Error("No JWT or session token available");

    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/v1/auths/`, {
      method: "GET",
      headers: { Authorization: `Bearer ${tokens.jwt_token}` },
    }, 15000);

    if (!response.ok) throw new Error(`Session exchange failed: ${response.status}`);
    const data = await response.json() as { token?: string; id?: string };
    return data.token || tokens.jwt_token;
  }

  private async createChat(sessionToken: string, model: string, prompt: string, enableThinking: boolean): Promise<{ chatId: string; userMessageId: string }> {
    const userMessageId = crypto.randomUUID();
    const chat = {
      id: "",
      title: "New Chat",
      models: [model],
      history: {
        currentId: userMessageId,
        messages: {
          [userMessageId]: {
            id: userMessageId,
            parentId: null,
            childrenIds: [],
            role: "user",
            content: prompt,
            timestamp: Math.floor(Date.now() / 1000),
            models: [model],
          },
        },
      },
      tags: [],
      flags: [],
      features: [],
      mcp_servers: [],
      enable_thinking: enableThinking,
      auto_web_search: false,
      message_version: 1,
      timestamp: Date.now(),
    };

    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/v1/chats/new`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
        "X-FE-Version": FE_VERSION,
      },
      body: JSON.stringify({ chat }),
    }, 15000);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Create chat failed (${response.status}): ${text.slice(0, 200)}`);
    }
    const data = await response.json() as { id: string };
    return { chatId: data.id, userMessageId };
  }

  // ─── Main Request ─────────────────────────────────────────────────────

  private async makeRequest(tokens: ZaiTokens, request: ChatCompletionRequest): Promise<Response> {
    const upstreamModel = this.resolveUpstreamModel(request.model);
    const isNothinking = request.model.endsWith("-nothinking");
    const enableThinking = !isNothinking && (this.getModelInfo(request.model)?.thinking ?? true);

    // Assemble prompt from messages (flattens tool history into text)
    const prompt = this.assemblePrompt(request.messages);
    if (!prompt) throw new Error("No prompt could be assembled from messages");

    // Get session token
    const sessionToken = await this.ensureSessionToken(tokens);
    const userId = tokens.user_id || "unknown";

    // Create a fresh chat for this request
    const { chatId, userMessageId } = await this.createChat(sessionToken, upstreamModel, prompt, enableThinking);
    const assistantMessageId = crypto.randomUUID();

    // Build signature
    const timestampMs = String(Date.now());
    const requestId = crypto.randomUUID();
    const signature = this.signPrompt(requestId, timestampMs, userId, prompt);
    const queryParams = this.buildQueryParams(sessionToken, userId, requestId, timestampMs);
    const queryString = new URLSearchParams(queryParams).toString();

    const body = {
      stream: true,
      model: upstreamModel,
      messages: [{ role: "user", content: prompt }],
      signature_prompt: prompt,
      params: {},
      extra: {},
      features: {
        image_generation: false,
        web_search: false,
        auto_web_search: false,
        preview_mode: false,
        flags: [] as string[],
        enable_thinking: enableThinking,
      },
      variables: {
        "{{USER_NAME}}": "User",
        "{{CURRENT_DATETIME}}": new Date().toISOString(),
        "{{CURRENT_DATE}}": new Date().toISOString().split("T")[0],
        "{{CURRENT_TIME}}": new Date().toTimeString().split(" ")[0],
        "{{CURRENT_WEEKDAY}}": new Date().toLocaleDateString("en-US", { weekday: "long" }),
        "{{CURRENT_TIMEZONE}}": "UTC+7",
        "{{USER_LANGUAGE}}": "en-US",
      },
      chat_id: chatId,
      id: assistantMessageId,
      current_user_message_id: userMessageId,
      current_user_message_parent_id: null,
      background_tasks: { title_generation: true, tags_generation: true },
      stream_options: { include_usage: true },
    };

    const url = `${this.baseUrl}/api/v2/chat/completions?${queryString}&signature_timestamp=${timestampMs}`;
    return this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Signature": signature,
        "X-FE-Version": FE_VERSION,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
    }, config.providerRequestTimeoutMs);
  }

  // ─── Provider Interface ───────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.jwt_token && !tokens?.session_token) return { success: false, error: "No token available" };

    try {
      const response = await this.makeRequest(tokens, request);
      if (response.status === 401 || response.status === 403) return { success: false, error: "Z.ai session expired" };
      if (response.status === 429) return { success: false, error: "Z.ai rate limited", quotaExhausted: true };
      if (!response.ok) { const t = await response.text(); return { success: false, error: `Z.ai error (${response.status}): ${t.slice(0, 300)}` }; }
      return this.collectResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `Z.ai failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.jwt_token && !tokens?.session_token) return { success: false, error: "No token available" };

    try {
      const response = await this.makeRequest(tokens, request);
      if (response.status === 401 || response.status === 403) return { success: false, error: "Z.ai session expired" };
      if (response.status === 429) return { success: false, error: "Z.ai rate limited", quotaExhausted: true };
      if (!response.ok) { const t = await response.text(); return { success: false, error: `Z.ai error (${response.status}): ${t.slice(0, 300)}` }; }
      return this.createStreamResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `Z.ai stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "Z.ai tokens require re-login via Google OAuth" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!(tokens?.jwt_token || tokens?.session_token);
  }

  async fetchQuota(): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    return { success: true, quota: { limit: 999999, remaining: 999999, used: 0, resetAt: null } };
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.jwt_token && !tokens?.session_token) return { kind: "missing_tokens", success: false, error: "Missing Z.ai token" };
    try {
      const sessionToken = await this.ensureSessionToken(tokens);
      const response = await this.fetchWithTimeout(`${this.baseUrl}/api/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${sessionToken}`, "X-FE-Version": FE_VERSION },
      }, config.providerQuotaTimeoutMs);
      if (response.status === 401 || response.status === 403) return { kind: "session_expired", success: false, error: "Z.ai session expired" };
      if (!response.ok) return { kind: "transient_error", success: false, retryable: true, error: `HTTP ${response.status}` };
      return { kind: "healthy", success: true, quota: { limit: 999999, remaining: 999999, used: 0, source: "zai.healthCheck" } };
    } catch (error) {
      return { kind: "transient_error", success: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ─── Response Parsing ─────────────────────────────────────────────────

  private async collectResponse(response: Response, model: string): Promise<ProviderResult> {
    const text = await response.text();
    let answerText = "";
    let reasoningText = "";
    let promptTokens = 0, completionTokens = 0, totalTokens = 0;

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") break;

      try {
        const event = JSON.parse(payload) as ZaiSSEEvent;
        if (event.type !== "chat:completion") continue;
        if (typeof event.data !== "object" || !event.data) continue;
        const data = event.data;
        if (data.error) continue; // skip errors (post-done bug)
        const content = data.delta_content || data.content || "";
        if (data.phase === "thinking" && content) reasoningText += content;
        else if (content) answerText += content;
        if (data.usage) {
          promptTokens = data.usage.prompt_tokens || data.usage.input_tokens || 0;
          completionTokens = data.usage.completion_tokens || data.usage.output_tokens || 0;
          totalTokens = data.usage.total_tokens || (promptTokens + completionTokens);
        }
      } catch { /* skip */ }
    }

    if (!answerText.trim()) return { success: false, error: "Z.ai returned no content" };

    // Parse [TOOL_CALL_HISTORY] markers from response — model is requesting a tool call
    const toolCall = this.parseToolCallFromResponse(answerText);
    if (toolCall) {
      if (!totalTokens) { promptTokens = 10; completionTokens = this.estimateTokens(answerText); totalTokens = promptTokens + completionTokens; }
      const resp: ChatCompletionResponse = {
        id: this.generateId(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: toolCall.textBefore || null as any, tool_calls: toolCall.toolCalls } as any,
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
      };
      return { success: true, response: resp, tokensUsed: totalTokens, promptTokens, completionTokens, creditsUsed: totalTokens * this.getProviderCreditRate(model), creditSource: "estimated" };
    }

    // Clean any leaked special tokens from the response
    answerText = this.cleanSpecialTokens(answerText);

    if (!totalTokens) { promptTokens = 10; completionTokens = this.estimateTokens(answerText); totalTokens = promptTokens + completionTokens; }

    const resp: ChatCompletionResponse = {
      id: this.generateId(), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: answerText, ...(reasoningText ? { reasoning_content: reasoningText } as any : {}) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
    };
    return { success: true, response: resp, tokensUsed: totalTokens, promptTokens, completionTokens, creditsUsed: totalTokens * this.getProviderCreditRate(model), creditSource: "estimated" };
  }

  private createStreamResponse(response: Response, model: string): ProviderResult {
    const id = this.generateId();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = response.body?.getReader();
        if (!reader) { controller.close(); return; }
        const decoder = new TextDecoder();
        let buffer = "";
        let promptTokens = 0, completionTokens = 0, totalTokens = 0;

        const emit = (delta: any, finish_reason: string | null = null, usage?: any) => {
          const chunk: any = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }] };
          if (usage) chunk.usage = usage;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        try {
          emit({ role: "assistant" });
          let streamedContent = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === "[DONE]") continue;

              try {
                const event = JSON.parse(payload) as ZaiSSEEvent;
                if (event.type !== "chat:completion") continue;
                if (typeof event.data !== "object" || !event.data) continue;
                const data = event.data;
                if (data.error) continue;
                if (data.done) continue;

                const content = data.delta_content || data.content || "";
                if (data.phase === "thinking" && content) {
                  emit({ reasoning_content: content } as any);
                } else if (data.phase === "answer" && content) {
                  streamedContent += content;
                  emit({ content });
                }

                if (data.usage) {
                  promptTokens = data.usage.prompt_tokens || data.usage.input_tokens || 0;
                  completionTokens = data.usage.completion_tokens || data.usage.output_tokens || 0;
                  totalTokens = data.usage.total_tokens || (promptTokens + completionTokens);
                }
              } catch { /* skip */ }
            }
          }

          // Check if streamed content contains a tool call
          const toolCall = this.parseToolCallFromResponse(streamedContent);
          if (toolCall) {
            // Re-emit as tool_calls
            for (const tc of toolCall.toolCalls) {
              emit({ tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] });
            }
            const usage = totalTokens > 0 ? { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } : undefined;
            emit({}, "tool_calls", usage);
          } else {
            const usage = totalTokens > 0 ? { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens } : undefined;
            emit({}, "stop", usage);
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: "api_error" } })}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return { success: true, stream, tokensUsed: 0 };
  }

  // ─── Tool Call Parsing ────────────────────────────────────────────────

  /**
   * Parse [TOOL_CALL_HISTORY] markers from model response.
   * When the model outputs these markers, it means it wants to call a tool.
   */
  private parseToolCallFromResponse(content: string): {
    toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    textBefore: string;
  } | null {
    const marker = "[TOOL_CALL_HISTORY]";
    const idx = content.indexOf(marker);
    if (idx === -1) return null;

    const textBefore = this.cleanSpecialTokens(content.slice(0, idx).trim());
    const block = content.slice(idx);

    // Extract fields from the marker block
    const nameMatch = block.match(/function\.name:\s*(.+)/);
    const argsMatch = block.match(/function\.arguments:\s*(.+)/);
    const idMatch = block.match(/tool_call_id:\s*(.+)/);

    if (!nameMatch || !nameMatch[1]) return null;

    const name = nameMatch[1].trim();
    let args = argsMatch?.[1]?.trim() || "{}";
    const id = idMatch?.[1]?.trim() || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

    // Ensure args is valid JSON
    try { JSON.parse(args); } catch { args = JSON.stringify({ input: args }); }

    return {
      toolCalls: [{ id, type: "function", function: { name, arguments: args } }],
      textBefore,
    };
  }

  /**
   * Remove leaked special tokens from model output.
   */
  private cleanSpecialTokens(text: string): string {
    return text
      .replace(/<｜Assistant｜>/g, "")
      .replace(/<｜User｜>/g, "")
      .replace(/<｜end▁of▁sentence｜>/g, "")
      .replace(/\[TOOL_CALL_HISTORY\][\s\S]*?\[\/TOOL_CALL_HISTORY\]/g, "")
      .replace(/\[TOOL_RESULT_HISTORY\][\s\S]*?\[\/TOOL_RESULT_HISTORY\]/g, "")
      .trim();
  }
}
