import { api, emit, on, settings, save, fmtTime, baseName, fileKey, mediaUrl, FORMAT_NAMES, isPrivatePath, isHidden } from './core.js';
import { h, svg, iconBtn, segmented, numBox, select, toast, strip, card, popover, toggle } from './ui.js';
import { VRView, DEFAULT_CALIB } from './vrview.js';
import { SpatialAudio, AmbiFold } from './spatial-audio.js';
import { subs, initSubtitles, select as selectSubs, pickFile as pickSubs, setStyle as setSubStyle, nudge as nudgeSubs, loadFile as loadSubsFile, reloadTracks } from './subtitles.js';
import { initDepth, updateDepth, depthCfg, setDepthCfg, depthActive, depthStats } from './depth.js';
import { initAi, makeSubtitles, upscale as aiUpscale, ensure as aiEnsure, make3DFile } from './ai.js';
import { initReframe, openReframe } from './reframe.js';
import { VRPanel } from './vrpanel.js';
import { openExportDialog } from './export.js';
import { sfx } from './sfx.js';
import { applyLook } from './lut.js';
import { openEditor } from './editor.js';
import * as ax from './audio-extras.js';
import { initSleep, openSleepMenu, stopsAtEnd as sleepStopsAtEnd, finish as sleepFinish } from './sleep.js';
import { initPip, openPipMenu } from './pip.js';
import { initSlideshow, onShown as slideshowShown, advance as slideAdvance, slideshow, openSlideshowMenu, stop as slideStop } from './slideshow.js';

const $ = (id) => document.getElementById(id);
export const video = $('video');
const stage = $('stage');
export const view = new VRView($('vrCanvas'), video);

const state = { playlist: [], index: -1, flat: false, mode: 'vr', ab: { a: null, b: null }, remote: false };
export const player = { state, view, video, subs };
const cur = () => state.playlist[state.index];
player.current = cur;
const isMono = () => !!cur() && cur().format.layout === '2d';
// real 3D, or a flat source that 2D → 3D is adding depth to
const is3D = () => !!cur() && (!isMono() || depthActive());

// ---------------------------------------------------------------- loading
export async function open(paths, { play = true, known = null } = {}) {
  const start = state.playlist.length;
  for (const p of paths) {
    if (/\.(srt|vtt)$/i.test(p)) { if (cur()) loadSubsFile(p); continue; }
    if (isHidden(p)) continue; // locked vault: private files can't be opened
    const existing = state.playlist.findIndex((it) => fileKey(it.path) === fileKey(p));
    if (existing >= 0) { if (play && paths.length === 1) return load(existing); continue; }
    try {
      const cached = known?.get(fileKey(p));
      if (!cached) showBusy(`Reading ${baseName(p)}…`);
      const info = cached && cached.format && !cached.failed ? cached : await api.analyze(p);
      const mine = settings.formats?.[fileKey(p)];
      state.playlist.push({ path: p, name: baseName(p), info: mine ? { ...info, detectedBy: 'your choice for this file', confidence: 'high' } : info, format: { ...info.format, ...mine }, playPath: p });
      if (!isPrivatePath(p)) remember(p);
    } catch (e) {
      toast(`Can't open ${baseName(p)}: ${cleanErr(e)}`, 'err');
    } finally { hideBusy(); }
  }
  renderPlaylist();
  if (play && state.playlist.length > start) await load(start);
}
player.open = open;
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[\w-]+': (Error: )?/, '');

function remember(p) {
  save({ recent: [p, ...settings.recent.filter((x) => fileKey(x) !== fileKey(p))].slice(0, 8) });
  api.addRecent?.(p);
}

// ---------------------------------------------------------------- Windows: media keys, the media overlay, taskbar buttons
// The play/pause/next keys on keyboards and headphones work, Windows' volume overlay shows
// what's playing, and the taskbar thumbnail gets previous / play / next buttons.
function syncSystemControls() {
  const item = cur();
  api.thumbState?.({ loaded: !!item, playing: !!item && !video.paused, hasPrev: state.index > 0 || video.currentTime > 3, hasNext: state.index < state.playlist.length - 1 });
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  if (!item) { ms.metadata = null; return; }
  if (ms.metadata?.title !== item.name) ms.metadata = new MediaMetadata({ title: item.name, artist: 'VR180 Player', album: FORMAT_NAMES.projection[item.format.projection] || '' });
  ms.playbackState = video.paused ? 'paused' : 'playing';
  try { if (video.duration && isFinite(video.duration)) ms.setPositionState({ duration: video.duration, position: Math.min(video.duration, video.currentTime), playbackRate: video.playbackRate || 1 }); } catch {}
}
if ('mediaSession' in navigator) {
  const on = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  on('play', () => { if (video.paused) togglePlay(); });
  on('pause', () => { if (!video.paused) togglePlay(); });
  on('previoustrack', () => prev());
  on('nexttrack', () => next());
  on('seekbackward', (d) => seekBy(-(d.seekOffset || settings.seekStep || 10)));
  on('seekforward', (d) => seekBy(d.seekOffset || settings.seekStep || 10));
  on('seekto', (d) => { if (d.seekTime != null) seekTo(d.seekTime, false); });
}
for (const ev of ['play', 'pause', 'loadedmetadata', 'seeked', 'emptied']) video.addEventListener(ev, () => syncSystemControls());
setInterval(() => { if (!video.paused) syncSystemControls(); }, 5000);
api.onThumb?.((cmd) => { if (cmd === 'toggle') togglePlay(); else if (cmd === 'prev') prev(); else if (cmd === 'next') next(); });

let loadToken = 0;
async function load(i) {
  const item = state.playlist[i];
  if (!item) return;
  if (isHidden(item.path)) return;
  saveResume();
  state.index = i;
  state.ab = { a: null, b: null };
  sprite = null;
  const token = ++loadToken;
  stage.classList.add('loaded');
  document.title = `${item.name} · VR180 Player`;
  // this video's own settings, else its camera's, else your default
  const own = settings.calib[fileKey(item.path)];
  if (!own && settings.cameraCalib && Object.keys(settings.cameraCalib).length && item.camera === undefined) {
    item.camera = await api.cameraOf(item.path).catch(() => null);
    if (token !== loadToken) return;
  }
  item.calib = { ...DEFAULT_CALIB, ...(own || (item.camera && settings.cameraCalib?.[item.camera]) || settings.calibDefault) };
  // Chapters stored in the file become bookmarks the first time it is opened
  if (!settings.bookmarks[fileKey(item.path)] && item.info.chapters?.length) {
    save({ bookmarks: { ...settings.bookmarks, [fileKey(item.path)]: item.info.chapters.map((c) => ({ t: c.t, name: c.name })) } });
  }
  item.level = settings.level?.[fileKey(item.path)] || null;
  applyFormat();
  view.setCalib(item.calib);
  applyLook(view, item.calib).catch(() => {});
  view.reset();
  renderPlaylist();
  renderChapters();
  showHint();
  setViewMode(settings.defaultView === 'flat' && item.format.projection !== 'flat' ? 'flat' : 'vr');
  emit('item', item);
  syncSystemControls();

  // ---- photos: shown in the same view, no playback
  if (item.info.isImage) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    document.body.classList.add('photo-mode');
    try {
      const src = await loadPhoto(item);
      if (token !== loadToken) return;
      view.setSource(src);
      $('photoFlat').src = mediaUrl(item.path);
    } catch (e) {
      toast(`Couldn't open this photo: ${cleanErr(e)}`, 'err');
    }
    renderTrack();
    emit('loaded', item);
    slideshowShown(item);
    return;
  }
  document.body.classList.remove('photo-mode');
  view.setSource(video);

  let ok = await tryPlay(item.playPath);
  if (token !== loadToken) return;
  if (!ok) {
    // Chromium can't decode this codec; make an H.264 preview copy with ffmpeg
    showBusy(`This video's codec (${item.info.codec.toUpperCase()}) can't be decoded directly. Making a preview copy…`, true);
    try {
      item.playPath = await api.makeProxy('proxy', item.path);
      if (token !== loadToken) return;
      ok = await tryPlay(item.playPath);
      if (!ok) throw new Error('Preview could not be played');
    } catch (e) {
      toast(`Couldn't play this video: ${cleanErr(e)}`, 'err');
    } finally { hideBusy(); }
  }
  if (ok && token === loadToken) {
    // Chromium reports the displayed size (after rotation and pixel aspect); ffmpeg's is the coded size
    if (video.videoWidth && (video.videoWidth !== item.info.width || video.videoHeight !== item.info.height)) {
      item.display = { w: video.videoWidth, h: video.videoHeight };
      applyFormat();
    }
    view.updateTexel();
    const r = settings.resumeOn !== false && settings.resume[fileKey(item.path)];
    if (r && r.t > 10 && r.t < (video.duration || r.d) - 10 && !state.remote) {
      video.currentTime = r.t;
      osd(`Resumed at ${fmtTime(r.t)} · Home to restart`);
    }
    // watched further on a phone more recently? offer to continue from there
    strip.clear('xresume');
    const rr = settings.remoteResume?.[fileKey(item.path)];
    if (rr && rr.t > 10 && rr.t < (video.duration || rr.d) - 10 && rr.at > (r?.at || 0) && Math.abs(rr.t - video.currentTime) > 5 && !state.remote) {
      strip.set('xresume', 4, {
        text: `Continue from ${fmtTime(rr.t)}, where you stopped on ${rr.dev}?`,
        actions: [
          { label: 'Continue', onClick: () => { video.currentTime = rr.t; strip.clear('xresume'); osd(`Continued at ${fmtTime(rr.t)}`); } },
          { label: 'Not now', onClick: () => strip.clear('xresume') }
        ]
      });
    }
    routeAudio();
    renderTrack();
    loadSprite(item, token);
    emit('loaded', item);
    notify('load');
  }
}
player.load = load;

