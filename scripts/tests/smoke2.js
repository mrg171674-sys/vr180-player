// Packaged 2.0.0 smoke test: launches dist/win-unpacked with a test profile and checks the
// new parts survive packaging (AI runtime from the asar, depth on the GPU, 3D helper, pairing).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = process.cwd();
const exe = path.join(ROOT, 'dist', 'win-unpacked', 'VR180 Player.exe');
const clip = path.join(ROOT, 'test-videos', 'GOPR0042.mp4');
const talk = 'C:\\Users\\Owner\\AppData\\Local\\Temp\\claude\\vrt\\talk.mp4';
const child = spawn(exe, ['--remote-debugging-port=9341', clip], { stdio: 'ignore', env: { ...process.env, VR180_PROFILE: 'pkgsmoke' } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(9000);
  const targets = await (await fetch('http://127.0.0.1:9341/json')).json();
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const my = ++id;
    const h = (m) => { const d = JSON.parse(m.data); if (d.id === my) { ws.removeEventListener('message', h); resolve(d.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? 'EXCEPTION ' + JSON.stringify(r.exceptionDetails).slice(0, 300) : r.result.value; };
  console.log('page url:', page.url.replace(/^file:\/\/\//, '').slice(-60));
  console.log('version:', await ev(`vr180.appInfo().then(i=>i.version)`));
  console.log('video:', await ev(`(async()=>{ const v=__app.player.video; await v.play().catch(()=>{}); await new Promise(r=>setTimeout(r,1500)); return JSON.stringify({t:+v.currentTime.toFixed(1), w:v.videoWidth, paused:v.paused}); })()`));
  console.log('ai status:', await ev(`vr180.aiStatus().then(s=>Object.entries(s).map(([k,v])=>k+':'+(v.installed?'installed':'no')).join(' '))`));
  console.log('ort from asar:', await ev(`import('../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs').then(m=>typeof m.InferenceSession)`));
  console.log('2D->3D in package:', await ev(`(async()=>{ await __app.player.open([${JSON.stringify(talk)}]); await new Promise(r=>setTimeout(r,1500)); const d=await import('./depth.js'); d.setDepthCfg({ on: true }); d.updateDepth(true); for(let i=0;i<80;i++){ await new Promise(r=>setTimeout(r,150)); if(d.depthStats()?.runs>2) break; } const s=d.depthStats(); d.setDepthCfg({ on: false }); d.updateDepth(false); return s ? JSON.stringify({ runs: s.runs, ms: Math.round(s.ms), gpu: s.gpu }) : 'no depth maps'; })()`));
  console.log('3D helper page:', await ev(`fetch('depth-worker.html').then(r=>r.ok)`));
  console.log('3D export in package:', await ev(`(async()=>{ const done=new Promise(r=>{ vr180.onJobDone(r); vr180.onJobFailed(r); }); await vr180.queueAdd([{ kind:'3d', input: ${JSON.stringify(path.join(ROOT, 'test-videos', 'GOPR0042.mp4'))}.replace('GOPR0042.mp4','GOPR0042.mp4'), output: 'C:\\\\Users\\\\Owner\\\\AppData\\\\Local\\\\Temp\\\\claude\\\\vrt\\\\pkg_3d.mp4', strength: 50, pop: 35 }]); const j=await done; return j.status + ' · ' + (j.stage||'') + ' ' + (j.error||''); })()`));
  console.log('phone + pairing:', await ev(`(async()=>{ __app.showTab('phone'); await new Promise(r=>setTimeout(r,300)); document.querySelector('.page[data-page=phone] .btn.primary.wide').click(); await new Promise(r=>setTimeout(r,3000)); return document.querySelector('.pair-url')?.textContent + ' code ' + document.querySelector('.pair-code')?.textContent; })()`));
  const pairUrl = await ev(`document.querySelector('.pair-url')?.textContent`);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  if (pairUrl) { const u = new URL(pairUrl); u.hostname = '127.0.0.1'; const html = await (await fetch(u)).text(); console.log('pair page from package:', /Connect to VR180 Player/.test(html)); }
  const link = await ev(`document.querySelector('.page[data-page=phone] input.link').value`);
  if (link) { const u = new URL(link); u.hostname = '127.0.0.1'; const panel = await fetch(new URL('renderer/vrpanel.js', u)); console.log('phone VR panel served:', panel.status); }
  await ev(`(async()=>{ document.querySelector('.page[data-page=phone] .btn.wide')?.click(); return 1; })()`);
  const errs = [];
  await call('Runtime.enable');
  console.log('done');
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('SMOKE FAIL', e); child.kill(); process.exit(1); });
