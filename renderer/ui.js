import { sfx } from './sfx.js';

// Small UI kit in the style of the app: cards with OFF/ON switches,
// segmented pills, value boxes with units, tooltips, toasts, modals.

const P = (d, extra = '') => `<path d="${d}" ${extra}/>`;
const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
export const ICONS = {
  play: P('M8 5.5v13l10.5-6.5z', 'fill="currentColor"'),
  pause: P('M7 5h3.5v14H7zM13.5 5H17v14h-3.5z', 'fill="currentColor"'),
  prev: P('M6 5h2v14H6zM19 5v14L9 12z', 'fill="currentColor"'),
  next: P('M16 5h2v14h-2zM5 5v14l10-7z', 'fill="currentColor"'),
  back: P('M11 6 5 12l6 6M19 6l-6 6 6 6', S),
  fwd: P('M13 6l6 6-6 6M5 6l6 6-6 6', S),
  vol: P('M4 9.5v5h3.5L12 18V6L7.5 9.5z', 'fill="currentColor"') + P('M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11', S),
  mute: P('M4 9.5v5h3.5L12 18V6L7.5 9.5z', 'fill="currentColor"') + P('M16 9.5l5 5M21 9.5l-5 5', S),
  loop: P('M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4', S),
  full: P('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', S),
  unfull: P('M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5', S),
  list: P('M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01', S),
  folder: P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', S),
  headset: P('M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4l-2-3h-2l-2 3H5a2 2 0 0 1-2-2z', S),
  reset: P('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5', S),
  x: P('M6 6l12 12M18 6 6 18', S),
  info: '<circle cx="12" cy="12" r="9" ' + S + '/>' + P('M12 11v5M12 8h.01', S),
  gear: '<circle cx="12" cy="12" r="3" ' + S + '/>' + P('M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z', S),
  playtab: '<rect x="3" y="5" width="18" height="14" rx="3" ' + S + '/>' + P('M10 9.5v5l4.5-2.5z', 'fill="currentColor"'),
  layers: P('M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5', S),
  circle: '<circle cx="12" cy="12" r="8.5" ' + S + '/>',
  users: '<circle cx="9" cy="8" r="3.5" ' + S + '/>' + P('M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5a6.5 6.5 0 0 1 3 5.5', S),
  pin: P('M9 4h6M10 4v6l-3 4h10l-3-4V4M12 14v6', S),
  min: P('M5 12h14', S),
  max: '<rect x="5" y="5" width="14" height="14" rx="1.5" ' + S + '/>',
  camera: P('M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', S) + '<circle cx="12" cy="12.5" r="3.5" ' + S + '/>',
  bookmark: P('M6 4h12v17l-6-4-6 4z', S),
  ab: '<text x="12" y="16" text-anchor="middle" font-size="10.5" font-weight="800" fill="currentColor" font-family="Segoe UI, sans-serif">A-B</text>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2" ' + S + '/>' + P('M8 11V8a4 4 0 0 1 8 0v3', S),
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2" ' + S + '/>' + P('M8 11V8a4 4 0 0 1 7.5-2', S),
  search: '<circle cx="11" cy="11" r="6.5" ' + S + '/>' + P('M20 20l-4.3-4.3', S),
  calendar: '<rect x="4" y="5.5" width="16" height="14" rx="2" ' + S + '/>' + P('M4 10h16M8.5 3.5v4M15.5 3.5v4', S),
  chevron: P('M7 10l5 5 5-5', S),
  plus: P('M12 5v14M5 12h14', S),
  send: P('M4 12 20 4l-6 16-3-7z', S),
  eye: P('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', S) + '<circle cx="12" cy="12" r="3" ' + S + '/>',
  wifi: P('M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01', S),
  gamepad: P('M6 9h4M8 7v4M15 8h.01M18 10h.01M7 4h10a5 5 0 0 1 5 5v4a4 4 0 0 1-7 2.5L13.5 14h-3L9 15.5A4 4 0 0 1 2 13V9a5 5 0 0 1 5-5z', S),
  convert: P('M4 7h13l-3-3M20 17H7l3 3', S),
  level: P('M3 14h18M6 10l12-2', S) + '<circle cx="12" cy="9" r="1.6" fill="currentColor"/>',
  moon: P('M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z', S),
  pip: '<rect x="3" y="5" width="18" height="14" rx="2" ' + S + '/>' + '<rect x="11.5" y="11" width="7" height="5.5" rx="1" fill="currentColor"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2" ' + S + '/>' + P('M3 16l5-5 4 4 3-3 6 6', S) + '<circle cx="15.5" cy="9.5" r="1.5" fill="currentColor"/>',
  music: P('M9 18V6l11-2v12', S) + '<circle cx="6.5" cy="18" r="2.5" ' + S + '/><circle cx="17.5" cy="16" r="2.5" ' + S + '/>',
  edit: P('M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4', S),
  scissors: '<circle cx="6" cy="7" r="2.5" ' + S + '/><circle cx="6" cy="17" r="2.5" ' + S + '/>' + P('M8 8.5 20 18M8 15.5 20 6', S),
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5" ' + S + '/>' + P('M11 18.5h2', S),
  star: P('M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z', S),
  starFill: P('M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z', 'fill="currentColor"'),
  heart: P('M12 20s-7-4.4-9-8.6C1.6 8.4 3.4 5 6.6 5c2 0 3.4 1.2 4.1 2.4h2.6C14 6.2 15.4 5 17.4 5c3.2 0 5 3.4 3.6 6.4-2 4.2-9 8.6-9 8.6z', S),
  heartFill: P('M12 20s-7-4.4-9-8.6C1.6 8.4 3.4 5 6.6 5c2 0 3.4 1.2 4.1 2.4h2.6C14 6.2 15.4 5 17.4 5c3.2 0 5 3.4 3.6 6.4-2 4.2-9 8.6-9 8.6z', 'fill="currentColor"'),
  update: P('M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5M12 8v5l3 2', S),
  shield: P('M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z', S),
  copy: '<rect x="8" y="8" width="12" height="12" rx="2" ' + S + '/>' + P('M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3', S),
  shuffle: P('M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5', S)
};
export const svg = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
export const iconBtn = (name, title, onclick, cls = '') => h('button', { class: 'ibtn ' + cls, title, onclick, html: svg(name) });

