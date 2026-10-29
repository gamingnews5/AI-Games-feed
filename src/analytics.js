/**
 * Lightweight feed analytics → self-hosted Supabase (supabase.omgithub.com).
 * Insert-only with the publishable anon key; the table is unreadable to anon.
 * Every entry point is wrapped so analytics can never throw or block the feed.
 */
import { SUPABASE_URL, ANON_KEY } from './supabase-config.js';

const ENDPOINT = `${SUPABASE_URL}/rest/v1/feed_events`;
const FLUSH_MS = 5000;
const MAX_QUEUE = 200;
const COLS = ['visitor', 'session', 'game_id', 'event', 'value', 'device', 'tag', 'search', 'sort'];

/** Flip to false if the feed_events source columns are not live: nothing new is sent. */
export const SOURCE_COLUMNS_LIVE = true;
const SOURCE_COLS = ['referrer', 'landing', 'utm_source', 'utm_medium', 'utm_campaign'];
const SOURCE_SENT_KEY = 'feed.source.sent';
const OWN_HOSTS = new Set(['games.omgithub.com', 'android.omgithub.com', 'lolgames.net', 'omgithub.com']);
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

let enabled = false;
let source = null; // captured once at load; attached to the session's first event
let visitor = '';
let session = '';
let device = '';
let sortMode = '';
let queue = [];
let timer = 0;

function rid() {
  try {
    if (crypto.randomUUID) return crypto.randomUUID();
  } catch (_) {}
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function clip(s, n) {
  if (s == null || s === '') return null;
  return String(s).slice(0, n);
}

/** Traffic source for this page load (null fields when absent). Exported for tests. */
export function captureSource(href = location.href, referrer = document.referrer, ua = navigator.userAgent || '') {
  const url = new URL(href);
  const q = url.searchParams;
  let ref = null;
  try {
    if (referrer) {
      const r = new URL(referrer);
      if (/^https?:$/.test(r.protocol) && r.origin !== url.origin && !OWN_HOSTS.has(r.hostname)) ref = clip(r.origin + r.pathname, 300);
    }
  } catch (_) {}
  const app = /AiGameMaker\//.test(ua) || url.hostname === 'android.omgithub.com';
  return {
    referrer: ref,
    landing: clip(url.pathname + url.search, 300),
    utm_source: clip(q.get('utm_source') || q.get('ref') || (app ? 'app' : ''), 100),
    utm_medium: clip(q.get('utm_medium'), 100),
    utm_campaign: clip(q.get('utm_campaign'), 100),
  };
}

/** Remove utm_* and ref from the address bar (keeps ?g=, ?tag= and everything else). */
function cleanSourceParams() {
  try {
    const u = new URL(location.href);
    let changed = false;
    for (const k of [...UTM_KEYS, 'ref']) if (u.searchParams.has(k)) { u.searchParams.delete(k); changed = true; }
    if (changed) history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch (_) {}
}

function init() {
  try { source = captureSource(); } catch (_) { source = null; }
  cleanSourceParams();
  try {
    const host = location.hostname;
    const debug = new URLSearchParams(location.search).has('debug');
    const local = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
    enabled = debug || !local;
    if (!enabled) return;
    try {
      visitor = localStorage.getItem('feed.visitor') || '';
      if (!visitor) {
        visitor = rid();
        localStorage.setItem('feed.visitor', visitor);
      }
    } catch (_) {
      visitor = visitor || rid();
    }
    try {
      session = sessionStorage.getItem('feed.session') || '';
      if (!session) {
        session = rid();
        sessionStorage.setItem('feed.session', session);
      }
    } catch (_) {
      session = session || rid();
    }
    const ua = navigator.userAgent || '';
    device = /iPad|Tablet/i.test(ua)
      ? 'tablet'
      : /Mobi|Android|iPhone|iPod/i.test(ua)
        ? 'mobile'
        : 'desktop';
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        pauseWatch();
        flush();
      } else {
        resumeWatch();
      }
    });
    window.addEventListener('pagehide', () => {
      endWatch();
      flushSearch();
      flush();
    });
  } catch (_) {
    enabled = false;
  }
}

