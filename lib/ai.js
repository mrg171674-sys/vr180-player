// Local AI jobs that run through the same queue as conversions:
//  - speech to subtitles with whisper.cpp (99 languages, optional translation to English)
//  - AI upscaling with Real-ESRGAN on the graphics card, a few seconds of video at a time
//    so the temporary frames never fill the disk
// Both use add-ons from lib/models.js; nothing leaves the PC.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');
const models = require('./models');
const encoders = require('./encoders');
const { injectVR180InPlace } = require('./inject-vr180');

const jobs = new Map();   // job id -> { cancelled, proc }
let subsDir = null;       // fallback place for subtitles when the video's folder is read-only
function init(userData) { subsDir = path.join(userData, 'subtitles'); }

const LANGS = { en: 'English', de: 'German', nl: 'Dutch', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', pl: 'Polish', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', ru: 'Russian', uk: 'Ukrainian', tr: 'Turkish', ar: 'Arabic', he: 'Hebrew', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', cs: 'Czech', el: 'Greek', hu: 'Hungarian', ro: 'Romanian' };
const langName = (c) => LANGS[c] || (c || '?').toUpperCase();

function checkCancel(id) { if (jobs.get(id)?.cancelled) throw new Error('cancelled'); }
function cancel(id) {
  const j = jobs.get(id);
  if (!j) return;
  j.cancelled = true;
  try { j.proc?.kill(); } catch {}
  for (const p of j.procs || []) try { p.kill(); } catch {}
  try { j.onCancel?.(); } catch {}
  ff.cancel(id);
}

// Runs an add-on program, passing each output line on (progress), killable via cancel()
function exec(id, exe, args, { onLine, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const j = jobs.get(id);
    if (j?.cancelled) return reject(new Error('cancelled'));
    const p = spawn(exe, args, { windowsHide: true, cwd });
    if (j) j.proc = p;
    let tail = '', buf = '';
    const feed = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-20000);
      buf += s;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      for (const l of lines) onLine?.(l);
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => {
      if (j) j.proc = null;
      if (j?.cancelled) return reject(new Error('cancelled'));
      if (code === 0) return resolve(tail);
      const e = new Error(tail.trim().split('\n').slice(-3).join('\n') || `${path.basename(exe)} stopped (code ${code})`);
      e.stderrTail = tail.trim().split('\n').slice(-40).join('\n');
      reject(e);
    });
  });
}

