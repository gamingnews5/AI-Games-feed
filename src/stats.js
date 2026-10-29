import { SUPABASE_URL, ANON_KEY } from './supabase-config.js';
import { fetchCatalogFeed } from './feed-from-catalog.js';

const POLL_MS = 5000;
const $ = (id) => document.getElementById(id);
const titles = new Map();
let prev = {};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
};
const dur = (s) => {
  s = Math.round(Number(s) || 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const gameLink = (id) =>
  `<a href="/?g=${encodeURIComponent(id)}" target="_blank" rel="noopener">${esc(titles.get(id) || id)}</a>`;

function list(el, rows, render) {
  $(el).innerHTML = rows && rows.length
    ? rows.map((r) => `<div class="row">${render(r)}</div>`).join('')
    : '<div class="empty">Nothing yet</div>';
}

function kpi(key, label, value, text) {
  const bump = prev[key] != null && value > prev[key];
  prev[key] = value;
  return `<div class="kpi"><b class="${bump ? 'bump' : ''}">${text ?? fmt(value)}</b><span>${label}</span></div>`;
}

function spark(plays, views) {
  const now = Date.now();
  const start = Math.floor(now / 60000) * 60000 - 59 * 60000;
  const p = new Map(plays.map((r) => [Date.parse(r.m), r.n]));
  const v = new Map(views.map((r) => [Date.parse(r.m), r.n]));
  let max = 1;
  for (let i = 0; i < 60; i++) max = Math.max(max, (p.get(start + i * 60000) || 0) + (v.get(start + i * 60000) || 0));
  let html = '';
  for (let i = 0; i < 60; i++) {
    const t = start + i * 60000;
    const pn = p.get(t) || 0;
    const vn = v.get(t) || 0;
    const label = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    html += `<div class="col" title="${label}: ${vn} views, ${pn} plays"><div class="v" style="height:${(vn / max) * 100}%"></div><div class="p" style="height:${(pn / max) * 100}%"></div></div>`;
  }
  $('spark').innerHTML = html;
}

function render(d) {
  const t = d.totals_24h || {};
  const plays = (t.play || 0) + (t.play_tab || 0);
  $('kpis').innerHTML = [
    kpi('active', 'active now (5 min)', d.active_5m),
    kpi('v24', 'visitors 24h', d.visitors_24h),
    kpi('v7', 'visitors 7d', d.visitors_7d),
    kpi('views', 'views 24h', t.view || 0),
    kpi('plays', 'plays 24h', plays),
    kpi('watch', 'watch time 24h', d.watch_seconds_24h, dur(d.watch_seconds_24h)),
    kpi('likes', 'likes 24h', t.like || 0),
    kpi('shares', 'shares 24h', t.share || 0),
    kpi('dl', 'downloads 24h', t.download || 0),
    kpi('search', 'searches 24h', t.search || 0),
  ].join('');
  spark(d.plays_per_min || [], d.views_per_min || []);
  const top = (r) => `<span class="name">${gameLink(r.game_id)}</span><span class="num"><b>${fmt(r.plays)}</b> plays · ${dur(r.watch)} · ${fmt(r.views)} views</span>`;
  list('top24', d.top_24h, top);
  list('top7', d.top_7d, top);
  list('skips', d.quick_skips_24h, (r) => `<span class="name">${gameLink(r.game_id)}</span><span class="num"><b>${fmt(r.skips)}</b> / ${fmt(r.watches)} (${Math.round((r.skips / Math.max(1, r.watches)) * 100)}%)</span>`);
  list('zero', d.zero_searches_7d, (r) => `<span class="name">${esc(r.q)}</span><span class="num"><b>${fmt(r.n)}</b>×</span>`);
  list('searches', d.top_searches_7d, (r) => `<span class="name"><a href="/?search=${encodeURIComponent(r.q)}" target="_blank" rel="noopener">${esc(r.q)}</a></span><span class="num"><b>${fmt(r.n)}</b>× · ${fmt(r.results)} results</span>`);
  list('tags', d.top_tags_7d, (r) => `<span class="name"><a href="/?tag=${encodeURIComponent(r.tag)}" target="_blank" rel="noopener">${esc(r.tag)}</a></span><span class="num"><b>${fmt(r.n)}</b> taps</span>`);
  renderSources(d.sources_7d);
  list('daily', (d.daily_30d || []).slice().reverse(), (r) => `<span class="name">${esc(new Date(r.d).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span><span class="num"><b>${fmt(r.views)}</b> views · <b>${fmt(r.plays)}</b> plays</span>`);
}

/* ---- Sources (7d): tap a row to see its exact referrer / landing links ---- */
const openSources = new Set();
const safeUrl = (u) => {
  try {
    const x = new URL(String(u ?? ''));
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : '';
  } catch (_) {
    return '';
  }
};
const extLink = (href, text) => href
  ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`
  : `<span>${esc(text)}</span>`;
const sourceName = (src) => {
  const s = String(src || '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s)) return extLink(safeUrl(`https://${s}`), s);
  return esc(s || '(direct)');
};
const landingHref = (path) => {
  const p = String(path ?? '');
  if (!p.startsWith('/') || p.startsWith('//')) return '';
  const u = safeUrl(`https://games.omgithub.com${p}`);
  return u && new URL(u).origin === 'https://games.omgithub.com' ? u : '';
};

function renderSources(rows) {
  const el = $('sources');
  if (!rows || !rows.length) { el.innerHTML = '<div class="empty">Nothing yet</div>'; return; }
  el.innerHTML = rows.map((r) => {
    const key = String(r.source ?? '');
    const refs = Array.isArray(r.referrers) ? r.referrers : null;
    const lands = Array.isArray(r.landings) ? r.landings : null;
    const expandable = !!(refs || lands);
    const open = expandable && openSources.has(key);
    const num = `<span class="num"><b>${fmt(r.visits)}</b> visits · ${fmt(r.sessions)} sessions · ${fmt(r.plays)} plays · ${fmt(r.likes)} likes</span>`;
    const head = expandable
      ? `<div class="row src-row" role="button" tabindex="0" aria-expanded="${open}" data-source="${esc(key)}"><span class="caret">${open ? '▾' : '▸'}</span><span class="name">${sourceName(r.source)}</span>${num}</div>`
      : `<div class="row"><span class="name">${sourceName(r.source)}</span>${num}</div>`;
    if (!open) return head;
    const sub = [];
    (refs || []).forEach((x) => {
      const href = safeUrl(x?.url);
      sub.push(`<div class="row sub"><span class="name">${extLink(href, x?.url ?? '')}</span><span class="num"><b>${fmt(x?.visits)}</b> visits · ${fmt(x?.plays)} plays</span></div>`);
    });
    (lands || []).forEach((x) => {
      sub.push(`<div class="row sub"><span class="tagl">landing</span><span class="name">${extLink(landingHref(x?.url), x?.url ?? '')}</span><span class="num"><b>${fmt(x?.visits)}</b> visits</span></div>`);
    });
    return head + `<div class="src-links">${sub.join('') || '<div class="empty">No links yet</div>'}</div>`;
  }).join('');
}

function toggleSource(row) {
  const k = row.dataset.source;
  if (openSources.has(k)) openSources.delete(k); else openSources.add(k);
  if (lastData) renderSources(lastData.sources_7d);
}
document.addEventListener('click', (e) => {
  if (e.target.closest('#sources a')) return;
  const row = e.target.closest('#sources .src-row');
  if (row) toggleSource(row);
});
document.addEventListener('keydown', (e) => {
  const row = e.target.closest?.('#sources .src-row');
  if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleSource(row); }
});

let lastData = null;
let busy = false;
async function poll() {
  if (busy || document.visibilityState === 'hidden') return;
  busy = true;
  const live = $('live');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/feed_stats`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}`, 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastData = await res.json();
    render(lastData);
    live.className = 'live ok';
    $('liveText').textContent = `live · ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    live.className = 'live err';
    $('liveText').textContent = `offline (${err.message || err})`;
  } finally {
    busy = false;
  }
}

fetchCatalogFeed()
  .then(({ feed }) => {
    const arr = Array.isArray(feed) ? feed : feed?.games || [];
    arr.forEach((g) => g?.id && titles.set(g.id, g.title || g.id));
    poll();
  })
  .catch(() => {});
poll();
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', poll);
