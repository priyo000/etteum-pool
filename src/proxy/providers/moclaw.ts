import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";

interface MoclawTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: string;
  email?: string;
  method?: string;
  cookies?: string;
}

// WebSocket message types (client → server)
interface WsSendMessage {
  type: "send";
  threadId?: string;
  content: string | { type: string; text?: string }[];
}

// WebSocket event types (server → client)
interface WsAuthResult { type: "auth_result"; success: boolean; error?: string; userId?: string }
interface WsStreamEvent {
  type: "stream";
  event: {
    eventId: string;
    queryId: string;
    threadId: string;
    timestamp: number;
    event: WsInnerEvent;
  };
}
interface WsMessageFailed { type: "message_failed"; error: string; code?: string }
interface WsError { type: "error"; code: string; message: string }

type WsInnerEvent =
  | { type: "query_start" }
  | { type: "text"; text: string }
  | { type: "thinking_start" }
  | { type: "thinking"; text: string }
  | { type: "thinking_end" }
  | { type: "tool_use_start"; toolName: string; toolUseId: string }
  | { type: "tool_input"; text: string; toolUseId: string }
  | { type: "tool_output"; text: string; toolUseId: string }
  | { type: "tool_use_end"; toolUseId: string }
  | { type: "query_done" }
  | { type: "query_error"; error: string }
  | { type: "query_interrupted" }
  | { type: string; [key: string]: unknown };

type WsServerMessage = WsAuthResult | WsStreamEvent | WsMessageFailed | WsError;

const WS_URL = "wss://realtime.moclaw.ai/ws";
const API_URL = "https://api.moclaw.ai";
const AUTH0_CLIENT_ID = "R7QyN3rYIv2DSEqkgQJjfSvvb6XFxMOu";

export class MoclawProvider extends BaseProvider {
  name = "moclaw";

