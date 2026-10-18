import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_DEV_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // SECURITY (M10, see docs/agents/16-security-audit-preprod.md):
    // source maps OFF for production. Source maps expose TSX source code
    // (including comments, internal route paths, and any string literal
    // that wasn't built away by Vite). For a banking prod build we
    // never want the source map to ship to the browser.
    build: {
      sourcemap: false,
    },
    server: {
      port: 5173,
      host: true,
      watch: {
        usePolling: true,
        interval: 300,
      },
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
