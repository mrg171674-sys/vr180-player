// Security hardening tests for lib/phone.js (plain Node; fakes the clock, uses 127.0.0.x as different devices)
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const root = process.cwd();

let skew = 0;
const realNow = Date.now;
Date.now = () => realNow() + skew;
const later = (min) => { skew += min * 60000; };
const tick = () => new Promise((r) => setTimeout(r, 1300)); // let the 1 s sweep run

const phone = require(root + '/lib/phone');
const events = [];
phone.init((ch, data) => events.push([ch, data]), fs.mkdtempSync(path.join(os.tmpdir(), 'phonetest2-')));
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
const last = (ch) => events.filter(([c]) => c === ch).pop()?.[1];

function req(base, rest, { method = 'GET', body, cookie, from = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + rest);
    const r = https.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, agent, localAddress: from,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let j; try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch {} resolve({ status: res.statusCode, headers: res.headers, json: j || {}, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }); });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  · ' + extra : ''}`); };
const baseOf = (info) => `https://127.0.0.1:${info.port}/s/${new URL(info.url).pathname.split('/')[2]}/`;
const join = async (base, from, pin) => {
  const h = await req(base, 'api/hello', { method: 'POST', body: {}, from });
  if (pin && h.json.status === 'pin') { const p = await req(base, 'api/pin', { method: 'POST', body: { pin }, cookie: h.cookie, from }); return { cookie: h.cookie, status: p.json.status, res: p }; }
  return { cookie: h.cookie, status: h.json.status, res: h };
};
const sidOf = (from) => phone.devices().filter((d) => d.ip === from).pop()?.id;

