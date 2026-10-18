// A plain-text summary of a failed conversion that can be pasted into a bug report.
// Personal folder names are replaced with ~ so it can be shared safely.
const os = require('os');
const path = require('path');
const encoders = require('./encoders');

function scrub(text) {
  const home = os.homedir();
  const user = os.userInfo().username;
  let t = String(text);
  for (const p of [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')]) t = t.split(p).join('~');
  if (user && user.length > 2) t = t.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>');
  return t;
}

function summarizeOpts(o) {
  const keep = { ...o };
  delete keep.chapters;
  if (keep.segments) keep.segments = keep.segments.map((s) => ({ input: path.basename(s.input), start: s.start, end: s.end, speed: s.speed, freeze: s.freeze }));
  if (keep.input) keep.input = path.basename(keep.input);
  if (keep.output) keep.output = path.basename(keep.output);
  if (keep.lut) keep.lut = path.basename(keep.lut);
  if (keep.level && keep.level.rolls) keep.level = { mode: keep.level.mode, samples: keep.level.rolls.length };
  if (keep.subtitles) keep.subtitles = `${keep.subtitles.length} cues`;
  return keep;
}

function build({ appVersion, job, error, probe }) {
  const enc = encoders.status() || {};
  const gpu = os.cpus()[0]?.model || 'unknown CPU';
  const lines = [
    '=== VR180 Player error report ===',
    `Time: ${new Date().toISOString()}`,
    `App: ${appVersion} · Windows ${os.release()} · ${process.arch}`,
    `CPU: ${gpu} · RAM ${Math.round(os.totalmem() / 2 ** 30)} GB`,
    `GPU encoders: H.264 ${enc.h264 || 'none'} · HEVC ${enc.hevc || 'none'}${enc.vendor ? ' · ' + enc.vendor : ''}`,
    '',
    `Job: ${job.name}`,
    `Error: ${(error.message || String(error)).split('\n').pop()}`,
    '',
    '--- Input ---',
    probe ? `${probe.codec} ${probe.width}x${probe.height} @ ${probe.fps} fps · ${probe.duration?.toFixed?.(1)} s · audio ${probe.hasAudio ? probe.audioChannels + ' ch' : 'none'}${probe.spherical ? ' · ' + probe.spherical : ''}` : '(could not read the input file)',
    '',
    '--- Export options ---',
    JSON.stringify(summarizeOpts(job.opts), null, 2)
  ];
  if (error.graph) lines.push('', '--- Filter graph ---', error.graph);
  if (error.args) lines.push('', '--- ffmpeg arguments ---', error.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '));
  if (error.stderrTail) lines.push('', '--- ffmpeg output (last 40 lines) ---', error.stderrTail);
  return scrub(lines.join('\n'));
}

module.exports = { build, scrub };
