/**
 * Catalog + media sources, shared by the browser feed (src/feed-from-catalog.js)
 * and the Pages worker (worker/index.js). Change things here only.
 *
 * grootbot-dev was suspended on 2026-10-25, which took down
 * raw.githubusercontent.com/aigamedevs/Claude-vs-ChatGPT. Until Overheard
 * publishes the recreated catalog, the site serves a bundled snapshot
 * (public/catalog-snapshot.json, from aigamedevs/Claude-vs-ChatGPT@afcb1ef).
 */

/**
 * Live upstream catalog (raw grokgames.json URL). null = serve the bundled
 * snapshot only. When set, the worker's /catalog.json serves this (edge-cached
 * ~5 min) and falls back to the snapshot if it fails.
 */
export const UPSTREAM_CATALOG_URL = null;

/** Bundled same-origin copy of the catalog (always deployed with the site). */
export const CATALOG_SNAPSHOT_PATH = '/catalog-snapshot.json';

/**
 * Base for catalog-relative media (videos/*.mp4, videos/*.jpg posters,
 * screenshots/*). Everything is mirrored on R2 under the same relative keys.
 */
export const MEDIA_BASE = 'https://pub-f8a67dd028134c809667b629ac5ff178.r2.dev/';
