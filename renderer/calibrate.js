import { api, on, settings, save, FORMAT_NAMES } from './core.js';
import { h, svg, card, rangeRow, field, toggle, segmented, select, toast, modal, numBox } from './ui.js';
import { BUILTIN_LOOKS, allPresets, savePreset, deletePreset, lutName } from './lut.js';
import { player, view } from './player.js';
import { DEFAULT_CALIB } from './vrview.js';

const rows = {};
const toggles = {};
const cards = {};

function slider(key, label, min, max, step, unit, info) {
  rows[key] = rangeRow({ label, info, value: DEFAULT_CALIB[key], min, max, step, unit, onChange: (v) => player.setCalib({ [key]: v }) });
  return rows[key];
}
function flag(key, label, info) {
  toggles[key] = toggle(DEFAULT_CALIB[key], (v) => player.setCalib({ [key]: v }));
  return field(label, toggles[key], info);
}
function section(key, title, info, body) {
  cards[key] = card({ title, info, toggled: DEFAULT_CALIB[key], onToggle: (v) => player.setCalib({ [key]: v }), body });
  return cards[key];
}

let alignBtn, alignNote, envSel, lookSel, presetSel;

// Measures how far the right eye is off from the left (vertical + roll) and corrects it
async function autoAlign() {
  const item = player.current();
  if (!item) return;
  if (item.format.layout === '2d') return toast('Auto-align is for 3D videos (side-by-side or top-bottom).', 'err');
  alignBtn.disabled = true;
  alignBtn.innerHTML = '<span class="spinner small"></span>Analysing 3 frames…';
  try {
    const r = await api.align(item.path, { ...item.format, fov: item.calib.fov }, item.info.duration);
    if (Math.abs(r.vertical) < 0.08 && Math.abs(r.roll) < 0.1) {
      alignNote.textContent = 'Eyes are already lined up. Nothing to fix.';
      toast('Eyes are already aligned', 'ok');
    } else {
      // split the correction between both eyes so neither is pushed far off-centre
      player.setCalib({ eyesOn: true, leftV: +(r.vertical / 2).toFixed(2), rightV: -(r.vertical / 2).toFixed(2), leftRoll: +(r.roll / 2).toFixed(2), rightRoll: -(r.roll / 2).toFixed(2) });
      const parts = [];
      if (Math.abs(r.vertical) >= 0.08) parts.push(`right eye was ${Math.abs(r.vertical).toFixed(2)}° ${r.vertical > 0 ? 'low' : 'high'}`);
      if (Math.abs(r.roll) >= 0.1) parts.push(`rotated ${Math.abs(r.roll).toFixed(2)}°`);
      alignNote.textContent = `Fixed: ${parts.join(', ')} (confidence ${Math.round(r.confidence * 100)}%). Reset video to undo.`;
      toast('Eyes aligned: ' + parts.join(', '), 'ok');
    }
  } catch (e) {
    toast('Auto-align failed: ' + String(e.message).replace(/.*Error: /, ''), 'err');
  } finally {
    alignBtn.disabled = false;
    alignBtn.innerHTML = svg('eye') + 'Auto-align eyes';
  }
}

// ---- horizon auto-level
let levelBtn, levelNote, levelSeg;
async function autoLevel() {
  const item = player.current();
  if (!item || item.info.isImage) return;
  const id = 'level-' + Date.now();
  levelBtn.disabled = true;
  const label = () => levelBtn.innerHTML = '<span class="spinner small"></span>Finding the horizon…';
  label();
  const off = (pid, p) => { if (pid === id) levelBtn.innerHTML = `<span class="spinner small"></span>Finding the horizon… ${Math.round(p.fraction * 100)}%`; };
  api.onProgress(off);
  try {
    const r = await api.levelAnalyze(id, item.path, { ...item.format, fov: item.calib.fov }, item.info.duration);
    const mode = settings.levelMode || 'follow';
    player.setLevel({ ...r, mode });
    const spread = Math.max(...r.rolls) - Math.min(...r.rolls);
    levelNote.textContent = (r.confident ? '' : 'Few straight lines found, so this is a best guess. ')
      + `Horizon was tilted ${Math.abs(r.fixed).toFixed(1)}° on average${spread > 1 ? `, moving by up to ${spread.toFixed(1)}° as the camera turned` : ''}. `
      + (mode === 'follow' ? 'Follow keeps it level the whole time.' : 'Fixed applies one correction.');
    toast(`Horizon levelled (${Math.abs(r.fixed).toFixed(1)}°)`, 'ok');
  } catch (e) {
    if (!/cancel/.test(e.message)) toast('Auto-level failed: ' + String(e.message).replace(/.*Error: /, ''), 'err');
  } finally {
    levelBtn.disabled = false;
    levelBtn.innerHTML = svg('level') + 'Auto-level horizon';
  }
}

