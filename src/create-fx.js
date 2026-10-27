/* Create-sheet effects (lazy chunk, loaded on first ＋ touch/open):
 * typewriter placeholder, idea chips, reactive nebula (WebGL, CSS fallback),
 * warp jump on Send. prefers-reduced-motion → plain sheet, static gradient. */
import './create-fx.css';

const IDEAS = [
  'A neon racing game on Mars',
  "Flappy Bird but you're a pizza",
  'Co-op zombie survival in a mall',
  'Cats vs. lasers tower defense',
  'A rhythm game where you DJ for ghosts',
  'Tiny wizard platformer with gravity flips',
  'Pirate ship battles in the clouds',
  'Speedrun a haunted IKEA',
];
const CHIP_IDEAS = [
  ['🏎️', 'A neon racing game on Mars'],
  ['🍕', "Flappy Bird but you're a pizza"],
  ['🧟', 'Co-op zombie survival in a mall'],
  ['🐱', 'Cats vs. lasers tower defense'],
  ['👻', 'A rhythm game where you DJ for ghosts'],
];
const RANDOM_A = ['A cozy', 'A chaotic', 'A tiny', 'A neon', 'A spooky', 'A speedrun', 'A co-op', 'A pixel-art'];
const RANDOM_B = ['farming sim', 'racing game', 'roguelike', 'platformer', 'puzzle game', 'tower defense', 'shooter', 'fishing game'];
const RANDOM_C = ['on the Moon', 'inside a vending machine', 'with a talking sword', 'where gravity flips every 10s', 'starring a raccoon chef', 'in a sinking submarine', 'for two players on one phone', 'set in a dream'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ---------------- nebula ---------------- */
const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const FS = `precision mediump float;
uniform vec2 R;uniform float T,H,P,W;uniform vec2 C;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f*=f*(3.-2.*f);
return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+1.),f.x),f.y);}
float fb(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.03+7.1;a*=.5;}return v;}
vec3 hue(float t){return .5+.5*cos(6.2832*(t+vec3(0.,.33,.67)));}
void main(){vec2 uv=gl_FragCoord.xy/R;float as=R.x/R.y;vec2 q=(uv-.5)*vec2(as,1.);
float t=T*.05;float f=fb(q*2.2+vec2(t,-t*.7)+fb(q*1.4-t)*1.6);
vec3 col=mix(vec3(.02,.01,.06),hue(H+f*.35)*(.35+.9*f*f),smoothstep(.15,.95,f));
col+=hue(H+.5)*pow(f,5.)*1.4*(1.+P*1.5);
vec2 c=(C-.5)*vec2(as,1.);
for(int i=0;i<18;i++){float fi=float(i);vec2 s=vec2(h(vec2(fi,1.)),h(vec2(fi,2.)))-.5;s*=vec2(as,1.)*1.1;
float k=fract(T*.12+h(vec2(fi,3.)));vec2 pp=mix(s,c,k*k);float d=length(q-pp);
col+=hue(H+fi*.05)*(.00016+P*.00024)/(d*d+.00012)*(1.-k)*k*3.;}
col*=1.+P*.35;
if(W>0.){float a=atan(q.y,q.x);float r=length(q);
float st=pow(n(vec2(a*40.,r*3.-T*30.*W)),14.)*smoothstep(.02,.4,r)*W*6.;col+=vec3(.8,.9,1.)*st;
float ring=exp(-pow((r-W*1.6)*12.,2.))*W;col+=hue(H)*ring*1.5;col=mix(col,vec3(1.),smoothstep(.75,1.,W));}
gl_FragColor=vec4(col,1.);}`;

function makeNebula(canvas) {
  const weak = (navigator.hardwareConcurrency || 2) <= 4 || (navigator.deviceMemory && navigator.deviceMemory <= 2);
  if (weak) return null;
  let gl;
  try { gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false }); } catch (_) {}
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return null;
  const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
  gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = {}; ['R', 'T', 'H', 'P', 'W', 'C'].forEach((k) => { U[k] = gl.getUniformLocation(pr, k); });
  const st = { hue: 0.72, hueT: 0.72, pulse: 0, warp: 0, cx: 0.5, cy: 0.35, raf: 0, t0: performance.now() };
  const size = () => {
    // Half-res render (nebula is soft), DPR capped at 1.5.
    const s = Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;
    const w = Math.max(1, Math.round(canvas.clientWidth * s)), h = Math.max(1, Math.round(canvas.clientHeight * s));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
  };
  const frame = (now) => {
    st.raf = 0;
    if (document.hidden) return;
    size();
    st.pulse *= 0.93; st.hue += (st.hueT - st.hue) * 0.06;
    gl.uniform2f(U.R, canvas.width, canvas.height);
    gl.uniform1f(U.T, (now - st.t0) / 1000);
    gl.uniform1f(U.H, st.hue); gl.uniform1f(U.P, st.pulse); gl.uniform1f(U.W, st.warp);
    gl.uniform2f(U.C, st.cx, st.cy);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    st.raf = requestAnimationFrame(frame);
  };
  return {
    kind: 'webgl',
    start() { if (!st.raf) st.raf = requestAnimationFrame(frame); },
    stop() { if (st.raf) cancelAnimationFrame(st.raf); st.raf = 0; },
    running: () => !!st.raf,
    pulse(x, y) { st.pulse = Math.min(1.6, st.pulse + 0.55); st.hueT += 0.035; if (x != null) { st.cx = x; st.cy = y; } },
    setWarp(w) { st.warp = w; },
  };
}

