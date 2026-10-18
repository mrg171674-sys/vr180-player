const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const root = process.cwd();
const ff = require(root + '/lib/ffmpeg');
const lv = require(root + '/lib/level');
const T = (f) => path.join(root, 'test-videos', f);
const O = (f) => path.join(root, 'test-videos', 'out', f);
fs.mkdirSync(path.join(root, 'test-videos', 'out'), { recursive: true });
const quiet = () => {};
const time = async (label, fn) => { const t = Date.now(); const r = await fn(); console.log(`${label}: ${((Date.now() - t) / 1000).toFixed(1)} s`); return r; };
const pixel = (file, x, y, at = 1) => {
  const b = spawnSync(ff.ffmpegPath, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1e6 }).stdout;
  return [...b];
};

(async () => {
  const which = process.argv[2] || 'all';
  const base = { projection: 'fisheye', layout: 'sbs', fov: 180, crf: 22 };

  if (which === 'all' || which === 'gpu') {
    const cpu = await time('CPU (libx264)', () => ff.convertToVR180({ ...base, input: T('shaky_fisheye_LR.mp4'), output: O('cpu.mp4'), encoder: 'cpu' }, quiet));
    const gpu = await time('GPU (auto)', () => ff.convertToVR180({ ...base, input: T('shaky_fisheye_LR.mp4'), output: O('gpu.mp4'), encoder: 'auto' }, quiet));
    console.log('  gpu encoder:', gpu.encoder, '| note:', gpu.note);
    const p = await ff.probe(O('gpu.mp4'));
    console.log('  gpu output:', p.codec, p.width + 'x' + p.height, p.spherical, p.stereo);
  }

  if (which === 'all' || which === 'level') {
    const fmt = { projection: 'fisheye', layout: '2d', fov: 180 };
    const a = await lv.analyze(T('tilted_fisheye.mp4'), fmt, 8);
    console.log('measured before: first', a.rolls[0].toFixed(2), 'last', a.rolls.at(-1).toFixed(2), 'fixed', a.fixed);
    await ff.convertToVR180({ ...base, layout: '2d', input: T('tilted_fisheye.mp4'), output: O('level_follow.mp4'), level: { mode: 'follow', interval: a.interval, rolls: a.rolls } }, quiet);
    await ff.convertToVR180({ ...base, layout: '2d', input: T('tilted_fisheye.mp4'), output: O('level_fixed.mp4'), level: { mode: 'fixed', roll: a.fixed } }, quiet);
    const eq = { projection: 'equirect180', layout: '2d' };
    for (const f of ['level_follow.mp4', 'level_fixed.mp4']) {
      const r = await lv.analyze(O(f), eq, 8);
      console.log(`after ${f}: first ${r.rolls[0].toFixed(2)} mid ${r.rolls[Math.floor(r.rolls.length / 2)].toFixed(2)} last ${r.rolls.at(-1).toFixed(2)}`);
    }
    const raw = await ff.convertToVR180({ ...base, layout: '2d', input: T('tilted_fisheye.mp4'), output: O('level_none.mp4') }, quiet);
    const r0 = await lv.analyze(O('level_none.mp4'), eq, 8);
    console.log(`no levelling: first ${r0.rolls[0].toFixed(2)} last ${r0.rolls.at(-1).toFixed(2)}`);
  }

  if (which === 'all' || which === 'lut') {
    // LUT that swaps red and blue
    const n = 17;
    let cube = `TITLE "swap rb"\nLUT_3D_SIZE ${n}\n`;
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) cube += `${(b / (n - 1)).toFixed(4)} ${(g / (n - 1)).toFixed(4)} ${(r / (n - 1)).toFixed(4)}\n`;
    fs.writeFileSync(O('swap.cube'), cube);
    await ff.convertToVR180({ ...base, layout: '2d', input: T('lens_eye.mp4'), output: O('lut_full.mp4'), lut: O('swap.cube') }, quiet);
    await ff.convertToVR180({ ...base, layout: '2d', input: T('lens_eye.mp4'), output: O('lut_half.mp4'), lut: O('swap.cube'), lutMix: 0.5 }, quiet);
    await ff.convertToVR180({ ...base, layout: '2d', input: T('lens_eye.mp4'), output: O('lut_none.mp4') }, quiet);
    // a pixel inside the yellow area (left side)
    for (const f of ['lut_none.mp4', 'lut_full.mp4', 'lut_half.mp4']) console.log(`${f} pixel rgb:`, pixel(O(f), 300, 700).join(','));
  }

  if (which === 'all' || which === 'join') {
    const r = await ff.convertToVR180({ ...base, output: O('joined.mp4'),
      segments: [{ input: T('GOPR0042.mp4'), start: 0, end: 2 }, { input: T('GOPR0042.mp4'), start: 4, end: 6 }, { input: T('shaky_fisheye_LR.mp4'), start: 1, end: 3 }],
      chapters: [{ t: 0, name: 'Part one' }, { t: 2, name: 'Part two' }, { t: 4, name: 'Shaky bit' }] }, quiet);
    const p = await ff.probe(r.output);
    console.log('joined duration', p.duration, 'size', p.width + 'x' + p.height, 'chapters', JSON.stringify(p.chapters.map((c) => c.name + '@' + c.t)), p.spherical, p.stereo);
  }

  if (which === 'all' || which === 'presets') {
    const presets = {
      quest3: { codec: 'h265', eyeSize: 2880, noUpscale: true, crf: 20, maxrate: 90, fpsmax: 60 },
      visionpro: { codec: 'h265', eyeSize: 4096, noUpscale: true, crf: 20, maxrate: 100, tenbit: true },
      youtube: { codec: 'h264', eyeSize: 2880, noUpscale: true, crf: 17, maxrate: 120, audioBitrate: '320k' }
    };
    for (const [name, p] of Object.entries(presets)) {
      const r = await ff.convertToVR180({ ...base, ...p, input: T('GOPR0042.mp4'), output: O(`preset_${name}.mp4`) }, quiet);
      const info = spawnSync(ff.ffmpegPath, ['-hide_banner', '-i', r.output], { encoding: 'utf8' }).stderr.match(/Video: [^\n]+/)[0];
      console.log(`${name}: ${r.encoder} ${r.width}x${r.height} | ${info.slice(0, 110)}`);
    }
  }
})().catch((e) => console.error('ERR', e.message));
