import { attachCreateFx } from './create-fx.js';
import './create-fx.css';
import {
  fetchCatalogFeed,
  readCachedCatalogFeed,
  REPO_RAW_BASE,
} from './feed-from-catalog.js';
import * as analytics from './analytics.js';
import * as admin from './admin.js';
import { MEDIA_BASE } from './catalog-config.js';
import { searchGames, queryWords } from './search.js';
import { siteFor, isKnownHost, gameCanonicalUrl, MAIN_ORIGIN } from './sites.js';

const feedEl = document.getElementById('feed');
const countEl = document.getElementById('count');
const hintEl = document.getElementById('hint');
const sortEl = document.getElementById('sort');
const mobileFilterEl = document.getElementById('mobileFilter');
const toastEl = document.getElementById('toast');
const commentsSheetEl = document.getElementById('commentsSheet');
const commentsListEl = document.getElementById('commentsList');
const commentsTitleEl = document.getElementById('commentsTitle');

const SORT_KEY = 'opus-feed-sort';
const MOBILE_KEY = 'opus-feed-mobile-only';
const LAST_ID_KEY = 'opus-feed-last-id';
const LIKES_KEY = 'opus-feed-likes';
const SEEN_KEY = 'opus-feed-seen';
// v2: default flipped to full frame (letterbox). The v1 key held the old cover
// default for most users, so it is dropped once; explicit toggles land in v2.
const FIT_KEY = 'opus-feed-fit-mode-v2';
const FIT_KEY_V1 = 'opus-feed-fit-mode';
const SORT_TOP = 'top';
const SORT_NEW = 'new';
/** Cover = old cropped full-bleed; letterbox = contain + blurred bg fill. */
const FIT_COVER = 'cover';
const FIT_LETTERBOX = 'letterbox';
/** Per-domain branding (lolgames.net, games.omgithub.com, ...). */
const SITE = siteFor(window.location.hostname);
/** Share links stay on the current domain; previews/localhost share the main site. */
const PUBLIC_SITE_ORIGIN = isKnownHost(window.location.hostname) ? window.location.origin : MAIN_ORIGIN;

/** Max videos with src attached (current + ahead). */
const PRELOAD_WINDOW = 5;
/** Play destinations to warm for the active card and the next card. */
const PLAY_NAV_PRELOAD_WINDOW = 2;
/** Seconds of buffer before advancing the preload chain. */
const BUFFER_AHEAD_SEC = 2.5;
/**
 * Short clips (duration < this) loop until cumulative watch on the card
 * reaches this many seconds, then auto-advance. Longer clips advance on
 * first natural `ended`.
 */
const MIN_WATCH_BEFORE_ADVANCE = 10;
/** Screenshot-only cards: time per screenshot (multi) / for a lone screenshot. */
const SLIDE_MS = 3000;
const SINGLE_SLIDE_MS = 4000;
/** Crossfade between screenshots (matches .slide opacity transition). */
const SLIDE_FADE_MS = 700;

