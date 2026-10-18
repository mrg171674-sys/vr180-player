// "Make a flat video": a normal 16:9 video cut out of a VR180 / 360 video, the camera
// either fixed or following a path you recorded while watching. ffmpeg's v360 filter
// renders the view; sendcmd moves it frame by frame.
const fs = require('fs');
const path = require('path');
const os = require('os');
const ff = require('./ffmpeg');
const encoders = require('./encoders');

const RATES = [[23.976, '24000/1001'], [29.97, '30000/1001'], [59.94, '60000/1001']];
const rateOf = (fps) => (RATES.find(([f]) => Math.abs(f - fps) < 0.01) || [0, String(fps || 30)])[1];
const hfovOf = (v, aspect) => (2 * Math.atan(Math.tan((v * Math.PI) / 360) * aspect) * 180) / Math.PI;

// camera at time t: linear between samples [t, yaw, pitch, vfov]
function at(pathPts, t) {
  if (!pathPts.length) return [0, 0, 0, 60];
  if (t <= pathPts[0][0]) return pathPts[0];
  const last = pathPts[pathPts.length - 1];
  if (t >= last[0]) return last;
  let lo = 0, hi = pathPts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pathPts[m][0] <= t) lo = m; else hi = m; }
  const a = pathPts[lo], b = pathPts[hi], f = (t - a[0]) / (b[0] - a[0] || 1);
  // yaw takes the short way round
  let dy = b[1] - a[1];
  if (dy > 180) dy -= 360; else if (dy < -180) dy += 360;
  return [t, a[1] + dy * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

// sendcmd script. v360 treats each yaw/pitch command as a turn from where the camera
// points now (it multiplies onto its current orientation), so every step undoes the old
// pitch, turns by the change in yaw and applies the new pitch: the camera lands exactly
// on the wanted direction and never drifts. Lines only where the view moved noticeably.
function commands(pathPts, start, length, fps, aspect) {
  const lines = [];
  const first = at(pathPts, start);
  let prev = [first[1], first[2], first[3]];   // the filter starts here (its options)
  const n = Math.ceil(length * fps);
  for (let i = 1; i <= n; i++) {
    const t = i / fps;
    const [, yaw, pitch, v] = at(pathPts, start + t);
    let dy = yaw - prev[0];
    dy = ((dy + 540) % 360) - 180;
    const turn = Math.abs(dy) >= 0.03 || Math.abs(pitch - prev[1]) >= 0.03;
    const zoom = Math.abs(v - prev[2]) >= 0.05;
    if (!turn && !zoom) continue;
    const cmds = [];
    if (turn) {
      if (Math.abs(prev[1]) > 1e-4) cmds.push(`v360 pitch ${(-prev[1]).toFixed(4)}`);
      if (Math.abs(dy) > 1e-4) cmds.push(`v360 yaw ${dy.toFixed(4)}`);
      if (Math.abs(pitch) > 1e-4) cmds.push(`v360 pitch ${pitch.toFixed(4)}`);
      prev[0] += dy;
      prev[1] = pitch;
    }
    if (zoom) { cmds.push(`v360 v_fov ${v.toFixed(3)}`, `v360 h_fov ${hfovOf(v, aspect).toFixed(3)}`); prev[2] = v; }
    if (cmds.length) lines.push(`${t.toFixed(4)} ${cmds.join(', ')};`);
  }
  return lines.join('\n');
}

async function reframe(opts, onProgress, id) {
  const info = await ff.probe(opts.input);
  if (info.isImage) throw new Error('This works on videos.');
  const fps = info.fps || 30, rate = rateOf(fps);
  const [W, H] = opts.size === '4k' ? [3840, 2160] : opts.size === '720' ? [1280, 720] : [1920, 1080];
  const aspect = W / H;
  const start = Math.max(0, opts.start || 0);
  const end = Math.min(info.duration, opts.end || info.duration);
  const length = Math.max(0.1, end - start);
  const inProj = opts.projection === 'fisheye' ? `fisheye:ih_fov=${opts.fov || 180}:iv_fov=${opts.fov || 180}`
    : opts.projection === 'equirect360' ? 'e' : 'hequirect';
  const stereo = opts.layout === 'sbs' || opts.layout === 'tb' ? opts.layout : '2d';
  const pts = (opts.path && opts.path.length ? opts.path : [[0, opts.yaw || 0, opts.pitch || 0, opts.vfov || 60]]).map((p) => p.map(Number));
  const first = at(pts, start);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-render-'));
  const part = opts.output + '.part.mp4';
  let done = false;
  try {
    const moving = pts.length > 1;
    if (moving) fs.writeFileSync(path.join(work, 'camera.txt'), commands(pts, start, length, fps, aspect));
    const v360 = `v360=input=${inProj}:output=flat:in_stereo=${stereo}:out_stereo=2d:yaw=${(((first[1] + 540) % 360) - 180).toFixed(3)}:pitch=${first[2].toFixed(3)}` +
      `:v_fov=${first[3].toFixed(3)}:h_fov=${hfovOf(first[3], aspect).toFixed(3)}:w=${W}:h=${H}:interp=cubic`;
    const vf = [moving ? 'sendcmd=f=camera.txt' : null, v360, 'format=yuv420p'].filter(Boolean).join(',');
    const enc = await encoders.videoArgs({ codec: 'h264', crf: opts.crf || 19, width: W });
    const args = ['-hide_banner', '-y', '-ss', start.toFixed(3), '-t', length.toFixed(3), '-i', opts.input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf,
      ...enc.args, '-r', rate, '-c:a', 'aac', '-b:a', '192k', '-ac', '2', ...ff.NO_LOCATION, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', part];
    onProgress({ fraction: 0, stage: 'Filming the flat video…' });
    await ff.run(args, { id, cwd: work, duration: length, onProgress: (q) => onProgress({ fraction: q.fraction, stage: `Filming the flat video… ${Math.round(q.fraction * 100)}%` }) });
    fs.renameSync(part, opts.output);
    done = true;
    return { output: opts.output, width: W, height: H, gpu: enc.gpu, stage: `Done · flat ${W}×${H}${moving ? ' · follows your view' : ''}`, kind: 'reframe' };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    if (!done) try { fs.rmSync(part, { force: true }); } catch {}
  }
}

module.exports = { reframe, commands, at };
