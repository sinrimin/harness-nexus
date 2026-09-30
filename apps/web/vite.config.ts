import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Dev API target — overridable so a second stack can run beside the default
// (e.g. VITE_API_TARGET=http://127.0.0.1:18080 npm run dev while :8080 is
// occupied by another instance).
const apiTarget = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    // Proxy API + MCP + realtime (Socket.IO, ws upgrade) endpoints to the
    // Fastify server during development.
    proxy: {
      '/api': apiTarget,
      // The MCP outlet paths are `/mcp` and `/mcp/sse*`, but the string key
      // prefix-matches — it would also swallow the app's own `/mcp-servers`
      // page route. `bypass: false` lets those requests fall through to the SPA.
      '/mcp': {
        target: apiTarget,
        // Serve the SPA shell for the app's own /mcp-servers route instead of
        // proxying it to the Fastify MCP outlet.
        bypass: (req) => (req.url?.startsWith('/mcp-servers') ? '/index.html' : undefined),
      },
      '/socket.io': { target: apiTarget, ws: true },
    },
  },
});
