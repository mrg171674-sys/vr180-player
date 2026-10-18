// Launch the packaged app, then inspect it over the DevTools protocol
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = process.cwd();
const exe = path.join(ROOT, 'dist', 'win-unpacked', 'VR180 Player.exe');
const clip = path.join(ROOT, 'test-videos', 'GOPR0042.mp4');
const child = spawn(exe, ['--remote-debugging-port=9339', clip], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(9000);
  const targets = await (await fetch('http://127.0.0.1:9339/json')).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const my = ++id;
    const h = (m) => { const d = JSON.parse(m.data); if (d.id === my) { ws.removeEventListener('message', h); resolve(d.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  const ev = async (expr) => (await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
  console.log('title:', page.title);
  console.log('video:', await ev(`(async()=>{ const v=__app.player.video; await v.play().catch(()=>{}); await new Promise(r=>setTimeout(r,1500)); return JSON.stringify({t:+v.currentTime.toFixed(1), w:v.videoWidth, paused:v.paused}); })()`));
  console.log('version:', await ev(`vr180.appInfo().then(i=>i.version)`));
  console.log('updater:', await ev(`vr180.updateStatus().then(s=>JSON.stringify(s))`));
  console.log('encoders:', await ev(`vr180.encoders ? vr180.encoders().then(e=>JSON.stringify(e)) : 'n/a'`));
  console.log('phone:', await ev(`(async()=>{ __app.showTab('phone'); await new Promise(r=>setTimeout(r,300)); document.querySelector('.page[data-page=phone] .btn.primary.wide').click(); await new Promise(r=>setTimeout(r,3000)); return document.querySelector('.page[data-page=phone] input.link').value; })()`));
  const link = await ev(`document.querySelector('.page[data-page=phone] input.link').value`);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const u = new URL(link); u.hostname = '127.0.0.1';
  const pageHtml = await (await fetch(u)).text();
  const three = await fetch(new URL('node_modules/three/build/three.module.js', u));
  const hls = await fetch(new URL('node_modules/hls.js/dist/hls.min.js', u));
  console.log('phone page from package:', /VR180 Player/.test(pageHtml), '| three.js', three.status, '| hls.js', hls.status);
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, 'shots', 'pkg_phone.png'), Buffer.from(shot.data, 'base64'));
  await ev(`(async()=>{ document.querySelector('.page[data-page=phone] .btn.wide').click(); return 1; })()`);
  ws.close();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); child.kill(); process.exit(1); });
