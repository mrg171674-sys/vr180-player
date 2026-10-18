import { api, on, emit, settings, save, baseName, fmtTime, isHidden, isPrivatePath } from './core.js';
import { h, svg, card, toggle, field, toast, strip, iconBtn, modal } from './ui.js';
import { player } from './player.js';
import { library } from './library.js';

const ui = {};

// ---- invite codes: the host's LAN IPv4 packed into 7 Crockford base32 characters
// (32 address bits + a 3-bit check so typos are caught), shown as XXXX-XXX.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const check = (b) => (b[0] * 1 + b[1] * 3 + b[2] * 5 + b[3] * 7) % 8;
export function encodeCode(ip) {
  const b = ip.split('.').map(Number);
  if (b.length !== 4 || b.some((x) => !(x >= 0 && x <= 255))) return null;
  let v = ((b[0] * 256 + b[1]) * 256 + b[2]) * 256 + b[3];
  v = v * 8 + check(b);
  let out = '';
  for (let i = 0; i < 7; i++) { out = B32[v % 32] + out; v = Math.floor(v / 32); }
  return out.slice(0, 4) + '-' + out.slice(4);
}
// full invite = address part + the room's secret code: XXXX-XXX-SSSSS
export function decodeInvite(code) {
  const c = String(code).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (/^[0-9A-HJKMNP-TV-Z]{12}$/.test(c)) { const address = decodeCode(c.slice(0, 7)); return address ? { address, secret: c.slice(7) } : null; }
  const address = decodeCode(c);
  return address ? { address, secret: null } : null;
}
export function decodeCode(code) {
  const c = String(code).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{7}$/.test(c)) return null;
  let v = 0;
  for (const ch of c) v = v * 32 + B32.indexOf(ch);
  const chk = v % 8;
  v = Math.floor(v / 8);
  const b = [Math.floor(v / 16777216) % 256, Math.floor(v / 65536) % 256, Math.floor(v / 256) % 256, v % 256];
  return check(b) === chk ? b.join('.') : null;
}
const isIP = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s === 'localhost';
let lastJoin = null;
let status = { role: null, members: [], addresses: [] };
let rooms = [];
const opts = { followFile: true };
const COLORS = ['#7be0a3', '#e8c46a', '#7fb4ff', '#d99bff', '#ff9b8a', '#7fe3e3'];
const color = (id = '') => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

export function initTogether(page) {
  ui.name = h('input', { type: 'text', value: settings.togetherName || '', placeholder: 'Your name', maxlength: 32 });
  ui.name.addEventListener('change', () => save({ togetherName: ui.name.value.trim() }));

  ui.hostInfo = h('div', { class: 'muted' });
  ui.codeBox = h('div', { class: 'invite', hidden: true });
  ui.hostBtn = h('button', { class: 'btn primary', onclick: hostOrStop });
  ui.approve = toggle(settings.togetherApprove !== false, (v) => { save({ togetherApprove: v }); api.togetherApproveSetting(v); });
  const hostCard = card({
    title: 'Host a Room', info: 'Start a room on your home network. Friends on the same Wi-Fi/LAN running VR180 Player can join with the invite code, and play, pause, seeking and speed stay in sync. Everyone needs their own copy of the video. The connection is encrypted and the code is never sent over the network.',
    body: [field('Display name', ui.name), field('Approve each person who joins', ui.approve, 'You see a pop-up and choose Allow or Deny for every new member.'), ui.codeBox, ui.hostInfo, ui.hostBtn]
  });

  ui.rooms = h('div', { class: 'stack', style: { gap: '6px' } });
  ui.ip = h('input', { type: 'text', placeholder: 'Invite code (K7Q2-9F3-XM4RT)' });
  ui.recent = h('div', { class: 'stack', style: { gap: '6px' } });
  ui.ip.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(ui.ip.value.trim()); });
  const joinCard = card({
    title: 'Join a Room', info: 'Rooms on your network show up here automatically; you still need the room code from the host. If a room does not appear (some routers block discovery), type the full invite code.',
    body: [ui.rooms, h('div', { class: 'inline' }, ui.ip, h('button', { class: 'btn', onclick: () => join(ui.ip.value.trim()) }, 'Join')), ui.recent]
  });

  ui.state = h('div', { class: 'inline' });
  ui.members = h('div');
  ui.chat = h('div', { class: 'chat' });
  ui.msg = h('input', { type: 'text', placeholder: 'Say something…', maxlength: 300 });
  ui.msg.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  ui.follow = toggle(true, (v) => (opts.followFile = v));
  const roomCard = card({
    title: 'Room', info: 'Members and chat. Anyone in the room can control playback; the host keeps everyone within half a second.',
    body: [ui.state, ui.members, field('Follow video changes', ui.follow, 'Automatically open the same video when someone switches (if you have it)'),
      ui.chat, h('div', { class: 'inline' }, ui.msg, h('button', { class: 'btn', onclick: sendChat, html: svg('send') }))]
  });
  roomCard.style.minHeight = '100%';

  page.append(h('div', { class: 'grid2', style: { gridTemplateColumns: 'minmax(320px, 1fr) minmax(360px, 1.2fr)', height: '100%' } },
    h('div', { class: 'stack' }, hostCard, joinCard), roomCard));

  api.onTogetherStatus((s) => { status = s; render(); });
  api.onTogetherRooms((r) => { rooms = r; renderRooms(); });
  api.onTogetherMsg(onMessage);
  api.onTogetherApprove(askApprove);
  api.onTogetherApproveCancel(({ id }) => { approvals.get(id)?.close(); approvals.delete(id); });
  on('user-action', ({ kind }) => { if (status.role) sendState(kind); });
  api.togetherStatus().then((s) => { status = s; render(); });
  renderRooms();
  sys('Not in a room yet.');
}

