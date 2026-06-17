import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderQuotaSnapshot,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import path from "path";
import os from "node:os";

interface CanvaTokens {
  caz: string;
  cb?: string;
  cau?: string;
  user_id?: string;
  cl?: string;
  cs?: string;
  cf_clearance?: string;
  all_cookies?: string;
}

interface WorkerInput {
  mode: "image" | "video" | "quota";
  prompt?: string;
  cookies: CanvaTokens;
  timeout?: number;
  count?: number;
  aspect?: string;
}

interface WorkerOutput {
  ok: boolean;
  media_url?: string;
  thumbnail_url?: string;
  images?: Array<{ url: string; thumbnail: string; width?: number; height?: number; size?: number }>;
  width?: number;
  height?: number;
  size?: number;
  mode?: string;
  count?: number;
  quota_used?: number;
  quota_limit?: number;
  quota_remaining?: number;
  quota_exhausted?: boolean;
  error?: string;
}

const WORKER_SCRIPT = path.join(import.meta.dir, "canva_worker.py");
const WORKER_TIMEOUT_IMAGE = 120_000; // 120s for image (Canva can take 50-80s)
const WORKER_TIMEOUT_VIDEO = 180_000; // 180s for video

/**
 * Canva Provider — Image & Video generation via Magic Media.
 *
 * Uses a Python subprocess (curl_cffi) for TLS fingerprint impersonation,
 * which is required to bypass Cloudflare's bot detection on canva.com.
 */
export class CanvaProvider extends BaseProvider {
  name = "canva";

  override ownsModel(model: string): boolean {
    return model.toLowerCase().includes("canva");
  }

  supportedModels: ModelInfo[] = [
    {
      id: "canva-image",
      object: "model",
      created: Date.now(),
      owned_by: "canva",
      context_window: 1000,
      max_output: 1,
      thinking: false,
      vision: false,
      creditUnit: "image",
      creditRate: 1,
      creditSource: "fixed",
    },
    {
      id: "canva-video",
      object: "model",
      created: Date.now(),
      owned_by: "canva",
      context_window: 1000,
      max_output: 1,
      thinking: false,
      vision: false,
      creditUnit: "image",
      creditRate: 1,
      creditSource: "fixed",
    },
  ];

  // ─── Token helpers ───────────────────────────────────────────────

  private getTokens(account: Account): CanvaTokens | null {
    if (!account.tokens) return null;
    try {
      return (typeof account.tokens === "string" ? JSON.parse(account.tokens) : account.tokens) as CanvaTokens;
    } catch {
      return null;
    }
  }

  // ─── Worker subprocess ───────────────────────────────────────────

  private async runWorker(input: WorkerInput, timeoutMs: number): Promise<WorkerOutput> {
    // Write input to a temp file to avoid stdin pipe issues with Bun.spawn
    const tmpFile = path.join(os.tmpdir(), `canva_worker_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    await Bun.write(tmpFile, JSON.stringify(input));

    try {
      const proc = Bun.spawn([config.pythonPath, WORKER_SCRIPT], {
        stdin: Bun.file(tmpFile),
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => proc.kill(), timeoutMs);
      try {
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        if (!stdout.trim()) {
          return { ok: false, error: stderr.trim() || "worker returned empty output" };
        }
        return JSON.parse(stdout.trim());
      } finally {
        clearTimeout(timer);
        // Cleanup temp file
        try { await Bun.file(tmpFile).exists() && (await import("fs/promises")).unlink(tmpFile); } catch {}
      }
    } catch (err) {
      try { (await import("fs/promises")).unlink(tmpFile); } catch {}
      return { ok: false, error: `worker error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ─── Chat completion ─────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.caz) {
      return { success: false, error: "No CAZ token available" };
    }

    const mode = request.model === "canva-video" ? "video" : "image";
    const lastUserMsg = [...request.messages].reverse().find((m) => m.role === "user");
    const prompt = typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : JSON.stringify(lastUserMsg?.content || "");

    if (!prompt.trim()) {
      return { success: false, error: "Empty prompt" };
    }

    // Support n parameter for number of images (1-4, default 4 for image, 1 for video)
    const count = mode === "video" ? 1 : Math.min(4, Math.max(1, (request as any).n || 4));
    // Support aspect_ratio / size parameter (e.g. "1:1", "16:9", "9:16")
    const aspect = (request as any).aspect_ratio || (request as any).size || "1:1";
    const timeoutMs = mode === "video" ? WORKER_TIMEOUT_VIDEO : WORKER_TIMEOUT_IMAGE;
    const timeoutSec = Math.floor(timeoutMs / 1000) - 5;

    const result = await this.runWorker(
      { mode, prompt: prompt.trim(), cookies: tokens, timeout: timeoutSec, count, aspect },
      timeoutMs,
    );

    if (!result.ok) {
      if (result.quota_exhausted) {
        return { success: false, error: "Rate limited / quota exhausted", quotaExhausted: true };
      }
      return { success: false, error: result.error || "Canva generation failed" };
    }

    // Build OpenAI-compatible response
    const content = this.formatContent(result, mode);

    const response: ChatCompletionResponse = {
      id: this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: count },
    };