// Photo -> image (or, for Google VR photos, a canvas with both eyes side by side)
function loadImage(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('the image could not be decoded'));
    img.src = mediaUrl(path);
  });
}
async function loadPhoto(item) {
  const left = await loadImage(item.path);
  if (!item.info.photo?.rightEye) return left;
  const right = await loadImage(item.info.photo.rightEye);
  const c = document.createElement('canvas');
  c.width = left.naturalWidth * 2;
  c.height = left.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(left, 0, 0);
  g.drawImage(right, left.naturalWidth, 0, left.naturalWidth, left.naturalHeight);
  return c;
}

function tryPlay(p) {
  return new Promise((resolve) => {
    const done = (v) => { video.removeEventListener('loadeddata', onData); video.removeEventListener('error', onErr); clearTimeout(t); resolve(v); };
    const onData = () => done(video.videoWidth > 0);
    const onErr = () => done(false);
    video.addEventListener('loadeddata', onData);
    video.addEventListener('error', onErr);
    const t = setTimeout(() => done(video.videoWidth > 0), 10000);
    video.src = mediaUrl(p);
    if (!state.remote) video.play().catch(() => {});
  });
}

function showBusy(text, withBar) {
  $('busy').hidden = false;
  $('busyText').textContent = text;
  $('busyBar').parentElement.style.display = withBar ? '' : 'none';
  $('busyBar').style.width = '0';
}
const hideBusy = () => ($('busy').hidden = true);

// ---------------------------------------------------------------- format & view
// Half-width 3D movies (HSBS / HOU) squeeze each eye; they're meant to be shown at the
// full frame's shape. Auto: a flat SBS eye narrower than 1.2:1, or a TB eye wider than 2.5:1.
export function isHalf3D(item = cur()) {
  if (!item) return false;
  const f = item.format;
  if (f.half != null) return !!f.half;
  if (f.projection !== 'flat' || f.layout === '2d') return false;
  const { w, h } = item.display || { w: item.info.width, h: item.info.height };
  return f.layout === 'sbs' ? w / 2 / h < 1.2 : w / (h / 2) > 2.5;
}
export function eyeAspect(item = cur()) {
  if (!item) return 16 / 9;
  const { w, h } = item.display || { w: item.info.width, h: item.info.height };
  const l = item.format.layout;
  if (isHalf3D(item)) return w / h;
  return (l === 'sbs' ? w / 2 : w) / (l === 'tb' ? h / 2 : h);
}
function applyFormat() {
  const item = cur();
  if (!item) return;
  const f = item.format;
  view.setFormat({ ...f, eyeAspect: eyeAspect(item) });
  pills.projection.set(f.projection);
  pills.layout.set(f.layout);
  pills.fov.set(item.calib?.fov ?? 180);
  pills.fov.classList.toggle('disabled', f.projection !== 'fisheye');
  updateDepth(f.layout === '2d');
  refreshDepthUi();
  const dims = item.display || { w: item.info.width, h: item.info.height };
  ctl.fmt.textContent = `${dims.w}×${dims.h} · ${item.info.codec.toUpperCase()} · ${FORMAT_NAMES.projection[f.projection]} · ${FORMAT_NAMES.layout[f.layout]}${isHalf3D(item) ? ' (half)' : ''}${item.info.hdr ? ' · HDR' : ''}${item.info.ambisonic ? ' · Spatial audio' : ''}`;
  ctl.fmt.title = settings.formats?.[fileKey(item.path)] ? 'The format you chose for this file. Change it in the bar above.' : `Detected automatically (${item.info.detectedBy}). Change it in the bar above if it's wrong.`;
  pills.convert.disabled = !(f.projection === 'fisheye' || f.projection === 'equirect180' || f.projection === 'equirect360') || !!item.info.isImage;
  pills.edit.disabled = !!item.info.isImage;
  pills.flatvid.disabled = !!item.info.isImage || f.projection === 'flat';
  // only guessing: say so, and let one click confirm it
  if (item.info.confidence === 'low' && !settings.formats?.[fileKey(item.path)]) {
    strip.set('format', 3, { text: `Not sure what kind of video this is. Guessed: ${FORMAT_NAMES.projection[f.projection]} · ${FORMAT_NAMES.layout[f.layout]}. If it looks wrong, pick the right type in the bar at the top.`,
      actions: [{ label: 'Looks right', onClick: () => { rememberFormat(item); strip.clear('format'); } }] });
  } else if (f.projection === 'fisheye') {
    strip.set('format', 1, { text: `${FORMAT_NAMES.projection.fisheye} ${FORMAT_NAMES.layout[f.layout]} detected`, action: 'Convert to VR180', onAction: openExport });
  } else strip.clear('format');
}
// a format you pick (or confirm) is remembered for that file
function rememberFormat(item) {
  save({ formats: { ...settings.formats, [fileKey(item.path)]: { projection: item.format.projection, layout: item.format.layout } } });
}
export function setFormat(patch) {
  const item = cur();
  if (!item) return;
  Object.assign(item.format, patch);
  rememberFormat(item);
  applyFormat();
  sprite = null;
  loadSprite(item, loadToken);
  emit('format', item);
}
player.setFormat = setFormat;

export function setCalib(patch, persist = true) {
  const item = cur();
  if (!item) return;
  item.calib = { ...DEFAULT_CALIB, ...item.calib, ...patch };
  view.setCalib(item.calib);
  const lookChanged = 'lut' in patch || 'pictureOn' in patch;
  if (!lookChanged && 'lutMix' in patch) view.setLutMix(item.calib.pictureOn !== false && item.calib.lut ? item.calib.lutMix : 0);
  if ('fov' in patch) pills.fov.set(item.calib.fov);
  if ('ipd' in patch) pills.ipd.set(item.calib.ipd);
  if ('scale' in patch) pills.scale.set(item.calib.scale);
  if (persist) save({ calib: { ...settings.calib, [fileKey(item.path)]: item.calib } });
  emit('calib', item.calib);
  if (lookChanged) return applyLook(view, item.calib);
}
player.setCalib = setCalib;

