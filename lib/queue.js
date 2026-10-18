// Background conversion queue: one job at a time, keeps going while you watch.
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const ai = require('./ai');

// What each kind of job runs
const RUNNERS = {
  convert: (o, p, id) => ff.convertToVR180(o, p, id),
  subs: (o, p, id) => ai.transcribe(o, p, id),
  upscale: (o, p, id) => ai.upscale(o, p, id),
  '3d': (o, p, id) => ai.make3D(o, p, id),
  reframe: (o, p, id) => require('./reframe').reframe(o, p, id)
};

let jobs = [];
let running = null;
let emit = () => {};
let onAllDone = () => {};
let lastEmit = 0, emitTimer;
let saveFile = null, saveTimer;
let recovered = [];   // jobs that were unfinished when the app last closed

// The queue is saved to disk so conversions survive a crash or a closed window
function init(sender, allDone, userData) {
  emit = sender;
  onAllDone = allDone;
  if (!userData) return;
  saveFile = path.join(userData, 'queue.json');
  try {
    const saved = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    recovered = (saved.jobs || []).filter((j) => j.status === 'queued' || j.status === 'running');
  } catch {}
}
function persist() {
  if (!saveFile) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keep = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
      .map((j) => ({ id: j.id, name: j.name, opts: j.opts, status: j.status }));
    try { fs.writeFileSync(saveFile, JSON.stringify({ jobs: keep })); } catch {}
  }, 200);
}
const recovery = () => recovered.map((j) => ({ id: j.id, name: j.name, input: j.opts.input || j.opts.segments?.[0]?.input }));
function resumeRecovered() {
  for (const j of recovered) {
    // the half-written file from the crash is useless; start the job again cleanly
    try { fs.rmSync(j.opts.output + '.part.mp4', { force: true }); } catch {}
    jobs.push({ ...j, status: 'queued', fraction: 0, stage: 'Waiting… (resumed after restart)' });
  }
  const n = recovered.length;
  recovered = [];
  update(true);
  next();
  return n;
}
function discardRecovered() {
  for (const j of recovered) try { fs.rmSync(j.opts.output + '.part.mp4', { force: true }); } catch {}
  recovered = [];
  persist();
}

async function makeReport(j, e) {
  let probe = null;
  try { probe = await ff.probe(j.opts.input || j.opts.segments?.[0]?.input); } catch {}
  let appVersion = '?';
  try { appVersion = require('electron').app.getVersion(); } catch {}
  try { return require('./report').build({ appVersion, job: j, error: e, probe }); } catch { return String(e.stderrTail || e.message || e); }
}
const report = (id) => jobs.find((x) => x.id === id)?.report || null;
const pub = (j) => ({ elapsed: j.elapsed, size: j.size, test: !!j.opts.test, kind: j.opts.kind || 'convert', hasReport: !!j.report, id: j.id, name: j.name, status: j.status, fraction: j.fraction, stage: j.stage, note: j.note, error: j.error, output: j.output, eta: j.eta, input: j.opts.input || j.opts.segments?.[0]?.input });
function update(force) {
  clearTimeout(emitTimer);
  const go = () => { lastEmit = Date.now(); emit('queue', jobs.map(pub)); };
  if (force) persist();
  if (force || Date.now() - lastEmit > 250) go();
  else emitTimer = setTimeout(go, 250);
}

// Never overwrite: name_VR180.mp4, name_VR180 (2).mp4 …
function uniqueOutput(input, folder, suffix = '_VR180') {
  const dir = folder || path.dirname(input);
  const base = path.basename(input || 'joined').replace(/\.[^.]+$/, '') + suffix;
  const taken = new Set(jobs.filter((j) => j.status !== 'failed' && j.status !== 'cancelled').map((j) => j.opts.output.toLowerCase()));
  let out = path.join(dir, base + '.mp4');
  for (let n = 2; fs.existsSync(out) || taken.has(out.toLowerCase()); n++) out = path.join(dir, `${base} (${n}).mp4`);
  return out;
}

