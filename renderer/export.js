// Convert-to-VR180 dialog, used for one video (Player), many (Library batch),
// or a joined/cut edit (Edit dialog). Jobs go to the background queue.
import { api, settings, save, fmtTime, baseName, fileKey, FORMAT_NAMES, emit } from './core.js';
import { h, segmented, numBox, select, toast, modal, toggle, field } from './ui.js';
import { openJobs } from './jobs.js';
import { lutFileFor, lutName } from './lut.js';

const canConvert = (f, info) => (f.projection === 'fisheye' || f.projection === 'equirect180' || f.projection === 'equirect360') && !info?.isImage;

// One-click targets: the numbers people shouldn't have to know
export const TARGETS = {
  youtube: { name: 'YouTube VR180', blurb: 'H.264, up to 5.7K side-by-side, high bitrate, 320k audio. Upload straight to YouTube.',
    opts: { codec: 'h264', eyeSize: 2880, noUpscale: true, crf: 17, maxrate: 120, audioBitrate: '320k' } },
  quest3: { name: 'Quest 3', blurb: 'HEVC 5760×2880 side-by-side, up to 60 fps, about 90 Mbps. Plays smoothly in the Quest browser and players like Skybox.',
    opts: { codec: 'h265', eyeSize: 2880, noUpscale: true, crf: 20, maxrate: 90, fpsmax: 60 } },
  visionpro: { name: 'Apple Vision Pro', blurb: 'HEVC 10-bit, 4096 per eye side-by-side, about 100 Mbps. Plays as VR180 in Vision Pro apps like Moon Player or Reality Player. (Apple\'s own spatial MV-HEVC format can\'t be written by ffmpeg.)',
    opts: { codec: 'h265', eyeSize: 4096, noUpscale: true, crf: 20, maxrate: 100, tenbit: true } },
  custom: { name: 'Custom', blurb: 'Choose everything yourself.', opts: {} }
};

const parseClock = (s) => {
  const parts = String(s).trim().split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((acc, v) => acc * 60 + v, 0); // "1:05" -> 65, "1:02:03" -> 3723
};
// alignment fixes from Calibrate (eyes and lens); viewing comforts don't count
const ALIGN_KEYS = { ipd: 0, leftV: 0, rightV: 0, leftRoll: 0, rightRoll: 0, leftZoom: 100, rightZoom: 100, swap: false, cx: 0, cy: 0, stretch: 100 };
const hasAlignment = (c) => !!c && Object.entries(ALIGN_KEYS).some(([k, d]) => (c[k] ?? d) !== d);
const lookIsDefault = (c) => !c || (!c.lut && !c.brightness && (c.contrast ?? 100) === 100 && (c.saturation ?? 100) === 100) || c.pictureOn === false;

// items: [{ path, name, format, info, calib?, chapters?, ab?, level?, audioTrack? }]
// edit:  { segments: [{ input, start, end }], chapters, name } for the Edit dialog
// finished test conversions report back to the dialog that started them
let onTestDone = null;
api.onJobDone((j) => { if (j.test) onTestDone?.(j); });
api.onJobFailed((j) => { if (j.test) onTestDone?.(j); });

