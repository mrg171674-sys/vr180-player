import { api, on, emit, settings, save, fmtTime, fileKey, mediaUrl, resLabel, vaultState, isPrivatePath, isHidden } from './core.js';
import { makeSubtitles, upscale as aiUpscale, make3DFile } from './ai.js';
import { initImporter, openImport } from './importer.js';
import { h, svg, card, toggle, segmented, iconBtn, toast, pinDialog, strip, popover, modal } from './ui.js';
import { player } from './player.js';
import { openExportDialog } from './export.js';
import { sfx } from './sfx.js';

const selected = new Set(); // keys of selected videos (for batch convert)
let lastClicked = null;

const files = new Map();     // key -> { path, name, size, mtime, folder, details?, loading? }
let ui = {};
const view = { q: '', sort: 'recent', filter: 'all', collection: 'all' };

// ---- smart playlists, favourites and ratings (stored per file in settings.meta)
const meta = (f) => settings.meta?.[fileKey(f.path)] || {};
function setMeta(f, patch) {
  save({ meta: { ...settings.meta, [fileKey(f.path)]: { ...meta(f), ...patch } } });
}
const DAY = 86400000;
// tags: automatic ones from the file (camera, date, format…) plus your own
const tagsOf = (f) => [...new Set([...(f.details?.tags || []), ...(meta(f).tags || [])])];
// latest watch position from any device (this PC or a phone)
export const progressOf = (path) => {
  const k = fileKey(path), a = settings.resume[k], b = settings.remoteResume?.[k];
  return !a ? b || null : !b ? a : (b.at > a.at ? b : a);
};
const inProgress = (f) => { const r = progressOf(f.path); return !!r && r.t > 10 && (!r.d || r.t < r.d - 10); };
// a fisheye video counts as converted when a "name_VR180…" file sits next to it
let convertedIndex = new Set();
function rebuildConvertedIndex() {
  convertedIndex = new Set();
  for (const g of files.values()) {
    const m = /^(.*)_vr180/i.exec(g.name);
    if (m) convertedIndex.add(g.path.slice(0, g.path.length - g.name.length).toLowerCase() + m[1].toLowerCase());
  }
}
const converted = (f) => convertedIndex.has(f.path.slice(0, f.path.length - f.name.length).toLowerCase() + f.name.replace(/\.[^.]+$/, '').toLowerCase());
// when it was shot (from the file's metadata), falling back to the file date
const shotAt = (f) => f.details?.shotAt || f.mtime;
const sameDayInPastYears = (f) => {
  const d = new Date(shotAt(f)), now = new Date();
  if (d.getFullYear() >= now.getFullYear()) return false;
  const a = new Date(now.getFullYear(), d.getMonth(), d.getDate());
  return Math.abs(a - new Date(now.getFullYear(), now.getMonth(), now.getDate())) <= DAY;
};
const COLLECTIONS = [
  { id: 'all', label: 'All', icon: 'layers', test: () => true },
  { id: 'fav', label: 'Favourites', icon: 'heart', test: (f) => meta(f).fav },
  { id: 'continue', label: 'Continue watching', icon: 'play', test: (f) => !f.details?.isImage && inProgress(f) },
  { id: 'unwatched', label: 'Unwatched', icon: 'eye', test: (f) => !f.details?.isImage && !((progressOf(f.path)?.t || 0) > 5) },
  { id: 'recent', label: 'Recently added', icon: 'plus', test: (f) => Date.now() - f.mtime < 14 * DAY },
  { id: 'fisheye', label: 'Fisheye not converted', icon: 'convert', test: (f) => f.details?.format?.projection === 'fisheye' && !f.details.isImage && !converted(f) },
  { id: 'photos', label: 'Photos', icon: 'photo', test: (f) => f.details?.isImage || /\.(jpe?g|png|webp)$/i.test(f.name) },
  { id: 'memories', label: 'On this day', icon: 'calendar', test: sameDayInPastYears, hideEmpty: true }
];
// your saved searches show up as collections too
const allCollections = () => [...COLLECTIONS, ...(settings.smartCollections || []).map((c) => ({ id: 'q:' + c.id, label: c.name, icon: 'search', q: c.q, test: () => true, saved: c }))];

export const library = {
  // Watch Together uses this to find a matching copy of the host's video
  findByNameSize(name, size) {
    for (const f of files.values()) if (f.name === name && f.size === size && !isHidden(f.path)) return f.path;
    return null;
  },
  rescan: () => rescan(),
  // imports land here: added once, quietly
  ensureFolder(path) {
    path = path.replace(/[\\/]+$/, '');
    if (!settings.folders.some((f) => fileKey(f.path) === fileKey(path) || fileKey(path).startsWith(fileKey(f.path) + '\\'))) {
      save({ folders: [...settings.folders, { path, private: false }] });
      renderFolders();
    }
    rescan();
  }
};

