// Audio extras: switch between a file's audio tracks, fix audio that drifts out
// of sync with the picture, and background music for photos and silent videos.
import { api, settings, save, fileKey, mediaUrl, baseName } from './core.js';

let player, audio, video, reroute;
const ahead = { el: null, node: null, lead: 0, active: false };
const music = { el: null, index: 0, fadeVol: 0 };

export function initAudioExtras(p, a, v, routeAudio) {
  player = p; audio = a; video = v; reroute = routeAudio;
  setInterval(syncAhead, 250);
  setInterval(tickMusic, 200);
}

// ---------------------------------------------------------------- tracks
export function tracks() {
  const list = video.audioTracks ? [...video.audioTracks] : [];
  const info = player.current()?.info.audioTracks || [];
  return list.map((t, i) => ({ index: i, enabled: t.enabled, label: labelFor(t, info[i], i) }));
}
const labelFor = (t, meta, i) => {
  const lang = (t.language || meta?.lang || '').toUpperCase();
  // muxers fill in generic handler names; only show real track titles
  const name = /^(Sound|Audio)Handler$|^Core Media Audio$/i.test(t.label || '') ? '' : t.label || '';
  return [`Track ${i + 1}`, lang && lang !== 'UND' ? lang : '', name, meta ? `${meta.codec} ${meta.layout}` : ''].filter(Boolean).join(' · ');
};
export function selectedTrack() {
  const list = video.audioTracks ? [...video.audioTracks] : [];
  const i = list.findIndex((t) => t.enabled);
  return i < 0 ? 0 : i;
}
export function setTrack(i, persist = true) {
  for (const el of [video, ahead.el]) {
    if (!el?.audioTracks) continue;
    [...el.audioTracks].forEach((t, k) => (t.enabled = k === i));
  }
  const item = player.current();
  if (persist && item) save({ audioTrack: { ...settings.audioTrack, [fileKey(item.path)]: i } });
}

// ---------------------------------------------------------------- sync offset
// Positive ms: the sound is early, so delay it. Negative ms: the sound is late,
// so a hidden copy of the audio plays that far ahead of the picture.
export const offset = () => settings.audioOffset?.[fileKey(player.current()?.path || '')] || 0;
export function setOffset(ms) {
  const item = player.current();
  if (!item) return;
  save({ audioOffset: { ...settings.audioOffset, [fileKey(item.path)]: ms } });
  apply();
}
export function apply() {
  const item = player.current();
  if (!item || !audio.ctx) return;
  const ms = offset();
  if (audio.delay) audio.delay.delayTime.setTargetAtTime(Math.max(0, ms) / 1000, audio.ctx.currentTime, 0.02);
  const wantAhead = ms < 0 && !item.info.isImage;
  if (wantAhead) {
    if (!ahead.el) {
      ahead.el = new Audio();
      ahead.el.crossOrigin = 'anonymous';
      ahead.el.preload = 'auto';
      ahead.node = audio.ctx.createMediaElementSource(ahead.el);
    }
    const src = mediaUrl(item.playPath);
    if (ahead.el.src !== src) { ahead.el.src = src; ahead.el.addEventListener('loadedmetadata', () => setTrack(selectedTrack(), false), { once: true }); }
    ahead.lead = -ms / 1000;
  } else if (ahead.el) {
    ahead.el.pause();
  }
  if (ahead.active !== wantAhead) { ahead.active = wantAhead; reroute(); }
}
// the node that feeds the audio chain: the video itself, or the "ahead" copy
export const inputNode = () => (ahead.active && ahead.node ? ahead.node : audio.src);

function syncAhead() {
  if (!ahead.active || !ahead.el) return;
  const el = ahead.el;
  el.volume = video.volume;
  el.muted = video.muted;
  el.playbackRate = video.playbackRate;
  if (video.paused) { if (!el.paused) el.pause(); return; }
  const target = video.currentTime + ahead.lead;
  if (Math.abs(el.currentTime - target) > 0.06) el.currentTime = target;
  if (el.paused) el.play().catch(() => {});
}

