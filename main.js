const { app, BrowserWindow, ipcMain, dialog, protocol, Menu, shell, screen, Notification, clipboard, powerSaveBlocker, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// A separate profile lets two copies run side by side (e.g. testing Watch Together)
if (process.env.VR180_PROFILE) app.setPath('userData', path.join(app.getPath('appData'), 'VR180 Player', process.env.VR180_PROFILE));

const store = require('./lib/store');
const settings = store.init(app.getPath('userData'));

// Hardware video decoding: HEVC/H.265 and GPU zero-copy for smooth high-res playback
if (settings.hwDecode !== false) {
  app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,D3D11VideoDecoderAV1');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// lets the player switch between a file's audio tracks (video.audioTracks)
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

const ff = require('./lib/ffmpeg');
const { analyze } = require('./lib/detect');
const library = require('./lib/library');
const vault = require('./lib/vault');
const together = require('./lib/together');
const subs = require('./lib/subs');
const queue = require('./lib/queue');
const { autoAlign } = require('./lib/align');
const level = require('./lib/level');
const encoders = require('./lib/encoders');
const phone = require('./lib/phone');
const dupes = require('./lib/dupes');
const highlights = require('./lib/highlights');
const backup = require('./lib/backup');
const updater = require('./lib/updater');
const models = require('./lib/models');
const importer = require('./lib/importer');
const ai = require('./lib/ai');

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
]);

let win;
let launchPaths = [];
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac' };

// Serves local files with HTTP range support so the <video> element can seek,
// and with CORS headers so WebGL can sample the frames.
function registerMediaProtocol() {
  protocol.handle('media', async (req) => {
    const filePath = decodeURIComponent(new URL(req.url).searchParams.get('p') || '');
    let stat;
    try { stat = fs.statSync(filePath); } catch { return new Response('Not found', { status: 404 }); }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    const range = req.headers.get('range');
    let start = 0, end = stat.size - 1, status = 200;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1]) start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), stat.size - 1);
        if (!m[1] && m[2]) { start = stat.size - parseInt(m[2], 10); end = stat.size - 1; }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      }
    }
    headers['Content-Length'] = String(end - start + 1);
    const nodeStream = fs.createReadStream(filePath, { start, end, highWaterMark: 1 << 20 });
    const body = new ReadableStream({
      start(ctrl) {
        nodeStream.on('data', (c) => { ctrl.enqueue(new Uint8Array(c)); if (ctrl.desiredSize <= 0) nodeStream.pause(); });
        nodeStream.on('end', () => ctrl.close());
        nodeStream.on('error', (e) => ctrl.error(e));
      },
      pull() { nodeStream.resume(); },
      cancel() { nodeStream.destroy(); }
    }, { highWaterMark: 8 });
    return new Response(body, { status, headers });
  });
}

const send = (ch, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...args); };

function createWindow() {
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 820, x: b.x, y: b.y, minWidth: 900, minHeight: 600,
    frame: false,
    backgroundColor: '#101010',
    title: 'VR180 Player',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (b.maximized) win.maximize(); win.show(); });
  win.on('enter-full-screen', () => send('fullscreen-changed', true));
  win.on('leave-full-screen', () => send('fullscreen-changed', false));
  win.on('maximize', () => send('maximized-changed', true));
  win.on('unmaximize', () => send('maximized-changed', false));
  win.on('minimize', () => send('minimized'));
  win.on('close', () => {
    if (!win.isFullScreen()) store.set({ bounds: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'I' && input.control && input.shift) win.webContents.toggleDevTools();
  });
  // Open a file passed on the command line (e.g. "Open with")
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /\.(mp4|mov|m4v|mkv|webm|avi|jpe?g|png|webp)$/i.test(a));
  launchPaths = arg ? [path.resolve(arg)] : [];
}

