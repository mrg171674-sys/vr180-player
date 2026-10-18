// Colour looks: .cube LUT files, built-in looks generated from simple maths,
// and saved Picture presets ("Sunny", "Indoor", …).
import { api, settings, save, baseName } from './core.js';

const clamp = (v) => Math.min(1, Math.max(0, v));
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const sat = ([r, g, b], s) => { const l = luma(r, g, b); return [l + (r - l) * s, l + (g - l) * s, l + (b - l) * s]; };
const curve = (x, k) => { const s = 1 / (1 + Math.exp(-k * (x - 0.5))); const a = 1 / (1 + Math.exp(k / 2)); return (s - a) / (1 - 2 * a); };

// Built-in looks: f(r, g, b) -> [r, g, b], all in 0..1 gamma space
export const BUILTIN_LOOKS = {
  log: { name: 'Flat / Log → Natural', fn: (r, g, b) => sat([curve(r, 7), curve(g, 7), curve(b, 7)], 1.45) },
  warm: { name: 'Warm', fn: (r, g, b) => [r * 1.06 + 0.02, g * 1.01, b * 0.9] },
  cool: { name: 'Cool', fn: (r, g, b) => [r * 0.92, g * 0.99, b * 1.07 + 0.02] },
  teal: { name: 'Teal & Orange', fn: (r, g, b) => { const l = luma(r, g, b); const w = curve(l, 4); return sat([r + (w - 0.5) * 0.12, g + (w - 0.5) * 0.02, b - (w - 0.5) * 0.16], 1.1); } },
  film: { name: 'Faded film', fn: (r, g, b) => sat([0.06 + r * 0.88 * 1.03, 0.05 + g * 0.88, 0.07 + b * 0.84], 0.85) },
  vivid: { name: 'Vivid', fn: (r, g, b) => sat([curve(r, 5.5), curve(g, 5.5), curve(b, 5.5)], 1.35) },
  bw: { name: 'Black & white', fn: (r, g, b) => { const l = curve(luma(r, g, b), 5); return [l, l, l]; } }
};

export const BUILTIN_PRESETS = [
  { name: 'Sunny', brightness: -3, contrast: 110, saturation: 115, lut: 'builtin:warm', lutMix: 0.3 },
  { name: 'Indoor', brightness: 6, contrast: 104, saturation: 105, lut: 'builtin:cool', lutMix: 0.35 },
  { name: 'Night', brightness: 14, contrast: 94, saturation: 88, lut: null, lutMix: 1 },
  { name: 'Vivid', brightness: 0, contrast: 100, saturation: 100, lut: 'builtin:vivid', lutMix: 1 },
  { name: 'Film', brightness: 0, contrast: 100, saturation: 100, lut: 'builtin:film', lutMix: 0.85 },
  { name: 'B&W', brightness: 0, contrast: 105, saturation: 100, lut: 'builtin:bw', lutMix: 1 }
];

function generate(fn, size = 33) {
  const data = new Uint8Array(size * size * size * 4);
  const lines = [];
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const out = fn(r / (size - 1), g / (size - 1), b / (size - 1)).map(clamp);
    data[i++] = Math.round(out[0] * 255); data[i++] = Math.round(out[1] * 255); data[i++] = Math.round(out[2] * 255); data[i++] = 255;
    lines.push(out.map((v) => v.toFixed(5)).join(' '));
  }
  return { size, data, text: `LUT_3D_SIZE ${size}\n${lines.join('\n')}\n` };
}

// .cube text -> { size, data } (red changes fastest, then green, then blue)
export function parseCube(text) {
  let size = 0, min = [0, 0, 0], max = [1, 1, 1];
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^LUT_1D_SIZE/i.test(line)) throw new Error('1D LUTs are not supported, only 3D .cube files');
    if (/^LUT_3D_SIZE/i.test(line)) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (/^DOMAIN_MIN/i.test(line)) { min = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^DOMAIN_MAX/i.test(line)) { max = line.split(/\s+/).slice(1).map(Number); continue; }
    if (/^[A-Z_]/i.test(line)) continue; // TITLE etc.
    const p = line.split(/\s+/).map(Number);
    if (p.length >= 3 && p.every((v) => !isNaN(v))) vals.push(p);
  }
  if (!size || size > 129 || vals.length !== size ** 3) throw new Error(`This .cube file doesn't look valid (size ${size}, ${vals.length} entries)`);
  const data = new Uint8Array(size ** 3 * 4);
  vals.forEach((v, i) => {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(clamp((v[c] - min[c]) / ((max[c] - min[c]) || 1)) * 255);
    data[i * 4 + 3] = 255;
  });
  return { size, data };
}

const cache = new Map();
// lut id: 'builtin:warm' or a file path; returns { size, data } or null
export async function loadLut(id) {
  if (!id) return null;
  if (cache.has(id)) return cache.get(id);
  let lut;
  if (id.startsWith('builtin:')) {
    const b = BUILTIN_LOOKS[id.slice(8)];
    if (!b) return null;
    lut = generate(b.fn);
  } else {
    lut = parseCube(await api.readText(id));
  }
  cache.set(id, lut);
  return lut;
}

// A real file path for exports (built-in looks are written to the app's data folder)
export async function lutFileFor(id) {
  if (!id) return null;
  if (!id.startsWith('builtin:')) return id;
  const lut = await loadLut(id);
  return api.lutSave('builtin_' + id.slice(8), lut.text);
}

export function lutName(id) {
  if (!id) return 'None';
  if (id.startsWith('builtin:')) return BUILTIN_LOOKS[id.slice(8)]?.name || id;
  return baseName(id).replace(/\.cube$/i, '');
}

// Apply the look stored in a calibration to the VR view
let token = 0;
export async function applyLook(view, calib) {
  const t = ++token;
  const on = calib.pictureOn !== false && calib.lut;
  try {
    const lut = on ? await loadLut(calib.lut) : null;
    if (t !== token) return;
    view.setLut(lut, calib.lutMix ?? 1);
  } catch (e) {
    view.setLut(null);
    throw e;
  }
}

export const userPresets = () => settings.picturePresets || [];
export function savePreset(name, calib) {
  const p = { name, brightness: calib.brightness, contrast: calib.contrast, saturation: calib.saturation, lut: calib.lut || null, lutMix: calib.lutMix ?? 1 };
  save({ picturePresets: [...userPresets().filter((x) => x.name !== name), p] });
  return p;
}
export function deletePreset(name) { save({ picturePresets: userPresets().filter((x) => x.name !== name) }); }
export const allPresets = () => [...BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true })), ...userPresets()];
