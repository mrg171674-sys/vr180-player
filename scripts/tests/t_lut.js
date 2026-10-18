const root = process.argv[2], out = process.argv[3];
const ff = require(root + '/lib/ffmpeg'); const path = require('path'), fs = require('fs'); const { spawnSync } = require('child_process');
(async () => {
  const fish = path.join(root, 'test-videos', 'GOPR0042.mp4');
  const cube = path.join(out, 'black.cube');
  const yavg = (f) => { const o = spawnSync(ff.ffmpegPath, ['-v', 'error', '-ss', '1', '-i', f, '-frames:v', '1', '-vf', 'scale=64:32,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1e7 }).stdout; return o.reduce((a, b) => a + b, 0) / o.length; };
  const res = {};
  for (const mix of [0.001, 0.25, 0.75]) {
    const r = await ff.convertToVR180({ projection: 'fisheye', layout: 'sbs', fov: 180, codec: 'h264', crf: 22, encoder: 'cpu', output: path.join(out, `lut_${mix}.mp4`), input: fish, lut: cube, lutMix: mix }, () => {});
    res[mix] = yavg(r.output);
  }
  console.log('luma at strength 0% / 25% / 75%:', Object.values(res).map((v) => v.toFixed(0)).join(' / '), '-> ratios', (res[0.25] / res[0.001]).toFixed(2), (res[0.75] / res[0.001]).toFixed(2), '(expected about 0.75 and 0.25 in linear brightness terms; luma is gamma so a bit higher)');
})();