let allGames = [];
let catalogCount = 0;
let keyboardWired = false;
let scrollHintWired = false;
let hintHidden = false;
let activeIndex = 0;
let scrollRaf = 0;
/** Highest index currently allowed to hold a src (pipeline tip). */
let pipelineTip = -1;
const videoListeners = new WeakMap();
let toastTimer = 0;
/** Skip URL/position writes during programmatic restore scroll. */
let restoring = false;
/** Skip history pushes while applying a back/forward navigation. */
let historySilent = false;
/** True after the landing game replaces the current history entry. */
let feedHistorySeeded = false;
/** Cumulative seconds watched on the current card (short-clip looping). */
let watchAccumSec = 0;
/** Game id that watchAccumSec belongs to. */
let accumGameId = null;
/** Suppress auto-advance once (e.g. after Play opens external). */
let autoAdvancePaused = false;
const MUTED_KEY = 'opus-feed-muted';
/** Inside the Ai Game Maker Android app (UA token) or its host: sound on by default. */
function inAiGameMakerApp() {
  return /AiGameMaker\//.test(navigator.userAgent || '') || window.location.hostname === 'android.omgithub.com';
}
/** Saved mute toggle ('1'/'0') wins; else muted by default like Instagram/TikTok, except in the app. */
function readMutedPreference() {
  try {
    const v = localStorage.getItem(MUTED_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch (_) {}
  return !inAiGameMakerApp();
}
function writeMutedPreference(muted) {
  try {
    localStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch (_) {}
}
/** User's audio preference. */
let mutedPreference = readMutedPreference();
/** Temporary mute used only when the browser rejects autoplay with sound. */
let autoplayFallbackMuted = false;
let userGestureUnlocked = false;
let gestureWired = false;
/** Comments bottom sheet open — pause auto-advance / feed scroll. */
let commentsOpen = false;
let commentsSwipeStartY = null;
let commentsSwipeCurrentY = 0;
let commentsSwipeActive = false;
/** Play origins/URLs already given navigation hints during this page session. */
const warmedPlayOrigins = new Set();
const warmedPlayUrls = new Set();

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function platformLabel(platforms) {
  if (!Array.isArray(platforms) || !platforms.length) return '';
  const set = new Set(platforms.map((p) => String(p).toLowerCase()));
  const mobile = set.has('mobile') || set.has('touch') || set.has('phone');
  const pc = set.has('pc') || set.has('desktop');
  if (mobile && pc) return 'Mobile · PC';
  if (mobile) return 'Mobile';
  if (pc) return 'PC';
  return '';
}

/** Admin rating (override) wins over the catalog's screenshot_score. */
function effectiveScore(g) {
  return g.admin_rating ?? g.screenshot_score ?? -1;
}

function scoreLabel(score) {
  if (score == null || Number.isNaN(Number(score))) return '—';
  return Number(score).toFixed(1);
}

function readSortMode() {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === SORT_NEW || v === SORT_TOP) {
      analytics.setSort(v);
      return v;
    }
  } catch (_) {}
  // Top is the default when nothing is saved.
  analytics.setSort(SORT_TOP);
  return SORT_TOP;
}

function writeSortMode(mode) {
  analytics.setSort(mode);
  try {
    localStorage.setItem(SORT_KEY, mode);
  } catch (_) {}
}

function readMobileOnly() {
  try {
    return localStorage.getItem(MOBILE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function readFitMode() {
  try {
    const v = localStorage.getItem(FIT_KEY);
    if (v === FIT_COVER || v === FIT_LETTERBOX) return v;
  } catch (_) {}
  // Default: full frame (contain + blurred fill). Cropped cover only after the user toggles.
  return FIT_LETTERBOX;
}

function migrateFitMode() {
  try {
    localStorage.removeItem(FIT_KEY_V1);
  } catch (_) {}
}
migrateFitMode();

function writeFitMode(mode) {
  try {
    localStorage.setItem(FIT_KEY, mode);
  } catch (_) {}
}

function letterboxFitEnabled() {
  return readFitMode() === FIT_LETTERBOX;
}

function syncFitToggleTitle() {
  const fit = letterboxFitEnabled();
  document.documentElement.classList.toggle('fit-letterbox', fit);
  document.body.classList.toggle('fit-letterbox', fit);
  const logo = document.querySelector('.logo');
  if (!logo) return;
  const mode = readFitMode();
  logo.setAttribute(
    'aria-label',
    mode === FIT_LETTERBOX
      ? `${SITE.name} — full frame mode. Tap for cropped cover.`
      : `${SITE.name} — cropped cover mode. Tap for full frame.`,
  );
}

/** Ignore duplicate toggles from the same gesture (stacked listeners / echo events). */
let lastFitToggleAt = 0;
const FIT_TOGGLE_COOLDOWN_MS = 500;

/** Toggle cover ↔ letterbox and re-apply active card letterbox state. */
function toggleFitMode() {
  const now = Date.now();
  if (now - lastFitToggleAt < FIT_TOGGLE_COOLDOWN_MS) {
    return readFitMode();
  }
  lastFitToggleAt = now;
  const next = letterboxFitEnabled() ? FIT_COVER : FIT_LETTERBOX;
  writeFitMode(next);
  syncFitToggleTitle();
  syncAllLetterbox();
  return next;
}

function effectiveMuted() {
  return mutedPreference || autoplayFallbackMuted;
}

function syncMuteControls() {
  const muted = effectiveMuted();
  cards().forEach((card) => {
    const button = card.querySelector('.mute-control');
    if (!button) return;
    button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    button.setAttribute('aria-label', muted ? 'Unmute video' : 'Mute video');
    button.title = muted ? 'Unmute video' : 'Mute video';
  });
}

function applyMuteState() {
  const muted = effectiveMuted();
  cards().forEach((card) => {
    const video = videoOf(card);
    if (video) video.muted = muted;
  });
  syncMuteControls();
}

function setMutedPreference(muted) {
  mutedPreference = Boolean(muted);
  writeMutedPreference(mutedPreference);
  autoplayFallbackMuted = false;
  userGestureUnlocked = true;
  applyMuteState();
  if (!mutedPreference) {
    const video = videoOf(cards()[activeIndex]);
    if (video) tryPlay(video);
  }
}

function unlockAudioOnGesture() {
  if (userGestureUnlocked) return;
  userGestureUnlocked = true;
  if (autoplayFallbackMuted && !mutedPreference) {
    autoplayFallbackMuted = false;
    applyMuteState();
    const video = videoOf(cards()[activeIndex]);
    if (video) tryPlay(video);
  } else {
    syncMuteControls();
  }
  ['pointerdown', 'touchstart', 'wheel', 'keydown'].forEach((event) => {
    document.removeEventListener(event, unlockAudioOnGesture, true);
  });
}

function wireAudioGesture() {
  if (gestureWired) return;
  gestureWired = true;
  ['pointerdown', 'touchstart', 'wheel', 'keydown'].forEach((event) => {
    document.addEventListener(event, unlockAudioOnGesture, { capture: true, passive: true });
  });
}

function writeMobileOnly(on) {
  try {
    localStorage.setItem(MOBILE_KEY, on ? '1' : '0');
  } catch (_) {}
}

function readLastId() {
  try {
    return localStorage.getItem(LAST_ID_KEY) || '';
  } catch (_) {
    return '';
  }
}

function writeLastId(id) {
  if (!id) return;
  try {
    localStorage.setItem(LAST_ID_KEY, id);
  } catch (_) {}
}

function readLikes() {
  try {
    const raw = localStorage.getItem(LIKES_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function writeLikes(map) {
  try {
    localStorage.setItem(LIKES_KEY, JSON.stringify(map));
  } catch (_) {}
}

function isLiked(id) {
  return Boolean(readLikes()[id]);
}

function toggleLike(id) {
  const map = readLikes();
  if (map[id]) delete map[id];
  // Store when it was liked (truthy, so old `true` entries keep working) for Liked order.
  else map[id] = Date.now();
  writeLikes(map);
  return Boolean(map[id]);
}

function likeCount() {
  return Object.keys(readLikes()).length;
}

function readSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function writeSeen(map) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch (_) {}
}

function markSeen(id) {
  if (!id) return;
  const map = readSeen();
  if (map[id]) return;
  map[id] = Date.now();
  writeSeen(map);
}

function resetWatchAccum(id) {
  watchAccumSec = 0;
  accumGameId = id || null;
  autoAdvancePaused = false;
}

/**
 * Pick one resume target from the current Top/New + Mobile list. A valid deep
 * link wins; otherwise refresh resumes from the saved last id. Keeping this
 * choice in one place makes ordering and landing use the same target.
 */
function resumeIdForGames(games) {
  const hasId = (id) => Boolean(id && games.some((game) => game.id === id));
  const linkedId = deepLinkIdFromUrl();
  if (hasId(linkedId)) return linkedId;
  const lastId = readLastId();
  return hasId(lastId) ? lastId : '';
}

/**
 * After Top/New + Mobile filter: keep the resume id in place, but pull any
 * unseen games that sorted above it to sit immediately after the current
 * card. Seen games above remain above, and an empty seen set follows the
 * same path without special handling.
 */
/**
 * Drop locally viewed games, but keep the card we are landing on so a resume
 * or a shared link does not vanish. Used by New only; Top still shows seen
 * games and only reorders them.
 */
function withoutSeenExcept(games, keepId) {
  const seen = readSeen();
  return games.filter((g) => g.id === keepId || !seen[g.id]);
}

/**
 * Seen games sit above the landing card, oldest first, so scrolling up walks
 * back through watch history (most recently seen is the card just above).
 * Unseen games keep their Top/New order below it.
 */
function orderSeenHistoryAbove(games, anchorId) {
  const seen = readSeen();
  const rest = games.filter((g) => g.id !== anchorId);
  const history = rest
    .filter((g) => seen[g.id])
    .sort((a, b) => (Number(seen[a.id]) || 0) - (Number(seen[b.id]) || 0));
  const upcoming = rest.filter((g) => !seen[g.id]);
  const anchor = games.find((g) => g.id === anchorId);
  if (!anchor) return [...history, ...upcoming];
  return [...history, anchor, ...upcoming];
}

function orderWithUnseenCatchUp(games, resumeId) {
  if (!resumeId || !games.length) return games;
  const idx = games.findIndex((g) => g.id === resumeId);
  if (idx < 0) return games;

  const before = games.slice(0, idx);
  const current = games[idx];
  const after = games.slice(idx + 1);
  const seen = readSeen();
  const unseenAbove = before.filter((g) => !seen[g.id]);
  const seenAbove = before.filter((g) => seen[g.id]);
  if (!unseenAbove.length) return games;
  return [...seenAbove, current, ...unseenAbove, ...after];
}

function parseTs(raw) {
  const t = Date.parse(raw || '');
  return Number.isFinite(t) ? t : 0;
}

/** last_seen, then listing/publication, then video mtime — for helpers. */
function seenTs(game) {
  return parseTs(
    game.last_seen || game.listed_at || game.first_seen || game.published_at || game.video_mtime,
  );
}

/**
 * Sort games: fixed feedGroup() order, then within a group
 * Top: screenshot_score desc.
 * New: last_seen desc → listed_at/first_seen desc → published_at desc →
 * id asc → video_mtime desc → remote_likes desc. Never falls back to score
 * (so New stays distinct when many games share a batch day).
 */
/**
 * Fixed feed groups (Top/New only sort inside a group):
 * 1 browser games with a sourced clip, 2 self-recorded clips (tag rec),
 * 3 ROM / own-files / download games with a clip, 4 screenshot slideshows
 * (≥2 screenshots or tag screenshots), 5 single-image cards.
 */
function feedGroup(g) {
  const tags = Array.isArray(g.tags) ? g.tags : [];
  if (g.video) {
    if (g.requires_own_files === true || g.browser_playable === false || tags.includes('rom')) return 3;
    return tags.includes('rec') ? 2 : 1;
  }
  const n = Array.isArray(g.slides) ? g.slides.length : 0;
  return n >= 2 || tags.includes('screenshots') ? 4 : 5;
}

function sortGames(games, mode) {
  const list = games.slice();
  if (mode === SORT_NEW) {
    list.sort((a, b) => {
      const dLast = parseTs(b.last_seen) - parseTs(a.last_seen);
      if (dLast !== 0) return dLast;
      const dListed =
        parseTs(b.listed_at || b.first_seen) -
        parseTs(a.listed_at || a.first_seen);
      if (dListed !== 0) return dListed;
      const dPublished = parseTs(b.published_at) - parseTs(a.published_at);
      if (dPublished !== 0) return dPublished;
      const idCmp = String(a.id || '').localeCompare(String(b.id || ''));
      if (idCmp !== 0) return idCmp;
      const dVm = parseTs(b.video_mtime) - parseTs(a.video_mtime);
      if (dVm !== 0) return dVm;
      return (Number(b.remote_likes) || 0) - (Number(a.remote_likes) || 0);
    });
  } else {
    list.sort((a, b) => effectiveScore(b) - effectiveScore(a));
  }
  // Stable: keeps the Top/New order inside each group.
  list.sort((a, b) => feedGroup(a) - feedGroup(b));
  return list;
}

/** Active tag filter (?tag=<tag>); empty string = no tag filter. */
function normalizeTag(raw) {
  const v = String(raw || '').toLowerCase().trim();
  return /^[a-z0-9][a-z0-9.-]{0,31}$/.test(v) ? v : '';
}

function tagFromUrl() {
  try {
    return normalizeTag(new URLSearchParams(window.location.search).get('tag'));
  } catch (_) {
    return '';
  }
}

let activeTag = tagFromUrl();

/** Liked filter (?liked=1): only games liked on this device. */
function likedFromUrl() {
  try {
    const v = new URLSearchParams(window.location.search).get('liked');
    return v === '1' || v === 'true';
  } catch (_) {
    return false;
  }
}

let activeLiked = likedFromUrl();

/**
 * Liked games, most recently liked first. Entries that have a like timestamp
 * lead (newest first); legacy `true` entries keep the given Top/New order after them.
 */
function likedGamesOrdered(sortedGames) {
  const likes = readLikes();
  const ts = (g) => (typeof likes[g.id] === 'number' ? likes[g.id] : 0);
  return sortedGames
    .filter((g) => likes[g.id])
    .map((g, i) => ({ g, i, t: ts(g) }))
    .sort((a, b) => (b.t - a.t) || (a.i - b.i))
    .map((x) => x.g);
}

/** Free-text search (?search=…); empty = off. */
function searchFromUrl() {
  try {
    return String(new URLSearchParams(window.location.search).get('search') || '').trim().slice(0, 80);
  } catch (_) {
    return '';
  }
}

let activeSearch = searchFromUrl();

function searchWords(q) {
  return queryWords(q);
}

/** Searchable fields: core (title, creator handles, engine, tags/labels) is also
 *  used for typo-tolerant matching; description is exact-match only. */
function searchFields(g) {
  const tags = gameTags(g);
  return {
    core: [g.title, g.author, g.github_user, g.x_handle, g.engine, ...tags, ...tags.map(tagLabel)],
    extra: [g.description],
  };
}

/** Tags a card can be filtered by: catalog tags plus the engine name. */
function gameTags(g) {
  // Admin chip override: the card's chips are exactly the list, and so is the filter.
  if (Array.isArray(g.admin_tags)) return g.admin_tags.slice();
  const out = Array.isArray(g.tags) ? g.tags.slice() : [];
  const eng = normalizeTag(String(g.engine || '').replace(/[\s.]+/g, '-'));
  if (eng && !out.includes(eng)) out.push(eng);
  platformTags(g.platforms).forEach((t) => {
    if (!out.includes(t)) out.push(t);
  });
  const made = madeWithTag(g.made_with);
  if (made && !out.includes(made)) out.push(made);
  return out;
}

/** Platform filter slugs: desktop/pc → pc, touch/phone/mobile → mobile. */
function platformTags(platforms) {
  if (!Array.isArray(platforms)) return [];
  const set = new Set(platforms.map((x) => String(x).toLowerCase()));
  const out = [];
  if (set.has('mobile') || set.has('touch') || set.has('phone')) out.push('mobile');
  if (set.has('pc') || set.has('desktop')) out.push('pc');
  return out;
}

/** Friendly chip / header labels for catalog tags (slug stays the filter key). */
const TAG_LABELS = { rec: 'Recorded', screenshots: 'Screenshots' };

const MADE_LABELS = { 'opus-5.5': 'Opus 5.5', 'sonnet-5.5': 'Sonnet 5.5', astra: 'Astra', 'gemini-4-argon': 'Gemini 4 Argon' };

function madeWithTag(made) {
  const key = String(made || '').toLowerCase();
  return MADE_LABELS[key] ? key : '';
}

/** Human label for a filter slug (header pill, titles). */
function tagLabel(tag) {
  if (tag === 'pc') return 'PC';
  if (tag === 'mobile') return 'Mobile';
  if (MADE_LABELS[tag]) return MADE_LABELS[tag];
  if (TAG_LABELS[tag]) return TAG_LABELS[tag];
  return tag;
}

function chipHtml(tag, label, extraClass = '') {
  const cls = `tag-chip${extraClass ? ' ' + extraClass : ''}${tag === activeTag ? ' active' : ''}`;
  return `<button type="button" class="${cls}" data-tag="${escapeHtml(tag)}" title="Show ${escapeHtml(label)} games">${escapeHtml(label)}</button>`;
}

/** Strict mobile filter: platforms must include "mobile"; untagged → out. */
function filterGames(games, mobileOnly) {
  let list = games;
  if (activeTag) list = list.filter((g) => gameTags(g).includes(activeTag));
  if (!mobileOnly) return list;
  return list.filter((g) =>
    Array.isArray(g.admin_tags)
      ? g.admin_tags.includes('mobile')
      : Array.isArray(g.platforms) && g.platforms.includes('mobile'),
  );
}

/** Sort by the current mode, then (when searching) exact matches before fuzzy ones. */
function visibleGames(mode, mobileOnly) {
  // Liked view: every liked game, ignoring tag / mobile / search filters.
  if (activeLiked) return likedGamesOrdered(sortGames(allGames, mode));
  const sorted = sortGames(filterGames(allGames, mobileOnly), mode);
  if (!searchWords(activeSearch).length) return sorted;
  return searchGames(sorted, activeSearch, searchFields).list;
}

function deepLinkIdFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('g') || params.get('game') || '';
  } catch (_) {
    return '';
  }
}

function publicUrlFor(id = '', { liked = false } = {}) {
  const current = new URL(window.location.href);
  const u = new URL(PUBLIC_SITE_ORIGIN);
  u.pathname = current.pathname;
  // ?liked=1 is per-device, so it goes in history URLs but never in share links.
  if (liked && activeLiked) u.searchParams.set('liked', '1');
  if (activeTag) u.searchParams.set('tag', activeTag);
  if (activeSearch) u.searchParams.set('search', activeSearch);
  if (id) u.searchParams.set('g', id);
  return u;
}

function shareUrlFor(id) {
  return publicUrlFor(id).toString();
}

/**
 * URL for history.pushState/replaceState: same params as publicUrlFor, but always on
 * this page's own origin. Cross-origin pushState throws, so on hosts that are not in
 * SITES (android.omgithub.com app wrapper, previews) history would get no entries.
 * On known hosts this equals shareUrlFor.
 */
function historyUrlFor(id = '') {
  const u = publicUrlFor(id, { liked: true });
  const here = new URL(window.location.href);
  u.protocol = here.protocol;
  u.host = here.host;
  return u.toString();
}

function syncCanonicalUrl(id = '') {
  const canonical = document.querySelector('link[rel="canonical"]');
  const ogUrl = document.querySelector('meta[property="og:url"]');
  // Game pages: one main copy on games.omgithub.com. Home: this site itself.
  const url = id ? gameCanonicalUrl(id) : `${SITE.origin}/`;
  if (canonical) canonical.href = url;
  if (ogUrl) ogUrl.content = url;
}

function currentGameId() {
  return cards()[activeIndex]?.dataset.id || '';
}

function syncUrlForGame(id) {
  if (!id || restoring || historySilent) return;
  const next = historyUrlFor(id);
  try {
    // Card changes never push: Back skips previous games (it closes overlays, undoes
    // filter toggles, else leaves the page). Replace keeps ?g= current for share and
    // reload, and keeps whatever entry is on top (overlay/filter) as it is.
    if (!feedHistorySeeded || next !== window.location.href) {
      history.replaceState({ ...(history.state || {}), g: id }, '', next);
      feedHistorySeeded = true;
    }
  } catch (_) {
    // Cross-origin history changes are not allowed; sharing still uses next.
  }
  syncCanonicalUrl(id);
}

function pushOverlayHistory(kind) {
  if (historySilent) return;
  const id = currentGameId();
  try {
    history.pushState({ opus: kind, g: id }, '', window.location.href);
  } catch (_) {}
}

/** Back closes the top layer (comments/create) or undoes a filter toggle; card changes add no entries. */
function onHistoryPop() {
  const state = history.state || {};
  if (commentsOpen && state.opus !== 'comments') {
    closeCommentsSheet();
  }
  if (createOpen && state.opus !== 'create') {
    closeCreateSheet();
  }
  if (adminOpen && state.opus !== 'admin') {
    closeAdminEdit();
  }
  if (state.opus) return;
  const urlLiked = likedFromUrl();
  if (urlLiked !== activeLiked) {
    applyLikedFilter(urlLiked, { fromHistory: true, landId: state.g || deepLinkIdFromUrl() });
    return;
  }
  const urlSearch = searchFromUrl();
  if (urlSearch !== activeSearch) {
    activeSearch = urlSearch;
    syncSearchUI();
    if (tagFromUrl() === activeTag) {
      historySilent = true;
      try {
        renderFeed(readSortMode(), readMobileOnly(), { restore: false, landId: state.g || '' });
      } finally {
        historySilent = false;
      }
      return;
    }
  }
  const urlTag = tagFromUrl();
  if (urlTag !== activeTag) {
    applyTagFilter(urlTag, { fromHistory: true, landId: state.g || deepLinkIdFromUrl() });
    return;
  }
  // Plain entry (an overlay was popped): stay on the current game and refresh this
  // entry's ?g= (it may be stale if cards changed while the overlay was open).
  syncUrlForGame(currentGameId());
}

function dismissCommentsSheet() {
  if (history.state && history.state.opus === 'comments') {
    history.back();
    return;
  }
  closeCommentsSheet();
}

function wireHistoryNavigation() {
  window.addEventListener('popstate', onHistoryPop);
}

function cards() {
  return feedEl.querySelectorAll('.card');
}

function endCardEl() {
  return feedEl.querySelector('.end-card');
}

/** The end card is a manual-scroll destination, not a game in the feed. */
function endCardIsActive() {
  const end = endCardEl();
  if (!end || !feedEl.clientHeight) return false;
  return Math.abs(feedEl.scrollTop - end.offsetTop) < feedEl.clientHeight * 0.2;
}

function syncEndCardPlayback() {
  const list = cards();
  if (slidesOf(list[list.length - 1]) && activeIndex === list.length - 1) {
    const held = endCardIsActive();
    if (held !== slidesEndCardHeld) {
      slidesEndCardHeld = held;
      if (held) pauseSlides();
      else resumeSlides();
    }
    return;
  }
  const lastVideo = videoOf(list[list.length - 1]);
  if (!lastVideo || activeIndex !== list.length - 1) return;

  if (endCardIsActive()) {
    lastVideo.pause();
    return;
  }

  if (lastVideo.ended) {
    try {
      lastVideo.currentTime = 0;
    } catch (_) {}
  }
  if (canStartPlayback(lastVideo)) tryPlay(lastVideo);
}

function videoOf(card) {
  return card?.querySelector('video.clip');
}

/** Transparent poster so in-app WebViews (X, etc.) don't paint their grey play icon over our screenshot. */
const BLANK_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function posterOf(card) {
  return card?.querySelector('.poster');
}

function clipBgOf(card) {
  return card?.querySelector('.clip-bg');
}
/** Block Chrome's native video long-press menu on feed clips only. */
function suppressVideoContextMenu(el) {
  if (!el || el.__ctxMenuSuppressed) return;
  el.__ctxMenuSuppressed = true;
  el.addEventListener(
    'contextmenu',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true },
  );
}

/** True only when the clip's aspect matches the card's (within 1%), so contain leaves no bars in either direction. */
function clipFillsCard(video, card) {
  const vw = video?.videoWidth || 0;
  const vh = video?.videoHeight || 0;
  if (!vw || !vh) return true;
  const cw = card?.clientWidth || 0;
  const ch = card?.clientHeight || 0;
  if (!cw || !ch) return true;
  // Wider OR narrower than the card → contain leaves bars; use letterbox + blur fill.
  return Math.abs(vw / vh / (cw / ch) - 1) <= 0.01;
}

/*
 * Blurred cover fill behind a contain-fit clip: frames of the main <video> drawn
 * into a tiny canvas (CSS blur scales it up). No second network download.
 */
const BG_CANVAS_W = 48;
const BG_FPS = 12;
const bgLoop = { card: null, raf: 0, last: 0 };

function ensureClipBg(card) {
  let bg = clipBgOf(card);
  if (bg) return bg;
  if (!videoOf(card)) return null;
  bg = document.createElement('canvas');
  bg.className = 'clip-bg';
  bg.setAttribute('aria-hidden', 'true');
  card.insertBefore(bg, card.firstChild);
  return bg;
}

/** Draw the current clip frame, cover-cropped to the card aspect. */
function drawClipBg(card) {
  const video = videoOf(card);
  const bg = clipBgOf(card);
  if (!video || !bg || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return false;
  const cw = card.clientWidth || 1;
  const ch = card.clientHeight || 1;
  const w = BG_CANVAS_W;
  const h = Math.max(1, Math.round((BG_CANVAS_W * ch) / cw));
  if (bg.width !== w) bg.width = w;
  if (bg.height !== h) bg.height = h;
  const ctx = bg.getContext('2d', { alpha: false });
  if (!ctx) return false;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  try {
    ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } catch (_) {
    return false;
  }
  return true;
}

function stopBgLoop(card) {
  if (card && bgLoop.card !== card) return;
  if (bgLoop.raf) cancelAnimationFrame(bgLoop.raf);
  bgLoop.raf = 0;
  bgLoop.card = null;
}

function startBgLoop(card) {
  if (bgLoop.card === card && bgLoop.raf) return;
  stopBgLoop();
  bgLoop.card = card;
  bgLoop.last = 0;
  const tick = (t) => {
    if (bgLoop.card !== card) return;
    const video = videoOf(card);
    if (!card.classList.contains('letterbox') || !video || video.paused || video.ended) {
      stopBgLoop(card);
      return;
    }
    bgLoop.raf = requestAnimationFrame(tick);
    if (t - bgLoop.last < 1000 / BG_FPS) return;
    bgLoop.last = t;
    if (drawClipBg(card)) setBgReady(card);
  };
  bgLoop.raf = requestAnimationFrame(tick);
}

function setBgReady(card) {
  if (card.classList.contains('bg-ready')) return;
  card.classList.add('bg-ready');
  const poster = posterOf(card);
  if (poster && card.classList.contains('video-ready')) poster.classList.add('hidden');
}

function teardownClipBg(card) {
  if (!card) return;
  stopBgLoop(card);
  card.classList.remove('bg-ready');
  clipBgOf(card)?.remove();
}

function syncBgPlayback(card) {
  const video = videoOf(card);
  if (!video || !clipBgOf(card) || !card.classList.contains('letterbox')) return;
  if (!video.paused && !video.ended) {
    startBgLoop(card);
  } else {
    stopBgLoop(card);
    if (drawClipBg(card)) setBgReady(card);
  }
}

function markBgReady(card) {
  if (!clipBgOf(card) || !card.classList.contains('letterbox')) return;
  if (drawClipBg(card)) setBgReady(card);
  syncBgPlayback(card);
}

/**
 * Active card only: if the clip is wider than the card, contain the foreground
 * and play one blurred cover copy behind it. Inactive cards stay cover-only.
 */
function syncLetterbox(card, isActive) {
  if (!card) return;
  const video = videoOf(card);
  // Old portrait cover mode: never letterbox / blur fill.
  if (!letterboxFitEnabled() || !isActive || !video) {
    card.classList.remove('letterbox');
    teardownClipBg(card);
    return;
  }
  if (!video.videoWidth || !video.videoHeight) {
    // Metadata not ready yet — keep current mode until loadedmetadata.
    return;
  }
  if (clipFillsCard(video, card)) {
    card.classList.remove('letterbox');
    teardownClipBg(card);
    return;
  }

  card.classList.add('letterbox');
  if (!ensureClipBg(card)) return;
  markBgReady(card);
}

function syncAllLetterbox() {
  const list = cards();
  list.forEach((card, i) => {
    syncLetterbox(card, i === activeIndex);
  });
}

function bufferedAhead(video) {
  if (!video || !video.buffered || video.buffered.length === 0) return 0;
  try {
    const t = video.currentTime || 0;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      if (t >= start - 0.05 && t <= end + 0.05) return Math.max(0, end - t);
      if (start > t) return 0;
    }
    const last = video.buffered.end(video.buffered.length - 1);
    return Math.max(0, last - t);
  } catch (_) {
    return 0;
  }
}

function hasEnoughBuffer(video) {
  if (!video) return false;
  if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) return true;
  if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && bufferedAhead(video) >= BUFFER_AHEAD_SEC) {
    return true;
  }
  return bufferedAhead(video) >= BUFFER_AHEAD_SEC;
}

function canStartPlayback(video) {
  return video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

function isPlaying(video) {
  return Boolean(video && !video.paused && !video.ended && video.readyState > 2);
}

function setPosterVisible(card, visible) {
  if (!card) return;
  card.classList.toggle('video-ready', !visible);
  if (!visible) {
    card.dataset.played = '1';
    if (loadRotate?.card === card) stopLoadRotate({ toClip: true });
  }
  const poster = posterOf(card);
  if (!poster) return;
  // Letterbox: keep poster as blurred cover fill until the bg clip is ready.
  const keepAsFill =
    !visible &&
    card.classList.contains('letterbox') &&
    !card.classList.contains('bg-ready');
  poster.classList.toggle('hidden', !visible && !keepAsFill);
}

function attachSrc(video, { high = false } = {}) {
  if (!video) return;
  video.muted = effectiveMuted();
  const url = video.dataset.src;
  if (!url) return;
  if (video.getAttribute('src') === url) return;
  video.preload = 'auto';
  try {
    video.setAttribute('fetchpriority', high ? 'high' : 'low');
  } catch (_) {}
  video.src = url;
  try {
    video.load();
  } catch (_) {}
}

function detachSrc(video) {
  if (!video) return;
  if (!video.getAttribute('src') && !video.src) return;
  video.pause();
  video.removeAttribute('src');
  video.preload = 'none';
  try {
    video.load();
  } catch (_) {}
  const card = video.closest('.card');
  if (card) {
    card.classList.remove('letterbox');
    teardownClipBg(card);
  }
  setPosterVisible(card, true);
}

function tryPlay(video) {
  if (!video) return;
  video.muted = effectiveMuted();
  const p = video.play();
  if (p?.catch) {
    p.catch(() => {
      // Prefer sound, but retry muted when autoplay policy blocks it. Do not
      // persist this temporary fallback: the first gesture restores audio.
      const card = video.closest('.card');
      const isActive = Number(card?.dataset.index) === activeIndex;
      if (!isActive || mutedPreference || userGestureUnlocked || autoplayFallbackMuted) return;
      autoplayFallbackMuted = true;
      applyMuteState();
      const retry = video.play();
      if (retry?.catch) retry.catch(() => {});
    });
  }
}

function onVideoPlaying(video) {
  const card = video.closest('.card');
  const isActive = Number(card?.dataset.index) === activeIndex;
  syncLetterbox(card, isActive);
  setPosterVisible(card, false);
  if (isActive) syncBgPlayback(card);
  maybeAdvancePipeline();
}

function onVideoCanPlay(video) {
  const card = video.closest('.card');
  const idx = Number(card?.dataset.index);
  if (idx === activeIndex) tryPlay(video);
  maybeAdvancePipeline();
}

function onVideoProgress(video) {
  maybeAdvancePipeline();
}

function onVideoEnded(video) {
  const card = video.closest('.card');
  const idx = Number(card?.dataset.index);
  if (idx !== activeIndex) return;
  if (document.visibilityState === 'hidden') return;
  if (commentsOpen || autoAdvancePaused) return;
  if (video.paused && !video.ended) return;

  const dur = Number(video.duration);
  const finite = Number.isFinite(dur) && dur > 0;

  // Long enough (or unknown): advance on first natural end.
  if (!finite || dur >= MIN_WATCH_BEFORE_ADVANCE) {
    advanceToNext();
    return;
  }

  // Short clip: loop until cumulative watch ≥ threshold.
  const id = card?.dataset.id || accumGameId;
  if (accumGameId !== id) {
    resetWatchAccum(id);
  }
  watchAccumSec += dur;
  if (watchAccumSec >= MIN_WATCH_BEFORE_ADVANCE) {
    advanceToNext();
    return;
  }
  try {
    video.currentTime = 0;
  } catch (_) {}
  tryPlay(video);
}

function advanceToNext() {
  if (document.visibilityState === 'hidden') return;
  if (commentsOpen || autoAdvancePaused) return;
  const list = cards();
  const next = activeIndex + 1;
  if (next >= list.length) {
    // Stop on the last game. The end card is intentionally manual-scroll only.
    return;
  }
  scrollToIndex(next, { smooth: true });
}

function wireVideo(video) {
  if (!video || videoListeners.has(video)) return;
  video.muted = effectiveMuted();
  const onPlaying = () => onVideoPlaying(video);
  const onCanPlay = () => onVideoCanPlay(video);
  const onProgress = () => onVideoProgress(video);
  const onEnded = () => onVideoEnded(video);
  const onMeta = () => {
    const card = video.closest('.card');
    if (!card) return;
    syncLetterbox(card, Number(card.dataset.index) === activeIndex);
  };
  const onTimeUpdate = () => {
    const card = video.closest('.card');
    if (card && Number(card.dataset.index) === activeIndex) syncBgPlayback(card);
  };
  const onWaiting = () => {
    const card = video.closest('.card');
    if (card && Number(card.dataset.index) === activeIndex && video.readyState < 2) {
      setPosterVisible(card, true);
    }
  };
  video.addEventListener('playing', onPlaying);
  const onActiveFirstFrame = () => {
    const card = video.closest('.card');
    if (card && Number(card.dataset.index) === activeIndex) openFirstFrameGate();
  };
  video.addEventListener('playing', onActiveFirstFrame);
  video.addEventListener('error', onActiveFirstFrame);
  video.addEventListener('canplay', onCanPlay);
  video.addEventListener('canplaythrough', onCanPlay);
  video.addEventListener('progress', onProgress);
  video.addEventListener('ended', onEnded);
  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('timeupdate', onTimeUpdate);
  // Paused/first frame: paint the blurred canvas fill once data is decodable.
  video.addEventListener('loadeddata', onTimeUpdate);
  video.addEventListener('waiting', onWaiting);
  videoListeners.set(video, {
    onPlaying,
    onCanPlay,
    onProgress,
    onEnded,
    onMeta,
    onTimeUpdate,
    onWaiting,
  });
}

/* ---------- Screenshot-only cards: slideshow ---------- */

/** Slideshow of the active screenshot card (only one runs at a time). */
let slideshow = null;
/** Finger/mouse held on the active screenshot card. */
let slideHold = false;
/** Paused by Play / Download like a clip's video.pause(). */
let slidesMediaPaused = false;
/** End card scrolled into view below the last (screenshot) card. */
let slidesEndCardHeld = false;

function slidesOf(card) {
  return card?.querySelector('.slides') || null;
}

function slideDuration(n) {
  return n > 1 ? SLIDE_MS : SINGLE_SLIDE_MS;
}

/** Attach the image (and blurred fill) for slide i if it is still deferred. */
function loadSlide(card, i, { high = false } = {}) {
  const slide = card?.querySelectorAll('.slide')[i];
  if (!slide) return;
  const img = slide.querySelector('.slide-img');
  if (img && !img.getAttribute('src') && img.dataset.src) {
    img.fetchPriority = high ? 'high' : 'low';
    img.src = img.dataset.src;
  }
  const fill = slide.querySelector('.slide-fill');
  if (fill && fill.dataset.bg && !fill.style.backgroundImage) {
    fill.style.backgroundImage = `url("${fill.dataset.bg}")`;
  }
}

function restartClass(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // restart CSS animation
  el.classList.add(cls);
}

function showSlide(card, i) {
  const slides = card.querySelectorAll('.slide');
  slides.forEach((s, k) => {
    s.classList.toggle('on', k === i);
    if (k === i) restartClass(s, 'kb');
  });
  // Keep the outgoing slide's motion running through the crossfade.
  const keep = i;
  setTimeout(() => {
    slides.forEach((s, k) => {
      if (k !== keep && !s.classList.contains('on')) s.classList.remove('kb');
    });
  }, SLIDE_FADE_MS + 50);
  card.querySelectorAll('.slide-progress i').forEach((seg, k) => {
    seg.classList.toggle('done', k < i);
    if (k === i) restartClass(seg, 'run');
    else seg.classList.remove('run');
  });
  loadSlide(card, i, { high: Number(card.dataset.index) === activeIndex && i === 0 });
  afterFirstFrame(() => loadSlide(card, i + 1)); // preload the next screenshot
}

function slidesBlocked() {
  return (
    document.visibilityState === 'hidden' ||
    slideHold ||
    slidesMediaPaused ||
    slidesEndCardHeld
  );
}

function stopSlides() {
  if (!slideshow) return;
  clearTimeout(slideshow.timer);
  const { card } = slideshow;
  card.classList.remove('slides-paused');
  card.querySelectorAll('.slide').forEach((s, k) => {
    s.classList.toggle('on', k === 0);
    s.classList.remove('kb');
  });
  card.querySelectorAll('.slide-progress i').forEach((seg) => seg.classList.remove('run', 'done'));
  slideshow = null;
}

function runSlides() {
  const s = slideshow;
  if (!s || s.timer) return;
  if (slidesBlocked()) {
    s.card.classList.add('slides-paused');
    return;
  }
  s.card.classList.remove('slides-paused');
  s.t0 = performance.now();
  s.timer = setTimeout(onSlideTimer, Math.max(0, s.remaining));
}

function pauseSlides() {
  const s = slideshow;
  if (!s) return;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = 0;
    s.remaining = Math.max(0, s.remaining - (performance.now() - s.t0));
  }
  s.card.classList.add('slides-paused');
}

function resumeSlides() {
  if (!slideshow || slidesBlocked()) return;
  runSlides();
}

/** Start (or restart, when the card is re-entered) the active card's slideshow. */
function startSlides(card) {
  stopSlides();
  const n = card.querySelectorAll('.slide').length;
  if (!n) return;
  slideshow = { card, n, i: 0, remaining: slideDuration(n), t0: 0, timer: 0 };
  showSlide(card, 0);
  runSlides();
}

function onSlideTimer() {
  const s = slideshow;
  if (!s) return;
  s.timer = 0;
  if (s.i < s.n - 1) {
    s.i += 1;
    s.remaining = slideDuration(s.n);
    showSlide(s.card, s.i);
    runSlides();
    return;
  }
  onSlidesEnded();
}

/** Last screenshot done: advance exactly like a clip's `ended`, else loop. */
function onSlidesEnded() {
  const s = slideshow;
  const idx = Number(s.card.dataset.index);
  const canAdvance =
    idx === activeIndex &&
    document.visibilityState !== 'hidden' &&
    !commentsOpen &&
    !autoAdvancePaused &&
    activeIndex + 1 < cards().length;
  if (canAdvance) {
    advanceToNext();
    return;
  }
  // Not allowed to move on yet (comments open, Play suppressed, last game):
  // keep cycling like a short looping clip.
  s.i = 0;
  s.remaining = slideDuration(s.n);
  showSlide(s.card, 0);
  runSlides();
}

/** Active screenshot card runs its slideshow; everything else is stopped. */
function syncSlides() {
  const card = cards()[activeIndex];
  if (!slidesOf(card)) {
    stopSlides();
    return;
  }
  if (slideshow?.card !== card) {
    slidesMediaPaused = false;
    startSlides(card);
  }
}

/** Pause whatever the active card shows (clip or slideshow), e.g. before Play. */
function pauseActiveMedia() {
  const video = videoOf(cards()[activeIndex]);
  if (video) {
    video.pause();
    return;
  }
  slidesMediaPaused = true;
  pauseSlides();
}

/** Resume the active card (clip: tryPlay; slideshow: continue its timer). */
function resumeActiveMedia() {
  const video = videoOf(cards()[activeIndex]);
  if (video) {
    tryPlay(video);
    return;
  }
  slidesMediaPaused = false;
  resumeSlides();
}

/* ---------- Clip cards: rotate screenshots while the clip loads ---------- */

/** { card, i (0 = poster, k = extra k-1), timer, loadTimer } for the active clip card. */
let loadRotate = null;

function loadSlidesOf(card) {
  return card?.querySelector('.load-slides') || null;
}

function loadSlideReady(slide) {
  const img = slide?.querySelector('.slide-img');
  return Boolean(img && img.getAttribute('src') && img.complete && img.naturalWidth > 0);
}

/** Lazily attach one extra screenshot (never more than the next one). */
function loadExtra(card, k) {
  const slide = loadSlidesOf(card)?.querySelectorAll('.slide')[k];
  if (!slide) return;
  const img = slide.querySelector('.slide-img');
  if (img && !img.getAttribute('src') && img.dataset.src) img.src = img.dataset.src;
  const fill = slide.querySelector('.slide-fill');
  if (fill && fill.dataset.bg && !fill.style.backgroundImage) {
    fill.style.backgroundImage = `url("${fill.dataset.bg}")`;
  }
}

function stopLoadRotate({ toClip = false } = {}) {
  const r = loadRotate;
  if (!r) return;
  loadRotate = null;
  clearTimeout(r.timer);
  clearTimeout(r.loadTimer);
  const { card } = r;
  const layer = loadSlidesOf(card);
  const showing = layer?.querySelector('.slide.on');
  const reset = () => {
    layer?.querySelectorAll('.slide').forEach((s) => s.classList.remove('on', 'kb'));
    card.classList.remove('load-rotated');
  };
  if (toClip && showing && card.classList.contains('load-rotated')) {
    // Clip fades in over the current screenshot, then the layer is cleared.
    setTimeout(() => {
      if (loadRotate?.card !== card) reset();
    }, SLIDE_FADE_MS + 100);
  } else {
    reset();
  }
}

function loadRotateTick() {
  const r = loadRotate;
  if (!r) return;
  r.timer = setTimeout(loadRotateTick, SLIDE_MS);
  if (r.card.classList.contains('video-ready')) return stopLoadRotate({ toClip: true });
  // Same pause rules as slideshow cards: hold, hidden tab, overlays, Play.
  if (slidesBlocked()) return;
  const slides = loadSlidesOf(r.card).querySelectorAll('.slide');
  const n = slides.length + 1;
  const next = (r.i + 1) % n;
  // Only move to an extra screenshot once it has actually loaded.
  if (next > 0 && !loadSlideReady(slides[next - 1])) {
    loadExtra(r.card, next - 1);
    return;
  }
  r.i = next;
  slides.forEach((s, k) => {
    const on = k === next - 1;
    s.classList.toggle('on', on);
    if (on) restartClass(s, 'kb');
  });
  if (next > 0) r.card.classList.add('load-rotated');
  // Prefetch only the following extra.
  if (next < slides.length) loadExtra(r.card, next);
}

/**
 * Active clip card that cannot play yet: rotate poster + screenshots every
 * SLIDE_MS. Never advances the feed; stops once the clip has frames, and never
 * restarts on a mid-play stall (card.dataset.played).
 */
function syncLoadSlides() {
  const card = cards()[activeIndex];
  if (loadRotate && loadRotate.card !== card) stopLoadRotate();
  cards().forEach((c, i) => {
    if (i !== activeIndex && c.dataset.played) delete c.dataset.played;
  });
  if (!card || !loadSlidesOf(card) || loadRotate?.card === card) return;
  if (card.classList.contains('video-ready') || card.dataset.played) return;
  loadRotate = { card, i: 0, timer: 0, loadTimer: 0 };
  // Give the clip request a head start before fetching the first extra
  // (only fetched at all if the clip still isn't playing by then).
  loadRotate.loadTimer = setTimeout(() => loadExtra(card, 0), LOAD_EXTRA_DELAY_MS);
  loadRotate.timer = setTimeout(loadRotateTick, SLIDE_MS);
}

function windowEnd() {
  return Math.min(activeIndex + PRELOAD_WINDOW - 1, cards().length - 1);
}

/**
 * Sliding window + chained preload:
 * - Only indices [activeIndex .. activeIndex+4] may have src.
 * - Attach current immediately; advance tip only when prior card is playing
 *   or has ~2–3s buffered / canplaythrough.
 */
function maybeAdvancePipeline() {
  const list = cards();
  if (!list.length) return;

  const maxTip = windowEnd();

  // Ensure current always has src and tries to play.
  const curVideo = videoOf(list[activeIndex]);
  if (curVideo) {
    attachSrc(curVideo, { high: true });
    if (canStartPlayback(curVideo)) tryPlay(curVideo);
    if (isPlaying(curVideo) || curVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      pipelineTip = Math.max(pipelineTip, activeIndex);
    }
  }

  // Screenshot-only card as current: nothing to buffer, so the chain may grow.
  if (!curVideo) pipelineTip = Math.max(pipelineTip, activeIndex);

  // Grow tip forward while prior is ready enough (cards without a clip count as ready).
  // First load: nothing else downloads until the active clip shows a frame.
  while (pipelineTip < maxTip && firstFrameOpen) {
    const tip = Math.max(pipelineTip, activeIndex);
    const tipVideo = videoOf(list[tip]);
    const ready =
      !tipVideo ||
      (tip === activeIndex
        ? isPlaying(tipVideo) || canStartPlayback(tipVideo)
        : hasEnoughBuffer(tipVideo) || isPlaying(tipVideo));

    if (!ready && tip > activeIndex) break;
    if (tipVideo && tip === activeIndex && !isPlaying(tipVideo) && !canStartPlayback(tipVideo)) {
      // Still waiting on current — don't open further slots yet,
      // but current already has src above.
      break;
    }

    const next = tip + 1;
    if (next > maxTip) break;
    const nextVideo = videoOf(list[next]);
    if (nextVideo) attachSrc(nextVideo);
    pipelineTip = next;

    // Only open one new slot per readiness gate; loop continues if that
    // slot is already buffered (e.g. after scroll back) or has no clip.
    if (nextVideo && !hasEnoughBuffer(nextVideo) && !isPlaying(nextVideo)) break;
  }
  syncMediaWindow();

  // Detach anything outside the sliding window.
  list.forEach((card, i) => {
    const video = videoOf(card);
    if (!video) return;
    if (i < activeIndex || i > maxTip) {
      detachSrc(video);
    } else if (i <= pipelineTip) {
      attachSrc(video);
    }
  });
}

function syncActivePlayback() {
  const list = cards();
  list.forEach((card, i) => {
    const video = videoOf(card);
    if (!video) return;
    if (i === activeIndex) {
      syncLetterbox(card, true);
      if (video.getAttribute('src') || video.src) {
        if (canStartPlayback(video)) tryPlay(video);
        if (isPlaying(video)) setPosterVisible(card, false);
      }
      syncBgPlayback(card);
    } else {
      syncLetterbox(card, false);
      video.pause();
      try {
        if (video.getAttribute('src')) video.currentTime = 0;
      } catch (_) {}
      if (!isPlaying(video)) setPosterVisible(card, true);
    }
  });
}

function rememberActiveGame() {
  const list = cards();
  const card = list[activeIndex];
  const id = card?.dataset.id;
  if (!id) return;
  writeLastId(id);
  syncUrlForGame(id);
}

/* ---------- First-load priority: first-frame gate + media window ---------- */

/** Clip cards: first extra loading screenshot only if still not playing by then. */
const LOAD_EXTRA_DELAY_MS = 3000;
/** Gate opens on the active clip's first 'playing', or after these timeouts. */
const FIRST_FRAME_STILL_TIMEOUT_MS = 3000;
const FIRST_FRAME_CLIP_TIMEOUT_MS = 8000;
/** Posters/fills/slide 0 attached for activeIndex-2 .. activeIndex+2 (+ chain tip). */
const MEDIA_BEHIND = 2;
const MEDIA_AHEAD = 2;

let firstFrameOpen = false;
let firstFrameTimer = 0;
const afterFirstFrameQueue = [];

/** Run fn once the active clip has its first frame (or the gate timed out). */
function afterFirstFrame(fn) {
  if (firstFrameOpen) {
    fn();
    return;
  }
  afterFirstFrameQueue.push(fn);
}

function openFirstFrameGate() {
  if (firstFrameOpen) return;
  firstFrameOpen = true;
  clearTimeout(firstFrameTimer);
  firstFrameTimer = 0;
  const queued = afterFirstFrameQueue.splice(0);
  for (const fn of queued) {
    try {
      fn();
    } catch (_) {}
  }
  try {
    maybeAdvancePipeline();
  } catch (_) {}
}

function armFirstFrameGate() {
  if (firstFrameOpen || firstFrameTimer) return;
  const card = cards()[activeIndex];
  if (!card) return;
  const ms = videoOf(card) ? FIRST_FRAME_CLIP_TIMEOUT_MS : FIRST_FRAME_STILL_TIMEOUT_MS;
  firstFrameTimer = setTimeout(openFirstFrameGate, ms);
}

/** Attach a card's poster + blurred fill (or slideshow slide 0). Idempotent. */
function hydrateCardMedia(card, high) {
  if (!card) return;
  if (!card.dataset.mediaOn) {
    card.dataset.mediaOn = '1';
    const poster = card.querySelector('img.poster');
    if (poster && !poster.getAttribute('src') && poster.dataset.src) {
      poster.fetchPriority = high ? 'high' : 'low';
      poster.src = poster.dataset.src;
    }
    const fill = card.querySelector('.poster-fill');
    if (fill && fill.dataset.bg && !fill.style.backgroundImage) {
      fill.style.backgroundImage = `url("${fill.dataset.bg}")`;
    }
    if (card.querySelector('.slides')) loadSlide(card, 0, { high });
  }
  if (firstFrameOpen && !card.dataset.avatarOn) {
    card.dataset.avatarOn = '1';
    const avatar = card.querySelector('img.avatar-img');
    if (avatar && !avatar.getAttribute('src') && avatar.dataset.src) avatar.src = avatar.dataset.src;
  }
}

/** Active card always; neighbors (and the next chained clip) after the first frame. */
function syncMediaWindow() {
  const list = cards();
  if (!list.length) return;
  hydrateCardMedia(list[activeIndex], true);
  if (!firstFrameOpen) return;
  const lo = Math.max(0, activeIndex - MEDIA_BEHIND);
  const hi = Math.min(list.length - 1, Math.max(activeIndex + MEDIA_AHEAD, Math.min(pipelineTip + 1, windowEnd())));
  for (let i = lo; i <= hi; i++) hydrateCardMedia(list[i], false);
}

function setActiveIndex(next) {
  const list = cards();
  if (!list.length) return;
  const clamped = Math.max(0, Math.min(next, list.length - 1));
  const changed = clamped !== activeIndex;
  activeIndex = clamped;
  const card = list[activeIndex];
  const id = card?.dataset.id || '';
  if (changed) {
    // Reset tip to current so the chain rebuilds from the new card.
    pipelineTip = activeIndex - 1;
    // Fresh accum for the newly active card; leaving cancels the prior one.
    resetWatchAccum(id);
  } else if (accumGameId !== id) {
    resetWatchAccum(id);
  }
  if (id) {
    markSeen(id);
    analytics.cardEnter(id);
  }
  const warmEnd = Math.min(activeIndex + PLAY_NAV_PRELOAD_WINDOW - 1, list.length - 1);
  const warmUrls = [];
  for (let i = activeIndex; i <= warmEnd; i++) warmUrls.push(list[i]?.dataset.url);
  // Play-destination prefetch never competes with the first clip.
  afterFirstFrame(() => warmUrls.forEach(warmPlayNavigation));
  syncMediaWindow();
  armFirstFrameGate();
  syncActivePlayback();
  syncSlides();
  syncLoadSlides();
  maybeAdvancePipeline();
  if (changed) rememberActiveGame();
}

function currentIndexFromScroll() {
  const list = cards();
  if (!list.length) return 0;
  const top = feedEl.scrollTop;
  let best = 0;
  let bestDist = Infinity;
  list.forEach((c, i) => {
    const d = Math.abs(c.offsetTop - top);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

function initialsFrom(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return s.slice(0, 2).toUpperCase();
}

function hueFrom(name) {
  let h = 0;
  const s = String(name || 'x');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}


function formatCompact(n) {
  const x = Math.max(0, Math.floor(Number(n) || 0));
  if (x < 1000) return String(x);
  if (x < 10_000) {
    const s = (x / 1000).toFixed(1);
    return `${s.replace(/\.0$/, '')}k`;
  }
  if (x < 1_000_000) return `${Math.round(x / 1000)}k`;
  const s = (x / 1_000_000).toFixed(1);
  return `${s.replace(/\.0$/, '')}M`;
}

function remoteLikesOf(game) {
  const n = Number(game?.remote_likes);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}


/** Display count = remote_likes + 1 if locally liked (responsive before Overheard fills data). */
function displayLikeCount(game) {
  return remoteLikesOf(game) + (isLiked(game?.id) ? 1 : 0);
}

/** Normalize Overheard comments array (objects with text/author/likes/…). */
function commentsOf(game) {
  if (!Array.isArray(game?.comments)) return [];
  return game.comments.filter((c) => c && typeof c === 'object');
}

/**
 * Bubble count: the catalog's real reply/comment total on the source post
 * (comment_count). The fetched sample can include nested replies, so never
 * show fewer than the comments we actually have. 0 only when no data.
 */
function commentCount(game) {
  const listed = commentsOf(game).length;
  const n = Number(game?.comment_count);
  const total = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  return Math.max(total, listed);
}

/** Prefer local /avatars path from Overheard; else initials (no remote hotlink). */
function resolveCommentAvatarUrl(comment) {
  const raw = typeof comment?.avatar_url === 'string' ? comment.avatar_url.trim() : '';
  if (raw && isLocalAvatarPath(raw)) return raw;
  return null;
}

function sortedComments(game) {
  return commentsOf(game)
    .slice()
    .sort((a, b) => (Number(b.likes) || 0) - (Number(a.likes) || 0));
}

function commentRowHtml(comment) {
  const author = String(comment.author || 'anon').replace(/^@/, '').trim() || 'anon';
  const display = `@${author}`;
  const text = String(comment.text || '').trim();
  const likes = Math.max(0, Math.floor(Number(comment.likes) || 0));
  const initials = initialsFrom(author);
  const hue = hueFrom(author);
  const avatarUrl = resolveCommentAvatarUrl(comment);
  const avatarSrc = avatarSources(avatarUrl);
  const avatar = avatarUrl
    ? `<img class="cmt-avatar-img" src="${escapeHtml(avatarSrc.src)}"${avatarSrc.alt ? ` data-alt-src="${escapeHtml(avatarSrc.alt)}"` : ''} alt="" width="36" height="36" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(initials)}" data-hue="${hue}" />`
    : `<span class="cmt-avatar-fallback" style="--hue:${hue}" aria-hidden="true">${escapeHtml(initials)}</span>`;
  const url = typeof comment.url === 'string' ? comment.url.trim() : '';
  const safeUrl = url && httpUrl(url) ? url : '';
  const openAttrs = safeUrl
    ? ` role="link" tabindex="0" data-url="${escapeHtml(safeUrl)}"`
    : '';
  return `
    <div class="cmt-row${safeUrl ? ' cmt-row-link' : ''}"${openAttrs}>
      <span class="cmt-avatar">${avatar}</span>
      <div class="cmt-body">
        <div class="cmt-meta">
          <span class="cmt-author">${escapeHtml(display)}</span>
          <span class="cmt-likes" aria-label="${likes} likes">♥ ${escapeHtml(formatCompact(likes))}</span>
        </div>
        <p class="cmt-text">${escapeHtml(text) || '<span class="cmt-empty-text">…</span>'}</p>
      </div>
    </div>
  `;
}

function renderCommentsList(game) {
  if (!commentsListEl) return;
  const list = sortedComments(game);
  if (!list.length) {
    const total = commentCount(game);
    const src = typeof game?.source_post_url === 'string' && httpUrl(game.source_post_url) ? game.source_post_url : '';
    if (total > 0) {
      commentsListEl.innerHTML = `
      <div class="cmt-empty">
        <p>${escapeHtml(formatCompact(total))} ${total === 1 ? 'reply' : 'replies'} on the original post</p>
        ${src ? `<p class="cmt-empty-sub"><a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">Open the post</a></p>` : ''}
      </div>`;
      return;
    }
    commentsListEl.innerHTML = `
      <div class="cmt-empty">
        <p>No comments yet</p>
        <p class="cmt-empty-sub">Pulls in from X finds on the next Overheard scan.</p>
      </div>`;
    return;
  }
  commentsListEl.innerHTML = list.map(commentRowHtml).join('');
  commentsListEl.querySelectorAll('.cmt-avatar-img').forEach((img) => {
    wireAvatarFallback(img, () => {
      const fallback = document.createElement('span');
      fallback.className = 'cmt-avatar-fallback';
      fallback.style.setProperty('--hue', img.dataset.hue || '260');
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = img.dataset.fallback || '?';
      img.replaceWith(fallback);
    });
  });
  commentsListEl.querySelectorAll('.cmt-row-link').forEach((row) => {
    const open = () => {
      const u = row.dataset.url;
      if (u) window.open(u, '_blank', 'noopener,noreferrer');
    };
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      open();
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });
}

function setCommentsSheetOffset(py) {
  if (!commentsSheetEl) return;
  const panel = commentsSheetEl.querySelector('.comments-panel');
  if (!panel) return;
  const y = Math.max(0, py);
  panel.style.transform = y ? `translateY(${y}px)` : '';
  panel.style.transition = y ? 'none' : '';
}

function openCommentsSheet(game) {
  if (!commentsSheetEl || !commentsListEl) return;
  commentsOpen = true;
  autoAdvancePaused = true;
  const n = commentCount(game);
  if (commentsTitleEl) {
    commentsTitleEl.textContent = n ? `Comments · ${formatCompact(n)}` : 'Comments';
  }
  renderCommentsList(game);
  commentsSheetEl.hidden = false;
  commentsSheetEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('comments-open');
  setCommentsSheetOffset(0);
  // Next frame for enter animation
  requestAnimationFrame(() => {
    commentsSheetEl.classList.add('open');
  });
  pushOverlayHistory('comments');
}

function closeCommentsSheet() {
  if (!commentsSheetEl || !commentsOpen) return;
  commentsOpen = false;
  commentsSheetEl.classList.remove('open');
  document.body.classList.remove('comments-open');
  setCommentsSheetOffset(0);
  commentsSheetEl.setAttribute('aria-hidden', 'true');
  const panel = commentsSheetEl.querySelector('.comments-panel');
  const done = () => {
    if (commentsOpen) return;
    commentsSheetEl.hidden = true;
    if (commentsListEl) commentsListEl.innerHTML = '';
    // Resume auto-advance eligibility for the active card.
    autoAdvancePaused = false;
  };
  if (panel) {
    panel.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 320);
  } else {
    done();
  }
}

/* ---- Create a game sheet (bottom ＋) → omgithub.com composer ---- */
const CREATE_ORIGIN = 'https://omgithub.com/';
const createSheetEl = document.getElementById('createSheet');
const createPromptEl = document.getElementById('createPrompt');
const createSendEl = document.getElementById('createSend');
let createOpen = false;

/** Same encoding as omgithub's promptLoginReturn: base64url(utf8), no padding. */
function encodeLoginPrompt(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function createUrlFor(text) {
  const u = new URL(CREATE_ORIGIN);
  u.searchParams.set('loginPrompt', encodeLoginPrompt(text));
  u.searchParams.set('autostart', '1');
  u.searchParams.set('from', 'feed');
  return u.toString();
}

function syncCreateSend() {
  if (!createSendEl || !createPromptEl) return;
  const text = createPromptEl.value.trim();
  createSendEl.setAttribute('aria-disabled', text ? 'false' : 'true');
  createSendEl.classList.toggle('disabled', !text);
  createSendEl.href = text ? createUrlFor(text) : CREATE_ORIGIN;
}

/** Keep the panel above the on-screen keyboard (fixed bottom sits under it on mobile). */
const CREATE_WARP_OPEN_MS = 600;

/* AiGameMaker app (v2.0.4+) keyboard sync: the app pushes the keyboard height every
 * frame as --kb (px) on <html> and sets html.kb-anim while it animates. Once --kb is
 * seen, html.app-kb locks the feed + sheet to the keyboard-less height (--app-h) so the
 * WebView resize can't snap them, and the composer rides translate: 0 -var(--kb) with
 * no transition. Plain web (no --kb ever set) keeps the visualViewport path. */
let appKbOn = false;
let appKbResync = () => {};
function wireAppKeyboard() {
  const root = document.documentElement;
  const kbPx = () => parseFloat(root.style.getPropertyValue('--kb')) || 0;
  let lastH = '';
  let lastPx = 0;
  // --app-h must never stay below the real window: a stale lock clipped the bottom of
  // the feed (Play) when the app's --kb was non-zero while the WebView grew (late
  // layout, rotation, insets). Growth is never the keyboard, so always accept it, and
  // only hold a shrink while the composer is open and the keyboard is up/animating.
  const syncAppH = () => {
    const px = window.innerHeight;
    const kbBusy = kbPx() > 0 || root.classList.contains('kb-anim');
    if (px < lastPx && createOpen && kbBusy) return;
    const h = `${px}px`;
    lastPx = px;
    if (h !== lastH) { lastH = h; root.style.setProperty('--app-h', h); }
  };
  appKbResync = () => { if (appKbOn) syncAppH(); };
  const check = () => {
    if (!appKbOn && root.style.getPropertyValue('--kb') !== '') {
      appKbOn = true;
      syncAppH();
      root.classList.add('app-kb');
      createSheetEl?.style.removeProperty('--kb');
    }
    if (appKbOn) syncAppH();
  };
  check();
  new MutationObserver(check).observe(root, { attributes: true, attributeFilter: ['style', 'class'] });
  window.addEventListener('resize', () => { if (appKbOn) syncAppH(); });
}

function syncCreateKeyboard() {
  if (!createSheetEl) return;
  if (appKbOn) {
    // The app drives --kb on <html> every frame; don't shadow it on the sheet.
    createSheetEl.style.removeProperty('--kb');
    return;
  }
  const vv = window.visualViewport;
  const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  createSheetEl.style.setProperty('--kb', `${Math.round(kb)}px`);
}

/* Warm omgithub.com so Send opens the composer fast. Connections and the HTTP cache
 * are partitioned by top-level site: this pays off from games.omgithub.com (same site
 * as omgithub.com); from lolgames.net only the server-side edge warm-up applies, so
 * there we skip the asset prefetch (it would just download twice). */
const sameSiteAsOmgithub = /(^|\.)omgithub\.com$/.test(location.hostname);
let omgithubConnectAt = 0;
let omgithubAssetsWarmed = false;
function addHeadLink(rel, href, extra) {
  const l = document.createElement('link');
  l.rel = rel;
  l.href = href;
  if (extra) Object.assign(l, extra);
  document.head.appendChild(l);
  return l;
}
function warmOmgithub() {
  // Preconnect without crossorigin = the credentialed pool the navigation and the
  // page's same-origin module script use. Re-hint after ~8s (idle sockets close).
  const now = Date.now();
  if (now - omgithubConnectAt > 8000) {
    omgithubConnectAt = now;
    addHeadLink('preconnect', CREATE_ORIGIN.replace(/\/$/, ''));
  }
  if (omgithubAssetsWarmed || !sameSiteAsOmgithub) return;
  omgithubAssetsWarmed = true;
  fetch('/omgithub-preload.json', { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      (d?.assets || []).forEach((u) => {
        if (typeof u === 'string' && u.startsWith(CREATE_ORIGIN + 'assets/')) addHeadLink('prefetch', u);
      });
    })
    .catch(() => { omgithubAssetsWarmed = false; });
}

/* Create-sheet extras (typewriter, chips, Send ripple, warp) — small, so inlined. */
let createFx = null;
let createLaunching = false;
function loadCreateFx() {
  if (!createFx && createSheetEl && createPromptEl && createSendEl) {
    createFx = attachCreateFx({
      sheet: createSheetEl,
      prompt: createPromptEl,
      send: createSendEl,
      getTitle: () => allGames.find((g) => g.id === currentGameId())?.title || '',
      onFill: () => { syncCreateSend(); warmOmgithub(); },
    });
  }
  return createFx;
}

function openCreateSheet() {
  if (!createSheetEl || createOpen) return;
  warmOmgithub();
  loadCreateFx()?.open();
  if (commentsOpen) closeCommentsSheet();
  createOpen = true;
  autoAdvancePaused = true;
  createSheetEl.hidden = false;
  createSheetEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('comments-open', 'create-open');
  syncCreateSend();
  // Focus inside the tap so mobile browsers open the keyboard.
  try { createPromptEl?.focus({ preventScroll: true }); } catch (_) {}
  requestAnimationFrame(() => createSheetEl.classList.add('open'));
  syncCreateKeyboard();
  pushOverlayHistory('create');
}

function closeCreateSheet() {
  if (!createSheetEl || !createOpen) return;
  createOpen = false;
  appKbResync();
  createFx?.close();
  createLaunching = false;
  createSendEl?.classList.remove('launching');
  createSendEl?.removeAttribute('aria-label');
  createPromptEl?.blur();
  createSheetEl.classList.remove('open');
  document.body.classList.remove('comments-open', 'create-open');
  createSheetEl.setAttribute('aria-hidden', 'true');
  const panel = createSheetEl.querySelector('.comments-panel');
  const done = () => {
    if (createOpen) return;
    createSheetEl.hidden = true;
    autoAdvancePaused = false;
  };
  if (panel) {
    panel.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 320);
  } else {
    done();
  }
}

function dismissCreateSheet() {
  if (history.state && history.state.opus === 'create') {
    history.back();
    return;
  }
  closeCreateSheet();
}

function wireCreateSheet() {
  const btn = document.getElementById('createGame');
  if (!btn || !createSheetEl || !createPromptEl || !createSendEl) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { navigator.vibrate?.(10); } catch (_) {}
    btn.classList.remove('bounce');
    void btn.offsetWidth;
    btn.classList.add('bounce');
    btn.classList.remove('glow');
    openCreateSheet();
  });
  // Start warming on first touch/hover of ＋, before the click lands.
  const warmAll = () => { warmOmgithub(); };
  btn.addEventListener('pointerdown', warmAll, { passive: true });
  btn.addEventListener('pointerenter', warmAll, { passive: true });
  btn.addEventListener('animationend', () => btn.classList.remove('bounce'));
  // One soft glow ring per session to hint at ＋ (skipped under reduced motion).
  try {
    if (!sessionStorage.getItem('opus-feed-plus-glow')) {
      sessionStorage.setItem('opus-feed-plus-glow', '1');
      if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        setTimeout(() => btn.classList.add('glow'), 2500);
        setTimeout(() => btn.classList.remove('glow'), 2500 + 3300);
      }
    }
  } catch (_) {}
  createSheetEl.querySelectorAll('[data-close-create]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissCreateSheet();
    });
  });
  createPromptEl.addEventListener('input', () => { syncCreateSend(); warmOmgithub(); });
  createPromptEl.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissCreateSheet();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      createSendEl.click();
    }
  });
  // Send with the keyboard open: on touch the tap first blurs the textarea, the
  // keyboard closes and the sheet drops, so the button leaves the finger and the
  // click never fires (or lands elsewhere). Keep focus through the press and send
  // on the touch's pointerup (a user activation, so window.open is still allowed);
  // the click that may follow is swallowed so it can't open a second tab.
  let sendTap = null;
  let sendTapAt = 0;
  const keepPromptFocus = (e) => {
    if (document.activeElement === createPromptEl) e.preventDefault();
  };
  createSendEl.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    keepPromptFocus(e);
    sendTap = e.pointerType === 'mouse' ? null : { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  createSendEl.addEventListener('mousedown', keepPromptFocus);
  createSendEl.addEventListener('pointercancel', () => { sendTap = null; });
  createSendEl.addEventListener('pointerup', (e) => {
    const tap = sendTap;
    sendTap = null;
    if (!tap || tap.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 16) return;
    sendTapAt = Date.now();
    doCreateSend(e);
  });
  createSendEl.addEventListener('click', (e) => {
    if (Date.now() - sendTapAt < 1000) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    doCreateSend(e);
  });
  function doCreateSend(e) {
    e.stopPropagation();
    const text = createPromptEl.value.trim();
    if (!text) {
      e.preventDefault();
      createPromptEl.focus();
      return;
    }
    // window.open inside the tap (no popup blocker). 'noopener' but NOT 'noreferrer':
    // omgithub auto-start checks document.referrer's origin (page policy is
    // strict-origin-when-cross-origin, so only the origin is sent).
    e.preventDefault();
    if (createLaunching) return;
    const url = createUrlFor(text);
    createSendEl.href = url;
    const finish = () => {
      createPromptEl.value = '';
      syncCreateSend();
      dismissCreateSheet();
    };
    // AiGameMaker WebView: no multi-window, so window.open just navigates this same
    // WebView, and the history.back() of dismissCreateSheet() then cancelled it. Pop the
    // sheet's 'create' entry first, then navigate in place once we're back on the feed
    // entry (so Back from omgithub lands on the feed, sheet closed, same game).
    // location.assign sends the feed origin as referrer, like window.open did.
    if (inAiGameMakerApp()) {
      createPromptEl.value = '';
      syncCreateSend();
      const hadEntry = history.state?.opus === 'create';
      closeCreateSheet();
      let gone = false;
      const go = () => {
        if (gone) return;
        gone = true;
        window.removeEventListener('popstate', go);
        window.location.assign(url);
      };
      if (!hadEntry) { go(); return; }
      window.addEventListener('popstate', go);
      // Fallback if popstate never comes: neutralize the entry and go anyway.
      setTimeout(() => {
        if (gone) return;
        try { history.replaceState({ g: currentGameId() }, '', window.location.href); } catch (_) {}
        go();
      }, 400);
      history.back();
      return;
    }
    // Plain path: no effects (reduced motion / not loaded) → open synchronously.
    if (!createFx?.motion) {
      window.open(url, '_blank', 'noopener');
      setTimeout(finish, 0);
      return;
    }
    // Warp jump, then open while the tap's transient activation is still valid
    // (Chrome/Firefox ~5s, Safari ~1s) so popup blocking doesn't trigger.
    createLaunching = true;
    createSendEl.classList.add('launching');
    createSendEl.setAttribute('aria-label', 'Launching…');
    createPromptEl.blur();
    const warp = createFx.warp(text);
    setTimeout(() => window.open(url, '_blank', 'noopener'), CREATE_WARP_OPEN_MS);
    warp.then(() => setTimeout(finish, 120));
  }
  window.visualViewport?.addEventListener('resize', () => { if (createOpen) syncCreateKeyboard(); });
  window.visualViewport?.addEventListener('scroll', () => { if (createOpen) syncCreateKeyboard(); });
}

function wireCommentsSheet() {
  if (!commentsSheetEl) return;
  commentsSheetEl.querySelectorAll('[data-close-comments]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissCommentsSheet();
    });
  });

  const panel = commentsSheetEl.querySelector('.comments-panel');
  const grab = commentsSheetEl.querySelector('.comments-grab') || panel;
  if (!panel || !grab) return;

  const onStart = (clientY) => {
    commentsSwipeActive = true;
    commentsSwipeStartY = clientY;
    commentsSwipeCurrentY = 0;
  };
  const onMove = (clientY) => {
    if (!commentsSwipeActive || commentsSwipeStartY == null) return;
    const dy = clientY - commentsSwipeStartY;
    commentsSwipeCurrentY = dy;
    if (dy > 0) setCommentsSheetOffset(dy);
  };
  const onEnd = () => {
    if (!commentsSwipeActive) return;
    commentsSwipeActive = false;
    const dy = commentsSwipeCurrentY;
    commentsSwipeStartY = null;
    commentsSwipeCurrentY = 0;
    if (panel) panel.style.transition = '';
    if (dy > 90) {
      dismissCommentsSheet();
    } else {
      setCommentsSheetOffset(0);
    }
  };

  grab.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button != null && e.button !== 0) return;
      onStart(e.clientY);
      try {
        grab.setPointerCapture(e.pointerId);
      } catch (_) {}
    },
    { passive: true },
  );
  grab.addEventListener(
    'pointermove',
    (e) => {
      if (!commentsSwipeActive) return;
      onMove(e.clientY);
    },
    { passive: true },
  );
  grab.addEventListener('pointerup', onEnd);
  grab.addEventListener('pointercancel', onEnd);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && commentsOpen) {
      e.preventDefault();
      closeCommentsSheet();
    }
  });
}

/**
 * Prefer same-origin / relative avatar_url (e.g. /avatars/...), else GitHub png, else null → initials.
 */
function isLocalAvatarPath(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  if (u.startsWith('/') && !u.startsWith('//')) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return true;
  try {
    const parsed = new URL(u, window.location.origin);
    return parsed.origin === window.location.origin;
  } catch (_) {
    return false;
  }
}

/**
 * Catalog avatars (/avatars/<file>) are published to R2 by publish_catalog.sh,
 * so new ones need no site deploy: load from the R2 media base first and fall
 * back to the site's own /avatars copy. Returns { src, alt }.
 */
function avatarSources(url) {
  const u = String(url || '').trim();
  const m = u.match(/^\/?avatars\/([^/?#]+)$/i);
  if (m) return { src: `${MEDIA_BASE}avatars/${m[1]}`, alt: `/avatars/${m[1]}` };
  return { src: u, alt: '' };
}

/** On error: try the alternate (site) copy once, then call giveUp(). */
function wireAvatarFallback(img, giveUp) {
  img.addEventListener('error', () => {
    const alt = img.dataset.altSrc;
    if (alt && img.getAttribute('src') !== alt) {
      img.dataset.altSrc = '';
      img.src = alt;
      return;
    }
    giveUp();
  });
}

function resolveAvatarUrl(game) {
  const raw = typeof game?.avatar_url === 'string' ? game.avatar_url.trim() : '';
  if (raw && isLocalAvatarPath(raw)) return raw;
  const gh = String(game?.github_user || '')
    .replace(/^@/, '')
    .trim();
  if (/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(gh)) {
    return `https://github.com/${gh}.png?size=80`;
  }
  return null;
}


const SOURCE_URL_FIELDS = [
  'source_url',
  'sourceUrl',
  'listing_url',
  'listingUrl',
  'found_url',
  'foundUrl',
  'x_url',
  'twitter_url',
  'url',
  'page_url',
];

const X_RESERVED_HANDLES = new Set([
  'i', 'intent', 'share', 'home', 'explore', 'search', 'settings',
  'messages', 'notifications', 'compose', 'login', 'signup',
]);

function sourceUrlsFor(game) {
  return SOURCE_URL_FIELDS
    .map((field) => game?.[field])
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
}

function httpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch (_) {
    return null;
  }
}

/**
 * Warm an external game's Play destination without embedding or navigating to
 * it. Link hints are intentionally kept for the life of the page so scroll,
 * filter, and sort changes cannot spam the same origin or URL.
 */
function warmPlayNavigation(value) {
  const url = httpUrl(value);
  if (!url) return;

  const origin = url.origin;
  if (!warmedPlayOrigins.has(origin)) {
    warmedPlayOrigins.add(origin);

    const dns = document.createElement('link');
    dns.rel = 'dns-prefetch';
    dns.href = origin;
    document.head.appendChild(dns);

    const preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = origin;
    document.head.appendChild(preconnect);
  }

  // Fragments do not change the HTML request, so normalize them out for
  // deduplication while preserving query parameters used by the game.
  url.hash = '';
  const href = url.href;
  if (warmedPlayUrls.has(href)) return;
  warmedPlayUrls.add(href);

  const prefetch = document.createElement('link');
  prefetch.rel = 'prefetch';
  prefetch.href = href;
  prefetch.setAttribute('fetchpriority', 'low');
  document.head.appendChild(prefetch);
}

function socialHandleFromUrl(value, hosts) {
  const url = httpUrl(value);
  if (!url || !hosts.has(url.hostname.toLowerCase())) return '';
  const handle = url.pathname.split('/').filter(Boolean)[0] || '';
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) && !X_RESERVED_HANDLES.has(handle.toLowerCase())
    ? handle
    : '';
}

/** Pick the place this game was found, keeping X ahead of GitHub. */
function authorUrlFor(game) {
  const sourceUrls = sourceUrlsFor(game);
  // Prefer the original post itself (X status, Reddit thread, HN item) over a profile.
  const postUrl = [game?.likes_source_url, ...sourceUrls].map((v) => httpUrl(v)).find((u) => u && (
    (/(^|\.)(x|twitter)\.com$/i.test(u.hostname) && /\/status\/\d+/.test(u.pathname)) ||
    (/(^|\.)reddit\.com$/i.test(u.hostname) && /\/comments\//.test(u.pathname)) ||
    (/^news\.ycombinator\.com$/i.test(u.hostname) && u.searchParams.get('id'))
  ));
  if (postUrl) return postUrl.toString();
  const xHosts = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
  const explicitX = String(game?.x_handle || '').replace(/^@/, '').trim();
  const xHandle = /^[A-Za-z0-9_]{1,15}$/.test(explicitX) && !X_RESERVED_HANDLES.has(explicitX.toLowerCase())
    ? explicitX
    : sourceUrls.map((url) => socialHandleFromUrl(url, xHosts)).find(Boolean) || '';
  if (xHandle) return `https://x.com/${encodeURIComponent(xHandle)}`;

  const githubUser = String(game?.github_user || '').replace(/^@/, '').trim();
  if (/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(githubUser)) {
    return `https://github.com/${encodeURIComponent(githubUser)}`;
  }

  const githubUrl = sourceUrls.find((value) => {
    const url = httpUrl(value);
    return url && /^(www\.)?github\.com$/i.test(url.hostname);
  });
  if (githubUrl) return githubUrl;

  return sourceUrls.map((value) => httpUrl(value)?.toString() || '').find(Boolean) || '';
}

/** Comparable form of a link: no hash, no trailing slash, lowercase host. */
function linkKey(value) {
  const u = httpUrl(value);
  if (!u) return '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

/** "Game page" credit link (page_url) unless it repeats Play or the author link. */
function gamePageUrlFor(game, authorUrl) {
  const key = linkKey(game?.page_url);
  if (!key) return '';
  if (key === linkKey(game.play_url) || (authorUrl && key === linkKey(authorUrl))) return '';
  return httpUrl(game.page_url).toString();
}

function authorRowHtml(game) {
  const row = authorRowInnerHtml(game);
  // Dedupe against the author link only when the row (and so that link) is shown.
  const pageUrl = gamePageUrlFor(game, row ? authorUrlFor(game) : '');
  if (!pageUrl) return row;
  const link = `<a class="game-page-link" href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener" aria-label="Game page: ${escapeHtml(game.title || '')}">Game page ↗</a>`;
  return `<div class="author-row">${row}${link}</div>`;
}

function authorRowInnerHtml(game) {
  const name = game.author || game.github_user || game.x_handle || '';
  if (!name) return '';
  const display = game.github_user
    ? `@${game.github_user}`
    : game.x_handle
      ? `@${game.x_handle}`
      : name;
  const initials = initialsFrom(name);
  const hue = hueFrom(name);
  const avatarUrl = resolveAvatarUrl(game);
  const avatarSrc = avatarSources(avatarUrl);
  const avatar = avatarUrl
    ? `<img class="avatar-img" data-src="${escapeHtml(avatarSrc.src)}"${avatarSrc.alt ? ` data-alt-src="${escapeHtml(avatarSrc.alt)}"` : ''} alt="" width="36" height="36" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(initials)}" data-hue="${hue}" />`
    : `<span class="avatar-fallback" style="--hue:${hue}" aria-hidden="true">${escapeHtml(initials)}</span>`;
  const authorUrl = authorUrlFor(game);
  const tag = authorUrl ? 'a' : 'div';
  const linkAttrs = authorUrl
    ? ` href="${escapeHtml(authorUrl)}" target="_blank" rel="noopener" aria-label="Open ${escapeHtml(display)}"`
    : '';
  return `
    <${tag} class="author${authorUrl ? ' author-link' : ''}"${linkAttrs}>
      <span class="avatar">${avatar}</span>
      <span class="author-name">${escapeHtml(display)}</span>
    </${tag}>
  `;
}

function showToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.hidden = false;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    toastEl.hidden = true;
  }, 1800);
}

async function shareGame(game) {
  const url = shareUrlFor(game.id);
  const title = game.title || SITE.name;
  const text = `Play ${title} on ${SITE.name}`;
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (err) {
      // User cancel → quiet exit; other errors fall through to clipboard.
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied');
  } catch (_) {
    // Last resort: prompt-less fallback via temp input
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Link copied');
    } catch (_) {
      showToast('Could not copy link');
    }
  }
}

function buildEndCard() {
  const card = document.createElement('section');
  card.className = 'end-card';
  card.setAttribute('aria-labelledby', 'endCardTitle');
  if (activeLiked) {
    card.innerHTML = `
    <div class="end-card-content">
      <p class="end-card-eyebrow">Liked ♥</p>
      <h2 id="endCardTitle">That’s all your liked games</h2>
      <p class="end-card-copy">Tap ♥ on more games to add them here.</p>
      <button type="button" class="discover-more liked-exit">Show all games</button>
    </div>
  `;
    card.querySelector('.liked-exit')?.addEventListener('click', () => applyLikedFilter(false));
    return card;
  }
  card.innerHTML = `
    <div class="end-card-content">
      <p class="end-card-eyebrow">You’re all caught up</p>
      <h2 id="endCardTitle">You're up to date</h2>
      <p class="end-card-copy">That’s everything for today. Come back soon for more games.</p>
      <a class="discover-more" href="https://omgithub.com/" target="_blank" rel="noopener noreferrer">
        Discover more games
      </a>
    </div>
  `;
  return card;
}

/** Screenshot-only card media: stacked slides (first eager, rest deferred) + progress. */
function slidesHtml(urls) {
  const n = urls.length;
  const slides = urls
    .map((u, i) => {
      const url = escapeHtml(u);
      // All slides deferred; the media window attaches slide 0 near the viewport.
      const fill = `data-bg="${url}"`;
      const img = `data-src="${url}"`;
      return `<div class="slide${i === 0 ? ' on' : ''}"><div class="slide-fill" aria-hidden="true" ${fill}></div><img class="slide-img" ${img} alt="" decoding="async" draggable="false" /></div>`;
    })
    .join('');
  const progress = n > 1
    ? `<div class="slide-progress" aria-hidden="true">${'<i><b></b></i>'.repeat(n)}</div>`
    : '';
  return `<div class="slides" style="--slide-ms:${slideDuration(n)}ms;--slide-fade-ms:${SLIDE_FADE_MS}ms">${slides}</div>${progress}`;
}

/**
 * Clip cards with extra screenshots: deferred slides stacked over the poster,
 * rotated while the clip is still loading (see syncLoadSlides).
 */
function loadSlidesHtml(game) {
  const extras = Array.isArray(game.shots) ? game.shots.filter((u) => u && u !== game.screenshot) : [];
  if (!game.video || !extras.length) return '';
  const slides = extras
    .map((u) => {
      const url = escapeHtml(u);
      return `<div class="slide"><div class="slide-fill" aria-hidden="true" data-bg="${url}"></div><img class="slide-img" data-src="${url}" alt="" decoding="async" draggable="false" /></div>`;
    })
    .join('');
  return `<div class="load-slides" aria-hidden="true" style="--slide-ms:${SLIDE_MS}ms;--slide-fade-ms:${SLIDE_FADE_MS}ms">${slides}</div>`;
}

/** Score + platform / made-with / engine / tag chips (rebuilt in place by refreshCardMeta). */
/** Engine name → chip slug ('Three.js' → 'three-js'); display names learned from the catalog. */
const engineLabels = new Map();
function engineSlug(engine) {
  return String(engine || '')
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
function learnEngineLabels(games) {
  for (const g of games) {
    const slug = engineSlug(g.engine);
    if (slug && !engineLabels.has(slug)) engineLabels.set(slug, String(g.engine));
  }
}
/** Chip label for a slug, incl. derived ones (mobile → Mobile, opus-5.5 → Opus 5.5, godot → Godot). */
function chipLabel(slug) {
  return engineLabels.get(slug) || tagLabel(slug);
}
/** Server / typed name → the feed's chip slug ('Opus 5.5' → 'opus-5.5', 'three.js' → 'three-js'). */
function canonChipTag(raw) {
  const v = admin.normalizeAdminTag(raw);
  if (!v) return '';
  if (v === 'desktop') return 'pc';
  if (v === 'touch' || v === 'phone') return 'mobile';
  if (engineLabels.has(v) || MADE_LABELS[v]) return v;
  const dashed = v.replace(/\./g, '-').replace(/-+/g, '-');
  if (engineLabels.has(dashed) || MADE_LABELS[dashed]) return dashed;
  const dotted = v.replace(/-(\d)/g, '.$1');
  if (MADE_LABELS[dotted]) return dotted; // 'opus-5-5' → 'opus-5.5'
  return v;
}
admin.setTagCanon(canonChipTag);
/** Slugs of the chips the card shows (rating excluded), in card order. */
function chipTags(game) {
  if (Array.isArray(game.admin_tags)) return game.admin_tags.slice();
  const out = [];
  const add = (t) => t && !out.includes(t) && out.push(t);
  platformTags(game.platforms).forEach(add);
  if (MADE_LABELS[String(game.made_with || '').toLowerCase()]) add(madeWithTag(game.made_with));
  if (game.engine) add(engineSlug(game.engine));
  (Array.isArray(game.tags) ? game.tags : []).forEach(add);
  return out;
}
function overrideChipsHtml(game) {
  return game.admin_tags
    .map((t) => {
      const cls = t === 'mobile' || t === 'pc' ? 'platform' : MADE_LABELS[t] ? 'made-with' : engineLabels.has(t) ? 'engine' : '';
      return chipHtml(t, chipLabel(t), cls);
    })
    .join('');
}

function badgesHtml(game) {
  if (Array.isArray(game.admin_tags)) {
    return `
        <span class="score">${escapeHtml(scoreLabel(game.admin_rating ?? game.screenshot_score))}</span>
        ${overrideChipsHtml(game)}
      `;
  }
  const platHtml = platformTags(game.platforms)
    .map((t) => chipHtml(t, tagLabel(t), 'platform'))
    .join('');

  const madeLabel = MADE_LABELS[String(game.made_with || '').toLowerCase()] || '';
  const madeTag = madeWithTag(game.made_with);
  const madeHtml = madeLabel && madeTag ? chipHtml(madeTag, madeLabel, 'made-with') : '';

  const engTag = normalizeTag(String(game.engine || '').replace(/[\s.]+/g, '-'));
  const engineHtml = game.engine
    ? `<button type="button" class="engine tag-chip${engTag && engTag === activeTag ? ' active' : ''}" data-tag="${escapeHtml(engTag)}" title="Made in ${escapeHtml(game.engine)} — tap to filter">${escapeHtml(game.engine)}</button>`
    : '';
  const tagsHtml = (Array.isArray(game.tags) ? game.tags : [])
    .map(
      (t) =>
        chipHtml(t, tagLabel(t)),
    )
    .join('');

  return `
        <span class="score">${escapeHtml(scoreLabel(game.admin_rating ?? game.screenshot_score))}</span>
        ${platHtml}
        ${madeHtml}
        ${engineHtml}
        ${tagsHtml}
      `;
}

function wireTagChips(card, game) {
  card.querySelectorAll('.tag-chip').forEach((chip) => {
    chip.addEventListener('pointerdown', (e) => e.stopPropagation());
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = chip.dataset.tag || '';
      if (t && t !== activeTag) analytics.track('tag', { game_id: game.id, tag: t });
      if (t) applyTagFilter(t === activeTag ? '' : t);
    });
  });
}

