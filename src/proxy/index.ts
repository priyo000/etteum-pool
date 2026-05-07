import { Hono } from "hono";
import { routeRequest, getAllModels, providers } from "./router";
import { db } from "../db/index";
import { accounts, requestLogs } from "../db/schema";
import { broadcast } from "../ws/index";
import type { ChatCompletionRequest, CreditSource } from "./providers/base";
import {
  anthropicToOpenAI,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  type AnthropicMessagesRequest,
} from "./transforms/anthropic";
import { isBadUpstreamRequest, isInvalidModelError } from "./errors";
import { prepareLogBody } from "./logging";
import { eq } from "drizzle-orm";

export const proxyRouter = new Hono();

function normalizeModelId(model: string): string {
  // Common typo seen from clients: "sonet" -> canonical Anthropic "sonnet".
  return model.replace(/claude-sonet/gi, "claude-sonnet");
}

function computeCredits(
  provider: keyof typeof providers,
  model: string,
  totalTokens: number,
  resultCredits?: number,
  resultCreditSource?: CreditSource
) {
  if (resultCredits !== undefined && resultCredits > 0) {
    return {
      creditsUsed: Math.max(0.01, resultCredits),
      creditSource: resultCreditSource || "upstream" as CreditSource,
    };
  }

  if (totalTokens > 0) {
    return {
      creditsUsed: Math.max(0.01, totalTokens * providers[provider].getProviderCreditRate(model)),
      creditSource: "estimated" as CreditSource,
    };
  }

  return {
    creditsUsed: 0,
    creditSource: resultCreditSource || "estimated" as CreditSource,
  };
}

function extractUsageFromSsePayload(payload: string) {
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload);
    const usage = parsed.usage;
    const choice = parsed.choices?.[0];
    const content = String(
      choice?.delta?.content ??
      choice?.message?.content ??
      choice?.text ??
      parsed?.delta?.content ??
      parsed?.content ??
      parsed?.text ??
      ""
    );

    return {
      content,
      promptTokens: Number(usage?.prompt_tokens || usage?.input_tokens || 0),
      completionTokens: Number(usage?.completion_tokens || usage?.output_tokens || 0),
      totalTokens: Number(usage?.total_tokens || 0),
      creditsUsed: Number(usage?.credits_used || usage?.creditsUsed || parsed.credits_used || parsed.creditsUsed || 0),
    };
  } catch {
    return null;
  }
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function wrapStreamWithUsageFinalizer(
  stream: ReadableStream<Uint8Array>,
  context: {
    logId?: number;
    accountId: number;
    accountEmail: string;
    provider: keyof typeof providers;
    model: string;
    quotaBefore: number;
    startedAt: number;
    fallbackPromptTokens: number;
    fallbackCompletionTokens: number;
    fallbackTotalTokens: number;
    fallbackCreditsUsed: number;
    fallbackCreditSource: CreditSource;
  }
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let reader: ReturnType<ReadableStream<Uint8Array>["getReader"]> | undefined;
  let buffer = "";
  let streamedContent = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let upstreamCredits = 0;

  const observe = (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed.slice(5);
      const usage = extractUsageFromSsePayload(payload.trim());
      if (!usage) continue;
      streamedContent += usage.content || "";
      promptTokens = usage.promptTokens || promptTokens;
      completionTokens = usage.completionTokens || completionTokens;
      totalTokens = usage.totalTokens || totalTokens;
      upstreamCredits = usage.creditsUsed || upstreamCredits;
    }
  };

  const finalize = () => {
    const finalPromptTokens = promptTokens || context.fallbackPromptTokens;
    const finalCompletionTokens = completionTokens || estimateTokensFromText(streamedContent) || context.fallbackCompletionTokens;
    const finalTotalTokens = totalTokens || finalPromptTokens + finalCompletionTokens || context.fallbackTotalTokens;
    const { creditsUsed, creditSource } = computeCredits(
      context.provider,
      context.model,
      finalTotalTokens,
      upstreamCredits || context.fallbackCreditsUsed,
      upstreamCredits > 0 ? "upstream" : context.fallbackCreditSource
    );
    const quotaAfter = context.quotaBefore > 0 ? Math.max(0, context.quotaBefore - creditsUsed) : 0;
    const durationMs = Math.max(0, Date.now() - context.startedAt);

    void (async () => {
      try {
        if (context.quotaBefore > 0) {
          await db
            .update(accounts)
            .set({ quotaRemaining: quotaAfter, updatedAt: new Date() })
            .where(eq(accounts.id, context.accountId));
        }

        if (context.logId) {
          await db
            .update(requestLogs)
            .set({
              promptTokens: finalPromptTokens,
              completionTokens: finalCompletionTokens,
              totalTokens: finalTotalTokens,
              creditsUsed,
              durationMs,
              accountQuotaAfter: quotaAfter,
            })
            .where(eq(requestLogs.id, context.logId));
        }

        broadcast({
          type: "request_log",
          data: {
            id: context.logId,
            accountId: context.accountId,
            accountEmail: context.accountEmail,
            email: context.accountEmail,
            provider: context.provider,
            model: context.model,
            promptTokens: finalPromptTokens,
            completionTokens: finalCompletionTokens,
            totalTokens: finalTotalTokens,
            creditsUsed,
            status: "success",
            durationMs,
            accountQuotaBefore: context.quotaBefore,
            accountQuotaAfter: quotaAfter,
            createdAt: new Date(context.startedAt).toISOString(),
            requestBody: prepareLogBody({
              model: context.model,
              stream: true,
              _poolprox: {
                creditSource,
                creditUnit: providers[context.provider].getProviderCreditUnit(context.model),
                creditRate: providers[context.provider].getProviderCreditRate(context.model),
              },
            }),
          },
        });
      } catch (error) {
        console.error("[Proxy] Failed to finalize stream usage:", error);
      }
    })();
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const streamReader = stream.getReader();
      reader = streamReader;
      try {
        while (true) {
          const { done, value } = await streamReader.read();
          if (done) break;
          observe(value);
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        return;
      } finally {
        controller.close();
        finalize();
      }
    },
    async cancel(reason) {
      try {
        await reader?.cancel(reason);
      } finally {
        finalize();
      }
    },
  });
}

