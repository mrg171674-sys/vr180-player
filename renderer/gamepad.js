// Xbox / PlayStation controller support (standard gamepad mapping).
import { emit } from './core.js';
import { toast } from './ui.js';
import { player, view, video } from './player.js';
import { padAction, runAction } from './shortcuts.js';

// While Settings is showing, a press only highlights its row (the listener returns true)
let onPadPress = null;
export const listenPad = (fn) => (onPadPress = fn);

const DZ = 0.18;
const dz = (v) => (Math.abs(v) < DZ ? 0 : (v - Math.sign(v) * DZ) / (1 - DZ));
const prev = [];
let seekAcc = 0, last = performance.now();

window.addEventListener('gamepadconnected', (e) => toast(`Controller connected: ${e.gamepad.id.replace(/\(.*\)/, '').trim()}`, 'ok'));

// what each button does comes from Settings › Controller (defaults in shortcuts.js)
const press = (i) => { const id = padAction(i); if (id) runAction(id); };

function poll(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const gp of navigator.getGamepads?.() || []) {
    if (!gp) continue;
    const was = prev[gp.index] || [];
    gp.buttons.forEach((b, i) => { if (b.pressed && !was[i] && !onPadPress?.(i)) press(i); });
    prev[gp.index] = gp.buttons.map((b) => b.pressed);

    const lx = dz(gp.axes[0] || 0), ly = dz(gp.axes[1] || 0), rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
    if (lx || ly) view.look(-lx * 2.2 * dt, -ly * 1.6 * dt);
    if (rx && player.current()) {
      seekAcc += rx * 15 * dt;
      if (Math.abs(seekAcc) >= 1) { player.seekBy(Math.trunc(seekAcc)); seekAcc %= 1; }
    }
    if (ry) video.volume = Math.max(0, Math.min(1, video.volume - ry * 0.8 * dt));
    const lt = gp.buttons[6]?.value || 0, rt = gp.buttons[7]?.value || 0;
    if (lt > 0.1 || rt > 0.1) view.zoom((lt - rt) * 60 * dt);
  }
  requestAnimationFrame(poll);
}
requestAnimationFrame(poll);
