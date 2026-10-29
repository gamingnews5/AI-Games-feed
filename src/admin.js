/* Admin editing (rating + tags) and the per-game overrides every viewer gets.
 *
 * Non-admins: /api/me is read once after the first render; nothing else here runs
 * for them except the overrides fetch, which is a silent no-op on any failure.
 * Admins (data.user.is_admin === true): a small ✎ button in the action rail opens a
 * sheet with rating chips 1–10 and tag toggles. Edits apply optimistically and revert with a toast if the save fails.
 */


export const ME_URL = 'https://omgithub.com/api/me';
// Live (omsite 1e47f82). GET is public (credentials omitted, so lolgames.net's
// `Access-Control-Allow-Origin: *` works too); POST needs the omgithub session.
// GET  → { generated_at, overrides: { [game_id]: { admin_rating: 1..10|null, tags: string[]|null, updated_at } }, projects }
// POST { game_id, admin_rating } and/or { game_id, tags } and/or { game_id, play_url: https|null } (play_url needs server support) → 200 { ok, game_id, override|null }
//      errors { error }: 401 / 403 / 400 / 415 / 503
export const OVERRIDES_URL = 'https://omgithub.com/api/feed/overrides';
export const SAVE_URL = OVERRIDES_URL;
export const saveBody = (gameId, patch) => ({ game_id: gameId, ...patch });

const OVERRIDES_CACHE_KEY = 'opus-admin-overrides-v2';
const LOCAL_KEY = 'opus-admin-local-v1';
const FETCH_TIMEOUT_MS = 8000;
/** GET is max-age=30 + a 10s server cache: a just-saved value wins over the GET for this long
 *  unless the GET already carries that save (its updated_at ≥ the save's updated_at). */
export const LOCAL_WIN_MS = 45000;

function timeoutSignal(ms) {
  try {
    if (AbortSignal.timeout) return AbortSignal.timeout(ms);
  } catch (_) {}
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** true only for data.user?.is_admin === true; any failure → false. */
export async function fetchIsAdmin() {
  try {
    const r = await fetch(ME_URL, { credentials: 'include', cache: 'no-store', signal: timeoutSignal(FETCH_TIMEOUT_MS) });
    if (!r.ok) return false;
    const data = await r.json();
    return data?.user?.is_admin === true;
  } catch (_) {
    return false;
  }
}

/** Chip slug: lowercase, spaces/underscores → '-', keeps dots ('opus-5.5'). */
export function normalizeAdminTag(raw) {
  const v = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return /^[a-z0-9][a-z0-9.-]{0,31}$/.test(v) ? v : '';
}

/** The feed maps server names back to its chip slugs (e.g. 'opus 5.5' → 'opus-5.5', 'three.js' → 'three-js'). */
let canonTag = normalizeAdminTag;
export function setTagCanon(fn) {
  if (typeof fn === 'function') canonTag = fn;
}
export const MAX_TAGS = 12;
/** Tag overrides saved before this were catalog-tags-only (platform / model / engine chips
 *  stayed derived). From then on an override is the card's full chip list. */
export const LEGACY_TAGS_BEFORE = Date.parse('2026-10-28T10:29:00Z');

function cleanTags(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    const v = canonTag(t);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.length ? out : null;
}

/** https URL (≤2048 chars, no user:pass) → normalized href; anything else → null. */
export const MAX_PLAY_URL = 2048;
export function cleanPlayUrl(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > MAX_PLAY_URL) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** 1.0–10.0 in 0.1 steps (e.g. 7.3); anything else → null. */
export function cleanRating(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 10) return null;
  return Math.round(n * 10) / 10;
}

/** One override entry → { admin_rating|null, tags|null, updated_at } or null if it overrides nothing. */
function cleanEntry(o) {
  if (!o || typeof o !== 'object') return null;
  const e = { admin_rating: cleanRating(o.admin_rating), tags: cleanTags(o.tags), play_url: cleanPlayUrl(o.play_url), broken: o.broken === true || null, updated_at: o.updated_at || null };
  if (e.tags && e.updated_at && Date.parse(e.updated_at) < LEGACY_TAGS_BEFORE) e.legacy = true;
  return e.admin_rating == null && !e.tags && !e.play_url && !e.broken ? null : e;
}

