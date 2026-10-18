// Writes Google Spherical Video V2 metadata (st3d + sv3d/equi) into an MP4,
// marking it as 180° equirectangular VR180, the same boxes Google's
// Spatial Media Metadata Injector writes. Streams the file so large videos are fine.
const fs = require('fs');

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const VISUAL_ENTRY_HEADER = 8 + 78; // box header + VisualSampleEntry fixed fields
const AUDIO_ENTRY_HEADER = 8 + 28;  // box header + AudioSampleEntry fixed fields

function box(type, ...payloads) {
  const body = Buffer.concat(payloads);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}
const fullHeader = () => Buffer.alloc(4); // version 0, flags 0
const u32 = (...vals) => { const b = Buffer.alloc(4 * vals.length); vals.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };

function vr180Boxes(layout) {
  const stereoMode = layout === 'tb' ? 1 : layout === 'sbs' ? 2 : 0;
  const st3d = box('st3d', fullHeader(), Buffer.from([stereoMode]));
  const svhd = box('svhd', fullHeader(), Buffer.from('VR180 Player\0', 'ascii'));
  const prhd = box('prhd', fullHeader(), u32(0, 0, 0)); // yaw, pitch, roll
  // Bounds are 0.32 fixed point: crop a quarter off the left and right = 180° horizontally
  const equi = box('equi', fullHeader(), u32(0, 0, 0x40000000, 0x40000000));
  const sv3d = box('sv3d', svhd, box('proj', prhd, equi));
  return Buffer.concat([st3d, sv3d]);
}

function children(buf, start, end) {
  const list = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (size === 1) throw new Error('64-bit box inside moov is not supported');
    if (size === 0) size = end - off;
    if (size < 8 || off + size > end) break;
    list.push({ type, off, size });
    off += size;
  }
  return list;
}
const child = (buf, parent, type, headerLen = 8) =>
  children(buf, parent.off + headerLen, parent.off + parent.size).find((c) => c.type === type);

function topLevelBoxes(fd, fileSize) {
  const list = [];
  const h = Buffer.alloc(16);
  let off = 0;
  while (off + 8 <= fileSize) {
    fs.readSync(fd, h, 0, 16, off);
    let size = h.readUInt32BE(0);
    const type = h.toString('ascii', 4, 8);
    if (size === 1) size = Number(h.readBigUInt64BE(8));
    else if (size === 0) size = fileSize - off;
    if (size < 8) throw new Error('Corrupt MP4 box');
    list.push({ type, off, size });
    off += size;
  }
  return list;
}

function shiftChunkOffsets(buf, node, delta) {
  for (const c of children(buf, node.off + 8, node.off + node.size)) {
    if (CONTAINERS.has(c.type)) shiftChunkOffsets(buf, c, delta);
    else if (c.type === 'stco' || c.type === 'co64') {
      const n = buf.readUInt32BE(c.off + 12);
      for (let i = 0; i < n; i++) {
        if (c.type === 'stco') { const p = c.off + 16 + i * 4; buf.writeUInt32BE(buf.readUInt32BE(p) + delta, p); }
        else { const p = c.off + 16 + i * 8; buf.writeBigUInt64BE(buf.readBigUInt64BE(p) + BigInt(delta), p); }
      }
    }
  }
}

// Appends boxes to the first sample entry of the track with the given handler
// ('vide' / 'soun') and grows every parent box to match.
function insertIntoSampleEntry(moov, handler, headerLen, extra, skipIf, required) {
  const root = { off: 0, size: moov.length };
  for (const trak of children(moov, 8, moov.length).filter((c) => c.type === 'trak')) {
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!hdlr || moov.toString('ascii', hdlr.off + 16, hdlr.off + 20) !== handler) continue;
    const minf = child(moov, mdia, 'minf');
    const stbl = minf && child(moov, minf, 'stbl');
    const stsd = stbl && child(moov, stbl, 'stsd');
    const entry = stsd && children(moov, stsd.off + 16, stsd.off + stsd.size)[0];
    if (!entry) continue;
    const existing = children(moov, entry.off + headerLen, entry.off + entry.size);
    if (existing.some((c) => skipIf.includes(c.type))) return moov; // already tagged
    const at = entry.off + entry.size;
    const out = Buffer.concat([moov.subarray(0, at), extra, moov.subarray(at)]);
    for (const a of [root, trak, mdia, minf, stbl, stsd, entry]) out.writeUInt32BE(out.readUInt32BE(a.off) + extra.length, a.off);
    return out;
  }
  if (required) throw new Error('No ' + (handler === 'vide' ? 'video' : 'audio') + ' track found');
  return moov;
}