// Temp folders left behind by a crash or a forced quit (phone streams, phone copies, jobs, analysis)
// ---------------------------------------------------------------- long jobs
// The PC doesn't fall asleep while jobs run, the taskbar button shows the progress, and
// "When done" can put the PC to sleep or shut it down (after a minute you can cancel).
let awake = null, doneTimer = null;
function onQueue(list) {
  const busy = list.some((j) => j.status === 'running' || j.status === 'queued');
  if (busy && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && awake !== null) { powerSaveBlocker.stop(awake); awake = null; }
  const r = list.find((j) => j.status === 'running');
  if (win && !win.isDestroyed()) win.setProgressBar(r ? Math.max(0.02, r.fraction || 0) : -1);
}
function whenDone() {
  const act = store.get().whenDone;
  if (act !== 'sleep' && act !== 'shutdown') return;
  store.set({ whenDone: 'nothing' });     // one time only
  send('when-done', { action: act, seconds: 60 });
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => powerAction(act), 60000);
}
function powerAction(act) {
  doneTimer = null;
  if (process.env.VR180_DRYRUN_POWER) { console.log('[power] would ' + act); return; }
  const { execFile } = require('child_process');
  if (act === 'shutdown') execFile('shutdown.exe', ['/s', '/t', '0'], { windowsHide: true });
  else execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)'], { windowsHide: true });
}
// Taskbar thumbnail buttons (previous / play-pause / next) and the recent-files jump list
const thumbIcon = (n) => nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icons', `thumb-${n}.png`));
let thumbs = null;
function setThumbs(s) {
  if (!win || win.isDestroyed() || process.platform !== 'win32') return;
  const key = JSON.stringify(s);
  if (key === thumbs) return;
  thumbs = key;
  if (!s || !s.loaded) { win.setThumbarButtons([]); return; }
  win.setThumbarButtons([
    { tooltip: 'Previous', icon: thumbIcon('prev'), flags: s.hasPrev ? ['enabled'] : ['disabled'], click: () => send('thumb', 'prev') },
    { tooltip: s.playing ? 'Pause' : 'Play', icon: thumbIcon(s.playing ? 'pause' : 'play'), click: () => send('thumb', 'toggle') },
    { tooltip: 'Next', icon: thumbIcon('next'), flags: s.hasNext ? ['enabled'] : ['disabled'], click: () => send('thumb', 'next') }
  ]);
}
ipcMain.handle('thumb-state', (_e, s) => setThumbs(s));
ipcMain.handle('add-recent', (_e, file) => { try { app.addRecentDocument(file); } catch {} });

ipcMain.handle('when-done-cancel', () => { const was = !!doneTimer; clearTimeout(doneTimer); doneTimer = null; return was; });
ipcMain.handle('test-output', (_e, name) => {
  const dir = path.join(require('os').tmpdir(), 'vr180-job-test-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
});

function cleanStaleTemp() {
  const tmp = require('os').tmpdir();
  let names = [];
  try { names = fs.readdirSync(tmp); } catch {}
  for (const n of names) {
    if (!/^vr180-(phone|dl|job|hl|render|ai)-/.test(n)) continue;
    const p = path.join(tmp, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60000) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

app.whenReady().then(() => {
  setTimeout(cleanStaleTemp, 5000);
  registerMediaProtocol();
  library.init(app.getPath('userData'));
  models.init(app.getPath('userData'));
  importer.init(send, app.getPath('userData'));
  ai.init(app.getPath('userData'));
  together.init(send);
  queue.init((ch, data) => { send(ch, data); if (ch === 'queue') onQueue(data); }, (count) => {
    if (Notification.isSupported() && !win?.isFocused()) new Notification({ title: 'VR180 Player', body: `Finished ${count} job${count === 1 ? '' : 's'}` }).show();
    whenDone();
  }, app.getPath('userData'));
  encoders.detect(); // find working GPU encoders in the background
  phone.init(send, app.getPath('userData'));
  updater.init(send);
  if (settings.togetherName) together.setName(settings.togetherName);
  createWindow();
});
app.on('window-all-closed', () => { updater.stop(); phone.stop(); phone.cleanupSync?.(); queue.shutdown(); ff.cancelAll(); together.leave(); library.flush(); store.flush(); app.quit(); });

// ---- window controls
ipcMain.handle('win', (_e, action) => {
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (action === 'close') win.close();
  else if (action === 'pin') { userPinned = !userPinned; if (!mini) win.setAlwaysOnTop(userPinned, 'floating'); }
  else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  else if (action === 'exit-fullscreen') win.setFullScreen(false);
  else if (action === 'enter-fullscreen') win.setFullScreen(true);
  else if (action === 'mini') toggleMini();
  return { pinned: userPinned, fullscreen: win.isFullScreen(), maximized: win.isMaximized(), mini: !!mini };
});

// ---- mini-player: small always-on-top window in the corner
let mini = null;
let userPinned = false; // the pin button's state, kept separately so the mini-player can restore it
function animateBounds(to, ms = 200) {
  const from = win.getBounds();
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const k = Math.min(1, (Date.now() - start) / ms), e = 1 - Math.pow(1 - k, 3);
      const lerp = (a, b) => Math.round(a + (b - a) * e);
      win.setBounds({ x: lerp(from.x, to.x), y: lerp(from.y, to.y), width: lerp(from.width, to.width), height: lerp(from.height, to.height) });
      k < 1 ? setTimeout(tick, 12) : resolve();
    };
    tick();
  });
}
async function toggleMini() {
  if (!mini) {
    if (win.isFullScreen()) { win.setFullScreen(false); await new Promise((r) => setTimeout(r, 400)); }
    mini = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    if (mini.maximized) win.unmaximize();
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    send('mini-changed', true);
    win.setMinimumSize(320, 180);
    await animateBounds({ x: wa.x + wa.width - 480 - 16, y: wa.y + wa.height - 270 - 16, width: 480, height: 270 });
    win.setAspectRatio(16 / 9);
    win.setAlwaysOnTop(true, 'floating');
  } else {
    const m = mini;
    mini = null;
    win.setAspectRatio(0);
    win.setAlwaysOnTop(userPinned, 'floating');
    send('mini-changed', false);
    await animateBounds(m.bounds);
    win.setMinimumSize(900, 600);
    if (m.maximized) win.maximize();
  }
}