const myName = () => ui.name.value.trim() || undefined;

async function hostOrStop() {
  if (status.role) return leave();
  try {
    await api.togetherHost(myName(), { approve: settings.togetherApprove !== false, secret: roomSecret() });
    sys('Room started. Waiting for friends…');
  } catch (e) { toast('Could not start the room: ' + String(e.message).replace(/.*Error: /, ''), 'err'); }
}
// input: a full invite code, or (from the room list / recent rooms) an address plus a known secret
async function join(input, secret) {
  if (!input) return;
  let address = input.trim();
  if (!isIP(address)) {
    const inv = decodeInvite(input);
    if (!inv) return toast("That invite code doesn't look right. It should be like K7Q2-9F3-XM4RT.", 'err');
    address = inv.address;
    secret = secret || inv.secret;
  }
  if (!secret) secret = await askCode(address);
  if (!secret) return;
  try {
    const s = await api.togetherJoin(address, myName(), secret);
    lastJoin = { address, code: (encodeCode(address) || address) + '-' + secret, secret, at: Date.now() };
    sys(s.waiting ? 'Waiting for the host to let you in…' : `Joined the room at ${address}`);
    toast(s.waiting ? 'Waiting for the host to let you in' : 'Joined room', 'ok');
    ui.ip.value = '';
  } catch (e) { toast('Could not join: ' + String(e.message).replace(/.*Error: /, ''), 'err'); }
}
// the host keeps one room code (so friends can rejoin) until they ask for a new one
function roomSecret(fresh) {
  if (fresh || !settings.togetherSecret) {
    const b = crypto.getRandomValues(new Uint8Array(5));
    save({ togetherSecret: Array.from(b, (x) => B32[x & 31]).join('') });
  }
  return settings.togetherSecret;
}
async function newCode() {
  roomSecret(true);
  if (status.role === 'host') { await api.togetherLeave(); await api.togetherHost(myName(), { approve: settings.togetherApprove !== false, secret: roomSecret() }); }
  toast('New room code made. The old invite code no longer works.', 'ok');
}
// the room code is the last part of the host's invite code
function askCode(address) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', placeholder: 'XM4RT', maxlength: 6, class: 'pin-input', style: { letterSpacing: '6px', textTransform: 'uppercase' } });
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); });
    const m = modal({ title: 'Room code', width: 360, onClose: () => { if (!done) { done = true; resolve(null); } }, body: [
      h('p', { class: 'muted' }, `Ask the host for the room code: the last 5 characters of their invite code (${address}).`),
      input, h('button', { class: 'btn primary wide', onclick: () => finish(input.value.trim()) }, 'Join')] });
    setTimeout(() => input.focus(), 50);
  });
}
// host: someone with the right code wants in
const approvals = new Map();
function askApprove(d) {
  const m = modal({ title: 'Someone wants to join your room', width: 380, onClose: () => approvals.delete(d.id), body: [
    h('p', {}, h('b', {}, d.name), ` (${d.ip}) entered the room code.`),
    h('div', { class: 'inline' },
      h('button', { class: 'btn primary', onclick: () => { api.togetherDecide(d.id, true); m.close(); } }, 'Allow'),
      h('button', { class: 'btn danger', onclick: () => { api.togetherDecide(d.id, false); m.close(); } }, 'Deny'))] });
  approvals.set(d.id, m);
}
async function leave() { await api.togetherLeave(); sys('You left the room.'); }

