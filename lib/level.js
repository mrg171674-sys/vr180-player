// Horizon auto-level. Decodes the video at a low frame rate, unwarps the front
// of the left eye to a flat view (where straight lines in the world stay
// straight), and measures how far the scene's horizontal and vertical edges are
// rotated from level. The result is a smoothed roll curve over time.
const { spawn } = require('child_process');
const ff = require('./ffmpeg');

const N = 256;
const MAX_TILT = 20;      // degrees we look for either way
const BIN = 0.25;         // histogram resolution in degrees

function flatChain(format) {
  const crop = format.layout === 'sbs' ? 'crop=iw/2:ih:0:0,' : format.layout === 'tb' ? 'crop=iw:ih/2:0:0,' : '';
  const fov = format.fov || 180;
  const inp = { fisheye: `fisheye:ih_fov=${fov}:iv_fov=${fov}`, equirect180: 'hequirect', equirect360: 'e' }[format.projection];
  const flat = inp ? `v360=input=${inp}:output=flat:h_fov=100:v_fov=100:w=${N}:h=${N}` : `scale=${N}:${N}`;
  return `${crop}${flat},gblur=sigma=1,format=gray`;
}

// Tilt of one frame in degrees, or null if there are no clear lines.
// Per-pixel gradients read shallow lines as level (a line tilted 3° is drawn
// as long flat pixel runs), so edge direction is measured per 8x8 block with a
// structure tensor, which averages the gradients and recovers the true angle.
const BLOCK = 8;
function frameTilt(g) {
  const bins = new Float64Array(Math.round((2 * MAX_TILT) / BIN) + 1);
  let total = 0;
  const m = 4; // skip the edges of the view
  for (let by = m; by + BLOCK <= N - m; by += BLOCK / 2) {
    for (let bx = m; bx + BLOCK <= N - m; bx += BLOCK / 2) {
      let jxx = 0, jyy = 0, jxy = 0;
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          const i = y * N + x;
          const gx = (g[i - N + 1] + 2 * g[i + 1] + g[i + N + 1]) - (g[i - N - 1] + 2 * g[i - 1] + g[i + N - 1]);
          const gy = (g[i + N - 1] + 2 * g[i + N] + g[i + N + 1]) - (g[i - N - 1] + 2 * g[i - N] + g[i - N + 1]);
          jxx += gx * gx; jyy += gy * gy; jxy += gx * gy;
        }
      }
      const energy = jxx + jyy;
      if (energy < 64 * 4000) continue;
      // coherence: 1 for a single clean straight edge, 0 for texture or corners
      const coh = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / energy;
      if (coh < 0.6) continue;
      // dominant gradient direction, then the edge is perpendicular to it
      let a = (0.5 * Math.atan2(2 * jxy, jxx - jyy) * 180) / Math.PI + 90;
      a = ((a % 90) + 90) % 90;
      if (a > 45) a -= 90;
      if (Math.abs(a) > MAX_TILT) continue;
      const w = Math.sqrt(energy) * coh * coh;
      const b = (a + MAX_TILT) / BIN;
      const b0 = Math.floor(b), f = b - b0;
      bins[b0] += w * (1 - f);
      if (b0 + 1 < bins.length) bins[b0 + 1] += w * f;
      total += w;
    }
  }
  if (total < 2e3) return null;
  // smooth the histogram, take its peak, refine with a parabola
  const s = bins.map((_, i) => [-3, -2, -1, 0, 1, 2, 3].reduce((acc, k) => acc + (bins[i + k] || 0) * (4 - Math.abs(k)), 0));
  let best = 0;
  for (let i = 1; i < s.length; i++) if (s[i] > s[best]) best = i;
  const l = s[best - 1] ?? s[best], r = s[best + 1] ?? s[best];
  const denom = l - 2 * s[best] + r;
  const off = denom ? (0.5 * (l - r)) / denom : 0;
  // confidence: how much of the edge energy sits near the peak
  const near = s.slice(Math.max(0, best - 8), best + 9).reduce((a, b) => a + b, 0) / s.reduce((a, b) => a + b, 0);
  return { tilt: (best + off) * BIN - MAX_TILT, confidence: near };
}

