/* Feed → omgithub Feedback (lands in omgithub's admin Feedback tab).
 * POST {API_ORIGIN}/api/feedback { type: 'bug'|'idea', message, attachments: [id] (≤ 3), source: 'feed', game_id, page }
 *   → 201 { id, attachments: n }; errors { error, code } (see attachments.js for uploads, credentials and codes)
 */
import { API_ORIGIN, MAX_FILES, apiFetch, createAttachPicker, errorText, readJson } from './attachments.js';

export const FEEDBACK_URL = `${API_ORIGIN}/api/feedback`;
export const FEEDBACK_MAX = 2000;
export const FEEDBACK_TYPES = [['bug', 'Bug'], ['idea', 'Idea']];

export async function sendFeedback({ type = 'bug', message = '', attachments = [], gameId = '', page = '' } = {}) {
  const body = {
    type: type === 'idea' ? 'idea' : 'bug',
    message: String(message || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, FEEDBACK_MAX),
    attachments: (attachments || []).map(String).slice(0, MAX_FILES),
    source: 'feed',
    page: String(page || location.href).slice(0, 500),
  };
  if (gameId) body.game_id = String(gameId);
  try {
    const r = await apiFetch(FEEDBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await readJson(r);
    return { ok: r.ok, status: r.status, body: j, error: r.ok ? '' : errorText(r.status, j, "Couldn't send — try again") };
  } catch (_) {
    return { ok: false, status: 0, error: "Couldn't send — check your connection and try again" };
  }
}

/* ---- Feedback sheet (same look + keyboard handling as the report sheet) ---- */
let sheetEl = null;
let st = null; // { gameId, onSent, onDismiss, type, sending }
let picker = null;
function ensureSheet() {
  if (sheetEl) return sheetEl;
  sheetEl = document.createElement('div');
  sheetEl.id = 'feedbackSheet';
  sheetEl.className = 'comments-sheet report-sheet feedback-sheet';
  sheetEl.hidden = true;
  sheetEl.setAttribute('aria-hidden', 'true');
  sheetEl.innerHTML = `
    <div class="comments-backdrop" data-close-feedback></div>
    <div class="comments-panel report-panel" role="dialog" aria-modal="true" aria-labelledby="feedbackTitle">
      <div class="comments-grab" aria-hidden="true"><span class="comments-handle"></span></div>
      <header class="comments-header">
        <h2 id="feedbackTitle" class="comments-title">Feedback</h2>
        <button type="button" class="comments-close" aria-label="Close" data-close-feedback>&times;</button>
      </header>
      <form class="report-body feedback-body" autocomplete="off">
        <div class="report-reasons" role="group" aria-label="Type">${FEEDBACK_TYPES.map(([k, l]) => `<button type="button" class="admin-chip" data-ftype="${k}" aria-pressed="false">${l}</button>`).join('')}</div>
        <textarea class="report-text feedback-text" maxlength="${FEEDBACK_MAX}" rows="4" placeholder="Tell us what's broken or what you'd like" aria-label="Your feedback"></textarea>
        <button type="submit" class="report-send feedback-send">Send</button>
      </form>
    </div>`;
  document.body.appendChild(sheetEl);
  picker = createAttachPicker();
  sheetEl.querySelector('.feedback-send').before(picker.el);
  const setType = (t) => { if (st) st.type = t; sheetEl.querySelectorAll('[data-ftype]').forEach((x) => { const on = x.dataset.ftype === t; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }); };
  sheetEl._setType = setType;
  sheetEl.querySelectorAll('[data-close-feedback]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); st?.onDismiss?.(); }));
  sheetEl.querySelector('.report-reasons').addEventListener('click', (e) => { const b = e.target.closest('[data-ftype]'); if (b && st) setType(b.dataset.ftype); });
  sheetEl.querySelector('.feedback-body').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!st || st.sending) return;
    const text = sheetEl.querySelector('.feedback-text').value.trim();
    if (!text && !picker.count()) { picker.say('Write a few words or attach a screenshot'); return; }
    if (picker.busy()) { picker.say('Still preparing the files…'); return; }
    const s = st;
    s.sending = true;
    const btn = sheetEl.querySelector('.feedback-send');
    btn.disabled = true;
    let ids = [];
    try {
      ids = await picker.uploadAll((i, n) => { btn.textContent = `Uploading ${i}/${n}…`; });
    } catch (e) {
      btn.textContent = 'Send'; btn.disabled = false; s.sending = false;
      picker.say(e?.message || "Couldn't upload — try again or remove the file");
      return;
    }
    btn.textContent = 'Sending…';
    const res = await sendFeedback({ type: s.type, message: text, attachments: ids, gameId: s.gameId, page: s.page });
    btn.textContent = 'Send'; btn.disabled = false; s.sending = false;
    if (st !== s) return;
    if (!res.ok) { picker.say(res.status === 429 ? 'Too many sends — try again later' : res.error); return; }
    s.onSent?.(res);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isFeedbackSheetOpen()) { e.preventDefault(); st?.onDismiss?.(); } });
  return sheetEl;
}
export const isFeedbackSheetOpen = () => !!sheetEl && !sheetEl.hidden && sheetEl.classList.contains('open');
export function openFeedbackSheet(opts = {}) {
  const el = ensureSheet();
  st = { ...opts, type: 'bug', sending: false };
  el._setType('bug');
  el.querySelector('.feedback-text').value = '';
  picker.reset();
  const btn = el.querySelector('.feedback-send'); btn.textContent = 'Send'; btn.disabled = false;
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('comments-open');
  requestAnimationFrame(() => el.classList.add('open'));
  return el;
}
export function closeFeedbackSheet() {
  if (!sheetEl || sheetEl.hidden) return;
  sheetEl.classList.remove('open');
  sheetEl.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('comments-open');
  sheetEl.querySelector('.feedback-text')?.blur();
  const el = sheetEl;
  setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 320);
  st = null;
}
