// 2D → 3D. A small depth model (Depth Anything V2 Small, an optional add-on) runs on the
// graphics card through WebGPU and estimates how far away everything in the picture is,
// many times a second. The VR view shifts each eye by that depth, so flat videos and
// photos get real depth in the headset (and in the red/cyan and L|R previews).
import * as THREE from '../node_modules/three/build/three.module.js';
import { api, settings, save, mediaUrl } from './core.js';
import { IN_W, inputHeight, toInput, postDepth } from './depth-core.js';

let ort = null, session = null, loading = null;
let view = null, getSource = null, timer = null, onError = null;
const st = { active: false, busy: false, tex: null, mem: {}, ms: 0, runs: 0, doneKey: '', gpu: null, input: null };
const canvas = document.createElement('canvas');
const g = canvas.getContext('2d', { willReadFrequently: true });

export const depthCfg = () => ({ on: false, strength: 50, pop: 35, ...settings.depth3d });
export const depthStats = () => (st.active ? { fps: st.ms ? Math.min(1000 / st.ms, 30) : 0, ms: st.ms, gpu: st.gpu, runs: st.runs } : null);

// Loads onnxruntime and the model once (about 3 s), on the graphics card when WebGPU works
export async function loadDepthModel() {
  if (session) return { session, ort, gpu: st.gpu };
  if (!loading) loading = (async () => {
    const paths = await api.aiPaths();
    if (!paths.depthModel) throw Object.assign(new Error('The 2D → 3D add-on is not installed.'), { notInstalled: true });
    ort = await import('../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs');
    ort.env.wasm.wasmPaths = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url).href;
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    const bytes = new Uint8Array(await (await fetch(mediaUrl(paths.depthModel))).arrayBuffer());
    st.gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null)));
    session = await ort.InferenceSession.create(bytes, { executionProviders: st.gpu ? ['webgpu'] : ['wasm'] });
    return { session, ort, gpu: st.gpu };
  })();
  try { return await loading; } catch (e) { loading = null; throw e; }
}

function publish(d, w, h, still) {
  const cur = postDepth(d, w, h, still, st.mem);
  if (!st.tex || st.tex.image.width !== w || st.tex.image.height !== h) {
    st.tex?.dispose();
    st.tex = new THREE.DataTexture(new Uint8Array(w * h), w, h, THREE.RedFormat, THREE.UnsignedByteType);
    st.tex.minFilter = st.tex.magFilter = THREE.LinearFilter;
    st.tex.unpackAlignment = 1;
  }
  // rows flipped to match the video texture
  const out = st.tex.image.data;
  for (let y = 0; y < h; y++) {
    const src = y * w, dst = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) out[dst + x] = cur[src + x] * 255;
  }
  st.tex.needsUpdate = true;
  apply();
}

function apply() {
  const c = depthCfg();
  if (st.active && st.tex) view.setDepth(st.tex, c.strength / 100, 1 - c.pop / 100);
  else view.setDepth(null, 0);
}

async function step() {
  if (!st.active || st.busy) return;
  const src = getSource();
  if (!src) return;
  if (src.still && src.key === st.doneKey) return;
  st.busy = true;
  try {
    const { session: s } = await loadDepthModel();
    if (!st.active) return;
    const H = inputHeight(src.w, src.h);
    if (canvas.width !== IN_W || canvas.height !== H) { canvas.width = IN_W; canvas.height = H; }
    g.drawImage(src.el, 0, 0, IN_W, H);
    const n = IN_W * H;
    st.input = toInput(g.getImageData(0, 0, IN_W, H).data, n, 4, st.input);
    const t0 = performance.now();
    const res = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', st.input, [1, 3, H, IN_W]) });
    const ms = performance.now() - t0;
    st.ms = st.runs ? st.ms * 0.8 + ms * 0.2 : ms;
    st.runs++;
    const o = res[s.outputNames[0]];
    const [oh, ow] = o.dims.slice(-2);
    if (st.active) publish(o.data, ow, oh, src.still);
    o.dispose?.();
    st.doneKey = src.key;
  } catch (e) {
    stop();
    onError?.(e);
  } finally {
    st.busy = false;
  }
}

function start() {
  if (st.active) return;
  st.active = true;
  st.mem = {};
  st.doneKey = '';
  clearInterval(timer);
  timer = setInterval(step, 30);
  step();
}
function stop() {
  st.active = false;
  clearInterval(timer);
  timer = null;
  st.mem = {};
  if (view) apply();
}

// The player tells us which picture is showing; depth runs only for flat (mono) sources
export function initDepth(v, sourceFn, errorFn) {
  view = v;
  getSource = sourceFn;
  onError = errorFn;
}
export function updateDepth(eligible) {
  const c = depthCfg();
  if (eligible && c.on) { st.doneKey = ''; start(); apply(); } else stop();
}
export function setDepthCfg(patch) {
  save({ depth3d: { ...depthCfg(), ...patch } });
  apply();
}
export const depthActive = () => st.active;
export const depthReady = () => !!session;
