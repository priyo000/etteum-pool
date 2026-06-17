import { Hono } from "hono";
import { routeRequest, getAllModels } from "../proxy/router";
import type { ChatCompletionRequest } from "../proxy/providers/base";
import { broadcast } from "../ws/index";

export const modelTestRouter = new Hono();

interface TestResult {
  model: string;
  provider: string;
  status: "success" | "error";
  durationMs: number;
  response?: string;
  error?: string;
}

const TEST_PROMPT: ChatCompletionRequest = {
  model: "",
  messages: [
    { role: "user", content: "hi" },
  ],
};

/**
 * POST /api/models/test
 * Body: { model: string }
 * Tests a single model by sending a minimal request.
 */
modelTestRouter.post("/test", async (c) => {
  const { model } = await c.req.json<{ model: string }>();
  if (!model) return c.json({ error: "model is required" }, 400);

  const result = await testModel(model);
  return c.json(result);
});

/**
 * POST /api/models/test-all
 * Tests all available models concurrently (max 5 at a time).
 * Returns array of results.
 */
modelTestRouter.post("/test-all", async (c) => {
  const allModels = getAllModels();
  const results: TestResult[] = [];
  const concurrency = 5;

  // Process in batches
  for (let i = 0; i < allModels.length; i += concurrency) {
    const batch = allModels.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((m) => testModel(m.id))
    );
    results.push(...batchResults);

    // Broadcast progress
    broadcast({
      type: "model_test_progress",
      data: {
        completed: results.length,
        total: allModels.length,
        latest: batchResults,
      },
    });
  }

  return c.json({ results });
});

/**
 * POST /api/models/test-provider
 * Body: { provider: string }
 * Tests all models for a specific provider concurrently (max 3 at a time).
 */
modelTestRouter.post("/test-provider", async (c) => {
  const { provider } = await c.req.json<{ provider: string }>();
  if (!provider) return c.json({ error: "provider is required" }, 400);

  const allModels = getAllModels();
  const providerModels = allModels.filter((m) => m.owned_by === provider);

  if (providerModels.length === 0) {
    return c.json({ error: `No models found for provider: ${provider}` }, 404);
  }

  const results: TestResult[] = [];
  const concurrency = 3;

  for (let i = 0; i < providerModels.length; i += concurrency) {
    const batch = providerModels.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((m) => testModel(m.id))
    );
    results.push(...batchResults);

    broadcast({
      type: "model_test_progress",
      data: {
        provider,
        completed: results.length,
        total: providerModels.length,
        latest: batchResults,
      },
    });
  }

  return c.json({ results, provider });
});

async function testModel(modelId: string): Promise<TestResult> {
  const start = Date.now();
  try {
    const request: ChatCompletionRequest = { ...TEST_PROMPT, model: modelId };
    const { result, provider, durationMs } = await routeRequest(request, false);

    if (result.success && result.response) {
      const content =
        result.response.choices?.[0]?.message?.content || "";
      return {
        model: modelId,
        provider,
        status: "success",
        durationMs,
        response: typeof content === "string" ? content.slice(0, 100) : JSON.stringify(content).slice(0, 100),
      };
    }

    return {
      model: modelId,
      provider,
      status: "error",
      durationMs,
      error: result.error || "No response",
    };
  } catch (err: any) {
    return {
      model: modelId,
      provider: "unknown",
      status: "error",
      durationMs: Date.now() - start,
      error: err.message || String(err),
    };
  }
}
