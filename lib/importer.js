// Camera and memory-card import. Notices memory cards (removable drives with a DCIM folder),
// lists the videos and photos that haven't been imported yet, and copies them into dated
// folders. Every copy is read back and compared before it counts, and nothing on the card
// is ever changed or deleted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MEDIA = /\.(mp4|mov|m4v|mkv|360|insv|insp|jpe?g|png|heic|dng|webp)$/i;
const SKIP = /\.(lrv|thm|xmp|db|ini)$/i;   // GoPro proxies and thumbnails, sidecars
const CARD_DIRS = ['DCIM', path.join('PRIVATE', 'M4ROOT', 'CLIP')];

let emit = () => {};
let indexFile = null, index = {};   // "name|size|mtime" -> where it went
let drives = new Set(), timer = null, busy = false;
const jobs = new Map();

function init(sender, userData) {
  emit = sender;
  indexFile = path.join(userData, 'imported.json');
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { index = {}; }
}
function saveIndex() { try { fs.writeFileSync(indexFile + '.tmp', JSON.stringify(index)); fs.renameSync(indexFile + '.tmp', indexFile); } catch {} }
const keyOf = (f) => `${f.name.toLowerCase()}|${f.size}|${Math.round(f.mtime / 1000)}`;

// Which drive letters are removable (card readers, cameras in card-reader mode)
function removableInfo() {
  return new Promise((resolve) => {
    const ps = 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=2" | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err) return resolve([]);
      try { const j = JSON.parse(out || '[]'); resolve((Array.isArray(j) ? j : [j]).filter(Boolean).map((d) => ({ root: d.DeviceID + '\\', label: d.VolumeName || '', size: +d.Size || 0 }))); } catch { resolve([]); }
    });
  });
}

function walk(dir, depth, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0 && !e.name.startsWith('.')) walk(p, depth - 1, out); continue; }
    if (!MEDIA.test(e.name) || SKIP.test(e.name) || e.name.startsWith('._')) continue;
    try { const s = fs.statSync(p); out.push({ path: p, name: e.name, size: s.size, mtime: s.mtimeMs }); } catch {}
  }
}

// Everything on a card (or any folder), marking what was imported before
function scan(rootDir) {
  const files = [];
  const roots = CARD_DIRS.map((d) => path.join(rootDir, d)).filter((d) => fs.existsSync(d));
  if (!roots.length) walk(rootDir, 3, files);
  for (const r of roots) walk(r, 3, files);
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    const dest = index[keyOf(f)];
    f.imported = !!(dest && fs.existsSync(dest));
  }
  const fresh = files.filter((f) => !f.imported);
  return { root: rootDir, files, newCount: fresh.length, newBytes: fresh.reduce((n, f) => n + f.size, 0), total: files.length };
}

// Polls for cards: drive letters are cheap to check; the slower lookup runs only on a change
async function poll() {
  if (busy) return;
  busy = true;
  try {
    const now = new Set();
    for (let c = 68; c <= 90; c++) { const r = String.fromCharCode(c) + ':\\'; try { fs.statSync(r); now.add(r); } catch {} }
    const added = [...now].filter((r) => !drives.has(r));
    const removed = [...drives].filter((r) => !now.has(r));
    drives = now;
    for (const r of removed) emit('import-card-gone', { root: r });
    if (!added.length) return;
    const rem = await removableInfo();
    for (const r of added) {
      const d = rem.find((x) => x.root.toUpperCase() === r.toUpperCase());
      if (!d || !CARD_DIRS.some((x) => fs.existsSync(path.join(r, x)))) continue;
      const s = scan(r);
      if (s.newCount) emit('import-card', { root: r, label: d.label, newCount: s.newCount, newBytes: s.newBytes, total: s.total });
    }
  } finally { busy = false; }
}
function watch(on) {
  clearInterval(timer);
  timer = null;
  if (!on) return;
  // cards already in the reader when the app starts count as new once
  drives = new Set();
  timer = setInterval(poll, 3000);
  poll();
}

async function sha1(file) {
  const h = crypto.createHash('sha1');
  await new Promise((resolve, reject) => fs.createReadStream(file, { highWaterMark: 1 << 20 }).on('data', (c) => h.update(c)).on('end', resolve).on('error', reject));
  return h.digest('hex');
}

// Copies into <dest>/<yyyy-mm-dd>/, hashing while reading the card and checking the copy
async function run(id, { files, dest }, onProgress = () => {}) {
  const job = { cancelled: false, stream: null };
  jobs.set(id, job);
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  fs.mkdirSync(dest, { recursive: true });
  if (fs.statfsSync) {
    const s = fs.statfsSync(dest);
    if (s.bavail * s.bsize < total + 200e6) { jobs.delete(id); throw new Error(`Not enough free space in ${dest} (needs ${(total / 1e9).toFixed(1)} GB).`); }
  }
  let done = 0;
  const started = Date.now();
  const result = { imported: [], skipped: 0, failed: [], dest };
  try {
    for (const f of files) {
      if (job.cancelled) break;
      const day = new Date(f.mtime);
      const folder = path.join(dest, `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`);
      fs.mkdirSync(folder, { recursive: true });
      let target = path.join(folder, f.name);
      // same name already there: the same file is skipped, a different one gets a new name
      if (fs.existsSync(target)) {
        if (fs.statSync(target).size === f.size) { index[keyOf(f)] = target; result.skipped++; done += f.size; continue; }
        const ext = path.extname(f.name), base = path.basename(f.name, ext);
        for (let n = 2; fs.existsSync(target); n++) target = path.join(folder, `${base} (${n})${ext}`);
      }
      const part = target + '.importing';
      try {
        const h = crypto.createHash('sha1');
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(f.path, { highWaterMark: 4 << 20 });
          const ws = fs.createWriteStream(part);
          job.rs = rs; job.ws = ws;
          let failed = null;
          const fail = (e) => { if (failed) return; failed = e; rs.destroy(); ws.destroy(); };
          rs.on('data', (c) => {
            h.update(c);
            done += c.length;
            const el = (Date.now() - started) / 1000;
            onProgress({ fraction: done / total, file: f.name, index: result.imported.length + result.skipped + result.failed.length + 1, count: files.length, speed: done / Math.max(0.1, el), eta: el > 1 ? (el / (done / total)) * (1 - done / total) : null });
          });
          rs.on('error', fail);
          ws.on('error', fail);
          // the file is closed before we go on, so a cancelled copy can be removed on Windows
          ws.on('close', () => (failed ? reject(failed) : job.cancelled ? reject(new Error('cancelled')) : resolve()));
          rs.pipe(ws);
        });
        if (job.cancelled) throw new Error('cancelled');
        // read the copy back: it must be byte-for-byte what was on the card
        if ((await sha1(part)) !== h.digest('hex')) throw new Error('the copy did not match the card');
        fs.renameSync(part, target);
        try { fs.utimesSync(target, new Date(f.mtime), new Date(f.mtime)); } catch {}
        index[keyOf(f)] = target;
        result.imported.push(target);
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch {}
        if (job.cancelled) break;
        result.failed.push({ name: f.name, error: e.message });
      }
    }
  } finally {
    jobs.delete(id);
    saveIndex();
  }
  result.cancelled = job.cancelled;
  return result;
}
function cancel(id) {
  const j = jobs.get(id);
  if (!j) return;
  j.cancelled = true;
  try { j.rs?.destroy(); } catch {}
  try { j.ws?.destroy(); } catch {}
}

module.exports = { init, watch, poll, scan, run, cancel, removableInfo, keyOf };
