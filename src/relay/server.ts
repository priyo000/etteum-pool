/**
 * Relay Server
 *
 * Accepts WebSocket tunnel connections from remote etteum-pool instances.
 * When HTTP requests arrive for a specific tunnel, it forwards them through
 * the WebSocket connection to the connected pool and streams the response back.
 *
 * This allows multiple pool instances to be accessible through a single
 * public server without each needing a public IP.
 *
 * Architecture:
 *   Client (Cursor/CLI) → HTTP → Relay Server → WS Tunnel → Remote Pool
 *                       ← HTTP ← Relay Server ← WS Tunnel ← Remote Pool
 */
import type { ServerWebSocket } from "bun";
import {
  type RelayMessage,
  type TunnelRequestMessage,
  type TunnelResponseMessage,
  type StreamStartMessage,
  type StreamChunkMessage,
  type StreamEndMessage,
  type StreamErrorMessage,
  type TunnelErrorMessage,
  type AuthMessage,
  encodeMessage,
  decodeMessage,
  generateTunnelId,
  generateRequestId,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "./protocol";
import { broadcast } from "../ws/index";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RelayServerConfig {
  secret: string;           // shared secret clients must provide
  port?: number;            // relay server port (default: main port, uses /relay/ path)
  maxTunnels?: number;      // max concurrent tunnels (default: 50)
  requestTimeoutMs?: number; // timeout for tunneled requests (default: 120000)
  publicBaseUrl?: string;   // base URL for generated public URLs
}

interface TunnelPeer {
  tunnelId: string;
  peerId: string;
  peerName: string;
  ws: ServerWebSocket<TunnelWSData>;
  connectedAt: number;
  lastHeartbeat: number;
  requestsServed: number;
  models: string[];
}

interface PendingRequest {
  requestId: string;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  streamController?: ReadableStreamDefaultController<Uint8Array>;
  streamStarted?: boolean;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
}

export interface TunnelWSData {
  tunnelId?: string;
  peerId?: string;
  authenticated: boolean;
}

export interface RelayServerStatus {
  running: boolean;
  tunnels: Array<{
    tunnelId: string;
    peerId: string;
    peerName: string;
    connectedAt: number;
    lastHeartbeat: number;
    requestsServed: number;
    models: string[];
  }>;
  totalRequests: number;
}

// ─── Relay Server Class ──────────────────────────────────────────────────────

export class RelayServer {
  private config: RelayServerConfig;
  private tunnels = new Map<string, TunnelPeer>();       // tunnelId → peer
  private peerIndex = new Map<string, string>();          // peerId → tunnelId
  private pendingRequests = new Map<string, PendingRequest>(); // requestId → pending
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private totalRequests = 0;
  private running = false;

  constructor(cfg: RelayServerConfig) {
    this.config = cfg;
  }

  /** Start the relay server (heartbeat loop). */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Heartbeat loop: ping all connected tunnels
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [tunnelId, peer] of this.tunnels) {
        // Check if peer is dead (no heartbeat ack in timeout period)
        if (now - peer.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
          console.log(`[Relay Server] Tunnel ${tunnelId} timed out, disconnecting`);
          this.removeTunnel(tunnelId, "heartbeat timeout");
          continue;
        }

        // Send heartbeat
        this.sendToPeer(peer, { type: "heartbeat", ts: now });
      }
    }, HEARTBEAT_INTERVAL_MS);

    console.log("[Relay Server] Started");
  }

  /** Stop the relay server. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Disconnect all tunnels
    for (const [tunnelId] of this.tunnels) {
      this.removeTunnel(tunnelId, "server shutdown");
    }

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Relay server shutting down"));
    }
    this.pendingRequests.clear();

    console.log("[Relay Server] Stopped");
  }

  /** Get server status. */
  getStatus(): RelayServerStatus {
    return {
      running: this.running,
      tunnels: Array.from(this.tunnels.values()).map((t) => ({
        tunnelId: t.tunnelId,
        peerId: t.peerId,
        peerName: t.peerName,
        connectedAt: t.connectedAt,
        lastHeartbeat: t.lastHeartbeat,
        requestsServed: t.requestsServed,
        models: t.models,
      })),
      totalRequests: this.totalRequests,
    };
  }

  /** Get all available models across all connected tunnels. */
  getAllTunnelModels(): string[] {
    const models = new Set<string>();
    for (const peer of this.tunnels.values()) {
      for (const m of peer.models) models.add(m);
    }
    return Array.from(models);
  }

  /** Find a tunnel that can serve a given model. */
  findTunnelForModel(model: string): TunnelPeer | null {
    // First try exact match
    for (const peer of this.tunnels.values()) {
      if (peer.models.includes(model)) return peer;
    }
    // Fallback: first available tunnel (round-robin could be added later)
    const first = this.tunnels.values().next();
    return first.done ? null : first.value;
  }

  /** Find a tunnel by its ID. */
  getTunnel(tunnelId: string): TunnelPeer | null {
    return this.tunnels.get(tunnelId) || null;
  }

  // ─── WebSocket Handler (for Bun.serve) ─────────────────────────────────────

  /** WebSocket handler config for Bun.serve websocket option. */
  getWebSocketHandler() {
    return {
      open: (ws: ServerWebSocket<TunnelWSData>) => {
        ws.data = { authenticated: false };
        console.log("[Relay Server] New tunnel connection");
      },

      message: (ws: ServerWebSocket<TunnelWSData>, message: string | Buffer) => {
        try {
          const buf = typeof message === "string"
            ? new TextEncoder().encode(message)
            : new Uint8Array(message);
          const msg = decodeMessage(buf);
          this.handleMessage(ws, msg);
        } catch (err) {
          console.error("[Relay Server] Failed to decode message:", err);
        }
      },

      close: (ws: ServerWebSocket<TunnelWSData>) => {
        if (ws.data?.tunnelId) {
          this.removeTunnel(ws.data.tunnelId, "connection closed");
        }
      },
    };
  }

  // ─── HTTP Request Forwarding ───────────────────────────────────────────────

  /**
   * Forward an HTTP request through a tunnel to the connected pool.
   * Returns a Response that can be sent back to the original client.
   *
   * @param tunnelId - Target tunnel ID (or null for auto-routing)
   * @param request - The incoming HTTP request
   * @param path - The path to forward (e.g., /v1/chat/completions)
   */
  async forwardRequest(
    tunnelId: string | null,
    request: Request,
    path: string
  ): Promise<Response> {
    // Find the target tunnel
    let peer: TunnelPeer | null = null;

    if (tunnelId) {
      peer = this.tunnels.get(tunnelId) || null;
    } else {
      // Auto-route: try to find a tunnel based on the model in the request
      // For now, use first available tunnel
      const first = this.tunnels.values().next();
      peer = first.done ? null : first.value;
    }

    if (!peer) {
      return new Response(
        JSON.stringify({ error: { message: "No tunnel available", type: "relay_error" } }),
        { status: 502, headers: { "content-type": "application/json" } }
      );
    }

    const requestId = generateRequestId();
    const timeoutMs = this.config.requestTimeoutMs || 120_000;

    // Read request body
    let body: Uint8Array | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = new Uint8Array(await request.arrayBuffer());
    }

    // Extract headers
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      // Skip hop-by-hop and internal headers
      if (!["connection", "keep-alive", "transfer-encoding", "upgrade", "host"].includes(k.toLowerCase())) {
        headers[k] = v;
      }
    });

    // Check if client expects streaming
    const acceptsStream = headers["accept"]?.includes("text/event-stream") ||
      (body && (() => { try { return JSON.parse(new TextDecoder().decode(body)).stream; } catch { return false; } })());

    // Send tunnel request
    const tunnelReq: TunnelRequestMessage = {
      type: "tunnel_request",
      requestId,
      method: request.method,
      path,
      headers,
      body,
    };

    if (acceptsStream) {
      // Streaming response: return a ReadableStream
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      return new Promise<Response>((resolve, reject) => {
        let streamController: ReadableStreamDefaultController<Uint8Array>;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
          cancel() {
            // Client disconnected
            const pending = self.pendingRequests?.get(requestId);
            if (pending) {
              clearTimeout(pending.timer);
              self.pendingRequests.delete(requestId);
            }
          },
        });

        const timer = setTimeout(() => {
          self.pendingRequests.delete(requestId);
          try { streamController?.close(); } catch { /* ignore */ }
          reject(new Error("Tunnel request timeout"));
        }, timeoutMs);

        self.pendingRequests.set(requestId, {
          requestId,
          resolve: (resp) => resolve(resp),
          reject,
          timer,
          streamController: streamController!,
          streamStarted: false,
        });

        self.sendToPeer(peer!, tunnelReq);
        self.totalRequests++;
        peer!.requestsServed++;
      });
    } else {
      // Non-streaming: wait for full response
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(requestId);
          reject(new Error("Tunnel request timeout"));
        }, timeoutMs);

        this.pendingRequests.set(requestId, {
          requestId,
          resolve,
          reject,
          timer,
        });

        this.sendToPeer(peer!, tunnelReq);
        this.totalRequests++;
        peer!.requestsServed++;
      });
    }
  }

  // ─── Message Handling ──────────────────────────────────────────────────────

  private handleMessage(ws: ServerWebSocket<TunnelWSData>, msg: RelayMessage): void {
    // Authentication gate
    if (!ws.data?.authenticated) {
      if (msg.type === "auth") {
        this.handleAuth(ws, msg);
      } else {
        this.sendToWs(ws, { type: "auth_fail", reason: "Not authenticated" });
        ws.close(4001, "Not authenticated");
      }
      return;
    }

    switch (msg.type) {
      case "tunnel_response":
        this.handleTunnelResponse(msg);
        break;

      case "stream_start":
        this.handleStreamStart(msg);
        break;

      case "stream_chunk":
        this.handleStreamChunk(msg);
        break;

      case "stream_end":
        this.handleStreamEnd(msg);
        break;

      case "stream_error":
        this.handleStreamError(msg);
        break;

      case "tunnel_error":
        this.handleTunnelError(msg);
        break;

      case "heartbeat_ack":
        if (ws.data?.tunnelId) {
          const peer = this.tunnels.get(ws.data.tunnelId);
          if (peer) peer.lastHeartbeat = Date.now();
        }
        break;

      case "heartbeat":
        this.sendToWs(ws, { type: "heartbeat_ack", ts: msg.ts });
        break;

      default:
        console.warn(`[Relay Server] Unknown message type from tunnel: ${(msg as any).type}`);
    }
  }

  private handleAuth(ws: ServerWebSocket<TunnelWSData>, msg: AuthMessage): void {
    // Validate secret
    if (msg.secret !== this.config.secret) {
      this.sendToWs(ws, { type: "auth_fail", reason: "Invalid secret" });
      ws.close(4003, "Invalid secret");
      return;
    }

    // Check max tunnels
    const maxTunnels = this.config.maxTunnels || 50;
    if (this.tunnels.size >= maxTunnels) {
      this.sendToWs(ws, { type: "auth_fail", reason: "Max tunnels reached" });
      ws.close(4004, "Max tunnels reached");
      return;
    }

    // Check if peer already connected (reconnect scenario)
    const existingTunnelId = this.peerIndex.get(msg.peerId);
    if (existingTunnelId) {
      this.removeTunnel(existingTunnelId, "peer reconnected");
    }

    // Create tunnel
    const tunnelId = generateTunnelId();
    const baseUrl = this.config.publicBaseUrl || `http://localhost:${this.config.port || 1930}`;
    const publicUrl = `${baseUrl}/relay/${tunnelId}/v1`;

    const peer: TunnelPeer = {
      tunnelId,
      peerId: msg.peerId,
      peerName: msg.peerName || msg.peerId,
      ws,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      requestsServed: 0,
      models: msg.models || [],
    };

    this.tunnels.set(tunnelId, peer);
    this.peerIndex.set(msg.peerId, tunnelId);

    ws.data = {
      tunnelId,
      peerId: msg.peerId,
      authenticated: true,
    };

    // Send auth OK
    this.sendToWs(ws, {
      type: "auth_ok",
      tunnelId,
      publicUrl,
    });

    console.log(`[Relay Server] ✓ Tunnel established: ${tunnelId} (peer: ${msg.peerName || msg.peerId})`);
    console.log(`[Relay Server]   Public URL: ${publicUrl}`);
    console.log(`[Relay Server]   Models: ${msg.models?.join(", ") || "all"}`);

    broadcast({
      type: "relay_tunnel_connected",
      data: { tunnelId, peerId: msg.peerId, peerName: msg.peerName, models: msg.models },
    });
  }

  private handleTunnelResponse(msg: TunnelResponseMessage): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.requestId);

    const response = new Response(msg.body, {
      status: msg.status,
      headers: msg.headers,
    });

    pending.resolve(response);
  }

  private handleStreamStart(msg: StreamStartMessage): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) return;

    pending.streamStarted = true;
    pending.responseStatus = msg.status;
    pending.responseHeaders = msg.headers;

    // Create a streaming response
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        pending.streamController = controller;
      },
      cancel: () => {
        this.pendingRequests.delete(msg.requestId);
        clearTimeout(pending.timer);
      },
    });

    const response = new Response(stream, {
      status: msg.status,
      headers: msg.headers,
    });

    pending.resolve(response);
  }

  private handleStreamChunk(msg: StreamChunkMessage): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending?.streamController) return;

    try {
      pending.streamController.enqueue(msg.data);
    } catch {
      // Stream may have been cancelled by client
      this.pendingRequests.delete(msg.requestId);
      clearTimeout(pending.timer);
    }
  }

  private handleStreamEnd(msg: StreamEndMessage): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.requestId);

    if (pending.streamController) {
      try { pending.streamController.close(); } catch { /* ignore */ }
    }
  }

  private handleStreamError(msg: StreamErrorMessage): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.requestId);

    if (pending.streamController) {
      try { pending.streamController.error(new Error(msg.error)); } catch { /* ignore */ }
    } else {
      pending.reject(new Error(msg.error));
    }
  }

  private handleTunnelError(msg: TunnelErrorMessage): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(msg.requestId);

    const response = new Response(
      JSON.stringify({ error: { message: msg.error, type: "relay_error" } }),
      { status: msg.status || 502, headers: { "content-type": "application/json" } }
    );

    pending.resolve(response);
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private removeTunnel(tunnelId: string, reason: string): void {
    const peer = this.tunnels.get(tunnelId);
    if (!peer) return;

    // Send disconnect message
    try {
      this.sendToPeer(peer, { type: "disconnect", reason });
      peer.ws.close(1000, reason);
    } catch { /* ignore */ }

    this.tunnels.delete(tunnelId);
    this.peerIndex.delete(peer.peerId);

    // Reject any pending requests for this tunnel
    for (const [reqId, pending] of this.pendingRequests) {
      // We can't easily know which requests belong to this tunnel,
      // but they'll timeout naturally. For now just log.
    }

    console.log(`[Relay Server] Tunnel ${tunnelId} removed: ${reason}`);
    broadcast({
      type: "relay_tunnel_disconnected",
      data: { tunnelId, peerId: peer.peerId, reason },
    });
  }

  private sendToPeer(peer: TunnelPeer, msg: RelayMessage): void {
    try {
      peer.ws.send(encodeMessage(msg));
    } catch (err) {
      console.error(`[Relay Server] Failed to send to tunnel ${peer.tunnelId}:`, err);
    }
  }

  private sendToWs(ws: ServerWebSocket<TunnelWSData>, msg: RelayMessage): void {
    try {
      ws.send(encodeMessage(msg));
    } catch (err) {
      console.error("[Relay Server] Failed to send to ws:", err);
    }
  }
}

// ─── Singleton Instance ──────────────────────────────────────────────────────

let relayServerInstance: RelayServer | null = null;

/** Get or create the relay server singleton. */
export function getRelayServer(): RelayServer | null {
  return relayServerInstance;
}

/** Start the relay server with given config. */
export function startRelayServer(cfg: RelayServerConfig): RelayServer {
  if (relayServerInstance) {
    relayServerInstance.stop();
  }
  relayServerInstance = new RelayServer(cfg);
  relayServerInstance.start();
  return relayServerInstance;
}

/** Stop the relay server. */
export function stopRelayServer(): void {
  if (relayServerInstance) {
    relayServerInstance.stop();
    relayServerInstance = null;
  }
}
