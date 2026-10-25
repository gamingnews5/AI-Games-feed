import { defineConfig } from 'vite'
import { resolve } from 'node:path'

/**
 * Catalog source: src/catalog-config.js (dev falls back to the bundled
 * public/catalog-snapshot.json).
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
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
})
