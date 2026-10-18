// Tests: add-on install (local mirror of the pinned files), checksum refusal, cancel,
// AI subtitles on a clip with speech, AI upscaling of a short clip, queue integration.
const APP = process.argv[2];
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const M = 'C:/Users/Owner/AppData/Local/Temp/claude/vr180-models';
const models = require(APP + '/lib/models.js');
const ai = require(APP + '/lib/ai.js');
const queue = require(APP + '/lib/queue.js');
const ff = require(APP + '/lib/ffmpeg.js');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-aitest-'));
const SRC = { 'whisper-engine': M + '/whisper/whisper-bin-x64.zip', 'whisper-base': M + '/whisper-model/ggml-base.bin', depth: M + '/depth/model.onnx', esrgan: M + '/esrgan/realesrgan-ncnn-vulkan-20220424-windows.zip' };
let corrupt = null, slow = null;
const results = [];
const ok = (name, pass, extra = '') => { results.push(pass); console.log((pass ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };

const server = http.createServer((req, res) => {
  const id = decodeURIComponent(req.url.slice(1));
  if (!SRC[id]) { res.writeHead(404); return res.end(); }
  if (req.url.includes('redirect')) { res.writeHead(302, { Location: '/' + id }); return res.end(); }
  res.writeHead(200, { 'Content-Length': fs.statSync(SRC[id]).size });
  const s = fs.createReadStream(SRC[id], { highWaterMark: slow === id ? 16384 : 1 << 20 });
  if (corrupt === id) {
    let first = true;
    s.on('data', (c) => { if (first) { c[100] ^= 0xff; first = false; } if (!res.write(c)) { s.pause(); res.once('drain', () => s.resume()); } });
    s.on('end', () => res.end());
  } else if (slow === id) {
    s.on('data', (c) => { s.pause(); res.write(c); setTimeout(() => s.resume(), 20); });
    s.on('end', () => res.end());
  } else s.pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  for (const id of Object.keys(models.FILES)) models.FILES[id].url = base + id;
  models.init(ud); ai.init(ud);

  // 1. checksum mismatch is refused and leaves nothing behind
  corrupt = 'depth';
  let err = null;
  try { await models.install('depth', () => {}); } catch (e) { err = e.message; }
  ok('damaged download refused', /checksum mismatch/.test(err || '') && !models.status().depth.installed && !fs.existsSync(path.join(ud, 'models', 'depth')), err);
  corrupt = null;

  // 2. cancel mid-download
  slow = 'depth';
  const pr = models.install('depth', () => {});
  await new Promise((r) => setTimeout(r, 400));
  const mid = models.status().depth;
  models.cancel('depth');
  const res = await pr;
  ok('cancel install', res === false && mid.downloading && !models.status().depth.installed && !fs.existsSync(path.join(ud, 'models', 'depth')), `was ${(mid.fraction * 100).toFixed(1)}% when cancelled`);
  slow = null;

  // 3. real installs with progress
  for (const pack of ['subs', 'depth', 'upscale']) {
    const ticks = [];
    const t = Date.now();
    await models.install(pack, (p) => ticks.push(p));
    const st = models.status()[pack];
    ok(`install ${pack}`, st.installed && ticks.at(-1).done && ticks.length > 1, `${(st.size / 1e6).toFixed(0)} MB in ${Date.now() - t} ms, ${ticks.length} progress events`);
  }
  const P = models.paths();
  ok('paths', fs.existsSync(P.whisperCli) && fs.existsSync(P.whisperModel) && fs.existsSync(P.depthModel) && fs.existsSync(P.esrgan) && fs.readdirSync(P.esrganModels).length >= 6, JSON.stringify(Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v && path.relative(ud, v)]))));

  // 4. subtitles through the queue
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-aiw-'));
  const talk = path.join(work, 'talk.mp4');
  await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10', '-i', M + '/speech16.wav', '-filter_complex', '[1:a]adelay=1500|1500,apad=whole_dur=10[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', talk]);
  const events = [];
  let resolveDone;
  const finished = new Promise((r) => (resolveDone = r));
  queue.init((ch, data) => { events.push([ch, data]); if (ch === 'job-done' || ch === 'job-failed') resolveDone(data); }, () => {}, null);
  const t0 = Date.now();
  queue.add([{ kind: 'subs', input: talk, language: 'auto' }]);
  const job = await finished;
  const srtPath = path.join(work, 'talk.en.auto.srt');
  const srt = fs.existsSync(srtPath) ? fs.readFileSync(srtPath, 'utf8') : '';
  const firstCue = /(\d\d:\d\d:\d\d,\d+) -->/.exec(srt);
  ok('subtitles job', job.status === 'done' && /-->/.test(srt) && job.kind === 'subs', `${Date.now() - t0} ms · ${job.stage} · first cue at ${firstCue && firstCue[1]} (speech starts 1.5 s)`);
  console.log('   ' + srt.split('\n').slice(0, 7).join(' | '));
  const stages = [...new Set(events.filter(([c]) => c === 'queue').flatMap(([, l]) => l.map((j) => j.stage.replace(/[0-9]+%/, 'N%'))))];
  console.log('   stages seen: ' + stages.join(' / '));

  // 5. upscale a 2 s clip through the queue
  const small = path.join(work, 'small.mp4');
  await ff.run(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=960x480:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', small]);
  let resolve2;
  const fin2 = new Promise((r) => (resolve2 = r));
  queue.init((ch, data) => { if (ch === 'job-done' || ch === 'job-failed') resolve2(data); }, () => {}, null);
  const t1 = Date.now();
  queue.add([{ kind: 'upscale', input: small }]);
  const job2 = await fin2;
  const out = job2.output && await ff.probe(job2.output);
  ok('upscale job', job2.status === 'done' && out && out.width === 1920 && out.height === 960 && Math.abs(out.duration - 2) < 0.1 && out.hasAudio,
    `${Date.now() - t1} ms · ${job2.stage} · ${out && `${out.width}x${out.height} ${out.duration}s audio=${out.hasAudio} ${out.codec}`} ${job2.error || ''}`);
  if (out) {
    const frames = (await ff.run(['-i', job2.output, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'])).match(/frame=\s*(\d+)/g);
    console.log('   frames in output: ' + (frames && frames.at(-1)));
  }

  // 6. cancel a running upscale leaves nothing
  let resolve3;
  const fin3 = new Promise((r) => (resolve3 = r));
  let seenRunning = false;
  queue.init((ch, data) => { if (ch === 'queue' && data.some((j) => j.status === 'running' && /Upscaling/.test(j.stage))) seenRunning = true; }, () => {}, null);
  const [id3] = queue.add([{ kind: 'upscale', input: small, output: path.join(work, 'cancelme.mp4') }]);
  for (let i = 0; i < 100 && !seenRunning; i++) await new Promise((r) => setTimeout(r, 100));
  queue.cancel(id3);
  for (let i = 0; i < 50; i++) { const j = queue.list().find((x) => x.id === id3); if (j.status !== 'running') { resolve3(j); break; } await new Promise((r) => setTimeout(r, 100)); }
  const j3 = await fin3;
  ok('cancel upscale', j3.status === 'cancelled' && !fs.existsSync(path.join(work, 'cancelme.mp4')) && !fs.existsSync(path.join(work, 'cancelme.mp4.part.mp4')) && !fs.readdirSync(os.tmpdir()).some((d) => d.startsWith('vr180-ai-')), j3.status);

  // 7. remove
  models.remove('upscale');
  ok('remove add-on', !models.status().upscale.installed && models.status().subs.installed);

  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