// ---------------------------------------------------------------- horizon auto-level
// level = { mode: 'off' | 'fixed' | 'follow', interval, rolls[], fixed }, saved per video
player.level = () => cur()?.level || null;
function saveLevel(item) {
  save({ level: { ...settings.level, [fileKey(item.path)]: item.level } });
  emit('level', item.level);
}
player.setLevel = (lv) => { const item = cur(); if (!item) return; item.level = lv; saveLevel(item); };
player.setLevelMode = (mode) => { const item = cur(); if (!item?.level) return; item.level.mode = mode; saveLevel(item); };
// the view turns the dome the opposite way to how the analysis measures tilt
const LEVEL_VIEW_SIGN = 1;
export function levelAt(lv, t) {
  if (!lv || lv.mode === 'off') return 0;
  if (lv.mode === 'fixed' || !lv.rolls?.length) return lv.fixed || 0;
  const i = Math.min(lv.rolls.length - 1, Math.max(0, t / lv.interval));
  const i0 = Math.floor(i), f = i - i0;
  return lv.rolls[i0] * (1 - f) + (lv.rolls[i0 + 1] ?? lv.rolls[i0]) * f;
}
(function levelLoop() {
  view.setLevelRoll(LEVEL_VIEW_SIGN * levelAt(cur()?.level, video.currentTime || 0));
  requestAnimationFrame(levelLoop);
})();

// 'vr' | 'flat' | 'anaglyph' (red/cyan glasses) | 'sbs' (both eyes side by side)
export function setViewMode(mode) {
  if ((mode === 'anaglyph' || mode === 'sbs') && !is3D()) mode = 'vr';
  state.mode = mode;
  state.flat = mode === 'flat';
  stage.classList.toggle('flat', state.flat);
  if (!state.flat) view.setMode(mode);
  pills.view?.set(mode);
  emit('view-mode', mode);
}
player.setViewMode = setViewMode;
player.setFlat = (flat) => setViewMode(flat ? 'flat' : 'vr');
player.cycleView = () => {
  const modes = is3D() ? ['vr', 'flat', 'anaglyph', 'sbs'] : ['vr', 'flat'];
  const next = modes[(modes.indexOf(state.mode) + 1) % modes.length];
  setViewMode(next);
  osd({ vr: 'VR view', flat: 'Flat view', anaglyph: 'Anaglyph 3D (red/cyan glasses)', sbs: 'Side-by-side eyes' }[next]);
};

// ---------------------------------------------------------------- playback
// Local user actions are announced so Watch Together can mirror them
function notify(kind) { if (!state.remote) emit('user-action', { kind }); }
player.snapshotState = () => ({ paused: video.paused, time: video.currentTime, rate: video.playbackRate });

export function togglePlay() {
  if (!cur()) return;
  if (video.paused) { ensureAudio(); video.play(); } else video.pause();
  notify('play');
}
export function seekTo(t, announce = true) {
  if (!cur() || !isFinite(video.duration)) return;
  video.currentTime = Math.max(0, Math.min(video.duration - 0.05, t));
  renderTrack();
  if (announce) notify('seek');
}
export const seekBy = (s) => (cur()?.info.isImage ? slideAdvance(s > 0 ? 1 : -1) : seekTo(video.currentTime + s));
export function setRate(r) { video.playbackRate = r; pills.speed.set(String(r)); notify('rate'); }
export const next = () => state.index < state.playlist.length - 1 && load(state.index + 1);
export const prev = () => (video.currentTime > 3 || state.index <= 0 ? seekTo(0) : load(state.index - 1));
Object.assign(player, { togglePlay, seekTo, seekBy, setRate, next, prev });
player.playlist = () => state.playlist;
player.index = () => state.index;
player.playAt = (i) => (i >= 0 && i < state.playlist.length ? load(i) : null);

// Apply a state received from Watch Together without echoing it back
player.applyRemote = (s) => {
  state.remote = true;
  try {
    if (s.rate && video.playbackRate !== s.rate) { video.playbackRate = s.rate; pills.speed.set(String(s.rate)); }
    if (typeof s.time === 'number' && Math.abs(video.currentTime - s.time) > (s.tolerance ?? 0.4)) video.currentTime = s.time;
    if (s.paused === true && !video.paused) video.pause();
    if (s.paused === false && video.paused) video.play().catch(() => {});
  } finally { setTimeout(() => (state.remote = false), 50); }
};

// ---------------------------------------------------------------- audio
// Video sound goes through Web Audio: boost past 100%, and spatial (ambisonic) audio.
const audio = { ctx: null, src: null, gain: null, spatial: null };
player.audio = audio;
function ensureAudio() {
  if (audio.ctx) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
  try {
    audio.ctx = new AudioContext();
    audio.src = audio.ctx.createMediaElementSource(video);
    audio.gain = audio.ctx.createGain();
    audio.gain.connect(audio.ctx.destination);
    setBoost(settings.boost || 100);
    routeAudio();
    ax.apply();
  } catch {}
}
// source (video, or the "ahead" copy when sound runs late) -> sync delay -> spatial or plain -> boost
function routeAudio() {
  if (!audio.ctx) return;
  for (const n of [audio.src, audio.delay]) try { n?.disconnect(); } catch {}
  try { ax.inputNode()?.disconnect(); } catch {}
  audio.spatial?.disconnect();
  audio.spatial = null;
  audio.fold?.disconnect();
  audio.fold = null;
  if (!audio.delay) audio.delay = audio.ctx.createDelay(2.5);
  ax.inputNode().connect(audio.delay);
  const out = ax.chainInput?.() || audio.gain;
  if (cur()?.info.ambisonic && settings.spatialOn !== false) audio.spatial = new SpatialAudio(audio.ctx, audio.delay, out);
  else if (cur()?.info.ambisonic) audio.fold = new AmbiFold(audio.ctx, audio.delay, out);
  else audio.delay.connect(out);
  pills.cc?.classList.toggle('spatial', !!audio.spatial);
}
player.routeAudio = routeAudio;
player.audioTrack = ax.selectedTrack;
on('loaded', (item) => {
  if (item.info.isImage) return;
  const t = settings.audioTrack?.[fileKey(item.path)];
  if (t != null) ax.setTrack(t, false);
  ax.apply();
});
export function setBoost(pct) {
  save({ boost: pct });
  if (audio.gain) audio.gain.gain.value = pct / 100;
}
player.setBoost = setBoost;
video.addEventListener('play', ensureAudio);
// Keep the sound field pointing the right way as you look around
(function spatialLoop() {
  if (audio.spatial) audio.spatial.setMatrix(view.audioMatrix());
  requestAnimationFrame(spatialLoop);
})();

// Resume positions
function saveResume() {
  const item = cur();
  if (!item || !isFinite(video.duration) || !video.duration) return;
  const k = fileKey(item.path);
  const resume = { ...settings.resume, [k]: { t: video.currentTime, d: video.duration, at: Date.now() } };
  const keys = Object.keys(resume);
  if (keys.length > 400) keys.sort((a, b) => resume[a].at - resume[b].at).slice(0, keys.length - 400).forEach((x) => delete resume[x]);
  save({ resume });
}
player.saveResume = saveResume;
let lastResumeSave = 0;
video.addEventListener('timeupdate', () => { if (Date.now() - lastResumeSave > 5000) { lastResumeSave = Date.now(); saveResume(); } });
video.addEventListener('pause', saveResume);
window.addEventListener('beforeunload', saveResume);

// A-B loop: first press sets A, second sets B, third clears
export function abLoop() {
  if (!cur()) return;
  const ab = state.ab;
  if (ab.a == null) { ab.a = video.currentTime; osd(`Loop start ${fmtTime(ab.a)} · Shift+A again for the end`); }
  else if (ab.b == null) {
    ab.b = video.currentTime;
    if (ab.b <= ab.a + 0.3) { ab.a = ab.b = null; osd('Loop cleared'); }
    else osd(`Looping ${fmtTime(ab.a)} – ${fmtTime(ab.b)} · export it with Convert`);
  } else { ab.a = ab.b = null; osd('Loop cleared'); }
  ctl.ab.classList.toggle('on', ab.a != null);
  renderTrack();
}
player.abLoop = abLoop;
setInterval(() => {
  const { a, b } = state.ab;
  if (a != null && b != null && video.currentTime >= b) video.currentTime = a;
}, 40);

