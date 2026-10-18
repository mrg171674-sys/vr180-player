// Pairing code tests for lib/phone.js: page, single use, rate limits, rotation, stop
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const root = process.cwd();
const phone = require(root + '/lib/phone');

const events = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phonepair-'));
phone.init((ch, data) => events.push([ch, data]), dataDir);
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  · ' + extra : ''}`); };

function req(url, { method = 'GET', body, from = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method, localAddress: from, rejectUnauthorized: false, agent: false,
      headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks).toString(); let j = {}; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, text: b, json: j, type: res.headers['content-type'] }); });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  let info = await phone.start({ approve: true });
  const base = `https://127.0.0.1:${info.port}`;
  const token = new URL(info.url).pathname.split('/')[2];
  check('code shown in info', /^\d{6}$/.test(info.pairCode || '') && /\/pair$/.test(info.pairUrl), info.pairUrl);

  const page = await req(base + '/pair');
  check('pairing page', page.status === 200 && /Connect to VR180 Player/.test(page.text) && !page.text.includes(token) && !page.text.includes(info.pairCode));
  const js = await req(base + '/pair.js');
  check('pairing script', js.status === 200 && /text\/javascript/.test(js.type) && !js.text.includes(info.pairCode) && /replace\(\/\\D\/g/.test(js.text));

  // wrong codes from one address: 5 tries, then locked out
  const wrong = String((+info.pairCode + 1) % 1000000).padStart(6, '0');
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await req(base + '/pair', { method: 'POST', body: { code: wrong }, from: '127.0.0.2' })).status);
  check('5 wrong tries then a lockout', tries.slice(0, 5).every((s) => s === 403) && tries[5] === 429, tries.join(','));
  const locked = await req(base + '/pair', { method: 'POST', body: { code: info.pairCode }, from: '127.0.0.2' });
  check('locked-out device cannot use even the right code', locked.status === 429, 'wait ' + locked.json.wait + ' s');

  // the right code from another device works once and leads to the secret link
  const ok = await req(base + '/pair', { method: 'POST', body: { code: info.pairCode.slice(0, 3) + ' ' + info.pairCode.slice(3) }, from: '127.0.0.3' });
  check('right code opens the secret link', ok.status === 200 && ok.json.url === `/s/${token}/`);
  const used = info.pairCode;
  info = await phone.info();
  check('code changes after use', info.pairCode && info.pairCode !== used && events.some(([c, d]) => c === 'phone-pair' && d.code === info.pairCode));
  const again = await req(base + '/pair', { method: 'POST', body: { code: used }, from: '127.0.0.4' });
  check('used code no longer works', again.status === 403);
  // the link still needs approval (the code is only a way to get the link)
  const hello = await req(base + ok.json.url + 'api/hello', { method: 'POST', body: { caps: {} }, from: '127.0.0.3' });
  check('approval still required after pairing', hello.json.status === 'pending', JSON.stringify(hello.json));

  // 20 wrong codes in total (spread over addresses) change the code
  const before = (await phone.info()).pairCode;
  const bad = String((+before + 7) % 1000000).padStart(6, '0');
  for (let i = 0; i < 20; i++) await req(base + '/pair', { method: 'POST', body: { code: bad }, from: `127.0.1.${10 + (i % 5)}` });
  const after = (await phone.info()).pairCode;
  check('20 wrong codes in total change the code', after !== before);

  // locked stream refuses pairing
  await phone.setOptions({ locked: true });
  const lockedStream = await req(base + '/pair', { method: 'POST', body: { code: after }, from: '127.0.0.9' });
  check('locked stream refuses pairing', lockedStream.status === 423);
  await phone.setOptions({ locked: false });

  // a new link changes the code; stopping hides the page
  const pre = (await phone.info()).pairCode;
  await phone.rotate(true);
  check('new link -> new code', (await phone.info()).pairCode !== pre);
  await phone.stop();
  const port = info.port;
  // restart to check that the old code and page are gone
  const info2 = await phone.start({ approve: true });
  const stale = await req(`https://127.0.0.1:${info2.port}/pair`, { method: 'POST', body: { code: pre }, from: '127.0.0.20' });
  check('a code from before a restart is useless', stale.status === 403 || info2.pairCode === pre);
  await phone.stop();
  let gone;
  try { gone = await req(`https://127.0.0.1:${port}/pair`); } catch (e) { gone = { status: 'refused' }; }
  check('stopped: no pairing page', gone.status === 'refused' || gone.status === 404, String(gone.status));
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
