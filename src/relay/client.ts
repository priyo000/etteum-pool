/**
 * Relay Client
 *
 * Connects to a remote relay server via WebSocket, creating a tunnel.
 * When the relay server receives HTTP requests for this tunnel, it forwards
 * them through the WebSocket connection. This client processes them against
 * the local pool proxy and sends responses back.
 *
 * This allows exposing the local etteum-pool to the internet without
 * port forwarding or a public IP.
 */
import {
  type RelayMessage,
  type TunnelRequestMessage,
  type AuthMessage,
  encodeMessage,
  decodeMessage,
  generatePeerId,
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
} from "./protocol";
import { config } from "../config";
import { broadcast } from "../ws/index";

export interface RelayClientConfig {
  serverUrl: string;      // ws(s)://relay-server.com/relay/tunnel
  secret: string;         // shared secret for auth
  peerName?: string;      // human-readable name for this pool
  models?: string[];      // advertised models
  reconnect?: boolean;    // auto-reconnect on disconnect (default: true)
  maxReconnectDelay?: number; // max backoff delay ms (default: 30000)
}

export interface RelayClientStatus {
  connected: boolean;
  tunnelId: string | null;
  publicUrl: string | null;
  peerId: string;
  serverUrl: string;
  connectedAt: number | null;
  lastHeartbeat: number | null;
  requestsServed: number;
  reconnectAttempts: number;
}

type ClientState = "disconnected" | "connecting" | "authenticating" | "connected";

export class RelayClient {
  private ws: WebSocket | null = null;
  private state: ClientState = "disconnected";
  private peerId: string;
  private tunnelId: string | null = null;
  private publicUrl: string | null = null;
  private connectedAt: number | null = null;
  private lastHeartbeat: number | null = null;
  private requestsServed = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private config: RelayClientConfig;
  private shouldReconnect = true;

  constructor(cfg: RelayClientConfig) {
    this.config = cfg;
    this.peerId = generatePeerId();
  }

