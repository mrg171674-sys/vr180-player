// Settings backup: one .vr180backup file with your settings, presets, custom colour
// looks (LUT files), shortcuts, tags, ratings and watch history. Left out on purpose:
// the vault and anything in private folders, the phone PIN, and certificates.
const fs = require('fs');
const path = require('path');

const FORMAT = 'vr180-player-backup';
const LEFT_OUT = ['vaultOn', 'vaultAutoLock', 'phonePin', 'bounds', 'maximized'];
const MAX_LUT = 10 * 1024 * 1024;

const isPathKey = (k) => /^[a-z]:[\\/]|^\\\\|^\//i.test(k);
const privateRoots = (settings) => (settings.folders || []).filter((f) => f.private).map((f) => f.path.toLowerCase().replace(/[\\/]+$/, ''));
const inPrivate = (p, roots) => roots.some((r) => p.toLowerCase().startsWith(r + '\\') || p.toLowerCase().startsWith(r + '/'));

// every { lut: "C:\\…\\x.cube" } in the settings, wherever it is
function walkLuts(obj, fn) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'lut' && typeof v === 'string' && v && !v.startsWith('builtin:')) obj[k] = fn(v) ?? v;
    else if (v && typeof v === 'object') walkLuts(v, fn);
  }
}

function build(settings, appVersion) {
  const roots = privateRoots(settings);
  const out = {};
  for (const [k, v] of Object.entries(settings)) {
    if (LEFT_OUT.includes(k)) continue;
    if (k === 'folders') { out.folders = v.filter((f) => !f.private).map((f) => ({ path: f.path, private: false })); continue; }
    if (k === 'recent') { out.recent = (v || []).filter((p) => !inPrivate(p, roots)); continue; }
    // per-video maps (calibration, chapters, history, tags…): drop entries in private folders
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).some(isPathKey)) {
      out[k] = Object.fromEntries(Object.entries(v).filter(([p]) => !isPathKey(p) || !inPrivate(p, roots)));
      continue;
    }
    out[k] = v;
  }
  const copy = JSON.parse(JSON.stringify(out));
  const luts = {};
  walkLuts(copy, (file) => {
    try {
      const st = fs.statSync(file);
      if (st.size <= MAX_LUT && !luts[file]) luts[file] = fs.readFileSync(file).toString('base64');
    } catch {}
  });
  return { format: FORMAT, version: 1, appVersion, createdAt: new Date().toISOString(), settings: copy, luts };
}

function summarize(b) {
  const s = b.settings || {};
  const count = (o) => (o ? Object.keys(o).length : 0);
  return {
    createdAt: b.createdAt, appVersion: b.appVersion,
    folders: (s.folders || []).length,
    presets: (s.picturePresets || []).length,
    luts: count(b.luts),
    calibrated: count(s.calib),
    tagged: Object.values(s.meta || {}).filter((m) => m.tags?.length || m.fav || m.rating).length,
    history: count(s.resume) + count(s.remoteResume),
    shortcuts: count(s.keymap) + count(s.padmap),
    theme: s.theme || 'midnight'
  };
}

function parse(text) {
  let b;
  try { b = JSON.parse(text); } catch { throw new Error('This file isn\'t a VR180 Player backup.'); }
  if (!b || b.format !== FORMAT || !b.settings || typeof b.settings !== 'object') throw new Error('This file isn\'t a VR180 Player backup.');
  return b;
}

// mode 'merge': backup wins for what it contains, your other settings stay;
// mode 'replace': start from the backup only (your vault and phone PIN are kept)
function apply(b, current, mode, userData) {
  const incoming = JSON.parse(JSON.stringify(b.settings));
  for (const k of LEFT_OUT) delete incoming[k];
  // restore LUT files into this PC's userData and point the settings at them
  const dir = path.join(userData, 'luts', 'imported');
  const moved = {};
  for (const [orig, data] of Object.entries(b.luts || {})) {
    fs.mkdirSync(dir, { recursive: true });
    let name = path.basename(orig).replace(/[^\w .()-]/g, '_') || 'look.cube';
    let file = path.join(dir, name);
    for (let i = 2; fs.existsSync(file) && fs.readFileSync(file).toString('base64') !== data; i++) file = path.join(dir, name.replace(/(\.cube)?$/i, ` (${i}).cube`));
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    moved[orig] = file;
  }
  walkLuts(incoming, (file) => moved[file]);

  const keep = Object.fromEntries(LEFT_OUT.filter((k) => k in current).map((k) => [k, current[k]]));
  if (mode === 'replace') {
    // private folders stay (they're never in a backup), so the vault keeps working
    const priv = (current.folders || []).filter((f) => f.private);
    return { ...incoming, ...keep, folders: [...(incoming.folders || []), ...priv.filter((p) => !(incoming.folders || []).some((f) => f.path.toLowerCase() === p.path.toLowerCase()))] };
  }
  const merged = { ...current };
  for (const [k, v] of Object.entries(incoming)) {
    const cur = current[k];
    if (k === 'folders') merged.folders = [...(cur || []), ...v.filter((f) => !(cur || []).some((c) => c.path.toLowerCase() === f.path.toLowerCase()))];
    else if (k === 'picturePresets') merged.picturePresets = [...(cur || []).filter((p) => !v.some((x) => x.name === p.name)), ...v];
    else if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) merged[k] = { ...cur, ...v };
    else merged[k] = v;
  }
  return { ...merged, ...keep };
}

module.exports = { build, parse, summarize, apply, FORMAT };