/** Queue an event. Never throws. */
export function track(event, fields = {}) {
  try {
    if (!enabled || !event) return;
    const v = Number(fields.value);
    queue.push({
      visitor: clip(visitor, 40),
      session: clip(session, 40),
      game_id: clip(fields.game_id, 120),
      event,
      value: Number.isFinite(v) ? Math.max(0, Math.min(86400, Math.round(v * 10) / 10)) : null,
      device,
      tag: clip(fields.tag, 60),
      search: clip(fields.search, 100),
      sort: clip(fields.sort ?? sortMode, 16),
    });
    if (SOURCE_COLUMNS_LIVE && source) {
      let sent = false;
      try { sent = sessionStorage.getItem(SOURCE_SENT_KEY) === '1'; sessionStorage.setItem(SOURCE_SENT_KEY, '1'); } catch (_) {}
      if (!sent) Object.assign(queue[queue.length - 1], source);
      source = null;
    }
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  } catch (_) {}
}

export function flush() {
  try {
    if (timer) clearTimeout(timer);
    timer = 0;
    if (!queue.length) return;
    // Same key set on every row (PostgREST bulk insert): the one row with source
    // columns goes in its own request so ordinary rows never name those columns.
    const batch = queue.splice(0, 100);
    const shape = (r, cols) => { const o = {}; cols.forEach((c) => (o[c] = r[c] ?? null)); return o; };
    const plain = batch.filter((r) => !('landing' in r)).map((r) => shape(r, COLS));
    const sourced = batch.filter((r) => 'landing' in r).map((r) => shape(r, [...COLS, ...SOURCE_COLS]));
    if (queue.length) timer = setTimeout(flush, 1000);
    if (sourced.length) post(sourced);
    if (plain.length) post(plain);
  } catch (_) {}
}

function post(rows) {
  try {
    fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    }).catch(() => {});
  } catch (_) {}
}

export function setSort(mode) {
  sortMode = mode || '';
}

/* ---- Watch time per card (wall clock while visible, excluding play overlay) ---- */
let watchId = '';
let watchStart = 0; // 0 = paused
let watchAccum = 0;

export function cardEnter(id) {
  try {
    if (!enabled || !id || id === watchId) return;
    endWatch();
    watchId = id;
    watchAccum = 0;
    watchStart = document.visibilityState === 'hidden' ? 0 : performance.now();
    track('view', { game_id: id });
  } catch (_) {}
}

export function pauseWatch() {
  try {
    if (watchStart) watchAccum += (performance.now() - watchStart) / 1000;
    watchStart = 0;
  } catch (_) {}
}

export function resumeWatch() {
  try {
    if (watchId && !watchStart && document.visibilityState !== 'hidden') watchStart = performance.now();
  } catch (_) {}
}

export function endWatch() {
  try {
    if (!watchId) return;
    pauseWatch();
    track('watch', { game_id: watchId, value: Math.min(watchAccum, 3600) });
    watchId = '';
    watchAccum = 0;
  } catch (_) {}
}

/* ---- Play overlay session length ---- */
let playId = '';
let playStart = 0;

/** Play tap. `overlay` = opened in the in-feed iframe (timed until exit). */
export function playStarted(id, overlay = false) {
  try {
    track('play', { game_id: id });
    if (overlay) {
      playId = id || '';
      playStart = performance.now();
      pauseWatch();
    }
  } catch (_) {}
}

export function playExited() {
  try {
    if (!playStart) return;
    track('exit_play', { game_id: playId, value: (performance.now() - playStart) / 1000 });
    playStart = 0;
    playId = '';
    resumeWatch();
  } catch (_) {}
}

/* ---- Search: debounce live typing into one event ---- */
let searchTimer = 0;
let pendingSearch = null;

function flushSearch() {
  try {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = 0;
    if (pendingSearch && pendingSearch.q) {
      track('search', { search: pendingSearch.q, value: pendingSearch.n });
    }
    pendingSearch = null;
  } catch (_) {}
}

export function trackSearch(q, resultCount) {
  try {
    if (!enabled) return;
    pendingSearch = { q: String(q || '').trim().toLowerCase(), n: resultCount };
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(flushSearch, 1500);
  } catch (_) {}
}

init();

/** Stable per-device id (feed.visitor), created on demand even when analytics is off. */
export function visitorId() {
  if (visitor) return visitor;
  try {
    let v = localStorage.getItem('feed.visitor') || '';
    if (!v) { v = rid(); localStorage.setItem('feed.visitor', v); }
    return (visitor = v);
  } catch (_) {
    return '';
  }
}