  /** Start the relay client — connect to the relay server. */
  async connect(): Promise<void> {
    if (this.state !== "disconnected") {
      console.log("[Relay Client] Already connected or connecting");
      return;
    }

    this.shouldReconnect = this.config.reconnect !== false;
    this.state = "connecting";
    console.log(`[Relay Client] Connecting to ${this.config.serverUrl}...`);

    try {
      this.ws = new WebSocket(this.config.serverUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.addEventListener("open", () => this.onOpen());
      this.ws.addEventListener("message", (ev) => this.onMessage(ev));
      this.ws.addEventListener("close", (ev) => this.onClose(ev));
      this.ws.addEventListener("error", (ev) => this.onError(ev));
    } catch (err) {
      console.error("[Relay Client] Connection failed:", err);
      this.state = "disconnected";
      this.scheduleReconnect();
    }
  }

  /** Gracefully disconnect from the relay server. */
  disconnect(): void {
    this.shouldReconnect = false;
    this.cleanup();
    console.log("[Relay Client] Disconnected");
    broadcast({ type: "relay_status", data: this.getStatus() });
  }

  /** Get current status. */
  getStatus(): RelayClientStatus {
    return {
      connected: this.state === "connected",
      tunnelId: this.tunnelId,
      publicUrl: this.publicUrl,
      peerId: this.peerId,
      serverUrl: this.config.serverUrl,
      connectedAt: this.connectedAt,
      lastHeartbeat: this.lastHeartbeat,
      requestsServed: this.requestsServed,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  // ─── WebSocket Event Handlers ──────────────────────────────────────────────

  private onOpen(): void {
    console.log("[Relay Client] WebSocket connected, authenticating...");
    this.state = "authenticating";
    this.reconnectAttempts = 0;

    // Send auth message
    const authMsg: AuthMessage = {
      type: "auth",
      secret: this.config.secret,
      peerId: this.peerId,
      peerName: this.config.peerName || `etteum-pool@${config.port}`,
      version: PROTOCOL_VERSION,
      models: this.config.models,
    };

    this.send(authMsg);
  }

  private onMessage(ev: MessageEvent): void {
    try {
      const msg = decodeMessage(
        ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data
      );
      this.handleMessage(msg);
    } catch (err) {
      console.error("[Relay Client] Failed to decode message:", err);
    }
  }

  private onClose(ev: CloseEvent): void {
    console.log(`[Relay Client] Connection closed: code=${ev.code} reason=${ev.reason}`);
    this.cleanup();
    broadcast({ type: "relay_status", data: this.getStatus() });
    this.scheduleReconnect();
  }

  private onError(_ev: Event): void {
    console.error("[Relay Client] WebSocket error");
    // onClose will be called after this
  }

  // ─── Message Handling ──────────────────────────────────────────────────────

  private handleMessage(msg: RelayMessage): void {
    switch (msg.type) {
      case "auth_ok":
        this.state = "connected";
        this.tunnelId = msg.tunnelId;
        this.publicUrl = msg.publicUrl;
        this.connectedAt = Date.now();
        this.startHeartbeat();
        console.log(`[Relay Client] ✓ Tunnel established!`);
        console.log(`[Relay Client]   Tunnel ID: ${msg.tunnelId}`);
        console.log(`[Relay Client]   Public URL: ${msg.publicUrl}`);
        broadcast({ type: "relay_status", data: this.getStatus() });
        break;

      case "auth_fail":
        console.error(`[Relay Client] Authentication failed: ${msg.reason}`);
        this.shouldReconnect = false; // don't retry on auth failure
        this.cleanup();
        break;

      case "tunnel_request":
        this.handleTunnelRequest(msg);
        break;

      case "heartbeat":
        this.send({ type: "heartbeat_ack", ts: msg.ts });
        break;

      case "heartbeat_ack":
        this.lastHeartbeat = Date.now();
        if (this.heartbeatTimeoutTimer) {
          clearTimeout(this.heartbeatTimeoutTimer);
          this.heartbeatTimeoutTimer = null;
        }
        break;

      case "info":
        console.log(`[Relay Client] Info: tunnel=${msg.tunnelId} peers=${msg.connectedPeers}`);
        break;

      case "disconnect":
        console.log(`[Relay Client] Server requested disconnect: ${msg.reason}`);
        this.shouldReconnect = false;
        this.cleanup();
        break;

      default:
        console.warn(`[Relay Client] Unknown message type: ${(msg as any).type}`);
    }
  }

  /**
   * Handle an incoming tunneled HTTP request.
   * Forward it to the local pool proxy and send the response back.
   */
  private async handleTunnelRequest(msg: TunnelRequestMessage): Promise<void> {
    const { requestId, method, path, headers, body } = msg;

    try {
      // Build the local URL
      const localUrl = `http://127.0.0.1:${config.port}${path}`;

      // Forward to local pool
      const reqInit: RequestInit = {
        method,
        headers: { ...headers },
      };

      // Add body for non-GET requests
      if (body && method !== "GET" && method !== "HEAD") {
        reqInit.body = body;
      }

      // Remove hop-by-hop headers
      const hopHeaders = ["connection", "keep-alive", "transfer-encoding", "upgrade"];
      for (const h of hopHeaders) {
        delete (reqInit.headers as Record<string, string>)[h];
      }

      const response = await fetch(localUrl, reqInit);

      // Check if this is a streaming response (SSE)
      const contentType = response.headers.get("content-type") || "";
      const isStreaming = contentType.includes("text/event-stream");

      if (isStreaming && response.body) {
        // Stream the response back in chunks
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          if (!hopHeaders.includes(k.toLowerCase())) {
            responseHeaders[k] = v;
          }
        });

        this.send({
          type: "stream_start",
          requestId,
          status: response.status,
          headers: responseHeaders,
        });

        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            this.send({
              type: "stream_chunk",
              requestId,
              data: value,
            });
          }
        } catch (streamErr) {
          this.send({
            type: "stream_error",
            requestId,
            error: streamErr instanceof Error ? streamErr.message : String(streamErr),
          });
          return;
        }

        this.send({ type: "stream_end", requestId });
      } else {
        // Non-streaming: send full response
        const responseBody = new Uint8Array(await response.arrayBuffer());
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          if (!hopHeaders.includes(k.toLowerCase())) {
            responseHeaders[k] = v;
          }
        });

        this.send({
          type: "tunnel_response",
          requestId,
          status: response.status,
          headers: responseHeaders,
          body: responseBody,
        });
      }

      this.requestsServed++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Relay Client] Error processing request ${requestId}:`, errorMsg);

      this.send({
        type: "tunnel_error",
        requestId,
        error: errorMsg,
        status: 502,
      });
    }
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "connected") return;

      this.send({ type: "heartbeat", ts: Date.now() });

      // Set timeout for ack
      this.heartbeatTimeoutTimer = setTimeout(() => {
        console.warn("[Relay Client] Heartbeat timeout — connection may be dead");
        this.cleanup();
        this.scheduleReconnect();
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  // ─── Reconnection ─────────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    const maxDelay = this.config.maxReconnectDelay || 30_000;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), maxDelay);
    this.reconnectAttempts++;

    console.log(`[Relay Client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private send(msg: RelayMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(encodeMessage(msg));
    } catch (err) {
      console.error("[Relay Client] Send failed:", err);
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.state = "disconnected";
    this.tunnelId = null;
    this.publicUrl = null;
    this.connectedAt = null;
  }
}

// ─── Singleton Instance ──────────────────────────────────────────────────────

let relayClientInstance: RelayClient | null = null;

/** Get or create the relay client singleton. */
export function getRelayClient(): RelayClient | null {
  return relayClientInstance;
}

/** Start the relay client with given config. */
export function startRelayClient(cfg: RelayClientConfig): RelayClient {
  if (relayClientInstance) {
    relayClientInstance.disconnect();
  }
  relayClientInstance = new RelayClient(cfg);
  relayClientInstance.connect();
  return relayClientInstance;
}

/** Stop the relay client. */
export function stopRelayClient(): void {
  if (relayClientInstance) {
    relayClientInstance.disconnect();
    relayClientInstance = null;
  }
}
