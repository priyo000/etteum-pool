import type { ServerWebSocket } from "bun";

interface WSMessage {
  type: string;
  data: unknown;
}

// Store connected WebSocket clients
const clients = new Set<ServerWebSocket<unknown>>();
const MAX_WS_PAYLOAD_BYTES = 128 * 1024;

/**
 * WebSocket handler for Bun.serve
 */
export const websocketHandler = {
  open(ws: ServerWebSocket<unknown>) {
    clients.add(ws);
    ws.send(
      JSON.stringify({
        type: "connected",
        data: { message: "Connected to pool-proxy WebSocket", clients: clients.size },
      })
    );
    console.log(`[WS] Client connected (total: ${clients.size})`);
  },

  message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
    // Handle incoming messages (ping/pong, subscribe to specific events, etc.)
    try {
      const msg = JSON.parse(
        typeof message === "string" ? message : message.toString()
      ) as WSMessage;

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", data: { timestamp: Date.now() } }));
      }
    } catch {
      // Ignore invalid messages
    }
  },

  close(ws: ServerWebSocket<unknown>) {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (total: ${clients.size})`);
  },

  drain(ws: ServerWebSocket<unknown>) {
    // Called when backpressure is relieved
  },
};

/**
 * Broadcast a message to all connected WebSocket clients
 */
export function broadcast(message: WSMessage): void {
  if (clients.size === 0) return;

  let payload = JSON.stringify(message);
  if (payload.length > MAX_WS_PAYLOAD_BYTES) {
    payload = JSON.stringify({
      ...message,
      data: {
        ...(message.data && typeof message.data === "object" ? message.data as Record<string, unknown> : {}),
        requestBody: undefined,
        responseBody: undefined,
        truncated: true,
      },
    });
  }

  for (const client of clients) {
    try {
      const sent = client.send(payload);
      if (sent === -1) {
        clients.delete(client);
        client.close();
      }
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Get the number of connected clients
 */
export function getClientCount(): number {
  return clients.size;
}
