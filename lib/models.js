// Optional AI add-ons. Nothing is downloaded until you ask for it in Settings. Every file
// is checked against a pinned SHA-256, so a broken or tampered download is never used,
// and everything runs on this PC afterwards: no video, audio or text is ever uploaded.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const FILES = {
  'whisper-engine': {
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip',
    sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a', size: 8194445, unzip: true, exe: 'whisper-cli.exe'
  },
  'whisper-base': {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', size: 147951465, file: 'ggml-base.bin'
  },
  depth: {
    url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx',
    sha256: 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c', size: 99060839, file: 'model.onnx'
  },
  esrgan: {
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip',
    sha256: 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d', size: 45474481, unzip: true, exe: 'realesrgan-ncnn-vulkan.exe'
  }
};

// What you see in Settings: one switch per feature, each made of one or more files
const PACKS = {
  subs: { files: ['whisper-engine', 'whisper-base'], license: 'whisper.cpp (MIT) · Whisper base model (MIT)' },
  depth: { files: ['depth'], license: 'Depth Anything V2 Small (Apache 2.0)' },
  upscale: { files: ['esrgan'], license: 'Real-ESRGAN (BSD 3-Clause)' }
};

let root = null;
const active = new Map();   // pack -> { abort, done, total }

function init(userData) { root = path.join(userData, 'models'); }
const dirOf = (id) => path.join(root, id);
const markerOf = (id) => path.join(dirOf(id), 'installed.json');

function marker(id) {
  try {
    const m = JSON.parse(fs.readFileSync(markerOf(id), 'utf8'));
    if (m.sha256 !== FILES[id].sha256) return null;              // an older version of the add-on
    return fs.existsSync(path.join(dirOf(id), m.path)) ? m : null;
  } catch { return null; }
}
const fileReady = (id) => !!marker(id);
const packSize = (pack) => PACKS[pack].files.reduce((n, id) => n + FILES[id].size, 0);

function status() {
  const out = {};
  for (const [pack, p] of Object.entries(PACKS)) {
    const a = active.get(pack);
    out[pack] = {
      installed: p.files.every(fileReady), size: packSize(pack), license: p.license,
      downloading: !!a, fraction: a ? a.done / a.total : 0, stage: a?.stage || ''
    };
  }
  return out;
}

// Paths the AI jobs need (null when that add-on isn't installed)
function paths() {
  const at = (id) => { const m = marker(id); return m ? path.join(dirOf(id), m.path) : null; };
  const esrgan = at('esrgan');
  return {
    whisperCli: at('whisper-engine'), whisperModel: at('whisper-base'),
    depthModel: at('depth'),
    esrgan, esrganModels: esrgan ? path.join(path.dirname(esrgan), 'models') : null
  };
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}

// Windows 10/11 ship bsdtar, which unpacks zip files
function unzip(zip, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true });
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const p = spawn(tar, ['-xf', zip, '-C', dest], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('Could not unpack the download: ' + err.trim().slice(0, 200))));
  });
}

async function fetchImpl(url, signal) {
  let f = globalThis.fetch;
  try { const { net } = require('electron'); if (net?.fetch) f = net.fetch.bind(net); } catch {}
  return f(url, { signal, redirect: 'follow' });
}

async function downloadFile(id, a) {
  const spec = FILES[id];
  const dir = dirOf(id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, 'download.part');
  const res = await fetchImpl(spec.url, a.abort.signal);
  if (!res.ok) throw new Error(`Download failed (server said ${res.status}). Check your internet connection and try again.`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      got += buf.length;
      a.done += buf.length;
      if (got > spec.size) throw new Error('The download is bigger than expected, so it was stopped.');
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      a.tick();
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (hash.digest('hex') !== spec.sha256) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('The download was damaged or changed on the way (checksum mismatch), so it was not used. Try again.');
  }
  let rel;
  if (spec.unzip) {
    a.stage = 'Unpacking…'; a.tick(true);
    await unzip(part, path.join(dir, 'files'));
    fs.rmSync(part, { force: true });
    const exe = findFile(path.join(dir, 'files'), spec.exe);
    if (!exe) throw new Error('The add-on is missing ' + spec.exe);
    rel = path.relative(dir, exe);
  } else {
    fs.renameSync(part, path.join(dir, spec.file));
    rel = spec.file;
  }
  fs.writeFileSync(markerOf(id), JSON.stringify({ sha256: spec.sha256, path: rel, at: Date.now() }));
}

async function install(pack, onProgress = () => {}) {
  const p = PACKS[pack];
  if (!p) throw new Error('Unknown add-on');
  if (active.has(pack)) return active.get(pack).promise;
  const todo = p.files.filter((id) => !fileReady(id));
  const total = todo.reduce((n, id) => n + FILES[id].size, 0);
  try {
    fs.mkdirSync(root, { recursive: true });
    const free = fs.statfsSync ? (() => { const s = fs.statfsSync(root); return s.bavail * s.bsize; })() : Infinity;
    if (free < total * 2.2 + 200e6) throw new Error(`Not enough free disk space (needs about ${Math.ceil(total * 2.2 / 1e6)} MB).`);
  } catch (e) { if (/disk space/.test(e.message)) throw e; }
  let last = 0;
  const a = {
    abort: new AbortController(), done: 0, total: total || 1, stage: 'Downloading…',
    tick(force) { const now = Date.now(); if (force || now - last > 200) { last = now; onProgress({ pack, fraction: a.done / a.total, stage: a.stage }); } }
  };
  a.promise = (async () => {
    try {
      for (const id of todo) { a.stage = 'Downloading…'; await downloadFile(id, a); }
      onProgress({ pack, fraction: 1, stage: 'Installed', done: true });
      return true;
    } catch (e) {
      for (const id of todo) if (!fileReady(id)) fs.rmSync(dirOf(id), { recursive: true, force: true });
      const cancelled = a.abort.signal.aborted;
      onProgress({ pack, fraction: 0, stage: cancelled ? 'Cancelled' : 'Failed', error: cancelled ? null : e.message, done: true });
      if (cancelled) return false;
      throw e;
    } finally { active.delete(pack); }
  })();
  active.set(pack, a);
  return a.promise;
}

function cancel(pack) { active.get(pack)?.abort.abort(); }

function remove(pack) {
  const p = PACKS[pack];
  if (!p || active.has(pack)) return false;
  // a file shared with another installed feature stays
  const keep = new Set(Object.entries(PACKS).filter(([k]) => k !== pack).flatMap(([, q]) => q.files));
  for (const id of p.files) if (!keep.has(id)) fs.rmSync(dirOf(id), { recursive: true, force: true });
  return true;
}

module.exports = { init, status, paths, install, cancel, remove, FILES, PACKS };
