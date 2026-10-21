/**
 * Per-domain site config, shared by the browser app (src/main.js) and the
 * Pages advanced-mode worker (worker/index.js → dist/_worker.js).
 *
 * To add or edit a domain: change the entries below, rebuild, deploy.
 * - origin:      canonical origin for the home page of that site
 * - name:        short site name (logo, og:site_name, share text)
 * - title:       <title> / og:title / twitter:title
 * - description: meta description / og:description / twitter:description
 * - image:       absolute og:image / twitter:image URL ('' = none)
 * Hosts not listed here (pages.dev previews, localhost) use DEFAULT_HOST.
 */

/** Single main copy of every game page (?g=<id>) lives here. */
export const MAIN_ORIGIN = 'https://games.omgithub.com';
export const DEFAULT_HOST = 'games.omgithub.com';

const OMGITHUB = {
  origin: 'https://games.omgithub.com',
  name: 'AI Games Feed',
  title: 'AI Games Feed — Claude vs ChatGPT',
  description: 'Swipe through AI-made browser games.',
  image: '',
};

const LOLGAMES = {
  origin: 'https://lolgames.net',
  name: 'LOL Games',
  title: 'LOL Games – Free browser games, play instantly',
  description: 'Swipe through free browser games and play instantly, no downloads.',
  image: '',
};

export const SITES = {
  'games.omgithub.com': OMGITHUB,
  'lolgames.net': LOLGAMES,
  'www.lolgames.net': LOLGAMES,
};

/** Normalized hostname without port, lowercased. */
export function normalizeHost(host) {
  return String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

/** True when the host has its own entry (not a fallback). */
export function isKnownHost(host) {
  return Object.prototype.hasOwnProperty.call(SITES, normalizeHost(host));
}

/** Site config for a hostname; unknown hosts fall back to DEFAULT_HOST. */
export function siteFor(host) {
  const h = normalizeHost(host);
  return SITES[h] || SITES[DEFAULT_HOST];
}

/** Canonical URL of a game page: always on MAIN_ORIGIN. */
export function gameCanonicalUrl(id) {
  const u = new URL(MAIN_ORIGIN + '/');
  u.searchParams.set('g', id);
  return u.toString();
}
