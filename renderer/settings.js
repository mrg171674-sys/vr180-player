import { api, settings, save, emit } from './core.js';
import { h, card, toggle, segmented, numBox, select, field, toast, pinDialog, strip, modal } from './ui.js';
import { player, video, view } from './player.js';
import { sfx } from './sfx.js';
import { themePicker } from './themes.js';
import { aiCard } from './ai.js';
import { ACTIONS, keysFor, setKeys, resetKeys, comboOf, prettyKey, PAD_BUTTONS, padAction, setPad, PAD_DEFAULTS } from './shortcuts.js';
import { listenPad } from './gamepad.js';
import * as THREE from '../node_modules/three/build/three.module.js';

export const ACCENTS = { green: ['#2f7d4f', '#3c9a62'], gold: ['#8a6a1f', '#c99a2e'], blue: ['#2f5f9a', '#4a86d0'], purple: ['#5b3f94', '#8a63d2'], red: ['#8f3434', '#c95050'] };
// No accent chosen = use the theme's own accent colour
export function applyAccent(name) {
  const st = document.documentElement.style;
  if (!name || !ACCENTS[name]) { st.removeProperty('--green'); st.removeProperty('--green-hi'); return; }
  const [a, b] = ACCENTS[name];
  st.setProperty('--green', a);
  st.setProperty('--green-hi', b);
}

const bench = {};

