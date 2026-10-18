// Import from a camera or memory card: noticed automatically when a card goes in, or opened
// from the Library. Copies only what's new, into dated folders, checking every copy.
import { api, settings, save, fileKey, fmtTime } from './core.js';
import { h, toast, modal, strip, toggle, field } from './ui.js';
import { openJobs } from './jobs.js';

const GB = (b) => (!b ? '0 MB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB');
let lastCard = null;
let progressCb = null;
api.onImportProgress((id, p) => progressCb?.(id, p));
let onImported = () => {};

export function initImporter({ addFolder }) {
  onImported = addFolder;
  api.onImportCard((c) => {
    lastCard = c;
    if (settings.importWatch === false) return;
    strip.set('import', 4, {
      text: `Memory card found${c.label ? ` (${c.label})` : ''}: ${c.newCount} new video${c.newCount === 1 ? '' : 's'} and photos, ${GB(c.newBytes)}`,
      actions: [{ label: 'Import…', onClick: () => { strip.clear('import'); openImport(c.root); } }, { label: 'Not now', onClick: () => strip.clear('import') }]
    });
  });
  api.onImportCardGone((c) => { if (lastCard?.root === c.root) { lastCard = null; strip.clear('import'); } });
  api.importWatch(settings.importWatch !== false);
}

// Library button: the card that's in, or pick a folder (e.g. a camera's folder or a phone backup)
export async function openImport(root) {
  if (!root) {
    if (lastCard) root = lastCard.root;
    else {
      root = await api.folderDialog();
      if (!root) return;
    }
  }
  const scan = await api.importScan(root);
  const fresh = scan.files.filter((f) => !f.imported);
  if (!scan.files.length) return toast('No videos or photos found there.', 'err');
  const dest = { path: settings.importDir || (await api.importDefaultDest()) };
  const cfg = { convert: !!settings.importConvert };
  // group what's new by the day it was filmed
  const days = new Map();
  for (const f of fresh) {
    const d = new Date(f.mtime).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    if (!days.has(d)) days.set(d, { files: [], on: true });
    days.get(d).files.push(f);
  }
  const body = h('div', { class: 'import' });
  const m = modal({ title: '📥 Import videos and photos', width: 560, body: [body] });
  const destText = h('code', { class: 'import-dest' }, dest.path);
  const summary = h('p', { class: 'muted' });
  const go = h('button', { class: 'btn primary' }, 'Import');
  const refresh = () => {
    const chosen = [...days.values()].filter((d) => d.on).flatMap((d) => d.files);
    summary.textContent = `${chosen.length} file${chosen.length === 1 ? '' : 's'} · ${GB(chosen.reduce((n, f) => n + f.size, 0))}` + (scan.files.length > fresh.length ? ` · ${scan.files.length - fresh.length} imported before (skipped)` : '');
    go.disabled = !chosen.length;
  };
  const list = h('div', { class: 'import-days' }, ...[...days.entries()].map(([label, d]) => {
    const box = h('input', { type: 'checkbox', checked: true, onchange: () => { d.on = box.checked; refresh(); } });
    return h('label', { class: 'import-day' }, box, h('span', { class: 'grow' }, label), h('span', { class: 'muted' }, `${d.files.length} · ${GB(d.files.reduce((n, f) => n + f.size, 0))}`));
  }));
  body.replaceChildren(
    h('p', {}, `From ${root}`),
    fresh.length ? list : h('p', {}, 'Everything here was imported before. 🎉'),
    summary,
    field('Copy to', h('div', { class: 'inline' }, destText, h('button', { class: 'btn small', onclick: async () => { const p = await api.folderDialog(); if (p) { dest.path = p; destText.textContent = p; save({ importDir: p }); } } }, 'Change…'))),
    field('Convert fisheye videos to VR180 afterwards', toggle(cfg.convert, (v) => { cfg.convert = v; save({ importConvert: v }); }), 'Adds the fisheye videos to the conversion queue once they are copied.'),
    h('p', { class: 'muted small' }, 'Files go into a folder per day. Every copy is read back and checked. Nothing on the card is changed or deleted.'),
    h('div', { class: 'row-btns' }, go));
  refresh();
  if (!fresh.length) go.disabled = true;
  go.onclick = () => start([...days.values()].filter((d) => d.on).flatMap((d) => d.files), dest.path, cfg, body, m);
}

async function start(files, dest, cfg, body, m) {
  const id = 'imp-' + Date.now();
  const bar = h('div', { class: 'update-bar show' }, h('i'));
  const line = h('p', {}, 'Starting…');
  const cancel = h('button', { class: 'btn', onclick: () => api.importCancel(id) }, 'Cancel');
  body.replaceChildren(h('p', {}, `Copying ${files.length} file${files.length === 1 ? '' : 's'} to ${dest}`), bar, line, h('div', { class: 'row-btns' }, cancel));
  progressCb = (pid, p) => {
    if (pid !== id) return;
    bar.firstChild.style.width = Math.round(p.fraction * 100) + '%';
    line.textContent = `${p.index} of ${p.count} · ${p.file} · ${(p.speed / 1e6).toFixed(0)} MB/s${p.eta != null ? ' · ' + fmtTime(p.eta) + ' left' : ''}`;
  };
  let r;
  try { r = await api.importRun(id, { files, dest }); } catch (e) {
    body.replaceChildren(h('p', {}, 'Import stopped: ' + String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')), h('div', { class: 'row-btns' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Close')));
    return;
  } finally { progressCb = null; }
  onImported(dest);
  const lines = [h('p', {}, `${r.cancelled ? 'Stopped. ' : ''}Imported ${r.imported.length} file${r.imported.length === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} already there` : ''}.`)];
  if (r.failed.length) lines.push(h('p', { class: 'err' }, `${r.failed.length} could not be copied: ${r.failed.slice(0, 3).map((f) => f.name + ' (' + f.error + ')').join(', ')}${r.failed.length > 3 ? '…' : ''}`));
  if (cfg.convert && r.imported.length) {
    const queued = await queueFisheye(r.imported);
    if (queued) lines.push(h('p', {}, `${queued} fisheye video${queued === 1 ? '' : 's'} added to the conversion queue.`), h('button', { class: 'btn small', onclick: () => openJobs() }, 'Show jobs'));
  }
  lines.push(h('div', { class: 'row-btns' }, h('button', { class: 'btn primary', onclick: () => { m.close(); window.__app?.showTab?.('library'); } }, 'Show in Library')));
  body.replaceChildren(...lines);
  toast(`Imported ${r.imported.length} file${r.imported.length === 1 ? '' : 's'}`, r.failed.length ? 'err' : 'ok');
}

async function queueFisheye(paths) {
  const ex = { codec: 'h264', crf: 18, encoder: 'auto', ...settings.exportDefaults };
  const list = [];
  for (const p of paths) {
    if (!/\.(mp4|mov|m4v|mkv)$/i.test(p)) continue;
    try {
      const a = await api.analyze(p);
      if (a.format?.projection !== 'fisheye') continue;
      list.push({ input: p, projection: 'fisheye', layout: a.format.layout, fov: (settings.calib?.[fileKey(p)] || {}).fov ?? 180,
        codec: ex.codec === 'copy' ? 'h264' : ex.codec, crf: ex.crf, encoder: ex.encoder, eyeSize: ex.size || 0, chapters: [] });
    } catch {}
  }
  if (list.length) await api.queueAdd(list);
  return list.length;
}
