// "Make a flat video": a normal 16:9 video from a VR180 or 360 video, for phones, TVs and
// sharing. The camera either stays where you are looking, or follows a path you record by
// simply watching and looking around (smoothed, so it moves like a camera operator).
import { api, settings, save, baseName, fmtTime } from './core.js';
import { h, ICONS, toast, modal, segmented, field } from './ui.js';
import { openJobs } from './jobs.js';

ICONS.tv = '<rect x="3" y="5" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 21h8M12 17v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';

let P = null;                       // { view, video, stage, cur, setViewMode, osd }
const rec = { on: false, samples: [], timer: null, input: null };
let recorded = null;                // { input, samples, from, to }
let badge = null, badgeTime = null;
const deg = (r) => (r * 180) / Math.PI;

export function initReframe(parts) {
  P = parts;
  badgeTime = h('span', {}, '0:00');
  badge = h('div', { class: 'cam-rec-badge', hidden: true },
    h('i', { class: 'rec-dot' }), h('span', {}, 'Recording the camera: look around'), badgeTime,
    h('button', { class: 'btn small', onclick: () => stopRecording(true) }, 'Stop'));
  P.stage.append(badge);
  P.video.addEventListener('ended', () => { if (rec.on) stopRecording(true); });
}
export const recording = () => rec.on;

function sample() {
  const v = P.video;
  if (!rec.on || v.paused || v.seeking) return;
  const t = v.currentTime;
  // seeking back while recording re-records from there
  while (rec.samples.length && rec.samples[rec.samples.length - 1][0] >= t) rec.samples.pop();
  rec.samples.push([t, -deg(P.view.yaw), deg(P.view.pitch), P.view.camera.fov]);
  badgeTime.textContent = fmtTime(Math.max(0, t - rec.samples[0][0]));
}

export function startRecording(fromStart) {
  const item = P.cur();
  if (!item) return;
  rec.on = true;
  rec.samples = [];
  rec.input = item.path;
  P.setViewMode('vr');
  if (fromStart) P.video.currentTime = 0;
  badge.hidden = false;
  badgeTime.textContent = '0:00';
  clearInterval(rec.timer);
  rec.timer = setInterval(sample, 100);
  P.video.play().catch(() => {});
  P.osd('Recording the camera: look around with the mouse; the wheel zooms');
}

export function stopRecording(openDialog) {
  if (!rec.on) return;
  rec.on = false;
  clearInterval(rec.timer);
  badge.hidden = true;
  P.video.pause();
  if (rec.samples.length > 5) {
    recorded = { input: rec.input, samples: rec.samples, from: rec.samples[0][0], to: rec.samples[rec.samples.length - 1][0] };
    if (openDialog) openReframe();
  } else toast('Too short to use. Record at least a second of looking around.', 'err');
}

// Unwrap the yaw, then a centred moving average: hand movements become camera moves
function smoothPath(samples, amount) {
  const pts = samples.map((s) => [...s]);
  for (let i = 1; i < pts.length; i++) {
    let d = pts[i][1] - pts[i - 1][1];
    while (d > 180) { pts[i][1] -= 360; d -= 360; }
    while (d < -180) { pts[i][1] += 360; d += 360; }
  }
  const half = (amount / 100) * 1.2;   // up to ±1.2 s
  if (half < 0.05) return pts;
  return pts.map((p) => {
    let s1 = 0, s2 = 0, s3 = 0, n = 0;
    for (const q of pts) if (Math.abs(q[0] - p[0]) <= half) { s1 += q[1]; s2 += q[2]; s3 += q[3]; n++; }
    return [p[0], s1 / n, s2 / n, s3 / n];
  });
}

export function openReframe() {
  const item = P.cur();
  if (!item || item.info.isImage || item.format.projection === 'flat') return toast('Open a VR180 or 360 video first.', 'err');
  if (rec.on) return stopRecording(true);
  const mine = recorded?.input === item.path ? recorded : null;
  const cfg = { camera: mine ? 'follow' : 'fixed', size: settings.reframeSize || '1080', smooth: settings.reframeSmooth ?? 60 };
  const here = { yaw: -deg(P.view.yaw), pitch: deg(P.view.pitch), vfov: P.view.camera.fov };
  const body = h('div');
  const m = modal({ title: '📺 Make a flat video', width: 500, body: [h('p', { class: 'muted' }, `${baseName(item.path)} → a normal 16:9 video for phones, TVs and sharing`), body] });
  const paint = () => {
    const smooth = h('input', { type: 'range', min: 0, max: 100, step: 5, value: cfg.smooth });
    smooth.addEventListener('input', () => { cfg.smooth = +smooth.value; save({ reframeSmooth: cfg.smooth }); });
    const followInfo = mine
      ? h('div', { class: 'reframe-rec' }, h('b', {}, `Recorded camera: ${fmtTime(mine.from)} – ${fmtTime(mine.to)}`), ' ',
        h('button', { class: 'btn small', onclick: () => { m.close(); startRecording(false); } }, 'Record again from here'))
      : h('div', { class: 'reframe-rec' },
        h('p', { class: 'muted small' }, 'The video plays, you look around as if holding the camera (mouse to look, wheel to zoom), and the flat video follows. Stop any time; it also stops at the end.'),
        h('div', { class: 'row-btns' },
          h('button', { class: 'btn primary', onclick: () => { m.close(); startRecording(true); } }, '● Record from the beginning'),
          h('button', { class: 'btn', onclick: () => { m.close(); startRecording(false); } }, `● Record from ${fmtTime(P.video.currentTime)}`)));
    body.replaceChildren(
      field('Camera', segmented([{ value: 'follow', label: 'Follow my view' }, { value: 'fixed', label: 'Fixed' }], cfg.camera, (v) => { cfg.camera = v; paint(); }, 'small'),
        'Follow my view: record where you look while it plays. Fixed: the camera stays pointed where you are looking now.'),
      cfg.camera === 'follow' ? followInfo : h('p', { class: 'muted small' }, `Points where you are looking now (${Math.round(here.yaw)}° ${here.yaw >= 0 ? 'right' : 'left'}, ${Math.round(Math.abs(here.pitch))}° ${here.pitch >= 0 ? 'up' : 'down'}). Close this, look somewhere else and open it again to change it.`),
      cfg.camera === 'follow' && mine ? field('Smooth camera', smooth, 'Evens out quick or shaky head and mouse movements') : null,
      field('Size', segmented([{ value: '720', label: '720p' }, { value: '1080', label: '1080p' }, { value: '4k', label: '4K' }], cfg.size, (v) => { cfg.size = v; save({ reframeSize: v }); }, 'small')),
      h('div', { class: 'row-btns' }, h('button', { class: 'btn primary', disabled: cfg.camera === 'follow' && !mine, onclick: go }, 'Make the video')));
  };
  const go = async () => {
    const f = item.format;
    const job = { kind: 'reframe', input: item.path, projection: f.projection, layout: f.layout, fov: item.calib?.fov ?? 180, size: cfg.size };
    if (cfg.camera === 'follow' && mine) Object.assign(job, { path: smoothPath(mine.samples, cfg.smooth), start: mine.from, end: mine.to + 0.1 });
    else Object.assign(job, { path: [[0, here.yaw, here.pitch, here.vfov]] });
    await api.queueAdd([job]);
    m.close();
    toast('Making the flat video… progress is in Jobs.', 'ok', { label: 'Show', onClick: () => openJobs() });
  };
  paint();
}