/** { game_id: entry } from the GET response (or a bare map); null if unusable. */
export function parseOverrides(data) {
  const map = data && typeof data === 'object' ? (data.overrides && typeof data.overrides === 'object' ? data.overrides : data) : null;
  if (!map || Array.isArray(map)) return null;
  const out = {};
  for (const [id, o] of Object.entries(map)) {
    const e = id ? cleanEntry(o) : null;
    if (e) out[id] = e;
  }
  return out;
}

let serverMap = null; // latest known server overrides (fresh GET, else device cache)

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch (_) {
    return null;
  }
}
function writeJSON(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch (_) {}
}

export function readCachedOverrides() {
  if (!serverMap) serverMap = parseOverrides(readJSON(OVERRIDES_CACHE_KEY));
  return serverMap;
}

/** Fresh overrides (cached on success) or null on any failure. */
export async function fetchOverrides() {
  try {
    const r = await fetch(OVERRIDES_URL, { credentials: 'omit', cache: 'no-store', signal: timeoutSignal(FETCH_TIMEOUT_MS) });
    if (!r.ok) return null;
    const map = parseOverrides(await r.json());
    if (!map) return null;
    serverMap = map;
    writeJSON(OVERRIDES_CACHE_KEY, map);
    return map;
  } catch (_) {
    return null;
  }
}

/* ---- Local edits that beat a stale GET ----
 * id → { fields: {admin_rating, tags}, confirmed: fields|null, serverAt: iso|null, at: ms, inflight: n } */
const local = new Map();
(function loadLocal() {
  const saved = readJSON(LOCAL_KEY);
  if (!saved || typeof saved !== 'object') return;
  for (const [id, e] of Object.entries(saved)) {
    if (e && e.fields && Date.now() - e.at < LOCAL_WIN_MS) local.set(id, { fields: e.fields, confirmed: e.fields, serverAt: e.serverAt || null, at: e.at, inflight: 0 });
  }
})();
function persistLocal() {
  const out = {};
  for (const [id, e] of local) if (e.confirmed) out[id] = { fields: e.confirmed, serverAt: e.serverAt, at: e.at };
  writeJSON(LOCAL_KEY, out);
}

/** Local entry still wins over the server entry `o`? Drops it once it no longer does. */
function liveLocal(id, o) {
  const e = local.get(id);
  if (!e) return null;
  if (e.inflight > 0) return e;
  if (Date.now() - e.at >= LOCAL_WIN_MS) {
    local.delete(id);
    persistLocal();
    return null;
  }
  // The server map already carries this save (or something newer): use it. The entry
  // stays for the window so a later, staler GET still can't roll the value back.
  const caughtUp = e.serverAt && o?.updated_at && Date.parse(o.updated_at) >= Date.parse(e.serverAt);
  return caughtUp ? null : e;
}

/** Remember the catalog values once so a dropped override goes back to them. */
function baseOf(g) {
  if (!g.__adminBase) {
    g.__adminBase = {
      admin_rating: g.admin_rating ?? null,
      tags: Array.isArray(g.tags) ? g.tags.slice() : null,
      play_url: g.play_url || null,
    };
  }
  return g.__adminBase;
}

/** g.admin_tags = the card's full chip list (override); absent = chips derived from the catalog.
 *  A legacy override only replaces the catalog tags (g.tags). */
function setFields(g, rating, tags, legacyTags = null, playUrl = null, broken = null) {
  const base = baseOf(g);
  if (broken) g.broken = true;
  else delete g.broken;
  // Override Play link (all viewers); none → the catalog link.
  if (playUrl) {
    g.play_url = playUrl;
    g.play_url_override = true;
  } else {
    if (base.play_url) g.play_url = base.play_url;
    delete g.play_url_override;
  }
  if (rating == null) delete g.admin_rating;
  else g.admin_rating = rating;
  const catTags = legacyTags || base.tags;
  if (catTags && catTags.length) g.tags = catTags.slice();
  else delete g.tags;
  if (Array.isArray(tags)) g.admin_tags = tags.slice();
  else delete g.admin_tags;
}