// ---------------------------------------------------------------- subtitles
// Sidecar file next to the video ("beach.en.auto.srt"), so other players find it too
function sidecarDir(video) { return path.join(subsDir || os.tmpdir(), crypto.createHash('sha1').update(path.resolve(video).toLowerCase()).digest('hex').slice(0, 12)); }
function writeSidecar(video, tag, text) {
  const name = path.basename(video).replace(/\.[^.]+$/, '') + '.' + tag + '.srt';
  const next = path.join(path.dirname(video), name);
  try { fs.writeFileSync(next, text); return next; } catch {}
  const dir = sidecarDir(video);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

// Whisper's own segment times often start seconds early. Per-word times from DTW alignment
// are accurate, so the cues are rebuilt from those: short two-line subtitles that appear
// as the words are spoken and stay long enough to read.
const ts = (s) => { const ms = Math.max(0, Math.round(s * 1000)); return new Date(ms).toISOString().slice(11, 23).replace('.', ','); };
function buildSrt(json) {
  const words = [];
  for (const seg of json.transcription || []) {
    for (const t of seg.tokens || []) {
      if (!t.text || /^\[_/.test(t.text)) continue;           // timing and control tokens
      if (!(t.t_dtw >= 0)) return null;                        // no alignment: use whisper's own cues
      const time = t.t_dtw / 100;
      // t: when the word is spoken (its first token), t1: its last token (punctuation trails)
      if (/^\s/.test(t.text) || !words.length) words.push({ text: t.text.trim(), t: time, t1: time });
      else { const w = words.at(-1); w.text += t.text; w.t1 = Math.max(w.t1, time); }
    }
  }
  const cues = [];
  let cur = null;
  for (const w of words) {
    if (!w.text) continue;
    if (cur) {
      const last = cur.words.at(-1);
      const len = cur.text.length + 1 + w.text.length;
      const sentenceDone = /[.!?。！？]$/.test(last.text) && cur.text.length >= 15;
      const clause = /[,;:，、]$/.test(last.text) && cur.text.length > 50;
      if (w.t - last.t > 1.5 || len > 84 || w.t - cur.words[0].t > 6 || sentenceDone || clause) { cues.push(cur); cur = null; }
    }
    if (!cur) cur = { words: [], text: '' };
    cur.words.push(w);
    cur.text = cur.text ? cur.text + ' ' + w.text : w.text;
  }
  if (cur) cues.push(cur);
  cues.forEach((c, i) => {
    c.start = Math.max(i ? cues[i - 1].end + 0.04 : 0, c.words[0].t - 0.45);
    const next = cues[i + 1] ? cues[i + 1].words[0].t - 0.5 : Infinity;
    c.end = Math.min(next, Math.max(Math.min(c.words.at(-1).t1, c.words.at(-1).t + 0.6) + 0.5, c.start + 1.2));
    if (c.end <= c.start) c.end = c.start + 0.8;
  });
  const lines = (t) => {
    if (t.length <= 42) return t;
    const mid = t.length / 2;
    let best = -1;
    for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    return best < 0 ? t : t.slice(0, best) + '\n' + t.slice(best + 1);
  };
  return cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${lines(c.text)}\n`).join('\n');
}

async function transcribe(opts, onProgress, id) {
  const p = models.paths();
  if (!p.whisperCli || !p.whisperModel) throw new Error('Auto subtitles are not installed. Turn them on in Settings › AI features.');
  jobs.set(id, { cancelled: false });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-ai-'));
  try {
    const info = await ff.probe(opts.input);
    if (!info.hasAudio) throw new Error('This video has no sound to make subtitles from.');
    onProgress({ fraction: 0, stage: 'Reading the sound…' });
    const wav = path.join(tmp, 'audio.wav');
    await ff.run(['-hide_banner', '-y', '-i', opts.input, '-map', `0:a:${opts.audioTrack || 0}?`, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-progress', 'pipe:1', '-nostats', wav], { id, duration: info.duration, onProgress: (q) => onProgress({ fraction: q.fraction * 0.04, stage: 'Reading the sound…' }) });
    checkCancel(id);
    let lang = opts.language && opts.language !== 'auto' ? opts.language : null;
    const threads = Math.max(2, Math.min(8, os.cpus().length - 2));
    // -dtw: word-level alignment (needs flash attention off); JSON keeps those word times
    const args = ['-m', p.whisperModel, '-f', wav, '-l', lang || 'auto', '-osrt', '-oj', '-ojf', '-of', path.join(tmp, 'out'), '-pp',
      '-t', String(threads), '-sns', '-dtw', 'base', '-nfa'];
    if (opts.translate) args.push('-tr');
    onProgress({ fraction: 0.04, stage: 'Listening… 0%' });
    await exec(id, p.whisperCli, args, {
      cwd: path.dirname(p.whisperCli),
      onLine: (l) => {
        const m = /progress\s*=\s*(\d+)%/.exec(l);
        if (m) onProgress({ fraction: 0.04 + 0.95 * (+m[1] / 100), stage: `Listening${lang ? ' (' + langName(lang) + ')' : ''}… ${m[1]}%` });
        const d = /auto-detected language:\s*([a-z]{2,3})/.exec(l);
        if (d) lang = d[1];
      }
    });
    let srt = null;
    try { srt = buildSrt(JSON.parse(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8'))); } catch {}
    if (!srt) srt = fs.readFileSync(path.join(tmp, 'out.srt'), 'utf8');
    const cues = (srt.match(/-->/g) || []).length;
    if (!cues) throw new Error('No speech was found in this video.');
    const code = opts.translate ? 'en' : (lang || 'und');
    const output = writeSidecar(opts.input, code + '.auto', srt);
    const what = opts.translate && lang && lang !== 'en' ? `${langName(lang)} → English` : langName(code);
    return { output, stage: `Done · ${what} subtitles · ${cues} lines`, language: code, cues, kind: 'subs' };
  } finally {
    jobs.delete(id);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- upscaling
const RATES = [[23.976, '24000/1001'], [29.97, '30000/1001'], [47.952, '48000/1001'], [59.94, '60000/1001'], [119.88, '120000/1001']];
const rateOf = (fps) => (RATES.find(([f]) => Math.abs(f - fps) < 0.01) || [0, String(fps || 30)])[1];
const count = (dir) => { try { return fs.readdirSync(dir).length; } catch { return 0; } };

// Upscaled size: 2x, at most 8192 px wide (graphics-card encoders stop there); even numbers
function targetSize(w, h, max = 8192) {
  let W = w * 2, H = h * 2;
  if (W > max) { H = Math.round(H * max / W); W = max; }
  return { W: W - (W % 2), H: H - (H % 2) };
}

async function upscale(opts, onProgress, id) {
  const p = models.paths();
  if (!p.esrgan) throw new Error('AI upscaling is not installed. Turn it on in Settings › AI features.');
  jobs.set(id, { cancelled: false });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-ai-'));
  const part = opts.output + '.part.mp4';
  let done = false;
  try {
    const info = await ff.probe(opts.input);
    const esr = (inp, out) => exec(id, p.esrgan, ['-i', inp, '-o', out, '-n', 'realesr-animevideov3', '-s', '2', '-m', p.esrganModels, '-f', 'jpg'], { cwd: path.dirname(p.esrgan) });

    if (info.isImage) {
      // a VR180 photo keeps its right eye inside the JPEG's metadata, which upscaling would drop
      const head = Buffer.alloc(Math.min(info.size, 512 * 1024));
      const fd = fs.openSync(opts.input, 'r'); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
      if (head.includes('GImage:Data') || head.includes('GImage:Mime')) throw new Error('VR180 photos from Google-style cameras keep the second eye hidden in the file, which AI upscaling would lose. Convert it to a side-by-side photo first.');
      onProgress({ fraction: 0.05, stage: 'Upscaling the photo…' });
      const out = opts.output.replace(/\.[^.]+$/, '.jpg');
      await esr(opts.input, path.join(tmp, 'up.jpg'));
      // keep the VR photo's metadata (the second eye and camera info for VR180 photos is in XMP)
      await ff.run(['-hide_banner', '-y', '-i', path.join(tmp, 'up.jpg'), '-q:v', '1', out], { id });
      done = true;
      const s = await ff.probe(out);
      return { output: out, width: s.width, height: s.height, stage: `Done · ${s.width}×${s.height}`, kind: 'upscale' };
    }

    if (info.width > 5120 && !opts.force) throw new Error('This video is already very sharp (' + info.width + '×' + info.height + '); upscaling it would exceed what headsets and encoders handle.');
    const fps = info.fps || 30;
    const total = Math.max(1, Math.round(info.duration * fps));
    const { W, H } = targetSize(info.width, info.height);
    const enc = await encoders.videoArgs({ codec: W > 4096 ? 'h265' : (opts.codec || 'h265'), crf: opts.crf || 18, width: W });
    const CHUNK = Math.max(24, Math.round(fps * 4));
    const segs = [];
    const started = Date.now();
    let frames = 0;
    const inDir = path.join(tmp, 'in'), outDir = path.join(tmp, 'out');
    const report = (n) => {
      const f = Math.min(0.99, n / total);
      const el = (Date.now() - started) / 1000;
      onProgress({ fraction: f, stage: `Upscaling… frame ${Math.min(n, total)} of ${total}`, eta: f > 0.01 ? el / f - el : null });
    };
    onProgress({ fraction: 0, stage: 'Upscaling… starting the graphics card' });
    for (let start = 0, k = 0; start < total; start += CHUNK, k++) {
      checkCancel(id);
      for (const d of [inDir, outDir]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d); }
      // frame-exact chunks: seek half a frame early, take the next CHUNK frames
      const seek = start ? ['-ss', ((start - 0.5) / fps).toFixed(5)] : [];
      await ff.run(['-hide_banner', '-y', ...seek, '-i', opts.input, '-map', '0:v:0', '-frames:v', String(Math.min(CHUNK, total - start)),
        '-q:v', '2', '-start_number', '0', path.join(inDir, '%06d.jpg')], { id });
      const got = count(inDir);
      if (!got) break;
      const timer = setInterval(() => report(frames + count(outDir)), 700);
      try { await esr(inDir, outDir); } finally { clearInterval(timer); }
      checkCancel(id);
      const seg = path.join(tmp, `seg${String(k).padStart(5, '0')}.mkv`);
      await ff.run(['-hide_banner', '-y', '-framerate', rateOf(fps), '-start_number', '0', '-i', path.join(outDir, '%06d.jpg'),
        '-vf', `scale=${W}:${H}:flags=lanczos`, ...enc.args, seg], { id });
      segs.push(seg);
      frames += got;
      report(frames);
    }
    if (!segs.length) throw new Error('No frames could be read from this video.');
    onProgress({ fraction: 0.995, stage: 'Adding the sound…' });
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, segs.map((s) => `file '${s.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    await ff.run(['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-i', opts.input, '-map', '0:v:0', '-map', '1:a?',
      '-c', 'copy', ...ff.NO_LOCATION, '-movflags', '+faststart', part], { id });
    if (info.spherical === 'equirect180') await injectVR180InPlace(part, info.stereo || '2d', { ambisonic: info.ambisonic });
    fs.renameSync(part, opts.output);
    done = true;
    return { output: opts.output, width: W, height: H, gpu: enc.gpu, stage: `Done · ${W}×${H} · AI upscaled`, kind: 'upscale' };
  } finally {
    jobs.delete(id);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!done) try { fs.rmSync(part, { force: true }); } catch {}
  }
}

