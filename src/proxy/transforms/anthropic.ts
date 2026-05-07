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

export function anthropicToOpenAI(body: AnthropicMessagesRequest): ChatCompletionRequest {
  const messages: ChatCompletionRequest["messages"] = [];
  const system = contentToText(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages || []) {
    messages.push({
      role: message.role,
      content: anthropicContentToOpenAI(message.content),
    });
  }

  return {
    model: body.model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream,
    tools: body.tools,
    tool_choice: body.tool_choice,
  };
}

export function openAIToAnthropic(response: any, request: AnthropicMessagesRequest) {
  const choice = response?.choices?.[0];
  const text = choice?.message?.content || "";
  const toolCalls = choice?.message?.tool_calls || [];
  const content = [];
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
  const toolBlocks = new Map<number, number>();
  const closedToolBlocks = new Set<number>();
  let stopReason = "end_turn";

  function event(name: string, data: unknown) {
    return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();

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
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }));
      };

      const ensureTextBlock = () => {
        if (textBlockOpen) return;
        blockIndex += 1;
        textBlockOpen = true;
        controller.enqueue(event("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        }));
      };

      try {
        startMessage();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
            if (!dataLine) continue;
            const payload = dataLine.slice(6).trim();
            if (payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              const finishReason = chunk?.choices?.[0]?.finish_reason;
              const text = chunk?.choices?.[0]?.delta?.content || "";
              if (text) {
                ensureTextBlock();
                controller.enqueue(event("content_block_delta", {
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "text_delta", text },
                }));
                index += text.length;
              }
              for (const call of chunk?.choices?.[0]?.delta?.tool_calls || []) {
                stopReason = "tool_use";
                const callIndex = Number(call.index || 0);
                if (!toolBlocks.has(callIndex)) {
                  if (textBlockOpen) {
                    controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
                    textBlockOpen = false;
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
        if (textBlockOpen) controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: blockIndex }));
        for (const toolBlockIndex of toolBlocks.values()) {
          if (!closedToolBlocks.has(toolBlockIndex)) {
            controller.enqueue(event("content_block_stop", { type: "content_block_stop", index: toolBlockIndex }));
          }
        }
        controller.enqueue(event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: Math.max(1, Math.ceil(index / 4)) },
        }));
        controller.enqueue(event("message_stop", { type: "message_stop" }));
        controller.close();
      }
    },
  });
}