// OFF | ON switch
export function toggle(value, onChange) {
  const off = h('button', { class: 'off' }, 'OFF'), onb = h('button', { class: 'on' }, 'ON');
  const el = h('div', { class: 'toggle' }, off, onb);
  el.set = (v) => { el.value = !!v; el.classList.toggle('is-on', !!v); };
  off.dataset.sfx = onb.dataset.sfx = 'none';
  off.onclick = () => { if (el.value) { el.set(false); sfx.play('off'); onChange?.(false); } };
  onb.onclick = () => { if (!el.value) { el.set(true); sfx.play('on'); onChange?.(true); } };
  el.set(value);
  return el;
}

// [ Rate | Delay ] style
export function segmented(options, value, onChange, cls = '') {
  const el = h('div', { class: 'seg ' + cls });
  const btns = options.map((o) => {
    const b = h('button', { 'data-v': o.value, title: o.title, html: o.icon ? svg(o.icon) + (o.label ? `<span>${o.label}</span>` : '') : null }, o.icon ? null : o.label);
    b.dataset.sfx = 'none';
    b.onclick = () => { if (el.value !== o.value) { el.set(o.value); sfx.play('tick'); onChange?.(o.value); } };
    return b;
  });
  el.append(...btns);
  el.set = (v) => { el.value = v; btns.forEach((b, i) => b.classList.toggle('active', options[i].value === v)); };
  el.setHidden = (value, hidden) => { const i = options.findIndex((o) => o.value === value); if (i >= 0) btns[i].hidden = hidden; };
  el.set(value);
  return el;
}

