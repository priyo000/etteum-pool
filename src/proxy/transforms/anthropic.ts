import type { ChatCompletionRequest } from "../providers/base";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  thinking?: { type: string; budget_tokens?: number; display?: string; effort?: string; summary?: string };
  effort?: string;
}

function contentToText(content: string | AnthropicContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function anthropicContentToOpenAI(content: string | AnthropicContentBlock[] | undefined): string | any[] {
  if (!Array.isArray(content)) return content || "";
  return content.map((block) => {
    if (block.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: contentToText(block.content as any) || String(block.content || ""),
        is_error: Boolean(block.is_error),
      };
    }
    if (block.type === "tool_use") return block;
    if (block.type === "text") return { type: "text", text: block.text || "" };
    return block;
  });
}

/**
 * Convert Anthropic tool definitions `{ name, description, input_schema }` into
 * the OpenAI shape `{ type: "function", function: { name, description, parameters } }`
 * that every internal provider (kiro, kiro-pro, qoder, ...) expects.
 *
 * Without this, providers receive `input_schema` where they look for
 * `function.parameters`, silently send no usable tool spec upstream, and the
 * model replies with an empty turn — which surfaces in agents as "no reply".
 */
export function anthropicToolsToOpenAI(tools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .map((tool) => {
      // Already OpenAI-shaped — pass through untouched.
      if (tool?.type === "function" && tool.function?.name) return tool;
      const name = tool?.name;
      if (!name) return null;
      const parameters =
        tool.input_schema ?? tool.parameters ?? { type: "object", properties: {} };
      return {
        type: "function",
        function: {
          name,
          description: tool.description || "",
          parameters,
        },
      };
    })
    .filter(Boolean);
}

/**
 * Convert Anthropic `tool_choice` into the OpenAI equivalent.
 *   { type: "auto" }        -> "auto"
 *   { type: "any" }         -> "required"
 *   { type: "tool", name }  -> { type: "function", function: { name } }
 *   "auto" | "none" | ...   -> passed through
 */
export function anthropicToolChoiceToOpenAI(toolChoice: any): any {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return toolChoice.name
        ? { type: "function", function: { name: toolChoice.name } }
        : "required";
    case "none":
      return "none";
    default:
      return undefined;
  }
}

export function anthropicToOpenAI(body: AnthropicMessagesRequest): ChatCompletionRequest {
  const messages: ChatCompletionRequest["messages"] = [];
  const system = contentToText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages || []) {
    if (message.role !== "user" && message.role !== "assistant") continue;

    // ── String content: pass through directly ──
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    if (!Array.isArray(message.content)) continue;
    const blocks = message.content as AnthropicContentBlock[];

    // ── User messages: split text blocks from tool_result blocks ──
    // OpenAI expects tool_result as separate {role:"tool", tool_call_id, content} messages.
    // Anthropic bundles them inside user messages as content blocks.
    if (message.role === "user") {
      const textParts: string[] = [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          // Flush any accumulated text before emitting tool message
          if (textParts.length > 0) {
            messages.push({ role: "user", content: textParts.join("\n") });
            textParts.length = 0;
          }
          const toolResultContent = block.content;
          const text = typeof toolResultContent === "string"
            ? toolResultContent
            : Array.isArray(toolResultContent)
              ? toolResultContent.map((b: any) => b?.type === "text" ? b.text || "" : "").filter(Boolean).join("\n")
              : String(toolResultContent ?? "");
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id as string,
            content: text,
          });
        } else if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "image") {
          // Pass image blocks through as OpenAI image_url content
          textParts.push("[image]");
        }
      }
      // Flush remaining text
      if (textParts.length > 0) {
        messages.push({ role: "user", content: textParts.join("\n") });
      }
      continue;
    }

    // ── Assistant messages: split text from tool_use → tool_calls ──
    if (message.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      for (const block of blocks) {
        if (block.type === "tool_use") {
          let input = (block as any).input || {};
          if (typeof input !== "string") {
            try { input = JSON.stringify(input); } catch { input = "{}"; }
          }
          toolCalls.push({
            id: (block as any).id || `toolu_${crypto.randomUUID().replace(/-/g, "")}`,
            type: "function",
            function: {
              name: (block as any).name || "unknown",
              arguments: input,
            },
          });
        } else if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "thinking") {
          // Skip thinking blocks — not part of OpenAI format
        }
      }
      const msg: any = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : "",
      };
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      messages.push(msg);
      continue;
    }
  }

  const tools = anthropicToolsToOpenAI(body.tools);
  const toolChoice = anthropicToolChoiceToOpenAI(body.tool_choice);

  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
    ...(tools ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(body.effort ? { reasoning_effort: body.effort } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
  };
}

