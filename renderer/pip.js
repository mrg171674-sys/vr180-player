// Picture-in-picture: a second, flat video floating inside the dome, e.g. a
// reaction video or another take to compare. Shift+drag in the view moves it.
import { api, settings, save, baseName, mediaUrl } from './core.js';
import { h, svg, popover, numBox, select, toggle, toast } from './ui.js';

const POSITIONS = {
  br: { label: 'Bottom right', yaw: -35, pitch: -18 },
  bl: { label: 'Bottom left', yaw: 35, pitch: -18 },
  tr: { label: 'Top right', yaw: -35, pitch: 18 },
  tl: { label: 'Top left', yaw: 35, pitch: 18 },
  r: { label: 'Right', yaw: -50, pitch: 0 },
  l: { label: 'Left', yaw: 50, pitch: 0 },
  c: { label: 'Centre (below)', yaw: 0, pitch: -28 }
};

let player, view, btn;
const pip = { el: null, file: null, yaw: -35, pitch: -18 };
export const pipState = pip;
const cfg = () => ({ size: 40, opacity: 100, volume: 60, sync: true, ...settings.pip });

export function initPip(p, button) {
  player = p; view = p.view; btn = button;
  pip.el = h('video', { crossorigin: 'anonymous', playsinline: true, preload: 'auto', style: { display: 'none' } });
  document.body.append(pip.el);
  pip.el.addEventListener('loadedmetadata', show);
  // keep in step with the main video when "sync" is on
  p.video.addEventListener('play', () => { if (pip.file && cfg().sync) pip.el.play().catch(() => {}); });
  p.video.addEventListener('pause', () => { if (pip.file && cfg().sync) pip.el.pause(); });
  p.video.addEventListener('ratechange', () => { pip.el.playbackRate = p.video.playbackRate; });
  // Shift+drag moves the panel instead of looking around
  const stage = document.getElementById('stage');
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!pip.file || !e.shiftKey || e.target.id !== 'vrCanvas') return;
    e.stopImmediatePropagation();
    drag = { x: e.clientX, y: e.clientY };
    e.target.setPointerCapture(e.pointerId);
  }, true);
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    e.stopImmediatePropagation();
    const k = view.camera.fov / e.target.clientHeight;
    pip.yaw -= (e.clientX - drag.x) * k;
    pip.pitch = Math.max(-80, Math.min(80, pip.pitch - (e.clientY - drag.y) * k));
    drag = { x: e.clientX, y: e.clientY };
    show();
  }, true);
  stage.addEventListener('pointerup', (e) => { if (drag) { e.stopImmediatePropagation(); drag = null; view.lastDragMoved = true; } }, true);
}

function show() {
  if (!pip.file) { view.setPip(null); return; }
  const c = cfg();
  pip.el.volume = c.volume / 100;
  view.setPip({ video: pip.el, yaw: pip.yaw, pitch: pip.pitch, size: c.size, opacity: c.opacity });
}

export async function openFile(file) {
  if (!file) {
    const paths = await api.openDialog();
    file = paths[0];
    if (!file) return;
  }
  pip.file = file;
  pip.el.src = mediaUrl(file);
  pip.el.currentTime = 0;
  if (!player.video.paused) pip.el.play().catch(() => {});
  btn.classList.add('on');
  toast(`Picture-in-picture: ${baseName(file)} · Shift+drag to move it`, 'ok');
}
export function close() {
  pip.file = null;
  pip.el.pause();
  pip.el.removeAttribute('src');
  pip.el.load();
  btn.classList.remove('on');
  show();
}
function setCfg(patch) { save({ pip: { ...cfg(), ...patch } }); show(); }

export function openPipMenu() {
  popover(btn, (closeMenu) => {
    const c = cfg();
    if (!pip.file) {
      return [h('div', { class: 'menu-title' }, 'Picture-in-picture'),
        h('div', { class: 'muted', style: { padding: '2px 8px 6px', fontSize: '12px', maxWidth: '250px' } }, 'Float a second video inside the view, like a reaction video or another take to compare.'),
        h('button', { class: 'menu-item', onclick: () => { closeMenu(); openFile(); } }, h('span', { html: svg('plus') }), 'Choose a video…')];
    }
    return [
      h('div', { class: 'menu-title' }, baseName(pip.file)),
      h('div', { class: 'menu-grid' },
        h('span', {}, 'Position'), select(Object.entries(POSITIONS).map(([k, v]) => ({ value: k, label: v.label })), '', (k) => { pip.yaw = POSITIONS[k].yaw; pip.pitch = POSITIONS[k].pitch; show(); }),
        h('span', {}, 'Size'), numBox({ value: c.size, min: 10, max: 100, step: 5, unit: '%', width: 90, onChange: (v) => setCfg({ size: v }) }),
        h('span', {}, 'Opacity'), numBox({ value: c.opacity, min: 20, max: 100, step: 10, unit: '%', width: 90, onChange: (v) => setCfg({ opacity: v }) }),
        h('span', {}, 'Volume'), numBox({ value: c.volume, min: 0, max: 100, step: 10, unit: '%', width: 90, onChange: (v) => setCfg({ volume: v }) }),
        h('span', { title: 'Play and pause together with the main video' }, 'Sync with main'), toggle(c.sync, (v) => setCfg({ sync: v })),
        h('span', { title: 'Seconds the second video runs ahead (+) or behind (−) the main one' }, 'Jump to main time'),
        h('button', { class: 'btn', onclick: () => { pip.el.currentTime = player.video.currentTime; } }, 'Match')),
      h('button', { class: 'menu-item', onclick: () => { closeMenu(); openFile(); } }, h('span', { html: svg('pip') }), 'Choose another video…'),
      h('button', { class: 'menu-item', onclick: () => { closeMenu(); close(); } }, h('span', { html: svg('x') }), 'Close picture-in-picture')
    ];
  });
}
