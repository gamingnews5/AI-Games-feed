/* Screenshot / video attachments for Feedback and Reports.
 *
 * API CONTRACT (omgithub prod, omsite 1665b4e):
 *   POST {API_ORIGIN}/api/attachments   multipart/form-data: exactly one "file" field + optional "duration" (seconds)
 *        → 201 { id, url, kind: 'image'|'video', mime, bytes, w?, h?, duration? }
 *        images: jpeg/png/webp ≤ 1 MB (we always re-encode to webp/jpeg); videos: mp4/webm/quicktime ≤ 25 MB, ≤ 30.5 s.
 *        Guests allowed; 30 uploads/hour, 120 MB/hour.
 *   Ids (max 3) are sent as `attachments: [id, …]` with POST /api/feedback and POST /api/feed/reports.
 *   GET /api/feed/reports returns texts[].attachments: [{ url, kind }] ([] when none).
 *   Errors: { error, code } — see ERROR_TEXT.
 * Cookies: sent on omgithub feed hosts (games./android.omgithub.com), never on lolgames.net.
 *
 * Kill switch: FEEDBACK_ATTACH_ENABLED (on). ?ff=-attach turns it off for the tab (testing).
 */

export const FEEDBACK_ATTACH_ENABLED = true;
export const API_ORIGIN = 'https://omgithub.com';
/** Feed hosts that share the omgithub session (cookies sent). */
export const CREDENTIALED_ORIGINS = new Set(['https://games.omgithub.com', 'https://android.omgithub.com']);
export const ATTACHMENTS_URL = `${API_ORIGIN}/api/attachments`;
export const MAX_FILES = 3;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_SEC = 30;
export const IMG_MAX_SIDE = 1600;
export const IMG_TARGET_BYTES = 300 * 1024;
export const IMG_MAX_BYTES = 1024 * 1024;
const VIDEO_TYPES = /^video\/(mp4|webm|quicktime)$/;
const UPLOAD_TIMEOUT_MS = 60000;
const FF_KEY = 'opus-feed-ff';

const ffAttach = (() => {
  try {
    const ff = new URLSearchParams(window.location.search).get('ff');
    if (ff != null) {
      const parts = ff.split(',');
      const v = parts.includes('-attach') ? 'off' : parts.includes('attach') ? 'on' : '';
      if (v) sessionStorage.setItem(FF_KEY, v); else sessionStorage.removeItem(FF_KEY);
      return v || null;
    }
    return sessionStorage.getItem(FF_KEY) || null;
  } catch (_) {
    return null;
  }
})();
export const attachEnabled = () => (ffAttach ? ffAttach === 'on' : FEEDBACK_ATTACH_ENABLED);

/** Server error codes → friendly text. */
export const ERROR_TEXT = {
  file_too_large: 'That file is too big',
  unsupported_type: 'That file type isn\u2019t supported — use a screenshot or an mp4/webm/mov video',
  rate_limited: 'Too many uploads — try again later',
  too_many_attachments: 'Up to 3 files',
  too_many_files: 'Up to 3 files',
  unknown_attachment: 'An attachment expired — remove it and attach again',
  origin_not_allowed: 'Uploads aren\u2019t allowed from this page',
  video_too_long: 'Video is too long (max 30 seconds)',
  missing_file: 'That file was empty — attach it again',
  storage_unavailable: 'Uploads are down for a moment — try again soon',
  storage_failed: 'Couldn\u2019t store the file — try again',
  upload_failed: 'Couldn\u2019t upload — try again or remove the file',
};
/** → friendly text for an error response (status + parsed body). */
export function errorText(status, body, fallback) {
  const c = body && body.code;
  if (c && ERROR_TEXT[c]) return ERROR_TEXT[c];
  if (status === 413) return ERROR_TEXT.file_too_large;
  if (status === 415) return ERROR_TEXT.unsupported_type;
  if (status === 429) return ERROR_TEXT.rate_limited;
  if (status === 403) return ERROR_TEXT.origin_not_allowed;
  if (status === 503) return ERROR_TEXT.storage_unavailable;
  return fallback;
}
/** Error thrown by uploadAttachment / sendFeedback with a friendly .message. */
export class ApiError extends Error {
  constructor(status, body, fallback) { super(errorText(status, body, fallback)); this.status = status; this.code = body?.code || ''; }
}
export const readJson = async (r) => { try { return await r.json(); } catch (_) { return null; } };

