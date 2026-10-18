// AI features: the Settings card that installs the optional add-ons, and the actions that
// use them (subtitles from speech, AI upscaling). Everything runs on this PC.
import { api, on, emit, settings, save, baseName } from './core.js';
import { h, card, toggle, select, field, toast, modal } from './ui.js';
import { openJobs } from './jobs.js';
import { depthCfg, setDepthCfg } from './depth.js';

export const PACKS = {
  subs: { name: 'Auto subtitles', icon: '💬', desc: 'Turns speech into subtitles in 99 languages, and can translate them into English. About 6× faster than real time.' },
  depth: { name: '2D → 3D', icon: '🧊', desc: 'Adds real depth to flat videos and photos, live, so they look 3D in the headset. Uses your graphics card.' },
  upscale: { name: 'AI upscaling', icon: '✨', desc: 'Doubles the resolution of older or lower-resolution videos and photos for a sharper picture in the headset. Slow: plan on minutes per minute of video.' }
};
let status = {};
const listeners = new Set();
const fmtMB = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB');

export async function refreshAi() {
  try { status = await api.aiStatus(); } catch {}
  for (const f of listeners) f(status);
  return status;
}
export const aiInstalled = (pack) => !!status[pack]?.installed;
api.onAiProgress((p) => {
  status[p.pack] = { ...status[p.pack], downloading: !p.done, fraction: p.fraction, stage: p.stage };
  for (const f of listeners) f(status, p);
  if (p.done) refreshAi();
});

export function install(pack) {
  return api.aiInstall(pack).then(() => { refreshAi(); return true; }, (e) => {
    toast(`${PACKS[pack].name} could not be installed: ${String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 'err');
    refreshAi();
    return false;
  });
}

// Asks once before a download, then shows its progress. Resolves true when ready to use.
export async function ensure(pack) {
  await refreshAi();
  if (aiInstalled(pack)) return true;
  const p = PACKS[pack], s = status[pack] || {};
  return new Promise((resolve) => {
    const bar = h('div', { class: 'update-bar' }, h('i'));
    const note = h('p', { class: 'muted' }, `A one-time download of ${fmtMB(s.size || 0)} from GitHub / Hugging Face. It's checked before use, and runs on this PC afterwards: nothing you watch is uploaded.`);
    const go = h('button', { class: 'btn primary' }, 'Download and turn on');
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; listeners.delete(watch); resolve(v); } };
    const m = modal({ title: `${p.icon} ${p.name}`, width: 460, onClose: () => { if (status[pack]?.downloading) api.aiCancel(pack); done(false); }, body: [h('p', {}, p.desc), note, bar, h('div', { class: 'row-btns' }, go)] });
    const watch = (st, ev) => {
      if (ev?.pack !== pack) return;
      bar.classList.add('show');
      bar.firstChild.style.width = Math.round((ev.fraction || 0) * 100) + '%';
      note.textContent = ev.stage === 'Downloading…' ? `Downloading… ${Math.round(ev.fraction * 100)}%` : ev.stage;
    };
    listeners.add(watch);
    go.onclick = async () => {
      go.disabled = true;
      const ok = await install(pack);
      if (ok) { toast(`${p.name} is ready`, 'ok'); done(true); m.close(); } else { go.disabled = false; bar.classList.remove('show'); }
    };
  });
}

// Settings › AI features
export function aiCard() {
  const rows = {};
  const body = Object.entries(PACKS).map(([id, p]) => {
    const btn = h('button', { class: 'btn small' });
    const bar = h('div', { class: 'update-bar' }, h('i'));
    const meta = h('div', { class: 'muted small' });
    rows[id] = { btn, bar, meta };
    return h('div', { class: 'ai-row' },
      h('div', { class: 'ai-ico' }, p.icon),
      h('div', { class: 'grow' }, h('b', {}, p.name), h('div', { class: 'muted small' }, p.desc), meta, bar),
      btn);
  });
  const paint = (st) => {
    for (const [id, r] of Object.entries(rows)) {
      const s = st[id];
      if (!s) continue;
      r.bar.classList.toggle('show', !!s.downloading);
      r.bar.firstChild.style.width = Math.round((s.fraction || 0) * 100) + '%';
      r.meta.textContent = s.downloading ? `${s.stage === 'Downloading…' ? 'Downloading' : s.stage} ${s.stage === 'Downloading…' ? Math.round(s.fraction * 100) + '%' : ''}`
        : s.installed ? `Installed · ${fmtMB(s.size)} · ${s.license}` : `${fmtMB(s.size)} download · ${s.license}`;
      r.btn.textContent = s.downloading ? 'Cancel' : s.installed ? 'Remove' : 'Install';
      r.btn.classList.toggle('primary', !s.installed && !s.downloading);
      r.btn.onclick = async () => {
        if (s.downloading) return api.aiCancel(id);
        if (s.installed) {
          if (id === 'depth') emit('depth-off');
          status = await api.aiRemove(id);
          paint(status);
          return toast(`${PACKS[id].name} removed`);
        }
        install(id).then((ok) => ok && toast(`${PACKS[id].name} is ready`, 'ok'));
      };
    }
  };
  listeners.add(paint);
  refreshAi();
  return card({ title: 'AI Features', info: 'Optional add-ons, downloaded only when you click Install. Each download is checked against a known fingerprint before it is used, and everything runs on this PC: no video, sound or text ever leaves it.', body });
}

