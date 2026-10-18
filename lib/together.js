// Watch Together over the local network. The host runs a small TCP server
// (newline-delimited messages) and relays messages to all members. Rooms are
// announced by UDP broadcast so others can find them without typing an IP.
//
// Security: joining needs the room's secret code (part of the invite code). The
// code is never sent: the host sends a random challenge and the member answers
// with an HMAC of it. Both sides then derive a per-connection AES-256-GCM key, so
// everything after the handshake is encrypted. The host can approve each member,
// members can only send playback / chat messages, and there are limits on members,
// unanswered connections and message rate.
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');

const PORT = 47180;
const DISCOVERY_PORT = 47181;
const MAX_MEMBERS = 15;
const HELLO_TIMEOUT = 10000;
const MAX_MSGS_PER_SEC = 25;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)

let emit = () => {};
let server = null, clients = new Map(); // host side: socket -> { id, name, ip, key, status, rate }
let conn = null;                         // member side: { sock, key }
let me = { id: crypto.randomBytes(5).toString('hex'), name: os.userInfo().username || 'Viewer' };
let role = null;                          // 'host' | 'member' | null
let room = null;                          // host: { secret, approve }
let beacon = null, listener = null;
const rooms = new Map();                  // ip -> { name, count, seen }
const failures = new Map();               // ip -> { n, until }

function init(sender) {
  emit = sender;
  startListening();
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

// ---------------------------------------------------------------- crypto
const secretKey = (secret) => crypto.scryptSync(String(secret).toUpperCase(), 'vr180-together-v2', 32);
const proofOf = (secret, hostNonce, memberNonce) => crypto.createHmac('sha256', secretKey(secret)).update(hostNonce + '|' + memberNonce).digest('base64');
const sessionKey = (secret, hostNonce, memberNonce) => crypto.createHash('sha256').update(Buffer.concat([secretKey(secret), Buffer.from(hostNonce + '|' + memberNonce + '|session')])).digest();
function seal(key, msg) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(msg)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function open(key, line) {
  const b = Buffer.from(line, 'base64');
  if (b.length < 29) throw new Error('short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
}

function lineReader(sock, onLine) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    if (buf.length > 256 * 1024) return sock.destroy();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
}
const writeRaw = (sock, obj) => { try { sock.write(JSON.stringify(obj) + '\n'); } catch {} };
const writeSealed = (sock, key, msg) => { try { sock.write(seal(key, msg) + '\n'); } catch {} };

// ---------------------------------------------------------------- what members may send
const KINDS = new Set(['play', 'seek', 'rate', 'load', 'sync']);
const str = (v, n) => String(v ?? '').slice(0, n);
const num = (v, lo, hi, dflt = 0) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt);
function cleanFromMember(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.t === 'chat') return { t: 'chat', text: str(m.text, 500) };
  if (m.t === 'request-state') return { t: 'request-state' };
  if (m.t === 'state') {
    const file = m.file && typeof m.file === 'object' ? { name: str(m.file.name, 200), size: num(m.file.size, 0, 1e13), duration: num(m.file.duration, 0, 1e6) } : null;
    return { t: 'state', kind: KINDS.has(m.kind) ? m.kind : 'play', file, paused: !!m.paused, time: num(m.time, 0, 1e6), rate: num(m.rate, 0.25, 4, 1), sentAt: num(m.sentAt, 0, 1e14) };
  }
  return null; // 'members', 'closed', etc. only ever come from the host
}

// ---------------------------------------------------------------- host
function members() {
  return [{ id: me.id, name: me.name, host: true }, ...[...clients.values()].filter((c) => c.status === 'ok').map((c) => ({ id: c.id, name: c.name }))];
}
function broadcast(msg, except) {
  for (const [s, c] of clients) if (s !== except && c.status === 'ok') writeSealed(s, c.key, msg);
}
function status() {
  return { role, me, members: role === 'host' ? members() : status.members || [], addresses: lanAddresses(), port: PORT,
    secret: role === 'host' ? room?.secret : undefined, approve: room?.approve, waiting: role === 'member' && status.waiting };
}
function pushStatus() { emit('together-status', status()); }
const newSecret = () => Array.from(crypto.randomBytes(5), (b) => ALPHABET[b & 31]).join('');