function add(list) {
  const added = [];
  for (const opts of list) {
    const input = opts.input || opts.segments?.[0]?.input;
    if (opts.kind === 'subs') opts.output = input.replace(/.[^.\/]+$/, '') + '.auto.srt';
    if (!opts.output) opts.output = uniqueOutput(input, opts.folder, { upscale: '_upscaled', '3d': '_3D_SBS', reframe: '_flat' }[opts.kind] || '_VR180');
    if (opts.kind === '3d' && /\.(jpe?g|png|webp)$/i.test(input)) opts.output = opts.output.replace(/\.mp4$/, '.jpg');
    const name = opts.kind === 'subs' ? path.basename(input) + ' · subtitles' : path.basename(opts.output);
    const j = { id: 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), name, opts, status: 'queued', fraction: 0, stage: 'Waiting…' };
    jobs.push(j);
    added.push(j.id);
  }
  update(true);
  next();
  return added;
}

async function next() {
  if (running) return;
  const j = jobs.find((x) => x.status === 'queued');
  if (!j) return;
  running = j;
  j.status = 'running';
  j.stage = 'Starting…';
  j.started = Date.now();
  update(true);
  try {
    const run = RUNNERS[j.opts.kind || 'convert'] || RUNNERS.convert;
    const r = await run(j.opts, (p) => {
      j.fraction = p.fraction;
      j.stage = p.stage || `Converting… ${Math.round(p.fraction * 100)}%`;
      if (p.note) j.note = p.note;
      const el = (Date.now() - j.started) / 1000;
      j.eta = p.eta !== undefined ? p.eta : p.fraction > 0.02 && p.fraction < 1 ? el / p.fraction - el : null;
      update();
    }, j.id);
    j.status = 'done';
    j.fraction = 1;
    j.elapsed = (Date.now() - j.started) / 1000;
    try { j.size = fs.statSync(r.output).size; } catch {}
    j.stage = r.stage || `Done · ${r.width}×${r.height}${r.gpu ? ' · GPU' : ''}`;
    j.note = r.note;
    j.output = r.output;
    emit('job-done', pub(j));
  } catch (e) {
    const msg = String(e.message || e);
    j.status = msg === 'cancelled' ? 'cancelled' : 'failed';
    j.error = msg === 'cancelled' ? null : msg.split('\n').pop();
    j.stage = j.status === 'cancelled' ? 'Cancelled' : 'Failed';
    if (j.status === 'failed') {
      j.report = await makeReport(j, e);
      emit('job-failed', pub(j));
    }
  }
  running = null;
  update(true);
  if (!jobs.some((x) => x.status === 'queued')) {
    const done = jobs.filter((x) => x.status === 'done').length;
    if (done) onAllDone(done);
  }
  next();
}

function cancel(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  if (j.status === 'running') { ff.cancel(id); ai.cancel(id); }
  else if (j.status === 'queued') { j.status = 'cancelled'; j.stage = 'Cancelled'; update(true); }
}
function remove(id) {
  const j = jobs.find((x) => x.id === id);
  if (j?.status === 'running') return;
  jobs = jobs.filter((x) => x.id !== id);
  update(true);
}
function retry(id) {
  const j = jobs.find((x) => x.id === id);
  if (!j || (j.status !== 'failed' && j.status !== 'cancelled')) return;
  Object.assign(j, { status: 'queued', fraction: 0, stage: 'Waiting…', error: null });
  update(true);
  next();
}
function clearFinished() { jobs = jobs.filter((x) => x.status === 'queued' || x.status === 'running'); update(true); }
const list = () => jobs.map(pub);
const cancelAll = () => { for (const j of jobs) cancel(j.id); };
// App closing: keep the saved queue as it is (so it can be resumed), then stop ffmpeg
function shutdown() {
  clearTimeout(saveTimer);
  saveFile = null;
  for (const j of jobs) if (j.status === 'running') { ff.cancel(j.id); ai.cancel(j.id); }
}

module.exports = { report, init, add, cancel, remove, retry, clearFinished, list, cancelAll, recovery, resumeRecovered, discardRecovered, shutdown };