/** Server entry (or null) on top of the catalog values. */
function fieldsFrom(g, o) {
  const base = baseOf(g);
  const legacy = !!(o?.legacy && o.tags);
  return { admin_rating: o?.admin_rating ?? base.admin_rating, tags: legacy ? null : o?.tags || null, legacyTags: legacy ? o.tags : null, play_url: o?.play_url || null, broken: o?.broken === true || null };
}
const state = (g) => JSON.stringify([g.admin_rating ?? null, g.tags || null, g.admin_tags || null, g.play_url || null, !!g.broken]);

/**
 * Apply overrides (default: the latest server map) on top of catalog games, in place.
 * A fresh local edit beats the server map. Games overridden before but missing now go
 * back to catalog values. Returns the ids whose rating/tags changed.
 */
export function applyOverrides(games, overrides) {
  const changed = [];
  const map = overrides || serverMap || {};
  if (!Array.isArray(games)) return changed;
  for (const g of games) {
    if (!g?.id) continue;
    const o = map[g.id] || null;
    const e = local.size ? liveLocal(g.id, o) : null;
    if (!o && !e && !g.__adminBase) continue;
    const f = e ? e.fields : fieldsFrom(g, o);
    const before = state(g);
    setFields(g, f.admin_rating, f.tags, f.legacyTags, f.play_url, f.broken);
    if (state(g) !== before) changed.push(g.id);
  }
  return changed;
}

/** Optimistic local edit: the game shows `fields` now and keeps them over a stale GET. */
export function setGameFields(g, fields) {
  baseOf(g);
  const e = local.get(g.id) || { confirmed: null, serverAt: null, inflight: 0 };
  const full = Array.isArray(fields.tags);
  e.fields = {
    admin_rating: fields.admin_rating ?? null,
    tags: full ? fields.tags.slice() : null,
    // No chip list given (rating-only edit): keep whatever catalog/legacy tags show now.
    legacyTags: full ? null : g.tags ? g.tags.slice() : null,
    play_url: cleanPlayUrl(fields.play_url),
    broken: fields.broken === true || null,
  };
  e.at = Date.now();
  local.set(g.id, e);
  setFields(g, e.fields.admin_rating, e.fields.tags, e.fields.legacyTags, e.fields.play_url, e.fields.broken);
}

const ERROR_TOASTS = { 401: 'Sign in to omgithub', 403: 'Not allowed', 503: 'Edits paused' };
export function saveErrorToast(status) {
  return `${ERROR_TOASTS[status] || "Couldn't save"} — reverted`;
}

/**
 * POST one patch for game `g`. On success the server's normalized override is applied
 * (unless a later edit for the same game is still in flight). On failure the game goes
 * back to the last saved value. Resolves to { ok: true } or { ok: false, status }.
 */
export async function saveGamePatch(g, patch) {
  const e = local.get(g.id);
  if (e) e.inflight++;
  let status = 0;
  let body = null;
  try {
    const r = await fetch(SAVE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(saveBody(g.id, patch)),
      signal: timeoutSignal(FETCH_TIMEOUT_MS),
    });
    status = r.status;
    body = await r.json().catch(() => null);
    if (!r.ok || !body || body.ok === false) throw new Error('save failed');
  } catch (_) {
    if (e) e.inflight = Math.max(0, e.inflight - 1);
    if (e && e.inflight === 0) {
      if (e.confirmed) e.fields = e.confirmed;
      else local.delete(g.id);
    }
    if (!e || e.inflight === 0) applyOverrides([g]);
    return { ok: false, status };
  }
  const o = cleanEntry(body.override);
  const saved = fieldsFrom(g, o);
  // Keep the device copy of the server map in step for the next boot.
  const map = readCachedOverrides() || {};
  if (o) map[g.id] = o;
  else delete map[g.id];
  serverMap = map;
  writeJSON(OVERRIDES_CACHE_KEY, map);
  if (e) {
    e.inflight = Math.max(0, e.inflight - 1);
    e.confirmed = saved;
    e.serverAt = o?.updated_at || null;
    e.at = Date.now();
    if (e.inflight === 0) {
      e.fields = saved;
      setFields(g, saved.admin_rating, saved.tags, saved.legacyTags, saved.play_url, saved.broken);
    }
    persistLocal();
  }
  return { ok: true };
}

