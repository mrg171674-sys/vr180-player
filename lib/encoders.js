// Picks the video encoder for exports and phone streaming. GPU encoders
// (NVIDIA NVENC, AMD AMF, Intel Quick Sync) are tested once with a tiny frame,
// because ffmpeg lists them even when the PC has no matching graphics card.
const { spawn } = require('child_process');

let ffmpegPath = null;
let found = null;      // { h264: 'h264_nvenc' | null, hevc: 'hevc_nvenc' | null, vendor }
let probing = null;

const CANDIDATES = [
  { vendor: 'NVIDIA', h264: 'h264_nvenc', hevc: 'hevc_nvenc' },
  { vendor: 'AMD', h264: 'h264_amf', hevc: 'hevc_amf' },
  { vendor: 'Intel', h264: 'h264_qsv', hevc: 'hevc_qsv' }
];

function works(enc) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:d=0.2', '-frames:v', '3', '-c:v', enc, '-f', 'null', '-'], { windowsHide: true });
    const t = setTimeout(() => { p.kill(); resolve(false); }, 8000);
    p.on('close', (c) => { clearTimeout(t); resolve(c === 0); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function init(ffPath) { ffmpegPath = ffPath; }

function detect() {
  if (found) return Promise.resolve(found);
  if (probing) return probing;
  probing = (async () => {
    const out = { h264: null, hevc: null, vendor: null };
    for (const c of CANDIDATES) {
      const [a, b] = await Promise.all([works(c.h264), works(c.hevc)]);
      if (a || b) { out.h264 = a ? c.h264 : null; out.hevc = b ? c.hevc : null; out.vendor = c.vendor; break; }
    }
    found = out;
    return out;
  })();
  return probing;
}

// Builds the ffmpeg arguments for one encode.
// codec 'h264' | 'h265'; mode 'auto' | 'gpu' | 'cpu'; width = output frame width
async function videoArgs({ codec = 'h264', crf = 18, mode = 'auto', width = 0, maxrate = 0, tenbit = false, preset }) {
  const gpu = mode === 'cpu' ? null : await detect();
  let hevc = codec === 'h265';
  let enc = null, note = null;
  if (gpu) {
    // GPU H.264 encoders stop at 4096 px wide; switch to HEVC on the GPU if we can
    if (!hevc && width > 4096) {
      if (gpu.hevc) { hevc = true; note = `H.264 on the GPU is limited to 4096 px wide, so this ${width} px video uses HEVC on the GPU instead.`; }
      else note = 'H.264 on the GPU is limited to 4096 px wide, so this one is encoded on the CPU.';
    }
    if (!(width > 4096 && !hevc)) enc = hevc ? gpu.hevc : gpu.h264;
  }
  if (mode === 'gpu' && !enc && !note) note = 'No working GPU encoder was found, so the CPU is used.';
  const args = [];
  const vbv = maxrate ? ['-maxrate', `${maxrate}M`, '-bufsize', `${maxrate * 2}M`] : [];
  if (!enc) {
    if (hevc) args.push('-c:v', 'libx265', '-crf', String(crf), '-preset', preset || 'medium', '-tag:v', 'hvc1', ...vbv);
    else args.push('-c:v', 'libx264', '-crf', String(crf), '-preset', preset || 'medium', ...vbv);
    if (tenbit && hevc) args.push('-pix_fmt', 'yuv420p10le', '-profile:v', 'main10');
    else args.push('-pix_fmt', 'yuv420p');
  } else if (enc.endsWith('nvenc')) {
    args.push('-c:v', enc, '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0', ...vbv);
    if (tenbit && hevc) args.push('-profile:v', 'main10', '-pix_fmt', 'p010le'); else args.push('-pix_fmt', 'yuv420p');
  } else if (enc.endsWith('amf')) {
    args.push('-c:v', enc, '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2), ...vbv);
    if (tenbit && hevc) args.push('-pix_fmt', 'p010le'); else args.push('-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', enc, '-global_quality', String(crf), ...vbv);
    if (tenbit && hevc) args.push('-pix_fmt', 'p010le'); else args.push('-pix_fmt', 'nv12');
  }
  if (hevc && enc) args.push('-tag:v', 'hvc1');
  return { args, encoder: enc || (hevc ? 'libx265' : 'libx264'), gpu: !!enc, hevc, note };
}

const status = () => found;
module.exports = { init, detect, videoArgs, status };
