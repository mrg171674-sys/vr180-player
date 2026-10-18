// Remembered devices, up next, chapters, remote play/seek validation (lib/phone.js)
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const root = process.cwd();
const phone = require(root + '/lib/phone');

const events = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone5-'));
phone.init((ch, data) => events.push([ch, data]), dataDir);
const last = (ch) => events.filter(([c]) => c === ch).pop()?.[1];
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  · ' + extra : ''}`); };

function req(url, { method = 'GET', body, cookie, from = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method, localAddress: from, rejectUnauthorized: false, agent: false,
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/35.0 Chrome/126 VR', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks).toString(); let j = {}; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, text: b, location: res.headers.location, setCookie: res.headers['set-cookie'] || [] }); });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const cookieOf = (sc, name) => sc.map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));

(async () => {
  let info = await phone.start({ approve: true });
  const host = `https://127.0.0.1:${info.port}`;
  let base = host + new URL(info.url).pathname;
  const me = { from: '127.0.0.2' };
  phone.setCurrent({ path: __filename, playPath: __filename, name: 'trip.mp4', isImage: false, duration: 120, width: 3840, height: 1920, codec: 'h264',
    format: { projection: 'equirect180', layout: 'sbs' }, calib: {}, level: null, subs: [],
    chapters: [{ t: 0, name: 'Start' }, { t: 42.5, name: 'Beach' }], upNext: [{ i: 3, name: 'next.mp4' }, { i: 4, name: 'after.mp4' }] });

  // first visit: approval, "Allow & remember"
  let h = await req(base + 'api/hello', { method: 'POST', body: {}, ...me });
  const sess = cookieOf(h.setCookie, 'vr180s');
  check('headset is named', h.json.name === 'Quest 3 · headset', h.json.name);
  check('first visit waits for the PC', h.json.status === 'pending' && last('phone-approve')?.name === 'Quest 3 · headset');
  const id = phone.devices().find((d) => d.ip === '127.0.0.2').id;
  phone.decide(id, true, true);
  let s = await req(base + 'api/state', { ...me, cookie: sess });
  const trustC = s.setCookie.find((c) => c.startsWith('vr180d='));
  check('remembered: key cookie only for /pair, HttpOnly, Secure, Strict', /Path=\/pair;/.test(trustC || '') && /HttpOnly/.test(trustC) && /Secure/.test(trustC) && /SameSite=Strict/.test(trustC) && s.json.me.trusted === true);
  const s2 = await req(base + 'api/state', { ...me, cookie: sess });
  check('key is handed over once', !s2.setCookie.some((c) => c.startsWith('vr180d=')));
  const key = trustC.split(';')[0].split('=')[1];
  const stored = fs.readFileSync(path.join(dataDir, 'phone-trusted.json'), 'utf8');
  check('only a hash of the key is stored', !stored.includes(key) && JSON.parse(stored).length === 1);
  check('chapters reach the phone', s.json.item.chapters.length === 2 && s.json.item.chapters[1].name === 'Beach');
  check('no up next without control permission', Array.isArray(s.json.upNext) && s.json.upNext.length === 0);

  // up next + remote play/seek with control
  phone.setControl(id, true);
  s = await req(base + 'api/state', { ...me, cookie: sess });
  check('up next shown to a phone with control', s.json.upNext.length === 2 && s.json.upNext[0].name === 'next.mp4');
  let r = await req(base + 'api/event', { method: 'POST', body: { mode: 'remote', cmd: 'play', value: 3 }, ...me, cookie: sess });
  check('play an offered entry', r.status === 200 && last('phone-cmd')?.cmd === 'play' && last('phone-cmd')?.value === 3);
  r = await req(base + 'api/event', { method: 'POST', body: { mode: 'remote', cmd: 'play', value: 0 }, ...me, cookie: sess });
  check('an entry the PC did not offer is refused', r.status === 400);
  r = await req(base + 'api/event', { method: 'POST', body: { mode: 'remote', cmd: 'seek', value: 42.5 }, ...me, cookie: sess });
  check('seek to a chapter', r.status === 200 && last('phone-cmd')?.value === 42.5);
  r = await req(base + 'api/event', { method: 'POST', body: { mode: 'remote', cmd: 'seek', value: 9999 }, ...me, cookie: sess });
  check('seek outside the video is refused', r.status === 400);

  // later: new link (everyone out). The bookmark /pair brings the remembered headset straight back in.
  info = await phone.rotate(true);
  base = host + new URL(info.url).pathname;
  const p = await req(host + '/pair', { cookie: 'vr180d=' + key, from: '127.0.0.5' });
  check('bookmark /pair -> straight to the new link', p.status === 302 && p.location === new URL(info.url).pathname, p.location);
  h = await req(host + p.location + 'api/hello', { method: 'POST', body: {}, from: '127.0.0.5' });
  check('remembered device joins without asking the PC', h.json.status === 'ok');
  const noKey = await req(host + '/pair', { from: '127.0.0.6' });
  check('without the key: the code page', noKey.status === 200 && /6-digit code/.test(noKey.text));
  const badKey = await req(host + '/pair', { cookie: 'vr180d=' + 'x'.repeat(43), from: '127.0.0.6' });
  check('a made-up key: the code page', badKey.status === 200 && !badKey.location);
  // the pre-approval is for that address only and is used up
  h = await req(base + 'api/hello', { method: 'POST', body: {}, from: '127.0.0.7' });
  check('another device still needs approval', h.json.status === 'pending');

  // forget it on the PC
  const list = phone.trustedList();
  check('PC lists the remembered device', list.length === 1 && list[0].name === 'Quest 3 · headset');
  phone.forgetTrusted(list[0].id);
  const after = await req(host + '/pair', { cookie: 'vr180d=' + key, from: '127.0.0.8' });
  check('forgotten: the key no longer works', after.status === 200 && !after.location);

  await phone.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
