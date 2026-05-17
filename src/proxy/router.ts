import type { ChatCompletionRequest, ProviderResult } from "./providers/base";
import { KiroProvider } from "./providers/kiro";
import { KiroProProvider } from "./providers/kiro-pro";
import { CodeBuddyProvider } from "./providers/codebuddy";
import { CanvaProvider } from "./providers/canva";
import { ZaiProvider } from "./providers/zai";
import { WindsurfProvider } from "./providers/windsurf";
import { MoclawProvider } from "./providers/moclaw";
import { CodexProvider } from "./providers/codex";
import { isNonAccountRequestError } from "./errors";
import { applyPudidilFilters } from "./filters";
import { pool } from "./pool";
import type { Account } from "../db/schema";

const kiroProvider = new KiroProvider();
const kiroProProvider = new KiroProProvider();
const codebuddyProvider = new CodeBuddyProvider();
const canvaProvider = new CanvaProvider();
const zaiProvider = new ZaiProvider();
const windsurfProvider = new WindsurfProvider();
const moclawProvider = new MoclawProvider();
const codexProvider = new CodexProvider();

const providers = {
  kiro: kiroProvider,
  "kiro-pro": kiroProProvider,
  codebuddy: codebuddyProvider,
  canva: canvaProvider,
  zai: zaiProvider,
  windsurf: windsurfProvider,
  moclaw: moclawProvider,
  codex: codexProvider,
} as const;

type ProviderName = keyof typeof providers;

export interface RouteResult {
  result: ProviderResult;
  account: Account;
  provider: ProviderName;
  durationMs: number;
}

/** Check if a request contains image content blocks */
function requestHasImages(request: ChatCompletionRequest): boolean {
  return request.messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return (msg.content as any[]).some(
      (block) => block?.type === "image_url" || block?.type === "image"
    );
  });
}

/**
 * Sanitize request by applying pudidil filters to all text content.
 * Strips Claude Code identity, billing headers, and other patterns
 * that trigger content moderation on upstream providers.
 */
function sanitizeRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  const sanitized = { ...request };

  sanitized.messages = request.messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg, content: applyPudidilFilters(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: (msg.content as any[]).map((block) => {
          if (block?.type === "text" && typeof block.text === "string") {
            return { ...block, text: applyPudidilFilters(block.text) };
          }
          if (block?.type === "tool_result") {
            if (typeof block.content === "string") {
              return { ...block, content: applyPudidilFilters(block.content) };
            }
            if (Array.isArray(block.content)) {
              return {
                ...block,
                content: block.content.map((inner: any) =>
                  inner?.type === "text" && typeof inner.text === "string"
                    ? { ...inner, text: applyPudidilFilters(inner.text) }
                    : inner
                ),
              };
            }
          }
          return block;
        }),
      };
    }
    return msg;
  });

  if (sanitized.tools) {
    sanitized.tools = request.tools!.map((tool: any) => {
      if (tool?.function?.description) {
        return {
          ...tool,
          function: {
            ...tool.function,
            description: applyPudidilFilters(tool.function.description),
          },
        };
      }
      return tool;
    });
  }

  return sanitized;
}

/**
 * Route a chat completion request to the appropriate provider/account.
 * Implements retry logic with fallback to next account.
 */
export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean
): Promise<RouteResult> {
  // Apply content filters to strip Claude Code identity, billing headers, etc.
  const sanitizedRequest = sanitizeRequest(request);

  const hasImages = requestHasImages(sanitizedRequest);
  const providerName = pool.getProviderForModel(sanitizedRequest.model);
  if (!providerName) {
    throw new Error(`No provider found for model: ${sanitizedRequest.model}`);
  }

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  // Reject image requests for models that don't support vision
  if (hasImages) {
    const modelInfo = provider.getModelInfo(sanitizedRequest.model);
    if (modelInfo && !modelInfo.vision) {
      throw new Error(
        `Model "${sanitizedRequest.model}" does not support image/vision inputs. Use a vision-capable model instead.`
      );
    }
  }

  // Try up to 3 accounts before giving up
  const maxRetries = 3;
  let lastError = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const account = await pool.getNextAccount(providerName);
    if (!account) {
      throw new Error(
        `No active accounts available for provider: ${providerName}`
      );
    }

    const startTime = Date.now();
    let tracked = false;

    try {
      pool.trackRequestStart(account.id);
      tracked = true;
      const result = stream
        ? await provider.chatCompletionStream(account, sanitizedRequest)
        : await provider.chatCompletion(account, sanitizedRequest);

      const durationMs = Date.now() - startTime;

      if (result.success) {
        // If provider refreshed tokens internally, persist them to database
        if (result.tokens) {
          await pool.updateTokens(account.id, result.tokens);
        }
        await pool.markUsed(account.id);
        return { result, account, provider: providerName, durationMs };
      }

      pool.trackRequestEnd(account.id);
      tracked = false;

      // Client-side model errors should not poison accounts. A wrong model ID
      // is a bad request, not an account/session failure, so stop retrying and
      // let the API layer return an invalid_model response.
      if (isNonAccountRequestError(result.error)) {
        throw new Error(result.error || `Invalid model: ${sanitizedRequest.model}`);
      }

      // Handle quota exhaustion
      if (result.quotaExhausted) {
        await pool.markExhausted(account.id);
        lastError = result.error || "Quota exhausted";
        continue; // Try next account
      }

      // Handle token refresh
      if (
        result.error?.includes("expired") ||
        result.error?.includes("401")
      ) {
        const refreshResult = await provider.refreshToken(account);
        if (refreshResult.success && refreshResult.tokens) {
          // Parse tokens string to store as jsonb
          let parsedTokens: unknown;
          try {
            parsedTokens = JSON.parse(refreshResult.tokens);
          } catch {
            parsedTokens = refreshResult.tokens;
          }
          await pool.updateTokens(account.id, parsedTokens);
          // Retry with same account after refresh
          pool.trackRequestStart(account.id);
          tracked = true;
          const retryResult = stream
            ? await provider.chatCompletionStream(account, sanitizedRequest)
            : await provider.chatCompletion(account, sanitizedRequest);

          if (retryResult.success) {
            await pool.markUsed(account.id);
            return {
              result: retryResult,
              account,
              provider: providerName,
              durationMs: Date.now() - startTime,
            };
          }
          pool.trackRequestEnd(account.id);
          tracked = false;
        }
        await pool.markTransientFailure(account.id, result.error || "Auth failed");
        lastError = result.error || "Auth failed";
        continue;
      }

      // Generic error - mark account and try next
      await pool.markError(account.id, result.error || "Unknown error");
      lastError = result.error || "Unknown error";
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      if (tracked) {
        pool.trackRequestEnd(account.id);
        tracked = false;
      }
      if (isNonAccountRequestError(errMsg)) {
        throw error;
      }
      if (errMsg.includes("expired") || errMsg.includes("401")) {
        await pool.markTransientFailure(account.id, errMsg);
      } else {
        await pool.markError(account.id, errMsg);
      }
      lastError = errMsg;
    }
  }

  throw new Error(
    `All accounts failed for ${providerName}. Last error: ${lastError}`
  );
}

/**
 * Get all available models across all providers
 */
export function getAllModels() {
  return [
    ...kiroProvider.getModels(),
    ...kiroProProvider.getModels(),
    ...codebuddyProvider.getModels(),
    ...canvaProvider.getModels(),
    ...zaiProvider.getModels(),
    ...windsurfProvider.getModels(),
    ...moclawProvider.getModels(),
    ...codexProvider.getModels(),
  ];
}

export { providers };