/** 'include' on omgithub feed hosts (session cookie), 'omit' elsewhere (lolgames.net). */
export const apiCredentials = () => (CREDENTIALED_ORIGINS.has(location.origin) ? 'include' : 'omit');

/** fetch with the reports.js credential pattern: credentialed first, uncredentialed retry only on a thrown CORS/network error. */
export async function apiFetch(url, init = {}, timeoutMs = 8000) {
  const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined);
  const cred = apiCredentials();
  try {
    return await fetch(url, { ...init, credentials: cred, signal: signal() });
  } catch (e) {
    if (cred !== 'include') throw e;
    return fetch(url, { ...init, credentials: 'omit', signal: signal() });
  }
}

const isVideo = (f) => /^video\//.test(f?.type || '');
const isImage = (f) => /^image\//.test(f?.type || '');

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}
const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob((b) => r(b), type, q));

/** Downscale to IMG_MAX_SIDE and re-encode (webp, jpeg fallback) until ≤ IMG_TARGET_BYTES. */
export async function shrinkImage(file) {
  const { img, url } = await loadImage(file);
  try {
    let side = IMG_MAX_SIDE;
    let best = null;
    for (let pass = 0; pass < 4; pass++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      for (const q of [0.82, 0.7, 0.58, 0.45]) {
        let b = await toBlob(c, 'image/webp', q);
        if (!b || b.type !== 'image/webp') b = await toBlob(c, 'image/jpeg', q);
        if (!b) continue;
        if (!best || b.size < best.size) best = b;
        if (b.size <= IMG_TARGET_BYTES) return b;
      }
      side = Math.round(side * 0.75);
    }
    if (!best) throw new Error('encode');
    return best;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Video duration in seconds (NaN when the browser can't read it). */
export function videoDuration(file, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let done = false;
    const end = (d) => { if (done) return; done = true; URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(d); };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => end(Number(v.duration));
    v.onerror = () => end(NaN);
    setTimeout(() => end(NaN), timeoutMs);
    v.src = url;
  });
}

/** → { blob, kind, name, preview } or { error } (friendly text). */
export async function prepareFile(file) {
  if (isVideo(file)) {
    if (!VIDEO_TYPES.test(file.type)) return { error: 'Use an mp4, webm or mov video' };
    if (file.size > MAX_VIDEO_BYTES) return { error: `Video is too big (max ${MAX_VIDEO_BYTES / 1048576} MB)` };
    const d = await videoDuration(file);
    if (Number.isFinite(d) && d > MAX_VIDEO_SEC + 0.5) return { error: `Video is too long (max ${MAX_VIDEO_SEC} seconds)` };
    return { blob: file, kind: 'video', name: file.name || 'video.mp4', duration: Number.isFinite(d) ? Math.round(d * 100) / 100 : null, preview: URL.createObjectURL(file) };
  }
  if (isImage(file)) {
    try {
      const blob = await shrinkImage(file);
      if (blob.size > IMG_MAX_BYTES) return { error: 'That screenshot is too big (max 1 MB)' };
      const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
      const base = String(file.name || 'screenshot').replace(/\.[^.]+$/, '') || 'screenshot';
      return { blob, kind: 'image', name: `${base}.${ext}`, preview: URL.createObjectURL(blob) };
    } catch (_) {
      return { error: "Couldn't read that image" };
    }
  }
  return { error: 'Only screenshots or videos' };
}

/** Upload one prepared file → { id, url, kind, bytes }; throws on failure. */
export async function uploadAttachment(item) {
  const fd = new FormData();
  fd.append('file', item.blob, item.name);
  if (item.kind === 'video' && item.duration != null) fd.append('duration', String(item.duration));
  let r;
  try {
    r = await apiFetch(ATTACHMENTS_URL, { method: 'POST', body: fd }, UPLOAD_TIMEOUT_MS);
  } catch (_) {
    throw new ApiError(0, null, 'Couldn\u2019t upload — check your connection and try again');
  }
  const j = await readJson(r);
  if (!r.ok) throw new ApiError(r.status, j, ERROR_TEXT.upload_failed);
  if (!j || j.id == null) throw new ApiError(r.status, null, ERROR_TEXT.upload_failed);
  return { id: String(j.id), url: j.url || '', kind: j.kind || item.kind, bytes: Number(j.bytes) || item.blob.size };
}

/** Reports feed: keep only https attachments of known kinds. */
export function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a === 'object' && typeof a.url === 'string' && /^https:\/\//.test(a.url))
    .map((a) => ({ url: a.url, kind: a.kind === 'video' ? 'video' : 'image' }))
    .slice(0, MAX_FILES);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Admin reports feed: image thumbs (tap → full size) and inline videos. */
export function attachmentsHtml(list) {
  if (!list?.length) return '';
  return `<div class="att-row report-atts">${list
    .map((a) => (a.kind === 'video'
      ? `<video class="att-media att-video" src="${esc(a.url)}" controls preload="metadata" playsinline></video>`
      : `<a class="att-media att-img" href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="Attachment" loading="lazy" referrerpolicy="no-referrer"></a>`))
    .join('')}</div>`;
}

/* ---- Picker: "Attach screenshots or video" button + thumbnails with ✕ ---- */
export function createAttachPicker({ max = MAX_FILES } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'att-picker';
  wrap.innerHTML = `
    <div class="att-row att-thumbs" aria-live="polite"></div>
    <p class="att-msg" role="status" hidden></p>
    <label class="att-add">
      <input type="file" class="att-input" accept="image/*,video/*" multiple hidden>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>
      <span>Attach screenshots or video</span>
    </label>`;
  const input = wrap.querySelector('.att-input');
  const thumbs = wrap.querySelector('.att-thumbs');
  const msg = wrap.querySelector('.att-msg');
  const add = wrap.querySelector('.att-add');
  let items = [];
  let pending = 0;
  const say = (t) => { msg.textContent = t || ''; msg.hidden = !t; };
  const render = () => {
    thumbs.innerHTML = '';
    items.forEach((it, i) => {
      const t = document.createElement('div');
      t.className = `att-thumb ${it.kind}`;
      t.innerHTML = it.kind === 'video'
        ? `<video src="${esc(it.preview)}" muted playsinline preload="metadata"></video><span class="att-badge" aria-hidden="true">▶</span>`
        : `<img src="${esc(it.preview)}" alt="">`;
      const x = document.createElement('button');
      x.type = 'button'; x.className = 'att-remove'; x.setAttribute('aria-label', 'Remove attachment'); x.textContent = '✕';
      x.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); URL.revokeObjectURL(it.preview); items.splice(i, 1); say(''); render(); });
      t.append(x);
      thumbs.append(t);
    });
    thumbs.hidden = !items.length;
    add.classList.toggle('full', items.length + pending >= max);
    input.disabled = items.length + pending >= max;
  };
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.length) return;
    say('');
    const room = max - items.length - pending;
    if (files.length > room) say(`Up to ${max} files`);
    const take = files.slice(0, Math.max(0, room));
    pending += take.length; render();
    for (const f of take) {
      const r = await prepareFile(f);
      pending--;
      if (r.error) say(r.error);
      else items.push(r);
      render();
    }
  });
  render();
  return {
    el: wrap,
    count: () => items.length,
    busy: () => pending > 0,
    say,
    reset() { items.forEach((it) => URL.revokeObjectURL(it.preview)); items = []; pending = 0; say(''); render(); },
    /** Upload all; → ids. onProgress(i, n). Throws on the first failure (nothing is sent). */
    async uploadAll(onProgress) {
      const ids = [];
      for (let i = 0; i < items.length; i++) {
        onProgress?.(i + 1, items.length);
        ids.push((await uploadAttachment(items[i])).id);
      }
      return ids;
    },
  };
}
