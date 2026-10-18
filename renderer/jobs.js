// Jobs panel: background conversions, opened from the title bar.
import { api, emit, fmtTime, baseName, settings, save } from './core.js';
import { h, svg, iconBtn, toast, select, strip } from './ui.js';
import { sfx } from './sfx.js';

let jobs = [];
let whenSel = null;
let panel, list, badge, button;

export function initJobs(titlebarSlot) {
  badge = h('span', { class: 'badge-count', hidden: true });
  button = h('button', { class: 'wbtn jobs-btn', title: 'Jobs: conversions, AI subtitles and upscaling', html: svg('convert'), onclick: () => togglePanel() }, badge);
  titlebarSlot.prepend(button);

  list = h('div', { class: 'jobs-list' });
  panel = h('aside', { class: 'jobs-panel' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Jobs'), h('div', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => api.queueClear() }, 'Clear finished'),
      iconBtn('x', 'Close', () => togglePanel(false))),
    list,
    h('div', { class: 'jobs-foot' }, h('span', { class: 'muted' }, 'When everything is done'),
      whenSel = select([{ value: 'nothing', label: 'Do nothing' }, { value: 'sleep', label: 'Sleep the PC' }, { value: 'shutdown', label: 'Shut down the PC' }], settings.whenDone || 'nothing', (v) => {
        save({ whenDone: v });
        if (v !== 'nothing') toast(v === 'sleep' ? 'The PC will sleep when the jobs are done (you get a minute to cancel)' : 'The PC will shut down when the jobs are done (you get a minute to cancel)');
      })));
  document.body.append(panel);
  // a minute's warning before sleep / shut down, with a way out
  api.onWhenDone(({ action, seconds }) => {
    let left = seconds;
    whenSel?.set('nothing');
    settings.whenDone = 'nothing';
    const tick = () => strip.set('when-done', 9, { text: `All jobs are done. The PC will ${action === 'sleep' ? 'go to sleep' : 'shut down'} in ${left} s.`, actions: [{ label: 'Cancel', onClick: async () => { clearInterval(t); await api.whenDoneCancel(); strip.clear('when-done'); toast('Cancelled'); } }] });
    tick();
    const t = setInterval(() => { left--; if (left <= 0) { clearInterval(t); strip.clear('when-done'); } else tick(); }, 1000);
  });

  api.onQueue((j) => { jobs = j; render(); });
  api.onJobDone((j) => {
    sfx.play('chime');
    if (!j.test) toast(`Finished: ${j.name}`, 'ok');
    emit('job-done', j);
  });
  api.onJobFailed((j) => toast(`${{ subs: 'Subtitles failed', upscale: 'Upscaling failed' }[j.kind] || 'Conversion failed'}: ${j.name}${j.error ? ' · ' + j.error : ''}`, 'err', j.hasReport ? { label: 'Copy details', onClick: () => copyReport(j.id) } : null));
  api.queueList().then((j) => { jobs = j; render(); });
}

export function openJobs() { togglePanel(true); }
function togglePanel(force) {
  const show = force ?? !panel.classList.contains('show');
  panel.classList.toggle('show', show);
  button.classList.toggle('on', show);
}

function render() {
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
  badge.hidden = !active;
  badge.textContent = active;
  button.classList.toggle('busy', active > 0);
  if (!jobs.length) {
    list.replaceChildren(h('div', { class: 'empty-note' }, 'No conversions yet. Use Convert to VR180 in the Player, or select videos in the Library.'));
    return;
  }
  // rows are kept and updated in place; a row is rebuilt only when its status changes
  // (so animations don't replay and Cancel/Retry clicks never land on a vanished button)
  const keep = new Set(jobs.map((j) => j.id));
  for (const id of [...rows.keys()]) if (!keep.has(id)) { rows.get(id).el.remove(); rows.delete(id); }
  if (list.querySelector('.empty-note')) list.replaceChildren();
  const ordered = [...jobs].reverse().map((j) => {
    const r = rows.get(j.id);
    if (r && r.status === j.status && r.hasReport === !!j.hasReport) {
      r.el.querySelector('.job-status').textContent = label(j);
      r.el.querySelector('.bar i').style.width = Math.round((j.fraction || 0) * 100) + '%';
      r.el.querySelector('.job-stage').textContent = j.error || j.stage || '';
      const note = r.el.querySelector('.job-note');
      if (j.note && !note) r.el.append(h('div', { class: 'job-note' }, j.note)); else if (note && note.textContent !== (j.note || '')) note.textContent = j.note || '';
      return r.el;
    }
    const el = buildRow(j);
    if (r) r.el.replaceWith(el);
    rows.set(j.id, { el, status: j.status, hasReport: !!j.hasReport });
    return el;
  });
  ordered.forEach((el, i) => { if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null); });
}
const rows = new Map();
function buildRow(j) {
  {
    const actions = [];
    if (j.status === 'running' || j.status === 'queued') actions.push(h('button', { class: 'btn', onclick: () => api.queueCancel(j.id) }, 'Cancel'));
    if (j.status === 'failed' && j.hasReport) actions.push(h('button', { class: 'btn', title: 'Copy a summary of what went wrong, to paste into a bug report', onclick: () => copyReport(j.id) }, 'Copy details'));
    if (j.status === 'failed' || j.status === 'cancelled') actions.push(h('button', { class: 'btn', onclick: () => api.queueRetry(j.id) }, 'Retry'));
    if (j.status === 'done') {
      actions.push(h('button', { class: 'btn primary', onclick: () => { emit('open-file', j.output); togglePanel(false); } }, 'Play'),
        h('button', { class: 'btn', onclick: () => api.reveal(j.output) }, 'Show'));
    }
    if (j.status !== 'running') actions.push(iconBtn('x', 'Remove from list', () => api.queueRemove(j.id)));
    return h('div', { class: `job ${j.status}` },
      h('div', { class: 'inline' }, h('span', { class: 'job-name', title: j.output || j.input }, j.name), h('span', { class: 'job-status' }, label(j))),
      h('div', { class: 'bar' }, h('i', { style: { width: Math.round((j.fraction || 0) * 100) + '%' } })),
      h('div', { class: 'inline' }, h('span', { class: 'muted job-stage' }, j.error || j.stage || ''), h('div', { class: 'grow' }), ...actions),
      j.note ? h('div', { class: 'job-note' }, j.note) : null);
  }
}
const label = (j) => ({ queued: 'Waiting', running: j.eta ? `${fmtTime(j.eta)} left` : `${Math.round(j.fraction * 100)}%`, done: 'Done', failed: 'Failed', cancelled: 'Cancelled' }[j.status]);

// a pasteable summary of a failed conversion (personal folder names removed)
async function copyReport(id) {
  const text = await api.queueReport(id);
  if (!text) return toast('No details for this job.');
  api.copyText(text);
  toast('Error details copied. Paste them into your bug report.', 'ok');
}