export function initLibrary(page) {
  ui.folders = h('div', { class: 'stack', style: { gap: '6px' } });
  ui.netInput = h('input', { type: 'text', placeholder: '\\\\server\\share\\Videos' });
  const foldersCard = card({
    title: 'Folders', info: 'Folders to scan for videos, including subfolders. Network shares (\\\\NAS\\Videos) and mapped drives work too: files stream directly, nothing is copied or re-encoded.',
    actions: [iconBtn('reset', 'Rescan', () => rescan())],
    body: [ui.folders,
      h('button', { class: 'btn', onclick: async () => { const f = await api.folderDialog(); if (f) addFolder(f); }, html: svg('folder') + 'Add folder' }),
      h('div', { class: 'inline' }, ui.netInput, h('button', { class: 'btn', onclick: () => { const v = ui.netInput.value.trim(); if (v) { addFolder(v); ui.netInput.value = ''; } } }, 'Add'))]
  });

  ui.vaultStatus = h('div', { class: 'muted' });
  ui.vaultBtn = h('button', { class: 'btn', onclick: toggleLock });
  ui.vaultCard = card({
    title: 'Private Vault', info: 'Mark folders private with the lock icon. While locked they are hidden from the library, Recent and the start screen. Locks itself when you minimize or after 10 idle minutes. (Files are hidden in the app, not encrypted on disk.)',
    toggled: !!settings.vaultOn, onToggle: setVaultOn,
    body: [ui.vaultStatus, ui.vaultBtn]
  });

  ui.search = h('input', { type: 'search', placeholder: 'Search names and tags…  (e.g. GoPro 2025)' });
  let searchTimer;
  ui.search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { view.q = ui.search.value.toLowerCase(); render(); }, 160); });
  ui.search.title = 'Search names and tags. Also: rating>=4  >10min  <2min  year:2025  camera:gopro  type:3d|360|180|flat|photo  folder:iceland  is:fav  is:unwatched  -word  "exact words"';
  ui.saveSearch = h('button', { class: 'btn small', title: 'Keep this search as a collection on the left', onclick: saveSearch }, 'Save search');
  ui.sort = segmented([{ value: 'recent', label: 'Recent' }, { value: 'timeline', label: 'Timeline', title: 'Grouped into trips by the date they were shot' }, { value: 'name', label: 'Name' }, { value: 'size', label: 'Size' }, { value: 'rating', label: '★' }], 'recent', (v) => { view.sort = v; render(); }, 'small');
  ui.collections = h('div', { class: 'collections' });
  ui.tagCloud = h('div', { class: 'tag-cloud' });
  ui.collectionsCard = card({ title: 'Collections', info: 'Smart playlists that fill themselves. Click the heart or stars on a tile to add favourites and ratings. Tags come from the videos themselves (camera, date, format, resolution); right-click a video to add your own.', body: [ui.collections, h('div', { class: 'tag-head muted' }, 'Tags'), ui.tagCloud] });
  ui.filter = segmented([{ value: 'all', label: 'All' }, { value: '180', label: '180°' }, { value: '360', label: '360°' }, { value: '3d', label: '3D' }, { value: 'flat', label: '2D' }], 'all', (v) => { view.filter = v; render(); }, 'small');
  ui.count = h('span', { class: 'muted' });
  ui.tiles = h('div', { class: 'tiles vgrid' }, ui.sizer = h('div', { class: 'vgrid-sizer' }));
  ui.tiles.addEventListener('scroll', () => requestAnimationFrame(paint), { passive: true });
  let lastW = 0;
  new ResizeObserver(() => requestAnimationFrame(() => { const w = ui.tiles.clientWidth; if (w && Math.abs(w - lastW) > 2) { lastW = w; measured = false; render(true); } else paint(); })).observe(ui.tiles);
  const videosCard = card({
    title: 'Videos', info: 'Click a video to play it. Covers are made from the video itself and unwarped to a normal view. Formats are detected automatically.',
    actions: [ui.count, h('button', { class: 'btn', title: 'Copy new videos and photos from a memory card or camera folder', onclick: () => openImport(), html: svg('folder') + 'Import' }), h('button', { class: 'btn', title: 'Find copies of the same video', onclick: findDuplicates, html: svg('layers') + 'Find duplicates' }), h('button', { class: 'btn', onclick: playAll, html: svg('play') + 'Play all' })],
    body: [h('div', { class: 'lib-tools' }, ui.search, ui.saveSearch, ui.sort, ui.filter,
      h('button', { class: 'btn', title: 'Select every fisheye video, ready to batch convert', onclick: selectFisheye }, 'Select fisheye')),
    ui.selBar = h('div', { class: 'sel-bar' },
      ui.selCount = h('span', {}),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn', onclick: clearSelection }, 'Clear'),
      h('button', { class: 'btn gold', 'data-tour': 'batch', onclick: convertSelected, html: svg('convert') + 'Convert to VR180' })),
    ui.tiles]
  });

  page.append(h('div', { class: 'lib-layout' }, h('div', { class: 'lib-side' }, ui.collectionsCard, foldersCard, ui.vaultCard), h('div', { class: 'lib-main' }, videosCard)));

  renderFolders();
  renderVault();
  rescan();
  initImporter({ addFolder: (p) => library.ensureFolder(p) });
  on('vault', () => { renderFolders(); render(); renderVault(); });
  on('tab', (t) => { if (t === 'library') { measured = false; render(true); } });
}

// ---------------------------------------------------------------- folders
function addFolder(path) {
  path = path.replace(/[\\/]+$/, '');
  if (settings.folders.some((f) => fileKey(f.path) === fileKey(path))) return toast('That folder is already in the library');
  save({ folders: [...settings.folders, { path, private: false }] });
  renderFolders();
  rescan();
}
function renderFolders() {
  const visible = settings.folders.filter((f) => !f.private || vaultState.unlocked || !settings.vaultOn);
  ui.folders.replaceChildren(...(visible.length ? visible.map((f) => h('div', { class: 'folder-row', title: f.path },
    h('span', { html: svg('folder') }), h('span', { class: 'p' }, f.path.length > 34 ? '…' + f.path.slice(-33) : f.path),
    settings.vaultOn ? iconBtn(f.private ? 'lock' : 'unlock', f.private ? 'Private (click to make public)' : 'Make private', () => setPrivate(f, !f.private), f.private ? 'on' : '') : null,
    iconBtn('x', 'Remove from library', () => { save({ folders: settings.folders.filter((x) => x !== f) }); renderFolders(); rescan(); })))
    : [h('div', { class: 'empty-note' }, 'No folders yet.')]));
  const hiddenCount = settings.folders.length - visible.length;
  if (hiddenCount) ui.folders.append(h('div', { class: 'muted' }, `${hiddenCount} private folder${hiddenCount > 1 ? 's' : ''} hidden`));
}
async function setPrivate(f, priv) {
  if (priv && !(await api.vaultHasPin())) { toast('Set a PIN first'); return; }
  f.private = priv;
  save({ folders: [...settings.folders] });
  if (priv) save({ recent: settings.recent.filter((p) => !isPrivatePath(p)) });
  renderFolders();
  render();
}