// ---------------------------------------------------------------- chapters (named bookmarks)
export function chapters() {
  if (!cur()) return [];
  const raw = settings.bookmarks[fileKey(cur().path)] || [];
  return raw.map((b, i) => (typeof b === 'number' ? { t: b, name: `Chapter ${i + 1}` } : b)).sort((a, b) => a.t - b.t);
}
player.chapters = chapters;
function saveChapters(list) {
  save({ bookmarks: { ...settings.bookmarks, [fileKey(cur().path)]: list.sort((a, b) => a.t - b.t) } });
  renderTrack(true);
  renderChapters();
  emit('chapters');
}
export function addBookmark() {
  if (!cur()) return;
  const t = Math.round(video.currentTime * 10) / 10;
  const list = chapters().filter((x) => Math.abs(x.t - t) > 1);
  const name = `Chapter ${list.length + 1}`;
  saveChapters([...list, { t, name }]);
  osd(`${name} at ${fmtTime(t)} · rename it in the Chapters list`);
  showSidebar('chapters');
  setTimeout(() => startRename(t), 50);
}
function removeBookmark(t) { saveChapters(chapters().filter((x) => x.t !== t)); }
function renameBookmark(t, name) { saveChapters(chapters().map((x) => (x.t === t ? { ...x, name: name.trim() || x.name } : x))); }
export function jumpBookmark(dir) {
  const t = video.currentTime;
  const list = chapters();
  const target = dir > 0 ? list.find((x) => x.t > t + 0.5) : [...list].reverse().find((x) => x.t < t - 1.5);
  if (target) { seekTo(target.t); osd(`${target.name} · ${fmtTime(target.t)}`); }
}
const chapterAt = (t) => [...chapters()].reverse().find((c) => c.t <= t + 0.05);
Object.assign(player, { addBookmark, jumpBookmark, removeBookmark, renameBookmark });

// Snapshot of what you see (VR view) or the raw frame (flat view)
export async function snapshot() {
  const item = cur();
  if (!item) return;
  let url;
  if (state.flat) {
    const src = item.info.isImage ? $('photoFlat') : video;
    const w = item.info.isImage ? src.naturalWidth : video.videoWidth, h = item.info.isImage ? src.naturalHeight : video.videoHeight;
    if (!w || !h) return toast('Nothing to snapshot yet.', 'err');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0);
    url = c.toDataURL('image/png');
  } else url = view.snapshot();
  const file = await api.saveSnapshot(url, item.name.replace(/\.[^.]+$/, ''));
  sfx.play('shutter');
  osd('Snapshot saved to Pictures\\VR180 Player');
  stage.animate([{ boxShadow: 'inset 0 0 0 400px #fff8' }, { boxShadow: 'inset 0 0 0 0 #fff0' }], 300);
  return file;
}
player.snapshot = snapshot;

let osdTimer;
export function osd(text) {
  const el = $('osd');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
player.osd = osd;
on('osd', osd);

let hintTimer;
function showHint() {
  $('hint').classList.remove('gone');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => $('hint').classList.add('gone'), 3500);
}

// ---------------------------------------------------------------- pill bar
const pills = {};
function buildPillbar() {
  pills.projection = select([
    { value: 'fisheye', label: 'Fisheye 180' }, { value: 'equirect180', label: 'Equirect 180' },
    { value: 'equirect360', label: '360°' }, { value: 'flat', label: 'Flat 2D' }
  ], 'fisheye', (v) => setFormat({ projection: v }));
  pills.layout = select([
    { value: '2d', label: 'Mono' }, { value: 'sbs', label: 'Side-by-side' }, { value: 'tb', label: 'Top-bottom' }
  ], '2d', (v) => setFormat({ layout: v }));
  pills.fov = numBox({ value: 180, min: 120, max: 240, step: 1, unit: '° FOV', onChange: (v) => setCalib({ fov: v }) });
  pills.view = segmented([
    { value: 'vr', label: 'VR', title: 'Look around inside the video' },
    { value: 'flat', label: 'Flat', title: 'The raw video frame' },
    { value: 'anaglyph', label: '3D', title: 'Anaglyph: watch 3D on a normal monitor with red/cyan glasses' },
    { value: 'sbs', label: 'L|R', title: 'Both eyes side by side, for checking alignment or cross-eye viewing' }
  ], 'vr', setViewMode);
  pills.depth = h('button', { class: 'btn depth-btn', hidden: true, title: '2D → 3D: add depth to this flat video or photo (D)', onclick: () => openDepth() }, '2D→3D');
  pills.ipd = numBox({ value: 0, min: -8, max: 8, step: 0.1, unit: '° IPD', onChange: (v) => setCalib({ ipd: v }) });
  pills.scale = numBox({ value: 100, min: 50, max: 200, step: 5, unit: '% Scale', onChange: (v) => setCalib({ scale: v }) });
  pills.speed = select(['0.25', '0.5', '0.75', '1', '1.25', '1.5', '2', '3'].map((v) => ({ value: v, label: v + '×' })), '1', (v) => setRate(+v));
  pills.cc = h('button', { class: 'btn cc-btn', title: 'Subtitles & audio (C)', onclick: () => openCC() }, 'CC');
  pills.xr = h('button', { class: 'btn', hidden: true, title: 'Enter VR: watch in a PC VR headset', onclick: enterXR, html: svg('headset') });
  pills.convert = h('button', { class: 'btn gold', disabled: true, onclick: openExport, html: svg('convert') + 'Convert to VR180' });
  pills.flatvid = h('button', { class: 'btn', disabled: true, title: 'Make a flat video: a normal 16:9 video from this VR video, for phones, TVs and sharing', onclick: () => openReframe(), html: svg('tv') + 'Flat video' });
  pills.edit = h('button', { class: 'btn', disabled: true, title: 'Edit: cut sections out and join clips', 'data-tour': 'edit', onclick: () => openEditor(player), html: svg('scissors') + 'Edit' });
  pills.list = iconBtn('list', 'Playlist & chapters', () => { document.body.classList.toggle('nolist'); save({ nolist: document.body.classList.contains('nolist') }); });

  $('pillbar').append(
    h('div', { class: 'pill', title: 'Video format (auto-detected)', 'data-tour': 'format' }, pills.projection, pills.layout, pills.fov),
    h('div', { class: 'pill', 'data-tour': 'view' }, pills.view, pills.depth),
    h('div', { class: 'pill', title: 'Quick comfort: eye separation and scale (more in Calibrate)' }, pills.ipd, pills.scale),
    h('div', { class: 'pill', title: 'Playback speed' }, pills.speed),
    h('div', { class: 'pill' }, pills.cc),
    h('div', { class: 'grow' }),
    pills.xr, pills.flatvid, pills.edit, pills.convert,
    h('div', { class: 'pill' }, pills.list)
  );
  view.xrSupported().then((ok) => (pills.xr.hidden = !ok));
  on('subs-tracks', () => { pills.cc.classList.toggle('active', !!subs.current); ccPop?.refresh?.(); });
}