export function initCalibrate(page) {
  const eyes = section('eyesOn', 'Per-Eye Calibration',
    'Fix poorly stitched or misaligned 3D. IPD turns the two eyes apart or together; vertical alignment removes the "double image" strain. Double-click a slider to reset it.', [
      slider('ipd', 'IPD offset', -8, 8, 0.1, '°', 'Positive pushes the image further away, negative brings it closer.'),
      slider('leftV', 'Left eye vertical', -4, 4, 0.05, '°'),
      slider('rightV', 'Right eye vertical', -4, 4, 0.05, '°'),
      slider('leftRoll', 'Left eye roll', -5, 5, 0.05, '°'),
      slider('rightRoll', 'Right eye roll', -5, 5, 0.05, '°'),
      slider('leftZoom', 'Left eye zoom', 90, 110, 0.5, '%', 'Per-eye focus/scale to match two lenses'),
      slider('rightZoom', 'Right eye zoom', 90, 110, 0.5, '%'),
      flag('swap', 'Swap eyes', 'For files with left and right eyes stored the wrong way round.'),
      alignBtn = h('button', { class: 'btn primary', 'data-tour': 'align', onclick: autoAlign, html: svg('eye') + 'Auto-align eyes' }),
      alignNote = h('div', { class: 'muted' })
    ]);
  const comfort = section('comfortOn', 'View Comfort',
    'Tilt, level and resize the picture. Lay-down mode lifts the picture 60° in the headset so you can watch lying back with the horizon kept level.', [
      slider('tilt', 'Tilt up / down', -90, 90, 1, '°'),
      slider('roll', 'Horizon level', -30, 30, 0.5, '°', 'Straighten a crooked horizon'),
      slider('height', 'Height', -50, 50, 1, 'cm', 'Moves the picture up or down relative to your head (headset)'),
      slider('scale', 'Scale', 50, 200, 1, '%', 'Makes everything appear bigger or smaller'),
      flag('laydown', 'Lay-down mode', 'Only applies in the headset'),
      field('Comfort vignette', segmented([{ value: 'off', label: 'Off' }, { value: 'gentle', label: 'Gentle' }, { value: 'strong', label: 'Strong' }], settings.comfortVignette || 'off',
        (v) => save({ comfortVignette: v }), 'small'), 'Narrows your view softly while the camera swings or shakes, which reduces motion sickness. Opens up again when the picture is calm. Applies to every video.'),
      field('Horizon auto-level', levelSeg = segmented([{ value: 'off', label: 'Off' }, { value: 'fixed', label: 'Fixed' }, { value: 'follow', label: 'Follow' }], 'off', (v) => {
        if (v !== 'off') save({ levelMode: v });
        if (!player.level()?.rolls && v !== 'off') { levelSeg.set('off'); autoLevel(); return; }
        player.setLevelMode(v);
      }, 'small'), 'Fixed: one correction for the whole video. Follow: keeps the horizon level as a handheld camera tilts. Applies to playback and to Convert to VR180.'),
      levelBtn = h('button', { class: 'btn primary', 'data-tour': 'level', onclick: autoLevel, html: svg('level') + 'Auto-level horizon' }),
      levelNote = h('div', { class: 'muted' })
    ]);
  const lens = section('lensOn', 'Lens',
    'For fisheye footage: lens field of view, off-centre lens circles and anamorphic (squeezed) footage.', [
      slider('fov', 'Fisheye FOV', 150, 240, 1, '°', 'Most VR180 lenses are 180–200°'),
      slider('cx', 'Lens centre X', -10, 10, 0.1, '%'),
      slider('cy', 'Lens centre Y', -10, 10, 0.1, '%'),
      slider('stretch', 'Anamorphic stretch', 50, 200, 1, '%', 'Un-squeezes horizontally squeezed footage'),
      slider('screen', 'Virtual screen size', 30, 150, 1, '°', 'Size of the screen for flat 2D videos'),
      field('Curved screen', toggle(!!settings.curvedScreen, (v) => { save({ curvedScreen: v }); view.setCurved(v); }), 'Flat 2D videos on a gently curved screen, like an IMAX, so the edges aren\'t stretched'),
      field('Surroundings', envSel = select([{ value: '0', label: 'Void' }, { value: '1', label: 'Cinema' }, { value: '2', label: 'Lounge' }, { value: '3', label: 'Starfield' }, { value: '4', label: 'Sunset' }],
        String(settings.env ?? 1), (v) => { save({ env: +v }); view.setEnv(+v); }), 'What you see around the screen when watching flat 2D videos')
    ]);
  const lookOptions = () => [{ value: '', label: 'None' }, ...Object.entries(BUILTIN_LOOKS).map(([k, v]) => ({ value: 'builtin:' + k, label: v.name })),
    ...(player.current()?.calib.lut && !player.current().calib.lut.startsWith('builtin:') ? [{ value: player.current().calib.lut, label: lutName(player.current().calib.lut) }] : []),
    { value: '__load', label: 'Load .cube file…' }];
  lookSel = select(lookOptions(), '', async (v) => {
    if (v === '__load') {
      const f = await api.lutDialog();
      if (!f) { lookSel.set(player.current()?.calib.lut || ''); return; }
      v = f;
    }
    try { await player.setCalib({ lut: v || null, pictureOn: true }); } catch (e) { toast('Could not load that LUT: ' + e.message, 'err'); }
    refreshLooks();
  });
  presetSel = select([], '', (v) => {
    const p = allPresets().find((x) => x.name === v);
    if (p) { player.setCalib({ pictureOn: true, brightness: p.brightness, contrast: p.contrast, saturation: p.saturation, lut: p.lut, lutMix: p.lutMix }); toast(`Preset: ${p.name}`); }
    presetSel.set('');
  });
  const picture = section('pictureOn', 'Picture', 'Colour adjustments and looks. They show live, and Convert to VR180 can bake them into the export.', [
    field('Preset', h('div', { class: 'inline' }, presetSel,
      h('button', { class: 'btn', onclick: savePresetDialog, title: 'Save the current picture settings as a preset' }, 'Save…'))),
    field('Colour look', lookSel, 'A LUT (colour look-up table). Load a .cube from your camera maker, e.g. to turn flat log footage into normal colour.'),
    rows.lutStrength = rangeRow({ label: 'Look strength', value: 100, min: 0, max: 100, step: 1, unit: '%', onChange: (v) => player.setCalib({ lutMix: v / 100 }) }),
    slider('brightness', 'Brightness', -50, 50, 1, '%'),
    slider('contrast', 'Contrast', 50, 200, 1, '%'),
    slider('saturation', 'Saturation', 0, 200, 1, '%'),
    rangeRow({ label: 'Sharpness', info: 'Adaptive sharpening on the GPU: brings back detail that VR magnification softens, without halos. Applies to every video.', value: settings.sharpen ?? 25, min: 0, max: 100, step: 5, unit: '%',
      onChange: (v) => { save({ sharpen: v }); view.setQuality({ sharpen: v / 100 }); } }),
    field('Match flat view', toggle(!!settings.matchFlat, (on) => { save({ matchFlat: on }); view.setVibrance(on ? (settings.matchFlatAmt ?? 50) / 100 : 0); }),
      'Gives the VR view a little more colour and punch, closer to how the flat view looks with the graphics card\'s video enhancements. Applies to every video.'),
    rangeRow({ label: 'Match strength', value: settings.matchFlatAmt ?? 50, min: 10, max: 100, step: 5, unit: '%', onChange: (v) => { save({ matchFlatAmt: v }); if (settings.matchFlat) view.setVibrance(v / 100); } })
  ]);
  view.setVibrance(settings.matchFlat ? (settings.matchFlatAmt ?? 50) / 100 : 0);
  function refreshLooks() {
    lookSel.replaceChildren(...lookOptions().map((o) => h('option', { value: o.value }, o.label)));
    lookSel.set(player.current()?.calib.lut || '');
    presetSel.replaceChildren(h('option', { value: '' }, 'Choose…'), ...allPresets().map((p) => h('option', { value: p.name }, p.name + (p.builtin ? '' : ' ★'))));
    presetSel.set('');
  }
  function savePresetDialog() {
    const item = player.current();
    if (!item) return;
    const input = h('input', { type: 'text', placeholder: 'e.g. Beach day', maxlength: 30 });
    const ok = () => { const n = input.value.trim(); if (!n) return; savePreset(n, item.calib); refreshLooks(); m.close(); toast(`Saved preset "${n}"`, 'ok'); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    const mine = allPresets().filter((p) => !p.builtin);
    const m = modal({ title: 'Save picture preset', width: 380, body: [
      h('p', { class: 'muted' }, `Saves brightness, contrast, saturation and the colour look (${lutName(item.calib.lut)}).`), input,
      h('button', { class: 'btn primary wide', onclick: ok }, 'Save preset'),
      ...(mine.length ? [h('div', { class: 'muted' }, 'Your presets'), ...mine.map((p) => h('div', { class: 'inline' }, h('span', { class: 'grow' }, p.name),
        h('button', { class: 'btn danger', onclick: () => { deletePreset(p.name); refreshLooks(); m.close(); toast('Preset deleted'); } }, 'Delete')))] : [])] });
    setTimeout(() => input.focus(), 30);
  }

  const formatLine = h('div', { class: 'muted' });
  // Preview: one eye at a time, red/cyan anaglyph, or both eyes side by side
  const eyeSeg = segmented([{ value: 'L', label: 'Left' }, { value: 'R', label: 'Right' }, { value: 'anaglyph', label: '3D' }, { value: 'sbs', label: 'L|R' }], 'L', (v) => {
    if (v === 'L' || v === 'R') { player.setViewMode('vr'); view.showEye(v === 'L' ? 1 : 2); }
    else { view.showEye(1); player.setViewMode(v); }
  }, 'small');
  // Per camera: these settings for every video from the same camera (unless a video has its own)
  const camBtn = h('button', { class: 'btn', hidden: true });
  async function refreshCam() {
    const it = player.current();
    camBtn.hidden = true;
    if (!it || it.info.isImage) return;
    if (it.camera === undefined) it.camera = await api.cameraOf(it.path).catch(() => null);
    if (player.current() !== it || !it.camera) return;
    const has = !!settings.cameraCalib?.[it.camera];
    camBtn.hidden = false;
    camBtn.textContent = has ? `Update ${it.camera} settings` : `Use for all ${it.camera} videos`;
    camBtn.title = `Every ${it.camera} video you open gets these settings, unless you tuned that video itself.`;
    camBtn.onclick = () => {
      save({ cameraCalib: { ...settings.cameraCalib, [it.camera]: { ...it.calib } } });
      toast(`Saved for all ${it.camera} videos`, 'ok');
      refreshCam();
    };
  }
  on('loaded', refreshCam);
  on('tab', (t) => { if (t === 'calibrate') refreshCam(); });

  const preview = card({
    title: 'Live Preview', info: 'Your changes show here instantly. Drag to look around. Settings are saved per video.',
    actions: [eyeSeg], body: [h('div', { id: 'calibStageSlot' }), formatLine,
      h('div', { class: 'calib-foot' },
        h('button', { class: 'btn', onclick: () => { player.setCalib({ ...DEFAULT_CALIB }); toast('Calibration reset for this video'); } }, 'Reset video'),
        h('button', { class: 'btn', onclick: () => { save({ calibDefault: { ...player.current().calib } }); toast('Saved as default for new videos', 'ok'); } }, 'Save as default'),
        h('button', { class: 'btn', onclick: () => { if (settings.calibDefault) player.setCalib({ ...settings.calibDefault }); else toast('No default saved yet'); } }, 'Apply default'),
        camBtn)]
  });
  preview.style.height = '100%';

  page.append(h('div', { class: 'calib-layout' },
    h('div', { class: 'calib-cards' }, h('div', { class: 'grid2' }, h('div', { class: 'stack' }, eyes, lens), h('div', { class: 'stack' }, comfort, picture))),
    h('div', { class: 'calib-preview' }, preview)));

  const sync = () => {
    const item = player.current();
    const c = item?.calib || DEFAULT_CALIB;
    for (const [k, r] of Object.entries(rows)) r.set(k === 'lutStrength' ? Math.round((c.lutMix ?? 1) * 100) : c[k]);
    refreshLooks();
    const lv = item && player.level();
    levelSeg.set(lv?.mode || 'off');
    levelBtn.disabled = !item || !!item.info.isImage;
    if (!lv?.rolls) levelNote.textContent = item ? '' : '';
    for (const [k, t] of Object.entries(toggles)) t.set(c[k]);
    for (const [k, cd] of Object.entries(cards)) { cd.toggle.set(c[k]); cd.setEnabled(!!item && c[k]); }
    preview.querySelectorAll('.calib-foot .btn').forEach((b) => (b.disabled = !item));
    formatLine.textContent = item
      ? `${item.name} · ${FORMAT_NAMES.projection[item.format.projection]} · ${FORMAT_NAMES.layout[item.format.layout]}`
      : 'Open a video in the Player tab to calibrate it.';
    eyeSeg.style.display = item && item.format.layout !== '2d' ? '' : 'none';
    alignBtn.style.display = item && item.format.layout !== '2d' ? '' : 'none';
    if (!item) alignNote.textContent = '';
  };
  on('item', sync);
  on('calib', sync);
  on('format', sync);
  on('level', sync);
  view.setEnv(settings.env ?? 1);
  on('tab', (t) => {
    if (t !== 'calibrate') { view.showEye(1); if (eyeSeg.value !== 'L') player.setViewMode('vr'); eyeSeg.set('L'); }
    else sync();
  });
  sync();
}