// ---------------------------------------------------------------- vault
async function setVaultOn(on) {
  if (on && !(await api.vaultHasPin())) {
    const pin = await pinDialog('Create vault PIN', 'Choose a 4–8 digit PIN for private folders');
    if (!pin) { ui.vaultCard.toggle.set(false); ui.vaultCard.setEnabled(false); return; }
    try { await api.vaultSetPin(pin); } catch (e) { toast(String(e.message).replace(/.*Error: /, ''), 'err'); ui.vaultCard.toggle.set(false); ui.vaultCard.setEnabled(false); return; }
    const again = await pinDialog('Confirm PIN');
    if (again !== pin) { toast('PINs did not match', 'err'); await api.vaultClear(pin); ui.vaultCard.toggle.set(false); ui.vaultCard.setEnabled(false); return; }
    vaultState.unlocked = true;
    toast('Vault ready. Use the lock icons to make folders private.', 'ok');
  }
  if (!on && settings.folders.some((f) => f.private) && !vaultState.unlocked) {
    if (!(await unlock())) { ui.vaultCard.toggle.set(true); ui.vaultCard.setEnabled(true); return; }
  }
  if (!on) save({ folders: settings.folders.map((f) => ({ ...f, private: false })) });
  save({ vaultOn: on });
  emit('vault');
}
export async function unlock() {
  const pin = await pinDialog('Unlock vault');
  if (pin == null) return false;
  if (await api.vaultVerify(pin)) { vaultState.unlocked = true; lastActivity = Date.now(); emit('vault'); toast('Vault unlocked', 'ok'); return true; }
  toast('Wrong PIN', 'err');
  return false;
}
export function lock() {
  if (!vaultState.unlocked) return;
  vaultState.unlocked = false;
  // close private media everywhere: player, slideshow, playlist, phones, Watch Together
  player.purgePrivate();
  emit('vault'); // phones and Watch Together re-check what they may show
}
async function toggleLock() { vaultState.unlocked ? lock() : unlock(); }
function renderVault() {
  const on = !!settings.vaultOn;
  const n = settings.folders.filter((f) => f.private).length;
  ui.vaultStatus.textContent = !on ? '' : `${vaultState.unlocked ? 'Unlocked' : 'Locked'} · ${n} private folder${n === 1 ? '' : 's'}`;
  ui.vaultBtn.innerHTML = svg(vaultState.unlocked ? 'lock' : 'unlock') + (vaultState.unlocked ? 'Lock now' : 'Unlock');
  if (on && n && !vaultState.unlocked) strip.set('vault', 2, { text: 'Private vault is locked', action: 'Unlock', onAction: unlock });
  else strip.clear('vault');
}
// auto-lock
let lastActivity = Date.now();
['mousemove', 'keydown', 'pointerdown'].forEach((ev) => window.addEventListener(ev, () => (lastActivity = Date.now()), { passive: true }));
setInterval(() => { if (vaultState.unlocked && Date.now() - lastActivity > (settings.vaultAutoLock || 10) * 60000) lock(); }, 15000);
api.onMinimized(() => lock());

