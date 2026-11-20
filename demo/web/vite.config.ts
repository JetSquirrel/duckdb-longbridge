import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Without this, a missing extension wasm falls through to the SPA fallback and
// duckdb-wasm receives index.html with a 200 — a very confusing failure. Turn
// it into an honest 404 with an actionable body instead.
const extensionRepo404 = (): Plugin => ({
  name: 'extension-repo-404',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0];
      if (
        url.startsWith('/v1.5.4/') &&
        url.endsWith('.wasm') &&
        !existsSync(join(server.config.root, 'public', url))
      ) {
        res.statusCode = 404;
        res.setHeader('content-type', 'text/plain');
        res.end(
          `missing ${url} — run the wasm build for the extensions and copy the ` +
            `.wasm files into public/v1.5.4/wasm_eh/ (see the README.md there).`,
        );
        return;
      }
      next();
    });
  },
});

// The dev proxy forwards extension -> sidecar traffic through Vite so the
// wasm extensions only ever talk to same-origin URLs (no CORS needed).
// The sidecar gateway is built separately and listens on :8787.
export default defineConfig({
  plugins: [react(), extensionRepo404()],
  server: {
    proxy: {
      // Trailing slashes matter: '/v1' would also swallow the extension
      // repository path '/v1.5.4/wasm_eh/...' served from public/.
      '/v1/': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/jev/': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    // duckdb-wasm ships its own bundles; pre-bundling breaks the ?url imports.
    exclude: ['@duckdb/duckdb-wasm'],
  },
});
