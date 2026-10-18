// Phone tab: start a private stream, show the QR code and link, set a PIN,
// approve phones and see (or remove) every connected device.
import { api, on, emit, settings, save, fmtTime, fileKey, isHidden } from './core.js';
import { h, svg, card, toggle, segmented, select, field, toast, modal, iconBtn } from './ui.js';
import { sfx } from './sfx.js';

const ui = {};
let info = { running: false };
let devices = [];
const prompts = new Map(); // open approval / control dialogs by phone id

export function initPhoneTab(page, player) {
  ui.startBtn = h('button', { class: 'btn primary wide', onclick: () => (info.running ? stopStream() : startStream()) });
  ui.pinToggle = toggle(!!settings.phonePinOn, (v) => { save({ phonePinOn: v }); ui.pinIn.disabled = !v; if (info.running) api.phoneOptions({ pin: v ? ui.pinIn.value : null }); });
  ui.pinIn = h('input', { type: 'text', inputmode: 'numeric', maxlength: 8, placeholder: '4–8 digits', value: settings.phonePin || randomPin(), style: { width: '120px' } });
  ui.pinIn.disabled = !settings.phonePinOn;
  ui.pinIn.addEventListener('change', () => { ui.pinIn.value = ui.pinIn.value.replace(/\D/g, '').slice(0, 8); save({ phonePin: ui.pinIn.value }); if (info.running && settings.phonePinOn) api.phoneOptions({ pin: ui.pinIn.value }); });
  ui.approve = toggle(settings.phoneApprove !== false, (v) => { save({ phoneApprove: v }); if (info.running) api.phoneOptions({ approve: v }); });
  ui.quality = segmented([{ value: 'auto', label: 'Auto' }, { value: 'original', label: 'Original' }, { value: '4k', label: '4K' }, { value: '1080', label: '1080p' }],
    settings.phoneQuality || 'auto', (v) => { save({ phoneQuality: v }); if (info.running) api.phoneOptions({ quality: v }); }, 'small');

  ui.lock = toggle(false, (v) => { if (info.running) api.phoneOptions({ locked: v }).then((i) => { info = i; render(); }); else { ui.lock.set(false); toast('Start the stream first.'); } });
  const MIN = (list) => list.map((m) => ({ value: String(m), label: m ? m + ' min' : 'Never' }));
  ui.expire = select(MIN([0, 5, 10, 15, 30]), String(settings.phoneLinkExpire ?? 10), (v) => { save({ phoneLinkExpire: +v }); if (info.running) api.phoneOptions({ linkExpireMin: +v }); });
  ui.idle = select(MIN([0, 15, 30, 60]), String(settings.phoneIdleStop ?? 30), (v) => { save({ phoneIdleStop: +v }); if (info.running) api.phoneOptions({ idleStopMin: +v }); });

  const setupCard = card({
    title: 'Phone Stream', info: 'Watch the video that is open on this PC on your phone, or use your phone as a remote. Phones must scan the QR code (or open the link): being on the same Wi-Fi is not enough.',
    body: [
      h('p', { class: 'muted' }, 'Start a private stream, then scan the QR code with your phone\'s camera. The phone and this PC need to be on the same Wi-Fi.'),
      field('Require a PIN', h('div', { class: 'inline' }, ui.pinIn, ui.pinToggle), 'The phone asks for this PIN after scanning. 5 wrong tries locks it out for a minute.'),
      field('Approve new phones', ui.approve, 'Each new phone has to be allowed on this PC before it can watch.'),
      field('Lock stream', ui.lock, 'While locked, no new phone can join, even with the link and PIN. Phones already watching keep watching.'),
      field('Quality', ui.quality, 'Auto sends the original when the phone can play it, and otherwise has this PC re-encode it on the fly (using the graphics card when possible).'),
      ui.startBtn
    ]
  });

  ui.qr = h('div', { class: 'qr-wrap' });
  ui.link = h('input', { type: 'text', readonly: true, class: 'link' });
  // which network the QR code points to (PCs often have virtual / VPN adapters too)
  ui.net = h('select', { class: 'net-pick', onchange: async () => { info = await api.phoneOptions({ ip: ui.net.value }); render(); } });
  ui.netRow = h('div', { class: 'inline net-row', hidden: true }, h('span', { class: 'muted' }, 'Network'), ui.net);
  ui.doctor = h('div', { class: 'doctor', hidden: true });
  ui.status = h('div', { class: 'muted' });
  const qrCard = card({
    title: 'Scan to Watch', info: 'Your phone will warn that the connection is "not private". That is expected: the stream is encrypted with a certificate made by this PC, not by a public authority. Tap Advanced / Show details, then continue.',
    body: [ui.qr, ui.netRow, ui.doctor, h('div', { class: 'inline' }, ui.link,
      h('button', { class: 'btn', onclick: () => { api.copyText(ui.link.value); toast('Link copied', 'ok'); }, html: svg('copy') + 'Copy' })),
    h('button', { class: 'btn', onclick: newLink, html: svg('shield') + 'New link (disconnect everyone)' }),
    ui.pair = h('details', { class: 'pair-box' }, h('summary', {}, 'Headset or no camera? Use a code instead'),
      h('p', { class: 'muted' }, 'In the headset\'s browser (Quest, Pico…) open this address, then type the code. Then tap "VR" to watch around you.'),
      ui.pairUrl = h('div', { class: 'pair-url' }),
      ui.pairCode = h('div', { class: 'pair-code' }),
      h('p', { class: 'muted small' }, 'The code works once and changes every 10 minutes. The PIN and your approval still apply.')),
    h('details', { class: 'cert-help' }, h('summary', {}, 'The phone says "Your connection is not private"'),
      h('p', {}, 'iPhone (Safari): tap Show Details → visit this website → Visit Website.'),
      h('p', {}, 'Android (Chrome): tap Advanced → Proceed to … (unsafe).'),
      h('p', { class: 'muted' }, 'The video is still encrypted between this PC and your phone. The warning only means the certificate was made by this PC rather than bought from a certificate company.')),
    ui.status]
  });

  ui.list = h('div', { class: 'devices' });
  const devCard = card({ title: 'Connected Devices', info: 'Every phone that has opened the link. Remove one to cut it off straight away. "Control" lets that phone use Remote mode to control playback on this PC.', body: [ui.list] });

  const safetyCard = card({
    title: 'Safety', info: 'Phones only get in with the link, plus the PIN and your approval if those are on. A phone is tied to the network address it joined from, so a copied link session is useless on another device. Wrong PINs lock that address out for longer each time, and 20 wrong PINs replace the link.',
    body: [
      field('Link expires if nobody joins within', ui.expire, 'An unused link is replaced with a new one after this long.'),
      field('Stop the stream after no phones for', ui.idle, 'Stops the stream automatically when no phone has been connected for this long.'),
      ui.trusted = h('div', { class: 'trusted-list' })
    ]
  });
  ui.caQr = h('div', { class: 'qr-wrap small' });
  ui.caFp = h('code', { class: 'fp' });
  const step = (n, text) => h('li', {}, text);
  const trustCard = card({
    title: 'Trust this PC on your phone', info: 'Installs this PC\'s own security certificate on a phone, once. After that the phone never shows the "not private" warning again for this PC, and nobody else on the Wi-Fi can pretend to be this PC. The certificate only works for home-network addresses, so it can\'t be misused for real websites.',
    body: [
      h('p', { class: 'muted' }, 'Optional, once per phone. Scan this with the phone\'s camera while the stream is running, then follow the steps.'),
      ui.caQr,
      h('details', { class: 'cert-help', open: true }, h('summary', {}, 'iPhone'),
        h('ol', {}, step(1, 'Scan the code, tap the link, then "Allow" to download the profile (tap through the "not private" warning if it appears).'),
          step(2, 'Open Settings → Profile Downloaded → Install (enter your passcode) → Install.'),
          step(3, 'Settings → General → About → Certificate Trust Settings → turn on "VR180 Player on …".'))),
      h('details', { class: 'cert-help' }, h('summary', {}, 'Android'),
        h('ol', {}, step(1, 'Scan the code and download "VR180-Player-PC.crt" (tap through the warning if it appears).'),
          step(2, 'Settings → Security → More security settings → Install from device storage (or "Encryption & credentials → Install a certificate") → CA certificate.'),
          step(3, 'Pick the downloaded file and confirm. Chrome trusts it from then on.'))),
      h('div', { class: 'muted fp-row' }, 'Fingerprint (SHA-256): ', ui.caFp)
    ]
  });
  ui.log = h('div', { class: 'phone-log' });
  const logCard = card({ title: 'Recent Activity', info: 'Who joined, who was turned away, wrong PINs and other safety events for this stream.', body: [ui.log] });

  page.append(h('div', { class: 'grid2' }, h('div', { class: 'stack' }, setupCard, devCard, safetyCard), h('div', { class: 'stack' }, qrCard, trustCard, logCard)));

  api.onPhoneDevices((d) => { devices = d.devices; recordPhonePositions(player); renderDevices(); ui.status.textContent = info.running ? `${d.stream || 'Direct stream'} · ${fmtRate(d.rate)}` : ''; });
  api.onPhoneApprove(askApproval);
  api.onPhoneApproveCancel(({ id }) => closePrompt(id));
  api.onPhoneControlRequest(askControl);
  api.onPhoneDownloadRequest(askDownload);
  api.onPhoneDownloadCancel(({ id }) => closePrompt('dl:' + id));
  api.onPhoneControlCancel(({ id }) => closePrompt(id));
  api.onPhoneLog(renderLog);
  api.onPhonePair((p) => { info = { ...info, pairCode: p.code, pairUrl: p.url }; render(); });
  api.onPhoneAlert((a) => {
    toast(a.text, a.kind === 'link-expired' || a.kind === 'idle-stop' ? '' : 'err');
    if (a.info) { info = a.info; if (!info.running) devices = []; render(); renderDevices(); }
  });
  renderLog([]);
  renderTrusted();
  api.onPhoneCmd((c) => remoteCommand(player, c));
  render();

  // keep the phone up to date with what the PC shows
  const pushItem = () => { if (info.running) api.phoneCurrent(currentFor(player)); };
  on('loaded', pushItem); on('vault', pushItem); on('playlist', pushItem); on('chapters', pushItem); on('calib', pushItem); on('format', pushItem); on('level', pushItem); on('subs-tracks', pushItem);
  setInterval(() => { if (info.running) api.phonePcState(player.snapshotState()); }, 1000);
}

