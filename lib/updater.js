// Auto-update from GitHub Releases (installed copy only; the portable .exe can't replace itself)
const { app } = require('electron');
const pkg = require('../package.json');

const SIX_HOURS = 6 * 60 * 60 * 1000;
let send = () => {};
let updater = null;
let status = { state: 'idle' };
let timer = null;

function publishConfig() {
  // packaged builds drop package.json's "build" section; electron-builder writes app-update.yml instead
  if (app.isPackaged) {
    try {
      const yml = require('fs').readFileSync(require('path').join(process.resourcesPath, 'app-update.yml'), 'utf8');
      return /YOUR-/i.test(yml) ? null : { yml };
    } catch { return null; }
  }
  const p = pkg.build && pkg.build.publish;
  const cfg = Array.isArray(p) ? p[0] : p;
  if (!cfg || !cfg.owner || !cfg.repo || /YOUR-/i.test(cfg.owner + cfg.repo)) return null;
  return cfg;
}

function set(next) {
  status = { ...next, at: Date.now() };
  send('update-status', status);
}

function init(sender) {
  send = sender;
  const testFeed = process.env.VR180_UPDATE_FEED; // local feed used by the test harness
  if (process.env.PORTABLE_EXECUTABLE_DIR) return set({ state: 'unsupported', reason: 'portable' });
  if (!testFeed && !app.isPackaged) return set({ state: 'unsupported', reason: 'dev' });
  if (!testFeed && !publishConfig()) return set({ state: 'unsupported', reason: 'not-configured' });

  try { ({ autoUpdater: updater } = require('electron-updater')); } catch (e) { return set({ state: 'error', error: e.message }); }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = null;
  if (testFeed) {
    const cfg = require('path').join(app.getPath('temp'), 'vr180-test-update.yml');
    require('fs').writeFileSync(cfg, `provider: generic\nurl: ${testFeed}\nupdaterCacheDirName: vr180-player-updater-test\n`);
    updater.forceDevUpdateConfig = true;
    updater.updateConfigPath = cfg;
  }
  updater.on('checking-for-update', () => set({ state: 'checking' }));
  updater.on('update-not-available', () => set({ state: 'latest', version: app.getVersion() }));
  updater.on('update-available', (i) => set({ state: 'downloading', version: i.version, percent: 0 }));
  updater.on('download-progress', (p) => set({ state: 'downloading', version: status.version, percent: Math.round(p.percent), speed: p.bytesPerSecond }));
  updater.on('update-downloaded', (i) => set({ state: 'ready', version: i.version, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes.replace(/<[^>]+>/g, '').slice(0, 400) : '' }));
  updater.on('error', (e) => set(/No published versions/i.test(String(e && e.message)) ? { state: 'latest', version: app.getVersion() } : { state: 'error', error: friendly(e) }));

  setTimeout(check, 8000); // let the app settle first
  timer = setInterval(check, SIX_HOURS);
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(m)) return 'No internet connection';
  if (/404/.test(m)) return 'No releases published yet';
  return m.split('\n')[0].slice(0, 160);
}

function check() {
  if (!updater) return Promise.resolve(status);
  if (status.state === 'downloading' || status.state === 'ready') return Promise.resolve(status);
  return updater.checkForUpdates().then(() => status, () => status); // failures arrive through the 'error' event
}

function install() {
  if (!updater || status.state !== 'ready') return false;
  setImmediate(() => updater.quitAndInstall(false, true));
  return true;
}

function stop() { clearInterval(timer); }

module.exports = { init, check, install, stop, status: () => status };
