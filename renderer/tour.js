// First-run guided tour: dims the window, spotlights one thing at a time and
// explains it. Replay it any time from Settings › About.
import { emit, settings, save } from './core.js';
import { h, svg } from './ui.js';
import { sfx } from './sfx.js';

const STEPS = [
  { title: 'Welcome to VR180 Player 👋', text: 'Play 180° and 360° VR videos on your PC, convert fisheye footage to VR180, and watch together with friends. This quick tour shows you around. It takes about a minute.' },
  { tab: 'player', target: () => document.querySelector('#stage:not(.loaded) [data-tour=drop]') || document.getElementById('stage'), title: 'Open a video',
    text: 'Drop any VR video onto the window, or click Choose video. Fisheye, VR180, 360°, flat, mono or 3D: the format is detected automatically.' },
  { tab: 'player', target: '[data-tour=format]', title: 'Format, detected for you',
    text: 'This shows what the app detected: lens type, 3D layout and field of view. If it ever guesses wrong, change it here.' },
  { tab: 'player', target: '[data-tour=view]', title: 'Ways to watch',
    text: 'VR lets you look around inside the video. Flat shows the raw frame. For 3D videos, "3D" is red/cyan anaglyph for cheap 3D glasses, and L|R shows both eyes side by side.' },
  { tab: 'player', target: '#stage', drag: true, title: 'Look around',
    text: 'Drag with the mouse to look around, and scroll to zoom. A game controller works too (left stick). R resets the view.' },
  { tab: 'player', target: '#controls', title: 'Playback controls',
    text: 'Hover the bar to preview frames. Shift+A sets an A-B loop, B adds a chapter, S saves a snapshot, and the CC button above has subtitles and spatial audio.' },
  { tab: 'player', target: '#controls [title^="Mini"]', title: 'Fullscreen & mini-player',
    text: 'Fullscreen (F) shows only the video; the controls fade away until you move the mouse near the bottom. The mini-player (Ctrl+M) keeps a small window on top of everything.' },
  { tab: 'calibrate', target: '.calib-cards', title: 'Calibrate',
    text: 'Fix eye strain from badly aligned 3D: Auto-align eyes does it in one click. You can also tilt, level and scale the picture, or lie back with Lay-down mode in a headset.' },
  { tab: 'library', target: '.lib-main', title: 'Library',
    text: 'Add folders (including network drives) to see all your videos with covers and badges. Ctrl-click to select several and convert them to VR180 in one go. A private vault hides folders behind a PIN.' },
  { tab: 'together', target: '.page[data-page=together] .grid2 > .stack', title: 'Watch Together',
    text: 'Host a room and share the short invite code. Friends on your network who join stay in sync: play, pause, seeking and speed. There\'s chat too.' },
  { tab: 'settings', target: '[data-tour=bench]', title: 'Check your PC',
    text: 'The benchmark tests decoding, VR rendering and 8K, with a progress bar so you can see it working. Sounds, animations, shortcuts and more are here too.' },
  { tab: 'player', title: 'You\'re all set!', text: 'Drop a video in to get started. You can replay this tour from Settings › About.' }
];

let root, hole, cardEl, index = 0, onKey;

export function startTour() {
  if (root) return;
  index = 0;
  root = h('div', { class: 'tour' });
  hole = h('div', { class: 'tour-hole' }, h('div', { class: 'tour-hand', html: '<svg viewBox="0 0 24 24" class="ic"><path d="M9 11V5a1.5 1.5 0 0 1 3 0v5m0-1a1.5 1.5 0 0 1 3 0v1.5m0-.5a1.5 1.5 0 0 1 3 0V13a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3.5 14a1.5 1.5 0 0 1 2.5-1.6L9 15" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>' }));
  cardEl = h('div', { class: 'tour-card' });
  root.append(hole, cardEl);
  root.addEventListener('pointerdown', (e) => { if (e.target === root) e.stopPropagation(); });
  document.body.append(root);
  onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  requestAnimationFrame(() => root.classList.add('show'));
  show();
}

function go(d) {
  const n = index + d;
  if (n < 0) return;
  if (n >= STEPS.length) return end();
  index = n;
  sfx.play('tick');
  show();
}

function show() {
  const step = STEPS[index];
  if (step.tab) emit('goto', step.tab);
  const dots = h('div', { class: 'tour-dots' }, ...STEPS.map((_, i) => h('span', { class: i === index ? 'on' : i < index ? 'done' : '' })));
  cardEl.replaceChildren(
    h('div', { class: 'tour-step' }, `${index + 1} / ${STEPS.length}`),
    h('h3', {}, step.title),
    h('p', {}, step.text),
    h('div', { class: 'inline' }, dots, h('div', { class: 'grow' }),
      index < STEPS.length - 1 ? h('button', { class: 'btn ghost', onclick: end }, 'Skip') : null,
      index > 0 ? h('button', { class: 'btn', onclick: () => go(-1) }, 'Back') : null,
      h('button', { class: 'btn primary', onclick: () => go(1) }, index === STEPS.length - 1 ? 'Start watching' : 'Next')));
  cardEl.classList.remove('pop');
  void cardEl.offsetWidth;
  cardEl.classList.add('pop');
  hole.classList.toggle('drag', !!step.drag);
  // wait a frame so a tab switch has laid out before measuring
  requestAnimationFrame(() => requestAnimationFrame(place));
}

function targetRect() {
  const t = STEPS[index].target;
  const el = typeof t === 'function' ? t() : t ? document.querySelector(t) : null;
  if (!el || !el.offsetParent && el !== document.body) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? r : null;
}

function place() {
  if (!root) return;
  const r = targetRect();
  const W = window.innerWidth, H = window.innerHeight, pad = 8;
  if (r) {
    hole.classList.remove('none');
    Object.assign(hole.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  } else {
    hole.classList.add('none');
    Object.assign(hole.style, { left: W / 2 + 'px', top: H / 2 + 'px', width: '0px', height: '0px' });
  }
  const cw = cardEl.offsetWidth, ch = cardEl.offsetHeight;
  let x, y;
  if (!r) { x = (W - cw) / 2; y = (H - ch) / 2; }
  else {
    const below = r.bottom + pad + 14, above = r.top - pad - 14 - ch;
    if (below + ch < H - 10) y = below;
    else if (above > 10) y = above;
    else y = Math.min(H - ch - 10, Math.max(10, r.top + r.height / 2 - ch / 2));
    x = r.left + r.width / 2 - cw / 2;
    // if the card would cover a tall target, put it beside instead
    if (y > r.top && y < r.bottom) x = r.right + 24 + cw < W ? r.right + 24 : Math.max(10, r.left - 24 - cw);
  }
  cardEl.style.left = Math.max(10, Math.min(W - cw - 10, x)) + 'px';
  cardEl.style.top = Math.max(10, Math.min(H - ch - 10, y)) + 'px';
}

function end() {
  if (!root) return;
  save({ tourDone: true });
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  const r = root;
  root = null;
  r.classList.remove('show');
  setTimeout(() => r.remove(), 300);
  emit('goto', 'player');
  sfx.play('success');
}

export function maybeStartTour() {
  if (!settings.tourDone) setTimeout(startTour, 600);
}
export const tourState = () => ({ open: !!root, index, total: STEPS.length });
