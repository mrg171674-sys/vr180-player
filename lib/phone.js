// Phone player: a small HTTPS server that streams the open video to phones on
// the same network. Nothing is reachable without the secret link (QR code);
// optionally a PIN and a per-device approval are required as well.
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const pki = require('./pki');
const QRCode = require('qrcode');
const ff = require('./ffmpeg');
const encoders = require('./encoders');

const PORT = 47190;
const ROOT = path.join(__dirname, '..');
// the only files the phone page may load (besides the API and the media)
const STATIC = {
  '': ['phone/index.html', 'text/html; charset=utf-8'],
  'phone.js': ['phone/phone.js', 'text/javascript'],
  'phone.css': ['phone/phone.css', 'text/css'],
  'icon.png': ['phone/icon.png', 'image/png'],
  'renderer/vrview.js': ['renderer/vrview.js', 'text/javascript'],
  'renderer/vrpanel.js': ['renderer/vrpanel.js', 'text/javascript'],
  'node_modules/three/build/three.module.js': ['node_modules/three/build/three.module.js', 'text/javascript'],
  'hls.js': ['node_modules/hls.js/dist/hls.min.js', 'text/javascript']
};
const MEDIA_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// security limits
const SESSION_TTL = 120000;          // a phone that hasn't been heard from for 2 min is dropped
const PENDING_TTL = 120000;          // unanswered PIN / approval sessions expire after 2 min
const MAX_WAITING_PER_IP = 2;        // sessions that are still entering a PIN or waiting for approval
const MAX_WAITING = 6;
const LOCKOUTS = [60, 300, 900];     // seconds, after each burst of 5 wrong PINs
const WRONG_PIN_ROTATE = 20;         // this many wrong PINs in total replaces the link
const COMMANDS = new Set(['prev', 'back', 'toggle', 'fwd', 'next', 'view', 'recenter', 'volup', 'voldown', 'look', 'play', 'seek']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP, 'Cross-Origin-Resource-Policy': 'same-origin' };

let emit = () => {};
let userData = '';
let server = null;
const st = {
  preApproved: new Map(),   // ip -> remembered device that just came through /pair
  token: null, pin: null, approve: true, quality: 'auto',
  locked: false,            // no new phones may join
  linkExpireMin: 10,        // 0 = never: the link is replaced if nobody joins within this time
  idleStopMin: 30,          // 0 = never: the stream stops after this long with no phones
  tokenAt: 0, joined: false, lastPhoneAt: 0,
  sessions: new Map(),      // sid -> session
  failures: new Map(),      // ip -> { count, level, until }
  wrongTotal: 0,
  downloads: new Map(),     // ticket -> { sid, ip, kind, file, temp, ready, progress, expires, proc }
  log: [],                  // recent activity for the PC
  current: null,            // what the PC is showing
  pc: { time: 0, paused: true, rate: 1 },
  hls: new Map(),           // id -> { id, proc, dir, start, cap, path, lastUse, encoder }
  streams: new Set(),       // open media responses: { res, kind: 'direct' | 'download' }
  ip: null,                 // the address the QR code uses (null = best guess)
  bytes: 0, rate: 0
};
const MAX_ENCODES = 2;      // NVENC on consumer cards allows a handful of sessions; keep two for phones

// ---------------------------------------------------------------- remembered devices
// "Allow & remember": the device gets a long random key, in a cookie only the /pair address
// ever sees. Opening https://<pc>:PORT/pair later (a bookmark) goes straight to the current
// link without a code, and the PC doesn't ask again. Unused for 90 days, or forgotten on
// the PC, and the key is worthless. Only a hash of it is stored here.
const TRUST_DAYS = 90;
let trusted = [];
const trustFile = () => path.join(userData, 'phone-trusted.json');
const keyHash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const trustCookie = (req) => /(?:^|;\s*)vr180d=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
function loadTrusted() {
  try { trusted = JSON.parse(fs.readFileSync(trustFile(), 'utf8')).filter((t) => t && t.hash && Date.now() - (t.used || t.at) < TRUST_DAYS * 864e5); } catch { trusted = []; }
}
function saveTrusted() { try { fs.writeFileSync(trustFile(), JSON.stringify(trusted)); } catch {} }
const trustedList = () => trusted.map((t) => ({ id: t.hash.slice(0, 16), name: t.name, at: t.at, used: t.used }));
function forgetTrusted(id) {
  const before = trusted.length;
  trusted = trusted.filter((t) => t.hash.slice(0, 16) !== id);
  if (trusted.length !== before) { saveTrusted(); log('A remembered device was forgotten'); }
  return trustedList();
}

function init(sender, dataDir) {
  emit = sender;
  userData = dataDir;
  loadTrusted();
  setInterval(() => { st.rate = st.bytes; st.bytes = 0; if (server) { sweep(); pushDevices(); } }, 1000);
}

