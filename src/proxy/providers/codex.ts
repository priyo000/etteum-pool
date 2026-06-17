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
  "codex-gpt-5.5-xhigh": "gpt-5.5-xhigh",
  "gpt-5.5-xhigh": "gpt-5.5-xhigh",
  "codex-gpt-5.5": "gpt-5.5",
  "codex-gpt-5.4": "gpt-5.4",
  "codex-gpt-5.3": "gpt-5.3-codex",
  "codex-gpt-5.2": "gpt-5.2",
};

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface CodexReasoningConfig {
  effort?: string;
  summary?: "auto" | "detailed";
}

export class CodexProvider extends BaseProvider {
  name = "codex";

  override ownsModel(model: string): boolean {
    const m = model.toLowerCase();
    return m.startsWith("codex-") || m === "gpt-5-codex" || m === "gpt-5.5-xhigh";
  }

  supportedModels: ModelInfo[] = [
    { id: "codex-auto", object: "model", created: Date.now(), owned_by: "codex", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.5-xhigh", object: "model", created: Date.now(), owned_by: "codex", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.02 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.5", object: "model", created: Date.now(), owned_by: "codex", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.02 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.4", object: "model", created: Date.now(), owned_by: "codex", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.015 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.3", object: "model", created: Date.now(), owned_by: "codex", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.012 / 1000, creditSource: "estimated" },
    { id: "codex-gpt-5.2", object: "model", created: Date.now(), owned_by: "codex", context_window: 200000, max_output: 64000, thinking: true, vision: true, creditUnit: "credit", creditRate: 0.01 / 1000, creditSource: "estimated" },
  ];

  override getModelInfo(model: string): ModelInfo | undefined {
    const normalized = model.toLowerCase();
    if (normalized === "gpt-5.5-xhigh") return super.getModelInfo("codex-gpt-5.5-xhigh");
    return super.getModelInfo(model);
  }

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

  private contentToText(content: unknown): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text" || block?.type === "input_text" || block?.type === "output_text") return block.text || "";
        if (block?.type === "tool_result") return this.contentToText(block.content) || String(block.content || "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private stringifyToolInput(input: unknown): string {
    if (typeof input === "string") return input;
    try { return JSON.stringify(input ?? {}); } catch { return "{}"; }
  }

