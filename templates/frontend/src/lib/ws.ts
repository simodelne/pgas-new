// Vendored from simoneos/frontend/src/hooks/useWebSocket.ts
// (snapshot 2026-06-01). Simplified: no per-session tab fan-out, no
// kernel/surrogate reconciliation — just a minimal connect-with-token
// hook that surfaces incoming messages via a callback.
//
// The WS URL comes from VITE_PGAS_WS_URL. The JWT (or dev-static-token)
// is appended as a `?token=...` query param — same convention as
// simoneos uses today.
//
// Reconnects on close after a fixed 3s backoff. Production deploys
// behind a reverse proxy that supports WS upgrades should work with
// this client unchanged.

import { useEffect, useRef } from 'react';
import { getToken } from './auth';

export interface WsMessage {
  type: string;
  sessionId?: string;
  data?: unknown;
}

export function useWebSocket(onMessage: (msg: WsMessage) => void): void {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const baseUrl = import.meta.env.VITE_PGAS_WS_URL || 'ws://localhost:8787/ws';
    const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

    const connect = (): void => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      const ws = new WebSocket(url);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsMessage;
          onMessageRef.current(msg);
        } catch {
          // Malformed WS message — ignore.
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);
}
