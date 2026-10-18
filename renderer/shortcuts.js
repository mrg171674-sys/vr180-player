// Every player action that can have a keyboard shortcut or a controller button,
// with its default keys. Your own choices live in settings.keymap / settings.padmap.
import { api, emit, settings, save } from './core.js';
import { player, view, video } from './player.js';

const vol = (d) => { video.volume = Math.max(0, Math.min(1, video.volume + d)); player.osd(`Volume ${Math.round(video.volume * 100)}%`); };
const ipd = (d) => { if (player.current()) player.setCalib({ ipd: Math.round(((player.current().calib.ipd || 0) + d) * 10) / 10 }); };
const step = () => settings.seekStep || 10;

export const ACTIONS = [
  { id: 'play', label: 'Play / pause', keys: ['Space', 'K'], run: () => player.togglePlay() },
  { id: 'back', label: 'Back', keys: ['ArrowLeft', 'J'], run: () => player.seekBy(-step()) },
  { id: 'fwd', label: 'Forward', keys: ['ArrowRight'], run: () => player.seekBy(step()) },
  { id: 'volup', label: 'Volume up', keys: ['ArrowUp'], run: () => vol(0.05) },
  { id: 'voldown', label: 'Volume down', keys: ['ArrowDown'], run: () => vol(-0.05) },
  { id: 'mute', label: 'Mute', keys: ['M'], run: () => { video.muted = !video.muted; player.osd(video.muted ? 'Muted' : 'Sound on'); } },
  { id: 'fullscreen', label: 'Fullscreen', keys: ['F', 'F11'], run: () => api.win('fullscreen') },
  { id: 'exit', label: 'Leave fullscreen / mini-player', keys: ['Escape'], run: () => {
    if (document.body.classList.contains('fs')) api.win('exit-fullscreen');
    else if (document.body.classList.contains('mini')) emit('toggle-mini');
  } },
  { id: 'view', label: 'Cycle VR / flat / 3D / L|R', keys: ['V'], run: () => player.cycleView() },
  { id: 'flat', label: 'VR / flat', keys: [], run: () => player.setFlat(!player.state.flat) },
  { id: 'reset', label: 'Reset view', keys: ['R'], run: () => view.reset() },
  { id: 'zoomin', label: 'Zoom in', keys: ['+', '='], run: () => view.zoom(-5) },
  { id: 'zoomout', label: 'Zoom out', keys: ['-'], run: () => view.zoom(5) },
  { id: 'loop', label: 'Loop video', keys: ['L'], run: () => document.querySelector('#controls [title^="Loop video"]')?.click() },
  { id: 'ab', label: 'A-B loop', keys: ['Shift+A'], run: () => player.abLoop() },
  { id: 'bookmark', label: 'Add chapter', keys: ['B'], run: () => player.addBookmark() },
  { id: 'prevch', label: 'Previous chapter', keys: ['['], run: () => player.jumpBookmark(-1) },
  { id: 'nextch', label: 'Next chapter', keys: [']'], run: () => player.jumpBookmark(1) },
  { id: 'home', label: 'Back to start', keys: ['Home'], run: () => player.seekTo(0) },
  { id: 'next', label: 'Next video', keys: ['N'], run: () => player.next() },
  { id: 'prev', label: 'Previous video', keys: ['P'], run: () => player.prev() },
  { id: 'snapshot', label: 'Snapshot', keys: ['S'], run: () => player.snapshot() },
  { id: 'cc', label: 'Subtitles & audio menu', keys: ['C'], run: () => { if (player.current()) player.openCC(); } },
  { id: 'subminus', label: 'Subtitles earlier', keys: ['G'], run: () => player.nudgeSubs(-0.1) },
  { id: 'subplus', label: 'Subtitles later', keys: ['H'], run: () => player.nudgeSubs(0.1) },
  { id: 'ipdminus', label: 'IPD −', keys: [','], run: () => ipd(-0.1) },
  { id: 'ipdplus', label: 'IPD +', keys: ['.'], run: () => ipd(0.1) },
  { id: 'mini', label: 'Mini-player', keys: ['Ctrl+M'], run: () => emit('toggle-mini') },
  { id: 'open', label: 'Open video', keys: ['Ctrl+O'], run: () => emit('open-dialog') },
  { id: 'export', label: 'Convert to VR180', keys: ['Ctrl+E'], run: () => player.openExport() },
  { id: 'stats', label: 'Stats for nerds', keys: ['I'], run: () => player.toggleStats() },
  { id: 'depth', label: '2D → 3D on/off', keys: ['D'], run: () => player.toggleDepth() },
  { id: 'palette', label: 'Find a command (palette)', keys: ['Ctrl+K'], run: () => import('./palette.js').then((m) => m.openPalette()) },
  { id: 'help', label: 'Show keyboard shortcuts', keys: ['?'], run: () => import('./palette.js').then((m) => m.showShortcuts()) }
];
const byId = new Map(ACTIONS.map((a) => [a.id, a]));

// Shift only counts for letters and named keys: symbols like + already include it
const NAMES = { ' ': 'Space' };
export function comboOf(e) {
  let key = NAMES[e.key] || e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return null;
  if (key.length === 1) key = key.toUpperCase();
  const named = key.length > 1 || /[A-Z0-9]/.test(key);
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && named && 'Shift', key].filter(Boolean).join('+');
}
export const prettyKey = (c) => c.replace('ArrowLeft', '←').replace('ArrowRight', '→').replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('Escape', 'Esc');

export const keysFor = (id) => settings.keymap?.[id] ?? byId.get(id)?.keys ?? [];
export function actionForCombo(combo) {
  for (const a of ACTIONS) if (keysFor(a.id).includes(combo)) return a;
  return null;
}
export function setKeys(id, keys) { save({ keymap: { ...(settings.keymap || {}), [id]: keys } }); }
export function resetKeys() { save({ keymap: {} }); }
export const runAction = (id) => byId.get(id)?.run();

// ---- controller buttons (standard gamepad mapping)
export const PAD_BUTTONS = [
  [0, 'A / ✕'], [1, 'B / ○'], [2, 'X / □'], [3, 'Y / △'], [4, 'LB / L1'], [5, 'RB / R1'], [8, 'Back / Share'], [9, 'Start / Options'],
  [12, 'D-pad up'], [13, 'D-pad down'], [14, 'D-pad left'], [15, 'D-pad right'], [10, 'Left stick click'], [11, 'Right stick click']
];
export const PAD_DEFAULTS = { 0: 'play', 1: 'flat', 2: 'reset', 3: 'fullscreen', 4: 'prev', 5: 'next', 9: 'play', 12: 'volup', 13: 'voldown', 14: 'back', 15: 'fwd' };
export const padAction = (button) => (settings.padmap && button in settings.padmap ? settings.padmap[button] : PAD_DEFAULTS[button]) || null;
export function setPad(button, id) { save({ padmap: { ...(settings.padmap || {}), [button]: id || '' } }); }