function buildCard(game, index) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.index = String(index);
  card.dataset.id = game.id;
  card.dataset.url = game.play_url;
  if (typeof game.iframe === 'boolean') card.dataset.iframe = String(game.iframe);

  const slides = !game.video && Array.isArray(game.slides) ? game.slides : null;
  if (slides) card.classList.add('slides-card');
  const screenshot = slides
    ? slidesHtml(slides)
    : game.screenshot
    ? `<div class="poster-fill" aria-hidden="true" data-bg="${escapeHtml(game.screenshot)}"></div><img class="poster ken-burns" data-src="${escapeHtml(game.screenshot)}" alt="" decoding="async" draggable="false" />${loadSlidesHtml(game)}`
    : `<div class="poster poster-fallback ken-burns" aria-hidden="true"></div>`;

  const desc = game.description
    ? `<p class="desc">${escapeHtml(game.description)}</p>`
    : '';

  const liked = isLiked(game.id);
  const likeN = displayLikeCount(game);
  const cmtN = commentCount(game);
  // Always show a compact number so empty feeds aren't confusing (0 is fine).
  const likeCountHtml = `<span class="like-count">${escapeHtml(formatCompact(likeN))}</span>`;

  card.innerHTML = `
    ${screenshot}
    ${slides ? '' : `<video
      class="clip"
      data-src="${escapeHtml(game.video)}"
      playsinline
      webkit-playsinline
      preload="none"
      poster="${BLANK_POSTER}"
      disablepictureinpicture
    ></video>`}
    ${slides ? '' : `<button type="button" class="mute-control" aria-pressed="${effectiveMuted() ? 'true' : 'false'}" aria-label="${effectiveMuted() ? 'Unmute video' : 'Mute video'}" title="${effectiveMuted() ? 'Unmute video' : 'Mute video'}">
      <svg class="icon-muted" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 9v6h4l5 4V5L8 9H4Z"/>
        <path d="M16.5 10.5a3 3 0 0 1 0 3"/>
      </svg>
      <svg class="icon-unmuted" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 9v6h4l5 4V5L8 9H4Z"/>
        <path d="M17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12"/>
      </svg>
    </button>`}
    <div class="card-body">
      <div class="badges">${badgesHtml(game)}</div>
      ${authorRowHtml(game)}
      <h2 class="title">${escapeHtml(game.title)}</h2>
      ${desc}
      ${playOrDownloadHtml(game)}
    </div>
    <div class="rail" aria-label="Actions">
      <button type="button" class="rail-btn like ${liked ? 'liked' : ''}" aria-pressed="${liked ? 'true' : 'false'}" aria-label="${liked ? 'Unlike' : 'Like'}">
        <span class="rail-icon" aria-hidden="true">
          <svg class="icon-heart" viewBox="0 0 24 24" width="28" height="28">
            <path class="heart-outline" d="M12 21s-6.7-4.35-9.33-8.1C.8 10.35 1.2 6.9 3.9 5.25 6.1 3.9 8.7 4.35 12 7.2c3.3-2.85 5.9-3.3 8.1-1.95 2.7 1.65 3.1 5.1 1.23 7.65C18.7 16.65 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
            <path class="heart-fill" d="M12 21s-6.7-4.35-9.33-8.1C.8 10.35 1.2 6.9 3.9 5.25 6.1 3.9 8.7 4.35 12 7.2c3.3-2.85 5.9-3.3 8.1-1.95 2.7 1.65 3.1 5.1 1.23 7.65C18.7 16.65 12 21 12 21z" fill="currentColor"/>
          </svg>
        </span>
        ${likeCountHtml}
      </button>
      <button type="button" class="rail-btn comments" aria-label="Comments">
        <span class="rail-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H12l-4.2 3.2c-.55.42-1.3.02-1.3-.66V15H7.5A2.5 2.5 0 0 1 5 12.5v-6Z"/>
          </svg>
        </span>
        <span class="comment-count">${escapeHtml(formatCompact(cmtN))}</span>
      </button>
      <button type="button" class="rail-btn share" aria-label="Share">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="18" cy="5" r="2.5"/>
          <circle cx="6" cy="12" r="2.5"/>
          <circle cx="18" cy="19" r="2.5"/>
          <path d="M8.4 13.2l7.2 4.2M15.6 6.6l-7.2 4.2"/>
        </svg>
      </button>
    </div>
  `;

  const muteBtn = card.querySelector('.mute-control');
  muteBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    setMutedPreference(!effectiveMuted());
  });

  wireTagChips(card, game);
  if (isAdmin) addAdminButton(card);
  if (isDownloadGame(game)) wireDownloadButton(card.querySelector('.play'), game);
  else wirePlayButton(card.querySelector('.play'), game);

  wireActiveVideoTap(card, game);

  const likeBtn = card.querySelector('.rail-btn.like');
  likeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // In the Liked view the card stays put after unlike (no re-render / scroll jump);
    // it drops out the next time the filter is entered.
    const on = toggleLike(game.id);
    if (on) analytics.track('like', { game_id: game.id });
    likeBtn.classList.toggle('liked', on);
    likeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    likeBtn.setAttribute('aria-label', on ? 'Unlike' : 'Like');
    syncLikeTotal();
    const countSpan = likeBtn.querySelector('.like-count');
    if (countSpan) {
      const n = remoteLikesOf(game) + (on ? 1 : 0);
      countSpan.textContent = formatCompact(n);
      countSpan.hidden = false;
    }
  });

  card.querySelector('.comments').addEventListener('click', (e) => {
    e.stopPropagation();
    analytics.track('comments', { game_id: game.id });
    openCommentsSheet(game);
  });

  card.querySelector('.share').addEventListener('click', (e) => {
    e.stopPropagation();
    analytics.track('share', { game_id: game.id });
    shareGame(game);
  });

  const img = card.querySelector('.avatar-img');
  if (img) {
    wireAvatarFallback(img, () => {
      const fallback = document.createElement('span');
      fallback.className = 'avatar-fallback';
      fallback.style.setProperty('--hue', img.dataset.hue || '260');
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = img.dataset.fallback || '?';
      img.replaceWith(fallback);
    });
  }

  wireVideo(videoOf(card));
  return card;
}

