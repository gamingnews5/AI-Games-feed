/**
 * Cloudflare Pages advanced-mode worker (built to dist/_worker.js).
 * - Per-host <title>, description, Open Graph / Twitter tags, canonical.
 * - Per-host /robots.txt and /sitemap.xml.
 * - /stats -> /stats/ redirect and no-cache HTML headers for the routes it
 *   handles (static assets are excluded via _routes.json and keep _headers).
 */
import { MAIN_ORIGIN, DEFAULT_HOST, SITES, siteFor, isKnownHost, normalizeHost, gameCanonicalUrl } from '../src/sites.js';
import { gameMedia } from '../src/feed-from-catalog.js';
import { CATALOG_R2_KEY, CATALOG_PUBLIC_URL } from '../src/catalog-config.js';
const HTML_NO_CACHE = 'no-cache, must-revalidate';
/** Edge copy of the catalog (Cache API key + TTL). */
const CATALOG_CACHE_KEY = 'https://catalog-cache.invalid/grokgames-r2-v3.json';
const CATALOG_TTL_S = 300;
/** Max time the HTML may wait for a preload lookup before going out plain. */
const PRELOAD_LOOKUP_BUDGET_MS = 120;

/** Read the catalog from R2: bucket binding first, then the public r2.dev URL. */
async function fetchCatalogFromR2(env) {
  if (env?.CATALOG_BUCKET) {
    try {
      const obj = await env.CATALOG_BUCKET.get(CATALOG_R2_KEY);
      if (obj) return { body: await obj.arrayBuffer(), source: 'r2-binding' };
    } catch (_) {}
  }
  const res = await fetch(CATALOG_PUBLIC_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (res.ok) return { body: await res.arrayBuffer(), source: 'r2-public' };
  return null;
}

/**
 * Catalog response from R2, edge-cached (refreshed at most every CATALOG_TTL_S
 * per colo). Never parses the JSON here.
 */
async function cachedCatalog(ctx, env) {
  const cache = caches.default;
  const key = new Request(CATALOG_CACHE_KEY);
  try {
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch (_) {}
  try {
    const got = await fetchCatalogFromR2(env);
    if (!got) return null;
    const stored = new Response(got.body, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${CATALOG_TTL_S}`,
        'x-catalog-source': got.source,
        'x-catalog-fetched-at': new Date().toISOString(),
      },
    });
    const put = cache.put(key, stored.clone()).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(put);
    return stored;
  } catch (_) {
    return null;
  }
}

async function catalogJsonResponse(ctx, env, request) {
  let res = null;
  try {
    res = await cachedCatalog(ctx, env);
  } catch (_) {}
  if (!res) {
    return new Response('{"error":"catalog unavailable"}', {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  return new Response(res.body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Browser revalidates every load; the edge copy is at most ~5 min old.
      'cache-control': 'no-cache',
      'x-catalog-source': res.headers.get('x-catalog-source') || 'r2',
    },
  });
}

/** Find one game object in the catalog text without parsing all of it. */
function findGameInText(text, id) {
  const needle = new RegExp('"id"\\s*:\\s*' + JSON.stringify(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = needle.exec(text);
  if (!m) return null;
  // Walk back to the '{' that opens this object.
  let depth = 0;
  let start = -1;
  for (let i = m.index; i >= 0; i--) {
    const c = text.charCodeAt(i);
    if (c === 125) depth++;
    else if (c === 123) {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  // Walk forward (string-aware) to its matching '}'.
  let inStr = false;
  depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123) depth++;
    else if (c === 125 && --depth === 0) {
      try {
        const g = JSON.parse(text.slice(start, i + 1));
        return g && g.id === id ? g : null;
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

async function posterForGame(id, ctx, env, request) {
  const res = await cachedCatalog(ctx, env);
  if (!res) return null;
  const g = findGameInText(await res.text(), id);
  if (!g || !g.play_url) return null;
  const { poster } = gameMedia(g);
  return poster;
}

/** Resolve within the budget or give up (HTML must never wait on the catalog). */
function withinBudget(promise, ms) {
  return Promise.race([
    promise.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** On *.pages.dev previews, ?site=<host> picks a config for testing. */
function resolveSite(url) {
  const host = normalizeHost(url.hostname);
  if (host.endsWith('.pages.dev')) {
    const forced = normalizeHost(url.searchParams.get('site') || '');
    if (forced && SITES[forced]) return { host: forced, site: SITES[forced], preview: true };
    return { host: DEFAULT_HOST, site: SITES[DEFAULT_HOST], preview: true };
  }
  return { host, site: siteFor(host), preview: !isKnownHost(host) };
}

function gameIdFrom(url) {
  const id = (url.searchParams.get('g') || url.searchParams.get('game') || '').trim();
  return id && id.length <= 200 ? id : '';
}

function textResponse(body, type) {
  return new Response(body, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=300',
    },
  });
}

function robotsTxt(site, preview) {
  if (preview) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\nDisallow: /stats/\n\nSitemap: ${site.origin}/sitemap.xml\n`;
}

async function catalogIds(ctx, env, request) {
  try {
    const res = await cachedCatalog(ctx, env);
    if (!res) return [];
    const doc = await res.json();
    const games = Array.isArray(doc) ? doc : doc.games || [];
    const ids = [];
    const seen = new Set();
    for (const g of games) {
      if (!g || !g.id || !g.play_url || !String(g.play_url).trim()) continue;
      const id = String(g.id);
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  } catch (_) {
    return [];
  }
}

async function sitemapXml(site, ctx, env, request) {
  const urls = [`${site.origin}/`];
  if (site.origin === MAIN_ORIGIN) {
    for (const id of await catalogIds(ctx, env, request)) urls.push(gameCanonicalUrl(id));
  }
  const body = urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

class SetAttr {
  constructor(attr, value) {
    this.attr = attr;
    this.value = value;
  }
  element(el) {
    el.setAttribute(this.attr, this.value);
  }
}

function rewriteHtml(res, url, site, poster) {
  const isStats = url.pathname.startsWith('/stats');
  const id = isStats ? '' : gameIdFrom(url);
  const pageUrl = id ? gameCanonicalUrl(id) : `${site.origin}/`;
  const title = isStats ? `Stats · ${site.name}` : site.title;
  const seen = new Set();
  const meta = (key, value) => ({
    element(el) {
      seen.add(key);
      el.setAttribute('content', value);
    },
  });
  let rw = new HTMLRewriter()
    .on('title', { element: (el) => el.setInnerContent(title) })
    .on('.logo', { element: (el) => el.setInnerContent(site.name) });
  if (!isStats) {
    const tags = {
      'name="description"': site.description,
      'property="og:title"': site.title,
      'property="og:description"': site.description,
      'property="og:url"': pageUrl,
      'property="og:site_name"': site.name,
      'name="twitter:title"': site.title,
      'name="twitter:description"': site.description,
    };
    if (site.image) {
      tags['property="og:image"'] = site.image;
      tags['name="twitter:image"'] = site.image;
    }
    for (const [sel, value] of Object.entries(tags)) rw = rw.on(`meta[${sel}]`, meta(sel, value));
    rw = rw
      .on('link[rel="canonical"]', {
        element(el) {
          seen.add('canonical');
          el.setAttribute('href', pageUrl);
        },
      })
      .on('head', {
        element(el) {
          el.onEndTag((end) => {
            let add = '';
            for (const [sel, value] of Object.entries(tags)) {
              if (seen.has(sel)) continue;
              const [attr, raw] = sel.split('=');
              add += `<meta ${attr}="${esc(raw.replace(/"/g, ''))}" content="${esc(value)}" />`;
            }
            if (!seen.has('canonical')) add += `<link rel="canonical" href="${esc(pageUrl)}" />`;
            if (add) end.before(add, { html: true });
          });
        },
      });
  }
  // Early-fetch hints: catalog (same-origin), media origins, and the deep-linked poster.
  if (!isStats) {
    // R2 preconnect is static in index.html.
    let hints = `<link rel="preload" href="/catalog.json" as="fetch" crossorigin="anonymous" fetchpriority="high" />`;
    if (poster) hints += `<link rel="preload" href="${esc(poster)}" as="image" fetchpriority="high" />`;
    rw = rw.on('head', {
      element(el) {
        el.prepend(hints, { html: true });
      },
    });
  }
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  headers.set('cache-control', HTML_NO_CACHE);
  headers.set('expires', '0');
  headers.append('vary', 'Host');
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { site, preview } = resolveSite(url);
    const path = url.pathname;

    if (path === '/robots.txt') return textResponse(robotsTxt(site, preview), 'text/plain; charset=utf-8');
    if (path === '/catalog.json') return catalogJsonResponse(ctx, env, request);
    if (path === '/sitemap.xml') return textResponse(await sitemapXml(site, ctx, env, request), 'application/xml; charset=utf-8');
    if (path === '/stats') {
      const to = new URL(url);
      to.pathname = '/stats/';
      return Response.redirect(to.toString(), 301);
    }

    const id = path.startsWith('/stats') ? '' : gameIdFrom(url);
    let posterP = Promise.resolve(null);
    if (id) {
      const lookup = posterForGame(id, ctx, env, request);
      // Let a slow cold lookup finish (and fill the edge cache) after the HTML is sent.
      if (ctx?.waitUntil) ctx.waitUntil(lookup.catch(() => {}));
      posterP = withinBudget(lookup, PRELOAD_LOOKUP_BUDGET_MS);
    }
    let res;
    try {
      res = await env.ASSETS.fetch(request);
    } catch (_) {
      return new Response('Temporarily unavailable', { status: 503 });
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html')) return res;
    try {
      const poster = await posterP;
      return rewriteHtml(res, url, site, poster);
    } catch (_) {
      return res;
    }
  },
};
