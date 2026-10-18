// Colour themes and small motion helpers (sliding tab highlight, ripples, count-up).
import { settings, save } from './core.js';
import { h } from './ui.js';

// "Match Windows" follows the light / dark app mode you chose in Windows, live
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const resolveTheme = (id) => (id === 'auto' ? (darkQuery.matches ? 'midnight' : 'light') : id);
darkQuery.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme('auto', true); });

export const THEMES = [
  { id: 'auto', name: 'Match Windows', bg: 'linear-gradient(135deg, #121212 50%, #eceff3 50%)', card: '#888', line: '#666', accent: '#3c9a62' },
  { id: 'midnight', name: 'Midnight', bg: '#121212', card: '#1b1b1b', line: '#2a2a2a', accent: '#3c9a62' },
  { id: 'oled', name: 'OLED Black', bg: '#000', card: '#0c0c0c', line: '#1d1d1d', accent: '#3c9a62' },
  { id: 'ocean', name: 'Ocean', bg: '#0b1220', card: '#121d31', line: '#1f2f4d', accent: '#4a8ef0' },
  { id: 'sunset', name: 'Sunset', bg: '#1a1020', card: '#26182f', line: '#3a2544', accent: '#f07a3c' },
  { id: 'forest', name: 'Forest', bg: '#0e1612', card: '#15241c', line: '#22382c', accent: '#4cbf7a' },
  { id: 'light', name: 'Light', bg: '#eceff3', card: '#ffffff', line: '#dadee4', accent: '#1f9e58' }
];

export function applyTheme(id, animate = false) {
  const root = document.documentElement;
  if (animate) {
    if (document.body.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches) { /* no crossfade */ }
    else root.classList.add('theme-switching');
    setTimeout(() => root.classList.remove('theme-switching'), 350);
  }
  id = resolveTheme(id);
  if (!id || id === 'midnight') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
}
export function setTheme(id) {
  save({ theme: id });
  applyTheme(id, true);
}

export function themePicker(onPick) {
  const wrap = h('div', { class: 'themes' });
  const draw = () => wrap.replaceChildren(...THEMES.map((t) => h('button', {
    class: 'theme-tile' + ((settings.theme || 'midnight') === t.id ? ' active' : ''),
    onclick: () => { setTheme(t.id); onPick?.(t.id); draw(); }
  },
  h('div', { class: 'theme-prev', style: { background: t.bg, border: `1px solid ${t.line}` } },
    h('div', { class: 'side' }, h('i', { style: { background: t.accent } }), h('i', { style: { background: t.line } }), h('i', { style: { background: t.line } })),
    h('i', { style: { background: t.card, border: `1px solid ${t.line}` } })),
  h('div', { class: 'theme-name' }, h('i', { style: { width: '8px', height: '8px', borderRadius: '50%', background: t.accent, display: 'inline-block' } }), t.name))));
  draw();
  return wrap;
}

// ---- sliding highlight under the active title-bar tab
export function tabIndicator(tabsEl) {
  const ind = h('div', { class: 'tab-ind' });
  tabsEl.prepend(ind);
  const move = () => {
    const a = tabsEl.querySelector('.tab.active');
    if (!a) { ind.style.opacity = 0; return; }
    ind.style.opacity = 1;
    ind.style.width = a.offsetWidth + 'px';
    ind.style.transform = `translateX(${a.offsetLeft}px)`;
    ind.style.setProperty('--tc', getComputedStyle(a).getPropertyValue('--tc'));
  };
  new MutationObserver(move).observe(tabsEl, { subtree: true, attributes: true, attributeFilter: ['class'] });
  requestAnimationFrame(move);
  return move;
}

// ---- press ripple on any button
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest?.('.btn, .ibtn, .wbtn');
  if (!b || b.disabled || document.body.classList.contains('reduce-motion')) return;
  const r = b.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const dot = h('span', { class: 'ripple', style: { width: size + 'px', height: size + 'px', left: e.clientX - r.left - size / 2 + 'px', top: e.clientY - r.top - size / 2 + 'px' } });
  if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
  b.append(dot);
  setTimeout(() => dot.remove(), 520);
}, true);

// ---- numbers that count up to their value
export function countUp(el, to, { ms = 700, decimals = 0, suffix = '' } = {}) {
  if (document.body.classList.contains('reduce-motion')) { el.textContent = to.toFixed(decimals) + suffix; return; }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / ms), e = 1 - Math.pow(1 - k, 3);
    el.textContent = (to * e).toFixed(decimals) + suffix;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---- remove an element with a fade/collapse
export function leave(el, then) {
  if (!el || document.body.classList.contains('reduce-motion')) { el?.remove(); then?.(); return; }
  el.style.maxHeight = el.offsetHeight + 'px';
  el.classList.add('leaving');
  setTimeout(() => { el.remove(); then?.(); }, 230);
}
