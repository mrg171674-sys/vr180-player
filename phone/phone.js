// Phone side of VR180 Player. Talks only to the PC that served this page, using
// relative URLs under the secret link.
import * as THREE from './node_modules/three/build/three.module.js';
import { VRView } from './renderer/vrview.js';
import { VRPanel } from './renderer/vrpanel.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
let view = null;
let item = null;          // what the PC is showing
let version = null;
let offset = 0;           // HLS streams start at the seek point; this maps them back to video time
let hls = null;
let mode = 'watch';
let follow = false;
let subsOn = true;
let pcState = { time: 0, paused: true, rate: 1 };
let me = { canControl: false, controlAsked: false }; // what the PC allows this phone to do

// ---------------------------------------------------------------- connection
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' } : { credentials: 'same-origin' });
  if (r.status === 401) { disconnected(); throw new Error('disconnected'); }
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('show', s.id === id)); }
function message(title, text) { $('msgTitle').textContent = title; $('msgText').textContent = text; show('screen-msg'); }
function disconnected() {
  stopPolling();
  message('Disconnected', 'The PC stopped the phone stream, made a new link, or removed this phone. Scan the new QR code to connect again.');
}

const LOCKED = ['Stream locked', 'The PC has locked this stream, so no new phones can join. Ask the person at the PC to unlock it.'];
async function connect() {
  const caps = {
    hevc: ['video/mp4; codecs="hvc1.1.6.L153.B0"', 'video/mp4; codecs="hev1.1.6.L153.B0"'].some((t) => !!video.canPlayType(t)),
    h264: !!video.canPlayType('video/mp4; codecs="avc1.640033"')
  };
  const { status, data } = await api('api/hello', { caps });
  if (status === 423) return message(...LOCKED);
  if (status === 429) return message('Too many phones waiting', 'Several phones are already waiting to join this stream. Try again in a minute.');
  if (data.status === 'pin') { show('screen-pin'); setTimeout(() => $('pin').focus(), 200); return; }
  if (data.status === 'pending') {
    show('screen-wait');
    $('waitText').textContent = 'Waiting for the PC to allow this phone…';
    setTimeout(connect, 1500);
    return;
  }
  if (data.status === 'denied') return message('Not allowed', 'The PC said no to this phone.');
  if (data.status === 'ok') startPlayer();
}
$('pinBtn').onclick = sendPin;
$('retryBtn').onclick = () => location.reload();
$('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendPin(); });
async function sendPin() {
  const { status, data } = await api('api/pin', { pin: $('pin').value });
  if (status === 200) { $('pinMsg').textContent = ''; return connect(); }
  if (status === 423) return message(...LOCKED);
  $('pin').value = '';
  const wait = data.wait >= 120 ? `${Math.ceil(data.wait / 60)} minutes` : `${data.wait} seconds`;
  $('pinMsg').textContent = data.wait ? `Too many tries. Wait ${wait}.` : `Wrong PIN${data.left != null ? ` · ${data.left} tries left` : ''}`;
}

// ---------------------------------------------------------------- player
let pollTimer = null, beatTimer = null;
function stopPolling() { clearInterval(pollTimer); clearInterval(beatTimer); }

function startPlayer() {
  show('screen-player');
  view = new VRView($('vrCanvas'), video);
  view.setEnv(1);
  setupHeadset();
  poll();
  pollTimer = setInterval(poll, 1000);
  beatTimer = setInterval(() => api('api/event', { mode, position: now() }).catch(() => {}), 2000);
  requestAnimationFrame(frame);
}
const now = () => (item?.isImage ? 0 : video.currentTime + offset);

async function poll() {
  let res;
  try { res = await api('api/state'); } catch { return; }
  const { item: it, pc } = res.data;
  pcState = pc;
  if (res.data.me) { me = res.data.me; updateControl(); renderDownload(); showTrust(); }
  renderUpNext(res.data.upNext || []);
  if (!it) { $('title').textContent = 'Nothing is playing on the PC yet'; return; }
  const key = it.title + '|' + it.version;
  if (key !== version) { version = key; await load(it); }
  else item = { ...item, calib: it.calib, level: it.level, format: it.format, subs: it.subs, chapters: it.chapters };
  renderChapters();
  updateMediaSession();
  applyLook();
  if (follow && mode === 'watch' && !item.isImage) followPc();
}

async function load(it) {
  item = it;
  $('title').textContent = it.title;
  applyLook();
  setLoading(true, it.isImage ? 'Loading photo…' : 'Starting video…');
  try {
    if (it.isImage) {
      video.pause();
      if (hls) { hls.destroy(); hls = null; }
      const left = await image('media/photo');
      let src = left;
      if (it.hasRight) {
        const right = await image('media/photo-right');
        src = document.createElement('canvas');
        src.width = left.naturalWidth * 2; src.height = left.naturalHeight;
        const g = src.getContext('2d');
        g.drawImage(left, 0, 0);
        g.drawImage(right, left.naturalWidth, 0, left.naturalWidth, left.naturalHeight);
      }
      view.setSource(src);
    } else {
      view.setSource(video);
      await playFrom(follow ? pcNow() : 0);
      offerResume(it);
    }
  } catch (e) {
    $('loadingText').textContent = 'Could not load: ' + e.message;
    return;
  }
  setLoading(false);
}
// ---------------------------------------------------------------- chapters, up next, lock screen
function renderChapters() {
  const list = item?.chapters || [];
  $('chapBtn').hidden = !list.length || item.isImage;
  $('chapList').replaceChildren(...list.map((c) => {
    const b = document.createElement('button');
    b.append(Object.assign(document.createElement('b'), { textContent: fmt(c.t) }), Object.assign(document.createElement('span'), { textContent: c.name }));
    b.onclick = () => { $('chapSheet').hidden = true; seek(c.t); };
    return b;
  }));
}
$('chapBtn').onclick = () => ($('chapSheet').hidden = false);
$('chapClose').onclick = () => ($('chapSheet').hidden = true);
$('chapSheet').addEventListener('click', (e) => { if (e.target === $('chapSheet')) $('chapSheet').hidden = true; });

let upNextKey = '';
function renderUpNext(list) {
  const key = list.map((u) => u.i + u.name).join('|');
  if (key === upNextKey) return;
  upNextKey = key;
  $('upnextBox').hidden = !list.length;
  $('upnext').replaceChildren(...list.map((u) => {
    const b = document.createElement('button');
    b.textContent = '▶  ' + u.name;
    b.onclick = () => api('api/event', { mode, cmd: 'play', value: u.i }).catch(() => {});
    return b;
  }));
}

// lock screen / notification controls for the phone's own playback
function updateMediaSession() {
  if (!('mediaSession' in navigator) || !item) return;
  if (navigator.mediaSession.metadata?.title !== item.title) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, artist: 'VR180 Player', artwork: [{ src: 'icon.png', sizes: '512x512', type: 'image/png' }] });
  }
  try { if (item.duration) navigator.mediaSession.setPositionState({ duration: item.duration, position: Math.min(item.duration, Math.max(0, now())), playbackRate: video.playbackRate || 1 }); } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const on = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  on('play', () => video.play().catch(() => {}));
  on('pause', () => video.pause());
  on('seekbackward', (d) => seek(now() - (d.seekOffset || 10)));
  on('seekforward', (d) => seek(now() + (d.seekOffset || 10)));
  on('seekto', (d) => { if (d.seekTime != null) seek(d.seekTime); });
}

