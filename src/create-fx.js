/* Create-sheet extras: typewriter placeholder, idea chips, Send ripple and the warp
 * jump on Send (CSS only). prefers-reduced-motion → plain sheet, no animation. */

// Every suggestion riffs on a well-known game.
const IDEAS = [
  'Minecraft but underwater',
  'Warcraft with cats',
  'Call of Duty in space',
  'League of Legends as a racing game',
  'Rocket League with dinosaurs',
  'Tetris but the blocks fight back',
  'Among Us on a pirate ship',
  'Mario Kart with shopping carts',
];
const CHIP_IDEAS = [
  ['⛏️', 'Minecraft but underwater'],
  ['🐱', 'Warcraft with cats'],
  ['🚀', 'Call of Duty in space'],
  ['🏎️', 'League of Legends as a racing game'],
  ['🦖', 'Rocket League with dinosaurs'],
];
const FAMOUS = ['Minecraft', 'Warcraft', 'Call of Duty', 'League of Legends', 'Rocket League', 'Fortnite', 'GTA', 'Mario Kart', 'Tetris', 'Among Us', 'Zelda', 'Pokémon', 'Doom', 'Portal', 'Pac-Man', 'Flappy Bird', 'Angry Birds', 'Stardew Valley', 'Fall Guys', 'Clash Royale'];
const TWISTS = [
  'but underwater', 'but in space', 'but everyone is a cat', 'but gravity flips every 10s', 'but it’s a cooking game',
  'but you play as the villain', 'but it’s 2D pixel art', 'but on a tiny planet', 'but it’s a rhythm game', 'but set in the Wild West',
  'with dinosaurs', 'with cats', 'with zombies', 'with shopping carts', 'with laser sharks', 'with a talking sword',
  'as a racing game', 'as a tower defense', 'as a farming sim', 'as a puzzle game', 'as a co-op roguelike', 'as a dating sim',
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

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

  let tw = 0, twIdea = Math.floor(Math.random() * IDEAS.length), twPos = 0, twDir = 1;
  const twStep = () => {
    tw = 0;
    if (!sheet.classList.contains('open') || prompt.value) return;
    const idea = IDEAS[twIdea];
    let delay = 55 + Math.random() * 45;
    if (twDir > 0) { twPos++; if (twPos >= idea.length) { twDir = -1; delay = 1500; } }
    else { twPos -= 2; if (twPos <= 0) { twPos = 0; twDir = 1; twIdea = (twIdea + 1) % IDEAS.length; delay = 380; } else delay = 22; }
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
  const buildChips = () => {
    const title = (getTitle() || '').trim();
    const list = [['🎲', 'Surprise me', 'random']];
    if (title) list.push(['✨', `Like ${title} but…`, `Like ${title} but `]);
    CHIP_IDEAS.forEach(([e, t]) => list.push([e, t, t]));
    chips.textContent = '';
    list.forEach(([e, label, text]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fx-chip';
      b.setAttribute('role', 'listitem');
      b.innerHTML = `<span aria-hidden="true">${e}</span> `;
      b.append(label);
      b.addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const t = text === 'random' ? `${pick(FAMOUS)} ${pick(TWISTS)}` : text;
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
    open() { buildChips(); syncGhost(); },
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