function host(name, opts = {}) {
  leave();
  if (name) me.name = String(name).slice(0, 32);
  const given = String(opts.secret || '').toUpperCase();
  room = { secret: /^[0-9A-HJKMNP-TV-Z]{5}$/.test(given) ? given : newSecret(), approve: opts.approve !== false };
  return new Promise((resolve, reject) => {
    server = net.createServer((sock) => {
      sock.setNoDelay(true);
      const ip = (sock.remoteAddress || '').replace('::ffff:', '');
      const f = failures.get(ip);
      if (f && Date.now() < f.until) { writeRaw(sock, { t: 'denied', reason: 'locked' }); return sock.destroy(); }
      if (clients.size >= MAX_MEMBERS + 3) { writeRaw(sock, { t: 'denied', reason: 'full' }); return sock.destroy(); }
      const hostNonce = crypto.randomBytes(16).toString('base64');
      const c = { id: null, name: null, ip, key: null, status: 'hello', rate: { t: 0, n: 0 } };
      clients.set(sock, c);
      writeRaw(sock, { t: 'challenge', nonce: hostNonce, v: 2 });
      const helloTimer = setTimeout(() => { if (c.status === 'hello') sock.destroy(); }, HELLO_TIMEOUT);
      lineReader(sock, (line) => {
        if (c.status === 'hello') {
          let msg;
          try { msg = JSON.parse(line); } catch { return sock.destroy(); }
          if (msg.t !== 'hello' || typeof msg.nonce !== 'string' || typeof msg.proof !== 'string') return sock.destroy();
          const expect = Buffer.from(proofOf(room.secret, hostNonce, msg.nonce));
          const got = Buffer.from(msg.proof);
          if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) {
            const ff = failures.get(ip) || { n: 0, until: 0 };
            ff.n++;
            if (ff.n >= 5) { ff.until = Date.now() + 60000; ff.n = 0; }
            failures.set(ip, ff);
            writeRaw(sock, { t: 'denied', reason: 'code' });
            emit('together-msg', { t: 'refused', name: str(msg.name, 32), ip });
            return sock.destroy();
          }
          clearTimeout(helloTimer);
          failures.delete(ip);
          c.key = sessionKey(room.secret, hostNonce, msg.nonce);
          c.id = str(msg.id, 16) || crypto.randomBytes(4).toString('hex');
          c.name = str(msg.name, 32) || 'Viewer';
          if ([...clients.values()].filter((x) => x.status === 'ok').length >= MAX_MEMBERS) { writeSealed(sock, c.key, { t: 'denied', reason: 'full' }); return sock.destroy(); }
          if (room.approve) {
            c.status = 'pending';
            writeSealed(sock, c.key, { t: 'waiting' });
            emit('together-approve', { id: c.id, name: c.name, ip });
          } else admit(sock, c);
          return;
        }
        let msg;
        try { msg = open(c.key, line); } catch { return sock.destroy(); }
        if (c.status !== 'ok') return; // waiting members can't talk yet
        // rate limit: a flood just gets dropped
        const now = Date.now();
        if (now - c.rate.t > 1000) { c.rate.t = now; c.rate.n = 0; }
        if (++c.rate.n > MAX_MSGS_PER_SEC) return;
        const clean = cleanFromMember(msg);
        if (!clean) return;
        clean.from = c.id;
        clean.fromName = c.name;
        broadcast(clean, sock);
        emit('together-msg', clean);
      });
      const drop = () => {
        clearTimeout(helloTimer);
        if (!clients.has(sock)) return;
        clients.delete(sock);
        if (c.status === 'pending') emit('together-approve-cancel', { id: c.id });
        if (c.status === 'ok') {
          broadcast({ t: 'members', list: members() });
          emit('together-msg', { t: 'left', name: c.name });
          pushStatus();
        }
      };
      sock.on('close', drop);
      sock.on('error', drop);
    });
    server.on('error', (e) => { server = null; room = null; reject(e.code === 'EADDRINUSE' ? new Error('Another program, or another VR180 Player window, is already using the Watch Together port (' + PORT + '). Close it and try again.') : e); });
    server.listen(PORT, () => {
      role = 'host';
      startBeacon();
      pushStatus();
      resolve(status());
    });
  });
}
function admit(sock, c) {
  c.status = 'ok';
  writeSealed(sock, c.key, { t: 'welcome' });
  broadcast({ t: 'members', list: members() });
  emit('together-msg', { t: 'joined', name: c.name });
  emit('together-msg', { t: 'request-state' });
  pushStatus();
}
// the host's answer to "X wants to join"
function decide(id, allow) {
  for (const [sock, c] of clients) {
    if (c.id !== id || c.status !== 'pending') continue;
    if (allow) admit(sock, c);
    else { writeSealed(sock, c.key, { t: 'denied', reason: 'host' }); sock.destroy(); }
  }
}
function setApprove(on) { if (room) room.approve = !!on; pushStatus(); }