/* ---- Edit sheet (reuses the comments-sheet look) ---- */

let sheetEl = null;
let sheetState = null; // { game, allTags, onChange, onClose }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ensureSheet() {
  if (sheetEl) return sheetEl;
  sheetEl = document.createElement('div');
  sheetEl.id = 'adminSheet';
  sheetEl.className = 'comments-sheet admin-sheet';
  sheetEl.hidden = true;
  sheetEl.setAttribute('aria-hidden', 'true');
  sheetEl.innerHTML = `
    <div class="comments-backdrop" data-close-admin></div>
    <div class="comments-panel admin-panel" role="dialog" aria-modal="true" aria-labelledby="adminTitle">
      <div class="comments-grab" aria-hidden="true"><span class="comments-handle"></span></div>
      <header class="comments-header">
        <h2 id="adminTitle" class="comments-title">Edit</h2>
        <button type="button" class="comments-close" aria-label="Close" data-close-admin>&times;</button>
      </header>
      <div class="admin-body">
        <div class="admin-label">Rating</div>
        <div class="admin-ratings">
          <input class="admin-rating-range" type="range" min="1" max="10" step="0.1" aria-label="Rating" />
          <output class="admin-rating-value" aria-live="polite">—</output>
          <button type="button" class="admin-rating-clear" data-rating-clear>Clear</button>
        </div>
        <div class="admin-label">Tags</div>
        <form class="admin-add" autocomplete="off">
          <input class="admin-add-input" type="text" inputmode="text" enterkeyhint="done" maxlength="40" placeholder="Add a tag" aria-label="New tag" />
          <button type="submit" class="admin-add-btn">Add</button>
        </form>
        <div class="admin-tags" role="group" aria-label="Tags"></div>
        <div class="admin-label">Status</div>
        <div class="admin-broken-row">
          <button type="button" class="admin-chip admin-broken" data-admin-broken aria-pressed="false">Broken</button>
          <span class="admin-report-count" data-admin-report-count></span>
          <button type="button" class="admin-chip admin-fixed" data-admin-fixed hidden>Fixed: clear reports</button>
          <a class="admin-reports-link" data-admin-reports-link href="?view=reports">Reports view</a>
        </div>
        <div class="admin-label">Play link</div>
        <form class="admin-play" autocomplete="off" novalidate>
          <input class="admin-play-input" type="url" inputmode="url" enterkeyhint="done" maxlength="2048" placeholder="https://… (empty = catalog link)" aria-label="Play link" spellcheck="false" autocapitalize="off" />
          <button type="submit" class="admin-add-btn">Save</button>
        </form>
        <button type="button" class="admin-reset-btn" data-admin-reset>Clear scrolled games</button>
      </div>
    </div>`;
  document.body.appendChild(sheetEl);
  sheetEl.querySelectorAll('[data-close-admin]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      sheetState?.onDismiss?.();
    }),
  );
  const range = sheetEl.querySelector('.admin-rating-range');
  const out = sheetEl.querySelector('.admin-rating-value');
  // Live readout while dragging; save once on release ('change').
  range.addEventListener('input', () => {
    out.textContent = Number(range.value).toFixed(1);
    range.classList.remove('unset');
  });
  range.addEventListener('change', () => {
    if (!sheetState) return;
    const n = cleanRating(range.value);
    if (n == null || n === sheetState.game.admin_rating) return renderAdminSheet();
    sheetState.onChange({ admin_rating: n });
  });
  sheetEl.querySelector('[data-rating-clear]').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!sheetState || sheetState.game.admin_rating == null) return;
    // Back to the catalog score.
    sheetState.onChange({ admin_rating: null });
  });
  sheetEl.querySelector('.admin-tags').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b || !sheetState) return;
    const t = b.dataset.tag;
    const cur = sheetState.tagsOf(sheetState.game);
    touchRecentTag(t);
    sheetState.onChange({ tags: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t] });
  });
  sheetEl.querySelector('.admin-add').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!sheetState) return;
    const input = sheetEl.querySelector('.admin-add-input');
    const t = canonTag(input.value);
    if (!t) {
      input.classList.remove('bad');
      void input.offsetWidth;
      input.classList.add('bad');
      return;
    }
    input.value = '';
    touchRecentTag(t);
    // New tag goes right after Mobile; the rest keep their places while the sheet is open.
    if (!sheetState.order.includes(t)) sheetState.order.splice(1, 0, t);
    const cur = sheetState.tagsOf(sheetState.game);
    if (!cur.includes(t)) sheetState.onChange({ tags: [...cur, t] });
    else renderAdminSheet();
  });
  sheetEl.querySelector('[data-admin-broken]').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!sheetState) return;
    const was = !!sheetState.game.broken;
    if (was) sheetState.justFixed = true; // offer "Fixed: clear reports" after un-marking
    sheetState.onChange({ broken: was ? null : true });
  });
  sheetEl.querySelector('[data-admin-fixed]').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!sheetState) return;
    sheetState.justFixed = false;
    sheetState.onClearReports?.(sheetState.game);
  });
  sheetEl.querySelector('[data-admin-reports-link]').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sheetState?.onOpenReports?.();
  });
  sheetEl.querySelector('.admin-play').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!sheetState) return;
    const input = sheetEl.querySelector('.admin-play-input');
    const raw = input.value.trim();
    const url = raw ? cleanPlayUrl(raw) : null;
    if (raw && !url) {
      input.classList.remove('bad');
      void input.offsetWidth;
      input.classList.add('bad');
      return;
    }
    input.classList.remove('bad');
    input.blur();
    const g = sheetState.game;
    const cur = g.play_url_override ? g.play_url : null;
    if (url === cur || (!url && !cur)) return renderAdminSheet();
    sheetState.onChange({ play_url: url });
  });
  sheetEl.querySelector('[data-admin-reset]').addEventListener('click', (e) => {
    e.stopPropagation();
    resetToFreshVisitor();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isAdminSheetOpen()) {
      e.preventDefault();
      sheetState?.onDismiss?.();
    }
  });
  return sheetEl;
}