export function initSettings(page) {
  const hw = card({
    title: 'Hardware Decoding', info: 'Uses your graphics card to decode HEVC/H.265, H.264, VP9 and AV1 so 8K at 60 fps plays smoothly. HEVC also needs the "HEVC Video Extensions" from the Microsoft Store. Files the GPU can\'t decode get a preview copy automatically.',
    toggled: settings.hwDecode !== false,
    onToggle: (v) => { save({ hwDecode: v }); strip.set('restart', 5, { text: 'Restart to apply the decoding change', action: 'Restart now', onAction: () => api.relaunch() }); },
    body: [
      h('div', { class: 'muted' }, 'Run a 13 second, 3-stage test on the open video to see if your PC keeps up.'),
      bench.btn = h('button', { class: 'btn', 'data-tour': 'bench', onclick: () => runBenchmark() }, 'Run benchmark'),
      bench.box = h('div', { class: 'bench', hidden: true },
        h('div', { class: 'inline' }, bench.stage = h('b', {}), h('div', { class: 'grow' }), bench.pct = h('span', { class: 'muted' })),
        h('div', { class: 'bar big' }, bench.bar = h('i')),
        bench.steps = h('div', { class: 'bench-steps' }),
        bench.live = h('div', { class: 'muted bench-live' }),
        h('div', { class: 'inline' }, bench.cancel = h('button', { class: 'btn', onclick: () => (bench.cancelled = true) }, 'Cancel'))),
      bench.result = h('div', { class: 'bench-result', hidden: true })]
  });

  const playback = card({
    title: 'Playback', info: 'How videos start.',
    body: [
      field('Start in', segmented([{ value: 'vr', label: 'VR view' }, { value: 'flat', label: 'Flat view' }], settings.defaultView || 'vr', (v) => save({ defaultView: v }), 'small')),
      field('Resume where I left off', toggle(settings.resumeOn !== false, (v) => save({ resumeOn: v }))),
      field('Play next video automatically', toggle(settings.autoNext !== false, (v) => save({ autoNext: v }))),
      field('Seek step', numBox({ value: settings.seekStep || 10, min: 2, max: 60, step: 1, unit: 's', width: 80, onChange: (v) => save({ seekStep: v }) })),
      field('Headset sharpness', segmented([{ value: 0.8, label: 'Saver' }, { value: 1, label: 'Normal' }, { value: 1.3, label: 'Sharp' }, { value: 1.6, label: 'Sharpest' }], settings.xrScale ?? 1,
        (v) => { save({ xrScale: v }); view.setXRScale(v); }, 'small'), 'How many pixels the headset draws. Sharp and Sharpest render above the headset\'s native resolution (crisper text and detail) but need a strong graphics card. Applies the next time you enter VR.'),
      field('Notice memory cards', toggle(settings.importWatch !== false, (v) => { save({ importWatch: v }); api.importWatch(v); }), 'When a memory card with new videos goes in, offer to import them (Library › Import).'),
      field('Smooth downscaling', toggle(settings.videoMips !== false, (v) => { save({ videoMips: v }); view.setQuality({ videoMips: v }); }), 'Stops fine detail in 6K/8K videos from shimmering when you zoom out or look at it from afar. Uses a little more graphics power.'),
      field('Fullscreen controls appear in the bottom', numBox({ value: settings.fsZone ?? 20, min: 5, max: 50, step: 5, unit: '%', width: 80, onChange: (v) => save({ fsZone: v }) }),
        'In fullscreen the control bar only shows when the mouse is this close to the bottom of the screen. Clicking or dragging to look around never brings it up.')]
  });

  const ex = { size: 0, codec: 'h264', crf: 18, ...settings.exportDefaults };
  const setEx = (p) => { Object.assign(ex, p); save({ exportDefaults: { ...ex } }); };
  const exportCard = card({
    title: 'Export Defaults', info: 'Starting values for Convert to VR180.',
    body: [
      field('Codec', segmented([{ value: 'h264', label: 'H.264' }, { value: 'h265', label: 'H.265' }], ex.codec === 'h265' ? 'h265' : 'h264', (v) => setEx({ codec: v }), 'small')),
      field('Quality (lower = better)', numBox({ value: ex.crf, min: 12, max: 30, step: 1, unit: 'CRF', width: 90, onChange: (v) => setEx({ crf: v }) })),
      field('Resolution per eye', select([{ value: '0', label: 'Keep original' }, { value: '2048', label: '2048' }, { value: '2880', label: '2880' }, { value: '3840', label: '3840' }], String(ex.size), (v) => setEx({ size: +v })))]
  });

  const vaultCard = card({
    title: 'Private Vault PIN', info: 'Turn the vault on from the Library tab. Here you can change or remove the PIN.',
    body: [
      field('Auto-lock after', numBox({ value: settings.vaultAutoLock || 10, min: 1, max: 120, step: 1, unit: 'min', width: 90, onChange: (v) => save({ vaultAutoLock: v }) })),
      h('div', { class: 'inline' },
        h('button', { class: 'btn', onclick: changePin }, 'Change PIN'),
        h('button', { class: 'btn danger', onclick: removePin }, 'Remove PIN'))]
  });

  const swatches = h('div', { class: 'swatches' });
  const drawSwatches = () => swatches.replaceChildren(
    h('div', { class: 'swatch auto' + (!settings.accent ? ' active' : ''), title: "Theme's own colour", onclick: () => { save({ accent: null }); applyAccent(null); drawSwatches(); } }),
    ...Object.entries(ACCENTS).map(([k, [, c]]) =>
    h('div', { class: 'swatch' + (settings.accent === k ? ' active' : ''), style: { background: c }, title: k, onclick: () => { save({ accent: k }); applyAccent(k); drawSwatches(); } })));
  drawSwatches();
  const look = card({
    title: 'Appearance', info: 'Colour of switches, sliders and highlights, and how much things move.',
    body: [themePicker(), field('Accent colour', swatches),
      field('Reduce animations', toggle(!!settings.reduceMotion, (v) => { save({ reduceMotion: v }); document.body.classList.toggle('reduce-motion', v); }), 'Turns off sliding and fading. Windows "reduce motion" is respected automatically too.')]
  });

  const sounds = card({
    title: 'Sounds', info: 'Little clicks and chimes for buttons, switches, finished conversions and Watch Together. Muted automatically while a video plays in fullscreen.',
    toggled: settings.sfxOn !== false,
    onToggle: (v) => { save({ sfxOn: v }); sfx.configure({ on: v }); },
    body: [
      field('Volume', numBox({ value: settings.sfxVolume ?? 40, min: 0, max: 100, step: 5, unit: '%', width: 90, onChange: (v) => { save({ sfxVolume: v }); sfx.configure({ volume: v }); sfx.play('tick'); } })),
      h('div', { class: 'inline', style: { flexWrap: 'wrap' } }, ...['click', 'on', 'whoosh', 'shutter', 'chime', 'pop', 'error'].map((n) =>
        h('button', { class: 'btn', 'data-sfx': 'none', onclick: () => sfx.play(n) }, n[0].toUpperCase() + n.slice(1))))]
  });

  const keyList = h('div', { class: 'key-edit' });
  const shortcuts = card({ title: 'Keyboard Shortcuts', info: 'Click a shortcut, then press the new key (with Ctrl/Alt/Shift if you like). Esc cancels, Backspace removes it. Keys 1–6 always switch tabs.',
    actions: [h('button', { class: 'btn small', onclick: () => { resetKeys(); renderKeys(); toast('Shortcuts back to the defaults', 'ok'); } }, 'Reset to defaults')], body: [keyList,
      h('div', { class: 'kbd-list' }, h('kbd', {}, 'Mouse drag · wheel'), h('span', {}, 'Look around · zoom'), h('kbd', {}, 'Double-click'), h('span', {}, 'Fullscreen'), h('kbd', {}, '1–6'), h('span', {}, 'Switch tabs'))] });
  function renderKeys() {
    keyList.replaceChildren(...ACTIONS.map((a) => h('div', { class: 'key-row' }, h('span', { class: 'grow' }, a.label),
      ...keysFor(a.id).map((k) => h('kbd', {}, prettyKey(k))),
      h('button', { class: 'btn small key-btn', title: 'Set a new key', onclick: (e) => capture(a, e.currentTarget) }, keysFor(a.id).length ? 'Change' : 'Set'))));
  }
  // record the next key press for an action (only one recording at a time)
  let cancelCapture = null;
  function capture(a, btn) {
    cancelCapture?.();
    btn.textContent = 'Press a key…';
    btn.classList.add('listening');
    document.body.classList.add('capturing-key');
    const done = () => { window.removeEventListener('keydown', onKey, true); cancelCapture = null; document.body.classList.remove('capturing-key'); renderKeys(); };
    const onKey = (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === 'Escape') return done();
      if (e.key === 'Backspace') { setKeys(a.id, []); done(); return toast(`"${a.label}" has no shortcut now`); }
      const combo = comboOf(e);
      if (!combo) return; // just a modifier so far
      if (/^[1-6]$/.test(combo)) { toast('1–6 are kept for switching tabs. Pick another key.', 'err'); return done(); }
      // a key can only do one thing: take it away from whatever had it
      const other = ACTIONS.find((x) => x.id !== a.id && keysFor(x.id).includes(combo));
      if (other) { setKeys(other.id, keysFor(other.id).filter((k) => k !== combo)); toast(`${prettyKey(combo)} was "${other.label}". It now does "${a.label}".`); }
      setKeys(a.id, [combo]);
      done();
    };
    window.addEventListener('keydown', onKey, true);
    cancelCapture = () => window.removeEventListener('keydown', onKey, true);
  }
  renderKeys();

  const padList = h('div', { class: 'key-edit' });
  const padHint = h('div', { class: 'muted small' }, 'Press any button on your controller to see which row it is.');
  const padOptions = [{ value: '', label: '(nothing)' }, ...ACTIONS.map((a) => ({ value: a.id, label: a.label }))];
  function renderPad() {
    padList.replaceChildren(...PAD_BUTTONS.map(([i, name]) => h('div', { class: 'key-row', 'data-btn': i }, h('span', { class: 'grow' }, name),
      select(padOptions, padAction(i) || '', (v) => setPad(i, v)))));
  }
  renderPad();
  // flash the row for a pressed button while Settings is open
  listenPad((i) => {
    if (!page.isConnected || page.offsetParent === null) return false; // Settings not showing: the button does its job
    const row = padList.querySelector(`[data-btn="${i}"]`);
    padHint.textContent = row ? `You pressed ${PAD_BUTTONS.find(([b]) => b === i)[1]}.` : `Button ${i} isn't remappable.`;
    row?.classList.remove('flash'); void row?.offsetWidth; row?.classList.add('flash');
    return true;
  });
  const controller = card({ title: 'Controller Buttons', info: 'Plug in or pair an Xbox/PlayStation controller and it works right away. Pick what each button does. Sticks: left looks around, right seeks (←→) and changes volume (↑↓); triggers zoom. In the headset, the VR controllers work too.',
    actions: [h('button', { class: 'btn small', onclick: () => { save({ padmap: {} }); renderPad(); toast('Controller buttons back to the defaults', 'ok'); } }, 'Reset')],
    body: [padHint, padList] });

  const about = h('div', { class: 'muted' });
  api.appInfo().then((i) => (about.textContent = `Version ${i.version} · Electron ${i.electron} · Chromium ${i.chrome}`));
  const upText = h('div', { class: 'muted update-text' });
  const upBar = h('div', { class: 'update-bar' }, h('i'));
  const upBtn = h('button', { class: 'btn', onclick: async () => { sfx.click?.(); upBtn.disabled = true; showUp(await api.updateCheck()); upBtn.disabled = false; } }, 'Check for updates');
  const upInstall = h('button', { class: 'btn primary', style: 'display:none', onclick: () => api.updateInstall() }, 'Restart to update');
  const UNSUPPORTED = {
    portable: 'This is the portable version, which can\'t update itself. Use the installer to get automatic updates.',
    dev: 'Updates are only checked in the installed app.',
    'not-configured': 'Automatic updates aren\'t set up in this build yet.'
  };
  function showUp(s) {
    if (!s) return;
    const t = {
      idle: 'Updates are checked automatically every 6 hours.',
      checking: 'Checking for updates…',
      latest: `You have the latest version (${s.version}).`,
      downloading: `Downloading ${s.version || 'update'}… ${s.percent || 0}%`,
      ready: `Version ${s.version} is ready. Restart to finish updating.`,
      error: `Couldn't check for updates: ${s.error}`,
      unsupported: UNSUPPORTED[s.reason] || 'Updates aren\'t available.'
    }[s.state];
    upText.textContent = t || '';
    upBar.classList.toggle('show', s.state === 'downloading');
    upBar.firstChild.style.width = (s.percent || 0) + '%';
    upBtn.style.display = s.state === 'unsupported' || s.state === 'ready' ? 'none' : '';
    upInstall.style.display = s.state === 'ready' ? '' : 'none';
  }
  api.updateStatus().then(showUp);
  api.onUpdateStatus(showUp);
  const backupBtns = h('div', { class: 'row-btns' },
    h('button', { class: 'btn', title: 'Save your settings, presets, colour looks, shortcuts, tags, ratings and watch history to one file', onclick: exportBackup }, 'Export settings…'),
    h('button', { class: 'btn', title: 'Load settings from a backup file, e.g. on a new PC', onclick: () => importBackup() }, 'Import settings…'));
  const aboutCard = card({ title: 'About', body: [about, upText, upBar, h('div', { class: 'row-btns' }, upBtn, upInstall), backupBtns, h('div', { class: 'muted' }, 'Snapshots are saved to Pictures\\VR180 Player.'),
    h('button', { class: 'btn', onclick: () => emit('start-tour') }, 'Replay the tour')] });

  page.append(h('div', { class: 'grid2' },
    h('div', { class: 'stack' }, hw, playback, exportCard, vaultCard, look, sounds),
    h('div', { class: 'stack' }, aiCard(), shortcuts, controller, aboutCard)));
}