// ---------------------------------------------------------------- 2D -> 3D video
// Pass 1: small frames go to a hidden window that runs the depth model on the graphics card;
// the depth maps are saved as a lossless grey video. Pass 2: ffmpeg shifts every pixel
// left or right by its depth for each eye and puts the eyes side by side.
const IN_W = 518;
const inH = (w, h) => Math.max(14, Math.round((IN_W * h) / w / 14) * 14);
// how far (pixels) the nearest/farthest things move; displace maps are limited to ±127
function shiftPixels(width, strength, pop) {
  const conv = 1 - pop / 100;
  const k = (strength / 100) * 0.035 * width;
  return { k: Math.min(k, 127 / Math.max(conv, 1 - conv)), conv };
}

function depthWorker(id, modelPath) {
  const { BrowserWindow, ipcMain } = require('electron');
  const win = new BrowserWindow({ show: false, width: 200, height: 100, webPreferences: { preload: path.join(__dirname, '..', 'depth-preload.js'), contextIsolation: true, backgroundThrottling: false } });
  const waiting = new Map();
  let failed = null, readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  const mine = (e) => !win.isDestroyed() && e.sender === win.webContents;
  const onReady = (e, info) => { if (mine(e)) readyResolve(info); };
  const onFail = (e, msg) => {
    if (!mine(e)) return;
    failed = new Error('The 3D helper stopped: ' + msg);
    readyReject(failed);
    for (const w of waiting.values()) w.reject(failed);
    waiting.clear();
  };
  const onResult = (e, seq, data, w, h) => { if (!mine(e)) return; const p = waiting.get(seq); waiting.delete(seq); p?.resolve({ data: Buffer.from(data), w, h }); };
  ipcMain.on('depth-ready', onReady);
  ipcMain.on('depth-fail', onFail);
  ipcMain.on('depth-result', onResult);
  win.webContents.on('render-process-gone', () => onFail({ sender: win.webContents }, 'the helper window crashed'));
  const close = () => {
    ipcMain.removeListener('depth-ready', onReady);
    ipcMain.removeListener('depth-fail', onFail);
    ipcMain.removeListener('depth-result', onResult);
    if (!win.isDestroyed()) win.destroy();
  };
  win.loadFile(path.join(__dirname, '..', 'renderer', 'depth-worker.html')).then(() => {
    win.webContents.send('depth-init', { modelUrl: 'media://file/?p=' + encodeURIComponent(modelPath) });
  }, (e) => readyReject(e));
  let seq = 0;
  return {
    ready,
    close,
    depth(data, w, h, still) {
      if (failed) return Promise.reject(failed);
      const s = ++seq;
      return new Promise((resolve, reject) => {
        waiting.set(s, { resolve, reject });
        win.webContents.send('depth-frame', { seq: s, w, h, data, still });
      });
    }
  };
}

