// Security + streaming test for lib/phone.js (runs in plain Node)
const https = require('https');
const os = require('os');
const path = require('path');
const fs = require('fs');
const root = process.cwd();
const phone = require(root + '/lib/phone');
const { analyze } = require(root + '/lib/detect');

const events = [];
phone.init((ch, data) => events.push([ch, data]), fs.mkdtempSync(path.join(os.tmpdir(), 'phonetest-')));
const agent = new https.Agent({ rejectUnauthorized: false });

function req(url, { method = 'GET', body, cookie, range } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, agent,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36', ...(cookie ? { Cookie: cookie } : {}), ...(range ? { Range: range } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body.toString()); } catch { return r.body.toString().slice(0, 60); } };
const check = (label, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  · ' + extra : ''}`);

(async () => {
  const info = await phone.start({ pin: '4826', approve: true, quality: 'auto' });
  const base = `https://127.0.0.1:${info.port}/s/${new URL(info.url).pathname.split('/')[2]}/`;
  check('QR code generated', info.qr.startsWith('data:image/png;base64,'), info.url.replace(/s\/.{10}.*/, 's/<secret>/'));

  check('root path is invisible (404)', (await req(`https://127.0.0.1:${info.port}/`)).status === 404);
  check('wrong token is invisible (404)', (await req(`https://127.0.0.1:${info.port}/s/abc123/`)).status === 404);
  const page = await req(base);
  check('right link serves the page', page.status === 200 && /VR180 Player/.test(page.body.toString()));
  check('no directory browsing', (await req(base + 'lib/phone.js')).status === 404 && (await req(base + '../../main.js')).status === 404);

  // phone A: correct PIN, then needs approval
  let r = await req(base + 'api/hello', { method: 'POST', body: {} });
  const cookieA = r.headers['set-cookie'][0].split(';')[0];
  check('new phone must enter the PIN', json(r).status === 'pin', `cookie flags: ${r.headers['set-cookie'][0].split(';').slice(1).join(';').trim()}`);
  check('API blocked before PIN', (await req(base + 'api/state', { cookie: cookieA })).status === 403);
  r = await req(base + 'api/pin', { method: 'POST', body: { pin: '4826' }, cookie: cookieA });
  check('correct PIN -> waits for approval', json(r).status === 'pending');
  const approval = events.find(([c]) => c === 'phone-approve');
  check('PC was asked to approve', !!approval, approval && approval[1].name);
  check('API blocked while pending', (await req(base + 'api/state', { cookie: cookieA })).status === 403);
  phone.decide(approval[1].id, true);
  r = await req(base + 'api/state', { cookie: cookieA });
  check('approved phone can use the API', r.status === 200);

  // what the PC is playing
  const file = path.join(root, 'test-videos', 'GOPR0042.mp4');
  const a = await analyze(file);
  phone.setCurrent({ path: file, playPath: file, name: 'GOPR0042.mp4', isImage: false, duration: a.duration, width: a.width, height: a.height, codec: a.codec, format: a.format, calib: {}, level: null, subs: [] });
  const st = json(await req(base + 'api/state', { cookie: cookieA }));
  check('state has the current video, direct stream', st.item?.title === 'GOPR0042.mp4' && st.item.direct === true);
  r = await req(base + 'media/direct', { cookie: cookieA, range: 'bytes=0-999' });
  check('direct stream supports seeking (206 range)', r.status === 206 && r.body.length === 1000, r.headers['content-range']);
  check('media blocked without a session', (await req(base + 'media/direct')).status === 401);

  // live re-encode (HLS) at 1080p, starting 2 s in
  phone.setOptions({ quality: '1080' });
  const st2 = json(await req(base + 'api/state', { cookie: cookieA }));
  check('1080p quality switches to re-encoding', st2.item.direct === false);
  const t0 = Date.now();
  r = await req(base + 'media/hls/start?t=2', { cookie: cookieA });
  const hls = json(r);
  check('HLS started', r.status === 200 && hls.start === 2, `first segment ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await new Promise((res) => setTimeout(res, 2500));
  const m3u8 = (await req(base + hls.url, { cookie: cookieA })).body.toString();
  const seg = m3u8.split('\n').find((l) => l.endsWith('.ts'));
  const segRes = await req(base + hls.url.replace('index.m3u8', seg), { cookie: cookieA });
  check('HLS playlist and segment served', /EXTM3U/.test(m3u8) && segRes.status === 200 && segRes.body.length > 1000, `${seg} ${(segRes.body.length / 1024).toFixed(0)} KB`);
  const devs = events.filter(([c]) => c === 'phone-devices').pop();
  check('device list reported to the PC', devs && devs[1].devices.length === 1, devs && `${devs[1].devices[0].name} · ${devs[1].stream}`);

  // phone B: wrong PIN 5 times -> locked out
  r = await req(base + 'api/hello', { method: 'POST', body: {} });
  const cookieB = r.headers['set-cookie'][0].split(';')[0];
  let last;
  for (let i = 0; i < 6; i++) last = await req(base + 'api/pin', { method: 'POST', body: { pin: '0000' }, cookie: cookieB });
  check('5 wrong PINs -> locked out', last.status === 429, JSON.stringify(json(last)));
  r = await req(base + 'api/pin', { method: 'POST', body: { pin: '4826' }, cookie: cookieB });
  check('even the right PIN is refused during lockout', r.status === 429);

  // remote commands (the PC has to allow control first)
  phone.setControl(approval[1].id, true);
  await req(base + 'api/event', { method: 'POST', body: { mode: 'remote', cmd: 'toggle' }, cookie: cookieA });
  check('remote command reaches the PC', events.some(([c, d]) => c === 'phone-cmd' && d.cmd === 'toggle'));

  // kick + new link
  phone.kick(approval[1].id);
  check('kicked phone is cut off (401)', (await req(base + 'api/state', { cookie: cookieA })).status === 401);
  const fresh = await phone.rotate();
  check('old link dead after "new link"', (await req(base)).status === 404 && fresh.url !== info.url);
  await phone.stop();
  check('stopped: nothing listening', await req(base).then(() => false, () => true));
})().catch((e) => { console.error('ERR', e); process.exit(1); });