/** Native download (not playable in the browser). */
function isDownloadGame(game) {
  return game?.browser_playable === false && !!game?.download_url;
}

/** This device's OS slug: android, ios, windows, macos, linux. */
function deviceOs() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux|CrOS/i.test(ua)) return 'linux';
  return '';
}

const OS_LABELS = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS' };

/** True when the download offers a build for this device (unknown list → allow). */
function downloadFitsDevice(game) {
  const list = game?.download_platforms;
  if (!Array.isArray(list) || !list.length) return true;
  const os = deviceOs();
  if (!os) return true;
  if (list.includes(os)) return true;
  if (list.includes('pc') && (os === 'windows' || os === 'linux')) return true;
  return false;
}

function downloadPlatformsLabel(game) {
  const list = Array.isArray(game?.download_platforms) ? game.download_platforms : [];
  return list.map((x) => OS_LABELS[x] || (x === 'pc' ? 'PC' : x)).join(' · ');
}

function playOrDownloadHtml(game) {
  if (isDownloadGame(game)) {
    const fits = downloadFitsDevice(game);
    const plats = downloadPlatformsLabel(game);
    const label = 'Download ↓';
    const title = fits
      ? `Download for ${plats || 'your device'}`
      : `Only for ${plats} — not available on this device`;
    return `<button type="button" class="play download${fits ? '' : ' unavailable'}" data-download="${escapeHtml(game.download_url)}" aria-disabled="${fits ? 'false' : 'true'}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}: ${escapeHtml(game.title)}">${label}${plats ? `<span class="dl-plat">${escapeHtml(plats)}</span>` : ''}</button>`;
  }
  return `<button type="button" class="play" aria-label="${escapeHtml(playButtonLabel(game))} ${escapeHtml(game.title)}">${escapeHtml(playButtonLabel(game))}</button>`;
}

