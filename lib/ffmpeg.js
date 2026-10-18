const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { injectVR180, injectVR180InPlace, moovHas } = require('./inject-vr180');
const encoders = require('./encoders');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const jobs = new Map();
encoders.init(ffmpegPath);

// Exports never carry where a video was filmed: phones store GPS in these tags
const NO_LOCATION = ['-metadata', 'location=', '-metadata', 'location-eng=', '-metadata', 'com.apple.quicktime.location.ISO6709='];

function run(args, { id, duration, onProgress, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true, cwd });
    if (id) jobs.set(id, p);
    let stderr = '';
    let buf = '';
    p.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    p.stdout.on('data', (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && duration && onProgress) onProgress({ fraction: Math.min(1, parseInt(m[1], 10) / 1e6 / duration) });
      }
    });
    p.on('error', reject);
    p.on('close', (code, signal) => {
      if (id && jobs.get(id) === p) jobs.delete(id);
      if (signal || p.killedByUser) return reject(new Error('cancelled'));
      if (code === 0) return resolve(stderr);
      const err = new Error(stderr.trim().split('\n').slice(-4).join('\n'));
      // everything a bug report needs
      err.stderrTail = stderr.trim().split('\n').slice(-40).join('\n');
      err.args = args;
      const gi = args.indexOf('-filter_complex_script');
      if (gi >= 0) { try { err.graph = fs.readFileSync(path.join(cwd || '', args[gi + 1]), 'utf8').slice(0, 6000); } catch {} }
      reject(err);
    });
  });
}

function parseTime(s) {
  const [h, m, sec] = s.split(':');
  return (+h) * 3600 + (+m) * 60 + parseFloat(sec);
}

async function probe(file, { timeout = 20000 } = {}) {
  // ffmpeg exits non-zero without an output file; the useful info is in stderr
  let timedOut = false;
  const out = await new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
    let s = '';
    // a sleeping NAS, a file still being copied or a cloud-only placeholder must not hang forever
    const t = setTimeout(() => { timedOut = true; p.kill(); }, timeout);
    p.stderr.on('data', (d) => (s += d));
    p.on('close', () => { clearTimeout(t); resolve(s); });
    p.on('error', () => { clearTimeout(t); resolve(''); });
  });
  if (timedOut) throw new Error('Reading this file took too long. Is the drive or network share responding?');
  const dur = /Duration:\s*(\d+:\d+:[\d.]+)/.exec(out);
  const vid = /Stream #\S+.*?Video:\s*(\w+).*?,\s*(\d{2,5})x(\d{2,5})/.exec(out);
  const isImage = /\.(jpe?g|png|webp)$/i.test(file);
  const fps = /,\s*([\d.]+)\s*fps/.exec(out);
  // "tiled equirectangular" = equirect with crop bounds (VR180); plain = full 360
  const sph = /spherical:\s*(tiled\s+)?(\w+)/.exec(out);
  let spherical = null;
  if (sph) spherical = sph[2] === 'equirectangular' ? (sph[1] ? 'equirect180' : 'equirect360') : sph[2];
  const st3d = /stereo3d:\s*([a-z ]+)/i.exec(out);
  if (!vid) throw new Error('No video stream found in this file.');
  let stereo = null;
  if (st3d) stereo = /side by side/i.test(st3d[1]) ? 'sbs' : /top and bottom/i.test(st3d[1]) ? 'tb' : '2d';
  // Displayed shape: non-square pixels (SAR) and phone rotation (display matrix)
  const vline = (/Stream #\S+.*?Video:[^\n]*/.exec(out) || [''])[0];
  const sarM = /\[SAR (\d+):(\d+) DAR \d+:\d+\]/.exec(vline);
  const sar = sarM && +sarM[2] ? +sarM[1] / +sarM[2] : 1;
  const rotM = /rotation of (-?[\d.]+) degrees/.exec(out);
  const rotation = rotM ? ((Math.round(+rotM[1]) % 360) + 360) % 360 : 0;
  let dw = Math.round(+vid[2] * (sar > 0 ? sar : 1)), dh = +vid[3];
  if (rotation === 90 || rotation === 270) [dw, dh] = [dh, dw];
  // HDR (HLG / PQ) and bit depth, from the colour description of the video stream
  const hdr = /arib-std-b67/.test(vline) ? 'hlg' : /smpte2084/.test(vline) ? 'pq' : null;
  const bitDepth = /(p010|10le|10be|p016|12le)/.test(vline) ? 10 : 8;

  // Audio: 4 channels with an ambisonic layout (from the SA3D box) = spatial audio
  const aud = /Stream #\S+.*?Audio:\s*(\w+)[^\n]*?,\s*(\d+) Hz,\s*([^,\n]+)/.exec(out);
  const layoutStr = aud ? aud[3].trim() : '';
  const audioChannels = !aud ? 0 : /ambisonic 1|4\.0|quad|4 channels/.test(layoutStr) ? 4 : /mono/.test(layoutStr) ? 1 : (+(/(\d+) channels/.exec(layoutStr)?.[1]) || 2);
  const ambisonic = /ambisonic/.test(layoutStr) || (audioChannels === 4 && (/ambix|ambisonic|spatial|foa/i.test(path.basename(file)) || (/.(mp4|mov|m4v)$/i.test(file) && moovHas(file, 'SA3D'))));

  // Every audio track, for switching between them (language, codec, channels)
  const audioTracks = [];
  const audRe = /Stream #\d+:\d+(?:\[\w+\])?(?:\((\w+)\))?: Audio: (\w+)[^\n]*?,\s*\d+ Hz,\s*([^,\n]+)/g;
  let am;
  while ((am = audRe.exec(out))) audioTracks.push({ index: audioTracks.length, lang: am[1] || 'und', codec: am[2], layout: am[3].trim() });

  // Embedded subtitle tracks
  const subtitles = [];
  const subRe = /Stream #\d+:\d+(?:\[\w+\])?(?:\((\w+)\))?: Subtitle: (\w+)/g;
  let sm;
  while ((sm = subRe.exec(out))) subtitles.push({ index: subtitles.length, lang: sm[1] || 'und', codec: sm[2] });

  // Chapters
  const chapters = [];
  const chRe = /Chapter #\d+:\d+: start ([\d.]+), end ([\d.]+)\s*\n\s*Metadata:\s*\n\s*title\s*:\s*([^\n]*)/g;
  let cm;
  while ((cm = chRe.exec(out))) chapters.push({ t: +cm[1], end: +cm[2], name: cm[3].trim() });

  return {
    duration: isImage ? 0 : dur ? parseTime(dur[1]) : 0,
    isImage,
    audioTracks,
    codec: vid[1],
    width: +vid[2],
    height: +vid[3],
    displayWidth: dw,
    displayHeight: dh,
    rotation,
    sar,
    hdr,
    bitDepth,
    fps: fps ? +fps[1] : 0,
    hasAudio: !!aud,
    audioCodec: aud ? aud[1] : null,
    audioChannels,
    ambisonic,
    subtitles,
    chapters,
    spherical,
    size: fs.statSync(file).size,
    stereo
  };
}

