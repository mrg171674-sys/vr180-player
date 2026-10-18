// Sleep timer: stop after a number of minutes, at the end of this video, or at
// the end of the playlist. The sound fades out over the last 10 seconds.
import { h, svg, popover, numBox, toast } from './ui.js';
import { fmtTime } from './core.js';

const FADE = 10;
let player, video, chip, btn;
const st = { mode: 'off', endAt: 0, baseVolume: 1, fading: false };
export const sleepState = st;

export function initSleep(p, button, chipEl) {
  player = p; video = p.video; btn = button; chip = chipEl;
  setInterval(tick, 250);
}

function set(mode, minutes) {
  restoreVolume();
  st.mode = mode;
  st.endAt = mode === 'minutes' ? Date.now() + minutes * 60000 : 0;
  btn.classList.toggle('on', mode !== 'off');
  render();
  if (mode !== 'off') toast(mode === 'minutes' ? `Sleep timer: ${minutes} min` : mode === 'video' ? 'Stopping at the end of this video' : 'Stopping at the end of the playlist', 'ok');
}
export const cancel = () => set('off');

// seconds left before playback stops, or null when it depends on nothing yet
function remaining() {
  if (st.mode === 'minutes') return (st.endAt - Date.now()) / 1000;
  const item = player.current();
  if (!item || item.info.isImage || !isFinite(video.duration)) return null;
  const left = (video.duration - video.currentTime) / (video.playbackRate || 1);
  if (st.mode === 'video') return left;
  if (st.mode === 'playlist') return player.state.index === player.state.playlist.length - 1 ? left : null;
  return null;
}

function tick() {
  if (st.mode === 'off') return;
  const r = remaining();
  render(r);
  if (r == null) return;
  if (r <= FADE && r > 0 && !video.paused) {
    if (!st.fading) { st.fading = true; st.baseVolume = video.volume; }
    video.volume = Math.max(0, st.baseVolume * (r / FADE));
  }
  if (r <= 0.15) finish();
}

// true when the end of the current video should stop playback instead of moving on
export function stopsAtEnd() {
  return st.mode === 'video' || (st.mode === 'playlist' && player.state.index === player.state.playlist.length - 1);
}

export function finish() {
  video.pause();
  restoreVolume();
  if (document.body.classList.contains('fs')) window.vr180.win('exit-fullscreen');
  set('off');
  toast('Sleep timer: playback stopped. Good night!');
}
function restoreVolume() {
  if (st.fading) { video.volume = st.baseVolume; st.fading = false; }
}

function render(r = remaining()) {
  chip.hidden = st.mode === 'off';
  if (st.mode === 'off') return;
  const label = st.mode === 'minutes' || r != null ? fmtTime(Math.max(0, r)) : st.mode === 'video' ? 'end of video' : 'end of playlist';
  chip.innerHTML = svg('moon') + `<span>${label}</span>`;
  chip.classList.toggle('ending', r != null && r <= FADE);
}

export function openSleepMenu() {
  let custom = 45;
  popover(btn, (close) => {
    const item = (label, fn, active) => h('button', { class: 'menu-item' + (active ? ' checked' : ''), onclick: () => { fn(); close(); } }, h('span', { class: 'dot' }), label);
    return [
      h('div', { class: 'menu-title' }, 'Sleep timer'),
      item('Off', () => set('off'), st.mode === 'off'),
      item('End of this video', () => set('video'), st.mode === 'video'),
      item('End of playlist', () => set('playlist'), st.mode === 'playlist'),
      ...[15, 30, 60, 90].map((m) => item(`${m} minutes`, () => set('minutes', m), false)),
      h('div', { class: 'menu-grid' }, h('span', {}, 'Custom'),
        h('div', { class: 'inline' }, numBox({ value: custom, min: 1, max: 600, step: 5, unit: 'min', width: 96, onChange: (v) => (custom = v) }),
          h('button', { class: 'btn', onclick: () => { set('minutes', custom); close(); } }, 'Start')))
    ];
  });
}