function playButtonLabel(game) {
  return 'Play ↗';
}

function openGame(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** The newest catalog entry for a card's game (a stale device copy may have rendered the card). */
function freshGame(game) {
  const id = game?.id || game?.dataset?.id;
  return (id && allGames.find((g) => g.id === id)) || game;
}

/**
 * Open a game's Play target. Every game opens top-level in a new tab (no in-feed iframe
 * or overlay exists). needs_isolation games (itch SharedArrayBuffer builds) must stay that
 * way: window.open + noopener only. In the AiGameMaker WebView (no multi-window) this becomes a
 * main-frame navigation the app intercepts and hands to a Chrome Custom Tab.
 */
function openPlay(game, url) {
  if (game?.needs_isolation) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  openGame(url);
}

/**
 * Short tap on the active card's video opens Play. Long-press toggles fit mode.
 * Chrome often fires pointercancel on video long-press (context-menu gesture) —
 * that must NOT cancel the hold timer, or a hold after scrolling looks like a no-op.
 */
function wireActiveVideoTap(card, game) {
  // Clip cards: the <video>. Screenshot cards: the slideshow layer.
  const video = videoOf(card) || slidesOf(card);
  if (!video) return;
  suppressVideoContextMenu(video);
  const isSlides = video.classList.contains('slides');
  // Touch on a screenshot card holds the slideshow until release.
  const releaseSlides = () => {
    if (!isSlides || !slideHold) return;
    slideHold = false;
    window.removeEventListener('pointerup', releaseSlides, true);
    window.removeEventListener('pointercancel', releaseSlides, true);
    if (slideshow?.card === card) resumeSlides();
  };
  const LONG_PRESS_MS = 450;
  let tapArmed = false; // short-tap → Play
  let holdAlive = false; // long-press timer still eligible
  let longPressFired = false;
  let holdTimer = 0;
  let startX = 0;
  let startY = 0;
  let startScroll = 0;
  let startTime = 0;

  const clearHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = 0;
    }
  };

  const cardIsCurrent = () => {
    const idx = Number(card.dataset.index);
    if (idx === activeIndex) return true;
    // After scroll, activeIndex can lag one frame behind scroll-snap.
    return idx === currentIndexFromScroll();
  };

  const fireLongPress = () => {
    if (longPressFired || !holdAlive) return;
    if (commentsOpen) return;
    if (!cardIsCurrent()) return;
    // Real scroll-away during the hold (not snap settle).
    if (Math.abs(feedEl.scrollTop - startScroll) > 48) return;
    longPressFired = true;
    holdAlive = false;
    tapArmed = false;
    clearHold();
    toggleFitMode(); // cooldown inside → exactly once
  };

  video.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (isSlides && slideshow?.card === card) {
        slideHold = true;
        pauseSlides();
        window.addEventListener('pointerup', releaseSlides, true);
        window.addEventListener('pointercancel', releaseSlides, true);
      }
      tapArmed = true;
      holdAlive = true;
      longPressFired = false;
      startX = e.clientX;
      startY = e.clientY;
      startScroll = feedEl.scrollTop;
      startTime = Date.now();
      clearHold();
      holdTimer = window.setTimeout(() => {
        holdTimer = 0;
        fireLongPress();
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );

  video.addEventListener(
    'pointermove',
    (e) => {
      if (longPressFired) return;
      if (Math.abs(e.clientX - startX) > 14 || Math.abs(e.clientY - startY) > 14) {
        // Finger dragged — treat as scroll/gesture, not hold or tap.
        holdAlive = false;
        tapArmed = false;
        clearHold();
      }
    },
    { passive: true },
  );

  // Do NOT clear the hold timer on pointercancel: mobile Chrome cancels the
  // pointer when recognizing a video long-press / context menu. The timer
  // (or pointerup fallback) still completes the fit toggle.
  video.addEventListener('pointercancel', () => {
    tapArmed = false; // cancel short-tap Play; keep holdAlive for the timer
  });

  video.addEventListener('pointerup', (e) => {
    if (longPressFired) {
      tapArmed = false;
      holdAlive = false;
      clearHold();
      return;
    }
    const heldMs = Date.now() - startTime;
    // If Chrome cancelled the timer path oddly, honor a completed hold on up.
    if (holdAlive && heldMs >= LONG_PRESS_MS) {
      fireLongPress();
      return;
    }
    clearHold();
    holdAlive = false;
    if (Math.abs(e.clientX - startX) > 14 || Math.abs(e.clientY - startY) > 14) {
      tapArmed = false;
    }
  });

  video.addEventListener('click', (e) => {
    // Long-press already toggled fit mode — never open Play on that gesture.
    if (longPressFired) {
      longPressFired = false;
      tapArmed = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!tapArmed) return;
    tapArmed = false;
    if (commentsOpen) return;
    if (!cardIsCurrent()) return;
    if (Math.abs(feedEl.scrollTop - startScroll) > 8) return;
    if (Math.abs(e.clientX - startX) > 14 || Math.abs(e.clientY - startY) > 14) return;
    e.stopPropagation();
    playGame(game);
  });
}