// ---- settings backup
const BACKUP_NOTE = 'Not included, on purpose: your private vault and anything in private folders, the phone stream PIN, and this PC\'s security certificates.';
async function exportBackup(file) {
  const r = await api.backupExport(typeof file === 'string' ? file : undefined);
  if (!r) return null;
  const s = r.summary;
  toast(`Settings saved: ${s.presets} preset${s.presets === 1 ? '' : 's'}, ${s.luts} colour look${s.luts === 1 ? '' : 's'}, ${s.history} watch position${s.history === 1 ? '' : 's'}`, 'ok');
  return r;
}
async function importBackup(file) {
  let s;
  try { s = await api.backupOpen(typeof file === 'string' ? file : undefined); } catch (e) { toast(String(e.message).replace(/.*Error: /, ''), 'err'); return; }
  if (!s) return;
  const row = (k, v) => [h('span', { class: 'muted' }, k), h('b', {}, String(v))];
  const go = async (mode) => {
    await api.backupApply(mode);
    m.close();
    toast('Settings imported. Restarting…', 'ok');
    setTimeout(() => api.relaunch(), 900);
  };
  const m = modal({ title: 'Import settings', width: 460, body: [
    h('p', { class: 'muted' }, `Backup from ${new Date(s.createdAt).toLocaleString()} (version ${s.appVersion}).`),
    h('div', { class: 'kbd-list backup-sum' }, ...row('Library folders', s.folders), ...row('Picture presets', s.presets), ...row('Colour looks (LUT files)', s.luts),
      ...row('Calibrated videos', s.calibrated), ...row('Favourites, ratings, tags', s.tagged), ...row('Watch positions', s.history), ...row('Custom shortcuts / buttons', s.shortcuts), ...row('Theme', s.theme)),
    h('p', { class: 'muted small' }, BACKUP_NOTE),
    h('div', { class: 'inline' },
      h('button', { class: 'btn primary', title: 'Add the backup to what you have; the backup wins where both have a value', onclick: () => go('merge') }, 'Merge with mine'),
      h('button', { class: 'btn danger', title: 'Use only the backup (your vault and phone PIN stay)', onclick: () => go('replace') }, 'Replace mine'))
  ] });
}
window.__backup = { exportBackup, importBackup };

