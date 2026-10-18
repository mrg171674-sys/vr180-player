// Edit dialog: join several clips into one and cut sections out of them,
// then export the result through the normal Convert pipeline.
import { api, fmtTime, baseName, FORMAT_NAMES } from './core.js';
import { h, svg, iconBtn, modal, toast, toggle, field, select } from './ui.js';
import { openExportDialog } from './export.js';

const parseClock = (s) => {
  const p = String(s).trim().split(':').map(Number);
  return p.some(isNaN) ? NaN : p.reduce((a, v) => a * 60 + v, 0);
};
const sameFormat = (a, b) => a.format.projection === b.format.projection && a.format.layout === b.format.layout;

// player: the player API (current item, playlist, A-B loop)
export function openEditor(player, preset = {}) {
  const first = player.current();
  if (!first) return toast('Open a video first.', 'err');
  if (first.info.isImage) return toast('Editing works on videos, not photos.', 'err');
  const clips = [{ item: first, cuts: [], speeds: [], freezes: [] }];
  const SPEEDS = [0.25, 0.5, 0.75, 1.5, 2, 4];
  const ab = player.state.ab;
  let chapterPerClip = true;

  const list = h('div', { class: 'edit-list' });
  const total = h('b');
  const warn = h('div', { class: 'edit-warn' });
  const addSel = select([], '', async (v) => {
    addSel.value = '';
    if (!v) return;
    if (v === '__file') {
      const paths = await api.openDialog();
      for (const p of paths) {
        try { const info = await api.analyze(p); clips.push({ item: { path: p, name: baseName(p), info, format: { ...info.format }, calib: {} }, cuts: [], speeds: [], freezes: [] }); }
        catch (e) { toast(`Can't add ${baseName(p)}`, 'err'); }
      }
    } else {
      const it = player.state.playlist.find((x) => x.path === v);
      if (it) clips.push({ item: it, cuts: [], speeds: [], freezes: [] });
    }
    render();
  });

  function keptRanges(c) {
    const d = c.item.info.duration;
    const cuts = c.cuts.filter((r) => r.b > r.a).sort((x, y) => x.a - y.a);
    const out = [];
    let t = 0;
    for (const r of cuts) {
      if (r.a > t + 0.05) out.push([t, Math.min(r.a, d)]);
      t = Math.max(t, r.b);
    }
    if (t < d - 0.05) out.push([t, d]);
    return out;
  }

  // kept ranges split into pieces with their own speed, plus freeze-frames at their ends
  function pieces(c) {
    const out = [];
    for (const [a, b] of keptRanges(c)) {
      const pts = new Set([a, b]);
      for (const s of c.speeds) for (const x of [s.a, s.b]) if (x > a && x < b) pts.add(x);
      for (const f of c.freezes) if (f.t > a && f.t < b) pts.add(f.t);
      const sorted = [...pts].sort((x, y) => x - y);
      for (let i = 0; i < sorted.length - 1; i++) {
        const x = sorted[i], y = sorted[i + 1];
        if (y - x < 0.05) continue;
        const mid = (x + y) / 2;
        const sp = c.speeds.find((s) => mid > s.a && mid < s.b);
        const fr = c.freezes.find((f) => Math.abs(f.t - y) < 0.01);
        out.push({ start: x, end: y, speed: sp ? sp.speed : 1, mute: sp ? sp.mute : false, freeze: fr ? fr.dur : 0 });
      }
    }
    return out;
  }
  const pieceLen = (p) => (p.end - p.start) / p.speed + p.freeze;
  const clipLen = (c) => pieces(c).reduce((s, p) => s + pieceLen(p), 0);

  function render() {
    addSel.replaceChildren(h('option', { value: '' }, '+ Add a clip…'),
      ...player.state.playlist.filter((it) => !it.info.isImage).map((it) => h('option', { value: it.path }, it.name)),
      h('option', { value: '__file' }, 'Other file…'));
    list.replaceChildren(...clips.map((c, i) => {
      const d = c.item.info.duration;
      const pct = (t) => (t / d) * 100 + '%';
      const bar = h('div', { class: 'edit-bar' },
        ...keptRanges(c).map(([a, b]) => h('i', { class: 'keep', style: { left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` } })),
        ...c.cuts.map((r) => h('i', { class: 'cut', style: { left: pct(r.a), width: `calc(${pct(Math.min(r.b, d))} - ${pct(r.a)})` }, 'data-tip': `Removed ${fmtTime(r.a)}–${fmtTime(r.b)}` })),
        ...c.speeds.map((s) => h('i', { class: 'spd', style: { left: pct(s.a), width: `calc(${pct(Math.min(s.b, d))} - ${pct(s.a)})` }, 'data-tip': `${s.speed}× speed` }, s.speed + '×')),
        ...c.freezes.map((f) => h('i', { class: 'frz', style: { left: pct(f.t) }, 'data-tip': `Freeze ${f.dur} s at ${fmtTime(f.t)}` })));
      const cutRows = c.cuts.map((r, k) => {
        const a = h('input', { type: 'text', value: fmtTime(r.a) }), b = h('input', { type: 'text', value: fmtTime(r.b) });
        const upd = () => { const x = parseClock(a.value), y = parseClock(b.value); if (!isNaN(x) && !isNaN(y) && y > x) { r.a = Math.max(0, x); r.b = Math.min(d, y); } render(); };
        a.addEventListener('change', upd); b.addEventListener('change', upd);
        return h('div', { class: 'inline cut-row' }, h('span', { html: svg('scissors') }), h('span', { class: 'muted' }, 'Remove'), a, h('span', { class: 'muted' }, 'to'), b,
          iconBtn('x', 'Keep this part after all', () => { c.cuts.splice(k, 1); render(); }));
      });
      const timeIn = (val, set) => { const el = h('input', { type: 'text', value: fmtTime(val) }); el.addEventListener('change', () => { const x = parseClock(el.value); if (!isNaN(x)) set(Math.max(0, Math.min(d, x))); render(); }); return el; };
      const speedRows = c.speeds.map((s, k) => {
        const sel = select(SPEEDS.map((v) => ({ value: String(v), label: v + '×' + (v < 1 ? ' slow motion' : ' faster') })), String(s.speed), (v) => { s.speed = +v; if (s.speed > 1) s.mute = false; render(); });
        const mute = h('label', { class: 'inline muted' }, Object.assign(h('input', { type: 'checkbox', onchange: (e) => (s.mute = e.target.checked) }), { checked: !!s.mute }), 'Mute');
        return h('div', { class: 'inline cut-row' }, h('span', { class: 'fx-ic' }, '⏩'), h('span', { class: 'muted' }, 'Speed'), timeIn(s.a, (x) => (s.a = x)), h('span', { class: 'muted' }, 'to'), timeIn(s.b, (x) => (s.b = Math.max(x, s.a + 0.2))), sel, mute,
          iconBtn('x', 'Back to normal speed', () => { c.speeds.splice(k, 1); render(); }));
      });
      const freezeRows = c.freezes.map((f, k) => h('div', { class: 'inline cut-row' }, h('span', { class: 'fx-ic' }, '⏸'), h('span', { class: 'muted' }, 'Freeze at'), timeIn(f.t, (x) => (f.t = x)),
        select([1, 2, 3, 4, 5].map((v) => ({ value: String(v), label: `for ${v} s` })), String(f.dur), (v) => { f.dur = +v; render(); }),
        iconBtn('x', 'Remove the freeze-frame', () => { c.freezes.splice(k, 1); render(); })));
      // the playhead if this clip is open, but never inside a part that's been removed
      const here = () => {
        let t = c.item === player.current() ? player.video.currentTime : d / 2;
        const k = keptRanges(c);
        if (k.length && !k.some(([a, b]) => t >= a && t < b)) t = k[0][0] + Math.min(1, (k[0][1] - k[0][0]) / 3);
        return t;
      };
      const mismatch = !sameFormat(c.item, clips[0].item);
      const row = h('div', { class: 'edit-clip' + (mismatch ? ' bad' : ''), draggable: 'true' },
        h('div', { class: 'inline' }, h('span', { class: 'drag', title: 'Drag to reorder' }, '⋮⋮'), h('b', { class: 'grow' }, `${i + 1}. ${c.item.name}`),
          h('span', { class: 'muted' }, `${fmtTime(clipLen(c))} of ${fmtTime(d)}`),
          h('button', { class: 'btn', onclick: () => {
            const useAB = i === 0 && c.item === player.current() && ab.a != null && ab.b != null;
            c.cuts.push(useAB ? { a: ab.a, b: ab.b } : { a: d * 0.4, b: d * 0.6 });
            render();
          }, html: svg('scissors') + 'Remove a section' }),
          h('button', { class: 'btn', title: 'Slow motion or fast forward for part of the clip', onclick: () => { const t = here(); c.speeds.push({ a: Math.max(0, t), b: Math.min(d, t + Math.max(1, d * 0.1)), speed: 0.5, mute: true }); render(); } }, '⏩ Speed'),
          h('button', { class: 'btn', title: 'Hold one frame still for a moment (uses the playhead if this clip is open)', onclick: () => { c.freezes.push({ t: +here().toFixed(2), dur: 2 }); render(); } }, '⏸ Freeze frame'),
          clips.length > 1 ? iconBtn('x', 'Take this clip out of the edit', () => { clips.splice(i, 1); render(); }) : null),
        bar, ...cutRows, ...speedRows, ...freezeRows,
        mismatch ? h('div', { class: 'muted' }, `Different format (${FORMAT_NAMES.projection[c.item.format.projection]} ${FORMAT_NAMES.layout[c.item.format.layout]}): only clips shot the same way can be joined.`) : null);
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); row.classList.add('dragging'); });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        const from = +e.dataTransfer.getData('text/plain');
        if (from !== i && !isNaN(from)) { const [m] = clips.splice(from, 1); clips.splice(i, 0, m); }
        render();
      });
      return row;
    }));
    const len = clips.reduce((s, c) => s + clipLen(c), 0);
    total.textContent = fmtTime(len);
    const bad = clips.filter((c) => !sameFormat(c.item, clips[0].item)).length;
    warn.textContent = bad ? `${bad} clip${bad > 1 ? 's don\'t' : ' doesn\'t'} match the first clip's format and will be left out.` : '';
  }

  const hlStatus = h('div', { class: 'muted' });
  let fades = false;
  function previewEdit() {
    const c = clips[0];
    if (c.item !== player.current()) return toast('Preview works on the video that is open in the player.');
    m.close();
    player.previewRanges(pieces(c).map((p) => [p.start, p.end, p.speed]));
  }
  // highlight reel: keep only the best moments of the first clip
  async function makeHighlights(target) {
    const c = clips[0];
    if (!target) {
      const pick = select([{ value: '30', label: '30 seconds' }, { value: '60', label: '1 minute' }, { value: '90', label: '1½ minutes' }], '60', () => {});
      const q = modal({ title: 'Highlight reel', width: 380, body: [
        h('p', { class: 'muted' }, 'Finds the liveliest parts (most movement and sound) and keeps just those, with a quick fade between them. You can adjust the result before exporting.'),
        h('div', { class: 'inline' }, h('span', {}, 'Length'), pick, h('div', { class: 'grow' }), h('button', { class: 'btn primary', onclick: () => { q.close(); makeHighlights(+pick.value); } }, 'Find highlights'))] });
      return;
    }
    hlStatus.textContent = 'Looking for the best moments…';
    const off = (p) => (hlStatus.textContent = `Looking for the best moments… ${Math.round(p * 100)}%`);
    hlListener = off;
    try {
      const r = await api.highlights(c.item.path, target);
      const d = c.item.info.duration;
      c.cuts = [];
      let t = 0;
      for (const s of r.segments) { if (s.start > t + 0.05) c.cuts.push({ a: t, b: s.start }); t = s.end; }
      if (t < d - 0.05) c.cuts.push({ a: t, b: d });
      c.speeds = []; c.freezes = [];
      fades = true;
      hlStatus.textContent = `Kept ${r.segments.length} moment${r.segments.length > 1 ? 's' : ''} (${fmtTime(r.segments.reduce((x, s) => x + s.end - s.start, 0))}). Press Preview to watch it.`;
      render();
    } catch (e) {
      hlStatus.textContent = 'Could not analyse this video: ' + String(e.message).replace(/.*Error: /, '').slice(0, 120);
    } finally { hlListener = null; }
  }

  const m = modal({
    title: 'Edit: cut & join', width: 820, body: [
      h('p', { class: 'muted' }, 'Remove sections you don\'t want, add more clips and drag them into order. The result is exported as one VR180 video, with the same options as Convert.'),
      list,
      h('div', { class: 'inline' }, addSel,
        h('button', { class: 'btn', title: 'Pick the liveliest moments of the first clip automatically (motion and loudness)', onclick: () => makeHighlights() }, '✨ Highlight reel'),
        h('button', { class: 'btn', title: 'Play the first clip in the player, skipping removed parts', onclick: previewEdit }, svg('play') + 'Preview'),
        h('div', { class: 'grow' }), h('span', { class: 'muted' }, 'Total length'), total),
      hlStatus,
      warn,
      field('Add a chapter at the start of each clip', toggle(chapterPerClip, (v) => (chapterPerClip = v))),
      h('button', { class: 'btn primary wide', onclick: next }, 'Next: export options…')
    ]
  });
  render();
  if (preset.highlight) makeHighlights();

  function next() {
    const usable = clips.filter((c) => sameFormat(c.item, clips[0].item));
    const segments = [];
    const chapters = [];
    let offset = 0;
    for (const c of usable) {
      if (!pieces(c).length) continue;
      if (chapterPerClip) chapters.push({ t: offset, name: c.item.name.replace(/\.[^.]+$/, '') });
      for (const p of pieces(c)) {
        segments.push({ input: c.item.path, start: +p.start.toFixed(3), end: +p.end.toFixed(3), ...(p.speed !== 1 ? { speed: p.speed } : {}), ...(p.mute ? { mute: true } : {}), ...(p.freeze ? { freeze: p.freeze } : {}), ...(fades ? { fade: true } : {}) });
        offset += pieceLen(p);
      }
    }
    if (!segments.length) return toast('Nothing left to export. Every part has been removed.', 'err');
    m.close();
    openExportDialog([{ ...usable[0].item }], { segments, chapters });
  }
}

// progress from the highlight analysis (one listener for the app's lifetime)
let hlListener = null;
api.onHighlightsProgress((p) => hlListener?.(p));