(async () => {
  // ---------------------------------------------------------------- headers
  let info = await phone.start({ pin: '4826', approve: true, linkExpireMin: 10, idleStopMin: 30 });
  let base = baseOf(info);
  const page = await req(base, '');
  const hd = page.headers;
  check('security headers on the page', hd['referrer-policy'] === 'no-referrer' && hd['x-frame-options'] === 'DENY' && /frame-ancestors 'none'/.test(hd['content-security-policy']) && hd['cache-control'] === 'no-store' && hd['x-content-type-options'] === 'nosniff',
    `CSP: ${(hd['content-security-policy'] || '').slice(0, 50)}…`);

  // ---------------------------------------------------------------- escalating lockout
  const a = await req(base, 'api/hello', { method: 'POST', body: {}, from: '127.0.0.2' });
  let r;
  for (let i = 0; i < 5; i++) r = await req(base, 'api/pin', { method: 'POST', body: { pin: '0000' }, cookie: a.cookie, from: '127.0.0.2' });
  check('5 wrong PINs -> locked out 60 s', r.status === 403 && r.json.wait === 60);
  r = await req(base, 'api/pin', { method: 'POST', body: { pin: '4826' }, cookie: a.cookie, from: '127.0.0.2' });
  check('right PIN refused during lockout', r.status === 429);
  skew += 61000;
  for (let i = 0; i < 5; i++) r = await req(base, 'api/pin', { method: 'POST', body: { pin: '1111' }, cookie: a.cookie, from: '127.0.0.2' });
  check('next 5 wrong PINs -> locked out 5 min', r.json.wait === 300);
  skew += 301000;
  for (let i = 0; i < 5; i++) r = await req(base, 'api/pin', { method: 'POST', body: { pin: '2222' }, cookie: a.cookie, from: '127.0.0.2' });
  check('then 15 min', r.json.wait === 900);

  // ---------------------------------------------------------------- 20 wrong PINs replace the link
  // 15 so far from .2; 5 more from another device
  const b = await req(base, 'api/hello', { method: 'POST', body: {}, from: '127.0.0.3' });
  for (let i = 0; i < 5; i++) r = await req(base, 'api/pin', { method: 'POST', body: { pin: '3333' }, cookie: b.cookie, from: '127.0.0.3' });
  const alert = last('phone-alert');
  check('20 wrong PINs in total -> link replaced', alert?.kind === 'pin-rotate' && (await req(base, '')).status === 404, alert?.text.slice(0, 50));
  info = alert.info; base = baseOf(info);
  check('new link works', (await req(base, '')).status === 200);

  // ---------------------------------------------------------------- popup spam
  phone.setOptions({ pin: null });
  const p1 = await req(base, 'api/hello', { method: 'POST', body: {}, from: '127.0.0.4' });
  const p2 = await req(base, 'api/hello', { method: 'POST', body: {}, from: '127.0.0.4' });
  const p3 = await req(base, 'api/hello', { method: 'POST', body: {}, from: '127.0.0.4' });
  const prompts = events.filter(([c, d]) => c === 'phone-approve' && d.ip === '127.0.0.4').length;
  check('3rd waiting session from one address refused (429)', p1.json.status === 'pending' && p2.json.status === 'pending' && p3.status === 429);
  check('the PC is asked only once for the same phone', prompts === 1, `${prompts} prompt(s)`);
  phone.decide(sidOf('127.0.0.4'), true);
  const s1 = await req(base, 'api/state', { cookie: p1.cookie, from: '127.0.0.4' });
  const s2 = await req(base, 'api/state', { cookie: p2.cookie, from: '127.0.0.4' });
  check('one Allow covers both of its sessions', s1.status === 200 && s2.status === 200);

  // ---------------------------------------------------------------- cookie bound to the address
  const stolen = await req(base, 'api/state', { cookie: p1.cookie, from: '127.0.0.5' });
  check('cookie used from another address -> 401', stolen.status === 401);
  check('...and the PC is warned', last('phone-alert')?.kind === 'hijack');
  check('...and that session is gone for the thief and the owner', (await req(base, 'api/state', { cookie: p1.cookie, from: '127.0.0.4' })).status === 401);

  // ---------------------------------------------------------------- remote control permission
  await req(base, 'api/event', { method: 'POST', body: { mode: 'remote' }, cookie: p2.cookie, from: '127.0.0.4' });
  r = await req(base, 'api/event', { method: 'POST', body: { mode: 'remote', cmd: 'toggle' }, cookie: p2.cookie, from: '127.0.0.4' });
  check('command refused without control permission (403)', r.status === 403 && !events.some(([c]) => c === 'phone-cmd'));
  r = await req(base, 'api/request-control', { method: 'POST', body: {}, cookie: p2.cookie, from: '127.0.0.4' });
  check('phone can ask for control; PC is asked', r.json.asked === true && !!last('phone-control-request'));
  phone.setControl(sidOf('127.0.0.4'), true);
  r = await req(base, 'api/event', { method: 'POST', body: { mode: 'remote', cmd: 'toggle' }, cookie: p2.cookie, from: '127.0.0.4' });
  check('command accepted after Allow', r.status === 200 && last('phone-cmd')?.cmd === 'toggle');
  r = await req(base, 'api/event', { method: 'POST', body: { mode: 'remote', cmd: 'shutdown' }, cookie: p2.cookie, from: '127.0.0.4' });
  check('unknown command rejected (400)', r.status === 400);
  r = await req(base, 'api/event', { method: 'POST', body: JSON.stringify({ cmd: 'toggle', pad: 'x'.repeat(10000) }), cookie: p2.cookie, from: '127.0.0.4' }).catch(() => ({ status: 'cut' }));
  check('oversized request ignored', r.status === 'cut' || r.status === 200);

  // ---------------------------------------------------------------- lock
  phone.setOptions({ locked: true });
  r = await req(base, 'api/hello', { method: 'POST', body: {}, from: '127.0.0.6' });
  check('locked: new phone refused (423)', r.status === 423);
  check('locked: phone already watching continues', (await req(base, 'api/state', { cookie: p2.cookie, from: '127.0.0.4' })).status === 200);
  phone.setOptions({ locked: false });

  // ---------------------------------------------------------------- session expiry
  later(3);
  await tick();
  check('silent phone dropped after 2 min (401)', (await req(base, 'api/state', { cookie: p2.cookie, from: '127.0.0.4' })).status === 401);

  // ---------------------------------------------------------------- unanswered approval expires
  const w = await req(base, 'api/hello', { method: 'POST', body: {}, from: '127.0.0.6' });
  later(3);
  await tick();
  check('unanswered approval expires and the PC prompt closes', !sidOf('127.0.0.6') && events.some(([c, d]) => c === 'phone-approve-cancel'));

  // ---------------------------------------------------------------- unused link expires
  await phone.stop();
  info = await phone.start({ approve: false, linkExpireMin: 10, idleStopMin: 30 });
  base = baseOf(info);
  later(11);
  await tick();
  const exp = last('phone-alert');
  check('link expires if nobody joins in 10 min', exp?.kind === 'link-expired' && (await req(base, '')).status === 404);

  // ---------------------------------------------------------------- stream stops when idle
  base = baseOf(exp.info);
  const j = await join(base, '127.0.0.2');
  check('phone joins the new link', j.status === 'ok');
  later(31);
  await tick();
  check('stream stops after 30 min with no phones', last('phone-alert')?.kind === 'idle-stop' && !phone.running());

  const log = last('phone-log') || [];
  console.log('\nactivity log sample:\n  ' + log.slice(0, 8).map((e) => e.text).join('\n  '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