// ---------------------------------------------------------------- scanning
let scanToken = 0;
async function rescan() {
  const token = ++scanToken;
  const seen = new Set(), ids = new Set();
  ui.count.textContent = 'Scanning…';
  for (const f of settings.folders) {
    const list = await api.libraryScan(f.path).catch(() => []);
    if (token !== scanToken) return;
    for (const it of list) {
      // the same physical file reached through two library folders is listed once
      if (it.id && ids.has(it.id)) continue;
      if (it.id) ids.add(it.id);
      const k = fileKey(it.path);
      seen.add(k);
      if (!files.has(k)) files.set(k, it);
    }
  }
  for (const k of [...files.keys()]) if (!seen.has(k)) files.delete(k);
  rebuildConvertedIndex();
  render();
  loadDetails(token);
}
// Analyse files and make covers a few at a time, the ones on screen first
async function loadDetails(token) {
  const pending = new Set([...files.values()].filter((f) => !f.details));
  const next = () => {
    for (const k of grid.onScreen) { const f = files.get(k); if (f && pending.has(f)) { pending.delete(f); return f; } }
    const f = pending.values().next().value;
    if (f) pending.delete(f);
    return f;
  };
  const worker = async () => {
    let f;
    while (token === scanToken && (f = next())) {
      f.loading = true;
      try { f.details = await api.libraryDetails(f.path); } catch { f.details = { failed: true }; }
      f.loading = false;
      updateTile(f);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (token === scanToken) render();
}

// ---------------------------------------------------------------- search language
// words match names and tags (one typo allowed in longer words); plus filters:
//   rating>=4  rating:5  >10min  <2min  >2gb  year:2025  camera:gopro  tag:beach  folder:iceland
//   type:3d|360|180|flat|fisheye|vr180|photo|video  is:fav  is:unwatched  is:new  -word  "two words"
const tokenize = (q) => (q.match(/-?"[^"]*"|\S+/g) || []).map((t) => t.replace(/"/g, ''));
function typo1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
}
function matcher(q) {
  const tests = tokenize(q.toLowerCase()).map((raw) => {
    const neg = raw.startsWith('-') && raw.length > 1;
    const w = neg ? raw.slice(1) : raw;
    let t;
    let m;
    if ((m = /^rating(>=|:|>|=)(\d)$/.exec(w))) t = (f) => (meta(f).rating || 0) >= +m[2] + (m[1] === '>' ? 1 : 0);
    else if ((m = /^([<>])(\d+(?:\.\d+)?)(s|sec|m|min|h|gb|mb)$/.exec(w))) {
      const v = +m[2], u = m[3];
      const val = (f) => (u === 'gb' ? f.size / 1e9 : u === 'mb' ? f.size / 1e6 : (f.details?.duration || 0) / (u === 'h' ? 3600 : u === 'm' || u === 'min' ? 60 : 1));
      t = (f) => (m[1] === '>' ? val(f) > v : val(f) < v);
    } else if ((m = /^year:(\d{4})$/.exec(w))) t = (f) => new Date(shotAt(f)).getFullYear() === +m[1];
    else if ((m = /^(tag|camera):(.+)$/.exec(w))) { const v = m[2].replace(/_/g, ' '); t = (f) => tagsOf(f).some((x) => x.toLowerCase() === v || (m[1] === 'camera' && x.toLowerCase().includes(v))); }
    else if ((m = /^folder:(.+)$/.exec(w))) t = (f) => f.path.toLowerCase().slice(0, f.path.length - f.name.length).includes(m[1]);
    else if ((m = /^type:(\w+)$/.exec(w))) {
      const k = m[1];
      t = (f) => {
        const fm = f.details?.format || {};
        return { '3d': fm.layout && fm.layout !== '2d', 360: fm.projection === 'equirect360', 180: fm.projection === 'fisheye' || fm.projection === 'equirect180', vr180: fm.projection === 'equirect180', fisheye: fm.projection === 'fisheye', flat: fm.projection === 'flat', photo: !!f.details?.isImage, video: !!f.details && !f.details.isImage }[k] ?? false;
      };
    } else if (w === 'is:fav' || w === 'fav') t = (f) => !!meta(f).fav;
    else if (w === 'is:unwatched') t = (f) => !((progressOf(f.path)?.t || 0) > 5);
    else if (w === 'is:new') t = (f) => Date.now() - f.mtime < 14 * DAY;
    else {
      const words = w.split(/\s+/);
      t = (f) => {
        const folder = f.path.slice(0, f.path.length - f.name.length - 1).split(/[\\/]/).pop();
        const hay = (f.name + ' ' + folder + ' ' + tagsOf(f).join(' ')).toLowerCase();
        return words.every((x) => hay.includes(x) || (x.length >= 5 && hay.split(/[^a-z0-9]+/).some((y) => y.length >= 4 && typo1(x, y))));
      };
    }
    return neg ? (f) => !t(f) : t;
  });
  return (f) => tests.every((t) => t(f));
}
async function saveSearch() {
  const q = ui.search.value.trim();
  if (!q) return toast('Type a search first, then save it.');
  const input = h('input', { type: 'text', value: q.replace(/\b\w+:/g, '').trim().slice(0, 30) || 'My collection', maxlength: 40 });
  const m = modal({ title: 'Save this search', width: 360, body: [
    h('p', { class: 'muted' }, `"${q}" will show up under Collections and stay up to date as you add videos.`), input,
    h('button', { class: 'btn primary wide', onclick: () => {
      const name = input.value.trim() || 'My collection';
      save({ smartCollections: [...(settings.smartCollections || []), { id: Date.now().toString(36), name, q }] });
      m.close(); renderCollections(true); toast(`Saved "${name}"`, 'ok');
    } }, 'Save')] });
  setTimeout(() => input.select(), 50);
}

// ---------------------------------------------------------------- what's shown
function visibleFiles() {
  let list = [...files.values()].filter((f) => !(settings.vaultOn && isHidden(f.path)));
  const col = allCollections().find((c) => c.id === view.collection) || COLLECTIONS[0];
  list = list.filter(col.test);
  if (col.q) list = list.filter(matcher(col.q));
  if (view.q) list = list.filter(matcher(view.q));
  if (view.filter !== 'all') list = list.filter((f) => {
    const fm = f.details?.format;
    if (!fm) return false;
    if (view.filter === '180') return fm.projection === 'fisheye' || fm.projection === 'equirect180';
    if (view.filter === '360') return fm.projection === 'equirect360';
    if (view.filter === '3d') return fm.layout !== '2d';
    return fm.projection === 'flat';
  });
  const recentAt = (f) => progressOf(f.path)?.at || 0;
  list.sort(view.sort === 'name' ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })
    : view.sort === 'size' ? (a, b) => b.size - a.size
    : view.sort === 'timeline' ? (a, b) => shotAt(b) - shotAt(a)
    : view.sort === 'rating' ? (a, b) => (meta(b).rating || 0) - (meta(a).rating || 0) || (meta(b).fav ? 1 : 0) - (meta(a).fav ? 1 : 0)
    : view.collection === 'recent' ? (a, b) => b.mtime - a.mtime
    : (a, b) => recentAt(b) - recentAt(a) || b.mtime - a.mtime);
  return list;
}