// "This device is remembered": once, with the address to bookmark
function showTrust() {
  if (!me.trusted || localStorage.getItem('vr180-trust-hint') === location.host) return;
  $('trustUrl').textContent = `https://${location.host}/pair`;
  $('trustBar').hidden = false;
}
$('trustOk').onclick = () => { $('trustBar').hidden = true; try { localStorage.setItem('vr180-trust-hint', location.host); } catch {} };

// "Continue from 12:30 (where you stopped on the PC)?"
function offerResume(it) {
  const r = it.resume;
  if (!r || follow || r.t < 10 || r.t > it.duration - 10) return;
  $('resumeText').textContent = `Continue from ${fmt(r.t)}? (${r.dev === 'PC' ? 'where the PC stopped' : 'where you stopped on ' + r.dev})`;
  $('resumeBar').hidden = false;
  $('resumeGo').onclick = () => { $('resumeBar').hidden = true; seek(r.t); };
  $('resumeNo').onclick = () => ($('resumeBar').hidden = true);
  setTimeout(() => ($('resumeBar').hidden = true), 12000);
}
const image = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('photo')); i.src = src; });
function setLoading(on, text) { $('loading').hidden = !on; if (text) $('loadingText').textContent = text; }

// Direct file when the phone can play it; otherwise the PC re-encodes live (HLS)
async function playFrom(t) {
  if (item.direct && !item.forceHls) {
    offset = 0;
    if (hls) { hls.destroy(); hls = null; }
    if (!video.src.endsWith('media/direct')) video.src = 'media/direct';
    video.currentTime = t;
    const ok = await canStart();
    if (ok) return;
    item.forceHls = true; // this phone couldn't decode the original
  }
  setLoading(true, 'Your PC is preparing the video for this phone…');
  const { data } = await api(`media/hls/start?t=${t.toFixed(2)}`);
  offset = data.start;
  // the PC may hand back an encode that started earlier: jump to the requested point in it
  const local = Math.max(0, t - offset);
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    if (!video.src.endsWith(data.url)) video.src = data.url;
    video.addEventListener('loadedmetadata', () => { if (local > 0.5) video.currentTime = local; }, { once: true });
    if (video.readyState >= 1 && local > 0.5) video.currentTime = local;
  } else if (window.Hls?.isSupported()) {
    if (hls && hls.url === data.url) { video.currentTime = local; }
    else {
      if (hls) hls.destroy();
      hls = new window.Hls({ startPosition: local, maxBufferLength: 20 });
      hls.url = data.url;
      hls.loadSource(data.url);
      hls.attachMedia(video);
      // the PC replaced this stream (another phone sought far away, quality changed): start a fresh one here
      hls.on(window.Hls.Events.ERROR, (_e, info) => { if (info.fatal) recoverStream(); });
    }
  } else throw new Error('this browser cannot play video streams');
  await canStart();
  setLoading(false);
}
let recovering = false;
async function recoverStream() {
  if (recovering || !item || item.isImage) return;
  recovering = true;
  const at = now();
  try { if (hls) { hls.destroy(); hls = null; } await playFrom(at); } catch {}
  setTimeout(() => (recovering = false), 3000);
}
// native HLS (iPhone): a vanished stream shows up as a media error
video.addEventListener('error', () => { if (offset > 0 || video.src.includes('/hls/')) recoverStream(); });
function canStart() {
  return new Promise((resolve) => {
    const done = (v) => { video.removeEventListener('canplay', ok); video.removeEventListener('error', bad); clearTimeout(t); resolve(v); };
    const ok = () => done(true), bad = () => done(false);
    video.addEventListener('canplay', ok);
    video.addEventListener('error', bad);
    const t = setTimeout(() => done(video.readyState >= 2), 12000);
    video.play().catch(() => {});
  });
}