// ---------------------------------------------------------------- member
function join(address, name, secret) {
  leave();
  if (name) me.name = String(name).slice(0, 32);
  secret = String(secret || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{5}$/.test(secret)) return Promise.reject(new Error('Enter the room code from the host (5 letters/numbers).'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(status()); };
    const sock = net.connect({ host: address, port: PORT, timeout: 5000 }, () => { sock.setTimeout(0); sock.setNoDelay(true); });
    let key = null;
    lineReader(sock, (line) => {
      if (!key) {
        let msg;
        try { msg = JSON.parse(line); } catch { return sock.destroy(); }
        if (msg.t === 'denied') return finish(new Error(msg.reason === 'locked' ? 'Too many wrong codes. Wait a minute and try again.' : msg.reason === 'full' ? 'That room is full.' : 'Wrong room code.'));
        if (msg.t !== 'challenge' || typeof msg.nonce !== 'string') return finish(new Error('That room uses an older version of VR180 Player. Update both PCs.'));
        const memberNonce = crypto.randomBytes(16).toString('base64');
        writeRaw(sock, { t: 'hello', id: me.id, name: me.name, nonce: memberNonce, proof: proofOf(secret, msg.nonce, memberNonce) });
        key = sessionKey(secret, msg.nonce, memberNonce);
        conn = { sock, key };
        role = 'member';
        return;
      }
      let msg;
      // the host answers a wrong code in plain text (there is no shared key then)
      if (line[0] === '{') { try { const m = JSON.parse(line); if (m.t === 'denied') return finish(new Error(m.reason === 'locked' ? 'Too many wrong codes. Wait a minute and try again.' : m.reason === 'full' ? 'That room is full.' : 'Wrong room code.')); } catch {} return sock.destroy(); }
      try { msg = open(key, line); } catch { return sock.destroy(); }
      if (msg.t === 'waiting') { status.waiting = true; pushStatus(); finish(); return; }
      if (msg.t === 'welcome') { status.waiting = false; pushStatus(); finish(); return; }
      if (msg.t === 'denied') { emit('together-msg', { t: 'denied', reason: msg.reason }); return; }
      if (msg.t === 'members') { status.members = Array.isArray(msg.list) ? msg.list.slice(0, MAX_MEMBERS + 1) : []; pushStatus(); return; }
      emit('together-msg', msg);
    });
    sock.on('timeout', () => { sock.destroy(); finish(new Error('No room found at that address')); });
    sock.on('error', (e) => finish(e));
    sock.on('close', () => {
      finish(new Error('The room closed the connection.'));
      if (conn?.sock === sock) {
        conn = null; role = null; status.members = []; status.waiting = false;
        emit('together-msg', { t: 'closed' });
        pushStatus();
      }
    });
  });
}

function send(msg) {
  if (role === 'host') { broadcast({ ...msg, from: me.id, fromName: me.name }); return; }
  if (conn && !status.waiting) {
    const clean = cleanFromMember(msg);
    if (clean) writeSealed(conn.sock, conn.key, clean);
  }
}

function leave() {
  if (server) {
    for (const s of clients.keys()) s.destroy();
    clients.clear();
    server.close();
    server = null;
  }
  if (conn) { const c = conn; conn = null; c.sock.destroy(); }
  stopBeacon();
  role = null;
  room = null;
  status.members = [];
  status.waiting = false;
  pushStatus();
}

function startBeacon() {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.bind(() => {
    sock.setBroadcast(true);
    const ping = () => {
      const msg = Buffer.from(JSON.stringify({ app: 'vr180-player', v: 2, name: me.name, port: PORT, count: members().length }));
      // every network the PC is on, not just the first one Windows picks
      for (const a of Object.values(os.networkInterfaces()).flat()) {
        if (!a || a.family !== 'IPv4' || a.internal || !a.netmask) continue;
        const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
        const bcast = ip.map((b, i) => (b | (~mask[i] & 255))).join('.');
        sock.send(msg, DISCOVERY_PORT, bcast, () => {});
      }
    };
    ping();
    beacon = { sock, timer: setInterval(ping, 2000) };
  });
}
function stopBeacon() {
  if (!beacon) return;
  clearInterval(beacon.timer);
  try { beacon.sock.close(); } catch {}
  beacon = null;
}

function startListening() {
  listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  listener.on('message', (buf, rinfo) => {
    try {
      const m = JSON.parse(buf.toString());
      if (m.app !== 'vr180-player') return;
      rooms.set(rinfo.address, { address: rinfo.address, name: str(m.name, 32), count: num(m.count, 0, 99), secure: m.v === 2, seen: Date.now() });
    } catch {}
  });
  listener.on('error', () => {});
  listener.bind(DISCOVERY_PORT);
  setInterval(() => {
    for (const [k, r] of rooms) if (Date.now() - r.seen > 6000) rooms.delete(k);
    emit('together-rooms', [...rooms.values()]);
  }, 2000);
}

function setName(name) { me.name = String(name || 'Viewer').slice(0, 32); }

module.exports = { init, host, join, send, leave, status, setName, decide, setApprove, _test: { seal, open, proofOf, cleanFromMember } };