    // Real Canva credit consumption (verified by quota probing 2026-05-16):
    //   image n=1 → 3, n=2 → 5, n=3 → 7, n=4 → 10  (≈ 2n + 1, with n=4 rounded up)
    //   video → 25 credits per generation
    let realCreditsUsed: number;
    if (mode === "video") {
      realCreditsUsed = 25;
    } else if (count === 4) {
      realCreditsUsed = 10;
    } else {
      realCreditsUsed = 2 * count + 1;
    }

    return {
      success: true,
      response,
      tokensUsed: count,
      creditsUsed: realCreditsUsed,
      creditSource: "fixed",
    };
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    // Canva generation doesn't stream — wrap as non-stream
    return this.chatCompletion(account, request);
  }

  // ─── Format response content ────────────────────────────────────

  private formatContent(result: WorkerOutput, mode: string): string {
    const parts: string[] = [];

    if (mode === "video") {
      if (result.media_url) parts.push(`[Video](${result.media_url})`);
      if (result.thumbnail_url) parts.push(`![Thumbnail](${result.thumbnail_url})`);
      if (result.width && result.height) parts.push(`Resolution: ${result.width}x${result.height}`);
      if (result.size) parts.push(`Size: ${(result.size / 1_000_000).toFixed(1)}MB`);
    } else if (result.images && result.images.length > 1) {
      // Multiple images
      for (let i = 0; i < result.images.length; i++) {
        const img = result.images[i]!;
        if (img.url) parts.push(`![Image ${i + 1}](${img.url})`);
      }
    } else {
      // Single image
      if (result.media_url) parts.push(`![Generated Image](${result.media_url})`);
    }

    return parts.join("\n\n") || result.media_url || "Generation completed but no URL returned.";
  }

  // ─── Quota ──────────────────────────────────────────────────────

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: ProviderQuotaSnapshot;
    error?: string;
  }> {
    const tokens = this.getTokens(account);
    if (!tokens?.caz) {
      return { success: false, error: "No CAZ token" };
    }

    const result = await this.runWorker({ mode: "quota", cookies: tokens }, 15_000);

    if (!result.ok) {
      return { success: false, error: result.error || "Quota fetch failed" };
    }

    return {
      success: true,
      quota: {
        limit: result.quota_limit || 0,
        remaining: result.quota_remaining || 0,
        used: result.quota_used || 0,
        source: "canva.quota",
      },
    };
  }

  // ─── Auth & Health ──────────────────────────────────────────────

  async refreshToken(_account: Account): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "Canva requires browser re-login" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    const tokens = this.getTokens(account);
    return !!tokens?.caz;
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const tokens = this.getTokens(account);
    if (!tokens?.caz) {
      return { kind: "missing_tokens", success: false, error: "No Canva CAZ token" };
    }

    const result = await this.runWorker({ mode: "quota", cookies: tokens }, 15_000);
    if (!result.ok) {
      return { kind: "auth_error", success: false, error: result.error || "Quota check failed" };
    }

    const remaining = result.quota_remaining || 0;
    if (remaining <= 0) {
      return { kind: "exhausted", success: true, quota: { limit: result.quota_limit || 0, remaining: 0, used: result.quota_used || 0, source: "canva.quota" } };
    }

    return {
      kind: "healthy",
      success: true,
      quota: { limit: result.quota_limit || 0, remaining, used: result.quota_used || 0, source: "canva.quota" },
    };
  }
}