function seek(t) {
  if (!item || item.isImage) return;
  t = Math.max(0, Math.min(item.duration - 0.2, t));
  // inside what's already streamed: just seek; otherwise restart the stream there
  if (item.direct && !item.forceHls) { video.currentTime = t; return; }
  const local = t - offset;
  const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
  if (local >= 0 && local <= buffered + 2) video.currentTime = local;
  else playFrom(t);
}

const pcNow = () => pcState.time + (pcState.paused ? 0 : ((pcState.age || 0) / 1000) * (pcState.rate || 1));
function followPc() {
  const target = pcNow();
  if (Math.abs(now() - target) > 1.5) seek(target);
  if (pcState.paused && !video.paused) video.pause();
  if (!pcState.paused && video.paused) video.play().catch(() => {});
}

function applyLook() {
  if (!view || !item) return;
  const f = item.format || {};
  const l = f.layout === 'sbs' ? item.width / 2 : item.width, hh = f.layout === 'tb' ? item.height / 2 : item.height;
  view.setFormat({ projection: f.projection, layout: f.layout, eyeAspect: l / hh });
  view.setCalib(item.calib || {});
}

// ---------------------------------------------------------------- per-frame: level, subtitles, UI
function frame() {
  if (item && view) {
    const lv = item.level, t = now();
    let roll = 0;
    if (lv && lv.mode !== 'off') {
      if (lv.mode === 'fixed' || !lv.rolls?.length) roll = lv.fixed || 0;
      else { const i = Math.min(lv.rolls.length - 1, Math.max(0, t / lv.interval)); const i0 = Math.floor(i); roll = lv.rolls[i0] + ((lv.rolls[i0 + 1] ?? lv.rolls[i0]) - lv.rolls[i0]) * (i - i0); }
    }
    view.setLevelRoll(roll);
    const cue = subsOn && item.subs ? item.subs.filter((c) => c.start <= t && c.end > t).map((c) => c.text).join('\n') : '';
    if ($('subs').dataset.t !== cue) { $('subs').dataset.t = cue; $('subs').replaceChildren(...(cue ? cue.split('\n').map((x) => Object.assign(document.createElement('span'), { textContent: x })) : [])); }
    if (!seeking && item.duration) $('seek').value = (t / item.duration) * 1000;
    $('time').textContent = item.isImage ? 'Photo' : `${fmt(t)} / ${fmt(item.duration)}`;
    $('play').textContent = video.paused ? '▶' : '❚❚';
  }
  requestAnimationFrame(frame);
}
const fmt = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60), x = Math.floor(s % 60); return `${m}:${String(x).padStart(2, '0')}`; };

