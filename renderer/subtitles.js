// Subtitles: sidecar .srt/.vtt files, tracks stored inside the video, or a file
// you pick. Shown as an overlay on the desktop and as a floating panel in VR.
import { api, on, emit, settings, save, baseName } from './core.js';
import { toast } from './ui.js';

const DEFAULT_STYLE = { size: 100, height: 0, bg: 55, offset: 0 };
export const subs = { tracks: [], current: null, cues: [], style: { ...DEFAULT_STYLE } };
let video, view, overlay, lastText = null;

// ---------------------------------------------------------------- parsing
const toSec = (s) => {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(s);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
};
export function parseSubs(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const start = toSec(a), end = toSec(z);
    if (isNaN(start) || isNaN(end)) continue;
    const textLines = lines.slice(ti + 1).map((l) => l.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim()).filter(Boolean);
    if (textLines.length) cues.push({ start, end, text: textLines.join('\n') });
  }
  return cues.sort((p, q) => p.start - q.start);
}

// ---------------------------------------------------------------- tracks
async function refreshTracks(item, pick) {
  subs.tracks = [];
  subs.current = null;
  subs.cues = [];
  render(true);
  if (!item) return emit('subs-tracks', subs);
  const files = await api.subsFind(item.path).catch(() => []);
  subs.tracks.push(...files.map((f) => ({ ...f, id: 'f:' + f.path })));
  for (const s of item.info.subtitles || []) {
    subs.tracks.push({ kind: 'embedded', index: s.index, id: 'e:' + s.index, label: `${s.lang === 'und' ? 'Track ' + (s.index + 1) : s.lang.toUpperCase()} (in video)` });
  }
  emit('subs-tracks', subs);
  if (pick) return select('f:' + pick);
  if (settings.subsAuto !== false && subs.tracks.length) select(subs.tracks[0].id, true);
}
// An AI subtitle job finished for the video that's open: list it and switch to it
export function reloadTracks(pick) { if (subs.item) return refreshTracks(subs.item, pick); }

export async function select(id, quiet) {
  if (!id) { subs.current = null; subs.cues = []; render(true); emit('subs-tracks', subs); return; }
  const t = subs.tracks.find((x) => x.id === id);
  if (!t) return;
  try {
    const text = t.kind === 'embedded' ? await api.subsExtract(currentPath(), t.index) : await api.subsRead(t.path);
    subs.cues = parseSubs(text);
    subs.current = id;
    if (!quiet) toast(`Subtitles: ${t.label} (${subs.cues.length} lines)`, 'ok');
  } catch (e) {
    toast('Could not load subtitles: ' + String(e.message).replace(/.*Error: /, ''), 'err');
  }
  lastText = null;
  render(true);
  emit('subs-tracks', subs);
}

export async function loadFile(path) {
  const id = 'f:' + path;
  if (!subs.tracks.some((t) => t.id === id)) subs.tracks.push({ kind: 'file', path, id, label: baseName(path) });
  await select(id);
}
export async function pickFile() {
  const p = await api.subsDialog();
  if (p) loadFile(p);
}

export function setStyle(patch) {
  Object.assign(subs.style, patch);
  save({ subStyle: { ...subs.style } });
  applyStyle();
  render(true);
}
export function nudge(delta) {
  setStyle({ offset: Math.round((subs.style.offset + delta) * 10) / 10 });
  emit('osd', `Subtitle timing ${subs.style.offset > 0 ? '+' : ''}${subs.style.offset.toFixed(1)} s`);
}

// ---------------------------------------------------------------- display
function applyStyle() {
  if (!overlay) return;
  overlay.style.setProperty('--sub-size', subs.style.size / 100);
  overlay.style.setProperty('--sub-lift', subs.style.height + '%');
  overlay.style.setProperty('--sub-bg', subs.style.bg / 100);
}
function activeText() {
  if (!subs.cues.length || !video) return '';
  const t = video.currentTime - subs.style.offset;
  // binary search for the last cue starting before t, then gather overlaps
  let lo = 0, hi = subs.cues.length - 1, idx = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (subs.cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
  const out = [];
  for (let i = idx; i >= 0 && i > idx - 6; i--) if (subs.cues[i].end > t) out.unshift(subs.cues[i].text);
  return out.join('\n');
}
function render(force) {
  const text = activeText();
  if (!force && text === lastText) return;
  lastText = text;
  if (overlay) {
    overlay.replaceChildren(...(text ? text.split('\n').map((l) => { const s = document.createElement('span'); s.textContent = l; return s; }) : []));
    overlay.classList.toggle('show', !!text);
  }
  view?.setSubtitle(text, subs.style);
}

const currentPath = () => subs.item?.path;

export function initSubtitles(v, vr) {
  video = v;
  view = vr;
  Object.assign(subs.style, DEFAULT_STYLE, settings.subStyle);
  overlay = document.createElement('div');
  overlay.id = 'subs';
  document.getElementById('stage').append(overlay);
  applyStyle();
  on('item', (item) => { subs.item = item; refreshTracks(item); });
  video.addEventListener('timeupdate', () => render());
  video.addEventListener('seeked', () => render());
  (function loop() { if (!video.paused) render(); requestAnimationFrame(loop); })();
}