// Subtitles & audio menu
let ccPop = null;
export function openCC() {
  ccPop = popover(pills.cc, () => {
    const radio = (id, label) => h('button', { class: 'menu-item' + (subs.current === id ? ' checked' : ''), onclick: () => selectSubs(id) }, h('span', { class: 'dot' }), label);
    const s = subs.style;
    const rows = [
      h('div', { class: 'menu-title' }, 'Subtitles'),
      radio(null, 'Off'),
      ...subs.tracks.map((t) => radio(t.id, t.label)),
      h('button', { class: 'menu-item', onclick: () => pickSubs() }, h('span', { html: svg('plus') }), 'Load subtitle file…'),
      cur() && !cur().info.isImage && cur().info.hasAudio ? h('button', { class: 'menu-item', title: 'Listens to the video on this PC and writes subtitles (99 languages)', onclick: () => { ccPop?.close?.(); makeSubtitles(cur().path, { audioTrack: ax.selectedTrack?.() || 0 }); } }, h('span', {}, '💬'), 'Make subtitles with AI…') : null,
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'menu-grid' },
        h('span', {}, 'Size'), numBox({ value: s.size, min: 50, max: 250, step: 10, unit: '%', width: 90, onChange: (v) => setSubStyle({ size: v }) }),
        h('span', {}, 'Height'), numBox({ value: s.height, min: 0, max: 60, step: 2, unit: '%', width: 90, onChange: (v) => setSubStyle({ height: v }) }),
        h('span', {}, 'Background'), numBox({ value: s.bg, min: 0, max: 100, step: 5, unit: '%', width: 90, onChange: (v) => setSubStyle({ bg: v }) }),
        h('span', { title: 'G / H keys' }, 'Timing'), numBox({ value: s.offset, min: -30, max: 30, step: 0.1, unit: 's', width: 90, onChange: (v) => setSubStyle({ offset: v }) }))
    ];
    rows.push(h('div', { class: 'menu-sep' }), h('div', { class: 'menu-title' }, 'Audio'));
    const tr = ax.tracks();
    if (tr.length > 1) {
      const sel = ax.selectedTrack();
      rows.push(...tr.map((t) => h('button', { class: 'menu-item' + (t.index === sel ? ' checked' : ''), onclick: () => { ax.setTrack(t.index); osd(t.label); ccPop?.refresh(); } }, h('span', { class: 'dot' }), t.label)));
    }
    const mc = ax.musicSettings();
    const grid = h('div', { class: 'menu-grid' },
      h('span', { title: 'Positive if the sound comes before the picture, negative if it comes after' }, 'Audio sync'),
      numBox({ value: ax.offset(), min: -1000, max: 1000, step: 25, unit: 'ms', width: 100, onChange: (v) => { ax.setOffset(v); osd(`Audio sync ${v > 0 ? '+' : ''}${v} ms`); } }));
    if (cur()?.info.ambisonic) grid.append(h('span', { title: 'Sound follows where you look (ambisonic audio detected)' }, 'Spatial audio'),
      toggle(settings.spatialOn !== false, (v) => { save({ spatialOn: v }); routeAudio(); osd(v ? 'Spatial audio on' : 'Spatial audio off'); }));
    grid.append(h('span', { title: 'Plays under photos and under videos that are muted or have no sound' }, 'Background music'),
      toggle(mc.on && mc.files.length > 0, async (v) => { if (v && !mc.files.length) { const f = await ax.chooseMusic(); if (!f.length) return ccPop?.refresh(); } else ax.setMusic({ on: v }); ccPop?.refresh(); }));
    if (mc.files.length) grid.append(h('span', {}, 'Music volume'), numBox({ value: mc.volume, min: 0, max: 100, step: 5, unit: '%', width: 90, onChange: (v) => ax.setMusic({ volume: v }) }));
    const snd = ax.soundSettings();
    grid.append(h('span', { title: 'Cuts wind rumble and hiss, and makes voices a little clearer' }, 'Fix wind & hiss'),
      toggle(snd.fix, (v) => { ensureAudio(); ax.setSound({ fix: v }); routeAudio(); osd(v ? 'Wind & hiss filter on' : 'Wind & hiss filter off'); }),
      h('span', { title: 'Evens out loud and quiet parts. Night keeps sudden bangs down when others are asleep.' }, 'Volume leveller'),
      segmented([{ value: 'off', label: 'Off' }, { value: 'gentle', label: 'Gentle' }, { value: 'night', label: 'Night' }], snd.level, (v) => { ensureAudio(); ax.setSound({ level: v }); routeAudio(); osd(v === 'off' ? 'Leveller off' : v === 'night' ? 'Night mode' : 'Volume leveller on'); }, 'small'));
    rows.push(grid, h('button', { class: 'menu-item', onclick: async () => { await ax.chooseMusic(); ccPop?.refresh(); } }, h('span', { html: svg('music') }),
      mc.files.length ? `Music: ${mc.files.length} file${mc.files.length > 1 ? 's' : ''} · change…` : 'Choose background music…'));
    return rows;
  });
}
player.openCC = openCC;
player.nudgeSubs = nudgeSubs;

async function enterXR() {
  try {
    setViewMode('vr');
    const s = await view.enterXR();
    pills.xr.disabled = true;
    s.addEventListener('end', () => (pills.xr.disabled = false));
    if (video.paused) togglePlay();
    // show the panel for a moment so it's easy to discover
    xrPanel.show(true);
    clearTimeout(xrPanelHide);
    xrPanelHide = setTimeout(() => { if (!video.paused && !xrPanel.hover) xrPanel.show(false); }, 4000);
  } catch (e) { toast('Could not start VR: ' + e.message, 'err'); }
}

// Floating control panel in the headset (B / Y shows it; it also comes up when you pause)
let xrPanelHide = null;
const xrPanel = new VRPanel(view, {
  title: () => cur()?.name || 'VR180 Player',
  time: () => [video.currentTime, cur() && !cur().info.isImage ? (video.duration || 0) : 0],
  buttons: () => [
    { id: 'prev', label: '⏮', run: () => prev() },
    { id: 'back', label: '⏪', run: () => seekBy(-10) },
    { id: 'play', label: video.paused ? '▶' : '❚❚', run: () => togglePlay() },
    { id: 'fwd', label: '⏩', run: () => seekBy(10) },
    { id: 'next', label: '⏭', run: () => next() },
    { id: 'vold', label: '🔉', run: () => { video.volume = Math.max(0, video.volume - 0.1); osd(`Volume ${Math.round(video.volume * 100)}%`); } },
    { id: 'volu', label: '🔊', run: () => { video.muted = false; video.volume = Math.min(1, video.volume + 0.1); osd(`Volume ${Math.round(video.volume * 100)}%`); } },
    { id: 'center', label: '⟲', run: () => view.recenterXR() },
    { id: 'exit', label: 'Exit', run: () => view.renderer.xr.getSession()?.end() }
  ],
  seek: (f) => { if (video.duration) seekTo(f * video.duration); },
  chips: () => state.playlist.slice(state.index + 1, state.index + 5).map((it, k) => ({ label: it.name, run: () => load(state.index + 1 + k) }))
});
player.xrPanel = xrPanel;
video.addEventListener('pause', () => { if (view.renderer.xr.isPresenting) xrPanel.show(true); });
video.addEventListener('play', () => {
  if (!view.renderer.xr.isPresenting || !xrPanel.visible) return;
  clearTimeout(xrPanelHide);
  xrPanelHide = setTimeout(() => { if (!video.paused && !xrPanel.hover) xrPanel.show(false); }, 2500);
});

// Headset controllers: right stick seeks/volume, left stick tilts/scales, trigger plays
let xrSeekAcc = 0, xrScale = null, xrPersist = null, xrA = {};
view.onXRSelect = () => togglePlay();
view.onXRInput = ({ hand, x, y, grip, a }, dt) => {
  const dz = (v) => (Math.abs(v) < 0.25 ? 0 : v);
  x = dz(x); y = dz(y);
  // A / X button: recenter (whatever you face becomes straight ahead)
  if (a && !xrA[hand]) { view.recenterXR(); osd('Recentered'); }
  xrA[hand] = a;
  if (hand === 'right') {
    if (x) { xrSeekAcc += x * 20 * dt; if (Math.abs(xrSeekAcc) > 1) { seekBy(Math.trunc(xrSeekAcc)); xrSeekAcc %= 1; } }
    if (y) video.volume = Math.max(0, Math.min(1, video.volume - y * dt));
  } else if (hand === 'left' && cur()) {
    const c = cur().calib;
    const changed = {};
    if (grip && y) {
      xrScale = Math.max(50, Math.min(200, (xrScale ?? c.scale) - y * 60 * dt));
      changed.scale = Math.round(xrScale * 10) / 10;
    } else xrScale = null;
    if (!grip && y) changed.tilt = Math.max(-90, Math.min(90, c.tilt - y * 40 * dt));
    if (x && !grip) changed.roll = Math.max(-30, Math.min(30, c.roll + x * 20 * dt));
    if (Object.keys(changed).length) {
      setCalib(changed, false);
      clearTimeout(xrPersist);
      xrPersist = setTimeout(() => setCalib({}, true), 600);
    }
  }
};