// ---- settings
ipcMain.handle('settings-get', () => store.get());
ipcMain.handle('settings-set', (_e, patch) => { store.set(patch); return true; });
ipcMain.handle('app-info', () => ({ version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, userData: app.getPath('userData') }));
ipcMain.handle('update-status', () => updater.status());
ipcMain.handle('update-check', () => updater.check());
ipcMain.handle('update-install', () => { store.flush(); phone.stop(); queue.shutdown(); return updater.install(); });
ipcMain.handle('relaunch', () => { store.flush(); app.relaunch(); app.exit(0); });

// ---- files
const VIDEO_FILTERS = [
  { name: 'Videos and photos', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'jpg', 'jpeg', 'png', 'webp'] },
  { name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'] },
  { name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
  { name: 'All files', extensions: ['*'] }];
ipcMain.handle('music-dialog', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Music', extensions: ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac'] }] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('open-dialog', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: VIDEO_FILTERS });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('folder-dialog', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('save-dialog', async (_e, suggested) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: suggested, filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('launch-paths', () => { const p = launchPaths; launchPaths = []; return p; });
ipcMain.handle('analyze', (_e, file) => analyze(file));
ipcMain.handle('exists', (_e, file) => fs.existsSync(file));
ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));
ipcMain.handle('highlights', async (_e, file, target) => {
  const info = await require('./lib/detect').analyze(file);
  const a = await highlights.analyze(file, info, (p) => send('highlights-progress', p), 'highlights');
  return { ...highlights.pick(a, info.duration, target), duration: info.duration };
});
// ---- settings backup (a file path can be passed in directly; otherwise a dialog asks)
let pendingBackup = null;
ipcMain.handle('backup-export', async (_e, file) => {
  store.flush();
  if (!file) {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), `VR180 Player settings ${new Date().toISOString().slice(0, 10)}.vr180backup`), filters: [{ name: 'VR180 Player backup', extensions: ['vr180backup'] }] });
    if (r.canceled || !r.filePath) return null;
    file = r.filePath;
  }
  const b = backup.build(store.get(), app.getVersion());
  fs.writeFileSync(file, JSON.stringify(b));
  return { file, summary: backup.summarize(b) };
});
ipcMain.handle('backup-open', async (_e, file) => {
  if (!file) {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'VR180 Player backup', extensions: ['vr180backup'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    file = r.filePaths[0];
  }
  pendingBackup = backup.parse(fs.readFileSync(file, 'utf8'));
  return backup.summarize(pendingBackup);
});
ipcMain.handle('backup-apply', (_e, mode) => {
  if (!pendingBackup) throw new Error('No backup opened');
  store.replace(backup.apply(pendingBackup, store.get(), mode === 'replace' ? 'replace' : 'merge', app.getPath('userData')));
  pendingBackup = null;
  return true;
});
ipcMain.handle('dupes-find', (_e, list) => dupes.find(list, (p) => send('dupes-progress', p)));
// Recycle Bin only (restorable), and only for files inside the library's folders
ipcMain.handle('trash-items', async (_e, paths) => {
  const roots = (store.get().folders || []).map((f) => path.resolve(f.path).toLowerCase().replace(/[\\/]*$/, path.sep));
  const out = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!roots.some((r) => abs.toLowerCase().startsWith(r))) { out.push({ path: p, ok: false, error: 'not in a library folder' }); continue; }
    try { await shell.trashItem(abs); out.push({ path: p, ok: true }); } catch (e) { out.push({ path: p, ok: false, error: e.message }); }
  }
  return out;
});
ipcMain.handle('save-snapshot', async (_e, dataUrl, baseName) => {
  const dir = path.join(app.getPath('pictures'), 'VR180 Player');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${baseName.replace(/[^\w.-]+/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
});

// ---- conversion
ipcMain.handle('make-proxy', (_e, id, file) => ff.makeProxy(file, (p) => send('progress', id, p), id));
ipcMain.handle('convert', (_e, id, opts) => ff.convertToVR180(opts, (p) => send('progress', id, p), id));
ipcMain.handle('cancel', (_e, id) => ff.cancel(id));
ipcMain.handle('queue-add', (_e, list) => queue.add(list));
ipcMain.handle('queue-cancel', (_e, id) => queue.cancel(id));
ipcMain.handle('queue-remove', (_e, id) => queue.remove(id));
ipcMain.handle('queue-retry', (_e, id) => queue.retry(id));
ipcMain.handle('queue-report', (_e, id) => queue.report(id));
ipcMain.handle('queue-clear', () => queue.clearFinished());
ipcMain.handle('queue-list', () => queue.list());
ipcMain.handle('queue-recovery', () => queue.recovery());
ipcMain.handle('queue-resume', () => queue.resumeRecovered());
ipcMain.handle('queue-discard', () => queue.discardRecovered());
ipcMain.handle('encoders', () => encoders.detect());

// Camera / memory-card import
ipcMain.handle('import-watch', (_e, on) => importer.watch(!!on));
// which camera made a file (for per-camera calibration)
ipcMain.handle('camera-of', async (_e, file) => { const t = require('./lib/tags'); return t.camera(await t.readMeta(file), path.basename(file)); });
ipcMain.handle('import-scan', (_e, root) => importer.scan(root));
ipcMain.handle('import-run', (_e, id, job) => importer.run(id, job, (p) => send('import-progress', id, p)));
ipcMain.handle('import-cancel', (_e, id) => importer.cancel(id));
ipcMain.handle('import-default-dest', () => path.join(app.getPath('videos'), 'VR180 Player', 'Imported'));

// Optional AI add-ons (downloaded only when you click Install)
ipcMain.handle('ai-status', () => models.status());
ipcMain.handle('ai-install', async (_e, pack) => { await models.install(pack, (p) => send('ai-progress', p)); return models.status(); });
ipcMain.handle('ai-cancel', (_e, pack) => models.cancel(pack));
ipcMain.handle('ai-remove', (_e, pack) => { models.remove(pack); return models.status(); });
ipcMain.handle('ai-paths', () => models.paths());

// ---- phone player
ipcMain.handle('phone-start', (_e, opts) => phone.start(opts));
ipcMain.handle('phone-stop', () => phone.stop());
ipcMain.handle('phone-rotate', () => phone.rotate());
ipcMain.handle('phone-options', (_e, o) => phone.setOptions(o));
ipcMain.handle('phone-info', () => phone.info());
ipcMain.handle('phone-current', (_e, item) => phone.setCurrent(item));
ipcMain.handle('phone-pcstate', (_e, s) => phone.setPcState(s));
ipcMain.handle('phone-kick', (_e, id) => phone.kick(id));
ipcMain.handle('phone-decide', (_e, id, allow, remember) => phone.decide(id, allow, !!remember));
ipcMain.handle('phone-trusted', () => phone.trustedList());
ipcMain.handle('phone-forget', (_e, id) => phone.forgetTrusted(id));
ipcMain.handle('phone-control', (_e, id, allow) => phone.setControl(id, allow));
// Connection doctor: Windows "Public" networks block incoming connections from phones
ipcMain.handle('phone-doctor', () => new Promise((resolve) => {
  const ps = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress'], { windowsHide: true });
  let out = '';
  const t = setTimeout(() => ps.kill(), 8000);
  ps.stdout.on('data', (d) => (out += d));
  ps.on('close', () => {
    clearTimeout(t);
    try {
      const list = [].concat(JSON.parse(out || '[]')).map((p) => ({ name: p.InterfaceAlias, category: ['Public', 'Private', 'DomainAuthenticated'][p.NetworkCategory] ?? String(p.NetworkCategory) }));
      resolve({ profiles: list });
    } catch { resolve({ profiles: [] }); }
  });
  ps.on('error', () => resolve({ profiles: [] }));
}));
ipcMain.handle('open-network-settings', () => shell.openExternal('ms-settings:network-status'));
ipcMain.handle('phone-download', (_e, id, allow, always) => phone.allowDownload(id, allow, !!always));

// ---- horizon level analysis (cancellable, with progress)
const levelJobs = new Map();
ipcMain.handle('level-analyze', async (_e, id, file, format, duration) => {
  const job = { cancelled: false };
  levelJobs.set(id, job);
  try {
    return await level.analyze(file, format, duration, (f) => send('progress', id, { fraction: f }), () => job.cancelled);
  } finally { levelJobs.delete(id); }
});
ipcMain.handle('level-cancel', (_e, id) => { const j = levelJobs.get(id); if (j) j.cancelled = true; });

// ---- LUTs
ipcMain.handle('lut-dialog', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '3D LUT', extensions: ['cube'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('read-text', (_e, file) => fs.promises.readFile(file, 'utf8'));
// built-in LUTs are generated by the renderer and saved here so exports can use them too
ipcMain.handle('lut-save', (_e, name, text) => {
  const dir = path.join(app.getPath('userData'), 'luts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name.replace(/[^\w-]+/g, '_') + '.cube');
  fs.writeFileSync(file, text);
  return file;
});

// ---- subtitles, alignment, previews
ipcMain.handle('subs-find', (_e, file) => subs.find(file));
ipcMain.handle('subs-extract', (_e, file, index) => subs.extract(file, index));
ipcMain.handle('subs-read', (_e, file) => subs.read(file));
ipcMain.handle('subs-dialog', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('align', (_e, file, format, duration) => autoAlign(file, format, duration));
ipcMain.handle('sprite', (_e, file, format, duration) => library.sprite(file, format, duration));
ipcMain.handle('copy-text', (_e, text) => clipboard.writeText(text));

// ---- library & vault
ipcMain.handle('library-scan', (_e, folder) => library.scan(folder));
ipcMain.handle('library-details', (_e, file) => library.details(file));
ipcMain.handle('vault-has-pin', () => vault.hasPin());
ipcMain.handle('vault-set-pin', (_e, pin, oldPin) => vault.setPin(pin, oldPin));
ipcMain.handle('vault-verify', (_e, pin) => vault.verify(pin));
ipcMain.handle('vault-clear', (_e, pin) => vault.clearPin(pin));

// ---- watch together
ipcMain.handle('together-host', (_e, name, opts) => together.host(name, opts));
ipcMain.handle('together-join', (_e, address, name, secret) => together.join(address, name, secret));
ipcMain.handle('together-decide', (_e, id, allow) => together.decide(id, allow));
ipcMain.handle('together-approve-setting', (_e, on) => together.setApprove(on));
ipcMain.handle('together-leave', () => together.leave());
ipcMain.handle('together-send', (_e, msg) => together.send(msg));
ipcMain.handle('together-status', () => together.status());
