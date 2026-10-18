// Bridge for the hidden 3D helper window (renderer/depth-worker.html)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('depthBridge', {
  onInit: (cb) => ipcRenderer.on('depth-init', (_e, a) => cb(a)),
  onFrame: (cb) => ipcRenderer.on('depth-frame', (_e, f) => cb(f)),
  ready: (info) => ipcRenderer.send('depth-ready', info),
  result: (seq, data, w, h) => ipcRenderer.send('depth-result', seq, data, w, h),
  fail: (msg) => ipcRenderer.send('depth-fail', msg)
});