// Timeline: clips grouped into trips (a gap of more than 36 hours starts a new one)
function trips(list) {
  const out = [];
  for (const f of list) {
    const t = shotAt(f);
    const last = out[out.length - 1];
    if (last && last.from - t <= 36 * 3600000) { last.items.push(f); last.from = t; }
    else out.push({ to: t, from: t, items: [f] });
  }
  const fmt = (t, o) => new Date(t).toLocaleDateString(undefined, o);
  for (const g of out) {
    const a = new Date(g.from), b = new Date(g.to);
    const sameDay = a.toDateString() === b.toDateString();
    const sameMonth = a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear();
    const span = sameDay ? fmt(g.to, { day: 'numeric', month: 'long', year: 'numeric' })
      : sameMonth ? `${fmt(g.to, { month: 'long' })} ${a.getDate()}–${b.getDate()}, ${b.getFullYear()}`
      : `${fmt(g.from, { day: 'numeric', month: 'short' })} – ${fmt(g.to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    // the folder most of the trip lives in usually names it ("Cornwall", "Gran's 2025")
    const folders = new Map();
    for (const f of g.items) { const d = f.path.slice(0, f.path.length - f.name.length - 1).split(/[\\/]/).pop(); folders.set(d, (folders.get(d) || 0) + 1); }
    const top = [...folders.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    g.title = span;
    g.sub = `${g.items.length} clip${g.items.length > 1 ? 's' : ''}${top ? ' · ' + top : ''}`;
  }
  return out;
}

// ---------------------------------------------------------------- virtual grid
// Only the rows on screen exist in the DOM, so 10,000 videos scroll as smoothly as 10.
const grid = { rows: [], cols: 1, tileW: 210, tileH: 170, gap: 12, onScreen: new Set(), firstPaint: true, mounted: new Map() };
let measured = false;
function measure() {
  const W = ui.tiles.clientWidth - 4;
  grid.cols = Math.max(1, Math.floor((W + grid.gap) / (210 + grid.gap)));
  grid.tileW = (W - grid.gap * (grid.cols - 1)) / grid.cols;
  grid.tileH = Math.round(grid.tileW * 10 / 16) + 40;
  measured = true;
}
function render(keepScroll) {
  if (!ui.tiles) return;
  if (!measured) measure();
  const list = visibleFiles();
  ui.count.textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
  renderCollections(true);
  if (!settings.folders.length) {
    for (const el of [...ui.tiles.children]) if (el !== ui.sizer) el.remove();
    ui.sizer.style.height = '0px';
    ui.tiles.append(h('div', { class: 'empty-note vgrid-empty' }, 'Add a folder on the left to build your library.'));
    return;
  }
  ui.tiles.querySelector('.vgrid-empty')?.remove();
  // rows: tile rows, plus a heading for each trip in Timeline view
  const rows = [];
  let y = 0;
  const addTiles = (items) => {
    for (let i = 0; i < items.length; i += grid.cols) { rows.push({ y, h: grid.tileH, items: items.slice(i, i + grid.cols) }); y += grid.tileH + grid.gap; }
  };
  if (view.sort === 'timeline') {
    for (const g of trips(list)) { rows.push({ y, h: 44, head: g }); y += 44 + 4; addTiles(g.items); }
  } else addTiles(list);
  grid.rows = rows;
  ui.sizer.style.height = y + 'px';
  if (!keepScroll && !grid.firstPaint) ui.tiles.scrollTop = 0;
  for (const el of [...ui.tiles.querySelectorAll('.tile, .tl-head')]) el.remove();
  grid.mounted = new Map();
  paint();
}
function paint() {
  if (!grid.rows) return;
  const top = ui.tiles.scrollTop - 400, bottom = ui.tiles.scrollTop + ui.tiles.clientHeight + 400;
  const want = new Map();
  let k = 0;
  for (const r of grid.rows) {
    if (r.y + r.h < top || r.y > bottom) continue;
    if (r.head) { want.set('h:' + r.y, { r }); continue; }
    r.items.forEach((f, i) => want.set(fileKey(f.path), { r, f, i, n: k++ }));
  }
  grid.onScreen = new Set([...want.keys()].filter((x) => !x.startsWith('h:')));
  for (const [key, el] of grid.mounted) if (!want.has(key)) { el.remove(); grid.mounted.delete(key); }
  for (const [key, w] of want) {
    let el = grid.mounted.get(key);
    if (!el) {
      if (w.r.head) {
        el = h('div', { class: 'tl-head' }, h('b', {}, w.r.head.title), h('span', { class: 'muted' }, w.r.head.sub),
          h('button', { class: 'btn small', onclick: () => playTrip(w.r.head), html: svg('play') + 'Play trip' }));
      } else {
        el = tile(w.f, grid.firstPaint ? Math.min(w.n, 24) : 0);
        if (!grid.firstPaint) el.style.animation = 'none';
      }
      grid.mounted.set(key, el);
      ui.tiles.append(el);
    }
    const x = w.r.head ? 0 : w.i * (grid.tileW + grid.gap);
    el.style.transform = `translate(${x}px, ${w.r.y}px)`;
    el.style.width = w.r.head ? '100%' : grid.tileW + 'px';
    if (!w.r.head) el.style.height = grid.tileH + 'px';
  }
  grid.firstPaint = false;
}
function playTrip(g) {
  const known = new Map(g.items.filter((f) => f.details && !f.details.failed).map((f) => [fileKey(f.path), f.details]));
  const list = [...g.items].sort((a, b) => shotAt(a) - shotAt(b)).map((f) => f.path);
  emit('goto', 'player');
  player.open([list[0]], { known }).then(() => player.open(list.slice(1), { play: false, known }));
}

// collection counts: at most twice a second while scanning
let collTimer = null;
function renderCollections(now) {
  if (!now) { if (!collTimer) collTimer = setTimeout(() => { collTimer = null; renderCollections(true); }, 500); return; }
  const pool = [...files.values()].filter((f) => !(settings.vaultOn && isHidden(f.path)));
  const cols = allCollections();
  ui.collections.replaceChildren(...cols.map((c) => {
    const n = c.q ? pool.filter(matcher(c.q)).length : pool.filter(c.test).length;
    if (c.hideEmpty && !n && view.collection !== c.id) return null;
    const btn = h('button', { class: 'coll' + (view.collection === c.id ? ' active' : '') + (c.id === 'memories' ? ' memories' : ''), onclick: () => { view.collection = c.id; render(); } },
      h('span', { html: svg(c.icon) }), h('span', { class: 'grow' }, c.label), h('span', { class: 'muted' }, String(n)));
    if (c.saved) btn.append(h('span', { class: 'coll-x', title: 'Remove this saved search', onclick: (e) => { e.stopPropagation(); save({ smartCollections: (settings.smartCollections || []).filter((x) => x.id !== c.saved.id) }); if (view.collection === c.id) view.collection = 'all'; render(); } }, '✕'));
    return btn;
  }).filter(Boolean));
  // tag cloud: most common first
  const counts = new Map();
  for (const f of pool) for (const t of tagsOf(f)) counts.set(t, (counts.get(t) || 0) + 1);
  const active = new Set(view.q.split(/\s+/).filter((w) => w.startsWith('tag:')).map((w) => w.slice(4)));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30);
  ui.tagCloud.replaceChildren(...(top.length ? top.map(([t, n]) => {
    const tok = t.toLowerCase().replace(/ /g, '_');
    return h('button', { class: 'tag' + (active.has(tok) ? ' on' : ''), onclick: () => toggleTag(tok) }, t, h('span', { class: 'muted' }, ' ' + n));
  }) : [h('span', { class: 'muted' }, 'Tags appear as videos are scanned.')]));
}
function toggleTag(tok) {
  const words = ui.search.value.trim().split(/\s+/).filter(Boolean);
  const k = 'tag:' + tok;
  const i = words.findIndex((w) => w.toLowerCase() === k);
  i >= 0 ? words.splice(i, 1) : words.push(k);
  ui.search.value = words.join(' ');
  view.q = ui.search.value.toLowerCase();
  render();
}
function tile(f, i = 0) {
  f.el = h('div', { class: 'tile', title: f.path, style: { '--i': i }, onclick: (e) => onTileClick(f, e), oncontextmenu: (e) => { e.preventDefault(); tileMenu(f); } });
  f.el.style.setProperty('--i', i);
  fillTile(f);
  return f.el;
}
function fillTile(f) {
  const d = f.details;
  const thumb = h('div', { class: 'thumb' });
  if (d?.thumb) thumb.style.backgroundImage = `url("${mediaUrl(d.thumb)}")`;
  else if (!d) thumb.append(h('div', { class: 'spinner' }));
  if (d?.format) {
    const fm = d.format;
    const proj = { fisheye: 'FISHEYE 180', equirect180: 'VR180', equirect360: '360°', flat: '2D' }[fm.projection];
    thumb.append(h('div', { class: 'badges' },
      h('span', { class: 'badge g' }, proj),
      fm.layout !== '2d' ? h('span', { class: 'badge y' }, fm.layout === 'sbs' ? 'SBS 3D' : 'TB 3D') : null,
      h('span', { class: 'badge' }, resLabel(d, fm.layout)),
      d.hdr ? h('span', { class: 'badge' }, 'HDR') : null));
    thumb.append(h('span', { class: 'dur' }, d.isImage ? 'PHOTO' : fmtTime(d.duration)));
    const r = progressOf(f.path);
    if (r && r.d) thumb.append(h('div', { class: 'prog', style: { width: Math.min(100, (r.t / r.d) * 100) + '%' } }));
    // hover to skim through the clip (uses the seek-bar preview sheet)
    if (!d.isImage && d.duration > 2) bindSkim(f, thumb);
  }
  const own = meta(f).tags || [];
  if (own.length) thumb.append(h('div', { class: 'tile-tags' }, ...own.slice(0, 3).map((t) => h('span', { class: 'tag small' }, t))));
  const key = fileKey(f.path);
  f.el.classList.toggle('selected', selected.has(key));
  thumb.append(h('button', { class: 'sel-check', title: 'Select (Ctrl+click)', 'data-sfx': 'none', html: '<svg viewBox="0 0 24 24" class="ic"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    onclick: (e) => { e.stopPropagation(); toggleSelect(f); } }));
  const m = meta(f);
  const heart = h('button', { class: 'fav' + (m.fav ? ' on' : ''), title: m.fav ? 'Remove from favourites' : 'Add to favourites', 'data-sfx': 'none', html: svg(m.fav ? 'heartFill' : 'heart'),
    onclick: (e) => { e.stopPropagation(); setMeta(f, { fav: !m.fav }); sfx.play(m.fav ? 'off' : 'pop'); heart.classList.add('bump'); fillTile(f); renderCollections(); if (view.collection === 'fav') render(true); } });
  const stars = h('div', { class: 'stars' + (m.rating ? ' rated' : '') }, ...[1, 2, 3, 4, 5].map((n) => h('button', { class: n <= (m.rating || 0) ? 'on' : '', title: `${n} star${n > 1 ? 's' : ''}`, 'data-sfx': 'none', html: svg(n <= (m.rating || 0) ? 'starFill' : 'star'),
    onclick: (e) => { e.stopPropagation(); setMeta(f, { rating: m.rating === n ? 0 : n }); sfx.play('tick'); fillTile(f); if (view.sort === 'rating') render(true); } })));
  thumb.append(heart);
  f.el.replaceChildren(thumb, h('div', { class: 'meta' },
    isPrivatePath(f.path) && settings.vaultOn ? h('span', { html: svg('lock'), style: { color: 'var(--gold)' } }) : null,
    h('span', { class: 'n' }, f.name), stars));
}
// skim: move across a cover to flip through the clip
function bindSkim(f, thumb) {
  let timer = null;
  const line = h('div', { class: 'skim-line' });
  thumb.addEventListener('pointerenter', () => {
    timer = setTimeout(async () => {
      if (!f.sprite) {
        try { f.sprite = await api.sprite(f.path, f.details.format, f.details.duration); } catch { f.sprite = false; }
      }
      if (f.sprite && thumb.matches(':hover')) { thumb.classList.add('skimming'); thumb.append(line); }
    }, 350);
  });
  thumb.addEventListener('pointermove', (e) => {
    const sp = f.sprite;
    if (!sp || !thumb.classList.contains('skimming')) return;
    const r = thumb.getBoundingClientRect();
    const x = Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width));
    const i = Math.min(sp.count - 1, Math.floor(x * sp.count));
    const sx = r.width / sp.w, sy = r.height / sp.h;
    thumb.style.backgroundImage = `url("${mediaUrl(sp.path)}")`;
    thumb.style.backgroundSize = `${sp.cols * sp.w * sx}px ${sp.rows * sp.h * sy}px`;
    thumb.style.backgroundPosition = `-${(i % sp.cols) * sp.w * sx}px -${Math.floor(i / sp.cols) * sp.h * sy}px`;
    line.style.left = x * 100 + '%';
  });
  thumb.addEventListener('pointerleave', () => {
    clearTimeout(timer);
    if (!thumb.classList.contains('skimming')) return;
    thumb.classList.remove('skimming');
    line.remove();
    thumb.style.backgroundImage = f.details?.thumb ? `url("${mediaUrl(f.details.thumb)}")` : '';
    thumb.style.backgroundSize = thumb.style.backgroundPosition = '';
  });
}

// ---------------------------------------------------------------- right-click menu: your own tags
function tileMenu(f) {
  popover(f.el.querySelector('.meta') || f.el, (close) => {
    const own = meta(f).tags || [];
    const input = h('input', { type: 'text', placeholder: 'Add a tag, e.g. Beach', maxlength: 24 });
    const add = () => {
      const t = input.value.trim().replace(/\s+/g, ' ');
      if (!t) return;
      if (!own.some((x) => x.toLowerCase() === t.toLowerCase())) setMeta(f, { tags: [...own, t] });
      close(); fillTile(f); renderCollections();
      toast(`Tagged "${t}"`, 'ok');
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    setTimeout(() => input.focus(), 50);
    return [
      h('div', { class: 'pop-title' }, f.name),
      h('div', { class: 'inline' }, input, h('button', { class: 'btn primary', onclick: add }, 'Add')),
      own.length ? h('div', { class: 'tag-cloud' }, ...own.map((t) => h('button', { class: 'tag on', title: 'Remove this tag', onclick: () => { setMeta(f, { tags: own.filter((x) => x !== t) }); close(); fillTile(f); renderCollections(); } }, t + ' ✕'))) : null,
      (f.details?.tags || []).length ? h('div', { class: 'muted small' }, 'Automatic: ' + f.details.tags.join(', ')) : null,
      h('div', { class: 'pop-sep' }),
      h('button', { class: 'pop-item', onclick: () => { api.reveal(f.path); close(); } }, 'Show in folder'),
      h('button', { class: 'pop-item', onclick: () => { close(); emit('highlight-reel', f.path); } }, 'Make a highlight reel…'),
      f.details && !f.details.isImage && f.details.hasAudio !== false ? h('button', { class: 'pop-item', onclick: () => { close(); makeSubtitles(f.path); } }, 'Make subtitles with AI…') : null,
      h('button', { class: 'pop-item', onclick: async () => { close(); let info = null; try { info = await api.analyze(f.path); } catch {} aiUpscale(f.path, info); } }, 'Upscale with AI…'),
      !f.details || f.details.format?.layout === '2d' ? h('button', { class: 'pop-item', onclick: async () => { close(); let info = null; try { info = await api.analyze(f.path); } catch {} make3DFile(f.path, info); } }, 'Make a 3D version with AI…') : null
    ];
  });
}

// ---------------------------------------------------------------- duplicate finder
const KIND = {
  exact: ['Exact copies', 'The same file saved more than once.'],
  similar: ['Probably the same video', 'Same length and the same picture, e.g. a re-encoded or renamed copy.'],
  converted: ['Already converted', 'A fisheye original next to its VR180 version. Keep both if you might convert it again.']
};
let dupesBar = null;
api.onDupesProgress((p) => { if (dupesBar) dupesBar.firstChild.style.width = Math.round(p * 100) + '%'; });
async function findDuplicates() {
  const pool = [...files.values()].filter((f) => !(settings.vaultOn && isHidden(f.path)));
  const pending = pool.filter((f) => !f.details).length;
  const bar = h('div', { class: 'update-bar show' }, h('i'));
  const status = h('p', { class: 'muted' }, pending ? `Waiting for ${pending} video${pending > 1 ? 's' : ''} to finish scanning…` : 'Comparing videos…');
  const body = h('div', { class: 'dupes' }, status, bar);
  const m = modal({ title: 'Find duplicates', width: 760, body: [body] });
  dupesBar = bar;
  const list = pool.filter((f) => f.details && !f.details.failed).map((f) => ({ path: f.path, name: f.name, size: f.size, mtime: f.mtime, duration: f.details.duration, thumb: f.details.thumb, projection: f.details.format?.projection }));
  const groups = await api.dupesFind(list);
  if (!document.body.contains(m.root)) return;
  if (!groups.length) { body.replaceChildren(h('p', {}, 'No duplicates found. 🎉'), h('p', { class: 'muted' }, `Checked ${list.length} files.`)); return; }
  const picks = new Map(); // path -> checkbox
  const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
  const keep = (g, how) => {
    const best = [...g.files].sort(how === 'newest' ? (a, b) => b.mtime - a.mtime : (a, b) => b.size - a.size)[0];
    for (const f of g.files) picks.get(f.path).checked = f !== best;
    refresh();
  };
  const go = h('button', { class: 'btn danger' });
  const refresh = () => {
    const sel = [...picks.entries()].filter(([, c]) => c.checked);
    const bytes = sel.reduce((n, [p]) => n + (groups.flatMap((g) => g.files).find((f) => f.path === p)?.size || 0), 0);
    go.disabled = !sel.length;
    go.textContent = sel.length ? `Move ${sel.length} to the Recycle Bin (frees ${fmtSize(bytes)})` : 'Tick the files you want to remove';
  };
  body.replaceChildren(
    h('p', { class: 'muted' }, `${groups.length} group${groups.length > 1 ? 's' : ''} found in ${list.length} files. Ticked files go to the Recycle Bin, so you can restore them.`),
    ...groups.map((g) => {
      const [title, sub] = KIND[g.kind];
      const newest = [...g.files].sort((a, b) => b.mtime - a.mtime)[0];
      return h('div', { class: 'dupe-group' },
        h('div', { class: 'inline' }, h('b', {}, title), h('span', { class: 'muted small' }, sub), h('div', { class: 'grow' }),
          h('button', { class: 'btn small', onclick: () => keep(g, 'newest') }, 'Keep newest'), h('button', { class: 'btn small', onclick: () => keep(g, 'largest') }, 'Keep largest')),
        ...g.files.map((f) => {
          const cb = h('input', { type: 'checkbox', onchange: refresh });
          // only exact copies are ticked for you; anything that's merely similar is your call
          cb.checked = g.kind === 'exact' && f !== newest;
          picks.set(f.path, cb);
          return h('label', { class: 'dupe-row' }, cb,
            h('div', { class: 'dupe-thumb', style: f.thumb ? { backgroundImage: `url("${mediaUrl(f.thumb)}")` } : null }),
            h('div', { class: 'grow' }, h('b', {}, f.name), h('div', { class: 'muted small' }, f.path.slice(0, f.path.length - f.name.length))),
            h('div', { class: 'muted small right' }, fmtSize(f.size), h('br'), new Date(f.mtime).toLocaleDateString()));
        }));
    }),
    h('div', { class: 'inline' }, h('div', { class: 'grow' }), go));
  go.onclick = async () => {
    const paths = [...picks.entries()].filter(([, c]) => c.checked).map(([p]) => p);
    go.disabled = true;
    const res = await api.trashItems(paths);
    const ok = res.filter((r) => r.ok).length, bad = res.filter((r) => !r.ok);
    toast(bad.length ? `Moved ${ok}; ${bad.length} couldn't be moved (${bad[0].error})` : `Moved ${ok} file${ok > 1 ? 's' : ''} to the Recycle Bin`, bad.length ? 'err' : 'ok');
    m.close();
    rescan();
  };
  refresh();
}
function updateTile(f) {
  if (f.el?.isConnected) fillTile(f);
  renderCollections();
  // filters that depend on the analysis need a (throttled) re-layout
  if (view.filter !== 'all' || view.collection !== 'all' || view.q) { clearTimeout(updateTile.t); updateTile.t = setTimeout(() => render(true), 600); }
}
function playAll() {
  const files = visibleFiles();
  if (!files.length) return;
  // hand the player what the library already knows, so it doesn't re-read every file
  const known = new Map(files.filter((f) => f.details && !f.details.failed).map((f) => [fileKey(f.path), f.details]));
  const list = files.map((f) => f.path);
  emit('goto', 'player');
  player.open([list[0]], { known }).then(() => player.open(list.slice(1), { play: false, known }));
}

