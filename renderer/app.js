// App shell: title bar tabs, window buttons, fullscreen, mini-player, keyboard, drag & drop.
import { api, on, emit, settings, loadSettings, save } from './core.js';
import { h, svg, toast, ICONS, strip } from './ui.js';
import { sfx } from './sfx.js';
import { applyTheme, tabIndicator } from './themes.js';
import { comboOf, actionForCombo } from './shortcuts.js';

await loadSettings();

ICONS.mini = '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/>';
ICONS.restore = '<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14 9h4v4M18 9l-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';

const { player, view, video, initPlayer } = await import('./player.js');
const { initCalibrate } = await import('./calibrate.js');
const { initLibrary } = await import('./library.js');
const { initTogether } = await import('./together.js');
const { initSettings, applyAccent } = await import('./settings.js');
const { initJobs } = await import('./jobs.js');
const { initPhoneTab } = await import('./phone-tab.js');
const { startTour, maybeStartTour, tourState } = await import('./tour.js');
await import('./gamepad.js');

const $ = (id) => document.getElementById(id);
const page = (name) => document.querySelector(`.page[data-page=${name}]`);

applyTheme(settings.theme);
applyAccent(settings.accent);
document.body.classList.toggle('reduce-motion', !!settings.reduceMotion);
sfx.configure({
  on: settings.sfxOn !== false,
  volume: settings.sfxVolume ?? 40,
  // no clicks and chimes while you're watching fullscreen
  quietWhen: () => document.body.classList.contains('fs') && !video.paused
});

// ---------------------------------------------------------------- tabs
const TABS = [
  { id: 'player', icon: 'playtab', title: 'Player (1)', color: '#3c9a62' },
  { id: 'library', icon: 'layers', title: 'Library (2)', color: '#d0a43c' },
  { id: 'calibrate', icon: 'circle', title: 'Calibrate (3)', color: '#4a86d0' },
  { id: 'together', icon: 'users', title: 'Watch Together (4)', color: '#a07ae0' },
  { id: 'phone', icon: 'phone', title: 'Phone player (5)', color: '#4fc3d9' },
  { id: 'settings', icon: 'gear', title: 'Settings (6)', color: 'var(--text-2)' }
];
let activeTab = null;
const tabBtns = TABS.map((t) => {
  const b = h('button', { class: 'tab', title: t.title, html: svg(t.icon), onclick: () => showTab(t.id) });
  b.style.setProperty('--tc', t.color);
  return b;
});
$('tabs').append(...tabBtns);
tabIndicator($('tabs'));

// The video stage lives in the Player tab but moves into Calibrate's preview
function mountStage(target) {
  const stage = $('stage');
  if (stage.parentElement !== target) target.append(stage);
}
export function showTab(id) {
  if (activeTab === id) return;
  activeTab = id;
  TABS.forEach((t, i) => tabBtns[i].classList.toggle('active', t.id === id));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.dataset.page === id));
  mountStage(id === 'calibrate' ? $('calibStageSlot') : $('stageSlot'));
  save({ tab: id });
  emit('tab', id);
}
on('goto', showTab);

// ---------------------------------------------------------------- window buttons
const pinBtn = h('button', { class: 'wbtn', title: 'Keep on top', html: svg('pin'), onclick: async () => { const s = await api.win('pin'); pinBtn.classList.toggle('on', s.pinned); toast(s.pinned ? 'Window stays on top' : 'Window no longer on top'); } });
$('winBtns').append(
  h('button', { class: 'wbtn', title: 'Mini-player (Ctrl+M)', html: svg('mini'), onclick: () => emit('toggle-mini') }),
  pinBtn,
  h('button', { class: 'wbtn', title: 'Minimize', html: svg('min'), onclick: () => api.win('minimize') }),
  h('button', { class: 'wbtn', title: 'Maximize', html: svg('max'), onclick: () => api.win('maximize') }),
  h('button', { class: 'wbtn close', title: 'Close', html: svg('x'), onclick: () => { player.saveResume(); api.win('close'); } }));
