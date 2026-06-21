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
  creditRate: number;
}

const GUMLOOP_MODELS: GumloopModelDef[] = [
  // ── Claude Opus (1M context) ──────────────────────────────────────
  {
    id: "gl-claude-opus-4.8",
    upstream: "claude-opus-4-8",
    context_window: 1_000_000,
    max_output: 32000,
    thinking: true,
    vision: true,
    creditRate: 0.075 / 1000,
  },
  {
    id: "gl-claude-opus-4.7",
    upstream: "claude-opus-4-7",
    context_window: 1_000_000,
    max_output: 32000,
    thinking: true,
    vision: true,
    creditRate: 0.075 / 1000,
  },
  {
    id: "gl-claude-opus-4.6",
    upstream: "claude-opus-4-6",
    context_window: 1_000_000,
    max_output: 32000,
    thinking: true,
    vision: true,
    creditRate: 0.075 / 1000,
  },
  {
    id: "gl-claude-opus-4.5",
    upstream: "claude-opus-4-5",
    context_window: 200_000,
    max_output: 32000,
    thinking: true,
    vision: true,
    creditRate: 0.075 / 1000,
  },
  // ── Claude Sonnet ─────────────────────────────────────────────────
  {
    id: "gl-claude-sonnet-4.6",
    upstream: "claude-sonnet-4-6",
    context_window: 1_000_000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  {
    id: "gl-claude-sonnet-4.5",
    upstream: "claude-sonnet-4-5",
    context_window: 200_000,
    max_output: 64000,
    thinking: true,
    vision: true,
    creditRate: 0.009 / 1000,
  },
  // ── Claude Haiku ──────────────────────────────────────────────────
  {
    id: "gl-claude-haiku-4.5",
    upstream: "claude-haiku-4-5",
    context_window: 200_000,
    max_output: 8192,
    thinking: false,
    vision: true,
    creditRate: 0.001 / 1000,
  },
  // ── Gemini ────────────────────────────────────────────────────────
  {
    id: "gl-gemini-2.5-pro",
    upstream: "gemini-2.5-pro",
    context_window: 1_000_000,
    max_output: 8192,
    thinking: true,
    vision: true,
    creditRate: 0.007 / 1000,
  },
  {
    id: "gl-gemini-2.5-flash",
    upstream: "gemini-2.5-flash",
    context_window: 1_000_000,
    max_output: 8192,
    thinking: true,
    vision: true,
    creditRate: 0.0005 / 1000,
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

  private buildBody(request: ChatCompletionRequest, upstreamModel: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: upstreamModel,
      messages: request.messages,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.tools) body.tools = request.tools;
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
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

    try {
      const res = await this.fetchWithTimeout(GUMLOOP_CHAT_URL, {
        method: "POST",
        headers: this.buildHeaders(apiKey!, tokens.uid),
        body: JSON.stringify(body),
      });

      if (res.status === 401 || res.status === 403) {
        // Key may have been revoked — clear it so next request re-registers
        if (tokens.api_key) {
          tokens.api_key = undefined;
          await this.persistTokens(account.id, tokens);
        }
        return { success: false, error: `Gumloop auth error: ${res.status}`, tokens };
      }
      if (res.status === 429) {
        return { success: false, error: "Gumloop rate limited", rateLimited: true };
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return { success: false, error: `Gumloop error ${res.status}: ${errText.slice(0, 300)}` };
      }

      const data = (await res.json()) as ChatCompletionResponse;
      const usage = data.usage;
      return {
        success: true,
        response: data,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        tokensUsed: usage?.total_tokens,
        creditsUsed: usage?.total_tokens ? usage.total_tokens * this.getProviderCreditRate(request.model) : undefined,
        creditSource: "estimated",
      };
    } catch (err) {
      return { success: false, error: `Gumloop request error: ${err instanceof Error ? err.message : String(err)}` };
    }
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

    const upstreamModel = this.resolveModel(request.model);
    const body = this.buildBody(request, upstreamModel);
    body.stream = true;

    try {
      const res = await this.fetchWithTimeout(GUMLOOP_CHAT_URL, {
        method: "POST",
        headers: this.buildHeaders(apiKey!, tokens.uid),
        body: JSON.stringify(body),
      });

      if (res.status === 401 || res.status === 403) {
        if (tokens.api_key) {
          tokens.api_key = undefined;
          await this.persistTokens(account.id, tokens);
        }
        return { success: false, error: `Gumloop auth error: ${res.status}`, tokens };
      }
      if (res.status === 429) {
        return { success: false, error: "Gumloop rate limited", rateLimited: true };
      }
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        return { success: false, error: `Gumloop stream error ${res.status}: ${errText.slice(0, 300)}` };
      }

      // Gumloop returns standard OpenAI SSE format (data: {...chat.completion.chunk...} + data: [DONE])
      // Pass-through verbatim — edge proxy will translate to Anthropic if client requested /v1/messages
      const upstream = res.body;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let totalCompletionTokens = 0;
      let promptTokens = 0;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          const buffer: string[] = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              buffer.push(text);
              controller.enqueue(encoder.encode(text));
              // Extract usage from final chunk (if present)
              const lines = text.split("\n");
              for (const line of lines) {
                if (line.startsWith("data: ") && line !== "data: [DONE]") {
                  try {
                    const chunk = JSON.parse(line.slice(6));
                    if (chunk.usage?.completion_tokens) totalCompletionTokens = chunk.usage.completion_tokens;
                    if (chunk.usage?.prompt_tokens) promptTokens = chunk.usage.prompt_tokens;
                  } catch {
                    // partial line, ignore
                  }
                }
              }
            }
          } catch (err) {
            controller.error(err);
            return;
          } finally {
            controller.close();
          }
          void buffer;
        },
      });

      return {
        success: true,
        stream,
        promptTokens,
        completionTokens: totalCompletionTokens,
        tokensUsed: promptTokens + totalCompletionTokens,
        creditsUsed: (promptTokens + totalCompletionTokens) * this.getProviderCreditRate(request.model),
        creditSource: "estimated",
      };
    } catch (err) {
      return { success: false, error: `Gumloop stream error: ${err instanceof Error ? err.message : String(err)}` };
    }
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

  async fetchQuota(account: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    // Gumloop free plan: 5000 credits/month, but no API endpoint to check remaining.
    // Return -1 (unknown) — pool will not mark exhausted based on this.
    const tokens = this.getTokens(account);
    if (!tokens) {
      return { success: false, error: "No tokens" };
    }
    return {
      success: true,
      quota: { limit: -1, remaining: -1, used: -1, resetAt: null },
    };
  }
}