export async function openExportDialog(items, edit = null) {
  const usable = items.filter((it) => canConvert(it.format, it.info));
  const skipped = items.length - usable.length;
  if (!usable.length) return toast('Only 180° and 360° videos can be converted to VR180.', 'err');
  const single = usable.length === 1 ? usable[0] : null;
  const gpu = await api.encoders().catch(() => null);
  const ex = { target: 'custom', size: 0, codec: 'h264', crf: 18, stabilize: 'off', encoder: 'auto', ...settings.exportDefaults };
  // fisheye and 360 always need re-projecting, so "No re-encode" only fits ready-made equirect 180
  const allFisheye = usable.every((it) => it.format.projection !== 'equirect180');
  if ((allFisheye || edit) && ex.codec === 'copy') ex.codec = 'h264';

  const summary = edit ? `Joins ${edit.segments.length} part${edit.segments.length > 1 ? 's' : ''} (${fmtTime(edit.segments.reduce((a, s) => a + (s.end - s.start) / (s.speed || 1) + (s.freeze || 0), 0))} in total) into one VR180 video.`
    : single
      ? (single.format.projection === 'equirect360'
        ? `Keeps the half of this 360° video you are facing now (${Math.round(Math.abs(single.viewYaw || 0))}° ${(single.viewYaw || 0) >= 0 ? 'right' : 'left'} of its front) and saves it as VR180${single.format.layout === 'tb' ? ', side by side' : ''}. Look somewhere else first to pick another half.`
        : single.format.projection === 'fisheye'
        ? `Converts this ${single.calib?.fov ?? 180}° fisheye ${FORMAT_NAMES.layout[single.format.layout].toLowerCase()} video to 180° equirectangular with VR180 metadata.`
        : `Already equirectangular. Saves it as a VR180 file with ${FORMAT_NAMES.layout[single.format.layout].toLowerCase()} spherical metadata.`)
      : `${usable.length} videos will be converted one after another in the background.` + (skipped ? ` (${skipped} non-180° video${skipped > 1 ? 's' : ''} skipped.)` : '');

  // ---- target preset
  const blurb = h('div', { class: 'muted target-blurb' });
  const target = segmented(Object.entries(TARGETS).map(([k, t]) => ({ value: k, label: t.name })), ex.target, (v) => { ex.target = v; applyTarget(); }, 'small target-seg');

  // ---- options
  const codec = segmented([
    { value: 'h264', label: 'H.264' }, { value: 'h265', label: 'H.265' },
    ...(!allFisheye && !edit ? [{ value: 'copy', label: 'No re-encode', title: 'Equirect videos only: keeps the original picture, very fast' }] : [])
  ], ex.codec, (v) => { ex.codec = v; custom(); sync(); }, 'small');
  const size = select([
    { value: '0', label: 'Keep original' }, { value: '2048', label: '2048 (4K SBS)' },
    { value: '2880', label: '2880 (5.7K SBS)' }, { value: '3840', label: '3840 (8K SBS)' }, { value: '4096', label: '4096 (8K SBS)' }
  ], String(ex.size), (v) => { ex.size = +v; custom(); });
  const crf = numBox({ value: ex.crf, min: 12, max: 30, step: 1, unit: 'CRF', width: 90, onChange: (v) => { ex.crf = v; custom(); sync(); } });
  const qual = h('span', { class: 'muted' });
  const stab = segmented([{ value: 'off', label: 'Off' }, { value: 'light', label: 'Light' }, { value: 'medium', label: 'Medium' }, { value: 'strong', label: 'Strong' }],
    ex.stabilize, (v) => { ex.stabilize = v; sync(); }, 'small');
  const gpuName = gpu?.vendor ? `GPU (${gpu.vendor})` : 'GPU';
  const encSeg = segmented([{ value: 'auto', label: 'Auto' }, { value: 'gpu', label: gpuName }, { value: 'cpu', label: 'CPU' }], ex.encoder, (v) => { ex.encoder = v; sync(); }, 'small');
  if (!gpu?.h264 && !gpu?.hevc) encSeg.setHidden('gpu', true);

  // ---- horizon + look (single video)
  // a horizon curve belongs to one video: in an edit, only use it if every part comes from that video
  const levelFits = !edit || edit.segments.every((s) => s.input === single?.path);
  const lv = levelFits && single?.level && single.level.mode !== 'off' ? single.level : null;
  let withLevel = !!lv;
  const levelToggle = toggle(withLevel, (v) => (withLevel = v));
  const look = single?.calib;
  let withLook = !lookIsDefault(look);
  const lookToggle = toggle(withLook, (v) => (withLook = v));

  // ---- range (single video, not edits)
  const dur = single?.info.duration || 0;
  const ab = single?.ab;
  const hasAB = ab && ab.a != null && ab.b != null;
  const range = { mode: hasAB ? 'ab' : 'all', start: hasAB ? ab.a : 0, end: hasAB ? ab.b : dur };
  const startIn = h('input', { type: 'text', value: fmtTime(range.start), style: { width: '78px' } });
  const endIn = h('input', { type: 'text', value: fmtTime(range.end), style: { width: '78px' } });
  const rangeSeg = single && !edit ? segmented([{ value: 'all', label: 'Whole video' }, { value: 'ab', label: 'A-B loop' }, { value: 'custom', label: 'Custom' }], range.mode, (v) => { range.mode = v; sync(); }, 'small') : null;
  if (rangeSeg && !hasAB) rangeSeg.setHidden('ab', true);
  const customRow = h('div', { class: 'inline', style: { justifyContent: 'flex-end' } }, h('span', { class: 'muted' }, 'From'), startIn, h('span', { class: 'muted' }, 'to'), endIn);

  // ---- chapters
  const chapters = edit ? edit.chapters || [] : single?.chapters || [];
  let withChapters = chapters.length > 0;
  const chapToggle = toggle(withChapters, (v) => (withChapters = v));

  // ---- output (batch)
  let folder = null;
  const folderLabel = h('span', { class: 'muted' }, 'Next to each original');
  const folderBtn = h('button', { class: 'btn', onclick: async () => { const f = await api.folderDialog(); if (f) { folder = f; folderLabel.textContent = f; } } }, 'Choose folder…');

  // ---- text: title, date stamp, burned-in subtitles (single video or edit)
  const tx = { titleOn: false, title: (single || usable[0]).name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), at: 0, dur: 5, size: 5, y: 0, depth: 2.5, dateOn: false, subsOn: false };
  const cues = !edit && single?.subs?.length ? single.subs : null;
  let shotAt = null;
  api.libraryDetails((single || usable[0]).path).then((d) => { shotAt = d?.shotAt || null; dateRow.style.display = shotAt ? '' : 'none'; dateLabel.textContent = shotAt ? `Date stamp (${fmtDate(shotAt)})` : ''; }).catch(() => {});
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const titleIn = h('input', { type: 'text', value: tx.title, maxlength: 80, style: { width: '220px' }, oninput: (e) => (tx.title = e.target.value) });
  const titleOpts = h('div', { class: 'text-opts' },
    h('div', { class: 'inline' }, h('span', { class: 'muted' }, 'Show from'), numBox({ value: 0, min: 0, max: 3600, step: 1, unit: 's', width: 76, onChange: (v) => (tx.at = v) }),
      h('span', { class: 'muted' }, 'for'), numBox({ value: 5, min: 1, max: 60, step: 1, unit: 's', width: 76, onChange: (v) => (tx.dur = v) })),
    h('div', { class: 'inline' }, h('span', { class: 'muted' }, 'Size'), segmented([{ value: '3.5', label: 'Small' }, { value: '5', label: 'Medium' }, { value: '7', label: 'Large' }], '5', (v) => (tx.size = +v), 'small'),
      h('span', { class: 'muted' }, 'Place'), segmented([{ value: '-15', label: 'Higher' }, { value: '0', label: 'Ahead' }, { value: '18', label: 'Lower' }], '0', (v) => (tx.y = +v), 'small')),
    h('div', { class: 'inline' }, h('span', { class: 'muted' }, 'Depth'), segmented([{ value: '1.5', label: 'Near' }, { value: '2.5', label: 'Comfortable' }, { value: '4', label: 'Far' }], '2.5', (v) => (tx.depth = +v), 'small'),
      h('button', { class: 'btn small', onclick: previewTitle }, 'Preview')));
  titleOpts.style.display = 'none';
  const titleToggle = toggle(false, (v) => { tx.titleOn = v; titleOpts.style.display = v ? '' : 'none'; });
  const dateLabel = h('span', {});
  const dateRow = h('div', { class: 'row-field simple' }, h('div', { class: 'rl' }, dateLabel), toggle(false, (v) => (tx.dateOn = v)));
  dateRow.style.display = 'none';
  async function previewTitle() {
    const { view } = await import('./player.js');
    view.setSubtitle(tx.title, { size: tx.size * 20, bg: 45 });
    setTimeout(() => view.setSubtitle(''), 3500);
    toast('Showing the title in the player for a few seconds');
  }
  function textOverlays() {
    const out = [];
    if (tx.titleOn && tx.title.trim()) out.push({ text: tx.title.trim(), start: tx.at, end: tx.at + tx.dur, size: tx.size, y: tx.y, depth: tx.depth });
    if (tx.dateOn && shotAt) out.push({ text: fmtDate(shotAt), start: 0.5, end: 6, size: 3, y: 24, depth: 2.5 });
    return out;
  }

  const note = h('p', { class: 'muted', style: { fontSize: '12px' } });
  function applyTarget() {
    const t = TARGETS[ex.target];
    blurb.textContent = t.blurb;
    if (ex.target === 'custom') return sync();
    Object.assign(ex, { codec: t.opts.codec, size: t.opts.eyeSize || 0, crf: t.opts.crf });
    codec.set(ex.codec); size.set(String(ex.size)); crf.set(ex.crf);
    sync();
  }
  function custom() { if (ex.target !== 'custom') { ex.target = 'custom'; target.set('custom'); blurb.textContent = TARGETS.custom.blurb; } }
  function sync() {
    const copy = ex.codec === 'copy';
    crf.classList.toggle('disabled', copy);
    size.disabled = copy;
    stab.style.opacity = copy ? 0.4 : 1;
    if (copy && ex.stabilize !== 'off') { ex.stabilize = 'off'; stab.set('off'); }
    qual.textContent = copy ? 'original quality' : ex.crf <= 15 ? 'very high quality' : ex.crf <= 19 ? 'high quality' : ex.crf <= 23 ? 'good quality' : 'smaller file';
    customRow.style.display = range.mode === 'custom' ? '' : 'none';
    const notes = [];
    if (ex.stabilize !== 'off') notes.push('Stabilization analyses the whole clip first (2 passes) and crops the edges slightly. Both eyes get the same correction, so 3D stays intact.');
    if (copy && range.mode !== 'all') notes.push('Without re-encoding, cuts snap to the nearest keyframe.');
    if (ex.encoder !== 'cpu' && gpu?.vendor) notes.push(`Encoding uses your ${gpu.vendor} graphics card, which is usually several times faster. If it fails, the CPU takes over automatically.`);
    note.textContent = notes.join(' ');
  }

  const body = [
    h('p', { class: 'muted' }, summary),
    field('Target', target), blurb,
    field('Video codec', codec),
    field('Resolution per eye', size, 'Never upscaled beyond the original by the presets.'),
    h('div', { class: 'row-field simple' }, h('div', { class: 'rl' }, 'Quality ', qual), crf),
    field('Encoder', encSeg, 'GPU encoding (NVIDIA NVENC, AMD AMF or Intel Quick Sync) is much faster than the CPU.'),
    field('Stabilize', stab, 'Smooths out handheld shake, which helps prevent motion sickness in VR.')
  ];
  if (lv) body.push(field(`Level horizon (${lv.mode === 'follow' ? 'follow' : `${Math.abs(lv.fixed).toFixed(1)}°`})`, levelToggle, 'Uses the Auto-level result from Calibrate.'));
  if (single && hasAlignment(single.calib)) body.push(field('Bake in eye alignment', toggle(ex.bake !== false, (v) => (ex.bake = v)), 'Your Calibrate fixes (eye angle, height, roll, zoom, swapped eyes, lens centre) go into the file, so every player and headset shows it lined up like here.'));
  if (single && !lookIsDefault(look)) body.push(field(`Bake in colour look${look.lut ? ` (${lutName(look.lut)})` : ''}`, lookToggle, 'Applies your Picture settings and colour look to the exported file.'));
  if (single && !edit) body.push(field('Range', rangeSeg, 'Export just part of the video. Set an A-B loop in the player (Shift+A) to use it here. To cut sections out or join clips, use Edit.'), customRow);
  if ((single || edit) && chapters.length) body.push(field(`Include ${chapters.length} chapter${chapters.length > 1 ? 's' : ''}`, chapToggle, 'Your named bookmarks become real chapters that players like VLC show.'));
  if (single || edit) {
    body.push(field('Title', h('div', { class: 'inline' }, titleIn, titleToggle), 'Text that floats in front of you at the start (or any time) of the video. Depth sets how far away it appears in the headset.'), titleOpts, dateRow);
    if (cues) body.push(field(`Burn in subtitles (${cues.length} lines)`, toggle(false, (v) => (tx.subsOn = v)), 'Draws the subtitles that are loaded in the player into the video itself, at a comfortable depth, so every player shows them.'));
  }
  if (!single && !edit) body.push(field('Save to', h('div', { class: 'inline' }, folderLabel, folderBtn)));
  body.push(field('Even out loudness', toggle(!!ex.audioLoud, (v) => { ex.audioLoud = v; }), 'Brings the sound to the level YouTube and streaming apps use (-14 LUFS), so quiet clips aren\'t too quiet and loud ones don\'t blast. Spatial audio is left as it is.'),
    field('Reduce wind and hiss', toggle(!!ex.audioWind, (v) => { ex.audioWind = v; }), 'Cuts low rumble from wind and handling, and steady background hiss.'));
  // a quick test: 10 seconds with these settings, then a time and size estimate for the whole thing
  const testBtn = h('button', { class: 'btn wide', title: 'Convert 10 seconds with these settings to check the result and see how long the whole video will take', onclick: () => start(true) }, '▶ Test 10 seconds first');
  body.push(note, ...(single && !edit && !single.info?.isImage ? [testBtn] : []), h('button', { class: 'btn primary wide', onclick: () => start() }, single || edit ? 'Choose where to save & convert' : `Convert ${usable.length} videos`));

  const m = modal({ title: edit ? 'Export edit as VR180' : single ? 'Convert to VR180' : 'Batch convert to VR180', body, width: 560 });
  applyTarget();

  async function start(test = false) {
    save({ exportDefaults: { target: ex.target, size: ex.size, codec: ex.codec, crf: ex.crf, stabilize: ex.stabilize, encoder: ex.encoder, audioLoud: !!ex.audioLoud, audioWind: !!ex.audioWind } });
    const t = TARGETS[ex.target].opts;
    const base = {
      codec: ex.codec, crf: ex.crf, stabilize: ex.stabilize, encoder: ex.encoder,
      eyeSize: ex.codec === 'copy' ? 0 : ex.size, noUpscale: !!t.noUpscale, audioLoud: !!ex.audioLoud, audioWind: !!ex.audioWind,
      maxrate: t.maxrate, fpsmax: t.fpsmax, tenbit: t.tenbit, audioBitrate: t.audioBitrate
    };
    let list;
    if (edit || single) {
      const src = single || usable[0];
      const extra = {};
      if (single && withLevel && lv) extra.level = lv.mode === 'fixed' ? { mode: 'fixed', roll: lv.fixed } : { mode: 'follow', interval: lv.interval, rolls: lv.rolls };
      if (single && withLook && !lookIsDefault(look)) {
        extra.picture = { brightness: look.brightness, contrast: look.contrast, saturation: look.saturation };
        if (look.lut) { extra.lut = await lutFileFor(look.lut); extra.lutMix = look.lutMix ?? 1; }
      }
      let start = 0, end = 0;
      if (!edit && range.mode === 'ab') { start = ab.a; end = ab.b; }
      if (!edit && range.mode === 'custom') {
        start = parseClock(startIn.value); end = parseClock(endIn.value);
        if (isNaN(start) || isNaN(end) || end <= start + 0.5 || end > dur + 1) return toast('Check the start and end times (e.g. 1:05 to 2:30).', 'err');
      }
      // the full length this export will have, for the test's estimate
      const fullLength = edit ? 0 : (end || dur) - (start || 0);
      if (test) { if (range.mode === 'all') start = Math.max(0, dur / 2 - 5); end = Math.min(start + 10, end || dur); }
      const suffix = edit ? '_VR180_edit' : range.mode === 'all' ? '_VR180' : `_VR180_${fmtTime(start).replace(/:/g, '-')}`;
      const output = test ? await api.testOutput(baseName(src.path).replace(/\.[^.]+$/, '') + '_test10s.mp4') : await api.saveDialog(src.path.replace(/\.[^.\\/]+$/, '') + suffix + '.mp4');
      if (!output) return;
      if (items.some((it) => fileKey(output) === fileKey(it.path))) return toast('Choose a different file name than the original.', 'err');
      list = [{ ...base, ...extra, output, projection: src.format.projection, layout: src.format.layout, fov: src.calib?.fov ?? 180, calib: ex.bake === false ? null : src.calib, audioTrack: src.audioTrack || 0, yaw: src.viewYaw || 0, pitch: src.viewPitch || 0,
        ...(edit ? { segments: edit.segments } : { input: src.path, start: start || undefined, end: end || undefined }),
        chapters: withChapters ? chapters : [],
        texts: textOverlays(), ...(tx.subsOn && cues ? { subtitles: cues.map((c) => ({ start: c.start, end: c.end, text: c.text })) } : {}) }];
      if ((list[0].texts.length || list[0].subtitles) && list[0].codec === 'copy') list[0].codec = 'h264';
      if (test) {
        list[0].test = true;
        const testLen = end - start;
        testBtn.disabled = true;
        testBtn.textContent = 'Testing 10 seconds…';
        const done = (j) => {
          if (j.output !== output && j.input !== src.path) return;
          if (!j.test) return;
          testBtn.disabled = false;
          testBtn.textContent = '▶ Test 10 seconds again';
          if (j.status === 'failed') { note.textContent = 'The test failed: ' + (j.error || 'unknown error'); return; }
          const k = fullLength / Math.max(1, testLen);
          const secs = (j.elapsed || 0) * k, mb = ((j.size || 0) * k) / 1e6;
          note.replaceChildren(`Test: 10 s took ${(j.elapsed || 0).toFixed(1)} s. The whole video should take about ${secs < 90 ? Math.round(secs) + ' seconds' : Math.round(secs / 60) + ' minutes'} and be about ${mb < 1000 ? Math.round(mb) + ' MB' : (mb / 1000).toFixed(1) + ' GB'}. `,
            h('button', { class: 'btn small', onclick: () => { m.close(); emit('goto', 'player'); window.__app?.player.open([output]); } }, 'Watch the test'));
        };
        onTestDone = done;
        await api.queueAdd(list);
        return;
      }
    } else {
      list = usable.map((it) => ({ ...base, input: it.path, folder, projection: it.format.projection, layout: it.format.layout,
        fov: (settings.calib[fileKey(it.path)] || {}).fov ?? 180, calib: ex.bake === false ? null : (settings.calib[fileKey(it.path)] || null),
        chapters: (settings.bookmarks[fileKey(it.path)] || []).filter((b) => typeof b === 'object') }));
    }
    await api.queueAdd(list);
    m.close();
    toast(edit ? 'Exporting your edit in the background' : single ? `Converting ${baseName(single.path)} in the background` : `${list.length} videos added to the queue`, 'ok');
    openJobs();
  }
}