async function handleChatCompletion(body: ChatCompletionRequest) {
  body = { ...body, model: normalizeModelId(body.model) };
  const isStream = body.stream === true;
  const { result, account, provider, durationMs } = await routeRequest(body, isStream);

  const promptTokens = result.promptTokens || result.response?.usage?.prompt_tokens || 0;
  const completionTokens = result.completionTokens || result.response?.usage?.completion_tokens || 0;
  const totalTokens = result.tokensUsed || result.response?.usage?.total_tokens || promptTokens + completionTokens;

  const { creditsUsed, creditSource } = computeCredits(
    provider,
    body.model,
    totalTokens,
    result.creditsUsed,
    result.creditSource
  );

  const quotaBefore = Number(account.quotaRemaining || 0);
  const quotaAfter = quotaBefore > 0 ? Math.max(0, quotaBefore - creditsUsed) : 0;

  if (quotaBefore > 0) {
    await db
      .update(accounts)
      .set({ quotaRemaining: quotaAfter, updatedAt: new Date() })
      .where(eq(accounts.id, account.id));
  }

  const logEntry = {
    accountId: account.id,
    accountEmail: account.email,
    provider,
    model: body.model,
    promptTokens,
    completionTokens,
    totalTokens,
    creditsUsed,
    status: "success" as const,
    durationMs,
    requestBody: prepareLogBody({
      ...body,
      _poolprox: {
        creditSource,
        creditUnit: providers[provider].getProviderCreditUnit(body.model),
        creditRate: providers[provider].getProviderCreditRate(body.model),
      },
    }),
    responseBody: prepareLogBody(result.response),
    accountQuotaBefore: quotaBefore,
    accountQuotaAfter: quotaAfter,
  };

  if (isStream && result.stream) {
    const [created] = await db.insert(requestLogs).values(logEntry).returning();
    const createdAt = created?.createdAt?.toISOString?.() || new Date().toISOString();

    broadcast({
      type: "request_started",
      data: { ...logEntry, id: created?.id, email: account.email, createdAt },
    });

    result.stream = wrapStreamWithUsageFinalizer(result.stream, {
      logId: created?.id,
      accountId: account.id,
      accountEmail: account.email,
      provider,
      model: body.model,
      quotaBefore,
      startedAt: Date.now() - durationMs,
      fallbackPromptTokens: promptTokens,
      fallbackCompletionTokens: completionTokens,
      fallbackTotalTokens: totalTokens,
      fallbackCreditsUsed: creditsUsed,
      fallbackCreditSource: creditSource,
    });

    return { result, isStream };
  }

  await db.insert(requestLogs).values(logEntry);

  broadcast({
    type: "request_log",
    data: { ...logEntry, email: account.email, createdAt: new Date().toISOString() },
  });

  return { result, isStream };
}

