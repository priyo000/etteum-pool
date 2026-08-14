#!/usr/bin/env bun

/**
 * Etteum Pool Chat CLI
 * Interactive chat with AI models via etteum-pool proxy
 *
 * Usage:
 *   bun scripts/chat.ts                          # Interactive chat (default: Qwen 3.8 Max)
 *   bun scripts/chat.ts --model qd-Qwen3.7-Max   # Use specific model
 *   bun scripts/chat.ts --list-models            # List available models
 *   bun scripts/chat.ts --system "You are..."    # Set system prompt
 */

import * as readline from "node:readline";

const API_BASE = process.env.OPENAI_API_BASE || "http://localhost:1930/v1";
const API_KEY = process.env.OPENAI_API_KEY || process.env.API_KEY || "pool-proxy-secret-key";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ModelInfo {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    model: "qd-Qwen3.8-Max-Preview",
    system: null as string | null,
    listModels: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) {
      options.model = args[++i];
    } else if (args[i] === "--system" && args[i + 1]) {
      options.system = args[++i];
    } else if (args[i] === "--list-models") {
      options.listModels = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      options.help = true;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Etteum Pool Chat CLI

Usage:
  bun scripts/chat.ts [options]

Options:
  --model <model>     Model to use (default: qd-Qwen3.8-Max-Preview)
  --system <prompt>   Set system prompt
  --list-models       List available models
  -h, --help          Show this help

Examples:
  bun scripts/chat.ts
  bun scripts/chat.ts --model qd-Qwen3.7-Max
  bun scripts/chat.ts --system "You are a helpful coding assistant"
  bun scripts/chat.ts --list-models

Environment Variables:
  OPENAI_API_BASE     API base URL (default: http://localhost:1930/v1)
  OPENAI_API_KEY      API key (default: pool-proxy-secret-key)
`);
}

async function listModels() {
  try {
    const res = await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const models: ModelInfo[] = data.data || [];

    console.log("\nAvailable Models:\n");
    console.log("ID".padEnd(40) + "Provider");
    console.log("-".repeat(60));

    for (const model of models) {
      const provider = model.owned_by || "unknown";
      console.log(model.id.padEnd(40) + provider);
    }

    console.log(`\nTotal: ${models.length} models\n`);
  } catch (err) {
    console.error("Failed to fetch models:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

async function streamChat(messages: ChatMessage[], model: string) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || `HTTP ${res.status}: ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            process.stdout.write(delta);
            fullContent += delta;
          }
        } catch (e) {
          // Skip parse errors
        }
      }
    }
  }

  process.stdout.write("\n");
  return fullContent;
}

async function interactiveChat(model: string, systemPrompt: string | null) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const messages: ChatMessage[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  console.log(`\n🤖 Etteum Pool Chat CLI`);
  console.log(`Model: ${model}`);
  console.log(`API: ${API_BASE}`);
  console.log(`Type your message (Ctrl+C to exit)\n`);

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        console.log("\nGoodbye!\n");
        rl.close();
        process.exit(0);
      }

      messages.push({ role: "user", content: trimmed });

      try {
        process.stdout.write("\nAssistant: ");
        const response = await streamChat(messages, model);
        messages.push({ role: "assistant", content: response });
      } catch (err) {
        console.error("\nError:", err instanceof Error ? err.message : err);
      }

      prompt();
    });
  };

  prompt();
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.listModels) {
    await listModels();
    process.exit(0);
  }

  await interactiveChat(options.model, options.system);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
