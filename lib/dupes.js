// Duplicate finder for the library.
//  - exact copies: same size and the same content hash (first + last 4 MB)
//  - probably the same: same length (±0.1 s) and nearly identical covers (perceptual hash)
//  - already converted: a fisheye original sitting next to its "_VR180" copy
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');

const CHUNK = 4 * 1024 * 1024;
async function quickHash(file, size) {
  const h = crypto.createHash('sha1');
  h.update(String(size));
  const fd = await fs.promises.open(file, 'r');
  try {
    const read = async (pos, len) => { const b = Buffer.alloc(len); const { bytesRead } = await fd.read(b, 0, len, pos); h.update(b.subarray(0, bytesRead)); };
    await read(0, Math.min(CHUNK, size));
    if (size > CHUNK) await read(Math.max(CHUNK, size - CHUNK), Math.min(CHUNK, size - CHUNK));
  } finally { await fd.close(); }
  return h.digest('hex');
}

// 64-bit difference hash of a cover image (9x8 greyscale, compare neighbours)
function dhash(image) {
  return new Promise((resolve) => {
    const p = spawn(ff.ffmpegPath, ['-v', 'error', '-i', image, '-vf', 'scale=9:8:flags=area,format=gray', '-f', 'rawvideo', '-'], { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('close', () => {
      const px = Buffer.concat(chunks);
      if (px.length < 72) return resolve(null);
      let bits = 0n;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
      resolve(bits);
    });
    p.on('error', () => resolve(null));
  });
}
const hamming = (a, b) => { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };

// files: [{ path, name, size, mtime, duration, thumb, projection }]
async function find(files, onProgress = () => {}) {
  const groups = [];
  const used = new Set();
  // the same physical file listed under two paths (mapped drive + UNC, junctions) counts once
  const seenIds = new Set();
  files = files.filter((f) => !f.id || (seenIds.has(f.id) ? false : seenIds.add(f.id)));
  // 1) exact copies
  const bySize = new Map();
  for (const f of files) { if (!bySize.has(f.size)) bySize.set(f.size, []); bySize.get(f.size).push(f); }
  const candidates = [...bySize.values()].filter((g) => g.length > 1);
  let done = 0;
  for (const g of candidates) {
    const byHash = new Map();
    for (const f of g) {
      try { const k = await quickHash(f.path, f.size); if (!byHash.has(k)) byHash.set(k, []); byHash.get(k).push(f); } catch {}
    }
    for (const same of byHash.values()) if (same.length > 1) { groups.push({ kind: 'exact', files: same }); same.forEach((f) => used.add(f.path)); }
    onProgress(++done / (candidates.length + 1) * 0.5);
  }
  // 2) re-encodes / converted copies: same length and a matching cover
  // one representative per exact group joins the comparison, so re-encodes of a copied file are found too
  const rep = new Map(groups.map((g) => [g.files[0].path, g]));
  const vids = files.filter((f) => f.duration && f.thumb && (!used.has(f.path) || rep.has(f.path)));
  const hashes = new Map();
  for (let i = 0; i < vids.length; i++) {
    hashes.set(vids[i].path, await dhash(vids[i].thumb));
    onProgress(0.5 + (i + 1) / Math.max(1, vids.length) * 0.5);
  }
  const seen = new Set();
  for (const a of vids) {
    if (seen.has(a.path)) continue;
    const ha = hashes.get(a.path);
    if (ha == null) continue;
    const same = [a];
    for (const b of vids) {
      if (b === a || seen.has(b.path)) continue;
      const hb = hashes.get(b.path);
      if (hb != null && Math.abs(a.duration - b.duration) <= 0.1 && hamming(ha, hb) <= 10) same.push(b);
    }
    if (same.length < 2) continue;
    same.forEach((f) => seen.add(f.path));
    const exact = same.map((f) => rep.get(f.path)).find(Boolean);
    if (exact) {
      for (const f of same) if (!exact.files.includes(f)) exact.files.push(f);
      exact.kind = 'similar';
      continue;
    }
    // an original next to its _VR180 export is "already converted", not a mistake
    const isPair = same.length === 2 && same.some((f) => /_vr180/i.test(f.name)) && same.some((f) => !/_vr180/i.test(f.name));
    groups.push({ kind: isPair ? 'converted' : 'similar', files: same });
  }
  // 3) originals whose converted copy exists but wasn't matched above (e.g. trimmed)
  const names = new Map(files.map((f) => [path.join(path.dirname(f.path), f.name).toLowerCase(), f]));
  for (const f of files) {
    if (seen.has(f.path) || used.has(f.path) || /_vr180/i.test(f.name) || f.projection !== 'fisheye') continue;
    const base = path.join(path.dirname(f.path), f.name.replace(/\.[^.]+$/, '')).toLowerCase() + '_vr180';
    const copy = [...names.entries()].find(([k]) => k.startsWith(base))?.[1];
    if (copy && !seen.has(copy.path)) { groups.push({ kind: 'converted', files: [f, copy] }); seen.add(f.path); seen.add(copy.path); }
  }
  onProgress(1);
  return groups.map((g) => ({ ...g, files: g.files.map(({ path: p, name, size, mtime, thumb, duration, id }) => ({ path: p, name, size, mtime, thumb, duration, id })) }));
}

module.exports = { find, quickHash, dhash };
