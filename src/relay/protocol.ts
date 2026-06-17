/**
 * Relay Proxy Protocol
 *
 * Defines the message format for WebSocket-based HTTP tunneling between
 * relay server and relay clients (pool instances).
 *
 * Wire format: CBOR-encoded binary frames over WebSocket for efficiency.
 * Streaming responses use chunked transfer via multiple stream_chunk messages.
 */
import { encode, decode } from "cbor-x";

// ─── Message Types ───────────────────────────────────────────────────────────

export type RelayMessageType =
  | "auth"           // client → server: authenticate tunnel
  | "auth_ok"       // server → client: authentication accepted
  | "auth_fail"     // server → client: authentication rejected
  | "tunnel_request"  // server → client: forward HTTP request to local pool
  | "tunnel_response" // client → server: full HTTP response (non-streaming)
  | "stream_start"    // client → server: begin streaming response
  | "stream_chunk"    // client → server: SSE chunk
  | "stream_end"      // client → server: stream complete
  | "stream_error"    // client → server: stream errored
  | "heartbeat"       // bidirectional keepalive
  | "heartbeat_ack"   // response to heartbeat
  | "tunnel_error"    // error processing a tunneled request
  | "info"           // server → client: informational (assigned URL, stats, etc.)
  | "disconnect";    // graceful disconnect

// ─── Message Payloads ────────────────────────────────────────────────────────

export interface AuthMessage {
  type: "auth";
  secret: string;
  peerId: string;       // unique identifier for this pool instance
  peerName?: string;    // human-readable name
  version?: string;     // protocol version
  models?: string[];    // models this pool can serve
}

export interface AuthOkMessage {
  type: "auth_ok";
  tunnelId: string;     // assigned tunnel ID
  publicUrl: string;    // public URL to reach this tunnel
  expiresAt?: number;   // optional TTL
}

export interface AuthFailMessage {
  type: "auth_fail";
  reason: string;
}

export interface TunnelRequestMessage {
  type: "tunnel_request";
  requestId: string;    // unique per-request, used to correlate response
  method: string;       // GET, POST, etc.
  path: string;         // /v1/chat/completions
  headers: Record<string, string>;
  body?: Uint8Array;    // raw request body (binary for efficiency)
}

export interface TunnelResponseMessage {
  type: "tunnel_response";
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array;    // full response body
}

export interface StreamStartMessage {
  type: "stream_start";
  requestId: string;
  status: number;
  headers: Record<string, string>;
}

export interface StreamChunkMessage {
  type: "stream_chunk";
  requestId: string;
  data: Uint8Array;     // raw SSE chunk bytes
}

export interface StreamEndMessage {
  type: "stream_end";
  requestId: string;
}

export interface StreamErrorMessage {
  type: "stream_error";
  requestId: string;
  error: string;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  ts: number;           // timestamp
}

export interface HeartbeatAckMessage {
  type: "heartbeat_ack";
  ts: number;           // echo back the original ts
  rtt?: number;         // round-trip time if known
}

export interface TunnelErrorMessage {
  type: "tunnel_error";
  requestId: string;
  error: string;
  status?: number;
}

export interface InfoMessage {
  type: "info";
  tunnelId: string;
  publicUrl: string;
  connectedPeers?: number;
  uptime?: number;
}

export interface DisconnectMessage {
  type: "disconnect";
  reason?: string;
}

export type RelayMessage =
  | AuthMessage
  | AuthOkMessage
  | AuthFailMessage
  | TunnelRequestMessage
  | TunnelResponseMessage
  | StreamStartMessage
  | StreamChunkMessage
  | StreamEndMessage
  | StreamErrorMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | TunnelErrorMessage
  | InfoMessage
  | DisconnectMessage;

// ─── Serialization ───────────────────────────────────────────────────────────

/** Encode a relay message to binary (CBOR) for WebSocket transmission. */
export function encodeMessage(msg: RelayMessage): Uint8Array {
  return encode(msg);
}

/** Decode a binary WebSocket frame back into a relay message. */
export function decodeMessage(data: Uint8Array | ArrayBuffer | Buffer): RelayMessage {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  return decode(buf) as RelayMessage;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a unique request ID. */
export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Generate a unique tunnel ID. */
export function generateTunnelId(): string {
  return `tun_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Generate a unique peer ID. */
export function generatePeerId(): string {
  return `peer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Protocol version for compatibility checks. */
export const PROTOCOL_VERSION = "1.0.0";

/** Default heartbeat interval (ms). */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Heartbeat timeout — if no ack received within this, consider connection dead. */
export const HEARTBEAT_TIMEOUT_MS = 30_000;

/** Max message size (10MB — large for image payloads). */
export const MAX_MESSAGE_SIZE = 10 * 1024 * 1024;