// ---------------------------------------------------------------- pairing code
// For headsets and devices without a camera: open https://<pc>:${PORT}/pair and type the
// 6 digits shown on the PC. Like the QR code it can only be read off the PC's screen, it
// works once, changes every 10 minutes, and guessing is cut off fast (5 tries per device,
// and after 20 wrong codes in total the code changes). PIN and approval still apply.
const PAIR_TTL = 10 * 60000;
const pair = { code: null, at: 0, fails: new Map(), wrong: 0 };
function newPairCode() {
  pair.code = server ? String(crypto.randomInt(0, 1000000)).padStart(6, '0') : null;
  pair.at = Date.now();
  pair.wrong = 0;
  if (server) emit('phone-pair', { code: pair.code, url: pairUrl() });
}
const pairUrl = () => `https://${qrAddress()}:${PORT}/pair`;
const PAIR_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VR180 Player · Connect</title><link rel="icon" href="/pair-icon.png">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101010;color:#eee;font:17px system-ui,-apple-system,"Segoe UI",sans-serif}
.card{background:#1b1b1b;border:1px solid #ffffff1a;border-radius:20px;padding:30px 28px;width:min(440px,90vw);text-align:center;box-shadow:0 20px 60px #0008}
h1{font-size:24px;margin:0 0 6px}p{color:#bbb;margin:0 0 20px;line-height:1.45}
input{font:600 40px ui-monospace,Consolas,monospace;letter-spacing:8px;text-align:center;width:100%;box-sizing:border-box;padding:14px 8px;border-radius:14px;border:1px solid #ffffff33;background:#0b0b0b;color:#fff;outline:none}
input:focus{border-color:#3c9a62}button{margin-top:16px;width:100%;padding:16px;border:0;border-radius:14px;background:#3c9a62;color:#fff;font:600 20px system-ui,sans-serif;cursor:pointer}
button:disabled{opacity:.6}.msg{min-height:24px;margin-top:14px;color:#ff8a80}</style></head>
<body><main class="card"><h1>Connect to VR180 Player</h1><p>Type the 6-digit code shown on the PC<br>(Phone tab → Headset or no camera?)</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000 000" aria-label="Pairing code">
<button id="go">Connect</button><div class="msg" id="msg" role="alert"></div></main><script src="/pair.js"></script></body></html>`;
const PAIR_JS = `const code=document.getElementById('code'),msg=document.getElementById('msg'),go=document.getElementById('go');
code.focus();
code.addEventListener('input',()=>{const d=code.value.replace(/\\D/g,'').slice(0,6);code.value=d.length>3?d.slice(0,3)+' '+d.slice(3):d;msg.textContent='';});
async function send(){const v=code.value.replace(/\\D/g,'');if(v.length!==6){msg.textContent='The code has 6 digits.';return;}
go.disabled=true;try{const r=await fetch('/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:v})});const d=await r.json().catch(()=>({}));
if(r.ok&&d.url){go.textContent='Connecting…';location.replace(d.url);return;}
msg.textContent=r.status===429?'Too many tries. Wait '+d.wait+' seconds.':r.status===423?'The PC has locked the stream.':'That code is not right'+(d.left!=null?' · '+d.left+' tries left':'')+'.';}
catch{msg.textContent='Could not reach the PC.';}go.disabled=false;}
go.onclick=send;code.addEventListener('keydown',(e)=>{if(e.key==='Enter')send();});`;

async function pairPost(req, res, ip) {
  const now = Date.now();
  const f = pair.fails.get(ip) || { n: 0, until: 0 };
  if (now < f.until) return send(res, 429, { wait: Math.ceil((f.until - now) / 1000) });
  if (st.locked) return send(res, 423, {});
  const body = await readBody(req);
  const code = String(body.code || '').replace(/\D/g, '');
  if (pair.code && code.length === 6 && safeEqual(code, pair.code)) {
    pair.fails.delete(ip);
    log(`A device (${ip}) used the pairing code`);
    newPairCode();   // single use
    return send(res, 200, { url: `/s/${st.token}/` });
  }
  f.n++;
  if (f.n >= 5) f.until = now + 60000 * Math.min(30, 2 ** (f.n - 5));
  pair.fails.set(ip, f);
  pair.wrong++;
  if (pair.wrong >= 20) { log('20 wrong pairing codes: the code was changed', 'warn'); newPairCode(); }
  return send(res, 403, { left: Math.max(0, 5 - f.n) });
}

function log(text, kind = 'info') {
  st.log.unshift({ at: Date.now(), text, kind });
  st.log.length = Math.min(st.log.length, 40);
  emit('phone-log', st.log);
}

// expire quiet sessions and apply the auto-stop timers
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    if (pair.code && now - pair.at > PAIR_TTL) newPairCode();
    for (const s of [...st.sessions.values()]) {
      const waiting = s.status === 'pin' || s.status === 'pending';
      if (waiting && now - s.connectedAt > PENDING_TTL) { dropSession(s); log(`${s.name} (${s.ip}) gave up or timed out`); }
      else if (!waiting && now - s.lastSeen > SESSION_TTL) { dropSession(s); if (s.status === 'ok') log(`${s.name} left`); }
    }
    if ([...st.sessions.values()].some((s) => s.status === 'ok' && now - s.lastSeen < 8000)) st.lastPhoneAt = now;
    for (const [id, d] of st.downloads) if (now > d.expires) { dropDownload(id); log('An unused download link expired'); }
    for (const h of [...st.hls.values()]) if (now - h.lastUse > 60000) stopHls(h.id);
    if (st.linkExpireMin && !st.joined && now - st.tokenAt > st.linkExpireMin * 60000) {
      await rotate(true);
      log(`Nobody joined within ${st.linkExpireMin} min, so the link was replaced`, 'warn');
      emit('phone-alert', { kind: 'link-expired', text: 'The phone link expired because nobody used it. Scan the new QR code.', info: await info() });
    } else if (st.idleStopMin && now - st.lastPhoneAt > st.idleStopMin * 60000) {
      await stop();
      log(`No phones for ${st.idleStopMin} min, so the stream was stopped`, 'warn');
      emit('phone-alert', { kind: 'idle-stop', text: `The phone stream stopped after ${st.idleStopMin} minutes with no phones.`, info: { running: false } });
    }
  } finally { sweeping = false; }
}
function dropSession(s) {
  st.sessions.delete(s.id);
  for (const [id, d] of st.downloads) if (d.sid === s.id) dropDownload(id);
  if (s.downloadAsked) emit('phone-download-cancel', { id: s.id });
  if (s.status === 'pending') emit('phone-approve-cancel', { id: s.id });
  if (s.controlAsked) emit('phone-control-cancel', { id: s.id });
}

// ---------------------------------------------------------------- certificate
// This PC's own certificate authority, made once. Phones that install it never see
// the "not private" warning again (see lib/pki.js for why it's safe to trust).
function authority() {
  const file = path.join(userData, 'phone-ca.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const ca = pki.createCA();
  fs.writeFileSync(file, JSON.stringify(ca));
  return ca;
}
// The server certificate, signed by the authority; re-issued when the network
// address changes or it gets close to expiring. The authority stays the same.
function certificate() {
  const ca = authority();
  const caFp = pki.fingerprint(ca.cert);
  const ips = lanAddresses();
  const file = path.join(userData, 'phone-cert.json');
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.ca === caFp && c.expires > Date.now() + 30 * 86400000 && ips.every((ip) => c.ips.includes(ip))) return { ...c, chain: c.cert + ca.cert };
  } catch {}
  const leaf = pki.issueServer(ca, ['127.0.0.1', ...ips]);
  const c = { key: leaf.key, cert: leaf.cert, expires: leaf.expires, ips, ca: caFp };
  fs.writeFileSync(file, JSON.stringify(c));
  return { ...c, chain: c.cert + ca.cert };
}
const caInfo = () => { const ca = authority(); return { der: pki.toDer(ca.cert), fingerprint: pki.fingerprint(ca.cert) }; };

function adapters() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      let score = 0;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) score += 10;
      if (/^169\.254\./.test(a.address)) score -= 30;
      if (/wi-?fi|wlan|wireless|ethernet|lan/i.test(name)) score += 5;
      if (/vethernet|virtualbox|vmware|hyper-v|wsl|loopback|bluetooth|tap|vpn|tailscale|zerotier|npcap|docker|nordlynx|wireguard/i.test(name)) score -= 20;
      if (/^192\.168\.56\./.test(a.address)) score -= 15; // VirtualBox host-only
      out.push({ name, address: a.address, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}
function lanAddresses() { return adapters().map((a) => a.address); }
const qrAddress = () => (st.ip && lanAddresses().includes(st.ip) ? st.ip : lanAddresses()[0]) || '127.0.0.1';

// ---------------------------------------------------------------- start / stop
async function start(opts = {}) {
  if (server) await stop();
  st.token = crypto.randomBytes(32).toString('base64url');
  st.pin = opts.pin ? String(opts.pin) : null;
  st.approve = opts.approve !== false;
  st.quality = opts.quality || 'auto';
  st.locked = !!opts.locked;
  if ('linkExpireMin' in opts) st.linkExpireMin = +opts.linkExpireMin || 0;
  if ('idleStopMin' in opts) st.idleStopMin = +opts.idleStopMin || 0;
  st.tokenAt = st.lastPhoneAt = Date.now();
  st.joined = false;
  st.sessions.clear();
  st.failures.clear();
  st.wrongTotal = 0;
  st.log = [];
  const cert = certificate();
  server = https.createServer({ key: cert.key, cert: cert.chain }, handle);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '0.0.0.0', resolve); });
  pair.fails.clear();
  newPairCode();
  log('Stream started');
  return info();
}
function cleanupSync() {
  for (const h of st.hls.values()) { try { h.proc.kill(); } catch {} try { fs.rmSync(h.dir, { recursive: true, force: true }); } catch {} }
  st.hls.clear();
  for (const d of st.downloads.values()) if (d.temp) { try { fs.rmSync(d.temp, { recursive: true, force: true }); } catch {} }
  st.downloads.clear();
}
async function stop() {
  stopHls();
  for (const x of st.streams) try { x.res.destroy(); } catch {}
  st.streams.clear();
  if (server) { const s = server; server = null; s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
  st.token = null;
  pair.code = null;
  for (const s of [...st.sessions.values()]) dropSession(s);
  pushDevices();
}
// new link: everyone currently connected is thrown out
async function rotate(quiet) {
  st.token = crypto.randomBytes(32).toString('base64url');
  st.tokenAt = Date.now();
  st.joined = false;
  st.wrongTotal = 0;
  st.failures.clear();
  for (const s of [...st.sessions.values()]) dropSession(s);
  stopHls();
  pushDevices();
  newPairCode();
  if (!quiet) log('New link made; everyone was disconnected');
  return info();
}
function setOptions(o) {
  if ('pin' in o) st.pin = o.pin ? String(o.pin) : null;
  if ('approve' in o) st.approve = !!o.approve;
  if ('quality' in o) { st.quality = o.quality; stopHls(); }
  if ('locked' in o && !!o.locked !== st.locked) { st.locked = !!o.locked; log(st.locked ? 'Stream locked: no new phones can join' : 'Stream unlocked'); }
  if ('linkExpireMin' in o) { st.linkExpireMin = +o.linkExpireMin || 0; st.tokenAt = Date.now(); }
  if ('idleStopMin' in o) { st.idleStopMin = +o.idleStopMin || 0; st.lastPhoneAt = Date.now(); }
  if ('ip' in o) st.ip = o.ip || null;
  return info();
}

async function info() {
  if (!server) return { running: false };
  const ip = qrAddress();
  const url = `https://${ip}:${PORT}/s/${st.token}/`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 560, color: { dark: '#111111', light: '#ffffff' }, errorCorrectionLevel: 'M' });
  const caUrl = `https://${ip}:${PORT}/ca.crt`;
  const caQr = await QRCode.toDataURL(caUrl, { margin: 1, width: 360, color: { dark: '#111111', light: '#ffffff' }, errorCorrectionLevel: 'M' });
  return { running: true, url, qr, addresses: lanAddresses(), adapters: adapters(), ip, port: PORT, pin: !!st.pin, approve: st.approve, quality: st.quality,
    caUrl, caQr, caFingerprint: caInfo().fingerprint, pairCode: pair.code, pairUrl: pairUrl(),
    locked: st.locked, linkExpireMin: st.linkExpireMin, idleStopMin: st.idleStopMin, joined: st.joined, log: st.log };
}

// ---------------------------------------------------------------- what the PC is playing
function setCurrent(item) {
  const changed = st.current?.path !== item?.path;
  if (changed) {
    stopHls();
    // phones lose the old file straight away (and everything, when the vault locks)
    for (const x of [...st.streams]) if (x.kind === 'direct' || !item) { try { x.res.destroy(); } catch {} st.streams.delete(x); }
    if (!item) for (const id of [...st.downloads.keys()]) dropDownload(id);
  }
  // the version only changes when a different file is opened (phones reload then)
  st.current = item ? { ...item, version: changed ? Date.now() : st.current.version } : null;
}
function setPcState(pc) { st.pc = { ...pc, at: Date.now() }; }

// ---------------------------------------------------------------- devices
function deviceName(ua = '') {
  // standalone headsets first: their browsers also say "Android"
  if (/OculusBrowser|Quest/.test(ua)) return `${/Quest 3S/.test(ua) ? 'Quest 3S' : /Quest 3/.test(ua) ? 'Quest 3' : /Quest Pro/.test(ua) ? 'Quest Pro' : /Quest 2/.test(ua) ? 'Quest 2' : 'Meta Quest'} · headset`;
  if (/Pico/i.test(ua)) return 'Pico · headset';
  if (/VisionOS|Apple Vision/i.test(ua)) return 'Apple Vision Pro · headset';
  let dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : null;
  if (!dev && /Android/.test(ua)) {
    const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
    dev = m && !/^K$/.test(m[1].trim()) ? m[1].trim() : 'Android phone';
  }
  if (!dev) dev = /Windows/.test(ua) ? 'Windows PC' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  return `${dev} · ${browser}`;
}
function devices() {
  return [...st.sessions.values()].filter((s) => s.status !== 'denied').map((s) => ({
    id: s.id, name: s.name, ip: s.ip, status: s.status, mode: s.mode, position: s.position, connectedAt: s.connectedAt, online: Date.now() - s.lastSeen < 8000,
    canControl: !!s.canControl, canDownload: !!s.canDownload
  }));
}
function pushDevices() {
  const h = [...st.hls.values()].sort((a, b) => b.lastUse - a.lastUse)[0];
  emit('phone-devices', { devices: devices(), rate: st.rate, stream: h ? `Re-encoding to ${h.label} (${h.encoder})${st.hls.size > 1 ? ` · ${st.hls.size} streams` : ''}` : null });
}
function kick(id) {
  const s = st.sessions.get(id);
  if (!s) return;
  dropSession(s);
  log(`Removed ${s.name} (${s.ip})`);
  pushDevices();
}
// one answer covers every waiting session from the same phone (same address and browser)
function decide(id, allow, remember = false) {
  const s = st.sessions.get(id);
  if (!s) return;
  if (allow && remember) {
    const key = crypto.randomBytes(32).toString('base64url');
    trusted.push({ hash: keyHash(key), name: s.name, at: Date.now(), used: Date.now() });
    saveTrusted();
    s.trustKey = key;     // handed to the phone with its next update, as a cookie for /pair
    s.trusted = true;
    log(`${s.name} will be remembered`, 'ok');
  }
  for (const o of st.sessions.values()) {
    if (o.status !== 'pending' || (o.id !== id && (o.ip !== s.ip || o.name !== s.name))) continue;
    o.status = allow ? 'ok' : 'denied';
    emit('phone-approve-cancel', { id: o.id });
  }
  if (allow) st.joined = true;
  log(`${allow ? 'Allowed' : 'Denied'} ${s.name} (${s.ip})`, allow ? 'ok' : 'warn');
  pushDevices();
}
// whether a phone may control playback on the PC (Remote mode)
function setControl(id, allow) {
  const s = st.sessions.get(id);
  if (!s) return;
  s.canControl = !!allow;
  if (s.controlAsked) emit('phone-control-cancel', { id: s.id });
  s.controlAsked = false;
  log(`${s.name} ${allow ? 'can now control' : 'can no longer control'} the PC`, allow ? 'ok' : 'info');
  pushDevices();
}

// ---------------------------------------------------------------- HTTP
function send(res, code, body, type = 'application/json', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(data);
}
const notFound = (res) => send(res, 404, 'Not found', 'text/plain');

// requests from the phone page are tiny; anything bigger is cut off
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4096) { resolve({}); req.destroy(); } });
    req.on('end', () => { try { const v = JSON.parse(b || '{}'); resolve(v && typeof v === 'object' ? v : {}); } catch { resolve({}); } });
  });
}
const cookieSid = (req) => /(?:^|;\s*)vr180s=([\w-]+)/.exec(req.headers.cookie || '')?.[1];