function playGame(gameOrUrl) {
  if (typeof gameOrUrl === 'object' && gameOrUrl) gameOrUrl = freshGame(gameOrUrl);
  const url =
    typeof gameOrUrl === 'string'
      ? gameOrUrl
      : gameOrUrl?.play_url || gameOrUrl?.dataset?.url;
  if (!url) return;
  const gid = typeof gameOrUrl === 'object' ? gameOrUrl?.id || gameOrUrl?.dataset?.id : currentGameId();
  // Every game opens in a new tab (the in-feed iframe overlay is retired).
  analytics.playStarted(gid, false);
  autoAdvancePaused = true;
  watchAccumSec = 0;
  pauseActiveMedia();
  openPlay(typeof gameOrUrl === 'object' ? gameOrUrl : null, url);
}

function wireDownloadButton(btn, game) {
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!downloadFitsDevice(game)) {
      showToast(`Only for ${downloadPlatformsLabel(game)}`);
      return;
    }
    analytics.track('download', { game_id: game.id });
    autoAdvancePaused = true;
    watchAccumSec = 0;
    pauseActiveMedia();
    openGame(game.download_url);
  });
}

/** Tap Play or hold ~450ms: opens the game in a new tab. */
function wirePlayButton(btn, game) {
  if (!btn) return;
  let holdTimer = 0;
  let held = false;
  let sx = 0;
  let sy = 0;
  const clear = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = 0;
  };
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    held = false;
    sx = e.clientX;
    sy = e.clientY;
    clear();
    holdTimer = setTimeout(() => {
      holdTimer = 0;
      held = true;
      btn.classList.add('held');
      if (navigator.vibrate) navigator.vibrate(15);
    }, 450);
  });
  // Open on release: touch pointerdown is not a user activation, so a
  // window.open from the timer would be popup-blocked.
  btn.addEventListener('pointerup', () => {
    btn.classList.remove('held');
    if (!held) return;
    const g = freshGame(game);
    const url = g?.play_url;
    if (!url) return;
    analytics.track('play_tab', { game_id: g.id });
    autoAdvancePaused = true;
    watchAccumSec = 0;
    pauseActiveMedia();
    openPlay(g, url);
  });
  btn.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - sx) > 14 || Math.abs(e.clientY - sy) > 14) clear();
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, clear));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    clear();
    if (held) {
      held = false;
      e.preventDefault();
      return;
    }
    playGame(game);
  });
}

