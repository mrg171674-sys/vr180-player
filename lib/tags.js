// Automatic library tags from a file's own metadata: camera, date, format,
// resolution and length. Location data is deliberately ignored.
const { spawn } = require('child_process');
const ff = require('./ffmpeg');

// "key : value" pairs from every Metadata block that ffmpeg prints for the file
function readMeta(file) {
  return new Promise((resolve) => {
    const p = spawn(ff.ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true });
    let s = '';
    p.stderr.on('data', (d) => (s += d));
    const t = setTimeout(() => p.kill(), 15000);
    p.on('close', () => {
      clearTimeout(t);
      const meta = {};
      for (const line of s.split(/\r?\n/)) {
        const m = /^\s{4,}([\w.\-©:]+?)\s*:\s(.*)$/.exec(line);
        if (m && !(m[1].toLowerCase() in meta)) meta[m[1].toLowerCase()] = m[2].trim();
      }
      resolve(meta);
    });
    p.on('error', () => resolve({}));
  });
}

const CAMERAS = [
  [/gopro|^gp\w*$|hero\d/i, 'GoPro'], [/insta360|insv/i, 'Insta360'], [/canon/i, 'Canon'], [/apple|iphone/i, 'iPhone'],
  [/samsung|galaxy/i, 'Samsung'], [/dji|osmo/i, 'DJI'], [/kandao|qoocam/i, 'Kandao'], [/vuze|humaneyes/i, 'Vuze'],
  [/lenovo|mirage/i, 'Lenovo'], [/ricoh|theta/i, 'Ricoh Theta'], [/zcam|z cam/i, 'Z CAM'], [/xiaomi|yi\b/i, 'Xiaomi'],
  [/pixel|google/i, 'Google Pixel'], [/meta|quest|oculus/i, 'Meta Quest'], [/sony/i, 'Sony'], [/nikon/i, 'Nikon'], [/panasonic|lumix/i, 'Panasonic']
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function camera(meta, name) {
  const fields = ['com.apple.quicktime.make', 'com.apple.quicktime.model', 'make', 'model', '©mak', '©mod', 'com.android.manufacturer', 'com.android.model',
    'firmware', 'handler_name', 'encoder', 'comment', 'title', 'artist'];
  const hay = fields.map((k) => meta[k] || '').join(' | ');
  for (const [re, label] of CAMERAS) if (re.test(hay)) return label;
  // GoPro and Insta360 file names are distinctive even when the metadata was stripped
  if (/^(GOPR|GH\d|GX\d|GS\d)/i.test(name)) return 'GoPro';
  if (/^(VID|IMG)_\d{8}_\d{6}_\d+_\d+/i.test(name) || /\.insv$/i.test(name)) return 'Insta360';
  const make = meta['com.apple.quicktime.make'] || meta.make;
  return make && make.length < 30 ? make.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

function shotDate(meta, mtime) {
  const raw = meta['com.apple.quicktime.creationdate'] || meta.creation_time || meta.date || meta['date-eng'];
  const d = raw ? new Date(raw) : null;
  // cameras without a clock write 1904/1970 dates; fall back to the file's date then
  if (d && !isNaN(d) && d.getFullYear() > 1995) return d;
  return mtime ? new Date(mtime) : null;
}

function resolutionTag(info) {
  const f = info.format || {};
  const eyeW = f.layout === 'sbs' ? info.width / 2 : info.width;
  const w = f.projection === 'flat' ? info.width : Math.max(eyeW * (f.layout === 'sbs' ? 2 : 1), info.width);
  if (w >= 7600) return '8K';
  if (w >= 5600) return '5.7K';
  if (w >= 3800) return '4K';
  if (w >= 2500) return '3K';
  if (w >= 1900) return 'HD';
  return null;
}

// tags for one analysed file (info = detect.analyze() result)
async function forFile(file, info, mtime) {
  const meta = info.isImage ? {} : await readMeta(file);
  const name = require('path').basename(file);
  const tags = [];
  const cam = camera(meta, name);
  if (cam) tags.push(cam);
  const d = shotDate(meta, mtime);
  if (d) { tags.push(String(d.getFullYear())); tags.push(`${MONTHS[d.getMonth()]} ${d.getFullYear()}`); }
  const f = info.format || {};
  if (info.isImage) tags.push('Photo');
  tags.push({ fisheye: 'Fisheye', equirect180: 'VR180', equirect360: '360', flat: 'Flat' }[f.projection] || 'Flat');
  if (f.layout && f.layout !== '2d') tags.push('3D');
  const res = resolutionTag(info);
  if (res) tags.push(res);
  if (!info.isImage && info.duration) {
    if (info.duration < 60) tags.push('Short');
    else if (info.duration > 20 * 60) tags.push('Long');
  }
  return { tags: [...new Set(tags)], shotAt: d ? d.getTime() : null };
}

module.exports = { forFile, readMeta, camera };
