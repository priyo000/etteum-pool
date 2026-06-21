import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import { decrypt } from "../../utils/crypto";

// ============================================================================
// Gumloop Provider — ws.gumloop.com OpenAI-compatible relay
//
// Bypass mechanism (live-verified 2026-06-20):
//   1. User login Gumloop via Google OAuth (manual, one-time)
//   2. Extract Firebase refresh_token + uid from IndexedDB firebaseLocalStorageDb
//   3. Provider auto-refresh Firebase idToken via securetoken.googleapis.com
//   4. Generate UUID v4 hex API key (crypto.randomUUID().replace(/-/g, ""))
//   5. POST api.gumloop.com/secret (ROOT path) with Bearer idToken + x-auth-key:uid
//      + body {user_id, secret_type:"agenthub_api_key", value, nickname} → 201 Created
//      (backend does NOT check tier — UI-only gate)
//   6. POST ws.gumloop.com/api/v1/chat/completions with Bearer api_key + x-auth-key:uid
//      → OpenAI-compatible verbatim (body & response pass-through, no transform)
//
// Auth storage (account.tokens JSON):
//   { uid, refresh_token, api_key, id_token?, id_token_expires_at? }
//
// nativeFormat = "openai" → edge proxy handles Anthropic client via transforms/anthropic.ts
// ============================================================================

const GUMLOOP_FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
const GUMLOOP_SECRET_URL = `${config.gumloopApiBase}/secret`;
const GUMLOOP_CHAT_URL = `${config.gumloopChatBase}/api/v1/chat/completions`;
const GUMLOOP_CREDIT_LIMIT_URL = `${config.gumloopApiBase}/get_subscription_tier_credit_limit`;

interface GumloopTokens {
  uid: string;
  refresh_token: string;
  api_key?: string; // generated UUID v4 hex, registered via /secret
  id_token?: string; // Firebase ID token (1hr expiry) — only needed for /secret registration
  id_token_expires_at?: number; // epoch ms
}

interface GumloopModelDef {
  /** Proxy-facing id (gl-*) */
  id: string;
  /** Real upstream id passed to ws.gumloop.com */
  upstream: string;
  context_window: number;
  max_output: number;
  thinking: boolean;
  vision: boolean;
  /**
   * Gumloop credit rate PER 1000 TOKENS (not per-interaction).
   *
   * Calibrated from real credit-delta measurements against the
   * get_subscription_tier_credit_limit endpoint (2026-06-20).
   * See scripts/test-gumloop-credit-rate.ts for methodology.
   *
   * Free plan: 5000 credits/month.
   *
   * Measured rates (credits per 1k tokens):
   *   Opus:   ~1.96  (7 data points, 8662 tokens)
   *   Sonnet: ~2.33  (6 data points, 6444 tokens)
   *   Haiku:  ~1.44  (5 data points, 4171 tokens)
   *   Gemini Pro:  ~1.96 (same tier as Opus — Expert AI)
   *   Gemini Flash: ~1.44 (same tier as Haiku — Standard AI)
   *
   * NOTE: Gumloop's credit endpoint has eventual consistency (~5s delay),
   * so per-request delta is noisy. Token-based estimation is more reliable
   * for per-request tracking. The credit endpoint is still used in
   * fetchQuota() for authoritative remaining-credits during warmup.
   */
  creditRate: number;
}