/**
 * GET /v1/models - List available models
 */
proxyRouter.get("/v1/models", (c) => {
  const models = getAllModels();
  return c.json({
    object: "list",
    data: models,
  });
});

/**
 * POST /v1/chat/completions - Chat completion (streaming + non-streaming)
 */
proxyRouter.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json<ChatCompletionRequest>();

  // Validate request
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json(
      {
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      },
      400
    );
  }

  if (!body.model) {
    return c.json(
      {
        error: {
          message: "model is required",
          type: "invalid_request_error",
          code: "invalid_model",
        },
      },
      400
    );
  }

  const isStream = body.stream === true;

  try {
    const { result } = await handleChatCompletion(body);

    if (isStream && result.stream) {
      // Return SSE stream
      return new Response(result.stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // Return JSON response
    return c.json(result.response);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    // Log the error
    await db.insert(requestLogs).values({
      provider: "unknown",
      model: body.model,
      status: "error",
      errorMessage,
      requestBody: prepareLogBody(body),
      responseBody: prepareLogBody({ error: errorMessage }),
      durationMs: 0,
    });

    broadcast({
      type: "request_error",
      data: { model: body.model, error: errorMessage },
    });

    const invalidModel = isInvalidModelError(errorMessage);
    const badUpstreamRequest = isBadUpstreamRequest(errorMessage);

    return c.json(
      {
        error: {
          message: errorMessage,
          type: invalidModel || badUpstreamRequest ? "invalid_request_error" : "server_error",
          code: invalidModel ? "invalid_model" : badUpstreamRequest ? "invalid_request" : "proxy_error",
        },
      },
      invalidModel || badUpstreamRequest ? 400 : 503
    );
  }
});

/**
 * POST /v1/messages - Anthropic Messages-compatible endpoint
 */
proxyRouter.post("/v1/messages", async (c) => {
  const body = await c.req.json<AnthropicMessagesRequest>();

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "messages is required and must be a non-empty array" } }, 400);
  }

  if (!body.model) {
    return c.json({ type: "error", error: { type: "invalid_request_error", message: "model is required" } }, 400);
  }

  const openAIRequest = anthropicToOpenAI(body);

  try {
    const { result } = await handleChatCompletion(openAIRequest);

    if (body.stream === true && result.stream) {
      return new Response(openAIStreamToAnthropic(result.stream, body), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    return c.json(openAIToAnthropic(result.response, body));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await db.insert(requestLogs).values({
      provider: "unknown",
      model: body.model,
      status: "error",
      errorMessage,
      requestBody: prepareLogBody(body),
      responseBody: prepareLogBody({ error: errorMessage }),
      durationMs: 0,
    });

    broadcast({ type: "request_error", data: { model: body.model, error: errorMessage } });

    const invalidModel = isInvalidModelError(errorMessage);
    const badUpstreamRequest = isBadUpstreamRequest(errorMessage);
    return c.json({
      type: "error",
      error: {
        type: invalidModel || badUpstreamRequest ? "invalid_request_error" : "api_error",
        message: errorMessage,
      },
    }, invalidModel || badUpstreamRequest ? 400 : 503);
  }
});