// ---------------------------------------------------------------- controls
const ctl = {};
let sprite = null;
function buildControls() {
  ctl.preview = h('div', { class: 'scrub' }, ctl.previewImg = h('div', { class: 'scrub-img' }), ctl.previewLabel = h('div', { class: 'scrub-label' }));
  ctl.track = h('div', { class: 'track' },
    h('div', { class: 'rail' }, ctl.buf = h('div', { class: 'buf' }), ctl.fill = h('div', { class: 'fill' })),
    ctl.abr = h('div', { class: 'abr', hidden: true }),
    ctl.marks = h('div'),
    ctl.knob = h('div', { class: 'knob' }),
    ctl.preview);
  ctl.play = iconBtn('play', 'Play / pause (Space)', togglePlay, 'play');
  ctl.time = h('span', { class: 'time' }, '0:00 / 0:00');
  ctl.fmt = h('span', { class: 'fmt' });
  ctl.ab = iconBtn('ab', 'A-B loop (Shift+A) · export the section with Convert', abLoop);
  ctl.loop = iconBtn('loop', 'Loop video (L)', () => { video.loop = !video.loop; ctl.loop.classList.toggle('on', video.loop); osd(video.loop ? 'Loop on' : 'Loop off'); });
  ctl.mute = iconBtn('vol', 'Mute (M)', () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 0.5; });
  ctl.vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 1, title: 'Volume' });
  ctl.vol.addEventListener('input', () => { video.volume = +ctl.vol.value; video.muted = video.volume === 0; });
  ctl.boost = numBox({ value: settings.boost || 100, min: 100, max: 200, step: 10, unit: '% boost', width: 104, onChange: setBoost });
  ctl.boost.title = 'Audio boost (louder than 100%)';
  ctl.full = iconBtn('full', 'Fullscreen (F)', () => emit('toggle-fullscreen'));
  ctl.mini = iconBtn('mini', 'Mini-player (Ctrl+M)', () => emit('toggle-mini'));
  ctl.slides = iconBtn('photo', 'Slideshow', () => openSlideshowMenu(ctl.slides));
  ctl.sleep = iconBtn('moon', 'Sleep timer', () => openSleepMenu());
  ctl.sleepChip = h('span', { class: 'sleep-chip', hidden: true, title: 'Sleep timer · click to change', onclick: () => openSleepMenu() });
  ctl.pip = iconBtn('pip', 'Picture-in-picture', () => openPipMenu());

  $('controls').append(ctl.track, h('div', { class: 'crow' },
    iconBtn('prev', 'Previous (P)', prev), iconBtn('back', 'Back 10 s (J / ←)', () => seekBy(-(settings.seekStep || 10))), ctl.play,
    iconBtn('fwd', 'Forward 10 s (→)', () => seekBy(settings.seekStep || 10)), iconBtn('next', 'Next (N)', next), ctl.time, ctl.sleepChip,
    h('div', { class: 'grow' }), ctl.fmt,
    ctl.ab, iconBtn('bookmark', 'Add chapter (B) · [ and ] jump between them', addBookmark), iconBtn('camera', 'Snapshot (S)', snapshot),
    iconBtn('reset', 'Reset view (R)', () => view.reset()), ctl.slides, ctl.pip, ctl.sleep, ctl.loop, ctl.mute, ctl.vol, ctl.boost, ctl.mini, ctl.full));

  // seeking on the custom track, with a picture preview while hovering
  let dragging = false;
  const tAt = (e) => { const r = ctl.track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (video.duration || 0); };
  ctl.track.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('mark')) return;
    dragging = true; ctl.track.setPointerCapture(e.pointerId); seekTo(tAt(e), false);
  });
  ctl.track.addEventListener('pointermove', (e) => {
    const r = ctl.track.getBoundingClientRect();
    const t = tAt(e);
    showPreview(t, Math.max(0, Math.min(r.width, e.clientX - r.left)), r.width);
    if (dragging) seekTo(t, false);
  });
  ctl.track.addEventListener('pointerleave', () => ctl.preview.classList.remove('show'));
  ctl.track.addEventListener('pointerup', () => { if (dragging) { dragging = false; notify('seek'); } });

  video.addEventListener('play', () => (ctl.play.innerHTML = svg('pause')));
  video.addEventListener('pause', () => (ctl.play.innerHTML = svg('play')));
  video.addEventListener('timeupdate', () => renderTrack());
  video.addEventListener('progress', () => renderTrack());
  video.addEventListener('volumechange', () => {
    ctl.mute.innerHTML = svg(video.muted || video.volume === 0 ? 'mute' : 'vol');
    ctl.vol.value = video.muted ? 0 : video.volume;
    save({ volume: video.volume });
  });
  video.addEventListener('ended', () => {
    if (video.loop) return;
    if (sleepStopsAtEnd()) { sleepFinish(); return; }
    if (slideshow.on) slideAdvance(1);
    else if (settings.autoNext !== false) next();
  });
}

function showPreview(t, x, width) {
  const c = chapterAt(t);
  ctl.previewLabel.textContent = fmtTime(t) + (c ? ' · ' + c.name : '');
  ctl.preview.classList.toggle('has-img', !!sprite);
  if (sprite) {
    const i = Math.min(sprite.count - 1, Math.floor(t / sprite.interval));
    ctl.previewImg.style.backgroundImage = `url("${mediaUrl(sprite.path)}")`;
    ctl.previewImg.style.backgroundPosition = `-${(i % sprite.cols) * sprite.w}px -${Math.floor(i / sprite.cols) * sprite.h}px`;
    ctl.previewImg.style.backgroundSize = `${sprite.cols * sprite.w}px ${sprite.rows * sprite.h}px`;
  }
  const half = (sprite ? sprite.w : 90) / 2 + 4;
  ctl.preview.style.left = Math.max(half, Math.min(width - half, x)) + 'px';
  ctl.preview.classList.add('show');
}
async function loadSprite(item, token) {
  if (!item.info.duration) return;
  try {
    const s = await api.sprite(item.path, item.format, item.info.duration);
    if (token === loadToken) sprite = s;
  } catch {}
}

function renderTrack(forceMarks) {
  const d = video.duration || 0, t = video.currentTime || 0;
  const pct = (x) => (d ? (x / d) * 100 : 0) + '%';
  ctl.fill.style.width = pct(t);
  ctl.knob.style.left = pct(t);
  ctl.time.textContent = cur()?.info.isImage ? `Photo ${state.index + 1} of ${state.playlist.length}` : `${fmtTime(t)} / ${fmtTime(d)}`;
  if (video.buffered.length) ctl.buf.style.width = pct(video.buffered.end(video.buffered.length - 1));
  const { a, b } = state.ab;
  ctl.abr.hidden = a == null;
  if (a != null) { ctl.abr.style.left = pct(a); ctl.abr.style.width = b != null ? `calc(${pct(b)} - ${pct(a)})` : '3px'; }
  const list = chapters();
  const sig = JSON.stringify(list) + d;
  if (forceMarks || ctl.marks.dataset.sig !== sig) {
    ctl.marks.dataset.sig = sig;
    ctl.marks.replaceChildren(...list.map((m) => {
      const el = h('div', { class: 'mark', style: { left: pct(m.t) }, 'data-tip': `${m.name} · ${fmtTime(m.t)} · right-click to remove` });
      el.onclick = (e) => { e.stopPropagation(); seekTo(m.t); };
      el.oncontextmenu = (e) => { e.preventDefault(); removeBookmark(m.t); };
      return el;
    }));
  }
}