// Spatial Audio box: first-order ambisonics, ACN channel order, SN3D normalisation
function sa3dBox() {
  const b = Buffer.alloc(8 + 12 + 16);
  b.writeUInt32BE(b.length, 0);
  b.write('SA3D', 4, 'ascii');
  b.writeUInt8(0, 8);          // version
  b.writeUInt8(0, 9);          // ambisonic type: periphonic
  b.writeUInt32BE(1, 10);      // order 1
  b.writeUInt8(0, 14);         // channel ordering: ACN
  b.writeUInt8(0, 15);         // normalisation: SN3D
  b.writeUInt32BE(4, 16);      // 4 channels
  for (let i = 0; i < 4; i++) b.writeUInt32BE(i, 20 + i * 4);
  return b;
}

function injectVR180(input, output, layout = '2d', opts = {}) {
  const fd = fs.openSync(input, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const top = topLevelBoxes(fd, fileSize);
    const moovBox = top.find((b) => b.type === 'moov');
    if (!moovBox) throw new Error('MP4 has no moov box');
    let moov = Buffer.alloc(moovBox.size);
    fs.readSync(fd, moov, 0, moovBox.size, moovBox.off);

    const before = moov.length;
    moov = insertIntoSampleEntry(moov, 'vide', VISUAL_ENTRY_HEADER, vr180Boxes(layout), ['sv3d', 'st3d'], true);
    if (opts.ambisonic) moov = insertIntoSampleEntry(moov, 'soun', AUDIO_ENTRY_HEADER, sa3dBox(), ['SA3D'], false);
    const added = moov.length - before;

    // If media data comes after moov, its absolute offsets move by the bytes we added
    const mdatAfter = top.some((b) => b.type === 'mdat' && b.off > moovBox.off);
    if (mdatAfter && added) shiftChunkOffsets(moov, { off: 0, size: moov.length }, added);

    const out = fs.openSync(output, 'w');
    try {
      const chunk = Buffer.alloc(8 * 1024 * 1024);
      const copy = (from, to) => {
        for (let pos = from; pos < to;) {
          const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, to - pos), pos);
          fs.writeSync(out, chunk, 0, n);
          pos += n;
        }
      };
      copy(0, moovBox.off);
      fs.writeSync(out, moov);
      copy(moovBox.off + moovBox.size, fileSize);
    } finally {
      fs.closeSync(out);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Faster and lighter: when moov is the last box (ffmpeg's default without +faststart),
// the tags are added by rewriting just the moov at the end of the same file. No copy of
// the video, no second file on disk. Otherwise it falls back to a streamed copy.
async function injectVR180InPlace(file, layout = '2d', opts = {}) {
  const fd = fs.openSync(file, 'r+');
  let fallback = false;
  try {
    const fileSize = fs.fstatSync(fd).size;
    const top = topLevelBoxes(fd, fileSize);
    const moovBox = top.find((b) => b.type === 'moov');
    if (!moovBox) throw new Error('MP4 has no moov box');
    if (top.some((b) => b.off > moovBox.off && b.type !== 'free' && b.type !== 'skip')) { fallback = true; }
    else {
      let moov = Buffer.alloc(moovBox.size);
      fs.readSync(fd, moov, 0, moovBox.size, moovBox.off);
      moov = insertIntoSampleEntry(moov, 'vide', VISUAL_ENTRY_HEADER, vr180Boxes(layout), ['sv3d', 'st3d'], true);
      if (opts.ambisonic) moov = insertIntoSampleEntry(moov, 'soun', AUDIO_ENTRY_HEADER, sa3dBox(), ['SA3D'], false);
      fs.writeSync(fd, moov, 0, moov.length, moovBox.off);
      fs.ftruncateSync(fd, moovBox.off + moov.length);
      fs.fsyncSync(fd);
    }
  } finally { fs.closeSync(fd); }
  if (fallback) {
    const tmp = file + '.meta.mp4';
    await new Promise((resolve, reject) => setImmediate(() => { try { injectVR180(file, tmp, layout, opts); resolve(); } catch (e) { reject(e); } }));
    fs.renameSync(tmp, file);
  }
}

// True if the file's moov box contains a box of this type (e.g. SA3D spatial audio)
function moovHas(file, type) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const moov = topLevelBoxes(fd, fs.fstatSync(fd).size).find((b) => b.type === 'moov');
    if (!moov || moov.size > 64 * 1024 * 1024) return false;
    const buf = Buffer.alloc(moov.size);
    fs.readSync(fd, buf, 0, moov.size, moov.off);
    return buf.includes(Buffer.from(type, 'ascii'));
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { injectVR180, injectVR180InPlace, moovHas };