// ---------------------------------------------------------------- subtitles from speech
const LANG_OPTS = [['auto', 'Detect automatically'], ['en', 'English'], ['nl', 'Dutch'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['pl', 'Polish'], ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese']];
export async function makeSubtitles(path, { audioTrack = 0 } = {}) {
  if (!(await ensure('subs'))) return;
  const cfg = { language: 'auto', translate: false, ...settings.aiSubs };
  const lang = select(LANG_OPTS.map(([value, label]) => ({ value, label })), cfg.language, (v) => (cfg.language = v));
  const m = modal({ title: '💬 Make subtitles', width: 460, body: [
    h('p', { class: 'muted' }, baseName(path)),
    field('Spoken language', lang, 'Detecting works well; pick the language if the video mixes languages or starts with music.'),
    field('Translate to English', toggle(cfg.translate, (v) => (cfg.translate = v)), 'Writes English subtitles whatever language is spoken.'),
    h('p', { class: 'muted small' }, 'The subtitles are saved next to the video (as a .srt file other players can use too) and show up in the CC menu.'),
    h('div', { class: 'row-btns' }, h('button', { class: 'btn primary', onclick: async () => {
      save({ aiSubs: { language: cfg.language, translate: cfg.translate } });
      await api.queueAdd([{ kind: 'subs', input: path, language: cfg.language, translate: cfg.translate, audioTrack }]);
      m.close();
      toast('Making subtitles… you can keep watching. Progress is in Jobs.', 'ok', { label: 'Show', onClick: () => openJobs() });
    } }, 'Start'))
  ] });
}

// ---------------------------------------------------------------- AI upscaling
export async function upscale(path, info) {
  if (!(await ensure('upscale'))) return;
  const w = info?.width || 0, hgt = info?.height || 0;
  let W = w * 2, H = hgt * 2;
  if (W > 8192) { H = Math.round(H * 8192 / W); W = 8192; }
  const tooBig = !info?.isImage && w > 5120;
  const mins = info?.duration ? Math.max(1, Math.round((info.duration * (info.fps || 30) * (w * hgt / (1920 * 960)) * 0.09) / 60)) : 0;
  const m = modal({ title: '✨ AI upscaling', width: 480, body: [
    h('p', { class: 'muted' }, baseName(path)),
    tooBig ? h('p', {}, `This video is already ${w}×${hgt}, as sharp as headsets and video encoders handle well. Upscaling it isn't useful.`)
      : h('p', {}, `${w}×${hgt} → ${W - (W % 2)}×${H - (H % 2)}. The AI redraws fine detail on your graphics card, frame by frame.`),
    !tooBig && !info?.isImage ? h('p', { class: 'muted small' }, `Rough time: ${mins < 60 ? mins + ' min' : (mins / 60).toFixed(1) + ' hours'} on a fast graphics card. It works in the background, a few seconds of video at a time, and saves a new file next to the original.`) : null,
    h('div', { class: 'row-btns' }, tooBig ? h('button', { class: 'btn', onclick: () => m.close() }, 'OK') : h('button', { class: 'btn primary', onclick: async () => {
      await api.queueAdd([{ kind: 'upscale', input: path }]);
      m.close();
      toast('Upscaling started. Progress is in Jobs.', 'ok', { label: 'Show', onClick: () => openJobs() });
    } }, 'Start'))
  ] });
}

// ---------------------------------------------------------------- 2D -> 3D files
// A real side-by-side 3D copy that any headset player shows in 3D, made with the same
// depth model as the live view.
export async function make3DFile(path, info) {
  if (!(await ensure('depth'))) return;
  const photo = !!info?.isImage || /\.(jpe?g|png|webp)$/i.test(path);
  const c = depthCfg();
  const cfg = { strength: c.strength, pop: c.pop };
  const num = (key, min, max) => {
    const r = h('input', { type: 'range', min, max, step: 5, value: cfg[key] });
    const out = h('span', { class: 'muted' }, cfg[key] + '%');
    r.addEventListener('input', () => { cfg[key] = +r.value; out.textContent = r.value + '%'; });
    return h('div', { class: 'inline' }, r, out);
  };
  const secs = info?.duration ? Math.round(info.duration * 1.6 + 5) : 0;
  const m = modal({ title: photo ? '🧊 Make a 3D photo' : '🧊 Make a 3D video', width: 480, body: [
    h('p', { class: 'muted' }, baseName(path)),
    h('p', {}, photo ? 'Saves a side-by-side 3D copy of this photo next to the original.' : 'Saves a side-by-side 3D copy next to the original. It plays in 3D here, in other VR players and on 3D TVs, and keeps the sound.'),
    field('Depth', num('strength', 10, 100), 'How far near things stand out from far things'),
    field('Pop-out', num('pop', 0, 80), 'Higher: more of the picture comes out towards you. Lower: it sits behind the screen like a window, which is easier on the eyes.'),
    secs ? h('p', { class: 'muted small' }, `Takes about ${secs < 90 ? secs + ' seconds' : Math.round(secs / 60) + ' minutes'} on a fast graphics card.`) : null,
    h('div', { class: 'row-btns' }, h('button', { class: 'btn primary', onclick: async () => {
      setDepthCfg({ strength: cfg.strength, pop: cfg.pop });
      await api.queueAdd([{ kind: '3d', input: path, strength: cfg.strength, pop: cfg.pop }]);
      m.close();
      toast(photo ? 'Making a 3D photo…' : 'Making a 3D video… progress is in Jobs.', 'ok', { label: 'Show', onClick: () => openJobs() });
    } }, 'Start'))
  ] });
}

// A finished subtitle job for the video that's playing switches to the new subtitles
export function initAi({ currentPath, reloadSubs }) {
  refreshAi();
  on('job-done', (j) => {
    if (j.kind === 'subs' && j.output) {
      if (currentPath() && currentPath() === j.input) reloadSubs(j.output);
    }
  });
}
