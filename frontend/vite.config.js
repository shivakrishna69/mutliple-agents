/**
 * Vite configuration.
 *
 * In development, requests to /api are proxied to the Express backend. The browser then
 * talks to a single origin (the Vite dev server), so the frontend code can use relative
 * URLs such as "/api/auth/login" and no CORS preflight is needed. In production, serve the
 * built files behind the same reverse proxy as the API, or set VITE_API_BASE_URL.
 */

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const environmentVariables = loadEnv(mode, process.cwd(), '');
  const backendProxyTarget = environmentVariables.VITE_BACKEND_PROXY_TARGET || 'http://localhost:5000';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: backendProxyTarget, changeOrigin: true },
        // Socket.IO (polling requests and the WebSocket upgrade). The browser's Origin header is
        // forwarded unchanged, so the backend's origin allowlist still applies.
        '/socket.io': { target: backendProxyTarget, changeOrigin: true, ws: true },
      },
    },
  };
});
