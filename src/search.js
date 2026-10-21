/**
 * Header search: accent/punctuation-insensitive matching plus a small typo-tolerant
 * fallback. No dependencies; per-game strings are folded once and cached.
 *
 *   fold('Pokémon!')  → 'pokemon'      fold('Straße') → 'strasse'
 *   'poke mon' also matches 'Pokémon' (space-insensitive "compact" form).
 *   'pokmon' / 'pokemn' / 'zelad' → fuzzy (Damerau–Levenshtein, threshold by length),
 *   only for words of 4+ chars that have no exact hit anywhere in the pool.
 */

const SPECIAL = {
  ß: 'ss', ẞ: 'ss', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe', ø: 'o', Ø: 'o',
  ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd', þ: 'th', Þ: 'th', ı: 'i', ħ: 'h', ŧ: 't',
};
const SPECIAL_RE = /[ßẞæÆœŒøØłŁđĐðÐþÞıħŧ]/g;

/** Lowercase, strip diacritics, map non-decomposable letters, punctuation → single spaces. */
export function fold(s) {
  return String(s ?? '')
    .replace(SPECIAL_RE, (c) => SPECIAL[c])
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Query → folded words (a leading @ is just punctuation and folds away). */
export function queryWords(q) {
  const f = fold(q);
  return f ? f.split(' ') : [];
}

/** Optimal-string-alignment Damerau–Levenshtein with early exit above `max`. */
export function editDistance(a, b, max = Infinity) {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2 = null;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[lb];
}

/** Typos allowed for a word of this length (short words: none). */
export function fuzzyBudget(len) {
  if (len < 4) return 0;
  if (len <= 6) return 1;
  if (len <= 10) return 2;
  return 3;
}

const cache = new WeakMap();

/**
 * Precompute per game: `core` (title/tags/author/engine), `text` (core + description),
 * `compact` (text without spaces) and `tokens` (unique 3+ char words, for fuzzy).
 */
export function indexGame(g, { core, extra }) {
  let idx = cache.get(g);
  if (idx) return idx;
  const coreText = fold(core.filter(Boolean).join(' '));
  const text = [coreText, fold(extra.filter(Boolean).join(' '))].filter(Boolean).join(' ');
  const tokens = [...new Set(text.split(' ').filter((t) => t.length >= 3))];
  const head = fold(core[0] || '');
  const coreTokens = new Set(coreText.split(' ').filter((t) => t.length >= 3));
  idx = { head: ` ${head} `, core: ` ${coreText} `, coreCompact: coreText.replace(/ /g, ''), coreTokens, text: ` ${text} `, compact: text.replace(/ /g, ''), tokens };
  cache.set(g, idx);
  return idx;
}

/** Exact tier: substring (3+ chars, space-insensitive) anywhere; 1–2 chars only as a
 *  word prefix in title/tags/author/engine so tiny queries don't match every description. */
function exactWord(idx, w) {
  if (w.length === 1) return idx.head.includes(` ${w}`); // single letter: title words only
  if (w.length === 2) return idx.core.includes(` ${w}`);
  return idx.text.includes(w) || idx.compact.includes(w);
}

/** Does word `w` hit the title/tags/author/engine part (not just the description)? */
function coreWord(idx, w) {
  if (w.length <= 2) return true; // short words already only match core
  return idx.core.includes(w) || idx.coreCompact.includes(w);
}

function fuzzyWord(idx, w, tokens = idx.tokens) {
  const max = fuzzyBudget(w.length);
  if (!max) return false;
  for (const t of tokens) {
    if (Math.abs(t.length - w.length) <= max && editDistance(w, t, max) <= max) return true;
    // Partially typed word with a typo: compare against the token's prefix.
    if (t.length > w.length) {
      for (const n of [w.length, w.length + 1]) {
        if (n <= t.length && editDistance(w, t.slice(0, n), max) <= max) return true;
      }
    }
  }
  return false;
}

/**
 * Filter + rank. Returns games in their incoming order, exact matches first then
 * fuzzy ones. A word only goes fuzzy when it has no exact hit in the whole pool,
 * so real words ("race") never pull in look-alikes ("rage").
 */
export function searchGames(games, query, fields) {
  const words = queryWords(query);
  if (!words.length) return { list: games, exact: games.length, fuzzy: 0 };
  const idxs = games.map((g) => indexGame(g, fields(g)));
  const joined = words.join('');
  const fuzzyOk = words.map(
    (w) => w.length >= 4 && !idxs.some((idx) => exactWord(idx, w) || idx.compact.includes(joined)),
  );
  // Tiers: 0 exact in title/tags/author/engine, 1 exact via description only,
  // 2 fuzzy in core fields, 3 fuzzy via description only. Order within a tier is kept.
  const tiers = [[], [], [], []];
  games.forEach((g, i) => {
    const idx = idxs[i];
    // Whole query with spaces folded ("poke mon" → "pokemon").
    if (words.length > 1 && joined.length >= 3 && idx.compact.includes(joined)) {
      tiers[idx.coreCompact.includes(joined) ? 0 : 1].push(g);
      return;
    }
    let fuzzyHit = false;
    let core = true;
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      if (exactWord(idx, w)) {
        if (!coreWord(idx, w)) core = false;
        continue;
      }
      if (fuzzyOk[k] && fuzzyWord(idx, w)) {
        fuzzyHit = true;
        if (!fuzzyWord(idx, w, idx.coreTokens)) core = false;
        continue;
      }
      return;
    }
    tiers[(fuzzyHit ? 2 : 0) + (core ? 0 : 1)].push(g);
  });
  const exact = tiers[0].concat(tiers[1]);
  const fuzzy = tiers[2].concat(tiers[3]);
  return { list: exact.concat(fuzzy), exact: exact.length, fuzzy: fuzzy.length };
}
