import { defineConfig } from 'vite'
import { resolve } from 'node:path'

import { CATALOG_PUBLIC_URL } from './src/catalog-config.js'

/**
 * Catalog: the client fetches same-origin /catalog.json (Pages worker → R2 in
 * production; proxied to the R2 public URL in `vite dev`).
 *
 * base: '/' — site is served at apex custom domain (games.omgithub.com), not a
 * project subpath.
 */
export default defineConfig({
  base: '/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        stats: resolve(import.meta.dirname, 'stats/index.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/catalog.json': {
        target: new URL(CATALOG_PUBLIC_URL).origin,
        changeOrigin: true,
        rewrite: () => new URL(CATALOG_PUBLIC_URL).pathname,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
})