const GUMLOOP_MODELS: GumloopModelDef[] = [
  // ── Claude Opus (1M context) ──────────────────────────────────────
  // creditRate: ~1.96 credits per 1k tokens (calibrated from real data)
  {
    id: "gl-claude-opus-4.8",
    upstream: "claude-opus-4-8",
    context_window: 1_000_000,
    max_output: 32000,
    thinking: true,
    vision: true,
    creditRate: 1.96 / 1000,
  },
  {
    id: "gl-claude-opus-4.7",
    upstream: "claude-opus-4-7",
    context_window: 1_000_000,
    max_output: 32000,
    thinking: true,
    vision: true,
    creditRate: 1.96 / 1000,
  },
  {
    id: "gl-claude-opus-4.6",
    upstream: "claude-opus-4-6",
    context_window: 1_000_000,
    max_output: 32000,
    thinking: true,
    vision: true,
    creditRate: 1.96 / 1000,
  },
  {
    id: "gl-claude-opus-4.5",
    upstream: "claude-opus-4-5",
    context_window: 200_000,
    max_output: 32000,
    thinking: true,
    vision: true,
    creditRate: 1.96 / 1000,
  },
  // ── Claude Sonnet ─────────────────────────────────────────────────
  // creditRate: ~2.33 credits per 1k tokens (calibrated from real data)
  {
    id: "gl-claude-sonnet-4.6",
    upstream: "claude-sonnet-4-6",
    context_window: 1_000_000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 2.33 / 1000,
  },
  {
    id: "gl-claude-sonnet-4.5",
    upstream: "claude-sonnet-4-5",
    context_window: 200_000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 2.33 / 1000,
  },
  // ── Claude Haiku ──────────────────────────────────────────────────
  // creditRate: ~1.44 credits per 1k tokens (calibrated from real data)
  {
    id: "gl-claude-haiku-4.5",
    upstream: "claude-haiku-4-5",
    context_window: 200_000,
    max_output: 8192,
    thinking: false,
    vision: true,
    creditRate: 1.44 / 1000,
  },
  // ── Gemini ────────────────────────────────────────────────────────
  // Gemini Pro: same tier as Opus (Expert AI) → ~1.96 credits/1k tokens
  {
    id: "gl-gemini-2.5-pro",
    upstream: "gemini-2.5-pro",
    context_window: 1_000_000,
    max_output: 8192,
    thinking: true,
    vision: true,
    creditRate: 1.96 / 1000,
  },
  // Gemini Flash: same tier as Haiku (Standard AI) → ~1.44 credits/1k tokens
  {
    id: "gl-gemini-2.5-flash",
    upstream: "gemini-2.5-flash",
    context_window: 1_000_000,
    max_output: 8192,
    thinking: true,
    vision: true,
    creditRate: 1.44 / 1000,
  },
];

const MODEL_BY_ID: Record<string, GumloopModelDef> = Object.fromEntries(
  GUMLOOP_MODELS.map((m) => [m.id.toLowerCase(), m]),
);

