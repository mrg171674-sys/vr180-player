// Command palette (Ctrl+K): type a few letters of anything the app can do, a tab, a recent
// video or a library search, and press Enter. "?" shows every keyboard shortcut.
import { api, emit, settings, baseName } from './core.js';
import { h, modal } from './ui.js';
import { ACTIONS, keysFor, prettyKey } from './shortcuts.js';

let open = null;

function commands() {
  const p = window.__app?.player;
  const cur = p?.current?.();
  const tab = (id, label) => ({ label: `Go to ${label}`, hint: 'Tab', run: () => window.__app.showTab(id) });
  const list = [
    tab('player', 'Player'), tab('library', 'Library'), tab('calibrate', 'Calibrate'), tab('together', 'Watch Together'), tab('phone', 'Phone'), tab('settings', 'Settings'),
    { label: 'Open a video or photo…', hint: 'File', run: async () => { const f = await api.openDialog(); if (f?.length) { window.__app.showTab('player'); p.open(f); } } },
    { label: 'Import from a memory card…', hint: 'Library', run: async () => { window.__app.showTab('library'); (await import('./importer.js')).openImport(); } },
    { label: 'Show jobs', hint: 'Jobs', run: async () => (await import('./jobs.js')).openJobs() },
    { label: 'AI features (install / remove)', hint: 'Settings', run: () => { window.__app.showTab('settings'); setTimeout(() => document.querySelector('.ai-row')?.closest('.card')?.scrollIntoView({ behavior: 'smooth' }), 200); } },
    { label: 'Keyboard shortcuts', hint: '?', run: () => showShortcuts() },
    ...ACTIONS.map((a) => ({ label: a.label, hint: keysFor(a.id).map(prettyKey).join(' · '), run: a.run }))
  ];
  if (cur && !cur.info.isImage) {
    list.push(
      { label: 'Make subtitles with AI…', hint: 'AI', run: async () => (await import('./ai.js')).makeSubtitles(cur.path) },
      { label: 'Upscale with AI…', hint: 'AI', run: async () => (await import('./ai.js')).upscale(cur.path, cur.info) },
      { label: 'Make a flat video…', hint: 'Export', run: async () => (await import('./reframe.js')).openReframe() },
      { label: 'Edit (cut and join)…', hint: 'Export', run: () => document.querySelector('[data-tour=edit]')?.click() }
    );
  }
  if (cur && cur.format.layout === '2d') list.push({ label: cur.info.isImage ? 'Make a 3D photo with AI…' : 'Make a 3D video with AI…', hint: 'AI', run: async () => (await import('./ai.js')).make3DFile(cur.path, cur.info) });
  for (const f of settings.recent || []) list.push({ label: `Open ${baseName(f)}`, hint: 'Recent', sub: f, run: () => { window.__app.showTab('player'); p.open([f]); } });
  return list;
}

// letters in order, rewarding word starts and runs; 0 = no match
function score(q, text) {
  q = q.toLowerCase(); text = text.toLowerCase();
  if (!q) return 1;
  if (text.includes(q)) return 100 + (text.startsWith(q) ? 50 : 0) - text.length * 0.1;
  let s = 0, i = 0, run = 0;
  for (let j = 0; j < text.length && i < q.length; j++) {
    if (text[j] === q[i]) { i++; run++; s += 1 + run + (j === 0 || /[\s/›(-]/.test(text[j - 1]) ? 5 : 0); } else run = 0;
  }
  return i === q.length ? s : 0;
}

export function openPalette() {
  if (open) { open.close(); return; }
  const input = h('input', { type: 'text', class: 'palette-input', placeholder: 'Type a command, a tab, a video… (Enter runs it)', spellcheck: false });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const m = modal({ title: 'Do something', width: 600, body: [input, list], onClose: () => (open = null) });
  m.root.classList.add('palette');
  open = m;
  let items = [], sel = 0;
  const all = commands();
  const draw = () => {
    const q = input.value.trim();
    items = all.map((c) => ({ c, s: Math.max(score(q, c.label), score(q, c.hint || '') * 0.5) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12).map((x) => x.c);
    if (q && q.length > 1) items.push({ label: `Search the library for "${q}"`, hint: 'Library', run: () => { window.__app.showTab('library'); const s = document.querySelector('.lib-tools input[type=search]'); if (s) { s.value = q; s.dispatchEvent(new Event('input')); } } });
    sel = Math.min(sel, items.length - 1);
    list.replaceChildren(...items.map((c, i) => h('button', { class: 'palette-item' + (i === sel ? ' sel' : ''), role: 'option', onmouseenter: () => { sel = i; mark(); }, onclick: () => go(i) },
      h('span', { class: 'grow' }, c.label, c.sub ? h('span', { class: 'muted small' }, '  ' + c.sub) : null), c.hint ? h('kbd', {}, c.hint) : null)));
  };
  const mark = () => [...list.children].forEach((el, i) => el.classList.toggle('sel', i === sel));
  const go = (i) => { const c = items[i]; if (!c) return; m.close(); setTimeout(() => c.run(), 30); };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); mark(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); mark(); list.children[sel]?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
    else if (e.key === 'Enter') { go(sel); e.preventDefault(); }
    e.stopPropagation();
  });
  draw();
  setTimeout(() => input.focus(), 20);
}

// "?": every shortcut at a glance (change them in Settings › Keyboard Shortcuts)
export function showShortcuts() {
  const rows = ACTIONS.filter((a) => keysFor(a.id).length).map((a) => h('div', { class: 'sc-row' }, h('span', {}, a.label), h('span', {}, ...keysFor(a.id).map((k) => h('kbd', {}, prettyKey(k))))));
  rows.push(h('div', { class: 'sc-row' }, h('span', {}, 'Switch tabs'), h('span', {}, h('kbd', {}, '1–6'))), h('div', { class: 'sc-row' }, h('span', {}, 'Look around · zoom'), h('span', {}, h('kbd', {}, 'Drag · wheel'))));
  modal({ title: 'Keyboard shortcuts', width: 640, body: [h('div', { class: 'sc-grid' }, ...rows), h('p', { class: 'muted small' }, 'Change any of them in Settings › Keyboard Shortcuts. Ctrl+K finds every command by name.')] });
}