// ---------------------------------------------------------------- sidebar: playlist & chapters
function buildSidebar() {
  ctl.pl = h('ul', { id: 'plItems' });
  ctl.chapters = h('ul', { id: 'chItems', hidden: true });
  ctl.plCount = h('span', { class: 'muted' });
  ctl.sideTabs = segmented([{ value: 'playlist', label: 'Playlist' }, { value: 'chapters', label: 'Chapters' }], 'playlist', showSidebar, 'small');
  $('playlist').append(card({
    title: '', cls: 'side-card',
    actions: [ctl.sideTabs, h('div', { class: 'grow' }), ctl.plCount, iconBtn('plus', 'Add videos', async () => { const p = await api.openDialog(); if (p.length) open(p, { play: !cur() }); })],
    body: [ctl.pl, ctl.chapters]
  }));
}
function showSidebar(which) {
  ctl.sideTabs.set(which);
  ctl.pl.hidden = which !== 'playlist';
  ctl.chapters.hidden = which !== 'chapters';
  if (document.body.classList.contains('nolist') && which === 'chapters') document.body.classList.remove('nolist');
}
function renderPlaylist() {
  queueMicrotask(() => emit('playlist'));
  ctl.pl.replaceChildren(...state.playlist.map((it, i) => {
    const li = h('li', { class: i === state.index ? 'cur' : '', title: it.path },
      h('span', { class: 'n' }, it.name), h('span', { class: 'd' }, fmtTime(it.info.duration)),
      iconBtn('x', 'Remove', (e) => { e.stopPropagation(); removeItem(i); }));
    li.onclick = () => load(i);
    return li;
  }));
  ctl.plCount.textContent = state.playlist.length || '';
}
function renderChapters() {
  const list = chapters();
  if (!list.length) {
    ctl.chapters.replaceChildren(h('li', { class: 'empty-li' }, 'Press B while watching to add a chapter here.'));
    return;
  }
  ctl.chapters.replaceChildren(...list.map((c) => {
    const name = h('span', { class: 'n', title: 'Double-click to rename' }, c.name);
    const li = h('li', { 'data-t': c.t }, h('span', { class: 'd ch-time' }, fmtTime(c.t)), name,
      iconBtn('x', 'Delete chapter', (e) => { e.stopPropagation(); removeBookmark(c.t); }));
    li.onclick = () => seekTo(c.t);
    name.ondblclick = (e) => { e.stopPropagation(); startRename(c.t); };
    return li;
  }));
}
function startRename(t) {
  const li = ctl.chapters.querySelector(`li[data-t="${t}"]`);
  if (!li) return;
  const span = li.querySelector('.n');
  const input = h('input', { type: 'text', value: span.textContent, class: 'rename' });
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (ok) => { if (done) return; done = true; ok ? renameBookmark(t, input.value) : renderChapters(); };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}
function removeItem(i) {
  state.playlist.splice(i, 1);
  if (i === state.index) {
    if (state.playlist.length) load(Math.min(i, state.playlist.length - 1));
    else closeVideo();
  } else if (i < state.index) state.index--;
  renderPlaylist();
}
// Locking the vault: private items leave the playlist, and if one is showing it's closed
player.purgePrivate = () => {
  const curItem = cur();
  const before = state.playlist.length;
  if (curItem && isHidden(curItem.path)) { if (slideshow.on) slideStop(); closeVideo(); }
  const keep = state.playlist.filter((it) => !isHidden(it.path));
  if (keep.length !== before) {
    const c = cur();
    state.playlist = keep;
    state.index = c ? keep.indexOf(c) : -1;
    renderPlaylist();
  }
};
player.closeVideo = () => closeVideo();
function closeVideo() {
  saveResume();
  document.body.classList.remove('photo-mode');
  $('photoFlat').removeAttribute('src');
  view.setSource(video);
  state.index = -1;
  video.removeAttribute('src');
  video.load();
  stage.classList.remove('loaded');
  pills.convert.disabled = true;
  strip.clear('format');
  document.title = 'VR180 Player';
  renderEmpty();
  renderChapters();
  emit('item', null);
}

export function renderEmpty() {
  const recent = settings.recent.filter((p) => !isHidden(p));
  $('empty').replaceChildren(...[
    h('div', { class: 'drop-card', 'data-tour': 'drop' },
      h('div', { html: svg('headset', 'big-ic'), style: { color: 'var(--green-hi)', transform: 'scale(2.2)', margin: '6px 0 14px' } }),
      h('div', { class: 'big' }, 'Drop a 180° video here'),
      h('div', { class: 'muted' }, 'Fisheye, VR180, 360° or flat · mono or 3D · format is detected automatically'),
      h('button', { class: 'btn primary', onclick: async () => { const p = await api.openDialog(); if (p.length) open(p); } }, 'Choose video…')),
    recent.length ? card({ title: 'Recent', cls: 'recent-card', body: recent.map((p) => h('button', { title: p, onclick: () => open([p]) }, baseName(p))) }) : null].filter(Boolean));
}
player.renderEmpty = renderEmpty;

// ---------------------------------------------------------------- export
function openExport() {
  const item = cur();
  if (!item) return;
  openExportDialog([{ ...item, chapters: chapters(), ab: { ...state.ab }, audioTrack: player.audioTrack?.() || 0, viewYaw: -view.yaw * 180 / Math.PI, viewPitch: view.pitch * 180 / Math.PI,
    // burned-in subtitles use the timing you set (the player shows cues 'offset' seconds later)
    subs: subs.cues.map((c) => ({ ...c, start: c.start + (subs.style.offset || 0), end: c.end + (subs.style.offset || 0) })) }]);
}
player.openExport = openExport;

// Preview an edit: play only the kept ranges ([start, end, speed]) of the open video
let preview = null;
player.previewRanges = (ranges) => {
  if (!ranges.length) return;
  preview = { ranges, i: 0 };
  video.currentTime = ranges[0][0];
  video.playbackRate = ranges[0][2] || 1;
  video.play().catch(() => {});
  osd('Previewing your edit · Esc to stop');
};
player.stopPreview = () => { if (preview) { preview = null; video.playbackRate = 1; } };
video.addEventListener('timeupdate', () => {
  if (!preview) return;
  const [, b] = preview.ranges[preview.i];
  if (video.currentTime < b - 0.06) return;
  preview.i++;
  if (preview.i >= preview.ranges.length) { player.stopPreview(); video.pause(); osd('Preview finished'); return; }
  const [a, , sp] = preview.ranges[preview.i];
  video.currentTime = a;
  video.playbackRate = sp || 1;
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && preview) player.stopPreview(); });
// "Make a highlight reel…" from the Library
on('highlight-reel', async (p) => {
  emit('goto', 'player');
  await player.open([p]);
  openEditor(player, { highlight: true });
});

// ---------------------------------------------------------------- 2D -> 3D
function refreshDepthUi() {
  const item = cur();
  const mono = !!item && item.format.layout === '2d';
  if (!pills.depth) return;
  pills.depth.hidden = !mono;
  pills.depth.classList.toggle('active', mono && depthActive());
  pills.view.setHidden('anaglyph', !is3D());
  pills.view.setHidden('sbs', !is3D());
  if (!is3D() && (state.mode === 'anaglyph' || state.mode === 'sbs')) setViewMode('vr');
}
async function setDepthOn(on) {
  if (on && !(await aiEnsure('depth'))) return false;
  setDepthCfg({ on });
  updateDepth(isMono());
  refreshDepthUi();
  osd(on ? '2D → 3D on' : '2D → 3D off');
  return true;
}
let depthPop = null;
export function openDepth() {
  if (!isMono()) return osd('This video is already 3D');
  depthPop = popover(pills.depth, () => {
    const c = depthCfg();
    return [
      h('div', { class: 'menu-title' }, '2D → 3D'),
      h('div', { class: 'menu-grid' },
        h('span', { title: 'Estimates the depth of every part of the picture on your graphics card, live' }, 'Add depth'),
        toggle(c.on && depthActive(), async (v) => { await setDepthOn(v); depthPop?.refresh?.(); }),
        h('span', { title: 'How far near things stand out from far things' }, 'Depth'),
        numBox({ value: c.strength, min: 10, max: 100, step: 5, unit: '%', width: 90, onChange: (v) => setDepthCfg({ strength: v }) }),
        h('span', { title: 'Higher: more of the picture comes out of the screen towards you. Lower: it sits behind the screen, like a window (easier on the eyes).' }, 'Pop-out'),
        numBox({ value: c.pop, min: 0, max: 80, step: 5, unit: '%', width: 90, onChange: (v) => setDepthCfg({ pop: v }) })),
      h('div', { class: 'menu-note' }, 'See it in the headset, or here with L|R or 3D (red/cyan glasses).'),
      h('div', { class: 'menu-sep' }),
      h('button', { class: 'menu-item', title: 'Save a side-by-side 3D copy that other players and headsets show in 3D', onclick: () => { depthPop?.close(); make3DFile(cur().path, cur().info); } }, h('span', {}, '💾'), cur()?.info.isImage ? 'Save as a 3D photo…' : 'Save as a 3D video…'),
      !cur()?.info.isImage ? h('button', { class: 'menu-item', title: 'Double the resolution with AI upscaling', onclick: () => { depthPop?.close(); aiUpscale(cur().path, cur().info); } }, h('span', {}, '✨'), 'Upscale with AI…') : null
    ];
  });
}
player.openDepth = openDepth;
player.toggleDepth = () => { if (!isMono()) return osd('This video is already 3D'); setDepthOn(!(depthCfg().on && depthActive())); };
on('depth-off', () => { setDepthCfg({ on: false }); updateDepth(false); refreshDepthUi(); });

