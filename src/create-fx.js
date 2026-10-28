/* Create-sheet extras: typewriter placeholder, idea chips, Send ripple and the warp
 * jump on Send (CSS only). prefers-reduced-motion → plain sheet, no animation. */

// Approved suggestion lines (ideas-v2). Each ＋ open shows a fresh shuffle
// (typewriter + chips), skipping what the previous opens showed.
const POOL = [
  ["🧱", "Tetris where cleared lines become platforms you jump on"],
  ["🪝", "Flappy Bird with a grappling hook"],
  ["🧟", "Vampire Survivors, but you play the horde"],
  ["🌀", "Portal, but you can only place one portal"],
  ["👻", "Pac-Man where the ghosts learn your route each level"],
  ["🐍", "Snake that leaves walls behind instead of growing"],
  ["🏰", "Angry Birds where you build the tower your friend attacks"],
  ["🔫", "Doom with one bullet you have to pick back up"],
  ["🎵", "Geometry Dash you play by tapping to the beat"],
  ["👾", "Space Invaders where you're the invaders"],
  ["🐸", "Frogger where every car is controlled by a past run of yours"],
  ["♟️", "Chess where every capture swaps the pieces' powers"],
  ["🪙", "Super Mario where every coin makes you jump higher"],
  ["🍉", "Fruit Ninja with a combo-chaining sword"],
  ["🏓", "Breakout where the ball splits on every hit"],
  ["⚽", "1v1 Rocket League vs a bot, first to 3 goals"],
  ["⛏️", "Minecraft-style voxel island with a day and night cycle"],
  ["🏎️", "60-second Mario Kart time trial on one track"],
  ["🃏", "Mini Clash Royale with 4 cards and one lane"],
  ["🗝️", "One-room Zelda dungeon with a key and a boss"],
  ["🐞", "Hollow Knight-style boss fight in a single arena"],
  ["🚇", "Subway Surfers endless runner with three lanes"],
  ["🚓", "Top-down GTA car chase through one city block"],
  ["🌾", "Pocket Stardew Valley with a 3×3 farm and seasons"],
  ["🧗", "Celeste-style climb with dash and wall jump, 5 screens"],
  ["🦸", "Overwatch-style 1v1 arena with two heroes"],
  ["🗡️", "Hades-style room clear with three weapon choices"],
  ["🏛️", "Civilization on a tiny 10×10 map, 20 turns"],
  ["🥋", "Street Fighter duel with three special moves"],
  ["🛹", "Tony Hawk skate park with a 2-minute trick run"],
  ["🎴", "Slay the Spire deckbuilding with Pokémon catching"],
  ["🔪", "Among Us rules inside a Counter-Strike round"],
  ["🌙", "Stardew farming by day, tower defense at night"],
  ["🏠", "Tetris blocks that build your Minecraft house"],
  ["🦇", "Dark Souls bosses in a Flappy Bird cave"],
  ["🚀", "Rocket League with Mario Kart items"],
  ["🎸", "Pokémon battles decided by Guitar Hero rhythm"],
  ["🏘️", "The Sims neighborhood where every house is a Doom level"],
  ["💣", "Fortnite building inside a Worms artillery match"],
  ["💎", "Diablo loot in a Vampire Survivors run"],
];
const IDEAS = POOL.map(([, t]) => t);
const RECENT_KEY = 'opus-create-ideas-recent';
const RECENT_MAX = 24;
const readRecent = () => {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
};
const pushRecent = (items) => {
  const next = [...items, ...readRecent().filter((t) => !items.includes(t))].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch (_) {}
};
const shuffle = (a) => {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
};
/** n fresh pool entries, avoiding recently shown ones (falls back if the pool runs dry). */
const drawFresh = (n, exclude = []) => {
  const recent = new Set([...readRecent(), ...exclude]);
  const fresh = shuffle(POOL.filter(([, t]) => !recent.has(t)));
  const rest = shuffle(POOL.filter(([, t]) => recent.has(t) && !exclude.includes(t)));
  return [...fresh, ...rest].slice(0, n);
};
const CHIP_COUNT = 4;
const TYPE_COUNT = 6;
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ---------------- attach ---------------- */
export function attachCreateFx({ sheet, prompt, send, getTitle, onFill }) {
  const motion = !reduced();
  sheet.classList.add('fx');
  if (!motion) sheet.classList.add('fx-still');
  const panel = sheet.querySelector('.create-panel');

  // Typewriter overlay over the textarea (placeholder hidden while it runs).
  // Wrapper is static markup: moving a focused textarea would blur it (and drop the
  // mobile keyboard).
  const wrap = prompt.parentNode;
  const ghost = document.createElement('div');
  ghost.className = 'fx-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.innerHTML = '<span class="fx-ghost-text"></span><span class="fx-caret"></span>';
  wrap.appendChild(ghost);
  const ghostText = ghost.firstChild;
  const basePlaceholder = prompt.getAttribute('placeholder') || '';

  let tw = 0, twIdea = 0, twPos = 0, twDir = 1;
  let twList = IDEAS.slice(0, TYPE_COUNT);
  const twStep = () => {
    tw = 0;
    if (!sheet.classList.contains('open') || prompt.value) return;
    const idea = twList[twIdea % twList.length];
    let delay = 55 + Math.random() * 45;
    if (twDir > 0) { twPos++; if (twPos >= idea.length) { twDir = -1; delay = 1500; } }
    else { twPos -= 2; if (twPos <= 0) { twPos = 0; twDir = 1; twIdea = (twIdea + 1) % twList.length; delay = 380; } else delay = 22; }
    ghostText.textContent = idea.slice(0, twPos);
    tw = setTimeout(twStep, delay);
  };
  const syncGhost = () => {
    const show = !prompt.value;
    ghost.hidden = !show;
    if (!motion) { prompt.setAttribute('placeholder', basePlaceholder); ghost.hidden = true; return; }
    prompt.setAttribute('placeholder', show ? '' : basePlaceholder);
    if (show && !tw && sheet.classList.contains('open')) { twPos = 0; twDir = 1; tw = setTimeout(twStep, 300); }
    if (!show && tw) { clearTimeout(tw); tw = 0; }
  };

  // Chips: 🎲 random, "Like <current game> but…", then fixed ideas. Rebuilt on each open.
  const chips = document.createElement('div');
  chips.className = 'fx-chips';
  chips.setAttribute('role', 'list');
  wrap.after(chips);
  let shownNow = [];
  const surprise = () => {
    // Only approved lines; never one shown in this or recent opens (pool wraps if exhausted).
    const t = drawFresh(1, shownNow)[0]?.[1] || IDEAS[Math.floor(Math.random() * IDEAS.length)];
    pushRecent([t]);
    return t;
  };
  const buildChips = () => {
    const title = (getTitle() || '').trim();
    const list = [['🎲', 'Surprise me', 'random']];
    if (title) list.push(['✨', `Like ${title} but…`, `Like ${title} but `]);
    const drawn = drawFresh(CHIP_COUNT + TYPE_COUNT);
    const chipIdeas = drawn.slice(0, CHIP_COUNT);
    twList = drawn.slice(CHIP_COUNT).map(([, t]) => t);
    twIdea = 0;
    shownNow = drawn.map(([, t]) => t);
    pushRecent(shownNow);
    chipIdeas.forEach(([e, t]) => list.push([e, t, t]));
    chips.textContent = '';
    list.forEach(([e, label, text]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fx-chip';
      b.setAttribute('role', 'listitem');
      b.innerHTML = `<span aria-hidden="true">${e}</span> `;
      b.append(label);
      if (text !== 'random') b.title = text.trim();
      b.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const t = text === 'random' ? surprise() : text;
        typeIn(t);
      });
      chips.appendChild(b);
    });
  };

  let typing = 0;
  const typeIn = (text) => {
    clearTimeout(typing);
    prompt.value = '';
    syncGhost();
    try { prompt.focus({ preventScroll: true }); } catch (_) {}
    if (!motion) { prompt.value = text; finishType(); return; }
    let i = 0;
    const chars = [...text];
    const step = () => {
      i = Math.min(chars.length, i + 1 + (chars.length > 40 ? 1 : 0));
      prompt.value = chars.slice(0, i).join('');
      if (i < chars.length) typing = setTimeout(step, 24);
      else finishType();
    };
    step();
  };
  const finishType = () => {
    const end = prompt.value.length;
    try { prompt.setSelectionRange(end, end); } catch (_) {}
    syncGhost();
    onFill();
  };

  prompt.addEventListener('input', () => { clearTimeout(typing); syncGhost(); });

  // Send: press ripple.
  send.addEventListener('pointerdown', (e) => {
    if (!motion || send.classList.contains('disabled')) return;
    const r = send.getBoundingClientRect();
    const s = document.createElement('span');
    s.className = 'fx-ripple';
    s.style.left = `${e.clientX - r.left}px`;
    s.style.top = `${e.clientY - r.top}px`;
    send.appendChild(s);
    setTimeout(() => s.remove(), 650);
  });

  return {
    motion,
    open() {
      buildChips();
      clearTimeout(tw); tw = 0; ghostText.textContent = '';
      syncGhost();
      // The sheet gets .open a frame later; start the typewriter once it has it.
      requestAnimationFrame(() => requestAnimationFrame(syncGhost));
    },
    close() {
      clearTimeout(tw); tw = 0; clearTimeout(typing);
      sheet.classList.remove('fx-warp', 'fx-flash');
      sheet.querySelector('.fx-warp-layer')?.remove();
    },
    /** Warp jump (~800ms). Resolves when the flash peaks. */
    warp(text) {
      if (!motion) return Promise.resolve();
      // Star streaks + shockwave ring (CSS), built only for the jump.
      const layer = document.createElement('div');
      layer.className = 'fx-warp-layer';
      layer.setAttribute('aria-hidden', 'true');
      layer.innerHTML = '<i class="fx-streaks"></i><i class="fx-ring"></i>';
      sheet.insertBefore(layer, panel);
      sheet.classList.add('fx-warp');
      const fly = document.createElement('div');
      fly.className = 'fx-fly';
      fly.textContent = text.length > 90 ? `${text.slice(0, 88)}…` : text;
      const r = prompt.getBoundingClientRect();
      fly.style.left = `${r.left + 14}px`; fly.style.top = `${r.top + 12}px`; fly.style.width = `${r.width - 28}px`;
      fly.style.setProperty('--dx', `${window.innerWidth / 2 - (r.left + r.width / 2)}px`);
      fly.style.setProperty('--dy', `${window.innerHeight / 2 - (r.top + 24)}px`);
      document.body.appendChild(fly);
      return new Promise((resolve) => {
        setTimeout(() => {
          sheet.classList.add('fx-flash');
          setTimeout(() => fly.remove(), 300);
          resolve();
        }, 780);
      });
    },
  };
}