  private normalizeTools(tools: any[] | undefined): any[] {
    if (!Array.isArray(tools) || tools.length === 0) return [];
    return tools
      .map((tool) => {
        if (tool?.type === "function" && tool.function?.name) {
          return {
            type: "function",
            name: tool.function.name,
            description: tool.function.description || "",
            parameters: tool.function.parameters || { type: "object", properties: {} },
          };
        }
        if (tool?.name) {
          return {
            type: "function",
            name: tool.name,
            description: tool.description || "",
            parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  private normalizeToolChoice(toolChoice: any): any {
    if (toolChoice == null) return "auto";
    if (typeof toolChoice === "string") return toolChoice;
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return { type: "function", name: toolChoice.function.name };
    }
    if (toolChoice.type === "tool" && toolChoice.name) {
      return { type: "function", name: toolChoice.name };
    }
    return toolChoice;
  }

  private normalizeReasoningEffort(effort: unknown): string | undefined {
    if (typeof effort !== "string") return undefined;
    const normalized = effort.toLowerCase();
    if (["minimal", "low", "medium", "high", "xhigh"].includes(normalized)) return normalized;
    return undefined;
  }

  private effortFromThinkingBudget(budgetTokens: unknown): string | undefined {
    if (typeof budgetTokens !== "number" || !Number.isFinite(budgetTokens) || budgetTokens <= 0) {
      return undefined;
    }
    if (budgetTokens >= 16_000) return "high";
    if (budgetTokens >= 4_000) return "medium";
    return "low";
  }

  private buildReasoning(request: ChatCompletionRequest): CodexReasoningConfig | undefined {
    const thinking = request.thinking as any;
    if (thinking?.type === "disabled" || request.reasoning_effort === "none") return undefined;

    const effort =
      this.normalizeReasoningEffort(request.reasoning_effort) ||
      this.normalizeReasoningEffort(thinking?.effort) ||
      this.effortFromThinkingBudget(thinking?.budget_tokens) ||
      (request.model.toLowerCase().includes("xhigh") ? "xhigh" : undefined) ||
      (thinking ? "medium" : undefined);

    const wantsVisibleSummary =
      (thinking && thinking.display !== "omitted") ||
      !!request.reasoning_effort ||
      request.model.toLowerCase().includes("xhigh");
    const summary = wantsVisibleSummary
      ? (thinking?.summary === "detailed" ? "detailed" : "auto")
      : undefined;

    if (!effort && !summary) return undefined;
    return { ...(effort ? { effort } : {}), ...(summary ? { summary } : {}) };
  }

  private textFromReasoningPart(part: any): string {
    if (!part) return "";
    if (typeof part === "string") return part;
    if (typeof part.text === "string") return part.text;
    if (typeof part.summary_text === "string") return part.summary_text;
    if (typeof part.content === "string") return part.content;
    if (Array.isArray(part.content)) {
      return part.content.map((inner: any) => this.textFromReasoningPart(inner)).filter(Boolean).join("\n");
    }
    return "";
  }

  private extractReasoningItemText(item: any): string {
    if (item?.type !== "reasoning") return "";
    const parts = [item.summary, item.content, item.text, item.reasoning].flatMap((value) => {
      if (Array.isArray(value)) return value;
      return value == null ? [] : [value];
    });
    return parts.map((part) => this.textFromReasoningPart(part)).filter(Boolean).join("\n");
  }

  private extractReasoningDelta(event: any): string {
    const type = event?.type || "";
    if (
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta" ||
      type === "response.reasoning.delta"
    ) {
      return typeof event.delta === "string" ? event.delta : "";
    }
    return "";
  }

  private buildPayload(request: ChatCompletionRequest): { instructions: string; input: unknown[] } {
    const systemParts: string[] = [];
    const items: unknown[] = [];
    for (const msg of request.messages) {
      const rawRole = msg.role as string;
      const text = this.contentToText(msg.content);
      if (rawRole === "system") {
        if (text) systemParts.push(text);
        continue;
      }
      if (rawRole === "tool") {
        items.push({
          type: "function_call_output",
          call_id: msg.tool_call_id || crypto.randomUUID(),
          output: text,
        });
        continue;
      }

      const role = rawRole === "tool" ? "user" : rawRole;
      if (text) {
        items.push({
          type: "message",
          role,
          content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
        });
      }

      if (Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block?.type === "tool_use" && block.id && block.name) {
            items.push({
              type: "function_call",
              call_id: block.id,
              name: block.name,
              arguments: this.stringifyToolInput(block.input),
            });
          } else if (block?.type === "tool_result" && block.tool_use_id) {
            items.push({
              type: "function_call_output",
              call_id: block.tool_use_id,
              output: this.contentToText(block.content) || String(block.content || ""),
            });
          }
        }
      }

      for (const call of msg.tool_calls || []) {
        const name = call?.function?.name;
        if (!name) continue;
        items.push({
          type: "function_call",
          call_id: call.id || crypto.randomUUID(),
          name,
          arguments: this.stringifyToolInput(call.function?.arguments),
        });
      }
    }
    return { instructions: systemParts.join("\n\n"), input: items };
  }

  private collectCompletedToolCalls(response: any, byIndex: Map<number, PendingToolCall>) {
    for (const [index, item] of (response?.output || []).entries()) {
      if (item?.type !== "function_call") continue;
      byIndex.set(index, {
        index,
        id: item.call_id || item.id || `call_${index}`,
        name: item.name || "",
        arguments: item.arguments || "",
      });
    }
  }

  private toolCallsFromMap(byIndex: Map<number, PendingToolCall>) {
    return [...byIndex.values()]
      .filter((call) => call.name)
      .sort((a, b) => a.index - b.index)
      .map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
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
    const tools = this.normalizeTools(request.tools);
    const reasoning = this.buildReasoning(request);
    const body = {
      model: this.resolveModel(request.model),
      instructions,
      input,
      tools,
      tool_choice: tools.length > 0 ? this.normalizeToolChoice(request.tool_choice) : "auto",
      parallel_tool_calls: tools.length > 0,
      store: false,
      stream: true,
      include: [],
      ...(reasoning ? { reasoning } : {}),
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
      let reasoningText = "";
      let inputTokens = 0;
      let outputTokens = 0;
      const toolCallsByIndex = new Map<number, PendingToolCall>();
      const reasoningByOutput = new Map<number, string>();

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
            const reasoningDelta = this.extractReasoningDelta(obj);
            if (reasoningDelta) {
              const index = Number(obj.output_index ?? 0);
              reasoningByOutput.set(index, `${reasoningByOutput.get(index) || ""}${reasoningDelta}`);
              reasoningText += reasoningDelta;
            } else if (t === "response.reasoning_summary_text.done" || t === "response.reasoning_summary_part.done") {
              const index = Number(obj.output_index ?? 0);
              const doneText = typeof obj.text === "string" ? obj.text : this.textFromReasoningPart(obj.part);
              if (doneText && !reasoningByOutput.get(index)) {
                reasoningByOutput.set(index, doneText);
                reasoningText += doneText;
              }
            } else if (t === "response.output_text.delta") {
              text += obj.delta || "";
            } else if (t === "response.output_item.added" || t === "response.output_item.done") {
              const item = obj.item || {};
              if (item.type === "reasoning") {
                const index = Number(obj.output_index ?? 0);
                const itemText = this.extractReasoningItemText(item);
                if (itemText && !reasoningByOutput.get(index)) {
                  reasoningByOutput.set(index, itemText);
                  reasoningText += itemText;
                }
              } else if (item.type === "function_call") {
                const index = Number(obj.output_index ?? toolCallsByIndex.size);
                toolCallsByIndex.set(index, {
                  index,
                  id: item.call_id || item.id || `call_${index}`,
                  name: item.name || "",
                  arguments: item.arguments || toolCallsByIndex.get(index)?.arguments || "",
                });
              }
            } else if (t === "response.function_call_arguments.delta") {
              const index = Number(obj.output_index ?? 0);
              const current = toolCallsByIndex.get(index) || { index, id: obj.call_id || `call_${index}`, name: obj.name || "", arguments: "" };
              current.arguments += obj.delta || "";
              toolCallsByIndex.set(index, current);
            } else if (t === "response.function_call_arguments.done") {
              const index = Number(obj.output_index ?? 0);
              const current = toolCallsByIndex.get(index) || { index, id: obj.call_id || `call_${index}`, name: obj.name || "", arguments: "" };
              current.arguments = obj.arguments || current.arguments;
              toolCallsByIndex.set(index, current);
            } else if (t === "response.completed") {
              this.collectCompletedToolCalls(obj.response, toolCallsByIndex);
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
      const toolCalls = this.toolCallsFromMap(toolCallsByIndex);

      const resp: ChatCompletionResponse = {
        id: this.generateId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: text,
            ...(reasoningText ? { reasoning_content: reasoningText } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          } as any,
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
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
      const provider = this;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let started = false;
          let accumulated = "";
          let hasToolCalls = false;
          const toolCallsByIndex = new Map<number, PendingToolCall>();
          const emittedToolIndexes = new Set<number>();
          const reasoningByOutput = new Map<number, string>();

          const emit = (delta: any, finish_reason: string | null = null) => {
            const chunk: any = {
              id, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta, finish_reason }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          };

          const emitRole = () => {
            if (started) return;
            started = true;
            emit({ role: "assistant" });
          };

          const emitToolStart = (call: PendingToolCall) => {
            emitRole();
            hasToolCalls = true;
            emittedToolIndexes.add(call.index);
            emit({
              tool_calls: [{
                index: call.index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: "" },
              }],
            });
          };

          const emitToolArguments = (index: number, delta: string) => {
            if (!delta) return;
            emitRole();
            hasToolCalls = true;
            emit({
              tool_calls: [{
                index,
                function: { arguments: delta },
              }],
            });
          };

          const emitReasoning = (index: number, delta: string) => {
            if (!delta) return;
            emitRole();
            reasoningByOutput.set(index, `${reasoningByOutput.get(index) || ""}${delta}`);
            emit({ reasoning_content: delta });
          };

          const emitMissingCompletedToolCalls = () => {
            for (const pending of [...toolCallsByIndex.values()].sort((a, b) => a.index - b.index)) {
              if (!pending.name) continue;
              if (!emittedToolIndexes.has(pending.index)) {
                emitToolStart(pending);
                emitToolArguments(pending.index, pending.arguments || "{}");
              }
            }
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
                  const reasoningDelta = provider.extractReasoningDelta(obj);

                  if (reasoningDelta) {
                    emitReasoning(Number(obj.output_index ?? 0), reasoningDelta);
                  } else if (t === "response.reasoning_summary_text.done" || t === "response.reasoning_summary_part.done") {
                    const index = Number(obj.output_index ?? 0);
                    const doneText = typeof obj.text === "string" ? obj.text : provider.textFromReasoningPart(obj.part);
                    if (doneText && !reasoningByOutput.get(index)) emitReasoning(index, doneText);
                  } else if (t === "response.output_text.delta") {
                    const delta = obj.delta || "";
                    if (!delta) continue;
                    emitRole();
                    accumulated += delta;
                    emit({ content: delta });
                  } else if (t === "response.output_item.added" || t === "response.output_item.done") {
                    const item = obj.item || {};
                    if (item.type === "reasoning") {
                      const index = Number(obj.output_index ?? 0);
                      const itemText = provider.extractReasoningItemText(item);
                      if (itemText && !reasoningByOutput.get(index)) {
                        emitReasoning(index, itemText);
                      }
                    } else if (item.type === "function_call") {
                      const index = Number(obj.output_index ?? toolCallsByIndex.size);
                      const current = toolCallsByIndex.get(index) || {
                        index,
                        id: item.call_id || item.id || `call_${index}`,
                        name: item.name || "",
                        arguments: "",
                      };
                      current.id = item.call_id || item.id || current.id;
                      current.name = item.name || current.name;
                      current.arguments = item.arguments || current.arguments;
                      toolCallsByIndex.set(index, current);
                      if (current.name && !emittedToolIndexes.has(index)) {
                        emitToolStart(current);
                        if (current.arguments) emitToolArguments(index, current.arguments);
                      }
                    }
                  } else if (t === "response.function_call_arguments.delta") {
                    const index = Number(obj.output_index ?? 0);
                    const current = toolCallsByIndex.get(index) || { index, id: obj.call_id || `call_${index}`, name: obj.name || "", arguments: "" };
                    current.arguments += obj.delta || "";
                    toolCallsByIndex.set(index, current);
                    emitToolArguments(index, obj.delta || "");
                  } else if (t === "response.function_call_arguments.done") {
                    const index = Number(obj.output_index ?? 0);
                    const current = toolCallsByIndex.get(index) || { index, id: obj.call_id || `call_${index}`, name: obj.name || "", arguments: "" };
                    const previousLength = current.arguments.length;
                    current.arguments = obj.arguments || current.arguments;
                    toolCallsByIndex.set(index, current);
                    if (!emittedToolIndexes.has(index) && current.name) emitToolStart(current);
                    if (current.arguments.length > previousLength && previousLength === 0) emitToolArguments(index, current.arguments);
                  } else if (t === "response.completed" || t === "response.done") {
                    provider.collectCompletedToolCalls(obj.response, toolCallsByIndex);
                    emitMissingCompletedToolCalls();
                    emit({}, hasToolCalls ? "tool_calls" : "stop");
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
            emitMissingCompletedToolCalls();
            emit({}, hasToolCalls ? "tool_calls" : "stop");
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

      const toIso = (value: unknown): string | null => {
        if (value == null || value === "") return null;
        if (typeof value === "number") return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
      };
      const subscriptionSource = data.subscription || data.account_plan || data.billing || data.plan || data.entitlement || {};
      const subscription = {
        status: String(subscriptionSource.status || data.subscription_status || data.plan_status || ""),
        expires_at: toIso(subscriptionSource.expires_at || subscriptionSource.expire_at || subscriptionSource.ends_at || subscriptionSource.current_period_end || data.expires_at || data.plan_expires_at),
        renews_at: toIso(subscriptionSource.renews_at || subscriptionSource.renewal_date || subscriptionSource.next_billing_date || subscriptionSource.current_period_end || data.renews_at || data.renewal_date),
        source_keys: Object.keys(subscriptionSource).slice(0, 20),
      };

      const codexQuota = {
        plan_type: String(data.plan_type || subscriptionSource.plan_type || subscriptionSource.type || ""),
        subscription,
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