/* ---- "Clear scrolled games": make this device look like a first-time visitor. ----
 * Wipes every opus-* localStorage/sessionStorage key (seen, last game, likes, sort,
 * Mobile filter, fit, mute, create-sheet ideas, + glow) and the cached catalog, but
 * keeps admin data: recent tags and the overrides/just-saved copies. Analytics ids
 * (feed.visitor / feed.session) and omgithub cookies are left alone. A sessionStorage
 * flag repeats the wipe on the next boot, before anything is read, so a late write
 * from the old page (scroll/seen timers) can't survive the reload. */
const RESET_FLAG = 'opus-feed-reset-pending';
const RESET_KEEP = new Set(['opus-feed-admin-recent-tags', OVERRIDES_CACHE_KEY, LOCAL_KEY]);
export const RESET_CACHES = ['opus-feed-catalog-v1'];
function wipeFeedState() {
  const cleared = [];
  for (const store of [localStorage, sessionStorage]) {
    try {
      for (const k of Object.keys(store)) {
        if (k.startsWith('opus-') && !RESET_KEEP.has(k) && k !== RESET_FLAG) { store.removeItem(k); cleared.push(k); }
      }
    } catch (_) {}
  }
  return cleared;
}
export function resetToFreshVisitor() {
  wipeFeedState();
  try { sessionStorage.setItem(RESET_FLAG, '1'); } catch (_) {}
  const go = () => window.location.replace(window.location.origin + '/');
  const drop = typeof caches !== 'undefined' ? Promise.all(RESET_CACHES.map((c) => caches.delete(c).catch(() => {}))) : Promise.resolve();
  Promise.race([drop, new Promise((r) => setTimeout(r, 800))]).then(go, go);
}
/** Call first thing on boot: finishes a pending reset (second wipe, then clears the flag). */
export function consumePendingReset() {
  try {
    if (sessionStorage.getItem(RESET_FLAG) !== '1') return false;
    sessionStorage.removeItem(RESET_FLAG);
  } catch (_) { return false; }
  wipeFeedState();
  return true;
}

