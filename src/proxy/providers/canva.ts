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

interface CanvaTokens {
  caz: string;
  cb?: string;
  cau?: string;
  user_id?: string;
  cl?: string;
  cs?: string;
  cdi?: string;
  cid?: string;
  cui?: string;
  cul?: string;
  cf_clearance?: string;
  all_cookies?: string;
}

/**
 * Canva Provider - Image generation
 * Model: canva-image
 */
export class CanvaProvider extends BaseProvider {
  name = "canva";
  private baseUrl = "https://www.canva.com";

  supportedModels: ModelInfo[] = [
    { id: "canva-image", object: "model", created: Date.now(), owned_by: "canva", tier: "standard", thinking: false, creditUnit: "image", creditRate: 1, creditSource: "fixed" },
  ];

  private getTokens(account: Account): CanvaTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string"
        ? JSON.parse(account.tokens)
        : account.tokens;
      return t as CanvaTokens;
    } catch {
      return null;
    }
  }

  async chatCompletion(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.caz) {
      return { success: false, error: "No CAZ token available" };
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
        return { success: false, error: `Canva API error (${response.status}): ${errText}` };
      }

      return this.parseResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `Canva request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(
    account: Account,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    // Canva image generation doesn't really stream, but we wrap it
    return this.chatCompletion(account, request);
  }

  async refreshToken(
    _account: Account
  ): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "Canva requires re-login" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!tokens?.caz;
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number };
    error?: string;
  }> {
    return {
      success: false,
      error: "Canva does not support real-time quota fetching",
    };
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.caz) {
      return { kind: "missing_tokens", success: false, error: "No Canva CAZ token available" };
    }

    return {
      kind: "unsupported",
      success: false,
      retryable: false,
      message: "Canva warmup quota/session check is not supported yet",
      metadata: { hasCaz: true },
    };
  }

  private async makeRequest(
    tokens: CanvaTokens,
    request: ChatCompletionRequest,
    _stream: boolean
  ): Promise<Response> {
    // Build cookie string from individual tokens
    const cookieParts: string[] = [];
    if (tokens.caz) cookieParts.push(`CAZ=${tokens.caz}`);
    if (tokens.cb) cookieParts.push(`CB=${tokens.cb}`);
    if (tokens.cau) cookieParts.push(`CAU=${tokens.cau}`);
    if (tokens.cl) cookieParts.push(`CL=${tokens.cl}`);
    if (tokens.cs) cookieParts.push(`CS=${tokens.cs}`);
    if (tokens.cf_clearance) cookieParts.push(`cf_clearance=${tokens.cf_clearance}`);

    // If all_cookies is available, use that instead
    let cookieStr = cookieParts.join("; ");
    if (tokens.all_cookies) {
      try {
        const allCookies = JSON.parse(tokens.all_cookies) as Record<string, string>;
        cookieStr = Object.entries(allCookies).map(([k, v]) => `${k}=${v}`).join("; ");
      } catch { /* use individual cookies */ }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json;charset=UTF-8",
      "Origin": "https://www.canva.com",
      "Referer": "https://www.canva.com/ai",
      "Cookie": cookieStr,
      "x-canva-authz": tokens.caz,
      "x-canva-brand": tokens.cb || "",
      "x-canva-user": tokens.user_id || "",
      "x-canva-active-user": tokens.cau || "",
      "x-canva-accept-prefix": "no-prefix",
      "x-canva-request": "generate",
      "x-canva-app": "home",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    };

    // Extract prompt from messages (use last user message)
    const lastUserMsg = [...request.messages].reverse().find(m => m.role === "user");
    const prompt = lastUserMsg?.content || "";

    const body = {
      prompt,
      model: "canva-image",
      num_images: 1,
      style: "auto",
    };

    return fetch(`${this.baseUrl}/_ajax/ai/image/generate`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  private async parseResponse(response: Response, model: string): Promise<ProviderResult> {
    const data = (await response.json()) as any;

    // Canva returns image URLs - wrap in OpenAI-compatible format
    const imageUrl = data.images?.[0]?.url || data.url || data.result || "";
    const content = imageUrl
      ? `![Generated Image](${imageUrl})`
      : data.response || data.text || JSON.stringify(data);

    const completionResponse: ChatCompletionResponse = {
      id: this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 1, // Count as 1 credit used
      },
    };

    return {
      success: true,
      response: completionResponse,
      tokensUsed: 1,
      creditsUsed: 1,
      creditSource: "fixed",
    };
  }
}
