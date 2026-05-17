import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";

interface CodexTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: string | number;
  email?: string;
  account_id?: string;
  method?: string;
}

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_SCOPE = "openid profile email offline_access";

const codexModelMap: Record<string, string> = {
  "codex-auto": "gpt-5.3-codex",
  "codex-gpt-5.5": "gpt-5.5",
  "codex-gpt-5.4": "gpt-5.4",
  "codex-gpt-5.3": "gpt-5.3-codex",
  "codex-gpt-5.2": "gpt-5.2",
};

export class CodexProvider extends BaseProvider {
  name = "codex";

  supportedModels: ModelInfo[] = [
    { id: "codex-auto", object: "model", created: Date.now(), owned_by: "codex", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.5", object: "model", created: Date.now(), owned_by: "codex", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.02 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.4", object: "model", created: Date.now(), owned_by: "codex", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.015 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.3", object: "model", created: Date.now(), owned_by: "codex", tier: "max", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.2", object: "model", created: Date.now(), owned_by: "codex", tier: "standard", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.01 / 1000, creditSource: "estimated" },
  ];

  private getTokens(account: Account): CodexTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as CodexTokens;
    } catch { return null; }
  }

  private resolveModel(model: string): string {
    return codexModelMap[model.toLowerCase()] || model;
  }

  private buildPayload(request: ChatCompletionRequest): { instructions: string; input: unknown[] } {
    const systemParts: string[] = [];
    const items: unknown[] = [];
    for (const msg of request.messages) {
      const rawRole = msg.role as string;
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as any[]).map(b => {
              if (typeof b === "string") return b;
              if (b?.type === "text") return b.text || "";
              if (b?.type === "input_text") return b.text || "";
              return "";
            }).filter(Boolean).join("\n")
          : "";
      if (!text) continue;
      if (rawRole === "system") {
        systemParts.push(text);
        continue;
      }
      const role = rawRole === "tool" ? "user" : rawRole;
      items.push({
        type: "message",
        role,
        content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      });
    }
    return { instructions: systemParts.join("\n\n"), input: items };
  }

  private async makeRequest(account: Account, request: ChatCompletionRequest): Promise<Response> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) throw new Error("expired: no access_token");

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
      "OpenAI-Beta": "responses=experimental",
      "originator": "codex-cli",
    };
    if (tokens.account_id) headers["chatgpt-account-id"] = tokens.account_id;

    const { instructions, input } = this.buildPayload(request);
    const body = {
      model: this.resolveModel(request.model),
      instructions,
      input,
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
    };

    return this.fetchWithTimeout(CODEX_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const response = await this.makeRequest(account, request);
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", quotaExhausted: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          let dataLine = "";
          for (const line of event.split("\n")) {
            if (line.startsWith("data: ")) dataLine += line.slice(6);
            else if (line.startsWith("data:")) dataLine += line.slice(5);
          }
          if (!dataLine || dataLine === "[DONE]") continue;

          try {
            const obj = JSON.parse(dataLine);
            const t = obj.type || "";
            if (t === "response.output_text.delta") {
              text += obj.delta || "";
            } else if (t === "response.completed") {
              const usage = obj.response?.usage;
              if (usage) {
                inputTokens = Number(usage.input_tokens) || 0;
                outputTokens = Number(usage.output_tokens) || 0;
              }
            }
          } catch { /* skip malformed */ }
        }
      }

      const promptTokens = inputTokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = outputTokens || this.estimateTokens(text);

      const resp: ChatCompletionResponse = {
        id: this.generateId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      };

      return { success: true, response: resp, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    try {
      const response = await this.makeRequest(account, request);
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (response.status === 429) {
        const text = await response.text().catch(() => "");
        return { success: false, error: text || "Rate limited", quotaExhausted: true };
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const id = this.generateId();
      const model = request.model;
      const encoder = new TextEncoder();
      const upstream = response.body;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let started = false;
          let accumulated = "";

          const emit = (delta: any, finish_reason: string | null = null) => {
            const chunk: any = {
              id, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta, finish_reason }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });

              let idx;
              while ((idx = buffer.indexOf("\n\n")) !== -1) {
                const event = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);

                let dataLine = "";
                for (const line of event.split("\n")) {
                  if (line.startsWith("data: ")) dataLine += line.slice(6);
                  else if (line.startsWith("data:")) dataLine += line.slice(5);
                }
                if (!dataLine || dataLine === "[DONE]") continue;

                try {
                  const obj = JSON.parse(dataLine);
                  const t = obj.type || "";

                  if (t === "response.output_text.delta") {
                    const delta = obj.delta || "";
                    if (!delta) continue;
                    if (!started) {
                      started = true;
                      emit({ role: "assistant" });
                    }
                    accumulated += delta;
                    emit({ content: delta });
                  } else if (t === "response.completed" || t === "response.done") {
                    emit({}, "stop");
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  } else if (t === "response.failed" || t === "error") {
                    emit({}, "stop");
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                    return;
                  }
                } catch { /* skip malformed */ }
              }
            }

            if (!started) emit({ role: "assistant", content: accumulated });
            emit({}, "stop");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            try { controller.error(err); } catch { /* already errored */ }
          }
        },
      });

      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.refresh_token) return { success: false, error: "No refresh token" };

    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: CODEX_CLIENT_ID,
        scope: CODEX_SCOPE,
      });

      const response = await this.fetchWithTimeout(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }, 15000);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return { success: false, error: `Refresh failed: HTTP ${response.status}: ${text.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      if (!data.access_token) return { success: false, error: "No access_token in refresh response" };

      const expiresIn = Number(data.expires_in) || 3600;
      const expiresAt = String(Math.floor(Date.now() / 1000) + expiresIn);

      return {
        success: true,
        tokens: JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token || tokens.refresh_token,
          id_token: data.id_token || tokens.id_token,
          expires_at: expiresAt,
          email: tokens.email,
          account_id: tokens.account_id,
          method: tokens.method || "oauth_pkce",
        }),
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!tokens?.access_token;
  }

  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.access_token) return { success: false, error: "No access_token" };

    try {
      const response = await this.fetchWithTimeout(CODEX_USAGE_URL, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${tokens.access_token}`,
          "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
        },
      }, config.providerQuotaTimeoutMs);

      if (response.status === 401 || response.status === 403) {
        return { success: false, error: `expired: HTTP ${response.status}` };
      }
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      const primary = data.rate_limit?.primary_window || {};
      const usedPercent = Number(primary.used_percent ?? 0);
      const resetSec = Number(primary.reset_after_seconds ?? 0);
      const resetAt = primary.reset_at
        ? new Date(Number(primary.reset_at) * 1000)
        : (resetSec > 0 ? new Date(Date.now() + resetSec * 1000) : null);

      const limit = 100;
      const remaining = Math.max(0, Math.round(limit - usedPercent));

      return {
        success: true,
        quota: { limit, remaining, used: Math.round(usedPercent), resetAt },
      };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  override async healthCheck(account: Account) {
    const valid = await this.validateAccount(account);
    if (!valid) {
      return { kind: "missing_tokens" as const, success: false, error: "No valid tokens available" };
    }

    const tokens = this.getTokens(account);
    if (!tokens?.access_token) {
      return { kind: "missing_tokens" as const, success: false, error: "No access_token" };
    }

    try {
      const response = await this.fetchWithTimeout(CODEX_USAGE_URL, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${tokens.access_token}`,
          "User-Agent": "codex-cli/1.0.18 (macOS; arm64)",
        },
      }, config.providerQuotaTimeoutMs);

      if (response.status === 401 || response.status === 403) {
        return { kind: "auth_error" as const, success: false, retryable: true, error: `expired: HTTP ${response.status}` };
      }
      if (!response.ok) {
        return { kind: "transient_error" as const, success: false, retryable: true, error: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      const primary = data.rate_limit?.primary_window || {};
      const secondary = data.rate_limit?.secondary_window || {};
      const usedPercent = Number(primary.used_percent ?? 0);
      const resetAt = primary.reset_at ? new Date(Number(primary.reset_at) * 1000) : null;

      const codexQuota = {
        plan_type: String(data.plan_type || ""),
        primary: {
          used_percent: Number(primary.used_percent ?? 0),
          limit_window_seconds: Number(primary.limit_window_seconds ?? 0),
          reset_at: primary.reset_at ? new Date(Number(primary.reset_at) * 1000).toISOString() : null,
          reset_after_seconds: Number(primary.reset_after_seconds ?? 0),
        },
        secondary: {
          used_percent: Number(secondary.used_percent ?? 0),
          limit_window_seconds: Number(secondary.limit_window_seconds ?? 0),
          reset_at: secondary.reset_at ? new Date(Number(secondary.reset_at) * 1000).toISOString() : null,
          reset_after_seconds: Number(secondary.reset_after_seconds ?? 0),
        },
        rate_limited: Boolean(data.rate_limit?.limit_reached),
      };

      const limit = 100;
      const remaining = Math.max(0, Math.round(limit - usedPercent));
      const exhausted = remaining <= 0 || codexQuota.rate_limited;

      return {
        kind: exhausted ? ("exhausted" as const) : ("healthy" as const),
        success: true,
        quota: { limit, remaining, used: Math.round(usedPercent), resetAt, source: "codex.fetchQuota" },
        metadata: { codex_quota: codexQuota },
      };
    } catch (e) {
      return { kind: "transient_error" as const, success: false, retryable: true, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