/* Recently touched tags (toggled or added on any game), newest first. */
export const RECENT_TAGS_KEY = 'opus-feed-admin-recent-tags';
const RECENT_MAX = 12;
export function recentTags() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_TAGS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function touchRecentTag(t) {
  try {
    localStorage.setItem(RECENT_TAGS_KEY, JSON.stringify([t, ...recentTags().filter((x) => x !== t)].slice(0, RECENT_MAX)));
  } catch {}
}
/** Mobile first always, then recent tags, then the card's other chips, then the rest. */
function sheetOrder(tags, allTags) {
  const out = ['mobile'];
  const add = (t) => t && !out.includes(t) && out.push(t);
  recentTags().forEach(add);
  tags.forEach(add);
  allTags.forEach(add);
  return out;
}

export function isAdminSheetOpen() {
  return !!sheetEl && !sheetEl.hidden && sheetEl.classList.contains('open');
}

export function renderAdminSheet() {
  if (!sheetEl || !sheetState) return;
  const { game, allTags, label } = sheetState;
  sheetEl.querySelector('.comments-title').textContent = `Edit · ${game.title || game.id}`;
  const cur = game.admin_rating ?? null;
  const fallback = game.screenshot_score != null ? Math.round(Number(game.screenshot_score)) : null;
  const range = sheetEl.querySelector('.admin-rating-range');
  const shown = cur ?? (fallback != null && Number.isFinite(Number(game.screenshot_score)) ? Math.min(10, Math.max(1, Math.round(Number(game.screenshot_score) * 10) / 10)) : 5);
  range.value = String(shown);
  range.classList.toggle('unset', cur == null);
  sheetEl.querySelector('.admin-rating-value').textContent = cur == null ? `— (${Number(shown).toFixed(1)})` : cur.toFixed(1);
  sheetEl.querySelector('[data-rating-clear]').disabled = cur == null;
  const tags = sheetState.tagsOf(game);
  // Order is fixed when the sheet opens (no jumping under the finger).
  const order = sheetState.order || (sheetState.order = sheetOrder(tags, allTags));
  for (const t of tags) if (!order.includes(t)) order.push(t);
  const brokenBtn = sheetEl.querySelector('[data-admin-broken]');
  brokenBtn.classList.toggle('on', !!game.broken);
  brokenBtn.setAttribute('aria-pressed', String(!!game.broken));
  const reportN = sheetState.reportCount ? sheetState.reportCount(game) : 0;
  sheetEl.querySelector('[data-admin-report-count]').textContent = reportN == null ? '' : `${reportN} ${reportN === 1 ? 'report' : 'reports'}`;
  sheetEl.querySelector('[data-admin-fixed]').hidden = !(sheetState.justFixed && !game.broken && reportN > 0);
  const play = sheetEl.querySelector('.admin-play-input');
  if (document.activeElement !== play) {
    play.value = game.play_url_override ? game.play_url : '';
    play.placeholder = `https://… (empty = ${game.__adminBase?.play_url || game.play_url || 'catalog link'})`;
  }
  sheetEl.querySelector('.admin-tags').innerHTML = order
    .map((t) => {
      const on = tags.includes(t);
      return `<button type="button" class="admin-chip${on ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${on}">${esc(label ? label(t) : t)}</button>`;
    })
    .join('');
}

/** opts: { game, allTags, label(tag), tagsOf(game) → card chip slugs, onChange(patch), onDismiss() } */
export function openAdminSheet(opts) {
  const el = ensureSheet();
  sheetState = { ...opts, allTags: opts.allTags.slice() };
  renderAdminSheet();
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('comments-open');
  requestAnimationFrame(() => el.classList.add('open'));
}

export function closeAdminSheet() {
  if (!sheetEl || sheetEl.hidden) return;
  sheetEl.classList.remove('open');
  sheetEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('comments-open');
  sheetEl.querySelector('.admin-add-input')?.blur();
  sheetEl.querySelector('.admin-play-input')?.blur();
  const el = sheetEl;
  setTimeout(() => {
    if (!el.classList.contains('open')) el.hidden = true;
  }, 320);
  sheetState = null;
}

export function adminSheetGameId() {
  return sheetState?.game?.id || '';
}

/* ---- Trigger: small ✎ rail button, admins only (no long-press editing). ---- */
export const EDIT_BTN_HTML = `<button type="button" class="rail-btn admin-edit" aria-label="Edit rating and tags" title="Edit rating and tags"><span class="rail-icon" aria-hidden="true">✎</span></button>`;
