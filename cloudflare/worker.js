// games.omgithub.com -> grootbot-dev GitHub Pages (gh-pages branch of grootbot-dev/AI-Games-feed).
// GitHub won't let this repo claim the custom domain (still claimed by SubmitGame's Pages),
// so Cloudflare serves the hostname by proxying the project-site URL.
const ORIGIN = 'https://grootbot-dev.github.io/AI-Games-feed';
const PUBLIC = 'https://games.omgithub.com';

export default {
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url);
    const isAsset = url.pathname.startsWith('/assets/');
    const upstream = await fetch(ORIGIN + url.pathname + url.search, {
      method: request.method,
      headers: {
        'user-agent': request.headers.get('user-agent') || 'games-omgithub-proxy',
        accept: request.headers.get('accept') || '*/*',
      },
      redirect: 'manual',
      cf: isAsset ? { cacheEverything: true, cacheTtl: 86400 } : { cacheTtl: -1 },
    });
    const headers = new Headers(upstream.headers);
    const loc = headers.get('location');
    if (loc) {
      headers.set('location', loc.replace(/^https?:\/\/grootbot-dev\.github\.io\/AI-Games-feed/i, PUBLIC));
    }
    if (!isAsset) {
      // Same as the zone's HTML no-cache rules: refresh always gets the latest deploy.
      headers.set('cache-control', 'no-cache, must-revalidate');
      headers.set('expires', '0');
    }
    headers.delete('x-github-request-id');
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  },
};