export class GumloopProvider extends BaseProvider {
  name = "gumloop";
  override nativeFormat: "openai" | "anthropic" = "openai";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().startsWith("gl-");
  }

  supportedModels: ModelInfo[] = GUMLOOP_MODELS.map((m) => ({
    id: m.id,
    object: "model",
    created: Date.now(),
    owned_by: "gumloop",
    context_window: m.context_window,
    max_output: m.max_output,
    thinking: m.thinking,
    vision: m.vision,
    creditUnit: "credit",
    creditRate: m.creditRate,
    creditSource: "estimated",
  }));

  override getModelInfo(model: string): ModelInfo | undefined {
    const normalized = model.toLowerCase();
    return this.supportedModels.find((m) => m.id.toLowerCase() === normalized);
  }

  // ── Token parsing & decryption ──────────────────────────────────────

  private parseTokens(account: Account): GumloopTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens;
      return t as GumloopTokens;
    } catch {
      return null;
    }
  }

  private getTokens(account: Account): GumloopTokens | null {
    const t = this.parseTokens(account);
    if (!t?.uid || !t.refresh_token) return null;
    // refresh_token may be stored encrypted in password field; if tokens.refresh_token
    // is missing but password exists, decrypt password.
    if (!t.refresh_token && account.password) {
      const decrypted = decrypt(account.password);
      if (decrypted) t.refresh_token = decrypted;
    }
    return t;
  }

  private resolveModel(model: string): string {
    const def = MODEL_BY_ID[model.toLowerCase()];
    return def?.upstream || model;
  }

  // ── Firebase ID token refresh ───────────────────────────────────────

  private async refreshFirebaseIdToken(
    refreshToken: string,
  ): Promise<{ idToken: string; expiresIn: number } | { error: string }> {
    const apiKey = config.gumloopFirebaseApiKey;
    if (!apiKey) {
      return { error: "GUMLOOP_FIREBASE_API_KEY not set in env" };
    }
    try {
      const res = await this.fetchWithTimeout(GUMLOOP_FIREBASE_TOKEN_URL + "?key=" + apiKey, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
      });
      const data = await res.json() as any;
      if (!res.ok || !data.id_token) {
        return { error: `Firebase refresh failed: ${data.error?.message || res.status}` };
      }
      return { idToken: data.id_token, expiresIn: Number(data.expires_in) || 3600 };
    } catch (err) {
      return { error: `Firebase refresh error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async getValidIdToken(tokens: GumloopTokens): Promise<{ idToken: string; error?: undefined } | { idToken?: undefined; error: string }> {
    // Reuse cached id_token if still valid (with 5 min buffer)
    const now = Date.now();
    if (tokens.id_token && tokens.id_token_expires_at && tokens.id_token_expires_at > now + 5 * 60 * 1000) {
      return { idToken: tokens.id_token };
    }
    const r = await this.refreshFirebaseIdToken(tokens.refresh_token);
    if ("error" in r) return { error: r.error };
    tokens.id_token = r.idToken;
    tokens.id_token_expires_at = now + r.expiresIn * 1000;
    return { idToken: r.idToken };
  }

  // ── API key registration (one-time per account) ─────────────────────
  //
  // Gumloop free plan: only 1 active agenthub_api_key per account.
  // Registering a new key while the old one is still active → 201 Created
  // but the new key returns 403 Unauthorized on chat endpoints.
  // So we: (a) reuse cached key, (b) fetch active key via GET /secret,
  // (c) only register a new key if no active key exists.

  private async ensureApiKey(account: Account, tokens: GumloopTokens): Promise<{ apiKey: string; error?: undefined } | { apiKey?: undefined; error: string }> {
    // (a) Reuse cached key — verify it's still working via a lightweight chat call
    if (tokens.api_key) {
      const ok = await this.testApiKey(tokens.api_key, tokens.uid);
      if (ok) return { apiKey: tokens.api_key };
      // Key revoked — clear cache, fall through to fetch/register
      console.warn(`[gumloop] cached api_key returned 401/403, fetching active key...`);
      tokens.api_key = undefined;
    }

    const { idToken, error } = await this.getValidIdToken(tokens);
    if (error) return { error };

    // (b) Fetch active key from Gumloop
    try {
      const listRes = await this.fetchWithTimeout(
        `${GUMLOOP_SECRET_URL}?secret_type=agenthub_api_key`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${idToken}`,
            "x-auth-key": tokens.uid,
          },
        },
      );
      if (listRes.ok) {
        const listBody = await listRes.text();
        // Response is a JSON string (the API key value), e.g. "e8ee5ce6c97e4f68ae94033a933599b1"
        const existingKey = listBody.trim().replace(/^"|"$/g, "");
        if (existingKey && existingKey.length >= 32) {
          tokens.api_key = existingKey;
          await this.persistTokens(account.id, tokens);
          return { apiKey: existingKey };
        }
      }
    } catch (err) {
      console.warn(`[gumloop] GET /secret failed:`, err);
    }

    // (c) No active key — register a new one
    const newKey = crypto.randomUUID().replace(/-/g, "");
    try {
      const res = await this.fetchWithTimeout(GUMLOOP_SECRET_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
          "x-auth-key": tokens.uid,
        },
        body: JSON.stringify({
          user_id: tokens.uid,
          secret_type: "agenthub_api_key",
          value: newKey,
          nickname: `etteum-${Date.now()}`,
        }),
      });
      const body = await res.text();
      if (res.status !== 200 && res.status !== 201) {
        return { error: `/secret registration failed: ${res.status} ${body.slice(0, 200)}` };
      }
      tokens.api_key = newKey;
      await this.persistTokens(account.id, tokens);
      return { apiKey: newKey };
    } catch (err) {
      return { error: `/secret registration error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Quick auth check — sends a minimal chat request, returns true if 200. */
  private async testApiKey(apiKey: string, uid: string): Promise<boolean> {
    try {
      const res = await this.fetchWithTimeout(GUMLOOP_CHAT_URL, {
        method: "POST",
        headers: this.buildHeaders(apiKey, uid),
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          max_tokens: 1,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async persistTokens(accountId: number, tokens: GumloopTokens): Promise<void> {
    try {
      const { db } = await import("../../db/index");
      const { accounts } = await import("../../db/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(accounts).set({ tokens, updatedAt: new Date() }).where(eq(accounts.id, accountId));
    } catch (err) {
      console.warn(`[gumloop] failed to persist tokens for account ${accountId}:`, err);
    }
  }

  // ── Chat completions ────────────────────────────────────────────────

  private buildHeaders(apiKey: string, uid: string): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-auth-key": uid,
    };
  }

  /**
   * Gumloop tool calling support (verified 2026-06-21):
   *
   *   ✅ `tools` param (definitions)           → OK — model returns tool_calls
   *   ✅ Initial tool call (no history)         → OK — finish_reason: "tool_calls"
   *   ❌ `tool_choice` (any value)              → 400 REJECTED
   *   ❌ `role: "tool"` in message history      → 400 REJECTED
   *   ❌ `assistant.tool_calls` in history      → 400 REJECTED
   *
   * Strategy: "first-turn tool calling"
   *   - Keep `tools` definitions so the model CAN invoke tools on the current turn.
   *   - Convert any PREVIOUS tool_calls / tool results in history to plain text,
   *     so the conversation context is preserved without triggering 400.
   *   - Never send `tool_choice`.
   *
   * This means: the agent can call tools, execute them, and on the next turn
   * the tool result is fed back as text context. The model sees the tool output
   * and can continue reasoning or call another tool.
   */
  private transformToolHistory(messages: ChatCompletionRequest["messages"]): ChatCompletionRequest["messages"] {
    const result: ChatCompletionRequest["messages"] = [];
    for (const msg of messages) {
      // ── Tool result message → convert to user message ──
      if (msg.role === "tool" as any) {
        const toolCallId = (msg as any).tool_call_id || "unknown";
        const content = typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content || "");
        result.push({
          role: "user",
          content: `[Tool Result${toolCallId !== "unknown" ? ` (${toolCallId})` : ""}]\n${content}`,
        });
        continue;
      }

      // ── Assistant message with tool_calls → convert to text ──
      if (msg.role === "assistant" && (msg as any).tool_calls) {
        const toolCalls = (msg as any).tool_calls as any[];
        const textContent = typeof msg.content === "string" ? msg.content : "";
        const toolText = toolCalls
          .map((tc: any) => {
            const name = tc?.function?.name || "unknown";
            const args = tc?.function?.arguments || "{}";
            return `[Tool Call: ${name}]\nArguments: ${args}`;
          })
          .join("\n\n");
        result.push({
          role: "assistant",
          content: [textContent, toolText].filter(Boolean).join("\n\n") || "[Tool call initiated]",
        });
        continue;
      }

      // ── All other messages: pass through ──
      result.push(msg);
    }
    return result;
  }

  private buildBody(request: ChatCompletionRequest, upstreamModel: string): Record<string, unknown> {
    // Transform tool history to text — Gumloop rejects tool_calls/role:tool in
    // message history, but DOES support tools param for the current turn.
    const messages = this.transformToolHistory(request.messages);

    const body: Record<string, unknown> = {
      model: upstreamModel,
      messages,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    // Keep tools definitions — model can invoke tools on the current turn.
    // The transformToolHistory() above ensures no tool_calls/role:tool in history.
    if (request.tools) body.tools = request.tools;
    // NEVER send tool_choice — Gumloop rejects it with 400.
    // Forward reasoning params — Gumloop passes reasoning_content back in response.
    if (request.reasoning_effort) body.reasoning_effort = request.reasoning_effort;
    if (request.thinking) body.thinking = request.thinking;
    return body;
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) {
      return { success: false, error: "No valid Gumloop tokens (uid + refresh_token required)" };
    }
    const { apiKey, error } = await this.ensureApiKey(account, tokens);
    if (error) {
      return { success: false, error };
    }

    const upstreamModel = this.resolveModel(request.model);
    const body = this.buildBody(request, upstreamModel);
    body.stream = false;

    // Retry logic for transient failures (502, 503, 504, network errors)
    const maxRetries = 3;
    let lastError: string = "";
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchWithTimeout(GUMLOOP_CHAT_URL, {
          method: "POST",
          headers: this.buildHeaders(apiKey!, tokens.uid),
          body: JSON.stringify(body),
        });

        // Don't retry auth errors
        if (res.status === 401 || res.status === 403) {
          if (tokens.api_key) {
            tokens.api_key = undefined;
            await this.persistTokens(account.id, tokens);
          }
          return { success: false, error: `Gumloop auth error: ${res.status}`, tokens };
        }
        
        // Don't retry rate limits
        if (res.status === 429) {
          return { success: false, error: "Gumloop rate limited", rateLimited: true };
        }
        
        // Retry on transient server errors
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          lastError = `Gumloop error ${res.status}`;
          if (attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            console.warn(`[gumloop] Chat ${res.status}, retry ${attempt}/${maxRetries} in ${delay}ms`);
            
            // Debug: dump request info on first failure
            if (attempt === 1) {
              const bodySize = JSON.stringify(body).length;
              const msgCount = (request.messages || []).length;
              const msgTypes = (request.messages || []).map((m: any) => {
                const contentLen = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
                return `${m.role}(${contentLen})`;
              }).join(', ');
              console.warn(`[gumloop] DEBUG: model=${request.model} bodySize=${bodySize}B msgs=${msgCount} [${msgTypes}] stream=${body.stream}`);
              
              // Dump first message structure for debugging
              if (request.messages && request.messages[0]) {
                console.warn(`[gumloop] First msg:`, JSON.stringify(request.messages[0]).slice(0, 200));
              }
            }
            
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }
        
        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return { success: false, error: `Gumloop error ${res.status}: ${errText.slice(0, 300)}` };
        }

        const data = (await res.json()) as ChatCompletionResponse;
        const usage = data.usage;
        const promptTokens = usage?.prompt_tokens;
        const completionTokens = usage?.completion_tokens;
        const totalTokens = usage?.total_tokens || (promptTokens ?? 0) + (completionTokens ?? 0);

        // Normalize finish_reason in non-stream response (Gumloop may send
        // Anthropic-format values like "end_turn" which confuse OpenAI clients).
        const NORMALIZED_FINISH: Record<string, string> = {
          end_turn: "stop",
          stop_sequence: "stop",
          max_tokens: "length",
        };
        if (data.choices) {
          for (const choice of data.choices) {
            const fr = choice?.finish_reason;
            if (fr && fr in NORMALIZED_FINISH) {
              const normalized = NORMALIZED_FINISH[fr];
              if (normalized) choice.finish_reason = normalized;
            }
          }
        }

        // Gumloop does NOT return credits_used in the response usage object.
        // We use token-based estimation (creditRate * totalTokens) calibrated
        // from real credit-delta measurements (see scripts/test-gumloop-credit-rate.ts).
        // Return undefined so computeCredits() uses the token-based path.
        return {
          success: true,
          response: data,
          promptTokens,
          completionTokens,
          tokensUsed: totalTokens,
          creditsUsed: undefined,
          creditSource: "estimated" as const,
        };
      } catch (err) {
        lastError = `Gumloop request error: ${err instanceof Error ? err.message : String(err)}`;
        
        // Retry on network errors
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.warn(`[gumloop] Chat network error, retry ${attempt}/${maxRetries} in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
    }
    
    return { success: false, error: lastError || "Gumloop chat failed after retries" };
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest,
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens) {
      return { success: false, error: "No valid Gumloop tokens (uid + refresh_token required)" };
    }
    const { apiKey, error } = await this.ensureApiKey(account, tokens);
    if (error) {
      return { success: false, error };
    }

    // ── Tool use streaming ──────────────────────────────────────────────
    // Gumloop's stream mode DOES send delta.tool_calls — verified via
    // test-gumloop-raw-stream.ts on 2026-06-22:
    //   chunk 0: { tool_calls: [{ index:0, id:"toolu_...", function:{ name:"Bash", arguments:"" } }] }
    //   chunk 1-N: { tool_calls: [{ index:0, function:{ arguments:"partial..." } }] }
    //   chunk N+1: { finish_reason: "tool_use", usage: {...} }
    //   chunk N+2: { finish_reason: "stop" }  ← duplicate, suppressed by parser
    //
    // Previously we fell back to non-stream for tool use. That caused
    // "streaming malah non-stream" — the client waited for the entire
    // response before seeing anything. Now we stream natively.
    //
    // The stream parser below (NORMALIZED_FINISH + hasToolCalls check)
    // forwards delta.tool_calls chunks to the edge proxy's
    // openAIStreamToAnthropic transform, which converts them to
    // content_block_start(tool_use) + input_json_delta + content_block_stop.


    const upstreamModel = this.resolveModel(request.model);
    const body = this.buildBody(request, upstreamModel);
    body.stream = true;

    // Retry logic for transient failures (502, 503, 504, network errors)
    const maxRetries = 3;
    let lastError: string = "";
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await this.fetchWithTimeout(GUMLOOP_CHAT_URL, {
          method: "POST",
          headers: this.buildHeaders(apiKey!, tokens.uid),
          body: JSON.stringify(body),
        });

        // Don't retry auth errors
        if (res.status === 401 || res.status === 403) {
          if (tokens.api_key) {
            tokens.api_key = undefined;
            await this.persistTokens(account.id, tokens);
          }
          return { success: false, error: `Gumloop auth error: ${res.status}`, tokens };
        }
        
        // Don't retry rate limits
        if (res.status === 429) {
          return { success: false, error: "Gumloop rate limited", rateLimited: true };
        }
        
        // Retry on transient server errors
        if (res.status === 502 || res.status === 503 || res.status === 504) {
          lastError = `Gumloop stream error ${res.status}`;
          if (attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // 1s, 2s, 4s max
            console.warn(`[gumloop] Stream ${res.status}, retry ${attempt}/${maxRetries} in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }
        
        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          return { success: false, error: `Gumloop stream error ${res.status}: ${errText.slice(0, 300)}` };
        }

        // Success — parse + re-emit stream with finish_reason normalization.
        //
        // Gumloop upstream sends non-standard finish_reason in stream chunks:
        //   chunk N-1:  finish_reason: "end_turn"  (Anthropic format)
        //   chunk N:    finish_reason: "stop"       (OpenAI format)
        //   data: [DONE]
        //
        // "end_turn" is not a valid OpenAI finish_reason. Some clients (agent
        // frameworks) misinterpret it as "incomplete" and loop/retry. We
        // normalize: "end_turn" → "stop", and suppress the duplicate trailing
        // chunk (empty delta + redundant finish_reason) that Gumloop emits.
        //
        // We also re-emit each chunk as a clean SSE line, matching the pattern
        // used by Kiro/CodeBuddy/Qoder providers.
        const upstream = res.body;
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let totalCompletionTokens = 0;
        let promptTokens = 0;
        let sseBuffer = "";
        let finishReasonSent: string | null = null;
        let lastUsage: any = null;
        let lastChunkId: string | null = null;
        let lastChunkModel: string | null = null;
        let lastChunkCreated: number | null = null;

        const NORMALIZED_FINISH: Record<string, string> = {
          end_turn: "stop",
          stop_sequence: "stop",
          max_tokens: "length",
        };

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const reader = upstream.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });

                // Process complete SSE lines from buffer
                const lines = sseBuffer.split("\n");
                sseBuffer = lines.pop() || ""; // keep incomplete last line

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed.startsWith("data:")) continue;

                  const payload = trimmed.startsWith("data: ")
                    ? trimmed.slice(6)
                    : trimmed.slice(5);

                  if (payload === "[DONE]") {
                    // Emit a final [DONE] marker
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    // Break out of both the line loop and the read loop
                    // early — Gumloop sends nothing useful after [DONE].
                    reader.releaseLock();
                    controller.close();
                    return;
                  }

                  let chunk: any;
                  try {
                    chunk = JSON.parse(payload);
                  } catch {
                    continue; // partial JSON, skip
                  }

                  // Capture usage (Gumloop sends it in the second-to-last chunk)
                  if (chunk.usage) {
                    lastUsage = chunk.usage;
                    if (chunk.usage.completion_tokens) totalCompletionTokens = chunk.usage.completion_tokens;
                    if (chunk.usage.prompt_tokens) promptTokens = chunk.usage.prompt_tokens;
                  }
                  if (chunk.id) lastChunkId = chunk.id;
                  if (chunk.model) lastChunkModel = chunk.model;
                  if (chunk.created) lastChunkCreated = chunk.created;

                  const choice = chunk.choices?.[0];
                  if (!choice) continue;

                  // Normalize finish_reason
                  let fr = choice.finish_reason;
                  if (fr && NORMALIZED_FINISH[fr]) {
                    fr = NORMALIZED_FINISH[fr];
                  }

                  const delta = choice.delta;
                  const hasContent = delta && typeof delta.content === "string" && delta.content.length > 0;
                  const hasReasoning = delta && typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0;
                  const hasToolCalls = delta && Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;

                  // Skip empty delta chunks that have no finish_reason and no
                  // content, reasoning, or tool_calls (noise).
                  // IMPORTANT: tool_calls chunks have no content/reasoning —
                  // skipping them loses all tool call arguments!
                  if (!fr && !hasContent && !hasReasoning && !hasToolCalls) continue;

                  // If we already sent a finish_reason, suppress further
                  // finish_reason chunks (Gumloop sends end_turn then stop).
                  // Only allow a new finish_reason if it's different AND
                    // carries content (extremely rare).
                  if (fr && finishReasonSent) {
                    if (!hasContent && !hasReasoning && !hasToolCalls) continue;
                  }

                  if (fr) finishReasonSent = fr;

                  // Early termination: once we've sent a finish_reason that
                  // signals completion (stop, tool_calls, length), emit [DONE]
                  // and close immediately. Gumloop sends duplicate finish_reasons
                  // (e.g. tool_use → stop) and trailing error chunks — we must
                  // not wait for those.
                  if (fr === "stop" || fr === "tool_calls" || fr === "length") {
                    const cleanChunk: any = {
                      id: chunk.id || lastChunkId || `chatcmpl-gumloop-${Date.now()}`,
                      object: "chat.completion.chunk",
                      created: chunk.created || lastChunkCreated || Math.floor(Date.now() / 1000),
                      model: chunk.model || lastChunkModel || upstreamModel,
                      choices: [{ index: 0, delta: delta || {}, finish_reason: fr }],
                    };
                    if (lastUsage) cleanChunk.usage = lastUsage;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(cleanChunk)}\n\n`));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    reader.releaseLock();
                    controller.close();
                    return;
                  }

                  // Re-emit clean SSE chunk (for non-stop finish_reason or content)
                  const outChunk: any = {
                    id: chunk.id || lastChunkId || `chatcmpl-gumloop-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: chunk.created || lastChunkCreated || Math.floor(Date.now() / 1000),
                    model: chunk.model || lastChunkModel || upstreamModel,
                    choices: [{
                      index: 0,
                      delta: delta || {},
                      ...(fr ? { finish_reason: fr } : {}),
                    }],
                  };

                  // Attach usage to the final chunk (the one with finish_reason)
                  if (fr && lastUsage) {
                    outChunk.usage = lastUsage;
                  }

                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(outChunk)}\n\n`));
                }
              }
              // Stream ended without [DONE] — emit one for client compatibility
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (err) {
              controller.error(err);
              return;
            } finally {
              try { reader.releaseLock(); } catch {}
              try { controller.close(); } catch {}
            }
          },
        });

        // Usage (promptTokens, totalCompletionTokens) is captured inside the
        // async stream reader above. Because ReadableStream.start() is async,
        // these values may still be 0 at this return point for fast responses.
        //
        // IMPORTANT: Return undefined (not 0) when we don't have usage yet.
        // The edge proxy checks truthiness: 0 is falsy → falls through to
        // estimateMessagesTokens() which produces wildly inaccurate counts.
        // undefined also skips the || chain, letting wrapStreamWithUsageFinalizer
        // extract the real usage from SSE chunks.
        const hasUsage = promptTokens > 0 || totalCompletionTokens > 0;
        return {
          success: true,
          stream,
          promptTokens: hasUsage ? promptTokens : undefined,
          completionTokens: hasUsage ? totalCompletionTokens : undefined,
          tokensUsed: hasUsage ? promptTokens + totalCompletionTokens : undefined,
          // Gumloop does NOT return credits_used in the response usage object.
          // We use token-based estimation (creditRate * totalTokens) calibrated
          // from real credit-delta measurements (see scripts/test-gumloop-credit-rate.ts).
          // creditSource="estimated" so computeCredits() falls through to the
          // token-based path, NOT the hardcoded fallback.
          creditsUsed: undefined,
          creditSource: "estimated" as const,
        };
      } catch (err) {
        lastError = `Gumloop stream error: ${err instanceof Error ? err.message : String(err)}`;
        
        // Retry on network errors
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.warn(`[gumloop] Stream network error, retry ${attempt}/${maxRetries} in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
    }
    
    // All retries exhausted
    return { success: false, error: lastError || "Gumloop stream failed after retries" };
  }

  // ── Auth & quota ────────────────────────────────────────────────────

  async refreshToken(account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens) {
      return { success: false, error: "No refresh_token available" };
    }
    const r = await this.refreshFirebaseIdToken(tokens.refresh_token);
    if ("error" in r) {
      return { success: false, error: r.error };
    }
    tokens.id_token = r.idToken;
    tokens.id_token_expires_at = Date.now() + r.expiresIn * 1000;
    await this.persistTokens(account.id, tokens);
    return { success: true, tokens: JSON.stringify(tokens) };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    if (!tokens?.uid || !tokens.refresh_token) return false;
    // Verify by refreshing id_token (confirms refresh_token still valid)
    const r = await this.refreshFirebaseIdToken(tokens.refresh_token);
    return !("error" in r);
  }

  /**
   * Check remaining Gumloop credits via the subscription tier endpoint.
   *
   * Endpoint: GET api.gumloop.com/get_subscription_tier_credit_limit?user_id=<uid>
   * Auth: Authorization: Bearer <firebase_id_token> + x-auth-key: <uid>
   *
   * Returns real-time credit_limit, remaining, and billing metadata.
   * Free plan: 5000 credits/month, charged PER INTERACTION (not per token):
   *   Expert AI (Opus, Gemini Pro):    30 credits/request
   *   Advanced AI (Sonnet):            20 credits/request
   *   Standard AI (Haiku, Gemini Flash): 2 credits/request
   * Source: https://docs.gumloop.com/core-concepts/credits
   */
  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const tokens = this.getTokens(account);
    if (!tokens?.uid || !tokens.refresh_token) {
      return { success: false, error: "No tokens" };
    }

    // Get fresh Firebase id_token (needed for credit endpoint auth)
    const { idToken, error } = await this.getValidIdToken(tokens);
    if (error) {
      return { success: false, error: `Credit check auth failed: ${error}` };
    }

    // Persist the refreshed id_token back to DB (so chat completion can reuse it)
    await this.persistTokens(account.id, tokens);

    try {
      const res = await this.fetchWithTimeout(
        `${GUMLOOP_CREDIT_LIMIT_URL}?user_id=${encodeURIComponent(tokens.uid)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${idToken}`,
            "x-auth-key": tokens.uid,
          },
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[gumloop] credit_limit endpoint returned ${res.status}: ${body.slice(0, 200)}`);
        return { success: false, error: `Credit limit check failed: ${res.status}` };
      }

      const data = await res.json() as {
        credit_limit?: number;
        remaining?: number;
        is_past_due?: boolean;
        renewal_date?: string | null;
        period_start_date?: string | null;
      };

      const limit = Number(data.credit_limit ?? 5000);
      const remaining = Number(data.remaining ?? 0);
      const used = Math.max(0, limit - remaining);

      // Parse renewal_date if available, otherwise approximate end of month
      let resetAt: Date | null = null;
      if (data.renewal_date) {
        resetAt = new Date(data.renewal_date);
      } else {
        const now = new Date();
        resetAt = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      }

      return {
        success: true,
        quota: { limit, remaining, used, resetAt },
      };
    } catch (err) {
      return { success: false, error: `Credit check error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