async function makeProxy(file, onProgress, id) {
  const info = await probe(file);
  const dir = path.join(os.tmpdir(), 'vr180-player-proxies');
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statSync(file);
  const out = path.join(dir, `${path.basename(file).replace(/\W+/g, '_')}_${st.size}_${Math.round(st.mtimeMs)}.mp4`);
  if (fs.existsSync(out)) return out;
  await run(['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(4096,iw)':-2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', info.ambisonic ? 'copy' : 'aac', ...(info.ambisonic ? [] : ['-b:a', '160k']), out + '.part.mp4'], { id, duration: info.duration, onProgress });
  fs.renameSync(out + '.part.mp4', out);
  return out;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const STAB = { light: 10, medium: 20, strong: 40 };
// level.js measures tilt the same way ffmpeg's rotate turns the picture, so undo it with the negative

// FFMETADATA chapters, times relative to the (trimmed) output
function chapterFile(chapters, start, end, dir) {
  const list = (chapters || [])
    .map((c) => ({ t: c.t - start, name: c.name }))
    .filter((c) => c.t >= -0.01 && c.t < end - start - 0.5)
    .sort((a, b) => a.t - b.t);
  if (!list.length) return null;
  if (list[0].t > 0.5) list.unshift({ t: 0, name: 'Start' });
  const esc = (s) => String(s).replace(/([=;#\\\n])/g, '\\$1');
  let txt = ';FFMETADATA1\n';
  list.forEach((c, i) => {
    const s = Math.max(0, Math.round(c.t * 1000));
    const e = Math.round((i + 1 < list.length ? list[i + 1].t : end - start) * 1000);
    txt += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${s}\nEND=${e}\ntitle=${esc(c.name || `Chapter ${i + 1}`)}\n`;
  });
  const file = path.join(dir, 'chapters.txt');
  fs.writeFileSync(file, txt);
  return file;
}

// opts:
//   input            source file (or use segments)
//   segments         [{ input, start, end, speed?, freeze?, mute?, fade? }] to join and cut; all must share projection + layout
//                    speed 0.25..4, freeze = seconds to hold the last frame, mute = silence, fade = short dip at both ends
//   texts            [{ text, start, end, size (deg), y (deg below the horizon), depth (m) }] titles / date stamps
//   subtitles        [{ start, end, text }] cues to burn in (source time, single input only)
//   output, projection 'fisheye'|'equirect180', layout '2d'|'sbs'|'tb', fov
//   eyeSize (0 = keep), noUpscale, codec 'h264'|'h265'|'copy', crf, maxrate (Mbps), fpsmax, tenbit
//   encoder 'auto'|'gpu'|'cpu', audioTrack, audioBitrate
//   start, end       trim (single input only)
//   stabilize        'off'|'light'|'medium'|'strong'
//   chapters         [{ t, name }] in output time for segments, source time otherwise
//   lut              path to a .cube file; lutMix 0..1
//   level            { mode: 'fixed', roll } | { mode: 'follow', interval, rolls }
async function convertToVR180(opts, onProgress, id) {
  opts = { ...opts, output: path.resolve(opts.output) };
  const segs = opts.segments?.length ? opts.segments.map((s) => ({ ...s, input: path.resolve(s.input) })) : null;
  if (!segs) opts.input = path.resolve(opts.input);
  const inputs = segs ? [...new Set(segs.map((s) => s.input))] : [opts.input];
  const infos = await Promise.all(inputs.map((f) => probe(f)));
  const info = infos[0];
  const layout = opts.layout || '2d';
  // 360 videos keep the half you choose (yaw/pitch); stereo 360 is top-bottom, VR180 side by side
  const is360 = opts.projection === 'equirect360';
  const outLayout = is360 && layout === 'tb' ? 'sbs' : layout;
  const eyeW = layout === 'sbs' ? info.width / 2 : info.width;
  const eyeH = layout === 'tb' ? info.height / 2 : info.height;
  const srcEye = is360 ? eyeH : Math.max(eyeW, eyeH);
  const S = even(opts.eyeSize ? (opts.noUpscale ? Math.min(opts.eyeSize, srcEye) : opts.eyeSize) : srcEye);
  const W = outLayout === 'sbs' ? S * 2 : S;
  const H = outLayout === 'tb' ? S * 2 : S;

  // ---- timing
  let start = 0, length, trimArgs = [];
  if (segs) {
    for (const s of segs) {
      const d = infos[inputs.indexOf(s.input)].duration;
      s.start = Math.max(0, s.start || 0);
      s.end = Math.min(d, s.end || d);
    }
    length = segs.reduce((a, s) => a + segDur(s), 0);
  } else {
    start = Math.max(0, opts.start || 0);
    const end = Math.min(info.duration || Infinity, opts.end || Infinity);
    const trimmed = start > 0 || (isFinite(end) && end < info.duration - 0.05);
    length = (isFinite(end) ? end : info.duration) - start;
    trimArgs = [...(start > 0 ? ['-ss', start.toFixed(3)] : []), ...(trimmed ? ['-t', length.toFixed(3)] : [])];
  }

  // enough disk space? (a clear message beats losing a long encode at 95%)
  try {
    const sf = fs.statfsSync(path.dirname(opts.output));
    const free = sf.bavail * sf.bsize;
    const mbps = opts.maxrate || (W >= 5000 ? 90 : W >= 3800 ? 60 : 30);
    const need = (length * mbps * 1e6) / 8 * 0.8;
    if (free < need) throw Object.assign(new Error(`Not enough disk space: this export needs roughly ${(need / 1e9).toFixed(1)} GB and the drive has ${(free / 1e9).toFixed(1)} GB free.`), { diskFull: true });
  } catch (e) { if (e.diskFull) throw e; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-job-'));
  const stab = STAB[opts.stabilize];
  const track = opts.audioTrack || 0;
  const anyAudio = infos.some((i) => i.hasAudio);
  const ambisonic = infos.every((i) => i.ambisonic);

  // ---- inputs and the joined/trimmed source stream ([src])
  // decode on the graphics card when one is there (the CPU retry turns this off)
  const hw = (mode) => (mode !== 'cpu' && encoders.status()?.vendor ? ['-hwaccel', 'auto'] : []);
  // each edit part is its own input, seeked straight to its start (frame-accurate)
  const segInputArgs = (mode) => segs.flatMap((s) => [...hw(mode), '-ss', s.start.toFixed(3), '-t', (s.end - s.start + 0.05).toFixed(3), '-i', s.input]);
  const inputArgsFor = (mode) => (segs ? segInputArgs(mode) : [...hw(mode), ...trimArgs, '-i', opts.input]);
  const buildPre = (withAudio) => {
    const out = [];
    if (!segs) { out.push('[0:v:0]null[src]'); return out; }
    const [w0, h0] = [info.width, info.height];
    segs.forEach((s, i) => {
      const k = inputs.indexOf(s.input);
      const speed = s.speed || 1, d = segDur(s), fps = info.fps || 30;
      const vf = [`trim=duration=${(s.end - s.start).toFixed(3)}`, speed === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${speed},fps=${fps}`, `scale=${w0}:${h0}`, 'setsar=1'];
      if (s.freeze) vf.push(`tpad=stop_mode=clone:stop_duration=${s.freeze}`);
      if (s.fade) vf.push(`fade=t=in:st=0:d=0.3`, `fade=t=out:st=${Math.max(0, d - 0.3).toFixed(3)}:d=0.3`);
      out.push(`[${i}:v:0]${vf.join(',')}[v${i}]`);
      if (withAudio) {
        const lay = ambisonic ? '4.0' : 'stereo';
        if (infos[k].hasAudio && !s.mute) {
          const af = [`atrim=duration=${(s.end - s.start).toFixed(3)}`, 'asetpts=PTS-STARTPTS', ...atempo(speed), `aformat=sample_rates=48000:channel_layouts=${lay}`];
          if (s.freeze) af.push(`apad=pad_dur=${s.freeze}`);
          if (s.fade) af.push('afade=t=in:st=0:d=0.3', `afade=t=out:st=${Math.max(0, d - 0.3).toFixed(3)}:d=0.3`);
          af.push(`atrim=0:${d.toFixed(3)}`);
          out.push(`[${i}:a:${Math.min(track, Math.max(0, infos[k].audioTracks.length - 1))}]${af.join(',')}[a${i}]`);
        } else out.push(`anullsrc=r=48000:cl=${lay},atrim=0:${d.toFixed(3)}[a${i}]`);
      }
    });
    out.push(segs.map((_, i) => `[v${i}]` + (withAudio ? `[a${i}]` : '')).join('') + `concat=n=${segs.length}:v=1:a=${withAudio ? 1 : 0}[src]` + (withAudio ? '[aout]' : ''));
    return out;
  };
  const pre = buildPre(anyAudio);
  const audioLabel = segs && anyAudio ? '[aout]' : null;

  // ---- the look: LUT (with strength), stabilize, level + projection
  const chain = [];
  if (opts.lut) {
    fs.copyFileSync(opts.lut, path.join(work, 'look.cube'));
    const mix = opts.lutMix ?? 1;
    chain.push(mix >= 0.999 ? 'lut3d=file=look.cube' : `split[lo][lb];[lb]lut3d=file=look.cube[lc];[lc][lo]blend=all_mode=normal:all_opacity=${mix.toFixed(3)}`);
  }
  // Picture adjustments from Calibrate (brightness / contrast / saturation in %)
  const pic = opts.picture;
  if (pic && (pic.brightness || pic.contrast !== 100 || pic.saturation !== 100)) {
    chain.push(`eq=brightness=${((pic.brightness || 0) / 100).toFixed(3)}:contrast=${((pic.contrast ?? 100) / 100).toFixed(3)}:saturation=${((pic.saturation ?? 100) / 100).toFixed(3)}`);
  }
  if (stab) chain.push(`vidstabtransform=input=transforms.trf:smoothing=${stab}:optzoom=1:interpol=bicubic`, 'unsharp=5:5:0.5:3:3:0.3');

  // Horizon level: turning a fisheye image about its centre is exactly a camera
  // roll, so each eye is rotated by a time-based angle (equirect footage is
  // turned into fisheye for this step first).
  const level = is360 ? null : opts.level;
  let inProj = opts.projection === 'fisheye' ? `fisheye:ih_fov=${opts.fov || 180}:iv_fov=${opts.fov || 180}` : 'hequirect';
  if (level) {
    if (opts.projection !== 'fisheye') {
      chain.push(`v360=input=hequirect:output=fisheye:h_fov=180:v_fov=180:in_stereo=${layout}:out_stereo=${layout}:w=${S}:h=${S}`);
      inProj = 'fisheye:ih_fov=180:iv_fov=180';
    }
    const angle = `'${levelExpr(level, segs, start)}'`;
    const rot = `rotate=a=${angle}:fillcolor=black`;
    if (layout === 'sbs') chain.push(`split[le1][le2];[le1]crop=iw/2:ih:0:0,${rot}[lel];[le2]crop=iw/2:ih:iw/2:0,${rot}[ler];[lel][ler]hstack`);
    else if (layout === 'tb') chain.push(`split[le1][le2];[le1]crop=iw:ih/2:0:0,${rot}[lel];[le2]crop=iw:ih/2:0:ih/2,${rot}[ler];[lel][ler]vstack`);
    else chain.push(rot);
  }
  // v360 takes the per-eye size and doubles it itself for stereo output
  const baked = !is360 && bakeEyes(opts.calib, { layout, S, inProj: opts.projection === 'fisheye' && !level ? 'fisheye' : 'hequirect', fov: level && opts.projection !== 'fisheye' ? 180 : (opts.fov || 180), eyeW: level ? S : eyeW, eyeH: level ? S : eyeH });
  if (baked) {
    chain.push(baked);
  } else if (is360) {
    chain.push(`v360=input=e:output=hequirect:in_stereo=${layout}:out_stereo=${outLayout}:yaw=${(+opts.yaw || 0).toFixed(2)}:pitch=${(+opts.pitch || 0).toFixed(2)}:w=${S}:h=${S}:interp=cubic`);
  } else if (opts.projection === 'fisheye' || level) {
    chain.push(`v360=input=${inProj}:output=hequirect:in_stereo=${layout}:out_stereo=${layout}:w=${S}:h=${S}:interp=cubic`);
  } else if (W !== info.width || H !== info.height) {
    chain.push(`scale=${W}:${H}:flags=lanczos`);
  }

  // Titles, date stamps and burned-in subtitles: drawn on each eye after the projection,
  // shifted slightly left/right so they float at a comfortable depth in the headset
  const overlays = [...(opts.texts || [])];
  if (opts.subtitles?.length && !segs) {
    for (const c of opts.subtitles) {
      const a = c.start - start, b = c.end - start;
      if (b > 0 && a < length) overlays.push({ text: c.text, start: Math.max(0, a), end: Math.min(length, b), size: 3.2, y: 28, depth: 2.5, fade: 0.15 });
    }
  }
  if (overlays.length) chain.push(...textFilters(overlays, { S, layout: outLayout, work }));

  const copyAll = !segs && !chain.length && opts.codec === 'copy';
  let done = false;
  // Sound finishing: even loudness (streaming level, -14 LUFS) and a wind / rumble cut.
  // Spatial (ambisonic) sound is left alone so it keeps working in headsets.
  const audioFx = [];
  if (!ambisonic && opts.audioWind) audioFx.push('highpass=f=110', 'afftdn=nf=-28');
  if (!ambisonic && opts.audioLoud) {
    // two passes for a single video: measure first, then one exact, even correction
    let ln = 'loudnorm=I=-14:TP=-1.5:LRA=11';
    if (!segs && infos[0].hasAudio) {
      try {
        onProgress({ fraction: 0, stage: 'Measuring loudness…' });
        const err = await run(['-hide_banner', '-nostats', ...(start ? ['-ss', start.toFixed(3)] : []), ...(length ? ['-t', length.toFixed(3)] : []), '-i', opts.input,
          '-map', `0:a:${track}?`, '-af', [...audioFx, ln + ':print_format=json'].join(','), '-f', 'null', '-'], { id });
        const j = JSON.parse(/\{[^{}]*"input_i"[^{}]*\}/.exec(err)[0]);
        const gain = -14 - +j.input_i;
        if (isFinite(gain) && +j.input_i > -70) {
          // enough headroom: one even gain change; otherwise gain plus a peak limiter, so
          // loud bangs don't stop quiet speech from reaching the level
          ln = +j.input_tp + gain <= -1.5
            ? ln + `:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`
            : `volume=${Math.min(24, gain).toFixed(2)}dB,alimiter=limit=0.84:attack=4:release=60:level=false`;
        }
      } catch (e) { if (e.message === 'cancelled') throw e; }
    }
    audioFx.push(ln);
  }
  // loudnorm works at 192 kHz: settle on a format every encoder takes
  if (audioFx.length) audioFx.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
  const graph = (body) => [...pre, `[src]${body.length ? body.join(',') : 'null'}[vout]`, ...(audioFx.length && audioLabel ? [`${audioLabel}${audioFx.join(',')}[afx]`] : [])].join(';');

  try {
    // Pass 1: measure camera shake over the whole frame, so both eyes get the same correction
    if (stab) {
      await run(['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', ...inputArgsFor(opts.encoder || 'auto'),
        '-filter_complex', [...buildPre(false), '[src]vidstabdetect=shakiness=6:accuracy=12:result=transforms.trf[vd]'].join(';'),
        '-map', '[vd]', '-f', 'null', '-'],
      { id, cwd: work, duration: length, onProgress: (p) => onProgress({ fraction: p.fraction * 0.4, stage: `Pass 1/2: analysing motion… ${Math.round(p.fraction * 100)}%` }) });
    }

    const chapterStart = segs ? 0 : start;
    const chap = chapterFile(opts.chapters, chapterStart, chapterStart + length, work);
    const tmp = opts.output + '.part.mp4';
    const base = stab ? 0.4 : 0;

    const encode = async (mode) => {
      const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', ...inputArgsFor(mode)];
      if (chap) args.push('-f', 'ffmetadata', '-i', chap, '-map_chapters', String(segs ? segs.length : 1));
      else args.push('-map_chapters', '-1');
      let enc = { encoder: 'copy', gpu: false, note: null };
      if (copyAll) {
        args.push('-map', '0:v:0', '-map', `0:a:${track}?`, '-c', 'copy');
        if (audioFx.length) args.push('-af', audioFx.join(','), '-c:a', 'aac', '-b:a', opts.audioBitrate || '192k');
      } else {
        fs.writeFileSync(path.join(work, 'graph.txt'), graph(chain));
        args.push('-filter_complex_script', 'graph.txt', '-map', '[vout]');
        if (audioLabel) args.push('-map', audioFx.length ? '[afx]' : audioLabel);
        else if (!segs) { args.push('-map', `0:a:${track}?`); if (audioFx.length) args.push('-af', audioFx.join(',')); }
        enc = await encoders.videoArgs({ codec: opts.codec === 'h265' ? 'h265' : 'h264', crf: opts.crf ?? 18, mode, width: W, maxrate: opts.maxrate, tenbit: opts.tenbit });
        args.push(...enc.args);
        if (opts.fpsmax) args.push('-fpsmax', String(opts.fpsmax));
        // Spatial (ambisonic) audio is kept as-is so its 4 channels survive
        if (ambisonic && !segs) args.push('-c:a', 'copy');
        else if (ambisonic) args.push('-c:a', 'aac', '-b:a', '512k');
        else args.push('-c:a', 'aac', '-b:a', opts.audioBitrate || '192k');
      }
      args.push(...NO_LOCATION, '-f', 'mp4', tmp);
      const label = enc.gpu ? ` (${enc.encoder.replace(/_/g, ' ').toUpperCase()})` : '';
      await run(args, {
        id, cwd: work, duration: length,
        onProgress: (p) => onProgress({ fraction: base + p.fraction * (1 - base), stage: `${stab ? 'Pass 2/2: c' : 'C'}onverting${label}… ${Math.round(p.fraction * 100)}%`, note: enc.note })
      });
      return enc;
    };

    let enc;
    try {
      enc = await encode(opts.encoder || 'auto');
    } catch (e) {
      // a GPU encoder or decoder can fail on odd sizes or driver issues: try once more on the CPU.
      // Other failures (disk full, unreadable file, a filter error) would just fail again.
      const gpuProblem = /nvenc|amf|qsv|cuda|cuvid|d3d11|dxva|hwaccel|OpenEncodeSession|No capable devices|InitializeEncoder|Error initializing output stream|encoder.*(failed|not)|Cannot load (nvcuda|amf|libmfx)|Failed setup for format d3d11|hardware/i.test(String(e.stderrTail || e.message));
      if (e.message === 'cancelled' || opts.encoder === 'cpu' || copyAll || !gpuProblem) throw e;
      const st = encoders.status();
      if (!st || (!st.h264 && !st.hevc)) throw e;
      onProgress({ fraction: base, stage: 'GPU encode failed, retrying on the CPU…' });
      try { enc = await encode('cpu'); } catch (e2) { e2.gpuError = e.stderrTail; throw e2; }
      enc.note = 'The GPU encoder failed on this video, so it was converted on the CPU.';
    }
    onProgress({ fraction: 1, stage: 'Writing VR180 metadata…' });
    // the tags go into the finished file in place; it gets its real name only when complete
    await injectVR180InPlace(tmp, outLayout, { ambisonic });
    fs.renameSync(tmp, opts.output);
    done = true;
    return { output: opts.output, width: W, height: H, duration: length, encoder: enc.encoder, gpu: enc.gpu, note: enc.note };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    // a failed or cancelled job leaves no hidden multi-GB part file behind
    if (!done) try { fs.rmSync(opts.output + '.part.mp4', { force: true }); } catch {}
  }
}

// Your Calibrate settings, baked into the file so every player shows it the way you set it
// up here: per-eye angle (IPD), height and roll, per-eye zoom (fisheye), swapped eyes, lens
// centre and stretch. Viewing comforts (tilt, scale, height) stay viewing settings.
// Sign mapping to v360 (checked against the app's shader): yaw = -yaw, pitch = pitch, roll = -roll.
function bakeEyes(calib, { layout, S, inProj, fov, eyeW, eyeH }) {
  if (!calib || calib.eyesOn === false && calib.lensOn === false) return null;
  const e = calib.eyesOn === false ? {} : calib, lens = calib.lensOn === false ? {} : calib;
  const ipd = +e.ipd || 0, lv = +e.leftV || 0, rv = +e.rightV || 0, lr = +e.leftRoll || 0, rr = +e.rightRoll || 0;
  const lz = (+e.leftZoom || 100) / 100, rz = (+e.rightZoom || 100) / 100, swap = !!e.swap && layout !== '2d';
  const cx = +lens.cx || 0, cy = +lens.cy || 0, st = (+lens.stretch || 100) / 100;
  const eyeWork = ipd || lv || rv || lr || rr || (inProj === 'fisheye' && (lz !== 1 || rz !== 1)) || swap;
  const lensWork = cx || cy || st !== 1;
  if (!eyeWork && !lensWork) return null;
  const W = Math.round(eyeW), H = Math.round(eyeH);
  // lens centre: sample (x + cx, y - cy) in eye pixels; stretch: widen about the centre
  const lensPre = () => {
    const f = [];
    if (cx || cy) {
      const M = Math.ceil(Math.max(Math.abs(cx), Math.abs(cy)) / 100 * Math.max(W, H)) + 2;
      f.push(`pad=${W + 2 * M}:${H + 2 * M}:${M}:${M}:black`, `crop=${W}:${H}:${Math.round(M + (cx / 100) * W)}:${Math.round(M - (cy / 100) * H)}`);
    }
    if (st !== 1) {
      const SW = Math.max(2, Math.round(W * st / 2) * 2);
      f.push(`scale=${SW}:${H}`, st > 1 ? `crop=${W}:${H}:${Math.round((SW - W) / 2)}:0` : `pad=${W}:${H}:${Math.round((W - SW) / 2)}:0:black`);
    }
    return f;
  };
  const proj = (zoom) => inProj === 'fisheye' ? `fisheye:ih_fov=${(fov * zoom).toFixed(3)}:iv_fov=${(fov * zoom).toFixed(3)}` : 'hequirect';
  const v360 = (yaw, pitch, roll, zoom) => `v360=input=${proj(zoom)}:output=hequirect:yaw=${yaw.toFixed(3)}:pitch=${pitch.toFixed(3)}:roll=${roll.toFixed(3)}:w=${S}:h=${S}:interp=cubic`;
  if (layout === '2d') {
    // one picture: the average height and roll (there is no second eye to angle)
    return [...lensPre(), v360(0, (lv + rv) / 2, -(lr + rr) / 2, (lz + rz) / 2)].join(',');
  }
  const cropL = layout === 'sbs' ? `crop=iw/2:ih:0:0` : `crop=iw:ih/2:0:0`;
  const cropR = layout === 'sbs' ? `crop=iw/2:ih:iw/2:0` : `crop=iw:ih/2:0:ih/2`;
  const left = [swap ? cropR : cropL, ...lensPre(), v360(ipd / 2, lv, -lr, lz)].join(',');
  const right = [swap ? cropL : cropR, ...lensPre(), v360(-ipd / 2, rv, -rr, rz)].join(',');
  return `split[bk1][bk2];[bk1]${left}[bkl];[bk2]${right}[bkr];[bkl][bkr]${layout === 'sbs' ? 'hstack' : 'vstack'}`;
}

// output length of one edit segment
function segDur(s) { return (s.end - s.start) / (s.speed || 1) + (s.freeze || 0); }
// atempo only goes 0.5..2 per filter in older builds, so chain it
function atempo(speed) {
  const out = [];
  let r = speed;
  while (r < 0.5 - 1e-9) { out.push('atempo=0.5'); r /= 0.5; }
  while (r > 2 + 1e-9) { out.push('atempo=2'); r /= 2; }
  if (Math.abs(r - 1) > 1e-6) out.push(`atempo=${r.toFixed(4)}`);
  return out;
}

// drawtext filters for text overlays on an equirect frame (S x S per eye).
// size and y are in degrees (1° = S/180 px); depth in metres sets the eye offset.
function fontFile(work) {
  const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  const src = ['segoeuib.ttf', 'arialbd.ttf', 'segoeui.ttf', 'arial.ttf'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!src) return null;
  fs.copyFileSync(src, path.join(work, 'font.ttf'));
  return 'font.ttf';
}
function textFilters(overlays, { S, layout, work }) {
  const font = fontFile(work);
  const px = S / 180;
  const out = [];
  overlays.forEach((o, i) => {
    const file = `text${i}.txt`;
    fs.writeFileSync(path.join(work, file), String(o.text).replace(/\r/g, ''));
    const size = Math.max(8, Math.round((o.size || 4) * px));
    // half the angle between the eyes for something this far away, in pixels
    const shift = layout === '2d' ? 0 : Math.round((Math.atan(0.032 / Math.max(0.5, o.depth || 3)) * 180 / Math.PI) * px);
    const f = o.fade ?? 0.4, a = +o.start.toFixed(3), b = +o.end.toFixed(3);
    const alpha = `if(lt(t,${a + f}),(t-${a})/${f},if(gt(t,${b - f}),(${b}-t)/${f},1))`;
    const cy = Math.round(S / 2 + (o.y || 0) * px);
    const common = [`textfile=${file}`, 'expansion=none', ...(font ? [`fontfile=${font}`] : []), `fontsize=${size}`, 'fontcolor=white', 'line_spacing=' + Math.round(size * 0.25),
      'box=1', 'boxcolor=black@0.45', `boxborderw=${Math.round(size * 0.35)}`, `alpha='${alpha}'`, `enable='between(t,${a},${b})'`];
    const eyes = layout === 'sbs' ? [[0, 0, shift], [S, 0, -shift]] : layout === 'tb' ? [[0, 0, shift], [0, S, -shift]] : [[0, 0, 0]];
    for (const [ox, oy, dx] of eyes) out.push(`drawtext=${common.join(':')}:x=${ox + Math.round(S / 2) + dx}-text_w/2:y=${oy + cy}-text_h/2`);
  });
  return out;
}

// Horizon level as an ffmpeg expression of output time t (radians for rotate).
// The roll curve is thinned to its key points so the expression stays short.
function levelExpr(level, segs, start) {
  const rad = (deg) => (-deg * Math.PI) / 180;
  if (level.mode === 'fixed') return rad(level.roll).toFixed(5);
  const at = (t) => {
    const i = Math.min(level.rolls.length - 1, Math.max(0, t / level.interval));
    const i0 = Math.floor(i), f = i - i0;
    return level.rolls[i0] * (1 - f) + (level.rolls[i0 + 1] ?? level.rolls[i0]) * f;
  };
  const pts = [];
  if (segs) {
    let offset = 0;
    for (const sg of segs) {
      for (let t = sg.start; t <= sg.end + 1e-6; t += level.interval) pts.push([offset + (t - sg.start) / (sg.speed || 1), at(t)]);
      offset += segDur(sg);
    }
  } else {
    const end = level.rolls.length * level.interval;
    for (let t = start; t <= end + 1e-6; t += level.interval) pts.push([t - start, at(t)]);
  }
  let keep = simplify(pts, 0.1);
  for (let tol = 0.2; keep.length > 400; tol *= 1.5) keep = simplify(pts, tol);
  if (keep.length === 1) return rad(keep[0][1]).toFixed(5);
  // piecewise linear, as a balanced binary tree of if()s: depth ~log2(n), well inside
  // ffmpeg's expression nesting limit even with hundreds of key points
  const seg = (i) => {
    const [t0, v0] = keep[i], [t1, v1] = keep[i + 1];
    const a0 = rad(v0), slope = (rad(v1) - a0) / Math.max(1e-6, t1 - t0);
    return `${a0.toFixed(5)}+(t-${t0.toFixed(3)})*${slope.toFixed(6)}`;
  };
  const tree = (lo, hi) => { // segments lo..hi (inclusive)
    if (lo === hi) return seg(lo);
    const mid = (lo + hi) >> 1;
    return `if(lt(t,${keep[mid + 1][0].toFixed(3)}),${tree(lo, mid)},${tree(mid + 1, hi)})`;
  };
  const lastV = rad(keep.at(-1)[1]).toFixed(5);
  return `if(gte(t,${keep.at(-1)[0].toFixed(3)}),${lastV},${tree(0, keep.length - 2)})`;
}

// Ramer-Douglas-Peucker: drop points within tol degrees of the line through their neighbours
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [t0, v0] = pts[0], [t1, v1] = pts.at(-1);
  let worst = -1, dist = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const [t, v] = pts[i];
    const d = Math.abs(v - (v0 + ((v1 - v0) * (t - t0)) / (t1 - t0 || 1)));
    if (d > dist) { dist = d; worst = i; }
  }
  if (dist <= tol) return [pts[0], pts.at(-1)];
  return [...simplify(pts.slice(0, worst + 1), tol).slice(0, -1), ...simplify(pts.slice(worst), tol)];
}

function cancel(id) {
  const p = jobs.get(id);
  if (p) { p.killedByUser = true; p.kill(); }
}
function cancelAll() { for (const id of jobs.keys()) cancel(id); }

module.exports = { run, probe, makeProxy, convertToVR180, cancel, cancelAll, ffmpegPath, segDur, bakeEyes, NO_LOCATION };