function scrollToIndex(i, { smooth = true } = {}) {
  const list = cards();
  if (!list.length) return;
  const clamped = Math.max(0, Math.min(i, list.length - 1));
  // 'instant' (not 'auto'): CSS scroll-behavior:smooth would still animate 'auto'.
  list[clamped].scrollIntoView({
    behavior: smooth ? 'smooth' : 'instant',
    block: 'start',
  });
  setActiveIndex(clamped);
}

function scrollToEndCard({ smooth = true } = {}) {
  const end = endCardEl();
  if (!end) return false;
  end.scrollIntoView({
    behavior: smooth ? 'smooth' : 'instant',
    block: 'start',
  });
  return true;
}

function indexOfGameId(id) {
  if (!id) return -1;
  const list = cards();
  for (let i = 0; i < list.length; i++) {
    if (list[i].dataset.id === id) return i;
  }
  return -1;
}

function resolveStartIndex(resumeId = '') {
  return indexOfGameId(resumeId);
}

function wireKeyboard() {
  if (keyboardWired) return;
  keyboardWired = true;
  window.addEventListener('keydown', (e) => {
    if (commentsOpen || createOpen) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'j') {
      e.preventDefault();
      const current = currentIndexFromScroll();
      if (current >= cards().length - 1) scrollToEndCard();
      else scrollToIndex(current + 1);
      hideHint();
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'k') {
      e.preventDefault();
      scrollToIndex(currentIndexFromScroll() - 1);
      hideHint();
    } else if (e.key === 'Enter') {
      // A focused button/link handles its own Enter (Play would open twice).
      if (e.target?.closest?.('button, a[href], input, textarea, select')) return;
      const card = cards()[currentIndexFromScroll()];
      if (card?.dataset.url) {
        playGame({
          id: card.dataset.id,
          play_url: card.dataset.url,
          iframe: card.dataset.iframe === 'true' ? true : card.dataset.iframe === 'false' ? false : null,
          title: card.querySelector('.title')?.textContent || 'Play game',
        });
      }
    }
  });
}

function tearDownVideos() {
  cards().forEach((card) => {
    const video = videoOf(card);
    if (!video) return;
    video.pause();
    detachSrc(video);
  });
  stopSlides();
  stopLoadRotate();
  slidesEndCardHeld = false;
  slidesMediaPaused = false;
  pipelineTip = -1;
  activeIndex = 0;
}

function onFeedScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    setActiveIndex(currentIndexFromScroll());
    syncEndCardPlayback();
    hideHint();
  });
}

function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  hintEl?.classList.add('hide');
}

