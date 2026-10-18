// Automatic stereo alignment. Grabs a few frames, unwarps the centre of each eye
// to the same flat 90° view, then searches for the vertical shift and roll that
// make the right eye line up with the left. Horizontal shift is allowed but
// ignored: that is normal stereo parallax.
const { spawn } = require('child_process');
const ff = require('./ffmpeg');

const N = 256;          // analysis size per eye
const VIEW_FOV = 60;    // degrees covered by the flat view (narrow = less projection distortion)
const F = N / 2 / Math.tan((VIEW_FOV / 2) * Math.PI / 180); // focal length in px

function eyeChain(format) {
  const p = format.projection;
  const fov = format.fov || 180;
  const inp = p === 'fisheye' ? `fisheye:ih_fov=${fov}:iv_fov=${fov}` : p === 'equirect360' ? 'e' : p === 'equirect180' ? 'hequirect' : null;
  const flat = inp ? `v360=input=${inp}:output=flat:h_fov=${VIEW_FOV}:v_fov=${VIEW_FOV}:w=${N}:h=${N}` : `scale=${N}:${N}`;
  return `${flat},format=gray`;
}

function grabPair(file, format, at) {
  const [lc, rc] = format.layout === 'tb' ? ['crop=iw:ih/2:0:0', 'crop=iw:ih/2:0:ih/2'] : ['crop=iw/2:ih:0:0', 'crop=iw/2:ih:iw/2:0'];
  const chain = eyeChain(format);
  const fc = `[0:v]split[l][r];[l]${lc},${chain}[a];[r]${rc},${chain}[b];[a][b]hstack`;
  return new Promise((resolve) => {
    const p = spawn(ff.ffmpegPath, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-filter_complex', fc, '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    const t = setTimeout(() => p.kill(), 30000);
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('close', () => {
      clearTimeout(t);
      const b = Buffer.concat(chunks);
      if (b.length !== N * N * 2) return resolve(null);
      const A = new Float32Array(N * N), B = new Float32Array(N * N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { A[y * N + x] = b[y * 2 * N + x]; B[y * N + x] = b[y * 2 * N + N + x]; }
      resolve([A, B]);
    });
    p.on('error', () => resolve(null));
  });
}

// Gradient magnitude, so brightness differences between lenses don't matter
function gradient(img, n) {
  const g = new Float32Array(n * n);
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    const i = y * n + x;
    g[i] = Math.abs(img[i + 1] - img[i - 1]) + Math.abs(img[i + n] - img[i - n]);
  }
  return g;
}
function half(img, n) {
  const m = n / 2, o = new Float32Array(m * m);
  for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
    const i = 2 * y * n + 2 * x;
    o[y * m + x] = (img[i] + img[i + 1] + img[i + n] + img[i + n + 1]) / 4;
  }
  return o;
}

// Mean absolute difference of A vs B shifted by (dx, dy) and rotated by r (radians)
function score(A, B, n, dx, dy, r, margin, step = 1) {
  const c = n / 2, cos = Math.cos(r), sin = Math.sin(r);
  let s = 0, k = 0;
  for (let y = margin; y < n - margin; y += step) {
    for (let x = margin; x < n - margin; x += step) {
      const u = x - c, v = y - c;
      const fx = c + u * cos - v * sin + dx, fy = c + u * sin + v * cos + dy;
      const bx = Math.floor(fx), by = Math.floor(fy);
      if (bx < 0 || by < 0 || bx >= n - 1 || by >= n - 1) continue;
      const tx = fx - bx, ty = fy - by, i = by * n + bx;
      const bv = (B[i] * (1 - tx) + B[i + 1] * tx) * (1 - ty) + (B[i + n] * (1 - tx) + B[i + n + 1] * tx) * ty;
      s += Math.abs(A[y * n + x] - bv);
      k++;
    }
  }
  return k ? s / k : Infinity;
}

// Returns { dy (px at N), roll (deg), confidence } for one pair
function estimate(A, B, n = N) {
  const gA = gradient(A, n), gB = gradient(B, n);
  const sA = half(gA, n), sB = half(gB, n), m = n / 2;
  let best = { s: Infinity };
  for (let rd = -3; rd <= 3; rd += 0.5) {
    const r = (rd * Math.PI) / 180;
    for (let dy = -20; dy <= 20; dy++) for (let dx = -18; dx <= 18; dx += 2) {
      const s = score(sA, sB, m, dx, dy, r, 22, 2);
      if (s < best.s) best = { s, dx, dy, rd };
    }
  }
  // refine at full resolution with sub-pixel steps
  let fine = { s: Infinity };
  for (let rd = best.rd - 0.5; rd <= best.rd + 0.5; rd += 0.125) {
    const r = (rd * Math.PI) / 180;
    for (let dy = best.dy * 2 - 2; dy <= best.dy * 2 + 2; dy += 0.25) for (let dx = best.dx * 2 - 3; dx <= best.dx * 2 + 3; dx += 1) {
      const s = score(gA, gB, n, dx, dy, r, 44, 2);
      if (s < fine.s) fine = { s, dx, dy, rd };
    }
  }
  const base = score(gA, gB, n, 0, 0, 0, 44, 2);
  // confidence: how much better the match got (1 = eyes were already identical)
  return { dy: fine.dy, roll: fine.rd, confidence: base < 1e-3 ? 1 : Math.max(0, 1 - fine.s / base) };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// vertical: degrees the right eye sits lower than the left; roll: degrees it is rotated clockwise
async function autoAlign(file, format, duration) {
  if (format.layout === '2d') throw new Error('Auto-align needs a 3D (side-by-side or top-bottom) video');
  const times = [0.25, 0.5, 0.75].map((f) => Math.max(0, (duration || 10) * f));
  const results = [];
  for (const t of times) {
    const pair = await grabPair(file, format, t);
    if (pair) results.push(estimate(pair[0], pair[1]));
  }
  if (!results.length) throw new Error('Could not read frames from this video');
  const dy = median(results.map((r) => r.dy));
  return {
    vertical: Math.atan(dy / F) * 180 / Math.PI,
    roll: median(results.map((r) => r.roll)),
    confidence: median(results.map((r) => r.confidence)),
    samples: results.length
  };
}

module.exports = { autoAlign, estimate, N, F };
