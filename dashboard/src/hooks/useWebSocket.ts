import { useEffect, useRef, useState, useCallback } from "react";
import { getWsBase } from "@/lib/api";

interface WebSocketMessage {
  type: string;
  data: any;
}

export function useWebSocket(url: string = `${getWsBase()}/ws`) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldReconnectRef = useRef(true);
  const connectionIdRef = useRef(0);
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);

  const connect = useCallback(() => {
    if (!shouldReconnectRef.current) return;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    try {
      const connectionId = ++connectionIdRef.current;
      const ws = new WebSocket(url);

      ws.onopen = () => {
        if (connectionId !== connectionIdRef.current) return;
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        if (connectionId !== connectionIdRef.current) return;
        try {
          const message = JSON.parse(event.data);
          setLastMessage(message);
        } catch {
          // ignore non-JSON messages
        }
      };

      ws.onclose = () => {
        if (connectionId !== connectionIdRef.current) return;
        setIsConnected(false);
        // Reconnect after 3 seconds
        if (shouldReconnectRef.current) {
          reconnectTimerRef.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        if (connectionId !== connectionIdRef.current) return;
        ws.close();
      };

      wsRef.current = ws;
    } catch {
      if (shouldReconnectRef.current) {
        reconnectTimerRef.current = setTimeout(connect, 3000);
      }
    }
  }, [url]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();
    return () => {
      shouldReconnectRef.current = false;
      connectionIdRef.current++;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
    };
  }, [connect]);

  const send = useCallback((data: any) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { isConnected, lastMessage, send };
}
