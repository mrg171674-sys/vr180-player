// Highlight reel without AI: score every second of a video by how much is
// happening on screen (motion) and how loud it is, then keep the best moments.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ff = require('./ffmpeg');
const { flatChain } = require('./library');

// one pass over a small, unwarped view: scene-change score per frame + momentary loudness
async function analyze(file, info, onProgress = () => {}, id) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-hl-'));
  try {
    const vf = ['fps=4', 'scale=960:-2', ...flatChain(info.format, 160, 100), "select='gte(scene,0)'", 'metadata=print:file=motion.txt'].join(',');
    const graph = [`[0:v:0]${vf}[v]`];
    if (info.hasAudio) graph.push('[0:a:0]ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file=loud.txt[a]');
    await ff.run(['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', file, '-filter_complex', graph.join(';'),
      '-map', '[v]', ...(info.hasAudio ? ['-map', '[a]'] : []), '-f', 'null', '-'], { id, cwd: work, duration: info.duration, onProgress: (p) => onProgress(p.fraction) });
    const secs = Math.max(1, Math.ceil(info.duration));
    const motion = perSecond(fs.readFileSync(path.join(work, 'motion.txt'), 'utf8'), 'lavfi.scene_score', secs);
    const loud = info.hasAudio && fs.existsSync(path.join(work, 'loud.txt')) ? perSecond(fs.readFileSync(path.join(work, 'loud.txt'), 'utf8'), 'lavfi.r128.M', secs) : null;
    return { motion, loud };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// "frame:… pts_time:12.25" followed by "key=value" lines -> average value per whole second
function perSecond(text, key, secs) {
  const sum = new Float64Array(secs), n = new Uint32Array(secs);
  let t = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) { t = Math.min(secs - 1, Math.floor(+m[1])); continue; }
    if (t != null && line.startsWith(key + '=')) {
      const v = parseFloat(line.slice(key.length + 1));
      if (isFinite(v)) { sum[t] += v; n[t]++; }
    }
  }
  return Array.from(sum, (s, i) => (n[i] ? s / n[i] : null));
}

// scale to 0..1 between the 10th and 95th percentile, so motion and loudness are comparable
// and long stretches where nothing happens all score (near) zero
function ranks(arr) {
  const vals = arr.filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return arr.map(() => 0);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
  const lo = q(0.1), hi = q(0.95);
  return arr.map((v) => (v == null || !isFinite(v) || hi <= lo ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)))));
}
const smooth = (a, r = 1) => a.map((_, i) => { let s = 0, n = 0; for (let j = i - r; j <= i + r; j++) if (j >= 0 && j < a.length) { s += a[j]; n++; } return s / n; });

// pick the best windows (3–8 s each, at least 10 s apart) until the target length
function pick({ motion, loud }, duration, target = 60) {
  if (duration <= target + 5) return { segments: [{ start: 0, end: +duration.toFixed(3) }], scores: [] };
  const m = ranks(motion);
  const l = loud ? ranks(loud) : null;
  const score = smooth(m.map((v, i) => (l ? 0.6 * v + 0.4 * l[i] : v)), 1);
  const order = score.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
  const chosen = [];
  let total = 0;
  for (const [s, i] of order) {
    if (total >= target) break;
    if (s < 0.2 && total >= Math.min(15, target / 2)) break; // only quiet moments left
    if (chosen.some((c) => Math.abs(c.center - i) < 10)) continue;
    // a hotter peak earns a longer window
    const len = Math.min(8, Math.max(3, Math.round(3 + 5 * s)));
    let start = Math.max(0, i - len / 2);
    let end = Math.min(duration, start + len);
    start = Math.max(0, end - len);
    chosen.push({ center: i, start, end, score: s });
    total += end - start;
  }
  chosen.sort((a, b) => a.start - b.start);
  // merge windows that touch
  const segments = [];
  for (const c of chosen) {
    const last = segments[segments.length - 1];
    if (last && c.start <= last.end + 0.5) last.end = Math.max(last.end, c.end);
    else segments.push({ start: +c.start.toFixed(3), end: +c.end.toFixed(3) });
  }
  return { segments, scores: score };
}

module.exports = { analyze, pick, perSecond };
