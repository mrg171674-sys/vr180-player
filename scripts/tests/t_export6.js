const root = process.argv[2], out = process.argv[3];
const ff = require(root + '/lib/ffmpeg'); const enc = require(root + '/lib/encoders');
const path = require('path'), fs = require('fs');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const check = (l, ok, x = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x ? '  · ' + x : ''}`); };
(async () => {
  await enc.detect();
  const input = path.join(root, 'test-videos', 'two_tracks.mp4'); // has audio
  const fish = path.join(root, 'test-videos', 'GOPR0042.mp4');
  const base = { projection: 'fisheye', layout: 'sbs', fov: 180, codec: 'h264', crf: 22, encoder: 'auto' };
  // 1) stabilize + segments with audio (used to fail)
  const ai = await ff.probe(input);
  let r = await ff.convertToVR180({ ...base, projection: 'fisheye', layout: ai.width / ai.height > 1.6 ? 'sbs' : '2d', stabilize: 'light', output: path.join(out, 'stab_seg.mp4'),
    segments: [{ input, start: 0.5, end: 2, fade: true }, { input, start: 3, end: 5, speed: 2 }] }, () => {});
  let p = await ff.probe(r.output);
  check('stabilize + edit with audio exports', p.hasAudio && Math.abs(p.duration - 2.5) < 0.15, `${p.duration.toFixed(2)} s (expected 2.50), audio ${p.hasAudio}`);
  check('VR180 tags written in place', p.spherical === 'equirect180' || /equirect/.test(String(p.spherical)), `spherical=${p.spherical} stereo=${p.stereo}`);
  check('no .part file left', !fs.existsSync(r.output + '.part.mp4'));
  // 2) long follow-mode level curve (500 key points) parses
  const rolls = Array.from({ length: 600 }, (_, i) => 3 * Math.sin(i * 0.7) + (i % 7) * 0.4);
  r = await ff.convertToVR180({ ...base, output: path.join(out, 'level_long.mp4'), input: fish, level: { mode: 'follow', interval: 0.01, rolls } }, () => {});
  check('follow-mode level with hundreds of key points exports', fs.existsSync(r.output));
  // 3) LUT strength not inverted: a LUT that maps everything to black, at 25% -> picture stays mostly bright
  const cube = path.join(out, 'black.cube');
  fs.writeFileSync(cube, 'LUT_3D_SIZE 2\n' + '0 0 0\n'.repeat(8));
  r = await ff.convertToVR180({ ...base, output: path.join(out, 'lut25.mp4'), input: fish, lut: cube, lutMix: 0.25, encoder: 'cpu' }, () => {});
  const yavg = (f) => { const o = spawnSync(ff.ffmpegPath, ['-v', 'error', '-ss', '1', '-i', f, '-frames:v', '1', '-vf', 'scale=64:32,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1e7 }).stdout; return o.reduce((a, b) => a + b, 0) / o.length; };
  const src = yavg(fish), got = yavg(r.output);
  check('LUT strength 25% darkens only a little (not inverted)', got > src * 0.55, `source luma ${src.toFixed(0)}, 25% black LUT -> ${got.toFixed(0)}`);
  // 4) cancel cleans up the part file
  const job = ff.convertToVR180({ ...base, output: path.join(out, 'cancel.mp4'), input: fish, encoder: 'cpu', crf: 12 }, () => {}, 'canceltest');
  await new Promise((x) => setTimeout(x, 700));
  ff.cancel('canceltest');
  try { await job; } catch {}
  check('cancelled job leaves no .part file', !fs.existsSync(path.join(out, 'cancel.mp4.part.mp4')) && !fs.existsSync(path.join(out, 'cancel.mp4')));
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => { console.error('ERR', e.message.slice(0, 1500)); });
