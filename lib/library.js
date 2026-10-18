// Scans library folders (local, mapped drives or \server\share paths) for
// videos, caches their analysis, and makes cover thumbnails with ffmpeg.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');
const { analyze } = require('./detect');
const tags = require('./tags');

const VIDEO = /\.(mp4|m4v|mov|mkv|webm|avi|jpe?g|png|webp)$/i;
let dir, cache = {}, cacheTimer;

function init(userData) {
  dir = path.join(userData, 'library');
  fs.mkdirSync(path.join(dir, 'thumbs'), { recursive: true });
  // the cache is written atomically with a backup, so a crash mid-write can't wipe it
  for (const f of ['cache.json', 'cache.json.bak']) {
    try { cache = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); break; } catch { cache = {}; }
  }
}
function writeCacheNow() {
  clearTimeout(cacheTimer);
  cacheTimer = null;
  const file = path.join(dir, 'cache.json');
  // keep it from growing forever: drop entries not used for 6 months once it gets big
  const keys = Object.keys(cache);
  if (keys.length > 20000) {
    const old = Date.now() - 180 * 86400000;
    for (const k of keys) if ((cache[k].seen || 0) < old) delete cache[k];
  }
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(cache));
    try { fs.copyFileSync(file, file + '.bak'); } catch {}
    fs.renameSync(file + '.tmp', file);
  } catch {}
}
function saveCache() {
  if (cacheTimer) return;
  cacheTimer = setTimeout(writeCacheNow, 3000);
}
// called on quit so the last few seconds of scanning aren't lost
function flush() { if (cacheTimer) writeCacheNow(); }

async function walk(root, depth, out) {
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory() && depth > 0 && !e.name.startsWith('.') && !e.name.startsWith('$')) await walk(p, depth - 1, out);
    else if (e.isFile() && VIDEO.test(e.name) && !/\.part\.mp4$/i.test(e.name)) out.push(p);
  }
}

async function scan(folder) {
  const files = [];
  await walk(folder, 5, files);
  const out = [];
  for (const p of files) {
    try {
      const st = await fs.promises.stat(p, { bigint: true });
      // the file's physical identity: the same file reached through two paths (a mapped drive
      // and its \\server\share, a junction) is recognised as one file
      const id = st.ino > 0n ? `${st.dev}:${st.ino}` : null;
      out.push({ path: p, name: path.basename(p), size: Number(st.size), mtime: Number(st.mtimeMs), folder, id });
    } catch {}
  }
  return out;
}

const keyOf = (file, size, mtime) => crypto.createHash('sha1').update(`${file}|${size}|${Math.round(mtime)}`).digest('hex').slice(0, 20);

// Cached analysis + thumbnail for one file
async function details(file) {
  const st = await fs.promises.stat(file);
  const key = keyOf(file, st.size, st.mtimeMs);
  if (!cache[key]) {
    cache[key] = await analyze(file);
    saveCache();
  }
  // auto tags (older cache entries get them the first time they're looked at)
  if (!cache[key].tags) {
    try { Object.assign(cache[key], await tags.forFile(file, cache[key], st.mtimeMs)); } catch { cache[key].tags = []; }
    saveCache();
  }
  const info = cache[key];
  info.seen = Date.now();
  const thumb = path.join(dir, 'thumbs', key + '.jpg');
  if (!fs.existsSync(thumb)) await makeThumb(file, info, thumb).catch(() => {});
  return { ...info, thumb: fs.existsSync(thumb) ? thumb : null };
}

// Renders a normal-looking cover picture: crops the left eye and, for 180/360
// footage, unwarps it to a flat 16:10 view with ffmpeg's v360 filter.
function flatChain(f, w, h) {
  const vf = [];
  if (f.layout === 'sbs') vf.push('crop=iw/2:ih:0:0');
  if (f.layout === 'tb') vf.push('crop=iw:ih/2:0:0');
  const inp = { fisheye: 'fisheye:ih_fov=180:iv_fov=180', equirect180: 'hequirect', equirect360: 'e' }[f.projection];
  if (inp) vf.push(`v360=input=${inp}:output=flat:h_fov=110:v_fov=75:w=${w}:h=${h}`);
  else vf.push(`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`);
  return vf;
}
function makeThumb(file, info, out) {
  // Google VR photos: the file on disk is only the left eye (the right eye lives in the XMP)
  const fmt = info.photo?.rightEye ? { ...info.format, layout: '2d' } : info.format;
  const vf = flatChain(fmt, 480, 300);
  const at = Math.min(60, (info.duration || 0) * 0.25);
  return new Promise((resolve, reject) => {
    const p = spawn(ff.ffmpegPath, ['-v', 'error', '-y', ...(at > 0 ? ['-ss', String(at)] : []), '-i', file, '-frames:v', '1', '-vf', vf.join(','), '-q:v', '4', out], { windowsHide: true });
    const t = setTimeout(() => p.kill(), 30000);
    p.on('close', (c) => { clearTimeout(t); c === 0 ? resolve() : reject(new Error('thumb failed')); });
    p.on('error', reject);
  });
}

// Seek-bar preview sheet: 100 frames (10 x 10 grid of 160x100), unwarped like the covers.
// Long videos only decode keyframes so this stays quick even for 8K files.
const SPRITE = { cols: 10, rows: 10, w: 160, h: 100 };
const spriteJobs = new Map();
function sprite(file, format, duration) {
  const st = fs.statSync(file);
  const key = keyOf(file, st.size, st.mtimeMs) + '_' + format.projection + format.layout;
  const out = path.join(dir, 'thumbs', key + '_sprite.jpg');
  if (fs.existsSync(out)) return Promise.resolve({ path: out, ...SPRITE, count: SPRITE.cols * SPRITE.rows, interval: duration / (SPRITE.cols * SPRITE.rows) });
  if (spriteJobs.has(out)) return spriteJobs.get(out);
  const n = SPRITE.cols * SPRITE.rows;
  const vf = [`fps=${n}/${Math.max(1, duration).toFixed(3)}`, ...flatChain(format, SPRITE.w, SPRITE.h), `tile=${SPRITE.cols}x${SPRITE.rows}`];
  const args = ['-v', 'error', '-y', ...(duration > 120 ? ['-skip_frame', 'nokey'] : []), '-i', file, '-an', '-sn', '-vf', vf.join(','), '-frames:v', '1', '-q:v', '5', out];
  const job = new Promise((resolve, reject) => {
    const p = spawn(ff.ffmpegPath, args, { windowsHide: true });
    const t = setTimeout(() => p.kill(), 10 * 60000);
    p.on('close', (c) => {
      clearTimeout(t); spriteJobs.delete(out);
      c === 0 && fs.existsSync(out) ? resolve({ path: out, ...SPRITE, count: n, interval: duration / n }) : reject(new Error('sprite failed'));
    });
    p.on('error', reject);
  });
  spriteJobs.set(out, job);
  return job;
}

module.exports = { init, scan, details, sprite, flatChain, flush };