export function openAIToAnthropic(response: any, request: AnthropicMessagesRequest) {
  const choice = response?.choices?.[0];
  const text = choice?.message?.content || "";
  const reasoning = choice?.message?.reasoning_content || "";
  const toolCalls = choice?.message?.tool_calls || [];
  const content = [];
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning, signature: "poolprox_unsigned_reasoning_summary" });
  }
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    let input = call?.function?.arguments || {};
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch { input = {}; }
    }
    content.push({ type: "tool_use", id: call.id, name: call?.function?.name, input });
  }
  const usage = response?.usage || {};
  return {
    id: response?.id?.replace(/^chatcmpl-/, "msg_") || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: response?.model || request.model,
    content: content.length > 0 ? content : [{ type: "text", text }],
    stop_reason: toolCalls.length > 0 ? "tool_use" : choice?.finish_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
    },
  };
}

export function openAIStreamToAnthropic(stream: ReadableStream<Uint8Array>, request: AnthropicMessagesRequest) {
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let started = false;
  let index = 0;
  let blockIndex = -1;
  let textBlockOpen = false;
  let thinkingBlockOpen = false;
  let thinkingSignatureSent = false;
  const toolBlocks = new Map<number, number>();
  const closedToolBlocks = new Set<number>();
  let stopReason = "end_turn";
  let usageFromUpstream = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  // Estimate input tokens from request content (system + messages)
  function estimateInputTokens(): number {
    let tokens = 0;
    if (request.system) {
      const sysText = typeof request.system === "string"
        ? request.system
        : request.system.map((b: any) => b?.text || "").join("");
      tokens += Math.max(1, Math.ceil(sysText.length / 4));
    }
    for (const msg of request.messages || []) {
      if (typeof msg.content === "string") {
        tokens += Math.max(1, Math.ceil(msg.content.length / 4));
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "text" && typeof block.text === "string") {
            tokens += Math.max(1, Math.ceil(block.text.length / 4));
          } else if (block?.type === "tool_result") {
            const text = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b: any) => b?.text || "").join("")
                : "";
            tokens += Math.max(1, Math.ceil(text.length / 4));
          }
        }
      }
      tokens += 4; // role overhead
    }
    return Math.max(1, tokens);
  }

  const estimatedInputTokens = estimateInputTokens();

  function event(name: string, data: unknown) {
    return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function dataPayload(block: string): string | null {
    const lines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"));
    if (lines.length === 0) return null;
    return lines
      .map((line) => line.startsWith("data: ") ? line.slice(6) : line.slice(5))
      .join("\n")
      .trim();
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const startMessage = () => {
        if (started) return;
        started = true;
        controller.enqueue(event("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: request.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: estimatedInputTokens, output_tokens: 0 },
          },
        }));
      };

      const ensureTextBlock = () => {
        if (textBlockOpen) return;
        if (thinkingBlockOpen) {
          closeThinkingBlock();
          thinkingBlockOpen = false;
        }
        blockIndex += 1;
        textBlockOpen = true;
        controller.enqueue(event("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        }));
      };

      const closeThinkingBlock = () => {
        if (!thinkingBlockOpen) return;
        if (!thinkingSignatureSent) {
          controller.enqueue(event("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "signature_delta", signature: "poolprox_unsigned_reasoning_summary" },
          }));
          thinkingSignatureSent = true;
        }
        controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
        thinkingBlockOpen = false;
      };

      try {
        startMessage();
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(event("ping", { type: "ping" }));
          } catch {
            if (heartbeat) clearInterval(heartbeat);
            heartbeat = null;
          }
        }, 10_000);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const payload = dataPayload(part);
            if (!payload) continue;
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              if (chunk?.error) {
                const message = typeof chunk.error === "string"
                  ? chunk.error
                  : chunk.error.message || "Upstream stream error";
                controller.enqueue(event("error", {
                  type: "error",
                  error: { type: "api_error", message },
                }));
                continue;
              }
              const finishReason = chunk?.choices?.[0]?.finish_reason;
              const delta = chunk?.choices?.[0]?.delta || {};
              const reasoning = delta.reasoning_content || "";
              const text = delta.content || "";

              // Capture upstream usage from final chunk
              if (chunk?.usage) {
                usageFromUpstream = {
                  prompt_tokens: Number(chunk.usage.prompt_tokens || 0),
                  completion_tokens: Number(chunk.usage.completion_tokens || 0),
                  total_tokens: Number(chunk.usage.total_tokens || 0),
                };
              }

              if (reasoning) {
                if (!thinkingBlockOpen) {
                  if (textBlockOpen) {
                    controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
                    textBlockOpen = false;
                  }
                  blockIndex += 1;
                  thinkingBlockOpen = true;
                  thinkingSignatureSent = false;
                  controller.enqueue(event("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: { type: "thinking", thinking: "" },
                  }));
                }
                controller.enqueue(event("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "thinking_delta", thinking: reasoning },
                }));
              }

              if (text) {
                ensureTextBlock();
                controller.enqueue(event("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text },
                }));
                index += text.length;
              }
              for (const call of delta.tool_calls || []) {
                stopReason = "tool_use";
                const callIndex = Number(call.index || 0);
                if (!toolBlocks.has(callIndex)) {
                  if (textBlockOpen) {
                    controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
                    textBlockOpen = false;
                  }
                  if (thinkingBlockOpen) {
                    closeThinkingBlock();
                  }
                  blockIndex += 1;
                  toolBlocks.set(callIndex, blockIndex);
                  controller.enqueue(event("content_block_start", {
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: {
                      type: "tool_use",
                      id: call.id,
                      name: call.function?.name,
                      input: {},
                    },
                  }));
                }
                const toolBlockIndex = toolBlocks.get(callIndex)!;
                const partialJson = call.function?.arguments || "";
                if (partialJson) {
                  controller.enqueue(event("content_block_delta", {
                    type: "content_block_delta",
                    index: toolBlockIndex,
                    delta: { type: "input_json_delta", partial_json: partialJson },
                  }));
                }
              }
              if (finishReason === "tool_calls") {
                stopReason = "tool_use";
                for (const toolBlockIndex of toolBlocks.values()) {
                  if (!closedToolBlocks.has(toolBlockIndex)) {
                    controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: toolBlockIndex }));
                    closedToolBlocks.add(toolBlockIndex);
                  }
                }
              } else if (finishReason === "length") {
                stopReason = "max_tokens";
              }
            } catch {
              // ignore malformed upstream stream chunk
            }
          }
        }
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (textBlockOpen) controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
        if (thinkingBlockOpen) closeThinkingBlock();
        for (const toolBlockIndex of toolBlocks.values()) {
          if (!closedToolBlocks.has(toolBlockIndex)) {
            controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: toolBlockIndex }));
          }
        }
        const outputTokens = usageFromUpstream.completion_tokens > 0
          ? usageFromUpstream.completion_tokens
          : Math.max(1, Math.ceil(index / 4));
        const inputTokens = usageFromUpstream.prompt_tokens > 0
          ? usageFromUpstream.prompt_tokens
          : estimatedInputTokens;
        controller.enqueue(event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { input_tokens: inputTokens, output_tokens: outputTokens },
        }));
        controller.enqueue(event("message_stop", { type: "message_stop" }));
        controller.close();
      }
    },
  });
}