function syncSortUI(mode) {
  if (!sortEl) return;
  sortEl.querySelectorAll('[data-sort]').forEach((btn) => {
    const on = btn.dataset.sort === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function syncMobileUI(on) {
  if (!mobileFilterEl) return;
  mobileFilterEl.classList.toggle('active', on);
  mobileFilterEl.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function renderFeed(mode, mobileOnly, { restore = true, landId = '', ensureId = '' } = {}) {
  let sorted = visibleGames(mode, mobileOnly);
  // A shared ?g= link must open that game even when the tag / search / mobile
  // filter would hide it: pin it at the top of the filtered list.
  if (ensureId && !sorted.some((g) => g.id === ensureId)) {
    const linked = allGames.find((g) => g.id === ensureId);
    if (linked) sorted = [linked, ...sorted];
  }
  let games = sorted;
  const resumeId = restore && !activeLiked ? resumeIdForGames(games) : '';
  const anchorId = restore ? resumeId : landId;
  // Scroll up: already seen, oldest at the top. Scroll down: not yet seen.
  // Liked view keeps most-recently-liked order instead.
  if (!activeLiked) games = orderSeenHistoryAbove(games, anchorId);
  syncLikeTotal();

  tearDownVideos();
  feedEl.innerHTML = '';
  resetWatchAccum(null);

  if (!games.length) {
    if (mode === SORT_NEW && sorted.length) {
      feedEl.innerHTML = '';
      feedEl.appendChild(buildEndCard());
      return;
    }
    if (activeLiked) {
      feedEl.innerHTML = `<div class="empty liked-empty"><p>No liked games yet — tap ♥ on a game</p><button type="button" class="filter-btn liked-exit">Show all games</button></div>`;
      feedEl.querySelector('.liked-exit')?.addEventListener('click', () => applyLikedFilter(false));
      return;
    }
    const msg = activeSearch
      ? `No games for “${activeSearch}”${activeTag ? ` in ${tagLabel(activeTag)}` : ''}`
      : activeTag
      ? `No ${tagLabel(activeTag)} games${mobileOnly ? ' for mobile' : ''} yet`
      : mobileOnly
      ? 'No mobile games tagged yet'
      : 'No gameplay videos found.';
    feedEl.innerHTML = `<div class="empty">${escapeHtml(msg)}</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  games.forEach((g, i) => frag.appendChild(buildCard(g, i)));
  frag.appendChild(buildEndCard());
  feedEl.appendChild(frag);

  restoring = true;
  // Force instant land: assignment to scrollTop also honors CSS scroll-behavior.
  const prevScrollBehavior = feedEl.style.scrollBehavior;
  feedEl.style.scrollBehavior = 'auto';
  feedEl.scrollTop = 0;
  activeIndex = 0;
  pipelineTip = -1;

  // Land on the saved or linked game. With no target, start at the first
  // unseen card so history stays above the fold.
  const targetId = restore ? resumeId : landId;
  const start = targetId
    ? resolveStartIndex(targetId)
    : activeLiked
    ? 0
    : games.findIndex((g) => !readSeen()[g.id]);
  const startIndex = start > 0 ? start : 0;
  if (startIndex > 0) {
    // Land cleanly without animating through every card (?g= / last-seen / sort keep).
    scrollToIndex(startIndex, { smooth: false });
  } else {
    setActiveIndex(0);
    rememberActiveGame();
  }
  feedEl.style.scrollBehavior = prevScrollBehavior;
  // Allow layout to settle before re-enabling URL writes from scroll.
  requestAnimationFrame(() => {
    restoring = false;
    rememberActiveGame();
  });
}

function wireSortToggle() {
  if (!sortEl) return;
  sortEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    const mode = btn.dataset.sort === SORT_NEW ? SORT_NEW : SORT_TOP;
    // Capture before DOM wipe; land on same game in the new order (no catch-up).
    const keepId = cards()[activeIndex]?.dataset.id || readLastId();
    writeSortMode(mode);
    syncSortUI(mode);
    renderFeed(mode, readMobileOnly(), { restore: false, landId: keepId });
    hideHint();
  });
}

const tagFilterEl = document.getElementById('tagFilter');

function syncTagUI() {
  if (!tagFilterEl) return;
  tagFilterEl.hidden = !activeTag;
  tagFilterEl.textContent = activeTag ? `${tagLabel(activeTag)} ✕` : '';
  tagFilterEl.title = activeTag ? `Showing ${tagLabel(activeTag)} — tap to clear` : '';
  tagFilterEl.setAttribute('aria-label', activeTag ? `Clear tag filter ${activeTag}` : '');
}

const likedToggleEl = document.getElementById('likedToggle');

function syncLikeTotal() {
  if (!countEl) return;
  const videoCount = allGames.filter((g) => g.video).length;
  const videoLabel = `${videoCount} ${videoCount === 1 ? 'video' : 'videos'}`;
  countEl.textContent = `${catalogCount} games`;
  countEl.title = videoLabel;
  countEl.dataset.tooltip = videoLabel;
}

function syncLikedUI() {
  document.body.classList.toggle('liked-view', activeLiked);
  if (likedToggleEl) {
    likedToggleEl.classList.toggle('active', activeLiked);
    likedToggleEl.setAttribute('aria-pressed', activeLiked ? 'true' : 'false');
    const label = activeLiked ? 'Showing liked games — tap to show all' : 'Show only games you liked';
    likedToggleEl.setAttribute('aria-label', label);
    likedToggleEl.title = label;
  }
}

/**
 * Enter / leave the Liked view. Like tag filters, a change pushes one history
 * entry (back returns to the previous feed); history-driven changes don't push.
 * Entering clears the tag and search filters so the view is just your likes.
 */
function applyLikedFilter(on, { fromHistory = false, landId = '' } = {}) {
  const next = Boolean(on);
  if (next === activeLiked && !fromHistory) return;
  const keepId = landId || currentGameId() || readLastId();
  activeLiked = next;
  if (next && !fromHistory) {
    activeTag = '';
    activeSearch = '';
    searchEntryPushed = false;
    document.body.classList.remove('search-open');
  } else if (fromHistory) {
    activeTag = tagFromUrl();
    activeSearch = searchFromUrl();
  }
  syncLikedUI();
  syncTagUI();
  syncSearchUI();
  // Entering: stay on the current game if it is liked, else start at the newest like.
  const id = next ? (isLiked(keepId) || fromHistory ? keepId : '') : keepId;
  if (!fromHistory) {
    try {
      history.pushState({ g: id, liked: next ? 1 : 0 }, '', historyUrlFor(id));
    } catch (_) {}
  }
  historySilent = true;
  try {
    renderFeed(readSortMode(), readMobileOnly(), { restore: false, landId: id });
  } finally {
    historySilent = false;
  }
  syncCanonicalUrl(currentGameId());
  hideHint();
}

/**
 * Set or clear the tag filter. A new filter pushes one history entry so back
 * returns to the unfiltered feed; history-driven changes don't push.
 */
function applyTagFilter(tag, { fromHistory = false, landId = '' } = {}) {
  const next = normalizeTag(tag);
  if (next === activeTag && !fromHistory) return;
  const keepId = landId || currentGameId() || readLastId();
  activeTag = next;
  if (next && activeLiked && !fromHistory) {
    activeLiked = false;
    syncLikedUI();
  }
  syncTagUI();
  const inTag = !next || allGames.some((g) => g.id === keepId && gameTags(g).includes(next));
  const id = inTag ? keepId : '';
  if (!fromHistory) {
    try {
      const url = historyUrlFor(id);
      history.pushState({ g: id, tag: next }, '', url);
    } catch (_) {}
  }
  historySilent = true;
  try {
    renderFeed(readSortMode(), readMobileOnly(), { restore: false, landId: id });
  } finally {
    historySilent = false;
  }
  syncCanonicalUrl(currentGameId());
  hideHint();
}

const searchBtnEl = document.getElementById('searchBtn');
const searchBoxEl = document.getElementById('searchBox');
const searchInputEl = document.getElementById('searchInput');
let searchTimer = 0;
/** True while the current history entry is the search entry we pushed. */
let searchEntryPushed = false;

function syncSearchUI() {
  if (searchInputEl && document.activeElement !== searchInputEl) searchInputEl.value = activeSearch;
  const open = !!activeSearch || document.body.classList.contains('search-open');
  if (searchBoxEl) searchBoxEl.hidden = !open;
  searchBtnEl?.classList.toggle('active', !!activeSearch);
}

/** Live search: first change pushes one entry, later keystrokes replace it. */
function applySearch(q) {
  const next = String(q || '').trim().slice(0, 80);
  if (next === activeSearch) return;
  const wasEmpty = !activeSearch;
  activeSearch = next;
  if (next && activeLiked) {
    activeLiked = false;
    syncLikedUI();
  }
  const pool = visibleGames(readSortMode(), readMobileOnly());
  const first = pool[0];
  if (next) analytics.trackSearch(next, pool.length);
  const id = first?.id || '';
  try {
    const url = historyUrlFor(id);
    if (wasEmpty && next && !searchEntryPushed) {
      history.pushState({ g: id, search: next }, '', url);
      searchEntryPushed = true;
    } else {
      history.replaceState({ g: id, search: next }, '', url);
    }
  } catch (_) {}
  if (!next) searchEntryPushed = false;
  historySilent = true;
  try {
    renderFeed(readSortMode(), readMobileOnly(), { restore: false, landId: id });
  } finally {
    historySilent = false;
  }
  syncSearchUI();
  syncCanonicalUrl(currentGameId());
  hideHint();
}

function closeSearch() {
  document.body.classList.remove('search-open');
  searchInputEl?.blur();
  if (activeSearch) {
    if (searchEntryPushed && history.state && history.state.search) {
      searchEntryPushed = false;
      history.back();
    } else {
      applySearch('');
    }
  }
  syncSearchUI();
}

function wireSearch() {
  syncSearchUI();
  searchBtnEl?.addEventListener('click', () => {
    if (document.body.classList.contains('search-open') || activeSearch) {
      closeSearch();
      return;
    }
    document.body.classList.add('search-open');
    syncSearchUI();
    searchInputEl?.focus();
  });
  searchInputEl?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applySearch(searchInputEl.value), 250);
  });
  searchInputEl?.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      applySearch(searchInputEl.value);
      searchInputEl.blur();
    } else if (e.key === 'Escape') {
      closeSearch();
    }
  });
  document.getElementById('searchClear')?.addEventListener('click', closeSearch);
}

function wireTagFilter() {
  syncTagUI();
  tagFilterEl?.addEventListener('click', () => applyTagFilter(''));
  syncLikedUI();
  likedToggleEl?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyLikedFilter(!activeLiked);
  });
}

function wireMobileFilter() {
  if (!mobileFilterEl) return;
  mobileFilterEl.addEventListener('click', () => {
    const next = !readMobileOnly();
    writeMobileOnly(next);
    syncMobileUI(next);
    renderFeed(readSortMode(), next, { restore: false });
    hideHint();
  });
}

/** Apply per-domain title/name before anything else touches the DOM. */
function applySiteBranding() {
  try {
    if (document.title !== SITE.title) document.title = SITE.title;
    const logo = document.querySelector('.logo');
    if (logo && logo.textContent !== SITE.name) logo.textContent = SITE.name;
    const set = (sel, attr, value) => {
      const el = document.querySelector(sel);
      if (el && value && el.getAttribute(attr) !== value) el.setAttribute(attr, value);
    };
    set('meta[name="description"]', 'content', SITE.description);
    set('meta[property="og:title"]', 'content', SITE.title);
    set('meta[property="og:description"]', 'content', SITE.description);
    set('meta[property="og:site_name"]', 'content', SITE.name);
    set('meta[name="twitter:title"]', 'content', SITE.title);
    set('meta[name="twitter:description"]', 'content', SITE.description);
  } catch (_) {}
}

async function init() {
  applySiteBranding();
  syncCanonicalUrl(deepLinkIdFromUrl());
  let data;
  // Stale-while-revalidate: start the network fetch now, render from the device copy
  // if there is one (and it has the ?g= game), refresh silently in the background.
  const freshP = fetchCatalogFeed();
  freshP.catch(() => {});
  const linkedBoot = deepLinkIdFromUrl();
  const cached = await readCachedCatalogFeed().catch(() => null);
  const cacheUsable = cached && (!linkedBoot || cached.feed.games?.some((g) => g?.id === linkedBoot));
  let fromCache = false;
  try {
    if (cacheUsable) {
      data = cached.feed;
      fromCache = true;
    } else {
      try {
        data = (await freshP).feed;
      } catch (err) {
        if (!cached) throw err;
        data = cached.feed; // offline + linked game not cached: still show the feed
        fromCache = true;
      }
    }
  } catch (err) {
    finishLoadBar();
    feedEl.innerHTML = `<div class="empty">Failed to load catalog<br/><small>${escapeHtml(err.message)}</small></div>`;
    if (countEl) countEl.textContent = 'offline';
    return;
  }
  if (fromCache) {
    freshP.then((fresh) => { if (fresh.sig !== cached.sig) applyFreshCatalog(fresh.feed); }).catch(() => {});
  }

  // Warm CDN origin used for clips + posters (media tags don't need CORS).
  try {
    const origin = new URL(REPO_RAW_BASE).origin;
    if (!document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }
  } catch (_) {}

  catalogCount = catalogCountOf(data);

  allGames = playableGames(data);
  learnEngineLabels(allGames);
  // Admin overrides (rating/tags) from the device copy apply before the first render.
  admin.applyOverrides(allGames, admin.readCachedOverrides());

  wireAudioGesture();
  wireCommentsSheet();
  wireCreateSheet();
  wireAppKeyboard();
  wireHistoryNavigation();

  const mode = readSortMode();
  const mobileOnly = readMobileOnly();
  syncSortUI(mode);
  syncMobileUI(mobileOnly);
  wireSortToggle();
  wireMobileFilter();
  wireTagFilter();
  wireSearch();
  // ?g= wins on every boot. With ?tag= we skip last-seen resume, but must
  // still land on the linked game (it used to fall to the tag's first card).
  const linkedId = deepLinkIdFromUrl();
  renderFeed(mode, mobileOnly, {
    restore: !activeTag && !activeLiked,
    landId: activeTag || activeLiked ? linkedId : '',
    ensureId: linkedId,
  });

  wireKeyboard();
  wireVisibility();
  wireLetterboxResize();
  wireFitToggle();
  if (!scrollHintWired) {
    scrollHintWired = true;
    feedEl.addEventListener('scroll', onFeedScroll, { passive: true });
  }
  requestAnimationFrame(watchFirstCardMedia);
  // Never ahead of the first card: overrides + admin check start once it is up.
  setTimeout(startAdminBoot, 0);
}

function playableGames(data) {
  return (Array.isArray(data?.games) ? data.games : []).filter(
    (g) => (g?.video || g?.slides?.length) && g?.play_url && g?.id,
  );
}

function catalogCountOf(data) {
  const n = Number(data.catalog_count ?? data.total_games ?? data.totals?.games);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/* Fresh catalog arrived after a cached boot: swap the data in place. The cards on
 * screen stay (no re-render, no scroll); the next sort/filter/search or the next
 * open uses the fresh list. */
function applyFreshCatalog(data) {
  const games = playableGames(data);
  if (!games.length) return;
  learnEngineLabels(games);
  admin.applyOverrides(games);
  allGames = games;
  catalogCount = catalogCountOf(data);
  syncLikeTotal();
  // Cards drawn from the device copy: refresh their Play target / iframe flag in place.
  for (const card of cards()) {
    const g = games.find((x) => x.id === card.dataset.id);
    if (!g) continue;
    if (g.play_url && card.dataset.url !== g.play_url) card.dataset.url = g.play_url;
    if (typeof g.iframe === 'boolean') card.dataset.iframe = String(g.iframe);
    else delete card.dataset.iframe;
  }
}

/* ---- Admin: overrides for everyone, ✎ edit sheet for admins ---- */
let isAdmin = false;
let adminOpen = false;
const adminChains = new Map();

function startAdminBoot() {
  admin.fetchOverrides().then((map) => {
    if (!map) return;
    // Patch cards in place (no re-sort, no scroll): the current card never jumps.
    const changed = admin.applyOverrides(allGames, map);
    changed.forEach(refreshCardMeta);
    // A filter that matched nothing before the overrides (e.g. ?tag= of an admin-only tag): render now.
    if (changed.length && !cards().length && (activeTag || readMobileOnly())) {
      renderFeed(readSortMode(), readMobileOnly(), { restore: false, landId: deepLinkIdFromUrl() });
    }
  });
  admin.fetchIsAdmin().then((yes) => {
    if (!yes) return;
    isAdmin = true;
    document.documentElement.classList.add('is-admin');
    cards().forEach(addAdminButton);
  });
}

function refreshCardMeta(id) {
  const game = allGames.find((g) => g.id === id);
  if (!game) return;
  feedEl.querySelectorAll(`.card[data-id="${CSS.escape(id)}"]`).forEach((card) => {
    const badges = card.querySelector('.badges');
    if (!badges) return;
    badges.innerHTML = badgesHtml(game);
    wireTagChips(card, game);
  });
}

function addAdminButton(card) {
  const rail = card.querySelector('.rail');
  if (!rail || rail.querySelector('.admin-edit')) return;
  rail.insertAdjacentHTML('beforeend', admin.EDIT_BTN_HTML);
  rail.querySelector('.admin-edit').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openAdminEdit(card.dataset.id);
  });
}

function adminAllTags() {
  const freq = new Map();
  for (const g of allGames) for (const t of chipTags(g)) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a) || a.localeCompare(b));
}

function adminSnapshot(game) {
  return { admin_rating: game.admin_rating ?? null, tags: Array.isArray(game.admin_tags) ? game.admin_tags.slice() : null };
}

function openAdminEdit(id) {
  const game = allGames.find((g) => g.id === id);
  if (!isAdmin || !game || adminOpen) return;
  if (commentsOpen) closeCommentsSheet();
  adminOpen = true;
  autoAdvancePaused = true;
  admin.openAdminSheet({
    game,
    allTags: adminAllTags(),
    label: chipLabel,
    tagsOf: chipTags,
    onChange: (patch) => adminEdit(game, patch),
    onDismiss: dismissAdminEdit,
  });
  pushOverlayHistory('admin');
}

function closeAdminEdit() {
  if (!adminOpen) return;
  adminOpen = false;
  admin.closeAdminSheet();
  autoAdvancePaused = false;
}

function dismissAdminEdit() {
  if (history.state && history.state.opus === 'admin') {
    history.back();
    return;
  }
  closeAdminEdit();
}

/** Optimistic edit: card + in-memory game now; saves run in order; a failure reverts. */
/** Override chips in card order: Mobile, PC, model, engine, then the rest as listed. */
function chipRank(t) {
  return t === 'mobile' ? 0 : t === 'pc' ? 1 : MADE_LABELS[t] ? 2 : engineLabels.has(t) ? 3 : 4;
}
function adminEdit(game, patch) {
  if (Array.isArray(patch.tags)) {
    patch = { ...patch, tags: patch.tags.map((t, i) => [chipRank(t), i, t]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]) };
  }
  if (Array.isArray(patch.tags) && patch.tags.length > admin.MAX_TAGS) {
    showToast(`Max ${admin.MAX_TAGS} tags`);
    return;
  }
  admin.setGameFields(game, { ...adminSnapshot(game), ...patch });
  refreshCardMeta(game.id);
  admin.renderAdminSheet();
  const redraw = () => {
    // A catalog refresh may have swapped in a new object for this game since the edit.
    const cur = allGames.find((g) => g.id === game.id);
    if (cur && cur !== game) admin.applyOverrides([cur]);
    refreshCardMeta(game.id);
    if (admin.adminSheetGameId() === game.id) admin.renderAdminSheet();
  };
  const prev = adminChains.get(game.id) || Promise.resolve();
  const run = prev.then(() =>
    admin.saveGamePatch(game, patch).then((res) => {
      redraw();
      if (!res.ok) showToast(admin.saveErrorToast(res.status));
    }),
  );
  adminChains.set(game.id, run);
}

/* Loading bar until the first card's poster / slide / clip frame is on screen; then
 * the 'Swipe down' hint shows (auto-hides after 4s or on scroll). */
let loadBarDone = false;
function finishLoadBar() {
  if (loadBarDone) return;
  loadBarDone = true;
  const bar = document.getElementById('loadbar');
  if (!bar) return;
  bar.classList.add('done');
  setTimeout(() => bar.remove(), 450);
}

function revealHint() {
  if (hintHidden || !hintEl) return;
  hintEl.classList.remove('hide');
  setTimeout(hideHint, 4000);
}

function watchFirstCardMedia() {
  const card = cards()[activeIndex] || cards()[0];
  let done = false;
  const shown = () => {
    if (done) return;
    done = true;
    finishLoadBar();
    revealHint();
  };
  if (!card) { shown(); return; }
  setTimeout(shown, 10000); // never leave the bar up forever
  const imgs = [...card.querySelectorAll('img.poster, .slides .slide.on img.slide-img, .slides .slide:first-child img.slide-img')];
  const video = card.querySelector('video.clip');
  if (!imgs.length && !video) { shown(); return; }
  for (const img of imgs) {
    if (img.complete && img.naturalWidth && img.getAttribute('src')) { shown(); return; }
    img.addEventListener('load', shown, { once: true });
  }
  if (video) {
    if (video.readyState >= 2) { shown(); return; }
    video.addEventListener('loadeddata', shown, { once: true });
    video.addEventListener('playing', shown, { once: true });
  }
}

let letterboxResizeWired = false;
function wireLetterboxResize() {
  if (letterboxResizeWired) return;
  letterboxResizeWired = true;
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      syncAllLetterbox();
    });
  };
  window.addEventListener('resize', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule, { passive: true });
}

let fitToggleWired = false;
function wireFitToggle() {
  const logo = document.querySelector('.logo');
  if (!logo || fitToggleWired) return;
  fitToggleWired = true;
  logo.setAttribute('role', 'button');
  logo.setAttribute('tabindex', '0');
  logo.title = 'Tap to toggle crop / full frame';
  syncFitToggleTitle();
  const toggle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFitMode();
  };
  logo.addEventListener('click', toggle);
  logo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle(e);
    }
  });
}

let visibilityWired = false;
function wireVisibility() {
  if (visibilityWired) return;
  visibilityWired = true;
  document.addEventListener('visibilitychange', () => {
    const list = cards();
    const video = videoOf(list[activeIndex]);
    if (!video && !slideshow) return;
    if (document.visibilityState === 'hidden') {
      // Pause playback + auto-advance while backgrounded.
      if (video) video.pause();
      else pauseSlides();
    } else {
      // Stay paused while comments, create sheet or iframe Play overlay is open.
      if (commentsOpen || createOpen) return;
      // Back from background / external Play: start accum fresh if Play
      // cancelled this card, then resume playback.
      if (autoAdvancePaused) {
        watchAccumSec = 0;
        autoAdvancePaused = false;
      }
      resumeActiveMedia();
    }
  });
}

init();
