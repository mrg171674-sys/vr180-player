// Builds every icon the app needs from build/icon.png (1024x1024).
// Run with Electron so nativeImage can resize:  npx electron scripts/make-icons.js
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png'));
const png = (size) => src.resize({ width: size, height: size, quality: 'best' }).toPNG();

// .ico with PNG-compressed entries (supported since Windows Vista)
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt16LE(1, e + 4);   // colour planes
    header.writeUInt16LE(32, e + 6);  // bits per pixel
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

app.whenReady().then(() => {
  if (src.isEmpty()) { console.error('build/icon.png is missing'); app.exit(1); return; }
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico([16, 20, 24, 32, 40, 48, 64, 128, 256]));
  fs.writeFileSync(path.join(ROOT, 'renderer', 'icon.png'), png(256));   // window, taskbar, title bar
  fs.writeFileSync(path.join(ROOT, 'phone', 'icon.png'), png(180));      // phone favicon / home screen
  console.log('icons written');
  app.exit(0);
});