// ---------------------------------------------------------------- standalone headset (Quest browser)
// Open the same link in the headset's browser and tap "VR": the video surrounds you,
// streamed wirelessly from the PC. Trigger plays/pauses, the right stick seeks,
// A / X recenters, B / Y brings up the control panel.
let headPanel = null;
function setupHeadset() {
  view.xrSupported().then((ok) => { $('vrBtn').hidden = !ok; });
  headPanel = new VRPanel(view, {
    title: () => item?.title || 'VR180 Player',
    time: () => [now(), item && !item.isImage ? item.duration : 0],
    buttons: () => [
      { id: 'back', label: '⏪', run: () => seek(now() - 10) },
      { id: 'play', label: video.paused ? '▶' : '❚❚', run: () => (video.paused ? video.play() : video.pause()) },
      { id: 'fwd', label: '⏩', run: () => seek(now() + 10) },
      { id: 'follow', label: 'Sync PC', on: follow, run: () => $('follow').click() },
      { id: 'cc', label: 'CC', on: subsOn, run: () => $('cc').click() },
      { id: 'center', label: '⟲', run: () => view.recenterXR() },
      { id: 'exit', label: 'Exit', run: () => view.renderer.xr.getSession()?.end() }
    ],
    seek: (f) => { if (item?.duration) seek(f * item.duration); }
  });
  let acc = 0, aWas = {};
  view.onXRSelect = () => (video.paused ? video.play().catch(() => {}) : video.pause());
  view.onXRInput = ({ hand, x, a }, dt) => {
    if (a && !aWas[hand]) view.recenterXR();
    aWas[hand] = a;
    if (hand === 'right' && Math.abs(x) > 0.25) { acc += x * 20 * dt; if (Math.abs(acc) > 1) { seek(now() + Math.trunc(acc)); acc %= 1; } }
  };
  video.addEventListener('pause', () => { if (view.renderer.xr.isPresenting) headPanel.show(true); });
}
$('vrBtn').onclick = async () => {
  try {
    const s = await view.enterXR();
    headPanel.show(true);
    if (video.paused) video.play().catch(() => {});
    s.addEventListener('end', () => headPanel.show(false));
  } catch (e) { alert('Could not start VR: ' + e.message); }
};

// ---------------------------------------------------------------- controls
let seeking = false;
$('seek').addEventListener('input', () => (seeking = true));
$('seek').addEventListener('change', () => { seeking = false; if (item) seek(($('seek').value / 1000) * item.duration); });
$('play').onclick = () => (video.paused ? video.play() : video.pause());
let hideTimer;
function wakeUi() { document.body.classList.remove('hide-ui'); clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!video.paused || isFs()) document.body.classList.add('hide-ui'); }, 3000); }
$('stage').addEventListener('pointerup', wakeUi);
wakeUi();