  supportedModels: ModelInfo[] = [
    { id: "mo-auto", object: "model", created: Date.now(), owned_by: "moclaw", tier: "standard", context_window: 200000, max_output: 64000, thinking: false, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
    { id: "moclaw-claude-sonnet-4-6", object: "model", created: Date.now(), owned_by: "moclaw", tier: "standard", context_window: 200000, max_output: 64000, thinking: false, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
    { id: "moclaw-claude-opus-4-6", object: "model", created: Date.now(), owned_by: "moclaw", tier: "standard", context_window: 200000, max_output: 64000, thinking: false, vision: true, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
    { id: "moclaw-deepseek-v4-pro", object: "model", created: Date.now(), owned_by: "moclaw", tier: "standard", context_window: 164000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
    { id: "moclaw-deepseek-v4-flash", object: "model", created: Date.now(), owned_by: "moclaw", tier: "standard", context_window: 164000, max_output: 64000, thinking: false, vision: false, creditUnit: "credit", creditRate: 2 / 1000, creditSource: "estimated" },
  ];

  private getTokens(account: Account): MoclawTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as MoclawTokens;
    } catch { return null; }
  }

  private stripPrefix(model: string): string {
    // mo-auto → auto-select best available model (claude-sonnet-4-6 as default)
    if (model.toLowerCase() === "mo-auto") return "claude-sonnet-4-6";
    return model.startsWith("moclaw-") ? model.slice(7) : model;
  }

  private formatMessages(request: ChatCompletionRequest): string {
    const parts: string[] = [];

    for (const msg of request.messages) {
      const content = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as any[]).map(b => b.text || b.content || "").join("")
          : "";
      if (!content) continue;

      if (msg.role === "system") parts.push(content);
      else if (msg.role === "user") parts.push(content);
      else if (msg.role === "assistant") {
        // Include assistant messages for context
        if (msg.tool_calls) {
          const calls = msg.tool_calls.map((tc: any) => `${tc.function.name}(${tc.function.arguments})`).join(", ");
          parts.push(`[Previous tool calls: ${calls}]`);
        } else {
          parts.push(`[Assistant previously said: ${content.slice(0, 500)}]`);
        }
      } else if (msg.role === "tool") {
        parts.push(`[Tool result: ${content}]`);
      }
    }

    // Append tool definitions if provided
    if (request.tools?.length) {
      parts.push("\n---\nYou have access to these tools. To use a tool, output EXACTLY:\n[TOOL_CALL]\n{\"name\": \"<tool_name>\", \"arguments\": {<args>}}\n[/TOOL_CALL]\n\nAvailable tools:");
      for (const tool of request.tools) {
        const fn = (tool as any).function || tool;
        parts.push(`• ${fn.name}${fn.description ? ` - ${fn.description}` : ""}`);
        if (fn.parameters) parts.push(`  Parameters: ${JSON.stringify(fn.parameters)}`);
      }
    }

    return parts.join("\n\n");
  }

  private parseToolCalls(text: string): { textBefore: string; toolCalls: any[] } | null {
    const regex = /\[TOOL_CALL\]\s*(\{[\s\S]*?\})\s*\[\/TOOL_CALL\]/g;
    const toolCalls: any[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (toolCalls.length === 0) lastIndex = match.index;
      try {
        const parsed = JSON.parse(match[1]!);
        toolCalls.push({
          id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "function",
          function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
        });
      } catch { /* skip malformed */ }
    }
    if (toolCalls.length === 0) return null;
    return { textBefore: text.slice(0, lastIndex).trim(), toolCalls };
  }

  /**
   * Get active session threadId from Moclaw API.
   * Also wakes up the sandbox if it's paused.
   */
  private async getActiveThread(accessToken: string): Promise<string | null> {
    try {
      // Wake up sandbox by hitting environment status
      const envResp = await this.fetchWithTimeout(`${API_URL}/api/v2/environment/status`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 15000);
      if (envResp.ok) {
        const env = await envResp.json() as any;
        // If sandbox is not running, wait for it to start
        if (env.runtime_state !== "ready" || env.sandbox?.status !== "running") {
          // Poll until ready (max 30s)
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const poll = await this.fetchWithTimeout(`${API_URL}/api/v2/environment/status`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            }, 10000);
            if (poll.ok) {
              const p = await poll.json() as any;
              if (p.runtime_state === "ready") break;
            }
          }
        }
      }

      const resp = await this.fetchWithTimeout(`${API_URL}/api/v2/sessions/active?channel=web`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, 10000);
      if (!resp.ok) return null;
      const data = await resp.json() as any;
      return data.session?.threadId || null;
    } catch { return null; }
  }

  /**
   * Connect to Moclaw WebSocket, send message, collect full response.
   * Skips stale/cached responses (arrive instantly) and takes the real one.
   */
  private async wsChat(accessToken: string, prompt: string, timeoutMs: number): Promise<{ text: string; error?: string }> {
    const threadId = await this.getActiveThread(accessToken);

    return new Promise((resolve) => {
      const timer = setTimeout(() => { try { ws.close(); } catch {}; resolve({ text: text || "", error: text ? undefined : "Timeout" }); }, timeoutMs);
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(accessToken)}`);
      let text = "";
      let done = false;
      let queryStartTime = 0;

      ws.onmessage = (ev) => {
        try {
          const msg: WsServerMessage = JSON.parse(String(ev.data));
          if (msg.type === "auth_result") {
            if (!msg.success) { clearTimeout(timer); try { ws.close(); } catch {}; resolve({ text: "", error: msg.error || "Auth failed" }); return; }
            const sendMsg: any = { type: "send", content: prompt };
            if (threadId) sendMsg.threadId = threadId;
            ws.send(JSON.stringify(sendMsg));
          } else if (msg.type === "stream") {
            const inner = msg.event.event;
            if (inner.type === "query_start") {
              queryStartTime = Date.now();
              text = "";
            } else if (inner.type === "text") {
              text += (inner as any).text || "";
            } else if (inner.type === "query_done" || inner.type === "query_interrupted") {
              const elapsed = Date.now() - queryStartTime;
              // Skip stale/cached responses that arrive instantly (<500ms)
              if (elapsed >= 500) {
                done = true; clearTimeout(timer); try { ws.close(); } catch {}; resolve({ text });
              } else {
                // Stale response, reset and wait for next query
                text = "";
              }
            } else if (inner.type === "query_error") {
              const elapsed = Date.now() - queryStartTime;
              if (elapsed >= 500) {
                done = true; clearTimeout(timer); try { ws.close(); } catch {}; resolve({ text: "", error: (inner as any).error || "Query error" });
              } else {
                text = "";
              }
            }
          } else if (msg.type === "message_failed") { clearTimeout(timer); try { ws.close(); } catch {}; resolve({ text: "", error: msg.error }); }
          else if (msg.type === "error") { clearTimeout(timer); try { ws.close(); } catch {}; resolve({ text: "", error: msg.message }); }
        } catch { /* ignore */ }
      };
      ws.onerror = () => { if (!done) { clearTimeout(timer); resolve({ text: "", error: "WebSocket error" }); } };
      ws.onclose = () => { if (!done) { clearTimeout(timer); resolve({ text: text || "", error: text ? undefined : "Connection closed" }); } };
    });
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token || tokens.access_token === "cookie-session") {
      return { success: false, error: "No valid access_token (need auth0_spa method)" };
    }

    const prompt = this.formatMessages(request);
    const model = this.stripPrefix(request.model);
    const { text, error } = await this.wsChat(tokens.access_token, prompt, config.providerRequestTimeoutMs);

    if (error) {
      if (error.includes("Auth failed") || error.includes("4002")) return { success: false, error: `expired: ${error}` };
      if (error.includes("quota") || error.includes("credit")) return { success: false, error, quotaExhausted: true };
      return { success: false, error };
    }
    if (!text) return { success: false, error: "Empty response from Moclaw" };

    // Check for tool calls
    const toolCall = this.parseToolCalls(text);
    const promptTokens = this.estimateMessagesTokens(request.messages);
    const completionTokens = this.estimateTokens(text);

    const resp: ChatCompletionResponse = {
      id: this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        message: toolCall
          ? { role: "assistant", content: toolCall.textBefore || null as any, tool_calls: toolCall.toolCalls }
          : { role: "assistant", content: text },
        finish_reason: toolCall ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    };

    return { success: true, response: resp, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token || tokens.access_token === "cookie-session") {
      return { success: false, error: "No valid access_token (need auth0_spa method)" };
    }

    const prompt = this.formatMessages(request);
    const model = request.model;
    const id = this.generateId();
    const encoder = new TextEncoder();
    const threadId = await this.getActiveThread(tokens.access_token);

    const accessToken = tokens.access_token;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(accessToken)}`);
        let done = false;
        let toolBuffer = "";
        let isBufferingTool = false;

        const emit = (delta: any, finish_reason: string | null = null, usage?: any) => {
          const chunk: any = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }] };
          if (usage) chunk.usage = usage;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        const timer = setTimeout(() => {
          if (!done) { done = true; try { ws.close(); } catch {}; emit({}, "stop"); controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); }
        }, config.providerRequestTimeoutMs);

        const finish = (reason: string = "stop") => {
          if (done) return;
          done = true;
          clearTimeout(timer);

          // Flush tool buffer if we were collecting tool calls
          if (isBufferingTool && toolBuffer) {
            const toolCall = this.parseToolCalls(toolBuffer);
            if (toolCall) {
              for (let i = 0; i < toolCall.toolCalls.length; i++) {
                const tc = toolCall.toolCalls[i];
                emit({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] });
              }
              emit({}, "tool_calls");
            } else {
              emit({ content: toolBuffer });
              emit({}, reason);
            }
          } else {
            emit({}, reason);
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };

        let queryStartTime = 0;
        let realQueryStarted = false;

        ws.onmessage = (ev) => {
          if (done) return;
          try {
            const msg: WsServerMessage = JSON.parse(String(ev.data));
            if (msg.type === "auth_result") {
              if (!msg.success) { done = true; clearTimeout(timer); try { ws.close(); } catch {}; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)); controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return; }
              const sendMsg: any = { type: "send", content: prompt };
              if (threadId) sendMsg.threadId = threadId;
              ws.send(JSON.stringify(sendMsg));
            } else if (msg.type === "stream") {
              const inner = msg.event.event;
              if (inner.type === "query_start") {
                queryStartTime = Date.now();
              } else if (inner.type === "query_done" || inner.type === "query_interrupted" || inner.type === "query_error") {
                const elapsed = Date.now() - queryStartTime;
                if (elapsed < 500 && !realQueryStarted) {
                  // Stale cached response — skip entirely
                  queryStartTime = 0;
                } else if (realQueryStarted) {
                  try { ws.close(); } catch {};
                  finish("stop");
                }
              } else if (inner.type === "text") {
                const t = (inner as any).text || "";
                if (!t) return;
                const elapsed = Date.now() - queryStartTime;
                // If query just started (<500ms) and we haven't committed to it yet, buffer
                if (!realQueryStarted && elapsed < 500) return;
                if (!realQueryStarted) {
                  realQueryStarted = true;
                  emit({ role: "assistant" });
                }
                if (t.includes("[TOOL_CALL]") || isBufferingTool) {
                  isBufferingTool = true;
                  toolBuffer += t;
                } else {
                  emit({ content: t });
                }
              } else if (inner.type === "thinking" && realQueryStarted) {
                const t = (inner as any).text || "";
                if (t) emit({ reasoning_content: t } as any);
              }
            } else if (msg.type === "message_failed" || msg.type === "error") {
              try { ws.close(); } catch {};
              finish("stop");
            }
          } catch { /* ignore */ }
        };

        ws.onerror = () => { if (!done) { try { ws.close(); } catch {}; finish("stop"); } };
        ws.onclose = () => { if (!done) finish("stop"); };
      },
    });

    return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) return { success: false, error: "No refresh token" };

    try {
      const response = await this.fetchWithTimeout(`https://auth.moclaw.ai/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: AUTH0_CLIENT_ID,
          refresh_token: tokens.refresh_token,
        }),
      }, 15000);

      if (!response.ok) return { success: false, error: `Refresh failed: HTTP ${response.status}` };
      const data = await response.json() as any;
      return {
        success: true,
        tokens: JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token || tokens.refresh_token,
          expires_in: String(data.expires_in || 86400),
          email: tokens.email,
          method: "auth0_spa",
        }),
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!(tokens?.access_token && tokens.access_token !== "cookie-session");
  }

  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token || tokens.access_token === "cookie-session") {
      return { success: false, error: "No valid access_token" };
    }

    try {
      const response = await this.fetchWithTimeout(`${API_URL}/api/subscription`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }, config.providerQuotaTimeoutMs);

      if (response.status === 401 || response.status === 403) return { success: false, error: "expired: token invalid" };
      if (!response.ok) return { success: false, error: `HTTP ${response.status}` };

      const sub = await response.json() as any;
      const limit = sub.plan?.monthly_credits || 1000;

      // Get credit balance
      const creditsResp = await this.fetchWithTimeout(`${API_URL}/api/credits/transactions?limit=1`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }, config.providerQuotaTimeoutMs);

      let remaining = limit;
      if (creditsResp.ok) {
        const credits = await creditsResp.json() as any;
        const latest = credits.items?.[0];
        if (latest?.balance_after !== undefined) remaining = latest.balance_after;
      }

      return {
        success: true,
        quota: { limit, remaining, used: limit - remaining, resetAt: sub.current_period_end || null },
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
