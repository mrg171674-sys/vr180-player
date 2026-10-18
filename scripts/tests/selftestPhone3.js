// End-to-end: phone download (real browser download), iPhone native fullscreen (stubbed), trust card
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs = require('fs');
const APP = String.raw`C:\Users\Owner\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\scratch-workspaces\ce2c1510-0d43-4f5e-9777-f8e5101ab90b\8702c2e1-a2f9-49a2-a497-ff763096460c\scratch-2026-10-14-268568`;
const OUT = path.join(__dirname, 'shots');
process.argv.push(path.join(APP, 'test-videos', 'GOPR0042.mp4'));
app.on('certificate-error', (e, _wc, url, _err, _cert, cb) => { if (url.includes(':47190/')) { e.preventDefault(); cb(true); } else cb(false); });
require(path.join(APP, 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (w, name) => fs.writeFileSync(path.join(OUT, name + '.png'), (await w.webContents.capturePage()).toPNG());
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

app.whenReady().then(async () => {
  await wait(4500);
  const pc = BrowserWindow.getAllWindows()[0];
  pc.setAlwaysOnTop(true); pc.show();
  const js = (w, s) => w.webContents.executeJavaScript(s, true).catch((e) => 'JSERR ' + e.message);
  pc.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 3) console.log('[pc console]', msg); });
  await js(pc, `(async()=>{ __app.showTab('phone'); await new Promise(r=>setTimeout(r,300));
    const pinRow=[...document.querySelectorAll('.page[data-page=phone] .row-field')].find(r=>/PIN/.test(r.textContent));
    if (pinRow.querySelector('.toggle').classList.contains('is-on')) pinRow.querySelector('.toggle .off').click();
    const lock=[...document.querySelectorAll('.page[data-page=phone] .row-field')].find(r=>/Lock stream/.test(r.textContent));
    if (lock.querySelector('.toggle').classList.contains('is-on')) lock.querySelector('.toggle .off').click();
    document.querySelector('.page[data-page=phone] .btn.primary.wide').click(); await new Promise(r=>setTimeout(r,2500)); return 1; })()`);
  const url = await js(pc, `document.querySelector('.page[data-page=phone] input.link').value`);
  const allow = () => js(pc, `(()=>{ const m=[...document.querySelectorAll('.modal')].pop(); if(!m) return 'none'; const t=m.querySelector('h3').textContent + ' | ' + m.querySelector('.modal-body').innerText.replace(/\\n+/g,' ').slice(0,200); [...m.querySelectorAll('.btn')].find(b=>b.textContent==='Allow'||b.textContent==='Allow this video').click(); return t; })()`);
  console.log('trust card:', await js(pc, `(()=>{ const c=[...document.querySelectorAll('.page[data-page=phone] .card')].find(c=>/Trust this PC/.test(c.textContent)); c.scrollIntoView(); return !!c.querySelector('img.qr') + ' qr, fp ' + c.querySelector('.fp').textContent.slice(0,20); })()`));
  await shot(pc, 'g1_pc_trust');

  const mkPhone = async (ua, x, part) => {
    const w = new BrowserWindow({ width: 390, height: 844, x, y: 40, show: true, webPreferences: { backgroundThrottling: false, partition: part } });
    w.webContents.setUserAgent(ua);
    w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log(`[phone console ${lvl}]`, msg.slice(0, 200)); });
    await w.loadURL(url);
    return w;
  };

  // ---- Android: download the phone-size copy through the browser's download manager
  const ph = await mkPhone(ANDROID, 40, 'dlphone');
  const saved = path.join(require('os').tmpdir(), 'vr180-e2e-download.mp4');
  fs.rmSync(saved, { force: true });
  let dlDone = null;
  session.fromPartition('dlphone').on('will-download', (_e, item) => {
    item.setSavePath(saved);
    console.log('browser download started:', item.getFilename(), item.getMimeType());
    item.once('done', (_e2, state) => (dlDone = state));
  });
  await wait(1500);
  console.log('PC prompt:', await allow());
  await wait(4000);
  console.log('more sheet:', await js(ph, `(async()=>{ document.getElementById('moreBtn').click(); await new Promise(r=>setTimeout(r,500)); return [...document.querySelectorAll('#dlOptions .opt')].map(b=>b.innerText.replace(/\\n/g,' ')).join(' / ') + ' | fsStyle shown: ' + !document.getElementById('fsStyleSec').hidden; })()`));
  await shot(ph, 'g2_phone_more');
  await js(ph, `document.querySelector('#dlOptions [data-kind=phone]').click(); 1`);
  await wait(1200);
  console.log('phone while asking:', await js(ph, `document.getElementById('dlText').textContent`));
  await shot(pc, 'g3_pc_download_prompt');
  console.log('PC prompt:', await allow());
  for (let i = 0; i < 40 && !dlDone; i++) await wait(500);
  console.log('phone status:', await js(ph, `document.getElementById('dlText').textContent`));
  console.log('download:', dlDone, fs.existsSync(saved) ? (fs.statSync(saved).size / 1e6).toFixed(1) + ' MB' : 'missing');
  await shot(ph, 'g4_phone_downloaded');
  console.log('PC device row:', await js(pc, `document.querySelector('.device').innerText.replace(/\\n+/g,' | ')`));
  await js(ph, `document.getElementById('sheetClose').click(); 1`);

  // ---- iPhone: no element fullscreen; native video fullscreen (stubbed webkitEnterFullscreen)
  const ip = await mkPhone(IPHONE, 460, 'iphone');
  await wait(1500);
  console.log('PC prompt (iPhone):', await allow());
  await wait(4500);
  console.log('iPhone native fullscreen:', await js(ip, `(async()=>{
    Element.prototype.requestFullscreen = undefined; Element.prototype.webkitRequestFullscreen = undefined;
    let entered = 0; HTMLVideoElement.prototype.webkitEnterFullscreen = function(){ entered++; window.__fsEl = this.id; };
    HTMLVideoElement.prototype.webkitExitFullscreen = function(){ this.dispatchEvent(new Event('webkitendfullscreen')); };
    document.getElementById('moreBtn').click(); await new Promise(r=>setTimeout(r,300));
    const styleShown = !document.getElementById('fsStyleSec').hidden; document.getElementById('sheetClose').click();
    document.getElementById('fsBtn').click(); await new Promise(r=>setTimeout(r,1200));
    const p=document.getElementById('fsProxy'); const tr=p.srcObject && p.srcObject.getVideoTracks()[0];
    const res={ styleShown, entered, el: window.__fsEl, native: document.body.classList.contains('fs-native'), track: tr ? tr.readyState + ' ' + (tr.getSettings().width||'?') + 'x' + (tr.getSettings().height||'?') : null, proxyPlaying: !p.paused, tilt: document.getElementById('tilt').classList.contains('on') };
    p.pause(); await new Promise(r=>setTimeout(r,300)); res.mirroredPause = document.getElementById('video').paused;
    p.play(); await new Promise(r=>setTimeout(r,300)); res.mirroredPlay = !document.getElementById('video').paused;
    document.getElementById('fsBtn').click(); await new Promise(r=>setTimeout(r,400));
    res.afterExit = { native: document.body.classList.contains('fs-native'), stream: !!p.srcObject };
    return JSON.stringify(res); })()`));
  console.log('fill-screen option still works:', await js(ip, `(async()=>{ localStorage.setItem('fsStyle','fill'); document.getElementById('fsBtn').click(); await new Promise(r=>setTimeout(r,500)); const r=document.body.classList.contains('fs-fill'); history.back(); await new Promise(r=>setTimeout(r,400)); localStorage.removeItem('fsStyle'); return r; })()`));
  console.log('activity log:', await js(pc, `document.querySelector('.phone-log').innerText.replace(/\\n/g,' | ').slice(0, 500)`));
  app.exit(0);
});
