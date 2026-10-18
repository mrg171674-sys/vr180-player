// End-to-end: phone fullscreen, iPhone fill-screen, control permission, lock
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const APP = String.raw`C:\Users\Owner\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\scratch-workspaces\ce2c1510-0d43-4f5e-9777-f8e5101ab90b\8702c2e1-a2f9-49a2-a497-ff763096460c\scratch-2026-10-14-268568`;
const OUT = path.join(__dirname, 'shots');
process.argv.push(path.join(APP, 'test-videos', 'beach_trip.mp4'));
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

  console.log('start:', await js(pc, `(async()=>{ __app.showTab('phone'); await new Promise(r=>setTimeout(r,300));
    const pinRow=[...document.querySelectorAll('.page[data-page=phone] .row-field')].find(r=>/PIN/.test(r.textContent));
    if (pinRow.querySelector('.toggle').classList.contains('is-on')) pinRow.querySelector('.toggle .off').click();
    const q=[...document.querySelectorAll('.page[data-page=phone] .seg button')].find(b=>b.textContent==='Auto'); q&&q.click();
    document.querySelector('.page[data-page=phone] .btn.primary.wide').click();
    await new Promise(r=>setTimeout(r,2500));
    return document.querySelector('.page[data-page=phone] input.link').value.replace(/s\\/.*/, 's/<secret>/'); })()`));
  const url = await js(pc, `document.querySelector('.page[data-page=phone] input.link').value`);

  const mkPhone = async (ua, x) => {
    const w = new BrowserWindow({ width: 390, height: 844, x, y: 40, show: true, webPreferences: { backgroundThrottling: false, partition: 'phone' + x } });
    w.webContents.setUserAgent(ua);
    w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log(`[phone console ${lvl}]`, msg.slice(0, 200)); });
    await w.loadURL(url);
    return w;
  };
  const allow = () => js(pc, `(()=>{ const m=[...document.querySelectorAll('.modal')].pop(); if(!m) return 'none'; const t=m.querySelector('h3').textContent; [...m.querySelectorAll('.btn')].find(b=>b.textContent==='Allow').click(); return t; })()`);

  // ---- Android phone: join, play, fullscreen
  const ph = await mkPhone(ANDROID, 40);
  await wait(1500);
  console.log('PC prompt:', await allow());
  await wait(5000);
  console.log('playing:', await js(ph, `JSON.stringify({screen: document.querySelector('.screen.show').id, t: +document.getElementById('video').currentTime.toFixed(1), paused: document.getElementById('video').paused})`));
  console.log('fullscreen:', await js(ph, `(async()=>{ document.getElementById('fsBtn').click(); await new Promise(r=>setTimeout(r,800)); return JSON.stringify({real: !!document.fullscreenElement, isFs: document.body.classList.contains('is-fs'), btn: document.getElementById('fsBtn').textContent}); })()`));
  await wait(3600);
  console.log('controls hidden after 3 s:', await js(ph, `document.body.classList.contains('hide-ui')`));
  await shot(ph, 'f1_android_fullscreen');
  console.log('exit via button:', await js(ph, `(async()=>{ document.getElementById('stage').dispatchEvent(new PointerEvent('pointerup')); document.getElementById('fsBtn').click(); await new Promise(r=>setTimeout(r,800)); return JSON.stringify({real: !!document.fullscreenElement, isFs: document.body.classList.contains('is-fs')}); })()`));
  // double tap
  console.log('double-tap:', await js(ph, `(async()=>{ const s=document.getElementById('stage'); const tap=()=>{ s.dispatchEvent(new PointerEvent('pointerdown',{clientX:200,clientY:300})); s.dispatchEvent(new PointerEvent('pointerup',{clientX:200,clientY:300})); }; tap(); await new Promise(r=>setTimeout(r,120)); tap(); await new Promise(r=>setTimeout(r,800)); const on=!!document.fullscreenElement; document.getElementById('fsBtn').click(); await new Promise(r=>setTimeout(r,600)); return 'entered ' + on + ', exited ' + !document.fullscreenElement; })()`));

  // ---- remote: needs permission
  console.log('remote before allow:', await js(ph, `(async()=>{ document.querySelector('#modeSeg [data-mode=remote]').click(); await new Promise(r=>setTimeout(r,400)); return JSON.stringify({ask: !document.getElementById('ctlAsk').hidden, disabled: document.getElementById('remote').classList.contains('no-control')}); })()`));
  await shot(ph, 'f2_remote_locked');
  const before = await js(pc, `__app.player.video.paused`);
  await js(ph, `document.querySelector('[data-cmd=toggle]').click(); 1`);
  await wait(800);
  console.log('toggle without permission: PC paused', before, '->', await js(pc, `__app.player.video.paused`));
  await js(ph, `document.getElementById('ctlBtn').click(); 1`);
  await wait(800);
  console.log('phone button:', await js(ph, `document.getElementById('ctlBtn').textContent`));
  await shot(pc, 'f3_pc_control_prompt');
  console.log('PC prompt:', await allow());
  await wait(1500);
  console.log('remote after allow:', await js(ph, `JSON.stringify({ask: !document.getElementById('ctlAsk').hidden, disabled: document.getElementById('remote').classList.contains('no-control')})`));
  const b2 = await js(pc, `__app.player.video.paused`);
  await js(ph, `document.querySelector('[data-cmd=toggle]').click(); 1`);
  await wait(800);
  console.log('toggle with permission: PC paused', b2, '->', await js(pc, `__app.player.video.paused`));
  console.log('PC device row:', await js(pc, `document.querySelector('.device').innerText.replace(/\\n+/g,' | ')`));
  await js(ph, `document.querySelector('#modeSeg [data-mode=watch]').click(); 1`);

  // ---- iPhone: no fullscreen API -> fill-screen
  const ip = await mkPhone(IPHONE, 460);
  await wait(1500);
  console.log('PC prompt (iPhone):', await allow());
  await wait(5000);
  console.log('iPhone fill-screen:', await js(ip, `(async()=>{ delete Element.prototype.requestFullscreen; delete Element.prototype.webkitRequestFullscreen; Element.prototype.requestFullscreen=undefined; Element.prototype.webkitRequestFullscreen=undefined;
    document.getElementById('fsBtn').click(); await new Promise(r=>setTimeout(r,600));
    const r=document.getElementById('stage').getBoundingClientRect();
    return JSON.stringify({fill: document.body.classList.contains('fs-fill'), real: !!document.fullscreenElement, stage: Math.round(r.width)+'x'+Math.round(r.height), viewport: innerWidth+'x'+innerHeight, hint: document.getElementById('hint').hidden ? null : document.getElementById('hint').textContent}); })()`));
  await shot(ip, 'f4_iphone_fill');
  console.log('iPhone Back leaves fill-screen:', await js(ip, `(async()=>{ history.back(); await new Promise(r=>setTimeout(r,600)); return !document.body.classList.contains('fs-fill') && document.querySelector('.screen.show').id; })()`));

  // ---- lock: a third phone is turned away, the others keep playing
  await js(pc, `[...document.querySelectorAll('.page[data-page=phone] .row-field')].find(r=>/Lock stream/.test(r.textContent)).querySelector('.toggle .on').click(); 1`);
  await wait(800);
  await shot(pc, 'f5_pc_locked');
  const third = await mkPhone(ANDROID.replace('Pixel 8', 'SM-S918B'), 860);
  await wait(1500);
  console.log('3rd phone while locked:', await js(third, `document.querySelector('.screen.show').id + ' / ' + document.getElementById('msgTitle').textContent`));
  console.log('1st phone still ok:', await js(ph, `document.querySelector('.screen.show').id`));
  await shot(third, 'f6_phone_locked');
  console.log('activity log:', await js(pc, `document.querySelector('.phone-log').innerText.replace(/\\n/g,' | ').slice(0, 600)`));
  app.exit(0);
});