// tilt to look around (iPhones need the user to allow it)
const deviceQuat = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const zee = new THREE.Vector3(0, 0, 1), euler = new THREE.Euler(), q0 = new THREE.Quaternion();
let tiltOn = false, alphaZero = null, lastOri = null;
function onOrient(e) {
  if (e.alpha == null) return;
  lastOri = e;
  if (alphaZero == null) alphaZero = e.alpha;
  const d = Math.PI / 180;
  const orient = (screen.orientation?.angle ?? window.orientation ?? 0) * d;
  euler.set(e.beta * d, (e.alpha - alphaZero) * d, -e.gamma * d, 'YXZ');
  deviceQuat.setFromEuler(euler);
  deviceQuat.multiply(q1);
  deviceQuat.multiply(q0.setFromAxisAngle(zee, -orient));
  if (tiltOn && view) view.deviceQuat = deviceQuat;
}
$('tilt').onclick = async () => {
  if (!tiltOn && typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
    try { if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return; } catch { return; }
  }
  tiltOn = !tiltOn;
  $('tilt').classList.toggle('on', tiltOn);
  if (tiltOn) { alphaZero = null; window.addEventListener('deviceorientation', onOrient); }
  else { window.removeEventListener('deviceorientation', onOrient); if (view) view.deviceQuat = null; }
};
$('recenter').onclick = () => { alphaZero = lastOri?.alpha ?? null; view?.reset(); };

// Cardboard: one picture per eye, fullscreen, landscape
$('cardboard').onclick = async () => {
  const on = !document.body.classList.contains('cardboard');
  document.body.classList.toggle('cardboard', on);
  $('cardboard').classList.toggle('on', on);
  view.setMode(on ? 'sbs' : 'vr');
  if (on) {
    await enterFullscreen(true);
    if (!tiltOn) $('tilt').click();
  } else exitFullscreen();
};
// in Cardboard, a tap shows the controls briefly so you can get out again
$('stage').addEventListener('click', () => { if (document.body.classList.contains('cardboard')) { document.body.classList.add('show-exit'); setTimeout(() => document.body.classList.remove('show-exit'), 3000); } });

$('follow').onclick = () => { follow = !follow; $('follow').classList.toggle('on', follow); if (follow) followPc(); };
$('cc').classList.add('on');
$('cc').onclick = () => { subsOn = !subsOn; $('cc').classList.toggle('on', subsOn); };

// Watch on the phone, or use it as a remote for the PC
$('modeSeg').addEventListener('click', (e) => {
  const m = e.target.dataset.mode;
  if (!m) return;
  mode = m;
  [...$('modeSeg').children].forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('remote').hidden = m !== 'remote';
  if (m === 'remote') video.pause();
  api('api/event', { mode, position: now() }).catch(() => {});
});
document.querySelectorAll('#remote [data-cmd]').forEach((b) => (b.onclick = () => { if (me.canControl) api('api/event', { mode, cmd: b.dataset.cmd }).catch(() => {}); }));
function updateControl() {
  $('ctlAsk').hidden = me.canControl;
  $('remote').classList.toggle('no-control', !me.canControl);
  $('ctlBtn').disabled = me.controlAsked;
  $('ctlBtn').textContent = me.controlAsked ? 'Waiting for the PC…' : 'Ask the PC for control';
}
$('ctlBtn').onclick = async () => {
  try { const { data } = await api('api/request-control', {}); me = { ...me, canControl: data.canControl, controlAsked: data.asked }; } catch {}
  updateControl();
};
updateControl();
let padLast = null, padAcc = { dx: 0, dy: 0 }, padTimer = null;
$('pad').addEventListener('pointerdown', (e) => { if (!me.canControl) return; padLast = { x: e.clientX, y: e.clientY }; $('pad').classList.add('active'); $('pad').setPointerCapture(e.pointerId); });
$('pad').addEventListener('pointermove', (e) => {
  if (!padLast) return;
  padAcc.dx += e.clientX - padLast.x; padAcc.dy += e.clientY - padLast.y;
  padLast = { x: e.clientX, y: e.clientY };
  if (!padTimer) padTimer = setTimeout(() => { api('api/event', { mode, cmd: 'look', value: padAcc }).catch(() => {}); padAcc = { dx: 0, dy: 0 }; padTimer = null; }, 50);
});
$('pad').addEventListener('pointerup', () => { padLast = null; $('pad').classList.remove('active'); });

