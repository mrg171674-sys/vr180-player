// End-to-end: PC app + a phone-sized window opening the stream link
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const APP = String.raw`C:\Users\Owner\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\scratch-workspaces\ce2c1510-0d43-4f5e-9777-f8e5101ab90b\8702c2e1-a2f9-49a2-a497-ff763096460c\scratch-2026-10-14-268568`;
const OUT = path.join(__dirname, 'shots');
process.argv.push(path.join(APP, 'test-videos', process.env.CLIP || 'GOPR0042.mp4'));
// the phone window accepts the PC's self-signed certificate (a real phone shows a warning instead)
app.on('certificate-error', (e, _wc, url, _err, _cert, cb) => { if (url.includes(':47190/')) { e.preventDefault(); cb(true); } else cb(false); });
require(path.join(APP, 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (w, name) => fs.writeFileSync(path.join(OUT, name + '.png'), (await w.webContents.capturePage()).toPNG());

app.whenReady().then(async () => {
  await wait(4500);
  const pc = BrowserWindow.getAllWindows()[0];
  pc.setAlwaysOnTop(true); pc.show();
  const js = (w, s) => w.webContents.executeJavaScript(s).catch((e) => 'JSERR ' + e.message);
  for (const w of [pc]) w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 3) console.log('[pc console]', msg); });

  // PC: Phone tab, PIN on, start
  console.log('start:', await js(pc, `(async()=>{ __app.showTab('phone'); await new Promise(r=>setTimeout(r,300));
    const pinRow=[...document.querySelectorAll('.page[data-page=phone] .row-field')].find(r=>/PIN/.test(r.textContent));
    pinRow.querySelector('input').value='7391'; pinRow.querySelector('input').dispatchEvent(new Event('change'));
    if (!pinRow.querySelector('.toggle').classList.contains('is-on')) pinRow.querySelector('.toggle .on').click();
    document.querySelector('.page[data-page=phone] .btn.primary.wide').click();
    await new Promise(r=>setTimeout(r,3000));
    return document.querySelector('.page[data-page=phone] input.link').value; })()`));
  const url = await js(pc, `document.querySelector('.page[data-page=phone] input.link').value`);
  await shot(pc, 'p1_pc_qr');

  // phone window
  const ph = new BrowserWindow({ width: 390, height: 844, x: 40, y: 40, show: true, webPreferences: { backgroundThrottling: false } });
  ph.webContents.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36');
  ph.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 3) console.log('[phone console]', msg); });
  await ph.loadURL(url);
  await wait(1500);
  await shot(ph, 'p2_phone_pin');
  console.log('phone screen:', await js(ph, `document.querySelector('.screen.show').id`));
  await js(ph, `document.getElementById('pin').value='7391'; document.getElementById('pinBtn').click(); 'sent'`);
  await wait(1500);
  console.log('phone after PIN:', await js(ph, `document.querySelector('.screen.show').id + ' / ' + document.getElementById('waitText').textContent`));
  await shot(pc, 'p3_pc_approve');
  console.log('PC approval prompt:', await js(pc, `(()=>{ const m=document.querySelector('.modal'); if(!m) return 'none'; const t=m.innerText.replace(/\\n+/g,' | '); [...m.querySelectorAll('.btn')].find(b=>b.textContent==='Allow').click(); return t; })()`));
  await wait(6000);
  console.log('phone playing:', await js(ph, `JSON.stringify({screen: document.querySelector('.screen.show').id, title: document.getElementById('title').textContent, src: document.getElementById('video').src.split('/').slice(-2).join('/'), t: document.getElementById('video').currentTime.toFixed(1), paused: document.getElementById('video').paused, w: document.getElementById('video').videoWidth})`));
  await shot(ph, 'p4_phone_playing');
  console.log('PC devices:', await js(pc, `document.querySelector('.devices').innerText.replace(/\\n+/g,' | ')`));
  await shot(pc, 'p5_pc_devices');

  // re-encoded stream: switch PC quality to 1080p, reload the phone
  await js(pc, `[...document.querySelectorAll('.page[data-page=phone] .seg button')].find(b=>b.textContent==='1080p').click(); 'ok'`);
  await wait(500);
  await ph.reload();
  await wait(9000);
  console.log('phone HLS:', await js(ph, `JSON.stringify({src: (document.getElementById('video').src||'').split('/').slice(-3).join('/'), t: document.getElementById('video').currentTime.toFixed(1), w: document.getElementById('video').videoWidth, h: document.getElementById('video').videoHeight, paused: document.getElementById('video').paused})`));
  console.log('PC status:', await js(pc, `document.querySelector('.page[data-page=phone] .card:last-child .muted:last-child')?.textContent || [...document.querySelectorAll('.page[data-page=phone] .muted')].pop().textContent`));

  // remote mode: toggle PC playback from the phone
  const before = await js(pc, `__app.player.video.paused`);
  console.log('remote click:', await js(ph, `(async()=>{ document.querySelector('#modeSeg [data-mode=remote]').click(); await new Promise(r=>setTimeout(r,500)); document.querySelector('[data-cmd=toggle]').click(); return 'ok'; })()`));
  await wait(1500);
  const after = await js(pc, `__app.player.video.paused`);
  console.log('remote toggle: PC paused', before, '->', after);
  await shot(ph, 'p6_phone_remote');
  await js(ph, `document.querySelector('#modeSeg [data-mode=watch]').click(); document.getElementById('cardboard').click(); 'ok'`);
  await wait(1500);
  await shot(ph, 'p7_phone_cardboard');

  // kick from the PC
  await js(pc, `[...document.querySelectorAll('.device .btn.danger')][0].click(); 'kicked'`);
  await wait(2500);
  console.log('phone after kick:', await js(ph, `document.querySelector('.screen.show').id + ' / ' + document.getElementById('msgTitle').textContent`));
  app.exit(0);
});
