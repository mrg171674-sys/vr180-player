// VR photos. Plain JPEG/PNG/WebP files are shown like videos. Google's VR180
// and Cardboard Camera photos (*.vr.jpg) keep the LEFT eye as the normal image
// and hide the RIGHT eye inside the XMP metadata as base64 (GImage:Data), split
// across "extended XMP" APP1 segments. This pulls it out so the photo can be
// shown in 3D.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const XMP_STD = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT = 'http://ns.adobe.com/xmp/extension/\0';

// Collect the standard XMP packet and the reassembled extended XMP from a JPEG
function readXmp(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return { std: '', ext: '' };
  let std = '';
  const parts = new Map(); // guid -> [{ offset, data }]
  let i = 2;
  while (i + 4 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xda || marker === 0xd9) break; // image data starts
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i + 4, i + 2 + len);
    if (marker === 0xe1) {
      if (seg.subarray(0, XMP_STD.length).toString('latin1') === XMP_STD) std += seg.subarray(XMP_STD.length).toString('utf8');
      else if (seg.subarray(0, XMP_EXT.length).toString('latin1') === XMP_EXT) {
        const p = XMP_EXT.length;
        const guid = seg.subarray(p, p + 32).toString('latin1');
        const offset = seg.readUInt32BE(p + 36);
        if (!parts.has(guid)) parts.set(guid, []);
        parts.get(guid).push({ offset, data: seg.subarray(p + 40) });
      }
    }
    i += 2 + len;
  }
  let ext = '';
  for (const list of parts.values()) {
    list.sort((a, b) => a.offset - b.offset);
    ext += Buffer.concat(list.map((x) => x.data)).toString('utf8');
  }
  return { std, ext };
}

const attr = (xml, name) => {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(xml) || new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? m[1] : null;
};

// Returns { rightEye: path|null, coverage: 'equirect180'|'equirect360'|null, layout } for VR photos
async function inspect(file) {
  if (!/\.jpe?g$/i.test(file)) return null;
  const buf = await fs.promises.readFile(file);
  const { std, ext } = readXmp(buf);
  const xml = std + ext;
  if (!/GPano|GImage/.test(xml)) return null;
  let coverage = null;
  const full = +attr(xml, 'GPano:FullPanoWidthPixels'), cropped = +attr(xml, 'GPano:CroppedAreaImageWidthPixels');
  if (full && cropped) coverage = cropped / full > 0.75 ? 'equirect360' : 'equirect180';
  const data = attr(ext, 'GImage:Data') || attr(std, 'GImage:Data');
  let rightEye = null;
  if (data && data.length > 1000) {
    const mime = attr(xml, 'GImage:Mime') || 'image/jpeg';
    const dir = path.join(os.tmpdir(), 'vr180-photos');
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto.createHash('sha1').update(file + buf.length).digest('hex').slice(0, 16);
    rightEye = path.join(dir, `${key}_right.${mime.includes('png') ? 'png' : 'jpg'}`);
    if (!fs.existsSync(rightEye)) fs.writeFileSync(rightEye, Buffer.from(data, 'base64'));
  }
  return { rightEye, coverage, layout: rightEye ? 'sbs' : '2d' };
}

module.exports = { inspect, readXmp };
