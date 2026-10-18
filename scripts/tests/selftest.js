const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const APP = path.resolve(__dirname, '..', '..');
const OUT = path.join(require('os').tmpdir(), 'vr180-test-shots');
if (process.env.CLIP) process.argv.push(path.join(APP, 'test-videos', process.env.CLIP));
fs.mkdirSync(OUT, { recursive: true });
require(path.join(APP, 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await wait(300);
  const w = BrowserWindow.getAllWindows()[0];
  w.webContents.on('console-message', (_e, lvl, msg, line, src) => { if (lvl >= 2) console.log('[console]', lvl, msg, src && src.split('/').pop() + ':' + line); });
  await wait(+(process.env.WAIT || 4500));
  w.setAlwaysOnTop(true); w.show(); w.focus();
  const js = (s) => w.webContents.executeJavaScript(s).catch((e) => 'JSERR ' + e.message);
  let n = 0;
  const shot = async (name) => fs.writeFileSync(path.join(OUT, (n++) + '_' + name + '.png'), (await w.webContents.capturePage()).toPNG());
  await shot('start');
  const steps = process.env.STEPS_FILE ? JSON.parse(fs.readFileSync(process.env.STEPS_FILE, 'utf8')) : (process.env.STEPS || '').split(';;').filter(Boolean).map((s) => s.split('|'));
  for (const [name, code, ms] of steps) {
    const r = await js(code || '0');
    await wait(+(ms || 1200));
    if (r !== undefined && r !== null && r !== 0) console.log(name, '=>', typeof r === 'string' ? r : JSON.stringify(r));
    await shot(name);
  }
  app.exit(0);
});
