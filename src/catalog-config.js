/**
 * Catalog + media sources, shared by the browser feed (src/feed-from-catalog.js)
 * and the Pages worker (worker/index.js). Change things here only.
 *
 * The live catalog lives on Cloudflare R2 (bucket ai-games-videos, key
 * catalog/grokgames.json), published by /workspace/catalog-publish/publish_catalog.sh
 * after every catalog commit. The browser only ever fetches same-origin
 * /catalog.json; the Pages worker reads R2 (bucket binding CATALOG_BUCKET, else
 * the public URL below) and edge-caches it for 5 minutes.
 */

/** R2 object key of the catalog (used with the CATALOG_BUCKET binding). */
export const CATALOG_R2_KEY = 'catalog/grokgames.json';

/**
 * Base for catalog-relative media (videos/*.mp4, videos/*.jpg posters,
 * screenshots/*) — R2 public bucket, same relative keys as the catalog repo.
 */
export const MEDIA_BASE = 'https://pub-f8a67dd028134c809667b629ac5ff178.r2.dev/';

/** Public URL of the catalog (worker fallback when the binding is absent). */
export const CATALOG_PUBLIC_URL = MEDIA_BASE + CATALOG_R2_KEY;
