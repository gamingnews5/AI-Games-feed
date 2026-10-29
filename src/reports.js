/* Broken-game reports.
 * POST   /api/feed/reports {game_id, text?, reason?, visitor?}  public, no credentials → 201/200 {ok, game_id, count}
 * GET    /api/feed/reports  admin (credentials) → { generated_at, reports: { id: { count, last_at, texts:[{text, reason, at}] } } }
 * DELETE /api/feed/reports/:game_id  admin → { ok, game_id } (server archives)
 */
export const REPORTS_URL = 'https://omgithub.com/api/feed/reports';
export const REPORTED_KEY = 'opus-feed-reported';
export const MAX_TEXT = 500;
export const REASONS = [
  ['wont_load', "Won't load"],
  ['black_screen', 'Black screen'],
  ['controls', 'Controls broken'],
  ['paywall', 'Asks to pay/login'],
];
const REASON_LABEL = Object.fromEntries(REASONS);
const TIMEOUT_MS = 8000;
const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined);

function readReported() {
  try {
    const v = JSON.parse(localStorage.getItem(REPORTED_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
export const hasReported = (id) => !!readReported()[id];
function markReported(id) {
  try {
    const m = readReported();
    m[id] = Date.now();
    localStorage.setItem(REPORTED_KEY, JSON.stringify(m));
  } catch {}
}

/** Send one report. Any answer (incl. 429 / network error) counts as done for this device. */
export async function sendReport(gameId, { reason = null, text = '', visitor = '' } = {}) {
  const body = { game_id: gameId };
  const t = String(text || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim().slice(0, MAX_TEXT);
  if (t) body.text = t;
  if (reason && REASON_LABEL[reason]) body.reason = reason;
  if (visitor && typeof visitor === 'string') body.visitor = visitor.slice(0, 64);
  let status = 0;
  try {
    const r = await fetch(REPORTS_URL, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal() });
    status = r.status;
  } catch {}
  // Thanks either way: 429 / dedupe / offline must not invite re-sending.
  if (status !== 400) markReported(gameId);
  return { ok: status >= 200 && status < 300, status };
}

function cleanReports(data) {
  const map = data?.reports;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const out = {};
  for (const [id, r] of Object.entries(map)) {
    const count = Number(r?.count);
    if (!id || !Number.isFinite(count) || count < 1) continue;
    const texts = Array.isArray(r.texts)
      ? r.texts.filter((x) => x && typeof x === 'object').map((x) => ({ text: typeof x.text === 'string' ? x.text.slice(0, MAX_TEXT) : '', reason: REASON_LABEL[x.reason] ? x.reason : null, at: x.at || null }))
      : [];
    out[id] = { count: Math.floor(count), last_at: r.last_at || texts[0]?.at || null, texts };
  }
  return out;
}
/** Admin: { game_id: {count, last_at, texts} } or null on failure. */
export async function fetchReports() {
  try {
    const r = await fetch(REPORTS_URL, { credentials: 'include', cache: 'no-store', signal: signal() });
    if (!r.ok) return null;
    return cleanReports(await r.json());
  } catch {
    return null;
  }
}
export async function clearReports(gameId) {
  try {
    const r = await fetch(`${REPORTS_URL}/${encodeURIComponent(gameId)}`, { method: 'DELETE', credentials: 'include', signal: signal() });
    return r.ok;
  } catch {
    return false;
  }
}

/** Most reported first, then latest report. */
export function sortReported(games, reports) {
  const at = (r) => Date.parse(r?.last_at || '') || 0;
  return games.slice().sort((a, b) => (reports[b.id]?.count || 0) - (reports[a.id]?.count || 0) || at(reports[b.id]) - at(reports[a.id]));
}

export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Card description lines for the Reports view: header + deduped texts, latest first (≤5, +N more). */
export function reportLines(r, { max = 5, now } = {}) {
  if (!r) return { head: 'No reports', lines: [], more: 0 };
  const n = r.count;
  const when = ago(r.last_at, now);
  const head = `${n} ${n === 1 ? 'report' : 'reports'}${when ? ` · last ${when}` : ''}`;
  const seen = new Set();
  const all = [];
  const sorted = r.texts.slice().sort((a, b) => (Date.parse(b.at || '') || 0) - (Date.parse(a.at || '') || 0));
  for (const x of sorted) {
    const label = x.reason ? REASON_LABEL[x.reason] : '';
    const line = x.text && label ? `${label}: ${x.text}` : x.text || label;
    const key = line.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    all.push(line);
  }
  return { head, lines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/* ---- Report sheet (reuses the comments-sheet look) ---- */
let sheetEl = null;
let sheetState = null; // { game, onSent, onDismiss }
function ensureSheet() {
  if (sheetEl) return sheetEl;
  sheetEl = document.createElement('div');
  sheetEl.id = 'reportSheet';
  sheetEl.className = 'comments-sheet report-sheet';
  sheetEl.hidden = true;
  sheetEl.setAttribute('aria-hidden', 'true');
  sheetEl.innerHTML = `
    <div class="comments-backdrop" data-close-report></div>
    <div class="comments-panel report-panel" role="dialog" aria-modal="true" aria-labelledby="reportTitle">
      <div class="comments-grab" aria-hidden="true"><span class="comments-handle"></span></div>
      <header class="comments-header">
        <h2 id="reportTitle" class="comments-title">Report broken game</h2>
        <button type="button" class="comments-close" aria-label="Close" data-close-report>&times;</button>
      </header>
      <form class="report-body" autocomplete="off">
        <div class="report-reasons" role="group" aria-label="What's wrong">${REASONS.map(([k, l]) => `<button type="button" class="admin-chip" data-reason="${k}" aria-pressed="false">${l}</button>`).join('')}</div>
        <textarea class="report-text" maxlength="${MAX_TEXT}" rows="3" placeholder="What's wrong? (optional)" aria-label="What's wrong?"></textarea>
        <button type="submit" class="report-send">Send</button>
      </form>
    </div>`;
  document.body.appendChild(sheetEl);
  sheetEl.querySelectorAll('[data-close-report]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); sheetState?.onDismiss?.(); }));
  sheetEl.querySelector('.report-reasons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-reason]');
    if (!b || !sheetState) return;
    sheetState.reason = sheetState.reason === b.dataset.reason ? null : b.dataset.reason;
    sheetEl.querySelectorAll('[data-reason]').forEach((x) => { const on = x.dataset.reason === sheetState.reason; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
  });
  sheetEl.querySelector('.report-body').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!sheetState || sheetState.sending) return;
    const st = sheetState;
    st.sending = true;
    const btn = sheetEl.querySelector('.report-send');
    btn.disabled = true;
    const res = await sendReport(st.game.id, { reason: st.reason, text: sheetEl.querySelector('.report-text').value, visitor: st.visitor || '' });
    btn.disabled = false;
    st.sending = false;
    st.onSent?.(res);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isReportSheetOpen()) { e.preventDefault(); sheetState?.onDismiss?.(); } });
  return sheetEl;
}
export const isReportSheetOpen = () => !!sheetEl && !sheetEl.hidden && sheetEl.classList.contains('open');
export function openReportSheet(opts) {
  const el = ensureSheet();
  sheetState = { ...opts, reason: null };
  el.querySelector('.comments-title').textContent = `Report · ${opts.game.title || opts.game.id}`;
  el.querySelector('.report-text').value = '';
  el.querySelectorAll('[data-reason]').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('comments-open');
  requestAnimationFrame(() => el.classList.add('open'));
}
export function closeReportSheet() {
  if (!sheetEl || sheetEl.hidden) return;
  sheetEl.classList.remove('open');
  sheetEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('comments-open');
  sheetEl.querySelector('.report-text')?.blur();
  const el = sheetEl;
  setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 320);
  sheetState = null;
}
