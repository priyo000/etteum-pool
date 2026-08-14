#!/usr/bin/env bun

/**
 * Etteum Pool CLI - Main entry point
 * Provides quick access to common operations
 *
 * Usage:
 *   bun scripts/cli.ts start          # Start proxy server
 *   bun scripts/cli.ts chat           # Interactive chat
 *   bun scripts/cli.ts models         # List available models
 *   bun scripts/cli.ts status         # Check server status
 */

import { spawn } from "bun";
import { existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const PORT = process.env.PORT || "1930";
const API_BASE = `http://localhost:${PORT}/v1`;

function showHelp() {
  console.log(`
🚀 Etteum Pool CLI

Usage: bun scripts/cli.ts <command> [options]

Commands:
  start              Start the proxy server
  stop               Stop the proxy server (Ctrl+C)
  chat               Start interactive chat
  models             List available models
  status             Check server status
  help               Show this help

Chat Options:
  --model <model>    Model to use (default: qd-Qwen3.8-Max-Preview)
  --system <prompt>  Set system prompt

Examples:
  bun scripts/cli.ts start
  bun scripts/cli.ts chat
  bun scripts/cli.ts chat --model qd-Qwen3.7-Max
  bun scripts/cli.ts models
  bun scripts/cli.ts status

Environment Variables:
  PORT               Server port (default: 1930)
  API_KEY            API key (from .env)
`);
}

async function startServer() {
  console.log("🚀 Starting Etteum Pool...\n");

  const proc = spawn(["bun", "scripts/start.ts"], {
    cwd: ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  process.on("SIGINT", () => {
    console.log("\n\nStopping server...");
    proc.kill();
    process.exit(0);
  });

  await proc.exited;
}

async function checkStatus() {
  try {
    const res = await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${process.env.API_KEY}` },
    });

    if (res.ok) {
      console.log("✅ Server is running");
      console.log(`   API: ${API_BASE}`);
      console.log(`   Port: ${PORT}`);

      const data = await res.json();
      const modelCount = data.data?.length || 0;
      console.log(`   Models: ${modelCount} available`);
    } else {
      console.log("❌ Server responded with error:", res.status);
    }
  } catch (err) {
    console.log("❌ Server is not running");
    console.log(`   Tried to connect to: ${API_BASE}`);
    console.log("\n   Start the server with: bun scripts/cli.ts start");
  }
}

async function listModels() {
  try {
    const res = await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${process.env.API_KEY}` },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const models = data.data || [];

    console.log("\n📦 Available Models:\n");
    console.log("Model ID".padEnd(45) + "Provider");
    console.log("─".repeat(65));

    for (const model of models) {
      const provider = model.owned_by || "unknown";
      console.log(model.id.padEnd(45) + provider);
    }

    console.log(`\nTotal: ${models.length} models\n`);
  } catch (err) {
    console.error("❌ Failed to fetch models:", err instanceof Error ? err.message : err);
    console.log("\n   Make sure the server is running: bun scripts/cli.ts start");
    process.exit(1);
  }
}

async function startChat() {
  // Check if server is running
  try {
    await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${process.env.API_KEY}` },
    });
  } catch {
    console.error("❌ Server is not running");
    console.log("   Start the server first: bun scripts/cli.ts start\n");
    process.exit(1);
  }

  // Run chat script
  const args = process.argv.slice(3); // Skip 'bun', 'scripts/cli.ts', 'chat'
  const chatScript = resolve(ROOT, "scripts/chat.ts");

  const proc = spawn(["bun", chatScript, ...args], {
    cwd: ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      OPENAI_API_BASE: API_BASE,
      OPENAI_API_KEY: process.env.API_KEY,
    },
  });

  await proc.exited;
}

async function main() {
  const command = process.argv[2];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case "start":
      await startServer();
      break;

    case "status":
      await checkStatus();
      break;

    case "models":
      await listModels();
      break;

    case "chat":
      await startChat();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
