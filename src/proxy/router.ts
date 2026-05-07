import type { ChatCompletionRequest, ModelInfo, ProviderResult } from "./providers/base";
import { KiroProvider } from "./providers/kiro";
import { CodeBuddyProvider } from "./providers/codebuddy";
import { CanvaProvider } from "./providers/canva";
import { isNonAccountRequestError } from "./errors";
import { pool } from "./pool";
import type { Account } from "../db/schema";

const kiroProvider = new KiroProvider();
const codebuddyProvider = new CodeBuddyProvider();
const canvaProvider = new CanvaProvider();

const providers = {
  kiro: kiroProvider,
  codebuddy: codebuddyProvider,
  canva: canvaProvider,
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
 * Route a chat completion request to the appropriate provider/account.
 * Implements retry logic with fallback to next account.
 */
export async function routeRequest(
  request: ChatCompletionRequest,
  stream: boolean
): Promise<RouteResult> {
  const hasImages = requestHasImages(request);
  const providerName = pool.getProviderForModel(request.model);
  if (!providerName) {
    throw new Error(`No provider found for model: ${request.model}`);
  }

  const provider = providers[providerName];
  if (!provider) {
    throw new Error(`Provider not configured: ${providerName}`);
  }

  // Reject image requests for models that don't support vision
  if (hasImages) {
    const modelInfo = provider.getModelInfo(request.model);
    if (modelInfo && !modelInfo.vision) {
      throw new Error(
        `Model "${request.model}" does not support image/vision inputs. Use a vision-capable model instead.`
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

    try {
      const result = stream
        ? await provider.chatCompletionStream(account, request)
        : await provider.chatCompletion(account, request);

      const durationMs = Date.now() - startTime;

      if (result.success) {
        await pool.markUsed(account.id);
        return { result, account, provider: providerName, durationMs };
      }

      // Client-side model errors should not poison accounts. A wrong model ID
      // is a bad request, not an account/session failure, so stop retrying and
      // let the API layer return an invalid_model response.
      if (isNonAccountRequestError(result.error)) {
        throw new Error(result.error || `Invalid model: ${request.model}`);
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
          const retryResult = stream
            ? await provider.chatCompletionStream(account, request)
            : await provider.chatCompletion(account, request);

          if (retryResult.success) {
            await pool.markUsed(account.id);
            return {
              result: retryResult,
              account,
              provider: providerName,
              durationMs: Date.now() - startTime,
            };
          }
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
    ...codebuddyProvider.getModels(),
    ...canvaProvider.getModels(),
  ];
}

export { providers };