// ---------------------------------------------------------------- background music
const musicCfg = () => ({ on: false, files: [], volume: 40, ...settings.music });
export const musicSettings = musicCfg;
export function setMusic(patch) {
  save({ music: { ...musicCfg(), ...patch } });
  if ('files' in patch) { music.index = 0; if (music.el) music.el.removeAttribute('src'); }
}
export async function chooseMusic() {
  const files = await api.musicDialog();
  if (files.length) setMusic({ files, on: true });
  return files;
}
function wantMusic() {
  const cfg = musicCfg();
  const item = player.current();
  if (!cfg.on || !cfg.files.length || !item) return false;
  if (item.info.isImage) return true;
  return !video.paused && (video.muted || !item.info.hasAudio);
}
function tickMusic() {
  const cfg = musicCfg();
  const want = wantMusic();
  if (!music.el) {
    if (!want) return;
    music.el = new Audio();
    music.el.addEventListener('ended', () => { music.index = (music.index + 1) % musicCfg().files.length; music.el.src = mediaUrl(musicCfg().files[music.index]); music.el.play().catch(() => {}); });
  }
  const el = music.el;
  // fade toward the target volume
  const target = want ? cfg.volume / 100 : 0;
  // ease toward the target, but at least 0.03 per tick so fades finish in about 2 s
  const delta = target - music.fadeVol;
  music.fadeVol += Math.sign(delta) * Math.min(Math.abs(delta), Math.max(Math.abs(delta) * 0.25, 0.03));
  el.volume = Math.max(0, Math.min(1, music.fadeVol));
  if (want) {
    const src = mediaUrl(cfg.files[music.index % cfg.files.length]);
    if (!el.src || !cfg.files.some((f) => el.src === mediaUrl(f))) el.src = src;
    if (el.paused) el.play().catch(() => {});
  } else if (music.fadeVol === 0 && !el.paused) el.pause();
}
export const nowPlaying = () => {
  const cfg = musicCfg();
  return cfg.files.length ? baseName(cfg.files[music.index % cfg.files.length]) : null;
};
export const musicState = () => ({ playing: !!music.el && !music.el.paused, volume: music.el?.volume || 0, track: nowPlaying() });

// ---------------------------------------------------------------- sound fixes
// A small chain before the volume: wind/rumble filter, hiss cut, clearer voices,
// and a leveller that evens out loud and quiet parts (Gentle, or Night for late viewing).
const fx = { input: null, nodes: [] };
export const soundSettings = () => ({ fix: false, level: 'off', ...settings.sound });
export function chainInput() {
  if (!audio?.ctx) return null;
  if (!fx.input) { fx.input = audio.ctx.createGain(); buildFx(); }
  return fx.input;
}
function buildFx() {
  const ctx = audio.ctx;
  try { fx.input.disconnect(); } catch {}
  for (const n of fx.nodes) try { n.disconnect(); } catch {}
  fx.nodes = [];
  const s = soundSettings();
  let last = fx.input;
  const add = (n) => { last.connect(n); last = n; fx.nodes.push(n); };
  if (s.fix) {
    add(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 120, Q: 0.7 }));       // wind rumble, handling noise
    add(new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 8000, gain: -7 }));   // hiss
    add(new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2800, Q: 0.9, gain: 3 })); // voices
  }
  if (s.level !== 'off') {
    add(new DynamicsCompressorNode(ctx, s.level === 'night'
      ? { threshold: -38, knee: 10, ratio: 10, attack: 0.004, release: 0.25 }
      : { threshold: -26, knee: 18, ratio: 3.5, attack: 0.01, release: 0.3 }));
    add(new GainNode(ctx, { gain: s.level === 'night' ? 2.4 : 1.5 }));                   // make up the lost loudness
  }
  last.connect(audio.gain);
}
export function setSound(patch) {
  save({ sound: { ...soundSettings(), ...patch } });
  if (fx.input) buildFx();
}
