// Finds subtitle files next to a video and extracts subtitle tracks stored inside it.
const fs = require('fs');
const path = require('path');
const os = require('os');
const ff = require('./ffmpeg');

const SUB_EXT = /\.(srt|vtt)$/i;

// name.srt, name.en.srt, name.English.vtt …
async function find(videoPath) {
  const base = path.basename(videoPath).replace(/\.[^.]+$/, '').toLowerCase();
  const out = [];
  for (const dir of [path.dirname(videoPath), ai().sidecarDir(videoPath)]) {
    let entries = [];
    try { entries = await fs.promises.readdir(dir); } catch {}
    for (const f of entries) {
      if (!SUB_EXT.test(f) || !f.toLowerCase().startsWith(base + '.')) continue;
      const tag = f.slice(base.length + 1).replace(SUB_EXT, '');
      const auto = /^([a-z]{2,3})\.auto$/i.exec(tag);
      const label = auto ? ai().langName(auto[1].toLowerCase()) + ' (AI)' : tag ? tag.toUpperCase() : path.extname(f).slice(1).toUpperCase() + ' file';
      out.push({ kind: 'file', path: path.join(dir, f), label, auto: !!auto });
    }
  }
  // your own subtitle files first, AI-made ones after them
  return out.sort((a, b) => a.auto - b.auto);
}
const ai = () => require('./ai');

async function extract(videoPath, index) {
  const out = path.join(os.tmpdir(), `vr180-sub-${Date.now()}-${index}.vtt`);
  await ff.run(['-y', '-v', 'error', '-i', videoPath, '-map', `0:s:${index}`, '-f', 'webvtt', out]);
  const text = await fs.promises.readFile(out, 'utf8');
  fs.rm(out, { force: true }, () => {});
  return text;
}

async function read(file) {
  const buf = await fs.promises.readFile(file);
  // UTF-16 subtitle files exist in the wild
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  return buf.toString('utf8');
}

module.exports = { find, extract, read };
