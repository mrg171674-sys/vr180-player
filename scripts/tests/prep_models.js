// Installs the AI add-ons into a test profile from the local copies (same pinned hashes)
const APP = process.argv[2], UD = process.argv[3];
const http = require('http');
const fs = require('fs');
const M = 'C:/Users/Owner/AppData/Local/Temp/claude/vr180-models';
const SRC = { 'whisper-engine': M + '/whisper/whisper-bin-x64.zip', 'whisper-base': M + '/whisper-model/ggml-base.bin', depth: M + '/depth/model.onnx', esrgan: M + '/esrgan/realesrgan-ncnn-vulkan-20220424-windows.zip' };
const models = require(APP + '/lib/models.js');
const server = http.createServer((req, res) => { const id = req.url.slice(1); res.writeHead(200, { 'Content-Length': fs.statSync(SRC[id]).size }); fs.createReadStream(SRC[id]).pipe(res); });
server.listen(0, '127.0.0.1', async () => {
  for (const id of Object.keys(models.FILES)) models.FILES[id].url = `http://127.0.0.1:${server.address().port}/${id}`;
  models.init(UD);
  for (const p of (process.argv[4] || 'subs,depth,upscale').split(',')) await models.install(p);
  console.log(JSON.stringify(models.status()));
  server.close();
});
