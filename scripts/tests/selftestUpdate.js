// Updater against a local fake release feed (never installs: the "installer" is random bytes)
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const APP = String.raw`C:\Users\Owner\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\scratch-workspaces\ce2c1510-0d43-4f5e-9777-f8e5101ab90b\8702c2e1-a2f9-49a2-a497-ff763096460c\scratch-2026-10-14-268568`;
const OUT = path.join(__dirname, 'shots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const blob = crypto.randomBytes(3 * 1024 * 1024);
const sha512 = crypto.createHash('sha512').update(blob).digest('base64');
const NAME = 'VR180-Player-Setup-99.0.0.exe';
const yml = `version: 99.0.0\nfiles:\n  - url: ${NAME}\n    sha512: ${sha512}\n    size: ${blob.length}\npath: ${NAME}\nsha512: ${sha512}\nreleaseDate: '2026-10-16T00:00:00.000Z'\n`;
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url.startsWith('/latest.yml')) { res.writeHead(200, { 'Content-Type': 'text/yaml' }); return res.end(yml); }
  if (req.url.startsWith('/' + NAME)) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': blob.length });
    // trickle it so download progress is visible
    let i = 0; const step = 256 * 1024;
    const pump = () => { if (i >= blob.length) return res.end(); res.write(blob.subarray(i, i + step)); i += step; setTimeout(pump, 80); };
    return pump();
  }
  res.writeHead(404); res.end();
}).listen(0, '127.0.0.1', () => {
  process.env.VR180_UPDATE_FEED = `http://127.0.0.1:${server.address().port}/`;
  require(path.join(APP, 'main.js'));
  app.whenReady().then(run);
});

async function run() {
  await wait(3000);
  const pc = BrowserWindow.getAllWindows()[0];
  const js = (s) => pc.webContents.executeJavaScript(s).catch((e) => 'JSERR ' + e.message);
  pc.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 3) console.log('[console]', msg); });
  await js(`__app.showTab('settings'); 'ok'`);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const s = await js(`vr180.updateStatus().then(s => s.state + (s.percent != null ? ' ' + s.percent + '%' : '') + (s.version ? ' v' + s.version : '') + (s.error ? ' ' + s.error : ''))`);
    if (!seen.has(s)) { seen.add(s); console.log('status:', s, '| about:', await js(`document.querySelector('.update-text').textContent`)); }
    if (/downloading [3-6]\d%/.test(s) && !fs.existsSync(path.join(OUT, 'u1_downloading.png'))) {
      await js(`document.querySelector('.update-text').scrollIntoView(); 'ok'`);
      fs.writeFileSync(path.join(OUT, 'u1_downloading.png'), (await pc.webContents.capturePage()).toPNG());
    }
    if (/^ready/.test(s) || /^error/.test(s)) break;
    await wait(500);
  }
  await wait(500);
  console.log('strip:', await js(`(document.querySelector('.strip')||{}).innerText`));
  fs.writeFileSync(path.join(OUT, 'u2_ready.png'), (await pc.webContents.capturePage()).toPNG());
  console.log('feed requests:', [...new Set(hits.map((h) => h.split('?')[0]))].join(', '));
  app.exit(0);
}