// ---------------------------------------------------------------- fullscreen
// Real fullscreen where the browser allows it (Android, iPad); iPhone Safari has no
// fullscreen for pages, so there the player fills the screen and hides everything else.
const isRealFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
const isFs = () => isRealFs() || document.body.classList.contains('fs-fill') || document.body.classList.contains('fs-native');
async function enterFullscreen(landscape) {
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  let real = false;
  if (request) { try { await request.call(el, { navigationUI: 'hide' }); real = true; } catch {} }
  if (!real && !landscape && fsStyle() === 'native' && (await nativeFullscreen())) return;
  if (!real && !document.body.classList.contains('fs-fill')) {
    document.body.classList.add('fs-fill');
    history.pushState({ fs: true }, ''); // Back leaves fill-screen instead of the page
    window.scrollTo(0, 1);
    if (innerHeight > innerWidth) hint('Turn your phone sideways for the biggest picture.', 'fsHint');
  }
  if (landscape || (item && item.width >= item.height)) { try { await screen.orientation?.lock?.('landscape'); } catch {} }
  updateFs();
  wakeUi();
}
async function exitFullscreen() {
  if (document.body.classList.contains('fs-native')) { try { $('fsProxy').webkitExitFullscreen(); } catch {} }
  try { screen.orientation?.unlock?.(); } catch {}
  if (document.body.classList.contains('fs-fill')) {
    document.body.classList.remove('fs-fill');
    if (history.state?.fs) history.back();
  }
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
  updateFs();
}
function updateFs() {
  const on = isFs();
  document.body.classList.toggle('is-fs', on);
  $('fsBtn').textContent = on ? '⤡' : '⛶';
  $('fsBtn').setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
  // leaving fullscreen some other way also ends Cardboard
  if (!on && document.body.classList.contains('cardboard')) { document.body.classList.remove('cardboard'); $('cardboard').classList.remove('on'); view?.setMode('vr'); }
}
const toggleFullscreen = () => (isFs() ? exitFullscreen() : enterFullscreen());

// iPhone Safari only allows a <video> to go truly fullscreen, so the VR picture is
// copied frame by frame into one (canvas.captureStream) and that is shown fullscreen.
// Tilt still steers the view; the iPhone player's own buttons pause and play.
const hasElementFs = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
const fsStyle = () => { try { return localStorage.getItem('fsStyle') || 'native'; } catch { return 'native'; } };
async function nativeFullscreen() {
  const proxy = $('fsProxy'), canvas = $('vrCanvas');
  if (!canvas.captureStream || !proxy.webkitEnterFullscreen) return false;
  try {
    if (!proxy.srcObject) proxy.srcObject = canvas.captureStream(30);
    await proxy.play();
    proxy.webkitEnterFullscreen();
  } catch { return false; }
  document.body.classList.add('fs-native');
  const mirror = () => { if (!document.body.classList.contains('fs-native')) return; proxy.paused ? video.pause() : video.play().catch(() => {}); };
  proxy.onpause = proxy.onplay = mirror;
  proxy.addEventListener('webkitendfullscreen', () => {
    document.body.classList.remove('fs-native');
    proxy.onpause = proxy.onplay = null;
    proxy.pause();
    proxy.srcObject?.getTracks().forEach((t) => t.stop());
    proxy.srcObject = null;
    updateFs();
  }, { once: true });
  if (!tiltOn) $('tilt').click(); // looking around needs tilt in the iPhone player
  return true;
}