function cssNebula(layer) {
  let hue = 0;
  return {
    kind: 'css',
    start() { layer.classList.add('run'); },
    stop() { layer.classList.remove('run'); },
    running: () => layer.classList.contains('run'),
    pulse() {
      hue = (hue + 14) % 360;
      layer.style.setProperty('--fx-hue', `${hue}deg`);
      layer.classList.remove('kick'); void layer.offsetWidth; layer.classList.add('kick');
    },
    setWarp() {},
  };
}

/* ---------------- attach ---------------- */
export function attachCreateFx({ sheet, prompt, send, getTitle, onFill }) {
  const motion = !reduced();
  sheet.classList.add('fx');
  if (!motion) sheet.classList.add('fx-still');
  const panel = sheet.querySelector('.create-panel');

  // Nebula layer sits between the backdrop and the panel.
  const layer = document.createElement('div');
  layer.className = 'fx-nebula';
  layer.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  layer.appendChild(canvas);
  sheet.insertBefore(layer, panel);
  let neb = null;
  if (motion) neb = makeNebula(canvas);
  if (!neb) { canvas.remove(); layer.classList.add('css'); neb = motion ? cssNebula(layer) : { kind: 'static', start() {}, stop() {}, running: () => false, pulse() {}, setWarp() {} }; }
  sheet.dataset.fx = neb.kind;

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
        const t = text === 'random' ? `${pick(RANDOM_A)} ${pick(RANDOM_B)} ${pick(RANDOM_C)}` : text;
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
      kick();
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

  // Caret position (approx) → nebula particles drift there.
  const caretPoint = () => {
    const r = prompt.getBoundingClientRect();
    const lines = prompt.value.split('\n');
    const last = lines[lines.length - 1] || '';
    const x = Math.min(r.right - 14, r.left + 14 + (last.length % 40) * 8.6);
    const y = Math.min(r.bottom - 10, r.top + 22 + (lines.length - 1 + Math.floor(last.length / 40)) * 22);
    const L = layer.getBoundingClientRect();
    return [(x - L.left) / (L.width || 1), 1 - (y - L.top) / (L.height || 1)];
  };
  const kick = () => { if (neb.running()) { const [x, y] = caretPoint(); neb.pulse(x, y); } };

  prompt.addEventListener('input', () => { clearTimeout(typing); syncGhost(); kick(); });

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

  const onVis = () => { if (document.hidden) neb.stop(); else if (sheet.classList.contains('open')) neb.start(); };
  document.addEventListener('visibilitychange', onVis);

  return {
    motion,
    kind: neb.kind,
    open() { buildChips(); neb.start(); syncGhost(); },
    close() { neb.stop(); clearTimeout(tw); tw = 0; clearTimeout(typing); neb.setWarp(0); sheet.classList.remove('fx-warp', 'fx-flash'); },
    /** Warp jump (~800ms). Resolves when the flash peaks. */
    warp(text) {
      if (!motion) return Promise.resolve();
      sheet.classList.add('fx-warp');
      const fly = document.createElement('div');
      fly.className = 'fx-fly';
      fly.textContent = text.length > 90 ? `${text.slice(0, 88)}…` : text;
      const r = prompt.getBoundingClientRect();
      fly.style.left = `${r.left + 14}px`; fly.style.top = `${r.top + 12}px`; fly.style.width = `${r.width - 28}px`;
      fly.style.setProperty('--dx', `${window.innerWidth / 2 - (r.left + r.width / 2)}px`);
      fly.style.setProperty('--dy', `${window.innerHeight / 2 - (r.top + 24)}px`);
      document.body.appendChild(fly);
      const t0 = performance.now();
      return new Promise((resolve) => {
        const tick = (now) => {
          const k = Math.min(1, (now - t0) / 780);
          neb.setWarp(k);
          if (k < 1) requestAnimationFrame(tick);
          else {
            sheet.classList.add('fx-flash');
            setTimeout(() => fly.remove(), 300);
            resolve();
          }
        };
        requestAnimationFrame(tick);
      });
    },
  };
}