// ---------------------------------------------------------------- picture helpers
// A tiny copy of the frame, ten times a second: how much the footage moves (comfort
// vignette) and its average colour (light spilling into the virtual cinema).
const probe = { c: null, g: null, prev: null, motion: 0, vig: 0 };
setInterval(() => {
  const item = cur();
  const strength = { off: 0, gentle: 0.6, strong: 1 }[settings.comfortVignette || 'off'];
  const flat = item?.format.projection === 'flat' && (settings.env ?? 1) > 0;
  if (!item || item.info.isImage || video.paused || video.readyState < 2 || (!strength && !flat) || state.flat) {
    if (probe.vig > 0.001) { probe.vig *= 0.8; view.setVignette(probe.vig); }
    return;
  }
  if (!probe.c) { probe.c = document.createElement('canvas'); probe.c.width = 32; probe.c.height = 16; probe.g = probe.c.getContext('2d', { willReadFrequently: true }); }
  try { probe.g.drawImage(video, 0, 0, 32, 16); } catch { return; }
  const d = probe.g.getImageData(0, 0, 32, 16).data;
  let r = 0, g = 0, b = 0, diff = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i]; g += d[i + 1]; b += d[i + 2];
    if (probe.prev) diff += Math.abs(d[i] - probe.prev[i]) + Math.abs(d[i + 1] - probe.prev[i + 1]) + Math.abs(d[i + 2] - probe.prev[i + 2]);
  }
  const n = d.length / 4;
  probe.prev = d;
  if (flat) { const lin = (v) => Math.pow(v / n / 255, 2.2); view.setAmbient(lin(r), lin(g), lin(b)); }
  if (strength) {
    probe.motion = probe.motion * 0.6 + (diff / n / 3) * 0.4;
    const target = Math.max(0, Math.min(1, (probe.motion - 5) / 18)) * strength;
    // close in quickly when the camera swings, open up slowly
    probe.vig += (target - probe.vig) * (target > probe.vig ? 0.5 : 0.08);
    view.setVignette(probe.vig);
  }
}, 100);

// Stats for nerds: what the decoder and renderer are doing
let statsEl = null, statsTimer = null, lastFrames = 0, lastTotal = 0, lastT = 0;
export function toggleStats() {
  if (statsEl) { statsEl.remove(); statsEl = null; clearInterval(statsTimer); return; }
  statsEl = h('div', { class: 'stats-hud' });
  stage.append(statsEl);
  const tick = () => {
    const item = cur();
    const q = video.getVideoPlaybackQuality?.() || {};
    const now = performance.now(), dt = (now - lastT) / 1000 || 1;
    const vfps = ((q.totalVideoFrames || 0) - lastTotal) / dt, rfps = ((view.frames || 0) - lastFrames) / dt;
    lastT = now; lastTotal = q.totalVideoFrames || 0; lastFrames = view.frames || 0;
    const buf = video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
    const mbps = item?.info.size && item.info.duration ? (item.info.size * 8 / item.info.duration / 1e6) : 0;
    const rows = item ? [
      ['File', `${video.videoWidth}×${video.videoHeight} ${item.info.codec.toUpperCase()}${item.info.bitDepth === 10 ? ' 10-bit' : ''}${item.info.hdr ? ' ' + item.info.hdr.toUpperCase() : ''} · ${item.info.fps || '?'} fps · ${mbps.toFixed(0)} Mbit/s`],
      ['Playing', item.playPath !== item.path ? 'preview copy (codec not supported directly)' : 'original file'],
      ['Decoded', `${vfps.toFixed(1)} fps · dropped ${q.droppedVideoFrames || 0} of ${q.totalVideoFrames || 0}`],
      ['Drawn', `${rfps.toFixed(1)} fps (skips frames when nothing changes)`],
      ['Buffered', `${buf.toFixed(1)} s ahead`],
      ['View', `${state.mode} · ${FORMAT_NAMES.projection[item.format.projection]} · ${FORMAT_NAMES.layout[item.format.layout]}`],
      ...(depthStats() ? [['2D → 3D', `depth ${depthStats().fps.toFixed(1)} times/s · ${Math.round(depthStats().ms)} ms each · ${depthStats().gpu ? 'graphics card' : 'processor (slow)'}`]] : [])
    ] : [['', 'Nothing playing']];
    statsEl.replaceChildren(...rows.map(([k, v]) => h('div', {}, h('b', {}, k), ' ', v)));
  };
  tick();
  statsTimer = setInterval(tick, 1000);
}
player.toggleStats = toggleStats;

// Picture quality settings (sharpening, smooth downscaling) apply to every video
export function applyQuality() {
  view.setQuality({ sharpen: (settings.sharpen ?? 25) / 100, videoMips: settings.videoMips !== false });
  view.setCurved(!!settings.curvedScreen);
  view.setXRScale(settings.xrScale ?? 1);
}
player.applyQuality = applyQuality;

// ---------------------------------------------------------------- init
api.onProgress((id, p) => { if (id === 'proxy') $('busyBar').style.width = Math.round(p.fraction * 100) + '%'; });

export function initPlayer() {
  initSlideshow(player);
  ax.initAudioExtras(player, audio, video, routeAudio);
  stage.append(h('img', { id: 'photoFlat', alt: '' }));
  buildPillbar();
  buildControls();
  buildSidebar();
  initSleep(player, ctl.sleep, ctl.sleepChip);
  initPip(player, ctl.pip);
  renderEmpty();
  renderChapters();
  initSubtitles(video, view);
  video.volume = settings.volume ?? 1;
  applyQuality();
  initDepth(view, () => {
    const item = cur();
    if (!item || item.format.layout !== '2d') return null;
    if (item.info.isImage) {
      const el = view.texture?.image;
      const w = el?.naturalWidth || el?.videoWidth || el?.width, hh = el?.naturalHeight || el?.videoHeight || el?.height;
      return el && w && !el.videoWidth ? { el, w, h: hh, still: true, key: item.path } : null;
    }
    if (video.readyState < 2 || !video.videoWidth) return null;
    return { el: video, w: video.videoWidth, h: video.videoHeight, still: video.paused, key: item.path + '@' + video.currentTime.toFixed(3) };
  }, (e) => {
    refreshDepthUi();
    if (e.notInstalled) toast('2D → 3D needs its add-on.', 'err', { label: 'Install', onClick: () => setDepthOn(true) });
    else toast('2D → 3D stopped: ' + String(e.message || e).slice(0, 160), 'err');
  });
  initReframe({ view, video, stage, cur, setViewMode, osd });
  initAi({ currentPath: () => cur()?.path, reloadSubs: (p) => { reloadTracks(p); osd('AI subtitles ready'); } });
  if (settings.nolist) document.body.classList.add('nolist');
  $('vrCanvas').addEventListener('click', () => { if (!view.lastDragMoved) togglePlay(); });
  video.addEventListener('click', togglePlay);
  for (const el of [$('vrCanvas'), video]) el.addEventListener('dblclick', () => emit('toggle-fullscreen'));
  on('vault', () => { if (!cur()) renderEmpty(); });
}
