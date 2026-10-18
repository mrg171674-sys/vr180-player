// Shared state and helpers for every page.
export const api = window.vr180;

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));

export const settings = {};
let pending = {}, saveTimer;
export async function loadSettings() {
  Object.assign(settings, await api.getSettings());
  settings.resume ??= {};
  settings.bookmarks ??= {};
  settings.calib ??= {};
  settings.recent ??= [];
  settings.folders ??= [];
}
// Saves top-level keys (whole value is replaced on disk)
export function save(patch) {
  Object.assign(settings, patch);
  Object.assign(pending, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 300);
}
function flushSettings() {
  clearTimeout(saveTimer);
  if (Object.keys(pending).length) { api.setSettings(pending); pending = {}; }
}
// don't lose the last change when the window closes
window.addEventListener('beforeunload', flushSettings);

export const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};
export const baseName = (p) => p.split(/[\\/]/).pop();
// one key per file however its path is spelled (C:/a/b or C:\a\b)
export const fileKey = (p) => p.replace(/\//g, '\\').toLowerCase();
export const mediaUrl = (p) => `media://file/?p=${encodeURIComponent(p)}`;

export const FORMAT_NAMES = {
  projection: { fisheye: 'Fisheye 180', equirect180: 'Equirect 180', equirect360: '360°', flat: 'Flat 2D screen' },
  layout: { '2d': 'Mono', sbs: 'Side-by-side 3D', tb: 'Top-bottom 3D' }
};
export function resLabel(info, layout) {
  const w = layout === 'sbs' ? info.width : layout === 'tb' ? info.width * 2 : info.width;
  if (w >= 7600) return '8K';
  if (w >= 5600) return '5.7K';
  if (w >= 3800) return '4K';
  if (w >= 2500) return '3K';
  if (w >= 1900) return 'HD';
  return 'SD';
}

// ---- private vault
export const vaultState = { unlocked: false };
const slashes = (p) => p.toLowerCase().replace(/\//g, '\\');
const norm = (p) => slashes(p).replace(/\\+$/, '') + '\\';
export function isPrivatePath(p) {
  const lp = slashes(p);
  return settings.folders.some((f) => f.private && lp.startsWith(norm(f.path)));
}
export const isHidden = (p) => !vaultState.unlocked && isPrivatePath(p);
