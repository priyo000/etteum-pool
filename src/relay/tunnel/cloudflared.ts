/**
 * Cloudflared Quick Tunnel
 *
 * Downloads the cloudflared binary (if not present), spawns a quick tunnel
 * that exposes the local pool to the internet via a *.trycloudflare.com URL.
 * No Cloudflare account needed — uses "quick tunnels" (free, ephemeral).
 *
 * Based on 9router's implementation.
 */
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";

// ─── Platform Detection ──────────────────────────────────────────────────────

const PLATFORM = os.platform();
const ARCH = os.arch();
const IS_WINDOWS = PLATFORM === "win32";

const GITHUB_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download";

const PLATFORM_BINARIES: Record<string, Record<string, string>> = {
  darwin: {
    x64: "cloudflared-darwin-amd64.tgz",
    arm64: "cloudflared-darwin-arm64.tgz",
  },
  win32: {
    x64: "cloudflared-windows-amd64.exe",
    ia32: "cloudflared-windows-386.exe",
    arm64: "cloudflared-windows-386.exe",
  },
  linux: {
    x64: "cloudflared-linux-amd64",
    arm64: "cloudflared-linux-arm64",
  },
};

function getDownloadUrl(): string {
  const platformMap = PLATFORM_BINARIES[PLATFORM];
  if (!platformMap) throw new Error(`Unsupported platform: ${PLATFORM}`);
  const binary = platformMap[ARCH] || platformMap["x64"];
  if (!binary) throw new Error(`Unsupported arch: ${ARCH} on ${PLATFORM}`);
  return `${GITHUB_BASE}/${binary}`;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const DATA_DIR = join(dirname(import.meta.dir), "..", "..", "data");
const BIN_DIR = join(DATA_DIR, "bin");
const BIN_NAME = IS_WINDOWS ? "cloudflared.exe" : "cloudflared";
const BIN_PATH = join(BIN_DIR, BIN_NAME);

// ─── Download State ──────────────────────────────────────────────────────────

interface DownloadState {
  downloading: boolean;
  progress: number; // 0-100
  error: string | null;
}

const dlState: DownloadState = { downloading: false, progress: 0, error: null };

export function getDownloadStatus(): DownloadState {
  return { ...dlState };
}

// ─── Download ────────────────────────────────────────────────────────────────

/**
 * Ensure cloudflared binary exists. Downloads if missing.
 * Returns the path to the binary.
 */
export async function ensureCloudflared(): Promise<string> {
  if (existsSync(BIN_PATH)) return BIN_PATH;

  if (dlState.downloading) {
    // Wait for existing download
    while (dlState.downloading) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (existsSync(BIN_PATH)) return BIN_PATH;
    throw new Error(dlState.error || "Download failed");
  }

  dlState.downloading = true;
  dlState.progress = 0;
  dlState.error = null;

  try {
    mkdirSync(BIN_DIR, { recursive: true });
    const url = getDownloadUrl();
    console.log(`[Cloudflared] Downloading from ${url}...`);

    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const contentLength = Number(response.headers.get("content-length") || 0);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (contentLength > 0) {
        dlState.progress = Math.round((received / contentLength) * 100);
      }
    }

    // Combine chunks
    const data = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }

    // Handle .tgz (macOS)
    if (url.endsWith(".tgz")) {
      // Extract using tar
      const tmpPath = join(BIN_DIR, "cloudflared.tgz");
      await Bun.write(tmpPath, data);
      const proc = spawn(["tar", "-xzf", tmpPath, "-C", BIN_DIR], { stdout: "ignore", stderr: "ignore" });
      await proc.exited;
      try { await Bun.file(tmpPath).exists() && (await import("node:fs/promises")).unlink(tmpPath); } catch {}
    } else {
      // Direct binary
      await Bun.write(BIN_PATH, data);
    }

    // Make executable on Unix
    if (!IS_WINDOWS) {
      chmodSync(BIN_PATH, 0o755);
    }

    dlState.progress = 100;
    console.log(`[Cloudflared] Downloaded successfully to ${BIN_PATH}`);
    return BIN_PATH;
  } catch (err) {
    dlState.error = err instanceof Error ? err.message : String(err);
    console.error(`[Cloudflared] Download failed:`, dlState.error);
    throw err;
  } finally {
    dlState.downloading = false;
  }
}

// ─── Process Management ──────────────────────────────────────────────────────

let cloudflaredProcess: Subprocess | null = null;
let intentionalKill = false;

export interface SpawnResult {
  tunnelUrl: string;
  process: Subprocess;
}

/**
 * Spawn a cloudflared quick tunnel pointing to the given local port.
 * Parses the tunnel URL from cloudflared's stderr output.
 */
export async function spawnQuickTunnel(localPort: number, protocol = "http2"): Promise<SpawnResult> {
  const binPath = await ensureCloudflared();
  intentionalKill = false;

  const args = [
    binPath,
    "tunnel",
    "--url", `http://localhost:${localPort}`,
    "--protocol", protocol,
    "--no-autoupdate",
  ];

  console.log(`[Cloudflared] Spawning: ${args.join(" ")}`);

  const proc = spawn({
    cmd: args,
    stdout: "pipe",
    stderr: "pipe",
  });

  cloudflaredProcess = proc;

  // Parse tunnel URL from stderr (cloudflared prints it there)
  const tunnelUrl = await parseTunnelUrl(proc);

  return { tunnelUrl, process: proc };
}

/**
 * Parse the tunnel URL from cloudflared's stderr output.
 * Cloudflared prints something like:
 *   "INF +-----------------------------------------------------------+"
 *   "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):"
 *   "INF |  https://xxx-yyy-zzz.trycloudflare.com"
 *   "INF +-----------------------------------------------------------+"
 */
async function parseTunnelUrl(proc: Subprocess): Promise<string> {
  const decoder = new TextDecoder();
  const reader = proc.stderr.getReader();
  let buffer = "";
  const timeout = 30_000; // 30s timeout
  const start = Date.now();

  const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

  while (Date.now() - start < timeout) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Check for URL in accumulated output
    const match = buffer.match(URL_RE);
    if (match) {
      // Release the reader so the process can continue
      reader.releaseLock();
      return match[0];
    }

    // Check for fatal errors
    if (buffer.includes("ERR") && buffer.includes("failed")) {
      reader.releaseLock();
      const errLine = buffer.split("\n").find(l => l.includes("ERR")) || "Unknown error";
      throw new Error(`Cloudflared failed to start: ${errLine}`);
    }
  }

  reader.releaseLock();
  throw new Error("Timeout waiting for cloudflared tunnel URL");
}

/**
 * Kill the cloudflared process.
 */
export function killCloudflared(): void {
  intentionalKill = true;
  if (cloudflaredProcess) {
    try {
      cloudflaredProcess.kill();
    } catch { /* ignore */ }
    cloudflaredProcess = null;
  }
}

/**
 * Check if cloudflared is currently running.
 */
export function isCloudflaredRunning(): boolean {
  if (!cloudflaredProcess) return false;
  // Check if process is still alive
  return cloudflaredProcess.exitCode === null;
}

/**
 * Was the last kill intentional? (vs unexpected exit)
 */
export function wasIntentionalKill(): boolean {
  return intentionalKill;
}

/**
 * Get the cloudflared process (for monitoring exit).
 */
export function getCloudflaredProcess(): Subprocess | null {
  return cloudflaredProcess;
}
