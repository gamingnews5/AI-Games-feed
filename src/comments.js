/* Writable feed comments API. The endpoint is intentionally best-effort: until
 * omgithub deploys it, the feed keeps its existing catalog-only comments view. */
import { REPORTS_URL } from './reports.js';

const COMMENTS_ORIGIN = new URL(REPORTS_URL).origin;
const TIMEOUT_MS = 8000;
const signal = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined);

function credentials() {
  const host = window.location.hostname;
  return host === 'games.omgithub.com' || host === 'android.omgithub.com' ? 'include' : 'omit';
}

function urlFor(gameId) {
  return `${COMMENTS_ORIGIN}/api/feed/comments/${encodeURIComponent(String(gameId))}`;
}

function normalize(comment) {
  if (!comment || typeof comment !== 'object') return null;
  const body = String(comment.body ?? comment.text ?? '').trim();
  if (!body) return null;
  return {
    id: comment.id == null ? '' : String(comment.id),
    author: String(comment.author || 'anon'),
    avatar_url: typeof comment.avatar_url === 'string' ? comment.avatar_url : '',
    body,
    text: body,
    created_at: comment.created_at || '',
    is_own: comment.is_own === true,
  };
}

async function request(url, init = {}) {
  const response = await fetch(url, { ...init, credentials: credentials(), signal: signal() });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(`comments request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export async function fetchComments(gameId) {
  const data = await request(urlFor(gameId), { headers: { Accept: 'application/json' } });
  const comments = Array.isArray(data?.comments) ? data.comments.map(normalize).filter(Boolean) : [];
  const n = Number(data?.count);
  return { comments, count: Number.isFinite(n) && n >= 0 ? Math.floor(n) : comments.length };
}

export async function postComment(gameId, body, visitor) {
  const clean = String(body || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim().slice(0, 500);
  const data = await request(urlFor(gameId), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: clean, visitor: String(visitor || '').slice(0, 64) }),
  });
  return normalize(data?.comment || data);
}

export async function deleteComment(gameId, commentId) {
  return request(`${urlFor(gameId)}/${encodeURIComponent(String(commentId))}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
}