// ---------------------------------------------------------------- sync
function fileDesc() {
  const it = player.current();
  // private (vault) files are never announced to the room
  return it && !isHidden(it.path) && !isPrivatePath(it.path) ? { name: it.name, size: it.info.size, duration: it.info.duration } : null;
}
function sendState(kind) {
  const s = player.snapshotState();
  api.togetherSend({ t: 'state', kind, file: fileDesc(), ...s, sentAt: Date.now() });
}
// The host sends a heartbeat so everyone stays together
setInterval(() => {
  if (status.role === 'host' && status.members.length > 1 && player.current()) {
    api.togetherSend({ t: 'sync', file: fileDesc(), ...player.snapshotState(), sentAt: Date.now() });
  }
}, 2000);

let missing = null;
async function onMessage(m) {
  switch (m.t) {
    case 'state':
    case 'sync': {
      const mine = fileDesc();
      if (m.file && (!mine || mine.name !== m.file.name || mine.size !== m.file.size)) {
        if (!opts.followFile) return;
        const path = library.findByNameSize(m.file.name, m.file.size) || findInPlaylist(m.file);
        if (!path) {
          if (missing !== m.file.name) { missing = m.file.name; sys(`${m.fromName || 'Host'} is playing "${m.file.name}", which you don't have.`); }
          strip.set('together-missing', 4, { text: `Room is playing "${m.file.name}". Add its folder to your Library to follow along.`, action: 'Library', onAction: () => emit('goto', 'library') });
          return;
        }
        strip.clear('together-missing');
        missing = null;
        player.state.remote = true;
        await player.open([path]);
        sys(`Opened "${m.file.name}" to match the room`);
      }
      // account for network delay when playing
      const lag = m.paused ? 0 : Math.min(1, Math.max(0, (Date.now() - m.sentAt) / 1000)) * (m.rate || 1);
      player.applyRemote({ paused: m.paused, time: m.time + lag, rate: m.rate, tolerance: m.t === 'sync' ? 0.6 : 0.25 });
      if (m.t === 'state' && m.kind && m.kind !== 'load') {
        const what = m.kind === 'play' ? (m.paused ? 'paused' : 'played') : m.kind === 'seek' ? `jumped to ${fmtTime(m.time)}` : m.kind === 'rate' ? `set speed ${m.rate}×` : null;
        if (what) player.osd(`${m.fromName} ${what}`);
      }
      setSynced(true);
      break;
    }
    case 'request-state': if (player.current()) sendState('load'); break;
    case 'chat': chat(m.fromName, m.text, m.from); break;
    case 'joined': sys(`${m.name} joined`); toast(`${m.name} joined the room`); break;
    case 'left': sys(`${m.name} left`); break;
    case 'closed': sys('The host closed the room.'); toast('Room closed'); strip.clear('together-missing'); break;
    case 'denied': sys(m.reason === 'host' ? 'The host didn\'t let you in.' : 'You were turned away.'); toast('Not let in', 'err'); break;
    case 'refused': sys(`Someone at ${m.ip} tried a wrong room code.`); break;
  }
}
function findInPlaylist(f) {
  return player.state.playlist.find((it) => it.name === f.name && it.info.size === f.size)?.path || null;
}

function sendChat() {
  const text = ui.msg.value.trim();
  if (!text || !status.role) return;
  api.togetherSend({ t: 'chat', text });
  chat(status.me?.name || 'You', text, status.me?.id);
  ui.msg.value = '';
}
function chat(name, text, id) {
  ui.chat.append(h('div', {}, h('b', { style: { color: color(id) } }, name + ': '), text));
  ui.chat.scrollTop = ui.chat.scrollHeight;
  if (document.querySelector('.page[data-page=together]:not(.active)')) player.osd(`${name}: ${text}`.slice(0, 80));
}
function sys(text) {
  ui.chat.append(h('div', { class: 'sys' }, text));
  ui.chat.scrollTop = ui.chat.scrollHeight;
}

