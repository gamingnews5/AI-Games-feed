/**
 * Cloudflare Pages advanced-mode worker (built to dist/_worker.js).
 * - Per-host <title>, description, Open Graph / Twitter tags, canonical.
 * - Per-host /robots.txt and /sitemap.xml.
 * - /stats -> /stats/ redirect and no-cache HTML headers for the routes it
 *   handles (static assets are excluded via _routes.json and keep _headers).
 */
import { MAIN_ORIGIN, DEFAULT_HOST, SITES, siteFor, isKnownHost, normalizeHost, gameCanonicalUrl } from '../src/sites.js';

const CATALOG_URL =
  'https://raw.githubusercontent.com/aigamedevs/Claude-vs-ChatGPT/main/data/grokgames.json';
const HTML_NO_CACHE = 'no-cache, must-revalidate';

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

async function catalogIds() {
  try {
    const res = await fetch(CATALOG_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!res.ok) return [];
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

async function sitemapXml(site) {
  const urls = [`${site.origin}/`];
  if (site.origin === MAIN_ORIGIN) {
    for (const id of await catalogIds()) urls.push(gameCanonicalUrl(id));
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

function rewriteHtml(res, url, site) {
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
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  headers.set('cache-control', HTML_NO_CACHE);
  headers.set('expires', '0');
  headers.append('vary', 'Host');
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { site, preview } = resolveSite(url);
    const path = url.pathname;

    if (path === '/robots.txt') return textResponse(robotsTxt(site, preview), 'text/plain; charset=utf-8');
    if (path === '/sitemap.xml') return textResponse(await sitemapXml(site), 'application/xml; charset=utf-8');
    if (path === '/stats') {
      const to = new URL(url);
      to.pathname = '/stats/';
      return Response.redirect(to.toString(), 301);
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
      return rewriteHtml(res, url, site);
    } catch (_) {
      return res;
    }
  },
};
