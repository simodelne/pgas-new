import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Vendored from simoneos/frontend/vite.config.ts (snapshot 2026-06-01),
// stripped of vitest config + dev-only proxy quirks. The vendored
// snapshot uses VITE_PGAS_API_URL / VITE_PGAS_WS_URL env vars instead
// of hardcoded localhost:3000 — the proxy block here is a local-dev
// convenience that only activates when those vars are set to relative
// paths (the default).

function isIgnorableProxySocketError(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null
      ? (err as { code?: unknown }).code
      : undefined;
  return code === 'EPIPE' || code === 'ECONNRESET';
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiUrl = env.VITE_PGAS_API_URL || 'http://localhost:8787';
  const wsUrl = env.VITE_PGAS_WS_URL || 'ws://localhost:8787/ws';

  // If apiUrl/wsUrl are absolute we don't need a dev proxy; the browser
  // will call them directly. Only activate the proxy when the consumer
  // points the env vars at relative paths (e.g. /api, /ws) and wants
  // Vite to forward to a backend on a different port.
  const useApiProxy = apiUrl.startsWith('/');
  const useWsProxy = wsUrl.startsWith('/');

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        ...(useApiProxy
          ? {
              '/api': {
                target: 'http://localhost:8787',
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/api/, ''),
              },
            }
          : {}),
        ...(useWsProxy
          ? {
              '/ws': {
                target: 'ws://localhost:8787',
                ws: true,
                configure: (proxy) => {
                  proxy.on('error', (err) => {
                    if (isIgnorableProxySocketError(err)) return;
                    const message = err instanceof Error ? err.message : String(err);
                    console.error(`[vite-proxy:/ws] ${message}`);
                  });
                },
              },
            }
          : {}),
      },
    },
  };
});