// ---------------------------------------------------------------- selection & batch convert
function onTileClick(f, e) {
  if (e.shiftKey && lastClicked) {
    const list = visibleFiles();
    const a = list.indexOf(lastClicked), b = list.indexOf(f);
    if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(fileKey(list[i].path));
    refreshSelection();
    return;
  }
  if (e.ctrlKey || selected.size) { toggleSelect(f); return; }
  player.open([f.path]);
  emit('goto', 'player');
}
function toggleSelect(f) {
  const k = fileKey(f.path);
  selected.has(k) ? selected.delete(k) : selected.add(k);
  lastClicked = f;
  refreshSelection();
}
function selectFisheye() {
  for (const f of visibleFiles()) if (f.details?.format?.projection === 'fisheye' && !f.details.isImage) selected.add(fileKey(f.path));
  if (!selected.size) toast('No fisheye videos found (still scanning?)');
  refreshSelection();
}
function clearSelection() { selected.clear(); refreshSelection(); }
function refreshSelection() {
  for (const f of files.values()) f.el?.classList.toggle('selected', selected.has(fileKey(f.path)));
  ui.selBar.classList.toggle('show', selected.size > 0);
  ui.selCount.textContent = selected.size + ' selected · Ctrl/Shift-click to add more';
}
function convertSelected() {
  const items = [...files.values()].filter((f) => selected.has(fileKey(f.path)) && f.details?.format)
    .map((f) => ({ path: f.path, name: f.name, format: f.details.format, info: f.details }));
  if (!items.length) return toast('Those videos are still being scanned. Try again in a moment.');
  openExportDialog(items);
}
library.select = (paths) => { paths.forEach((p) => selected.add(fileKey(p))); refreshSelection(); };
library.convertSelected = convertSelected;