// Remembered devices (Safety card): reconnect from /pair without a code or approval
async function renderTrusted() {
  if (!ui.trusted) return;
  const list = await api.phoneTrusted().catch(() => []);
  const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  ui.trusted.replaceChildren(
    h('div', { class: 'rl' }, 'Remembered devices'),
    list.length ? h('div', {}, ...list.map((t) => h('div', { class: 'trusted-row' },
      h('span', { class: 'grow' }, t.name, h('span', { class: 'muted small' }, ` · since ${day(t.at)}, last used ${day(t.used)}`)),
      h('button', { class: 'btn small', onclick: async () => { await api.phoneForget(t.id); renderTrusted(); toast(`${t.name} forgotten`); } }, 'Forget'))))
      : h('div', { class: 'muted small' }, 'None. Choose "Allow & remember" when a phone or headset asks to join.'));
}

// remember how far each phone got, so the PC (and other phones) can continue from there
let lastRecord = 0;
function recordPhonePositions(player) {
  if (Date.now() - lastRecord < 5000) return;
  const it = player.current();
  if (!it || it.info.isImage || !isFinite(it.info.duration)) return;
  const watching = devices.filter((d) => d.status === 'ok' && d.online && d.mode === 'watch' && d.position > 1);
  if (!watching.length) return;
  lastRecord = Date.now();
  const best = watching.sort((a, b) => b.position - a.position)[0];
  const k = fileKey(it.path);
  const prev = settings.remoteResume?.[k];
  if (prev && Math.abs(prev.t - best.position) < 2) return;
  save({ remoteResume: { ...(settings.remoteResume || {}), [k]: { t: best.position, d: it.info.duration, at: Date.now(), dev: best.name.split(' · ')[0] } } });
}

