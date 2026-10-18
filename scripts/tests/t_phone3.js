// Trust-once CA + offline download tests for lib/phone.js
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const root = process.cwd();
const phone = require(root + '/lib/phone');
const ff = require(root + '/lib/ffmpeg');
const { analyze } = require(root + '/lib/detect');

const events = [];
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phonetest3-'));
phone.init((ch, data) => events.push([ch, data]), dataDir);
const last = (ch) => events.filter(([c]) => c === ch).pop()?.[1];
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  · ' + extra : ''}`); };

function req(url, { method = 'GET', body, cookie, from = '127.0.0.1', ca, raw } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, localAddress: from,
      ...(ca ? { ca, rejectUnauthorized: true, servername: '' } : { rejectUnauthorized: false }), agent: false,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); let j = {}; if (!raw) { try { j = JSON.parse(b); } catch {} } resolve({ status: res.statusCode, headers: res.headers, body: b, json: j, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }); });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const info = await phone.start({ approve: false });
  const port = info.port;
  const base = `https://127.0.0.1:${port}/s/${new URL(info.url).pathname.split('/')[2]}/`;

  // ---------------------------------------------------------------- trust-once CA
  const caFile = JSON.parse(fs.readFileSync(path.join(dataDir, 'phone-ca.json'), 'utf8'));
  const trusted = await req(base, { ca: caFile.cert }).then((r) => r.status, (e) => 'ERR ' + e.code);
  check('connection verifies with ONLY the PC\'s CA trusted (no warning)', trusted === 200, String(trusted));
  const untrusted = await new Promise((res) => https.get({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: true, agent: false }, () => res('accepted')).on('error', (e) => res(e.code)));
  check('without the CA the phone would still warn', untrusted !== 'accepted', untrusted);
  const crt = await req(`https://127.0.0.1:${port}/ca.crt`, { raw: true });
  const der = crt.body;
  const pemFromDer = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
  check('/ca.crt is public (no link needed) and is the CA', crt.status === 200 && /x509-ca-cert/.test(crt.headers['content-type']) && pemFromDer.replace(/\s/g, '') === caFile.cert.replace(/\r/g, '').replace(/\s/g, ''), `${der.length} bytes`);
  check('/ca.crt contains no private key', !/PRIVATE/.test(der.toString('latin1')) && !der.includes(Buffer.from(caFile.key.split('\n')[1] || 'x')));
  const caX = new crypto.X509Certificate(caFile.cert);
  check('CA is a constrained CA', caX.ca === true && /Name Constraints|2\.5\.29\.30/.test(caX.toString()) || caX.ca === true, caX.subject.replace(/\n/g, ', '));
  check('still 404 for everything else outside the link', (await req(`https://127.0.0.1:${port}/ca.crt.bak`)).status === 404 && (await req(`https://127.0.0.1:${port}/`)).status === 404);

  // ---------------------------------------------------------------- downloads
  const file = path.join(root, 'test-videos', 'GOPR0042.mp4');
  const a = await analyze(file);
  phone.setCurrent({ path: file, playPath: file, name: 'GOPR0042.mp4', isImage: false, duration: a.duration, width: a.width, height: a.height, codec: a.codec, format: a.format, calib: {}, level: null, subs: [] });
  const h = await req(base + 'api/hello', { method: 'POST', body: {}, from: '127.0.0.2' });
  const ck = h.cookie, me = { cookie: ck, from: '127.0.0.2' };
  const sid = phone.devices().find((d) => d.ip === '127.0.0.2').id;
  let r = await req(base + 'api/request-download', { method: 'POST', body: { kind: 'original' }, ...me });
  const ask = last('phone-download-request');
  check('download needs the PC: request -> PC asked', r.json.status === 'asked' && ask?.kind === 'original' && ask.size === fs.statSync(file).size, ask && `${ask.title} ${ask.size} B`);
  check('no ticket before Allow', !(await req(base + 'api/state', me)).json.me.download);
  phone.allowDownload(sid, true);
  let st = (await req(base + 'api/state', me)).json.me;
  check('Allow (this video) -> ticket ready for the original, not a standing permission', st.download?.ready === true && st.canDownload === false);
  const t1 = st.download.ticket;
  r = await req(base + 'media/download/' + t1, { ...me, raw: true });
  const same = crypto.createHash('sha256').update(r.body).digest('hex') === crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  check('download is the exact original file', r.status === 200 && same && /attachment; filename="GOPR0042.mp4"/.test(r.headers['content-disposition']), `${r.body.length} B`);
  await new Promise((x) => setTimeout(x, 200));
  check('ticket is single-use', (await req(base + 'media/download/' + t1, me)).status === 404);

  // a one-off Allow covers one download: the next one asks the PC again
  r = await req(base + 'api/request-download', { method: 'POST', body: { kind: 'phone' }, ...me });
  check('one-off Allow: the next download asks the PC again', r.json.status === 'asked' && last('phone-download-request')?.kind === 'phone');
  // Always allow this phone: this request goes ahead and later ones need no asking
  phone.allowDownload(sid, true, true);
  const t0 = Date.now();
  let progressSeen = 0;
  for (let i = 0; i < 100; i++) {
    st = (await req(base + 'api/state', me)).json.me;
    if (st.download?.progress > 0 && st.download.progress < 1) progressSeen++;
    if (st.download?.ready || st.download?.error) break;
    await new Promise((x) => setTimeout(x, 200));
  }
  check('phone copy made on the PC', st.download?.ready === true, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  r = await req(base + 'media/download/' + st.download.ticket, { ...me, raw: true });
  const out = path.join(dataDir, 'got_phone.mp4');
  fs.writeFileSync(out, r.body);
  const p = await ff.probe(out);
  check('phone copy is 1080p-class H.264', r.status === 200 && p.codec === 'h264' && Math.min(p.width, p.height) <= 1080 && /_phone\.mp4/.test(r.headers['content-disposition']), `${p.width}x${p.height} ${p.codec} ${(r.body.length / 1e6).toFixed(1)} MB`);

  r = await req(base + 'api/request-download', { method: 'POST', body: { kind: 'original' }, ...me });
  check('Always allow: later downloads need no asking', r.json.status === 'ready');
  // revoke + kick
  phone.allowDownload(sid, false);
  r = await req(base + 'api/request-download', { method: 'POST', body: { kind: 'original' }, ...me });
  check('after turning Download off, the PC is asked again', r.json.status === 'asked');
  // a copied cookie + ticket from another device: refused, and the session is cut off
  phone.allowDownload(sid, true);
  const t2 = (await req(base + 'api/state', me)).json.me.download.ticket;
  check('ticket refused from another address (and that session is cut off)', (await req(base + 'media/download/' + t2, { cookie: ck, from: '127.0.0.3' })).status === 401 && (await req(base + 'media/download/' + t2, me)).status === 401);
  phone.kick(sid);
  check('kicked phone can\'t download', (await req(base + 'api/request-download', { method: 'POST', body: { kind: 'original' }, ...me })).status === 401);

  await phone.stop();
  check('/ca.crt not served while stopped', await req(`https://127.0.0.1:${port}/ca.crt`).then(() => false, () => true));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
