/* Admin editing (rating + tags) and the per-game overrides every viewer gets.
 *
 * Non-admins: /api/me is read once after the first render; nothing else here runs
 * for them except the overrides fetch, which is a silent no-op on any failure.
 * Admins (data.user.is_admin === true): a small ✎ button in the action rail opens a
 * sheet with rating chips 1–10 and tag toggles. Edits apply optimistically and revert with a toast if the save fails.
 */


export const ME_URL = 'https://omgithub.com/api/me';
// TODO(@omgithub): endpoints not final. Placeholders; a 404 / CORS failure is a no-op
// (overrides) or a revert + toast (saves).
// Expected GET response: { overrides: { [game_id]: { admin_rating?: 1..10|null, tags?: string[] } } }
// (a bare { [game_id]: {...} } map is accepted too).
export const OVERRIDES_URL = 'https://omgithub.com/api/feed/overrides';
// TODO(@omgithub): save body shape. Sent as POST JSON, credentials: 'include'.
export const SAVE_URL = 'https://omgithub.com/api/feed/overrides';
export const saveBody = (gameId, patch) => ({ game_id: gameId, ...patch }); // patch: {admin_rating} | {tags}

const OVERRIDES_CACHE_KEY = 'opus-admin-overrides-v1';
const FETCH_TIMEOUT_MS = 8000;

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

export function normalizeAdminTag(raw) {
  const v = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(v) ? v : '';
}