// Warn when Windows treats the network as Public: its firewall then blocks phones
async function checkNetwork(adapter) {
  if (!adapter) return;
  const { profiles } = await api.phoneDoctor().catch(() => ({ profiles: [] }));
  const p = profiles.find((x) => x.name === adapter.name);
  ui.doctor.hidden = !(p && p.category === 'Public');
  if (!ui.doctor.hidden) ui.doctor.replaceChildren(
    h('span', { html: svg('shield') }),
    h('div', { class: 'grow' }, h('b', {}, 'Windows marks this network as Public.'), h('div', { class: 'muted' }, 'Phones may be blocked by the firewall. If your phone can\'t connect, set this network to Private (only do this on your own home network).')),
    h('button', { class: 'btn small', onclick: () => api.openNetworkSettings() }, 'Network settings'));
}

const randomPin = () => String(Math.floor(1000 + Math.random() * 9000));
const fmtRate = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB/s` : b > 1e3 ? `${Math.round(b / 1e3)} KB/s` : 'idle');

function latestResume(path) {
  const k = fileKey(path), a = settings.resume[k], b = settings.remoteResume?.[k];
  const r = !a ? b : !b ? { ...a, dev: 'PC' } : b.at > a.at ? b : { ...a, dev: 'PC' };
  return r && r.t > 10 ? { t: r.t, dev: r.dev || 'PC' } : null;
}

function currentFor(player) {
  const it = player.current();
  // nothing private ever reaches a phone while the vault is locked
  if (!it || !it.info?.duration && !it.info?.isImage || isHidden(it.path)) return null;
  return {
    path: it.path, playPath: it.playPath, name: it.name, isImage: !!it.info.isImage, rightEye: it.info.photo?.rightEye || null,
    duration: it.info.duration, width: it.info.width, height: it.info.height, codec: it.info.codec,
    format: it.format, calib: it.calib, level: it.level, subs: player.subs.cues.slice(0, 5000),
    resume: latestResume(it.path),
    chapters: (player.chapters?.() || []).slice(0, 300).map((c) => ({ t: c.t, name: String(c.name || '').slice(0, 80) })),
    // the next few videos (never private ones while the vault is locked), for phones with control
    upNext: (player.playlist?.() || []).map((p, i) => ({ i, name: p.name, path: p.path })).filter((p) => p.i > (player.index?.() ?? -1) && !isHidden(p.path)).slice(0, 12).map(({ i, name }) => ({ i, name }))
  };
}

async function startStream() {
  ui.startBtn.disabled = true;
  try {
    if (settings.phonePinOn && !/^\d{4,8}$/.test(ui.pinIn.value)) { toast('The PIN must be 4 to 8 digits.', 'err'); return; }
    info = await api.phoneStart({ pin: settings.phonePinOn ? ui.pinIn.value : null, approve: settings.phoneApprove !== false, quality: settings.phoneQuality || 'auto',
      linkExpireMin: settings.phoneLinkExpire ?? 10, idleStopMin: settings.phoneIdleStop ?? 30 });
    renderLog(info.log || []);
    const player = (await import('./player.js')).player;
    api.phoneCurrent(currentFor(player));
    sfx.play('success');
  } catch (e) {
    toast('Could not start the phone stream: ' + String(e.message).replace(/.*Error: /, ''), 'err');
  } finally { ui.startBtn.disabled = false; render(); }
}
async function stopStream() { await api.phoneStop(); info = { running: false }; devices = []; render(); renderDevices(); }
async function newLink() {
  if (!info.running) return;
  info = await api.phoneRotate();
  toast('New link made. Everyone was disconnected.', 'ok');
  render();
}

function render() {
  ui.startBtn.innerHTML = svg('phone') + (info.running ? 'Stop phone stream' : 'Start phone stream');
  ui.startBtn.className = 'btn wide ' + (info.running ? 'danger' : 'primary');
  ui.qr.replaceChildren(info.running
    ? h('img', { src: info.qr, class: 'qr', alt: 'QR code for the phone link' })
    : h('div', { class: 'qr-empty', html: svg('phone') + '<span>Start the stream to get a QR code</span>' }));
  ui.link.value = info.running ? info.url : '';
  ui.pair.hidden = !info.running || !info.pairCode;
  if (info.pairCode) { ui.pairUrl.textContent = info.pairUrl; ui.pairCode.textContent = info.pairCode.slice(0, 3) + ' ' + info.pairCode.slice(3); }
  const ads = info.running ? info.adapters || [] : [];
  ui.netRow.hidden = ads.length < 2;
  ui.net.replaceChildren(...ads.map((a) => h('option', { value: a.address }, `${a.name} · ${a.address}`)));
  if (info.ip) ui.net.value = info.ip;
  if (info.running) checkNetwork(ads.find((a) => a.address === info.ip) || ads[0]);
  else ui.doctor.hidden = true;
  ui.lock.set(!!info.locked);
  ui.caQr.replaceChildren(info.running && info.caQr ? h('img', { src: info.caQr, class: 'qr', alt: 'QR code for this PC\'s certificate' }) : h('div', { class: 'qr-empty small', html: svg('shield') + '<span>Start the stream to show this code</span>' }));
  ui.caFp.textContent = info.caFingerprint ? info.caFingerprint.slice(0, 47) + '…' : '—';
  ui.qr.classList.toggle('locked', !!(info.running && info.locked));
  if (info.running && info.locked) ui.qr.append(h('div', { class: 'qr-lock', html: svg('lock') + '<span>Locked: no new phones</span>' }));
  emit('phone-running', info.running);
}

function renderDevices() {
  const active = devices.filter((d) => d.status === 'ok');
  document.body.classList.toggle('phone-live', active.some((d) => d.online));
  if (!devices.length) { ui.list.replaceChildren(h('div', { class: 'empty-note' }, info.running ? 'No phones yet. Scan the QR code to connect one.' : 'Start the stream to connect a phone.')); return; }
  ui.list.replaceChildren(...devices.map((d) => h('div', { class: 'device' + (d.online ? ' online' : '') },
    h('span', { class: 'dev-ic', html: svg('phone') }),
    h('div', { class: 'grow' }, h('b', {}, d.name), h('div', { class: 'muted' },
      `${d.ip} · ${d.status === 'ok' ? (d.mode === 'remote' ? 'Remote control' : `Watching · ${fmtTime(d.position)}`) : d.status === 'pin' ? 'Entering PIN' : 'Waiting for approval'} · ${d.online ? 'online' : 'away'}`)),
    d.status === 'ok' ? h('label', { class: 'ctl-toggle', title: 'Let this phone control playback on this PC' }, h('span', {}, 'Control'), controlToggle(d)) : null,
    d.status === 'ok' ? h('label', { class: 'ctl-toggle', title: 'Let this phone save videos for offline viewing' }, h('span', {}, 'Download'), downloadToggle(d)) : null,
    d.status === 'pending' ? h('button', { class: 'btn primary', onclick: () => api.phoneDecide(d.id, true) }, 'Allow') : null,
    h('button', { class: 'btn danger', onclick: () => (d.status === 'pending' ? api.phoneDecide(d.id, false) : api.phoneKick(d.id)) }, d.status === 'pending' ? 'Deny' : 'Remove'))));
}

function controlToggle(d) {
  const t = toggle(d.canControl, (v) => api.phoneControl(d.id, v));
  t.classList.add('small');
  return t;
}

function downloadToggle(d) {
  // the switch is a standing permission; the pop-up's Allow is just for that one video
  const t = toggle(d.canDownload, (v) => api.phoneDownload(d.id, v, true));
  t.classList.add('small');
  return t;
}

function askDownload(d) {
  sfx.play('pop');
  const key = 'dl:' + d.id;
  closePrompt(key);
  const size = d.size >= 1e9 ? (d.size / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(d.size / 1e6)) + ' MB';
  const m = modal({ onClose: () => prompts.delete(key), title: 'A phone wants to download a video', width: 420, body: [
    h('p', {}, h('b', {}, d.name), ` (${d.ip}) wants to save `, h('b', {}, d.title), ` for offline viewing.`),
    h('p', { class: 'muted' }, d.kind === 'phone' ? `Phone size: this PC makes a 1080p copy first (about ${size}).` : `Original file, full quality (${size}).`),
    h('p', { class: 'muted' }, 'Once it\'s on the phone, it stays there. Allow it only for people you\'re happy to give a copy to.'),
    h('div', { class: 'inline' },
      h('button', { class: 'btn primary', onclick: () => { api.phoneDownload(d.id, true, false); m.close(); } }, 'Allow this video'),
      h('button', { class: 'btn', title: 'Let this phone download any video you open, without asking each time', onclick: () => { api.phoneDownload(d.id, true, true); m.close(); } }, 'Always allow this phone'),
      h('button', { class: 'btn danger', onclick: () => { api.phoneDownload(d.id, false, false); m.close(); } }, 'Deny'))] });
  prompts.set(key, m);
}

function closePrompt(id) { const m = prompts.get(id); if (m) { prompts.delete(id); m.close(); } }

function askApproval(d) {
  sfx.play('pop');
  closePrompt(d.id);
  const m = modal({ onClose: () => prompts.delete(d.id), title: 'A phone wants to watch', width: 400, body: [
    h('p', {}, h('b', {}, d.name), ` (${d.ip}) opened your stream link.`),
    h('p', { class: 'muted' }, 'Allow it only if it\'s your phone or someone you gave the link to.'),
    h('div', { class: 'inline' },
      h('button', { class: 'btn primary', onclick: () => { api.phoneDecide(d.id, true); m.close(); } }, 'Allow'),
      h('button', { class: 'btn', title: 'Next time it can reconnect from a bookmark without a code, and you won\'t be asked again. Forget it any time under Safety.', onclick: async () => { await api.phoneDecide(d.id, true, true); m.close(); renderTrusted(); } }, 'Allow & remember'),
      h('button', { class: 'btn danger', onclick: () => { api.phoneDecide(d.id, false); m.close(); } }, 'Deny'))] });
  prompts.set(d.id, m);
}

function askControl(d) {
  sfx.play('pop');
  closePrompt(d.id);
  const m = modal({ onClose: () => prompts.delete(d.id), title: 'A phone wants to control this PC', width: 400, body: [
    h('p', {}, h('b', {}, d.name), ` (${d.ip}) wants to use Remote mode.`),
    h('p', { class: 'muted' }, 'It will be able to play, pause, seek, change the volume and look around in the video on this PC. You can turn this off again in Connected Devices.'),
    h('div', { class: 'inline' },
      h('button', { class: 'btn primary', onclick: () => { api.phoneControl(d.id, true); m.close(); } }, 'Allow'),
      h('button', { class: 'btn danger', onclick: () => { api.phoneControl(d.id, false); m.close(); } }, 'Deny'))] });
  prompts.set(d.id, m);
}

function renderLog(list) {
  if (!ui.log) return;
  if (!list.length) { ui.log.replaceChildren(h('div', { class: 'empty-note' }, 'Nothing yet.')); return; }
  const t = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  ui.log.replaceChildren(...list.slice(0, 12).map((e) => h('div', { class: 'log-row ' + e.kind }, h('span', { class: 'log-t' }, t(e.at)), h('span', {}, e.text))));
}

// Remote mode: the phone drives the PC player
function remoteCommand(player, { cmd, value }) {
  const v = player.video;
  if (cmd === 'play' && Number.isInteger(value)) return player.playAt?.(value);
  if (cmd === 'seek' && isFinite(value)) return player.seekTo(value);
  if (cmd === 'toggle') player.togglePlay();
  else if (cmd === 'back') player.seekBy(-10);
  else if (cmd === 'fwd') player.seekBy(10);
  else if (cmd === 'next') player.next();
  else if (cmd === 'prev') player.prev();
  else if (cmd === 'view') player.cycleView();
  else if (cmd === 'recenter') player.view.reset();
  else if (cmd === 'volup') v.volume = Math.min(1, v.volume + 0.1);
  else if (cmd === 'voldown') v.volume = Math.max(0, v.volume - 0.1);
  else if (cmd === 'look' && value) player.view.look((+value.dx || 0) * 0.005, (+value.dy || 0) * 0.005);
}