async function handle(req, res) {
  const url = new URL(req.url, 'https://x');
  const parts = url.pathname.split('/');
  // the only public path: this PC's certificate authority, so phones can trust it once
  if (req.method === 'GET' && url.pathname === '/ca.crt') {
    return send(res, 200, caInfo().der, 'application/x-x509-ca-cert', { 'Content-Disposition': 'attachment; filename="VR180-Player-PC.crt"' });
  }
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  // pairing with a short code (headsets): the page, its script and the check
  if (url.pathname === '/pair' && pair.code) {
    if (req.method === 'GET') {
      const k = trustCookie(req);
      const t = k && trusted.find((x) => safeEqual(x.hash, keyHash(k)));
      if (t && !st.locked) {
        t.used = Date.now();
        saveTrusted();
        st.preApproved.set(ip, { name: t.name, until: Date.now() + 60000 });
        log(`${t.name} (${ip}) reconnected as a remembered device`, 'ok');
        res.writeHead(302, { ...SECURITY_HEADERS, Location: `/s/${st.token}/` });
        return res.end();
      }
      return send(res, 200, PAIR_PAGE, 'text/html; charset=utf-8');
    }
    if (req.method === 'POST') return pairPost(req, res, ip);
  }
  if (req.method === 'GET' && url.pathname === '/pair.js' && pair.code) return send(res, 200, PAIR_JS, 'text/javascript');
  if (req.method === 'GET' && url.pathname === '/pair-icon.png' && pair.code) return send(res, 200, fs.readFileSync(path.join(ROOT, 'phone/icon.png')), 'image/png');
  // /s/<token>/<rest...>; anything else is invisible
  if (parts[1] !== 's' || !st.token || !safeEqual(parts[2] || '', st.token)) return notFound(res);
  const rest = parts.slice(3).join('/');

  if (req.method === 'GET' && rest in STATIC) {
    const [file, type] = STATIC[rest];
    return send(res, 200, fs.readFileSync(path.join(ROOT, file)), type);
  }
  if (rest === 'api/hello' && req.method === 'POST') return hello(req, res, ip);
  if (rest === 'api/pin' && req.method === 'POST') return pin(req, res, ip);

  // anything that isn't the API or media simply doesn't exist
  if (!rest.startsWith('api/') && !rest.startsWith('media/')) return notFound(res);
  // everything below needs an approved session
  const s = session(req, ip);
  if (!s) return send(res, 401, { error: 'not-connected' });
  if (s.status !== 'ok') return send(res, 403, { error: s.status });
  s.lastSeen = Date.now();

  if (rest === 'api/state') {
    const extra = {};
    if (s.trustKey) { extra['Set-Cookie'] = `vr180d=${s.trustKey}; Path=/pair; Max-Age=${TRUST_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`; s.trustKey = null; }
    return send(res, 200, stateFor(s), 'application/json', extra);
  }
  if (rest === 'api/event' && req.method === 'POST') {
    const e = await readBody(req);
    if (e.mode) s.mode = e.mode === 'remote' ? 'remote' : 'watch';
    if (typeof e.position === 'number' && isFinite(e.position)) s.position = e.position;
    // only known commands, and only from a phone the PC allowed to control it
    if (e.cmd && s.mode === 'remote') {
      if (!s.canControl) return send(res, 403, { error: 'no-control' });
      if (!COMMANDS.has(e.cmd)) return send(res, 400, { error: 'unknown-command' });
      let value;
      if (e.cmd === 'look' && e.value) value = { dx: clamp(+e.value.dx), dy: clamp(+e.value.dy) };
      // play: only an entry the PC offered as "up next"; seek: a time within the video
      if (e.cmd === 'play') { if (!(st.current?.upNext || []).some((u) => u.i === e.value)) return send(res, 400, { error: 'not-offered' }); value = e.value; }
      if (e.cmd === 'seek') { const t = +e.value; if (!isFinite(t) || t < 0 || t > (st.current?.duration || 0)) return send(res, 400, { error: 'bad-time' }); value = t; }
      emit('phone-cmd', { cmd: e.cmd, value, from: s.name });
    }
    return send(res, 200, { ok: true });
  }
  if (rest === 'api/request-download' && req.method === 'POST') {
    const { kind } = await readBody(req);
    if (!st.current || st.current.isImage) return send(res, 409, { error: 'nothing-to-download' });
    const k = kind === 'phone' ? 'phone' : 'original';
    if (s.canDownload) return send(res, 200, { status: 'ready', ticket: issueDownload(s, k, st.current) });
    if (!s.downloadAsked) {
      // remember exactly which video was asked for; Allow only ever delivers that one
      s.downloadAsked = k;
      s.downloadFor = { path: st.current.path, name: st.current.name, item: st.current };
      emit('phone-download-request', { id: s.id, name: s.name, ip: s.ip, kind: k, title: st.current.name, size: k === 'original' ? fileSize(st.current.path) : phoneSizeEstimate(st.current) });
      log(`${s.name} asked to download ${st.current.name} (${k === 'phone' ? 'phone size' : 'original'})`);
    }
    return send(res, 200, { status: 'asked' });
  }
  { const dm = /^media\/download\/([\w-]+)$/.exec(rest); if (dm) return serveDownload(req, res, s, dm[1]); }
  if (rest === 'api/request-control' && req.method === 'POST') {
    if (!s.canControl && !s.controlAsked) {
      s.controlAsked = true;
      emit('phone-control-request', { id: s.id, name: s.name, ip: s.ip });
      log(`${s.name} asked to control the PC`);
    }
    return send(res, 200, { canControl: !!s.canControl, asked: !!s.controlAsked });
  }
  if (rest === 'media/direct') return serveFile(req, res, st.current?.playPath);
  if (rest === 'media/photo') return serveFile(req, res, st.current?.isImage ? st.current.path : null);
  if (rest === 'media/photo-right') return serveFile(req, res, st.current?.isImage ? st.current.rightEye : null);
  if (rest === 'media/hls/start') return hlsStart(res, +url.searchParams.get('t') || 0, url.searchParams.get('cap'), s);
  const hm = /^media\/hls\/(\w+)\/(index\.m3u8|seg\d+\.ts)$/.exec(rest);
  if (hm) return hlsFile(res, hm[1], hm[2]);
  return notFound(res);
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const clamp = (v) => (isFinite(v) ? Math.max(-2000, Math.min(2000, v)) : 0);

// The session for this request. A session only works from the address it joined
// from, so a copied cookie is useless on another device.
function session(req, ip) {
  const s = st.sessions.get(cookieSid(req));
  if (!s) return null;
  if (s.ip !== ip) {
    dropSession(s);
    log(`${s.name}'s connection was used from another address (${ip}); it was cut off`, 'warn');
    emit('phone-alert', { kind: 'hijack', text: `Someone at ${ip} tried to use ${s.name}'s connection. It was cut off.` });
    pushDevices();
    return null;
  }
  return s;
}

// a new phone either needs the PIN, approval, or neither; ask the PC once per phone
function askPc(s) {
  const pre = st.preApproved.get(s.ip);
  if (pre && Date.now() < pre.until) {
    st.preApproved.delete(s.ip);
    s.status = 'ok';
    s.trusted = true;
    if (pre.name) s.name = pre.name;
    st.joined = true;
    log(`${s.name} (${s.ip}) joined (remembered device)`, 'ok');
    return;
  }
  s.status = st.approve ? 'pending' : 'ok';
  if (s.status === 'ok') { st.joined = true; log(`${s.name} (${s.ip}) joined`, 'ok'); return; }
  const already = [...st.sessions.values()].some((o) => o !== s && o.status === 'pending' && o.ip === s.ip && o.name === s.name);
  if (!already) emit('phone-approve', { id: s.id, name: s.name, ip: s.ip });
  log(`${s.name} (${s.ip}) is waiting for approval`);
}

async function hello(req, res, ip) {
  const body = await readBody(req);
  let s = session(req, ip);
  if (!s) {
    if (st.locked) { log(`Refused a phone at ${ip}: the stream is locked`, 'warn'); return send(res, 423, { status: 'locked' }); }
    const waiting = [...st.sessions.values()].filter((o) => o.status === 'pin' || o.status === 'pending');
    if (waiting.filter((o) => o.ip === ip).length >= MAX_WAITING_PER_IP || waiting.length >= MAX_WAITING) return send(res, 429, { status: 'busy' });
    s = { id: crypto.randomBytes(18).toString('base64url'), name: deviceName(req.headers['user-agent']), ip, connectedAt: Date.now(), lastSeen: Date.now(),
      mode: 'watch', position: 0, status: 'pin', canControl: false, itemVersion: -1 };
    if (body.name) s.name = String(body.name).replace(/[^\w ·.'-]/g, '').slice(0, 40) || s.name;
    // what this phone's browser can decode, so the original file can go straight through
    if (body.caps && typeof body.caps === 'object') s.caps = { hevc: !!body.caps.hevc, h264: body.caps.h264 !== false };
    st.sessions.set(s.id, s);
    if (st.pin) log(`${s.name} (${ip}) opened the link`);
    else askPc(s);
    pushDevices();
  }
  s.lastSeen = Date.now();
  if (st.locked && s.status !== 'ok') return send(res, 423, { status: 'locked' });
  const cookie = `vr180s=${s.id}; Path=/s/${st.token}/; HttpOnly; Secure; SameSite=Strict`;
  send(res, 200, { status: s.status, name: s.name }, 'application/json', { 'Set-Cookie': cookie });
}

async function pin(req, res, ip) {
  const s = session(req, ip);
  if (!s) return send(res, 401, { error: 'not-connected' });
  if (s.status !== 'pin') return send(res, 200, { status: s.status });
  if (st.locked) return send(res, 423, { status: 'locked' });
  const f = st.failures.get(ip) || { count: 0, level: 0, until: 0 };
  if (Date.now() < f.until) return send(res, 429, { error: 'locked', wait: Math.ceil((f.until - Date.now()) / 1000) });
  const body = await readBody(req);
  if (!st.pin || safeEqual(String(body.pin || ''), st.pin)) {
    st.failures.delete(ip);
    askPc(s);
    pushDevices();
    return send(res, 200, { status: s.status });
  }
  // wrong: lock this address out for longer each time, and replace the link if someone keeps guessing
  f.count++;
  st.wrongTotal++;
  let wait = 0;
  if (f.count >= 5) {
    wait = LOCKOUTS[Math.min(f.level, LOCKOUTS.length - 1)];
    f.until = Date.now() + wait * 1000;
    f.level++;
    f.count = 0;
    log(`5 wrong PINs from ${ip}; locked out for ${wait >= 60 ? wait / 60 + ' min' : wait + ' s'}`, 'warn');
  }
  st.failures.set(ip, f);
  if (st.wrongTotal >= WRONG_PIN_ROTATE) {
    await rotate(true);
    log(`${WRONG_PIN_ROTATE} wrong PINs: the link was replaced`, 'warn');
    emit('phone-alert', { kind: 'pin-rotate', text: 'Someone kept guessing your PIN, so the link was changed. Phones need to scan the new QR code.', info: await info() });
    return send(res, 401, { error: 'not-connected' });
  }
  send(res, 403, { error: 'wrong-pin', left: wait ? 0 : 5 - f.count, wait });
}

function stateFor(s) {
  const c = st.current;
  const dl = [...st.downloads.entries()].filter(([, d]) => d.sid === s.id).pop();
  const me = { trusted: !!s.trusted, canControl: !!s.canControl, controlAsked: !!s.controlAsked, locked: st.locked, canDownload: !!s.canDownload, downloadAsked: s.downloadAsked || null,
    download: dl ? { ticket: dl[0], kind: dl[1].kind, ready: dl[1].ready, progress: dl[1].progress, error: dl[1].error || null } : null };
  if (!c) return { item: null, pc: st.pc, me };
  const direct = !c.isImage && canDirect(c, s);
  return {
    item: {
      title: c.name, isImage: c.isImage, duration: c.duration, format: c.format, calib: c.calib, level: c.level, subs: c.subs, chapters: c.chapters || [],
      width: c.width, height: c.height, codec: c.codec, hasRight: !!c.rightEye,
      direct, version: c.version,
      resume: c.resume || null,
      size: c.isImage ? 0 : fileSize(c.path), phoneSize: c.isImage ? 0 : phoneSizeEstimate(c)
    },
    pc: { ...st.pc, age: Date.now() - (st.pc.at || 0) },
    // what's next on the PC, only for phones allowed to control it
    upNext: s.canControl ? (c.upNext || []) : [],
    me
  };
}

// The phone gets the original file when it can surely decode it: H.264 within 4096 px,
// or HEVC within 4096 px on phones that say they play HEVC (most iPhones, many Androids)
function canDirect(c, s) {
  if (st.quality !== 'auto' && st.quality !== 'original') return false;
  if (st.quality === 'original') return true;
  const fits = c.width <= 4096 && c.height <= 4096;
  if (/h264/i.test(c.codec)) return fits;
  if (/hevc|h265/i.test(c.codec)) return fits && !!s?.caps?.hevc;
  return false;
}

function serveFile(req, res, file, extraHeaders = {}) {
  if (!file) return notFound(res);
  let stat;
  try { stat = fs.statSync(file); } catch { return notFound(res); }
  const type = MEDIA_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  let start = 0, end = stat.size - 1, code = 200;
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...SECURITY_HEADERS, ...extraHeaders };
  if (range) {
    if (range[1]) start = +range[1];
    if (range[2]) end = Math.min(+range[2], stat.size - 1);
    if (!range[1] && range[2]) { start = stat.size - +range[2]; end = stat.size - 1; }
    code = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  const stream = fs.createReadStream(file, { start, end });
  stream.on('data', (c) => (st.bytes += c.length));
  stream.pipe(res);
  // tracked, so the stream can be cut off when the PC moves on or the vault locks
  const entry = { res, kind: extraHeaders['Content-Disposition'] ? 'download' : 'direct' };
  st.streams.add(entry);
  const done = () => { stream.destroy(); st.streams.delete(entry); };
  req.on('close', done);
  res.on('close', done);
}

// ---------------------------------------------------------------- live re-encoding (HLS)
// long side / short side limits; phones decode H.264 up to 4096 px wide
const CAPS = { auto: [4096, 2160, '4K'], '4k': [4096, 2160, '4K'], '1080': [2160, 1080, '1080p'] };
function stopHls(id) {
  for (const h of [...st.hls.values()]) {
    if (id && h.id !== id) continue;
    try { h.proc.kill(); } catch {}
    st.hls.delete(h.id);
    const dir = h.dir;
    setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 2000);
  }
}
async function hlsStart(res, t, capQuery) {
  const c = st.current;
  if (!c || c.isImage) return notFound(res);
  const [long, short, label] = CAPS[capQuery] || CAPS[st.quality] || CAPS.auto;
  // reuse an encode of this file that already covers this time (several phones can share one)
  let h = [...st.hls.values()].find((x) => x.path === c.path && x.long === long && t >= x.start && t < x.start + encodedSeconds(x) + 8);
  if (!h) {
    // at most two encodes at once: the one nobody used for longest makes room
    while (st.hls.size >= MAX_ENCODES) stopHls([...st.hls.values()].sort((a, b) => a.lastUse - b.lastUse)[0].id);
    const id = crypto.randomBytes(6).toString('hex');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-phone-'));
    // fit within long x short (keeping the shape), never upscale, even sizes for the encoder
    const scale = `scale='min(iw,${long})':'min(ih,${short})':force_original_aspect_ratio=decrease,scale='trunc(iw/2)*2':'trunc(ih/2)*2'`;
    const outW = Math.min(c.width, long);
    // always H.264 in the HLS stream (HEVC in TS segments doesn't play on phones)
    const v = await encoders.videoArgs({ codec: 'h264', crf: 23, mode: outW <= 4096 ? 'auto' : 'cpu', width: Math.min(outW, 4096), maxrate: long >= 4096 ? 40 : 12, preset: 'veryfast' });
    const args = ['-v', 'error', '-y', '-readrate', '4', ...(t > 0 ? ['-ss', t.toFixed(2)] : []), '-i', c.playPath, '-map', '0:v:0', '-map', '0:a:0?', '-vf', scale,
      ...v.args, '-g', '48', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_filename', path.join(dir, 'seg%05d.ts'), path.join(dir, 'index.m3u8')];
    const proc = spawn(ff.ffmpegPath, args, { windowsHide: true });
    proc.on('error', () => {});
    h = { id, proc, dir, start: t, long, label, path: c.path, encoder: v.gpu ? 'GPU' : 'CPU', lastUse: Date.now() };
    st.hls.set(id, h);
    pushDevices();
  }
  h.lastUse = Date.now();
  // wait (up to 20 s) for the first segment so the phone can start straight away
  const until = Date.now() + 20000;
  while (Date.now() < until && !fs.existsSync(path.join(h.dir, 'seg00001.ts')) && h.proc.exitCode == null) await new Promise((r) => setTimeout(r, 200));
  send(res, 200, { url: `media/hls/${h.id}/index.m3u8`, start: h.start });
}
function encodedSeconds(h) {
  try { return fs.readdirSync(h.dir).filter((f) => f.endsWith('.ts')).length * 4; } catch { return 0; }
}
function hlsFile(res, id, name) {
  const h = st.hls.get(id);
  if (!h) return notFound(res);
  h.lastUse = Date.now();
  const file = path.join(h.dir, name);
  if (!fs.existsSync(file)) return notFound(res);
  const data = fs.readFileSync(file);
  st.bytes += data.length;
  send(res, 200, data, name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
}

// ---------------------------------------------------------------- offline downloads
// A phone the PC allowed gets a single-use ticket, tied to its session and address,
// valid for 10 minutes. "Phone size" is a 1080p H.264 copy made on the fly.
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
// ~8.5 Mbit/s + audio, never more than the original (it may already be small)
const phoneSizeEstimate = (c) => Math.min(Math.round((c.duration || 0) * 1.1e6), fileSize(c.path) || Infinity);

// always = the device row's standing "Download" permission; otherwise just this one request
function allowDownload(id, allow, always = false) {
  const s = st.sessions.get(id);
  if (!s) return;
  if (always || !allow) s.canDownload = !!allow && always;
  const asked = s.downloadAsked, wanted = s.downloadFor;
  if (asked) emit('phone-download-cancel', { id: s.id });
  s.downloadAsked = null;
  s.downloadFor = null;
  if (allow && asked) {
    // only ever the video the phone asked for, even if the PC has moved on since
    if (wanted?.item && fs.existsSync(wanted.path)) issueDownload(s, asked, wanted.item);
    else log(`${s.name}'s download couldn't start: that video isn't available any more`, 'warn');
  }
  if (always || !allow) log(`${s.name} ${allow ? 'may download videos' : 'may no longer download videos'}`, allow ? 'ok' : 'info');
  pushDevices();
}

function issueDownload(s, kind, c = st.current) {
  for (const [id, d] of st.downloads) if (d.sid === s.id) dropDownload(id);
  const id = crypto.randomBytes(24).toString('base64url');
  // the 10 minutes start once the file is ready (a phone copy can take a while to make)
  const d = { sid: s.id, ip: s.ip, kind, name: c.name, expires: kind === 'original' ? Date.now() + 10 * 60000 : Infinity, ready: kind === 'original', progress: kind === 'original' ? 1 : 0, file: kind === 'original' ? c.path : null };
  st.downloads.set(id, d);
  if (kind === 'phone') makePhoneCopy(d, c);
  log(`Download ready for ${s.name}: ${c.name} (${kind === 'phone' ? 'phone size' : 'original'})`);
  return id;
}

async function makePhoneCopy(d, c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr180-dl-'));
  d.temp = dir;
  const out = path.join(dir, 'phone.mp4');
  const cap = 1080;
  const scale = `scale='if(gte(iw,ih),-2,min(${cap},iw))':'if(gte(iw,ih),min(${cap},ih),-2)'`;
  try {
    const v = await encoders.videoArgs({ codec: 'h264', crf: 23, mode: 'auto', width: Math.min(c.width, cap * 2), maxrate: 12, preset: 'fast' });
    await ff.run(['-v', 'error', '-y', '-i', c.playPath, '-map', '0:v:0', '-map', '0:a:0?', '-vf', scale, ...v.args,
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out],
    { id: 'dl-' + d.sid, duration: c.duration, onProgress: (p) => (d.progress = p.fraction) });
    if (!st.downloads.has(ticketOf(d))) return fs.rm(dir, { recursive: true, force: true }, () => {});
    d.file = out;
    d.ready = true;
    d.progress = 1;
    d.expires = Date.now() + 10 * 60000;
  } catch (e) {
    d.error = 'The PC could not make the phone copy.';
  }
}
const ticketOf = (d) => [...st.downloads.entries()].find(([, x]) => x === d)?.[0];

function dropDownload(id) {
  const d = st.downloads.get(id);
  if (!d) return;
  st.downloads.delete(id);
  ff.cancel?.('dl-' + d.sid);
  if (d.temp) setTimeout(() => fs.rm(d.temp, { recursive: true, force: true }, () => {}), 3000);
}

function serveDownload(req, res, s, id) {
  const d = st.downloads.get(id);
  if (!d || d.sid !== s.id || d.ip !== s.ip) return notFound(res);
  if (Date.now() > d.expires) { dropDownload(id); return send(res, 410, { error: 'expired' }); }
  if (!d.ready) return send(res, 409, { error: 'not-ready', progress: d.progress });
  const base = d.name.replace(/\.[^.]+$/, '').replace(/[^\w .()-]/g, '_');
  const filename = d.kind === 'phone' ? `${base}_phone.mp4` : d.name.replace(/[^\w .()-]/g, '_');
  // single use: the ticket is spent once the whole file has gone out
  res.on('finish', () => {
    if (res.statusCode === 200) { dropDownload(id); log(`${s.name} downloaded ${d.name}`, 'ok'); pushDevices(); }
  });
  serveFile(req, res, d.file, { 'Content-Disposition': `attachment; filename="${filename}"` });
}

const running = () => !!server;
module.exports = { init, start, stop, rotate, setOptions, info, setCurrent, setPcState, devices, kick, decide, setControl, allowDownload, running, cleanupSync, adapters, trustedList, forgetTrusted };
