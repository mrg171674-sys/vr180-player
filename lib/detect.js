// Works out what kind of VR video a file is: projection (fisheye / equirect180 /
// equirect360 / flat) and stereo layout (2d / sbs / tb). Uses, in order:
// spherical metadata, filename hints, then a few tiny decoded frames (stereo halves
// look alike; fisheye lenses leave black corners), then the frame's shape.
// Each result carries a confidence, so the app can say when it is only guessing.
const { spawn } = require('child_process');
const path = require('path');
const ff = require('./ffmpeg');
const photo = require('./photo');

const N = 128; // analysis frame is N x N grayscale

function grabFrame(file, at) {
  return new Promise((resolve) => {
    // (seeking a single image returns nothing, so only seek in videos)
    const p = spawn(ff.ffmpegPath, ['-v', 'error', ...(at > 0 ? ['-ss', String(at)] : []), '-i', file, '-frames:v', '1',
      '-vf', `scale=${N}:${N},format=gray`, '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    const timer = setTimeout(() => p.kill(), 20000);
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', () => { clearTimeout(timer); const b = Buffer.concat(chunks); resolve(b.length === N * N ? b : null); });
    p.on('error', () => resolve(null));
  });
}

const px = (g, x, y) => g[Math.min(N - 1, Math.max(0, y | 0)) * N + Math.min(N - 1, Math.max(0, x | 0))];
function mean(g, x0, y0, w, h) {
  let s = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { s += px(g, x, y); n++; }
  return n ? s / n : 0;
}
function std(g) {
  let s = 0, s2 = 0;
  for (const v of g) { s += v; s2 += v * v; }
  const m = s / g.length;
  return Math.sqrt(Math.max(0, s2 / g.length - m * m));
}
// Detail across the frame, ignoring smooth top-to-bottom gradients (sky / sea / sand)
function horizontalDetail(g) {
  let d = 0;
  for (let y = 0; y < N; y++) for (let x = 1; x < N; x++) d += Math.abs(px(g, x, y) - px(g, x - 1, y));
  return d / (N * (N - 1));
}
// How alike two halves are, relative to the detail in the frame (0 = identical)
function halfDiff(g, horizontal) {
  let d = 0, n = 0;
  const h = N / 2;
  // rows / columns that are flat (letterbox or pillarbox bars) look alike in any video; skip them
  const flatRow = (y) => { let a = 255, b = 0; for (let x = 0; x < N; x++) { const v = px(g, x, y); a = Math.min(a, v); b = Math.max(b, v); } return b - a < 6; };
  const flatCol = (x) => { let a = 255, b = 0; for (let y = 0; y < N; y++) { const v = px(g, x, y); a = Math.min(a, v); b = Math.max(b, v); } return b - a < 6; };
  for (let y = 0; y < (horizontal ? N : h); y++) {
    if (horizontal ? flatRow(y) : flatRow(y) && flatRow(y + h)) continue;
    for (let x = 0; x < (horizontal ? h : N); x++) {
      if (!horizontal && flatCol(x)) continue;
      d += Math.abs(px(g, x, y) - (horizontal ? px(g, x + h, y) : px(g, x, y + h)));
      n++;
    }
  }
  return n < N * 8 ? 9 : d / n / (std(g) + 1); // mostly bars: no opinion
}
// Fisheye lenses leave the corners of their (roughly square) image black
function looksFisheye(g, ex, ey, ew, eh) {
  const c = Math.max(2, Math.round(Math.min(ew, eh) * 0.07));
  const corners = [mean(g, ex, ey, c, c), mean(g, ex + ew - c, ey, c, c), mean(g, ex, ey + eh - c, c, c), mean(g, ex + ew - c, ey + eh - c, c, c)];
  const centre = mean(g, ex + ew * 0.35, ey + eh * 0.35, ew * 0.3, eh * 0.3);
  // letterboxed / pillarboxed films have black bars along a whole edge, not just the corners
  const edges = [mean(g, ex + ew * 0.4, ey, ew * 0.2, c), mean(g, ex + ew * 0.4, ey + eh - c, ew * 0.2, c), mean(g, ex, ey + eh * 0.4, c, eh * 0.2), mean(g, ex + ew - c, ey + eh * 0.4, c, eh * 0.2)];
  const barred = edges.filter((e) => e < 18).length >= 2;
  return Math.max(...corners) < 18 && centre > Math.max(...corners) + 12 && !barred;
}

// Filename hints. Numbers only count as a separate word, so timestamps and counters
// (VID_20240913_180512, IMG_1360) don't turn ordinary videos into VR.
const W = (re) => new RegExp(`(^|[^a-z0-9])(${re})([^a-z0-9]|$)`);
function hints(name) {
  const n = name.toLowerCase();
  const h = {};
  if (W('hsbs|h-sbs|half[-_ ]?sbs|hou|h-ou|htab|h-tab|half[-_ ]?(ou|tb|tab)').test(n)) h.half = true;
  else if (W('fsbs|f-sbs|full[-_ ]?sbs|fou|f-ou|full[-_ ]?(ou|tb|tab)').test(n)) h.half = false;
  if (W('lr|sbs|hsbs|h-sbs|fsbs|f-sbs|3dh|(half|full)[-_ ]?sbs').test(n) || /side[-_ ]?by[-_ ]?side/.test(n)) h.layout = 'sbs';
  else if (W('tb|ou|hou|h-ou|fou|f-ou|tab|htab|3dv|overunder|(half|full)[-_ ]?(ou|tb|tab)').test(n) || /top[-_ ]?(and[-_ ]?)?bottom|over[-_ ]?under/.test(n)) h.layout = 'tb';
  else if (W('mono|2d').test(n)) h.layout = '2d';
  if (W('360|vr360|360vr|360°').test(n) || /\.(360|insv)$/.test(n)) h.projection = 'equirect360';
  else if (/fisheye|dual[-_ ]?fisheye|mkx\d+|rf5\.?2/.test(n)) h.projection = 'fisheye';
  else if (/vr180|180vr/.test(n) || W('180|180°').test(n)) h.projection = 'equirect180';
  return h;
}

const near = (v, t, tol) => Math.abs(v - t) <= tol;
const majority = (votes) => {
  const c = {};
  for (const v of votes) c[v] = (c[v] || 0) + 1;
  const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return best ? { value: best[0], agree: best[1], total: votes.length } : null;
};

async function analyze(file) {
  const info = await ff.probe(file);
  const h = hints(path.basename(file));
  // Google VR180 / Cardboard photos: right eye hidden in the XMP, coverage in GPano
  if (info.isImage) {
    const vr = await photo.inspect(file).catch(() => null);
    if (vr) {
      info.photo = { rightEye: vr.rightEye };
      const projection = vr.coverage || (near(info.width / info.height, 2, 0.1) ? 'equirect360' : 'equirect180');
      return { ...info, format: { projection, layout: vr.layout, fov: 180 }, detectedBy: 'VR photo metadata', confidence: 'high' };
    }
  }
  // the displayed shape (after rotation and pixel aspect), which is what the frames show too
  const w = info.displayWidth || info.width, ht = info.displayHeight || info.height;
  const r = w / ht;
  const reasons = [];
  let confidence = 'high';

  // A few frames spread through the clip; blank or uniform frames don't get a vote
  let frames = [];
  const needFrames = !info.stereo || !info.spherical;
  if (needFrames) {
    const d = info.duration || 0;
    const times = info.isImage || d < 3 ? [0] : [0.15, 0.45, 0.75].map((f) => Math.min(d - 0.5, Math.max(0.5, d * f)));
    frames = (await Promise.all(times.map((t) => grabFrame(file, t)))).filter(Boolean);
  }
  const useful = frames.filter((g) => std(g) >= 8 && horizontalDetail(g) >= 1.5);

  // ---- stereo layout
  let layout = info.stereo, src = 'metadata';
  if (!layout && h.layout) { layout = h.layout; src = 'filename'; }
  if (!layout && useful.length) {
    const votes = useful.map((g) => {
      const sbs = halfDiff(g, true), tb = halfDiff(g, false);
      if (r > 1.6 && sbs < 0.45) return 'sbs';
      if (r < 1.25 && tb < 0.45 && h.projection !== 'equirect180' && ht >= 1600) return 'tb';
      return '2d';
    });
    const m = majority(votes);
    layout = m.value;
    src = 'picture';
    if (m.agree < m.total) confidence = 'medium';
  }
  if (!layout) {
    layout = near(r, 2, 0.15) && w >= 2880 ? 'sbs' : near(r, 0.5, 0.08) && ht >= 2880 ? 'tb' : '2d';
    src = 'shape';
    confidence = 'low';
  }
  reasons.push(`layout from ${src}`);

  // ---- projection
  const ew = layout === 'sbs' ? w / 2 : w;
  const eh = layout === 'tb' ? ht / 2 : ht;
  const er = ew / eh;
  let projection = info.spherical === 'equirect180' || info.spherical === 'equirect360' ? info.spherical : null;
  let half = h.half;
  src = 'metadata';
  if (!projection && h.projection) { projection = h.projection; src = 'filename'; }
  // a fisheye eye is about square; only then do black corners mean a lens circle
  if (!projection && useful.length && near(er, 1, 0.25)) {
    const gx = layout === 'sbs' ? N / 2 : N, gy = layout === 'tb' ? N / 2 : N;
    const fish = useful.filter((g) => looksFisheye(g, 0, 0, gx, gy)).length;
    if (fish && fish * 2 >= useful.length) { projection = 'fisheye'; src = 'picture'; if (fish < useful.length && confidence === 'high') confidence = 'medium'; }
  }
  if (!projection) {
    // 16:9 side-by-side (or 16:9 over-under) is a half-width 3D film, not VR180
    if (layout === 'sbs' && near(r, 16 / 9, 0.12)) { projection = 'flat'; half = half ?? true; }
    else if (layout === 'tb' && near(r, 16 / 9, 0.12)) { projection = 'flat'; half = half ?? true; }
    else if (layout === 'sbs' && near(r, 2, 0.1)) projection = 'equirect180';
    else if (layout === 'sbs' && near(r, 32 / 9, 0.2)) projection = 'flat';
    else if (layout === 'tb' && near(r, 0.5, 0.08)) projection = 'equirect180';
    else if (layout === 'tb' && near(r, 1, 0.08) && w >= 2048) projection = 'equirect360';
    // a mono square is VR180 only at VR resolutions; small squares are social-media videos
    else if (layout === '2d' && near(er, 1, 0.06) && Math.min(w, ht) >= 1400) projection = 'equirect180';
    else if (near(er, 2, 0.06) && w >= 1920) projection = 'equirect360';
    else projection = 'flat';
    src = 'shape';
    if (projection !== 'flat' && confidence === 'high') confidence = 'medium';
  }
  reasons.push(`projection from ${src}`);
  const format = { projection, layout, fov: 180 };
  if (half != null && layout !== '2d' && projection === 'flat') format.half = half;
  return { ...info, format, detectedBy: reasons.join(', '), confidence };
}

module.exports = { analyze, hints };
