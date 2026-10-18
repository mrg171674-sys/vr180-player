// Shared by live 2D → 3D (depth.js) and the 3D video export (depth-worker.js):
// turning picture pixels into the model's input, and its raw output into a steady depth map.
export const IN_W = 518;   // the model's native width; heights must be multiples of 14
export const inputHeight = (w, h) => Math.max(14, Math.round((IN_W * h) / w / 14) * 14);

// RGB(A) bytes -> normalised planar float input (ImageNet mean/std)
export function toInput(px, n, stride, out) {
  const data = out?.length === 3 * n ? out : new Float32Array(3 * n);
  for (let i = 0, p = 0; i < n; i++, p += stride) {
    data[i] = (px[p] / 255 - 0.485) / 0.229;
    data[n + i] = (px[p + 1] / 255 - 0.456) / 0.224;
    data[2 * n + i] = (px[p + 2] / 255 - 0.406) / 0.225;
  }
  return data;
}

// Raw model output -> 0..1 (1 = near): robust range that drifts slowly between frames,
// softened edges (fewer tears where depth jumps), and blending with the previous frame
// to stop flicker, except on hard cuts. mem keeps the state between frames.
export function postDepth(d, w, h, still, mem) {
  const n = w * h;
  const sample = [];
  for (let i = 0; i < n; i += 13) sample.push(d[i]);
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.02)], hi = sample[Math.floor(sample.length * 0.98)];
  const fresh = still || !mem.prev || mem.prev.length !== n;
  mem.lo = fresh ? lo : mem.lo * 0.7 + lo * 0.3;
  mem.hi = fresh ? hi : mem.hi * 0.7 + hi * 0.3;
  const span = Math.max(1e-6, mem.hi - mem.lo);
  const cur = new Float32Array(n);
  for (let i = 0; i < n; i++) cur[i] = Math.min(1, Math.max(0, (d[i] - mem.lo) / span));
  const tmp = new Float32Array(n), R = 2, k = 1 / (2 * R + 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = -R; j <= R; j++) s += cur[y * w + Math.min(w - 1, Math.max(0, x + j))];
    tmp[y * w + x] = s * k;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = -R; j <= R; j++) s += tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x];
    cur[y * w + x] = s * k;
  }
  if (!fresh) {
    let diff = 0;
    for (let i = 0; i < n; i += 7) diff += Math.abs(cur[i] - mem.prev[i]);
    if (diff / (n / 7) < 0.2) for (let i = 0; i < n; i++) cur[i] = cur[i] * 0.55 + mem.prev[i] * 0.45;
  }
  mem.prev = cur;
  return cur;
}
