// Hidden helper window for "Make 3D video": the main process streams small frames in,
// this page runs the depth model on the graphics card and streams depth maps back.
import { toInput, postDepth } from './depth-core.js';

const bridge = window.depthBridge;
let ort = null, session = null, input = null, mem = {};

bridge.onInit(async ({ modelUrl }) => {
  try {
    ort = await import('../node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs');
    ort.env.wasm.wasmPaths = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url).href;
    ort.env.wasm.numThreads = 1;
    ort.env.logLevel = 'error';
    const bytes = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());
    const gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null)));
    session = await ort.InferenceSession.create(bytes, { executionProviders: gpu ? ['webgpu'] : ['wasm'] });
    bridge.ready({ gpu });
  } catch (e) {
    bridge.fail(String(e?.message || e));
  }
});

// Frames arrive in order (a few ahead, so sending overlaps computing); the model takes
// one at a time, so they queue up here. Each answer carries its sequence number.
let chain = Promise.resolve();
bridge.onFrame((f) => { chain = chain.then(() => run(f)); });
async function run({ seq, w, h, data, still }) {
  try {
    const n = w * h;
    input = toInput(data, n, 3, input);
    const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, h, w]) });
    const o = res[session.outputNames[0]];
    const [oh, ow] = o.dims.slice(-2);
    const cur = postDepth(o.data, ow, oh, !!still, mem);
    o.dispose?.();
    const out = new Uint8Array(ow * oh);
    for (let i = 0; i < out.length; i++) out[i] = cur[i] * 255;
    bridge.result(seq, out, ow, oh);
  } catch (e) {
    bridge.fail(String(e?.message || e));
  }
}