// [ 100  % ] value box; drag vertically or scroll to change
export function numBox({ value, min = -Infinity, max = Infinity, step = 1, unit = '', onChange, width, label }) {
  const input = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false' });
  const el = h('label', { class: 'num', style: width ? { width: width + 'px' } : null },
    label ? h('span', { class: 'nl' }, label) : null, input, unit ? h('span', { class: 'unit' }, unit) : null);
  const dec = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  el.set = (v) => { el.value = v; input.value = (+v).toFixed(dec); };
  const commit = (v, fire = true) => {
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    if (isNaN(v)) v = el.value;
    el.set(v);
    if (fire) onChange?.(+v.toFixed(dec));
  };
  input.addEventListener('change', () => commit(parseFloat(input.value)));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); commit(el.value + (e.key === 'ArrowUp' ? step : -step)); }
  });
  el.addEventListener('wheel', (e) => {
    // only while you're editing this box; otherwise the wheel scrolls the page as usual
    if (el.classList.contains('disabled') || !el.contains(document.activeElement)) return;
    e.preventDefault(); commit(el.value + (e.deltaY < 0 ? step : -step));
  }, { passive: false });
  el.set(value);
  return el;
}

// Label + slider + value box, all kept in sync
export function rangeRow({ label, info, value, min, max, step = 1, unit = '', onChange }) {
  const range = h('input', { type: 'range', min, max, step, value });
  const box = numBox({ value, min, max, step, unit, width: 86, onChange: (v) => { range.value = v; onChange(v); } });
  range.addEventListener('input', () => { box.set(+range.value); onChange(+range.value); });
  range.addEventListener('dblclick', () => { const d = +range.dataset.default; range.value = d; box.set(d); onChange(d); });
  range.dataset.default = value;
  const row = h('div', { class: 'row-field' }, h('div', { class: 'rl' }, info ? infoTip(info) : null, label), range, box);
  row.set = (v) => { range.value = v; box.set(v); };
  return row;
}

export function field(label, control, info) {
  return h('div', { class: 'row-field simple' }, h('div', { class: 'rl' }, info ? infoTip(info) : null, label), control);
}

export function select(options, value, onChange, cls = '') {
  const s = h('select', { class: cls }, ...options.map((o) => h('option', { value: o.value }, o.label)));
  s.value = value;
  s.addEventListener('change', () => { onChange?.(s.value); if (!s.closest('.modal, .popover, form')) s.blur(); });
  s.set = (v) => (s.value = v);
  return s;
}

export function infoTip(text) {
  return h('span', { class: 'info', 'data-tip': text, html: svg('info') });
}

// Card with ⓘ title and optional OFF/ON switch that disables the body
export function card({ title, info, toggled, onToggle, actions, body = [], cls = '' }) {
  const bodyEl = h('div', { class: 'card-body' }, ...body);
  const disabledPill = h('div', { class: 'disabled-pill' }, 'DISABLED');
  const head = h('div', { class: 'card-head' }, info ? infoTip(info) : null, h('h3', {}, title), h('div', { class: 'grow' }), ...(actions || []));
  const el = h('section', { class: 'card ' + cls }, head, h('div', { class: 'card-wrap' }, bodyEl, disabledPill));
  el.body = bodyEl;
  el.setEnabled = (on) => el.classList.toggle('is-disabled', !on);
  if (toggled !== undefined) {
    const t = toggle(toggled, (v) => { el.setEnabled(v); onToggle?.(v); });
    head.append(t);
    el.toggle = t;
    el.setEnabled(toggled);
  }
  return el;
}

// ---- tooltip (dark bubble with arrow, shown above the hovered ⓘ)
const tip = h('div', { class: 'tooltip' });
document.body.append(tip);
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t) { tip.classList.remove('show'); return; }
  tip.textContent = t.dataset.tip;
  tip.classList.add('show');
  const r = t.getBoundingClientRect(), w = tip.offsetWidth, hgt = tip.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
  const below = r.top - hgt - 12 < 0;
  tip.classList.toggle('below', below);
  tip.style.left = x + 'px';
  tip.style.top = (below ? r.bottom + 12 : r.top - hgt - 12) + 'px';
  tip.style.setProperty('--ax', r.left + r.width / 2 - x + 'px');
});