$('titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) api.win('maximize'); });
initJobs($('winBtns'));

// ---------------------------------------------------------------- fullscreen
// The window itself goes fullscreen and the layout becomes video-only. The
// controls fade in only while the mouse is near the bottom (or over them), and
// briefly right after entering fullscreen.
function setFullscreenUI(fs) {
  document.body.classList.toggle('fs', fs);
  if (fs) { showTab('player'); revealUI(2500); }
  const btn = document.querySelector('#controls [title^="Fullscreen"]');
  if (btn) btn.innerHTML = svg(fs ? 'unfull' : 'full');
  sfx.play('whoosh');
  requestAnimationFrame(() => view.resize());
}
on('toggle-fullscreen', () => api.win('fullscreen'));
api.onFullscreen(setFullscreenUI);

// Only the mouse position brings the bar back: clicking or dragging the picture
// to look around never does, because in VR you grab the view constantly.
let hideTimer, pinnedUntil = 0, pointerY = 0, dragging = false;
const inZone = (y) => y > window.innerHeight * (1 - (settings.fsZone ?? 20) / 100);
const overControls = () => !!document.querySelector('#controls:hover, .popover:hover');
function revealUI(ms) {
  pinnedUntil = Math.max(pinnedUntil, Date.now() + (ms || 0));
  document.body.classList.add('show-ui');
  document.body.classList.remove('idle');
  scheduleHide();
}
function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (inZone(pointerY) || overControls() || document.querySelector('.popover') || Date.now() < pinnedUntil) return scheduleHide();
    document.body.classList.remove('show-ui');
    if (!dragging) document.body.classList.add('idle');
  }, Date.now() < pinnedUntil ? pinnedUntil - Date.now() + 50 : 700);
}
document.addEventListener('mousemove', (e) => {
  pointerY = e.clientY;
  dragging = e.buttons !== 0;
  document.body.classList.toggle('near-top', e.clientY < window.innerHeight * 0.1);
  if (inZone(e.clientY) || overControls()) revealUI();
  else { document.body.classList.remove('idle'); scheduleHide(); }
});
// Grabbing the view outside the zone cancels the brief "just entered fullscreen" reveal
document.addEventListener('pointerdown', (e) => {
  if (!inZone(e.clientY) && !e.target.closest('#controls, .popover')) { pinnedUntil = 0; scheduleHide(); }
});
document.addEventListener('pointerup', () => { dragging = false; });
document.addEventListener('mouseleave', () => { pointerY = 0; scheduleHide(); });
revealUI(2500);

// ---------------------------------------------------------------- mini-player
on('toggle-mini', () => api.win('mini'));
api.onMini((mini) => {
  document.body.classList.toggle('mini', mini);
  if (mini) showTab('player');
  sfx.play('whoosh');
  setTimeout(() => view.resize(), 260);
});
$('stage').append(h('div', { class: 'mini-bar' },
  h('div', { class: 'mini-drag', title: 'Drag to move' }),
  h('button', { class: 'wbtn', title: 'Back to full window', html: svg('restore'), onclick: () => emit('toggle-mini') }),
  h('button', { class: 'wbtn close', title: 'Close', html: svg('x'), onclick: () => { player.saveResume(); api.win('close'); } })));

// ---------------------------------------------------------------- pages
initPlayer();
initLibrary(page('library'));
initCalibrate(page('calibrate'));
initTogether(page('together'));
initSettings(page('settings'));
initPhoneTab(page('phone'), player);
showTab(settings.tab && settings.tab !== 'calibrate' ? settings.tab : 'player');
on('start-tour', startTour);
on('open-file', (p) => { showTab('player'); player.open([p]); });
maybeStartTour();

// A downloaded update waits for a restart
const showUpdate = (s) => {
  if (s && s.state === 'ready') strip.set('update', 5, {
    text: `Update ${s.version} is ready`,
    actions: [
      { label: 'Restart to update', onClick: () => api.updateInstall() },
      { label: 'Later', onClick: () => strip.clear('update') }
    ]
  });
};
api.updateStatus().then(showUpdate);
api.onUpdateStatus(showUpdate);

// Conversions that were running when the app closed or crashed: offer to finish them
api.queueRecovery().then((jobs) => {
  if (!jobs.length) return;
  strip.set('recovery', 6, {
    text: `${jobs.length} conversion${jobs.length > 1 ? 's' : ''} didn't finish last time`,
    actions: [
      { label: 'Resume', onClick: async () => { const n = await api.queueResume(); strip.clear('recovery'); toast(`Resuming ${n} conversion${n > 1 ? 's' : ''}`, 'ok'); } },
      { label: 'Discard', onClick: async () => { await api.queueDiscard(); strip.clear('recovery'); } }
    ]
  });
});

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  const t = e.target;
  // the command palette opens from anywhere, even while typing in a box
  if (!document.querySelector('.modal') && !tourState().open && comboOf(e) && actionForCombo(comboOf(e))?.id === 'palette') { e.preventDefault(); actionForCombo(comboOf(e)).run(); return; }
  if (document.querySelector('.modal') || tourState().open) return;
  if (t.tagName === 'INPUT' && t.type !== 'range' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') {
    if (e.key === 'Escape') t.blur();
    return;
  }
  if (document.body.classList.contains('capturing-key')) return; // Settings is recording a new shortcut
  // 1–6 always switch tabs
  if (!e.ctrlKey && !e.altKey && !e.metaKey && /^[1-6]$/.test(e.key)) { if (!document.body.classList.contains('fs') && !document.body.classList.contains('mini')) showTab(TABS[+e.key - 1].id); return; }
  const combo = comboOf(e);
  const action = combo && actionForCombo(combo);
  if (!action) return;
  e.preventDefault();
  action.run();
});
on('open-dialog', () => openDialog());

// ---------------------------------------------------------------- open files / drag & drop
async function openDialog() {
  const p = await api.openDialog();
  if (p.length) { showTab('player'); player.open(p); }
}
let dragDepth = 0;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); if (++dragDepth === 1) { showTab('player'); document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', (e) => { if (!isFileDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragend', () => { dragDepth = 0; document.body.classList.remove('dragging'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) player.open(paths);
});
api.onOpenPaths((paths) => { showTab('player'); player.open(paths); });

api.launchPaths().then((p) => { if (p.length) player.open(p); });

window.__app = { player, view, showTab, settings, sfx, startTour, tourState };