async function make3D(opts, onProgress, id) {
  const p = models.paths();
  if (!p.depthModel) throw new Error('2D → 3D is not installed. Turn it on in Settings › AI features.');
  const job = { cancelled: false, procs: [] };
  jobs.set(id, job);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-ai-'));
  let worker = null, done = false;
  const part = opts.output + (opts.output.toLowerCase().endsWith('.jpg') ? '.part.jpg' : '.part.mp4');
  try {
    const info = await ff.probe(opts.input);
    const still = info.isImage;
    let W = info.displayWidth || info.width, H = info.displayHeight || info.height;
    W -= W % 2; H -= H % 2;
    const fps = info.fps || 30, rate = rateOf(fps);
    const dw = IN_W, dh = inH(W, H);
    const total = still ? 1 : Math.max(1, Math.round(info.duration * fps));
    onProgress({ fraction: 0, stage: 'Starting the depth model…' });
    worker = depthWorker(id, p.depthModel);
    job.onCancel = () => worker?.close();
    const wk = await worker.ready;
    checkCancel(id);

    // ---- pass 1: depth maps
    const depthFile = path.join(tmp, 'depth.mkv');
    const ffPath = ff.ffmpegPath;
    const dec = spawn(ffPath, ['-v', 'error', '-i', opts.input, '-map', '0:v:0', '-vf', (still ? '' : `fps=${rate},`) + `scale=${dw}:${dh}:flags=area,format=rgb24`,
      ...(still ? ['-frames:v', '1'] : []), '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const enc = spawn(ffPath, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${dw}x${dh}`, '-r', rate, '-i', 'pipe:0', '-c:v', 'ffv1', depthFile], { windowsHide: true });
    job.procs.push(dec, enc);
    let encErr = '';
    enc.stderr.on('data', (d) => (encErr += d));
    const encDone = new Promise((res, rej) => enc.on('close', (c) => (c === 0 ? res() : rej(new Error(job.cancelled ? 'cancelled' : 'Saving the depth maps failed: ' + encErr.slice(-300))))));
    encDone.catch(() => {});
    enc.stdin.on('error', () => {});   // the encoder was stopped (cancel/failure): handled above
    const frameBytes = dw * dh * 3;
    let buf = Buffer.alloc(0), frames = 0, inflight = [], decEnded = false;
    const started = Date.now();
    const write = (b) => new Promise((res) => (enc.stdin.write(b) ? res() : enc.stdin.once('drain', res)));
    await new Promise((resolve, reject) => {
      let pumping = false;
      const pump = async () => {
        if (pumping) return;
        pumping = true;
        try {
          while (buf.length >= frameBytes || (decEnded && inflight.length)) {
            if (job.cancelled) throw new Error('cancelled');
            while (buf.length >= frameBytes && inflight.length < 3) {
              const fr = buf.subarray(0, frameBytes);
              buf = buf.subarray(frameBytes);
              const pr = worker.depth(new Uint8Array(fr), dw, dh, still);
              pr.catch(() => {});   // a failure surfaces when this frame's turn comes
              inflight.push(pr);
            }
            if (buf.length < frameBytes * 2) dec.stdout.resume();
            const r = await inflight.shift();
            if (r.w !== dw || r.h !== dh) throw new Error(`Unexpected depth size ${r.w}×${r.h}`);
            await write(r.data);
            frames++;
            const f = Math.min(1, frames / total);
            const el = (Date.now() - started) / 1000;
            onProgress({ fraction: f * 0.55, stage: `Estimating depth… frame ${Math.min(frames, total)} of ${total}`, eta: f > 0.02 ? (el / f) * (1 - f) + el * 0.6 : null });
          }
          if (decEnded && !inflight.length && buf.length < frameBytes) { enc.stdin.end(); resolve(); }
        } catch (e) { reject(e); } finally { pumping = false; }
      };
      dec.stdout.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; if (buf.length > frameBytes * 4) dec.stdout.pause(); pump(); });
      dec.on('close', (c) => { decEnded = true; if (c !== 0 && !job.cancelled && !frames) reject(new Error('Could not read the video frames.')); pump(); });
      dec.on('error', reject);
    });
    await encDone;
    worker.close();
    worker = null;
    checkCancel(id);
    if (!frames) throw new Error('No frames could be read.');

    // ---- pass 2: shift each eye by its depth, side by side
    const { k, conv } = shiftPixels(W, opts.strength ?? 50, opts.pop ?? 35);
    const K = k.toFixed(3), C = conv.toFixed(4);
    const src = still ? `[0:v]scale=${W}:${H},format=gbrp,split=2[s1][s2]` : `[0:v]fps=${rate},scale=${W}:${H},format=gbrp,split=2[s1][s2]`;
    const graph = [
      src,
      `[1:v]scale=${W}:${H}:flags=bicubic,format=gray,split=2[d1][d2]`,
      `[d1]lut=c0='clip(128-${K}*(val/255-${C}),0,255)',format=gbrp[xl]`,
      `[d2]lut=c0='clip(128+${K}*(val/255-${C}),0,255)',format=gbrp[xr]`,
      `color=c=0x808080:s=${W}x${H}:r=${rate}:d=${still ? 1 : (info.duration + 2).toFixed(2)},format=gbrp,split=2[y1][y2]`,
      '[s1][xl][y1]displace=edge=smear[L]',
      '[s2][xr][y2]displace=edge=smear[R]',
      '[L][R]hstack=inputs=2,format=' + (still ? 'yuvj444p' : 'yuv420p') + '[v]'
    ].join(';');
    const graphFile = path.join(tmp, 'graph.txt');
    fs.writeFileSync(graphFile, graph);
    let args;
    if (still) {
      args = ['-hide_banner', '-y', '-i', opts.input, '-i', depthFile, '-filter_complex_script', graphFile, '-map', '[v]', '-frames:v', '1', '-q:v', '2', '-f', 'image2', part];
      await ff.run(args, { id });
    } else {
      const venc = await encoders.videoArgs({ codec: W * 2 > 4096 ? 'h265' : 'h264', crf: opts.crf || 18, width: W * 2 });
      args = ['-hide_banner', '-y', '-i', opts.input, '-i', depthFile, '-filter_complex_script', graphFile, '-map', '[v]', '-map', '0:a?', '-c:a', 'copy',
        ...venc.args, '-frames:v', String(frames), ...ff.NO_LOCATION, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', part];
      await ff.run(args, { id, duration: info.duration, onProgress: (q) => onProgress({ fraction: 0.55 + q.fraction * 0.45, stage: `Making the two eyes… ${Math.round(q.fraction * 100)}%` }) });
    }
    fs.renameSync(part, opts.output);
    done = true;
    return { output: opts.output, width: W * 2, height: H, stage: `Done · 3D side-by-side ${W * 2}×${H}${wk.gpu ? ' · GPU' : ''}`, kind: '3d' };
  } finally {
    worker?.close();
    // stop the helper processes and let Windows release their files before tidying up
    await Promise.all(job.procs.map((p) => new Promise((r) => {
      if (p.exitCode !== null || p.signalCode) return r();
      p.once('close', r);
      try { p.kill(); } catch {}
      setTimeout(r, 3000);
    })));
    jobs.delete(id);
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    if (!done) try { fs.rmSync(part, { force: true }); } catch {}
  }
}

module.exports = { buildSrt, init, transcribe, upscale, make3D, shiftPixels, cancel, sidecarDir, langName, targetSize };