async function changePin() {
  if (!(await api.vaultHasPin())) return toast('No PIN yet. Turn on the vault in the Library tab.');
  const old = await pinDialog('Current PIN');
  if (old == null) return;
  if (!(await api.vaultVerify(old))) return toast('Wrong PIN', 'err');
  const pin = await pinDialog('New PIN', 'Choose a new 4–8 digit PIN');
  if (!pin) return;
  try { await api.vaultSetPin(pin, old); toast('PIN changed', 'ok'); } catch (e) { toast(String(e.message).replace(/.*Error: /, ''), 'err'); }
}
async function removePin() {
  if (!(await api.vaultHasPin())) return toast('There is no PIN set.');
  const pin = await pinDialog('Remove PIN', 'Enter your PIN. Private folders will become public.');
  if (pin == null) return;
  if (!(await api.vaultClear(pin))) return toast('Wrong PIN', 'err');
  save({ vaultOn: false, folders: settings.folders.map((f) => ({ ...f, private: false })) });
  emit('vault');
  toast('PIN removed', 'ok');
}

// ---------------------------------------------------------------- benchmark
// Three stages: decode the open video, render the VR view, then an 8K render stress
// test. Shows live progress, and notices when playback stalls (PC stuck).
const STAGES = [
  { key: 'decode', label: 'Decoding video', secs: 6 },
  { key: 'render', label: 'Rendering the VR view', secs: 4 },
  { key: 'stress', label: '8K render stress test', secs: 3 }
];
const TOTAL = STAGES.reduce((a, s) => a + s.secs, 0);
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