// Rotate a gray frame about its centre (bilinear), used to refine the estimate
function rotateFrame(g, deg) {
  const out = new Uint8Array(N * N);
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r), h = N / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x - h, v = y - h;
      const sx = c * u - s * v + h, sy = s * u + c * v + h;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= N - 1 || y0 >= N - 1) continue;
      const fx = sx - x0, fy = sy - y0, i = y0 * N + x0;
      out[y * N + x] = (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + N] * (1 - fx) + g[i + N + 1] * fx) * fy;
    }
  }
  return out;
}

// Measure, counter-rotate by the estimate, and measure what's left: the
// estimator is most accurate near level, so two refinements close the gap.
function frameTiltRefined(g) {
  const first = frameTilt(g);
  if (!first) return null;
  let tilt = first.tilt;
  for (let k = 0; k < 2; k++) {
    const res = frameTilt(rotateFrame(g, tilt));
    if (!res) break;
    tilt += res.tilt;
  }
  return { tilt, confidence: first.confidence };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function smooth(values, interval) {
  // fill gaps, median filter (kills one-frame mistakes), then moving average (~2 s)
  const filled = values.slice();
  let last = filled.find((v) => v != null) ?? 0;
  for (let i = 0; i < filled.length; i++) { if (filled[i] == null) filled[i] = last; else last = filled[i]; }
  const med = filled.map((_, i) => median(filled.slice(Math.max(0, i - 2), i + 3)));
  const k = Math.max(1, Math.round(1 / interval));
  return med.map((_, i) => {
    const w = med.slice(Math.max(0, i - k), i + k + 1);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
}

// Returns { interval, rolls[] (degrees, smoothed), fixed (one angle for the whole clip), samples, confident }
function analyze(file, format, duration, onProgress, isCancelled = () => false) {
  const interval = Math.max(0.5, (duration || 1) / 1200);
  return new Promise((resolve, reject) => {
    const p = spawn(ff.ffmpegPath, ['-v', 'error', '-i', file, '-an', '-sn', '-vf', `fps=${1 / interval},${flatChain(format)}`, '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const frameSize = N * N;
    let buf = Buffer.alloc(0);
    const raw = [];
    const confs = [];
    const expected = Math.max(1, Math.floor((duration || 1) / interval));
    p.stdout.on('data', (chunk) => {
      if (isCancelled()) { p.kill(); return; }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= frameSize) {
        const r = frameTiltRefined(buf.subarray(0, frameSize));
        raw.push(r ? r.tilt : null);
        confs.push(r ? r.confidence : 0);
        buf = buf.subarray(frameSize);
        if (raw.length % 10 === 0) onProgress?.(Math.min(1, raw.length / expected));
      }
    });
    p.on('error', reject);
    p.on('close', () => {
      if (isCancelled()) return reject(new Error('cancelled'));
      if (!raw.length) return reject(new Error('Could not read frames from this video'));
      const rolls = smooth(raw, interval);
      const good = raw.filter((v) => v != null);
      resolve({
        interval,
        rolls: rolls.map((v) => +v.toFixed(3)),
        fixed: +median(good).toFixed(3),
        samples: raw.length,
        confident: good.length / raw.length > 0.5 && median(confs) > 0.25
      });
    });
  });
}

// ffmpeg sendcmd script that turns v360's roll over time (export of "follow" mode)
function sendcmdScript(rolls, interval, start = 0, sign = 1) {
  return rolls.map((r, i) => {
    const t = i * interval - start;
    return t < 0 ? null : `${t.toFixed(3)} v360@lvl roll ${(sign * r).toFixed(3)};`;
  }).filter(Boolean).join('\n') + '\n';
}

module.exports = { analyze, frameTilt, frameTiltRefined, rotateFrame, sendcmdScript, flatChain, N };