// ---- toast
const toastEl = h('div', { id: 'toast' });
document.body.append(toastEl);
let toastTimer;
function hideToast() { toastEl.className = ''; toastEl.querySelector('.toast-btn')?.remove(); }
export function toast(msg, kind = '', action = null) {
  sfx.play(kind === 'ok' ? 'success' : kind === 'err' ? 'error' : 'pop');
  toastEl.textContent = msg;
  if (action) toastEl.append(h('button', { class: 'toast-btn', onclick: () => { action.onClick(); hideToast(); } }, action.label));
  toastEl.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 9000 : 4000);
}

// ---- modal
// Escape closes the topmost dialog, wherever the keyboard focus is
const openModals = [];
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openModals.length) return;
  e.stopImmediatePropagation(); e.preventDefault();
  openModals[openModals.length - 1]();
}, true);
export function modal({ title, body = [], onClose, width }) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sfx.play('close');
    openModals.splice(openModals.indexOf(close), 1);
    root.classList.add('closing');
    setTimeout(() => root.remove(), 160);
    onClose?.();
  };
  const cardEl = h('div', { class: 'modal-card', style: width ? { width: width + 'px' } : null },
    h('div', { class: 'card-head' }, h('h3', {}, title), h('div', { class: 'grow' }), iconBtn('x', 'Close', () => close())),
    h('div', { class: 'modal-body' }, ...body));
  const root = h('div', { class: 'modal' }, cardEl);
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  document.body.append(root);
  openModals.push(close);
  sfx.play('open');
  return { root, card: cardEl, close };
}

export function pinDialog(title, sub = 'Enter your PIN (4–8 digits)') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'password', inputmode: 'numeric', maxlength: 8, class: 'pin-input', autocomplete: 'off' });
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const ok = h('button', { class: 'btn primary wide', onclick: () => finish(input.value) }, 'OK');
    const m = modal({ title, width: 340, body: [h('p', { class: 'muted' }, sub), input, ok], onClose: () => { if (!done) { done = true; resolve(null); } } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value); });
    setTimeout(() => input.focus(), 30);
  });
}

// ---- gold notice strip: the highest-priority message wins
const notices = new Map();
export const strip = {
  set(key, priority, { text, action, onAction, actions }) { notices.set(key, { priority, text, action, onAction, actions }); strip.render(); },
  clear(key) { notices.delete(key); strip.render(); },
  render() {
    const el = document.getElementById('strip');
    const top = [...notices.values()].sort((a, b) => b.priority - a.priority)[0];
    el.classList.toggle('show', !!top);
    if (!top) return;
    const btns = top.actions || (top.action ? [{ label: top.action, onClick: top.onAction }] : []);
    el.replaceChildren(h('span', {}, top.text), ...btns.map((b) => h('button', { class: 'strip-btn', onclick: b.onClick }, b.label)));
  }
};

// ---- popover: a small floating card under a button; closes on outside click
let openPop = null;
export function popover(anchor, build) {
  if (openPop) { const same = openPop.anchor === anchor; openPop.close(); if (same) return; }
  const el = h('div', { class: 'popover' });
  el.append(...[].concat(build(() => close())).filter(Boolean));
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, hh = el.offsetHeight;
    let x = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    let y = r.bottom + 8;
    if (y + hh > window.innerHeight - 8) y = Math.max(8, r.top - hh - 8);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  };
  place();
  anchor.classList.add('on');
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close(); } };
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); });
  function close() {
    if (!openPop || openPop.el !== el) return;
    openPop = null;
    anchor.classList.remove('on');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', esc, true);
    el.classList.add('closing');
    setTimeout(() => el.remove(), 140);
  }
  openPop = { el, anchor, close, refresh: () => { el.replaceChildren(...[].concat(build(close)).filter(Boolean)); place(); } };
  return openPop;
}

// Every other button gets a soft click (toggles and segments make their own sounds)
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('button');
  if (!b || b.disabled || b.dataset.sfx === 'none' || b.closest('[data-sfx=none]')) return;
  sfx.play(b.classList.contains('tab') ? 'tab' : 'click');
}, true);