let synced = false;
function setSynced(v) { synced = v; renderState(); }

// ---------------------------------------------------------------- render
function render() {
  const r = status.role;
  ui.hostBtn.textContent = r === 'host' ? 'Close room' : r === 'member' ? 'Leave room' : 'Host room';
  ui.hostBtn.className = 'btn ' + (r ? 'danger' : 'primary');
  const code = r === 'host' && status.addresses?.length && status.secret ? encodeCode(status.addresses[0]) + '-' + status.secret : null;
  ui.codeBox.hidden = !code;
  if (code) ui.codeBox.replaceChildren(h('div', { class: 'muted' }, 'Invite code'), h('div', { class: 'code' }, code),
    h('button', { class: 'btn', onclick: () => { api.copyText(code); toast('Invite code copied', 'ok'); } }, 'Copy'),
    h('button', { class: 'btn', title: 'Make a new room code; the old invite code stops working', onclick: newCode }, 'New code'));
  ui.hostInfo.textContent = r === 'host'
    ? `Share the invite code. People who find your room in their list need the last part (${status.secret}). Windows may ask to allow network access the first time.`
    : r === 'member' ? (status.waiting ? 'Waiting for the host to let you in…' : 'You are in a room. Leave to host your own.') : 'Not hosting.';
  ui.name.disabled = !!r;
  ui.members.replaceChildren(...(status.members || []).map((m) => h('div', { class: 'member' },
    h('span', { class: 'avatar', style: { background: color(m.id) } }, (m.name || '?')[0].toUpperCase()),
    h('span', {}, m.name + (m.id === status.me?.id ? ' (you)' : '')), m.host ? h('span', { class: 'badge y' }, 'HOST') : null)));
  if (!r) setSynced(false);
  // remember rooms we joined, with the host's name, for one-click rejoin
  if (r === 'member' && lastJoin) {
    const host = (status.members || []).find((m) => m.host);
    if (host) {
      const recent = [{ ...lastJoin, name: host.name }, ...(settings.recentRooms || []).filter((x) => x.address !== lastJoin.address)].slice(0, 5);
      save({ recentRooms: recent });
      lastJoin = null;
    }
  }
  renderState();
  renderRooms();
  if (r) strip.set('together', 3, { text: r === 'host' ? `Hosting Watch Together · ${status.members.length} in room` : 'Connected to a Watch Together room', action: 'Leave', onAction: leave });
  else strip.clear('together');
  emit('together', status);
}
function renderState() {
  const r = status.role;
  ui.state.replaceChildren(h('span', { class: 'status-dot' + (r ? ' ok' : '') }),
    h('span', {}, !r ? 'Offline' : r === 'host' ? 'Hosting' : synced ? 'In sync with host' : 'Connected'));
}
function renderRooms() {
  const list = rooms.filter((x) => !(status.role === 'host' && (status.addresses || []).includes(x.address)));
  ui.rooms.replaceChildren(...(list.length ? list.map((x) => h('div', { class: 'room-row' },
    h('span', { html: svg('wifi') }), h('span', { class: 'n' }, `${x.name}'s room`, h('span', { class: 'muted' }, ` · ${x.count} watching · ${x.address}`)),
    h('button', { class: 'btn', disabled: !!status.role, onclick: () => join(x.address) }, x.secure === false ? 'Old version' : 'Join')))
    : [h('div', { class: 'empty-note', style: { padding: '14px' } }, 'Looking for rooms on your network…')]));
  const recent = settings.recentRooms || [];
  ui.recent.replaceChildren(...(recent.length ? [h('div', { class: 'muted' }, 'Recent rooms'), ...recent.map((x) => h('div', { class: 'room-row' },
    h('span', { class: 'n' }, `${x.name}'s room`, h('span', { class: 'muted' }, ` · ${x.code} · ${new Date(x.at).toLocaleDateString()}`)),
    h('button', { class: 'btn', disabled: !!status.role, onclick: () => join(x.address, x.secret) }, 'Rejoin'),
    iconBtn('x', 'Forget', () => { save({ recentRooms: recent.filter((y) => y !== x) }); renderRooms(); })))] : []));
}