async function runBenchmark() {
  const item = player.current();
  if (!item) return toast('Open a video in the Player first, then run the benchmark.', 'err');
  bench.cancelled = false;
  bench.btn.disabled = true;
  bench.box.hidden = false;
  bench.box.classList.remove('stuck', 'done');
  bench.result.hidden = true;
  bench.cancel.hidden = false;
  const restore = { paused: video.paused, time: video.currentTime, mode: player.state.mode };
  const res = {};
  let done = 0;
  const setProgress = (stageIdx, frac, live) => {
    const p = (done + STAGES[stageIdx].secs * frac) / TOTAL;
    bench.bar.style.width = (p * 100).toFixed(1) + '%';
    bench.pct.textContent = Math.round(p * 100) + '%';
    bench.stage.textContent = `Stage ${stageIdx + 1} of 3 · ${STAGES[stageIdx].label}`;
    bench.steps.replaceChildren(...STAGES.map((s, i) => h('span', { class: 'bstep ' + (i < stageIdx ? 'ok' : i === stageIdx ? 'now' : '') }, (i < stageIdx ? '✓ ' : '') + s.label)));
    if (live) bench.live.textContent = live;
  };
  const stuck = (msg) => {
    bench.box.classList.add('stuck');
    bench.stage.textContent = 'Playback looks stuck';
    bench.live.textContent = msg;
    sfx.play('error');
    return 'stuck';
  };

  try {
    // ---- stage 1: decode
    if (video.paused) await video.play().catch(() => {});
    const q0 = video.getVideoPlaybackQuality();
    let lastT = video.currentTime, lastMove = performance.now(), lastFrames = q0.totalVideoFrames, fpsNow = 0, lastTick = performance.now();
    const t0 = performance.now();
    while (true) {
      await new Promise((r) => setTimeout(r, 100));
      if (bench.cancelled) throw new Error('cancelled');
      const now = performance.now();
      const q = video.getVideoPlaybackQuality();
      if (video.currentTime !== lastT) { lastT = video.currentTime; lastMove = now; }
      if (now - lastTick >= 500) { fpsNow = ((q.totalVideoFrames - lastFrames) * 1000) / (now - lastTick); lastFrames = q.totalVideoFrames; lastTick = now; }
      const frames = q.totalVideoFrames - q0.totalVideoFrames, dropped = q.droppedVideoFrames - q0.droppedVideoFrames;
      setProgress(0, Math.min(1, (now - t0) / 6000), `${frames} frames decoded · ${dropped} dropped · ${fpsNow.toFixed(0)} fps · ${((now - t0) / 1000).toFixed(1)} s`);
      if (video.ended) { video.currentTime = 0; video.play(); lastMove = now; continue; }
      if (now - lastMove > 2000) {
        return finish(stuck(`The video hasn't moved for 2 seconds. Your PC may not be able to decode this ${item.info.codec.toUpperCase()} ${item.info.width}×${item.info.height} video. Try turning hardware decoding on, or use a lower-resolution copy.`));
      }
      if (now - t0 >= 6000) { res.frames = frames; res.dropped = dropped; res.dropPct = frames ? (dropped / frames) * 100 : 0; break; }
    }
    done += STAGES[0].secs;

    // ---- stage 2: VR rendering speed
    if (player.state.mode === 'flat') player.setViewMode('vr');
    let n = 0;
    const t1 = performance.now();
    while (performance.now() - t1 < 4000) {
      await nextFrame();
      if (bench.cancelled) throw new Error('cancelled');
      n++;
      const el = performance.now() - t1;
      setProgress(1, el / 4000, `${(n * 1000 / el).toFixed(0)} fps in the VR view`);
    }
    res.renderFps = (n * 1000) / (performance.now() - t1);
    done += STAGES[1].secs;

    // ---- stage 3: render the dome at 8K (7680x3840) every frame
    const rt = new THREE.WebGLRenderTarget(7680, 3840);
    const gl = view.renderer.getContext();
    const px = new Uint8Array(4);
    let m = 0;
    const t2 = performance.now();
    try {
      while (performance.now() - t2 < 3000) {
        if (bench.cancelled) throw new Error('cancelled');
        const f0 = performance.now();
        view.renderer.setRenderTarget(rt);
        view.renderer.render(view.scene, view.camera);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the GPU to finish
        view.renderer.setRenderTarget(null);
        m++;
        const el = performance.now() - t2;
        setProgress(2, el / 3000, `${(m * 1000 / el).toFixed(0)} fps at 8K · last frame ${(performance.now() - f0).toFixed(1)} ms`);
        if (performance.now() - f0 > 2000) return finish(stuck('The GPU took over 2 seconds to draw one 8K frame. It is struggling with 8K VR.'));
        await nextFrame();
      }
    } finally { rt.dispose(); }
    res.stressFps = (m * 1000) / (performance.now() - t2);
    done += STAGES[2].secs;
    return finish('ok');
  } catch (e) {
    return finish(e.message === 'cancelled' ? 'cancelled' : 'error');
  }

  function finish(outcome) {
    video.currentTime = restore.time;
    if (restore.paused) video.pause();
    player.setViewMode(restore.mode);
    bench.btn.disabled = false;
    bench.cancel.hidden = true;
    if (outcome === 'cancelled') { bench.box.hidden = true; toast('Benchmark cancelled'); return; }
    if (outcome !== 'ok') return;
    bench.box.classList.add('done');
    bench.bar.style.width = '100%';
    bench.pct.textContent = '100%';
    bench.stage.textContent = 'Finished';
    bench.steps.replaceChildren(...STAGES.map((s) => h('span', { class: 'bstep ok' }, '✓ ' + s.label)));
    const score = res.dropPct < 1 && res.renderFps >= 55 && res.stressFps >= 30 ? 'Smooth' : res.dropPct < 5 && res.renderFps >= 30 ? 'OK' : 'Struggling';
    bench.result.hidden = false;
    bench.result.className = 'bench-result ' + score.toLowerCase();
    bench.result.replaceChildren(
      h('div', { class: 'score' }, score),
      h('div', { class: 'kbd-list' },
        h('span', { class: 'muted' }, 'Decode'), h('span', {}, `${item.info.codec.toUpperCase()} ${item.info.width}×${item.info.height}: ${res.frames} frames, ${res.dropped} dropped (${res.dropPct.toFixed(1)}%)`),
        h('span', { class: 'muted' }, 'VR view'), h('span', {}, `${res.renderFps.toFixed(0)} fps`),
        h('span', { class: 'muted' }, '8K render'), h('span', {}, `${res.stressFps.toFixed(0)} fps`)),
      h('div', { class: 'muted' }, score === 'Smooth' ? 'Your PC handles this video and 8K VR easily.' : score === 'OK' ? 'Playable. Very high resolutions may stutter now and then.' : 'Your PC is struggling. Turn hardware decoding on, or use a lower resolution copy (Convert → 2048 per eye).'));
    sfx.play(score === 'Struggling' ? 'error' : 'chime');
  }
}