function cleanTags(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const t of raw) {
    const v = normalizeAdminTag(t);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function cleanRating(raw) {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : undefined;
}

/** { game_id: { admin_rating, tags } } from either response shape; null if unusable. */
export function parseOverrides(data) {
  const map = data && typeof data === 'object' ? (data.overrides && typeof data.overrides === 'object' ? data.overrides : data) : null;
  if (!map || Array.isArray(map)) return null;
  const out = {};
  for (const [id, o] of Object.entries(map)) {
    if (!id || !o || typeof o !== 'object') continue;
    const e = {};
    const r = cleanRating(o.admin_rating);
    if (r !== undefined) e.admin_rating = r;
    const t = cleanTags(o.tags);
    if (t) e.tags = t;
    if (Object.keys(e).length) out[id] = e;
  }
  return out;
}

export function readCachedOverrides() {
  try {
    return parseOverrides(JSON.parse(localStorage.getItem(OVERRIDES_CACHE_KEY) || 'null'));
  } catch (_) {
    return null;
  }
}

function writeCachedOverrides(map) {
  try {
    localStorage.setItem(OVERRIDES_CACHE_KEY, JSON.stringify(map));
  } catch (_) {}
}

/** Fresh overrides (cached on success) or null on any failure. */
export async function fetchOverrides() {
  if (!OVERRIDES_URL) return null;
  try {
    const r = await fetch(OVERRIDES_URL, { credentials: 'include', cache: 'no-store', signal: timeoutSignal(FETCH_TIMEOUT_MS) });
    if (!r.ok) return null;
    const map = parseOverrides(await r.json());
    if (map) writeCachedOverrides(map);
    return map;
  } catch (_) {
    return null;
  }
}

/** Remember the catalog values once so a later overrides map can drop an override. */
function baseOf(g) {
  if (!g.__adminBase) {
    g.__adminBase = {
      admin_rating: g.admin_rating ?? null,
      tags: Array.isArray(g.tags) ? g.tags.slice() : null,
    };
  }
  return g.__adminBase;
}

function setFields(g, rating, tags) {
  if (rating == null) delete g.admin_rating;
  else g.admin_rating = rating;
  if (tags && tags.length) g.tags = tags.slice();
  else delete g.tags;
}

/**
 * Apply { game_id: { admin_rating, tags } } on top of catalog games (in place).
 * Games overridden before but missing from `overrides` go back to catalog values.
 * Returns the ids whose rating/tags changed.
 */
export function applyOverrides(games, overrides) {
  const changed = [];
  if (!Array.isArray(games) || !overrides) return changed;
  for (const g of games) {
    if (!g?.id) continue;
    const o = overrides[g.id];
    if (!o && !g.__adminBase) continue;
    const base = baseOf(g);
    const rating = o && 'admin_rating' in o ? o.admin_rating : base.admin_rating;
    const tags = o && o.tags ? o.tags : base.tags;
    const before = JSON.stringify([g.admin_rating ?? null, g.tags || null]);
    setFields(g, rating, tags);
    if (JSON.stringify([g.admin_rating ?? null, g.tags || null]) !== before) changed.push(g.id);
  }
  return changed;
}

/** Local edit (optimistic): sets fields and keeps the cached overrides map in step. */
export function setGameFields(g, { admin_rating, tags }) {
  baseOf(g);
  setFields(g, admin_rating, tags);
}

export async function saveGamePatch(gameId, patch) {
  if (!SAVE_URL) throw new Error('save endpoint not configured');
  const r = await fetch(SAVE_URL, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(saveBody(gameId, patch)),
    signal: timeoutSignal(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`save failed (${r.status})`);
  // Keep the device copy in step so the next boot shows the edit before the fetch lands.
  const cached = readCachedOverrides() || {};
  cached[gameId] = { ...(cached[gameId] || {}), ...patch };
  writeCachedOverrides(cached);
  return true;
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
        <div class="admin-ratings" role="group" aria-label="Rating"></div>
        <div class="admin-label">Tags</div>
        <form class="admin-add" autocomplete="off">
          <input class="admin-add-input" type="text" inputmode="text" enterkeyhint="done" maxlength="40" placeholder="Add a tag" aria-label="New tag" />
          <button type="submit" class="admin-add-btn">Add</button>
        </form>
        <div class="admin-tags" role="group" aria-label="Tags"></div>
      </div>
    </div>`;
  document.body.appendChild(sheetEl);
  sheetEl.querySelectorAll('[data-close-admin]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      sheetState?.onDismiss?.();
    }),
  );
  sheetEl.querySelector('.admin-ratings').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rating]');
    if (!b || !sheetState) return;
    const n = Number(b.dataset.rating);
    // Tapping the current rating clears it (back to the catalog score).
    sheetState.onChange({ admin_rating: sheetState.game.admin_rating === n ? null : n });
  });
  sheetEl.querySelector('.admin-tags').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b || !sheetState) return;
    const t = b.dataset.tag;
    const cur = Array.isArray(sheetState.game.tags) ? sheetState.game.tags : [];
    sheetState.onChange({ tags: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t] });
  });
  sheetEl.querySelector('.admin-add').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!sheetState) return;
    const input = sheetEl.querySelector('.admin-add-input');
    const t = normalizeAdminTag(input.value);
    if (!t) {
      input.classList.remove('bad');
      void input.offsetWidth;
      input.classList.add('bad');
      return;
    }
    input.value = '';
    if (!sheetState.allTags.includes(t)) sheetState.allTags.unshift(t);
    const cur = Array.isArray(sheetState.game.tags) ? sheetState.game.tags : [];
    if (!cur.includes(t)) sheetState.onChange({ tags: [...cur, t] });
    else renderAdminSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isAdminSheetOpen()) {
      e.preventDefault();
      sheetState?.onDismiss?.();
    }
  });
  return sheetEl;
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
  sheetEl.querySelector('.admin-ratings').innerHTML = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    const on = cur === n;
    const hint = cur == null && fallback === n;
    return `<button type="button" class="admin-chip${on ? ' on' : ''}${hint ? ' admin-hint' : ''}" data-rating="${n}" aria-pressed="${on}">${n}</button>`;
  }).join('');
  const tags = Array.isArray(game.tags) ? game.tags : [];
  const order = [...tags, ...allTags.filter((t) => !tags.includes(t))];
  sheetEl.querySelector('.admin-tags').innerHTML = order
    .map((t) => {
      const on = tags.includes(t);
      return `<button type="button" class="admin-chip${on ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${on}">${esc(label ? label(t) : t)}</button>`;
    })
    .join('');
}

/** opts: { game, allTags, label(tag), onChange(patch), onDismiss() } */
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