// ---------------------------------------------------------------- More sheet
$('moreBtn').onclick = () => { $('sheet').hidden = false; renderDownload(); renderFsStyle(); };
$('sheetClose').onclick = () => ($('sheet').hidden = true);
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; });
function renderFsStyle() {
  $('fsStyleSec').hidden = hasElementFs();
  [...$('fsStyle').children].forEach((b) => b.classList.toggle('on', b.dataset.style === fsStyle()));
}
$('fsStyle').addEventListener('click', (e) => { const s = e.target.dataset.style; if (!s) return; try { localStorage.setItem('fsStyle', s); } catch {} renderFsStyle(); });

// downloads: ask, wait for the PC (and the phone-size copy), then save
const mb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB');
let startedTicket = null, lastAsked = null;
function renderDownload() {
  if (!item) return;
  $('dlPhoneSize').textContent = `1080p · about ${mb(item.phoneSize || 0)}`;
  $('dlOrigSize').textContent = `full quality · ${mb(item.size || 0)}`;
  $('dlOptions').hidden = !!item.isImage;
  const d = me.download, show = (text, p) => { $('dlStatus').hidden = false; $('dlText').textContent = text; $('dlBar').style.width = Math.round((p || 0) * 100) + '%'; };
  if (item.isImage) return show('Photos can\'t be downloaded here yet.', 0);
  if (d && d.error) return show(d.error, 0);
  if (d && d.ready && startedTicket !== d.ticket) {
    startedTicket = d.ticket;
    const a = Object.assign(document.createElement('a'), { href: 'media/download/' + d.ticket, download: '' });
    document.body.append(a); a.click(); a.remove();
    return show('Downloading… check your browser\'s downloads.', 1);
  }
  if (d && !d.ready) return show(`The PC is making the phone copy… ${Math.round(d.progress * 100)}%`, d.progress);
  if (d && startedTicket === d.ticket) return show('Downloading… check your browser\'s downloads.', 1);
  if (me.downloadAsked) { lastAsked = me.downloadAsked; return show('Waiting for the PC to allow the download…', 0); }
  if (lastAsked && !d) return show('The PC didn\'t allow the download.', 0);
  $('dlStatus').hidden = true;
}
$('dlOptions').addEventListener('click', async (e) => {
  const kind = e.target.closest('.opt')?.dataset.kind;
  if (!kind) return;
  lastAsked = null;
  try {
    const { data } = await api('api/request-download', { kind });
    if (data.status === 'asked') me.downloadAsked = kind;
    if (data.status === 'ready') me.download = { ticket: data.ticket, kind, ready: kind === 'original', progress: kind === 'original' ? 1 : 0 };
  } catch {}
  renderDownload();
});
$('fsBtn').onclick = toggleFullscreen;
document.addEventListener('fullscreenchange', updateFs);
document.addEventListener('webkitfullscreenchange', updateFs);
window.addEventListener('popstate', () => { if (document.body.classList.contains('fs-fill')) { document.body.classList.remove('fs-fill'); updateFs(); } });

// double-tap the picture to toggle fullscreen (a drag to look around doesn't count)
let lastTap = null, downAt = null;
$('stage').addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY, t: Date.now() }));
$('stage').addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 12 || Date.now() - downAt.t > 300) { lastTap = null; return; }
  const tap = { x: e.clientX, y: e.clientY, t: Date.now() };
  if (lastTap && tap.t - lastTap.t < 320 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 40) { lastTap = null; if (!document.body.classList.contains('cardboard')) toggleFullscreen(); }
  else lastTap = tap;
});

// a short message over the picture, shown once per phone
function hint(text, key) {
  try { if (key && localStorage.getItem(key)) return; if (key) localStorage.setItem(key, '1'); } catch {}
  $('hint').textContent = text;
  $('hint').hidden = false;
  clearTimeout(hint.t);
  hint.t = setTimeout(() => ($('hint').hidden = true), 4000);
}

// keep the screen on while a video plays
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); }
    else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch {}
}
video.addEventListener('play', () => keepAwake(true));
video.addEventListener('pause', () => keepAwake(false));
video.addEventListener('ended', () => keepAwake(false));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !video.paused) keepAwake(true); });

connect().catch(() => {});
