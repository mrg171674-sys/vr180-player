// In-headset control panel: a floating screen with a seek bar, buttons and "up next",
// aimed at with the controllers' laser pointers (the trigger clicks). B or Y shows and
// hides it. Used by the PC player and by the phone page in a standalone headset.
import * as THREE from '../node_modules/three/build/three.module.js';

const W = 1024, H = 420;
const ACCENT = '#3c9a62';
const fmt = (s) => { s = Math.max(0, s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

// model: { title(), time() -> [t, duration], buttons() -> [{ id, label, run, on? }], seek(fraction), chips?() -> [{ label, run }] }
export class VRPanel {
  constructor(view, model) {
    this.view = view;
    this.model = model;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.1, (1.1 * H) / W),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
    view.scene.add(this.mesh);
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(0.007, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }));
    this.dot.renderOrder = 22;
    this.dot.visible = false;
    view.scene.add(this.dot);
    this.lasers = (view.controllers || []).map((c) => {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x9fe3b7, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }));
      l.renderOrder = 21;
      l.visible = false;
      c.add(l);
      return l;
    });
    this.ray = new THREE.Raycaster();
    this.hits = new Map();
    this.hover = null;
    this.prevB = {};
    this.rects = [];
    view.xrPanel = this;
  }

  get visible() { return this.mesh.visible; }

  show(on) {
    if (on === this.mesh.visible) return;
    this.mesh.visible = on;
    for (const l of this.lasers) l.visible = on;
    this.dot.visible = false;
    clearInterval(this.timer);
    if (on) {
      // in front of you, a little below eye level, facing you
      const cam = this.view.renderer.xr.getCamera();
      const yaw = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ').y;
      const pos = new THREE.Vector3(-Math.sin(yaw) * 1.25, -0.32, -Math.cos(yaw) * 1.25).add(cam.position);
      this.mesh.position.copy(pos);
      this.mesh.lookAt(cam.position.x, pos.y + 0.12, cam.position.z);
      this.redraw();
      this.timer = setInterval(() => this.redraw(), 250);
    }
    this.view.invalidate?.();
  }

  // the panel's own layout; the same rectangles are used for clicks
  layout() {
    const rects = [];
    const btns = this.model.buttons();
    const gap = 12, bw = (W - 72 - gap * (btns.length - 1)) / btns.length;
    btns.forEach((b, i) => rects.push({ kind: 'btn', b, x: 36 + i * (bw + gap), y: 150, w: bw, h: 92 }));
    rects.push({ kind: 'seek', x: 36, y: 92, w: W - 72, h: 34 });
    const chips = this.model.chips?.() || [];
    let cx = 170;
    for (const c of chips.slice(0, 4)) {
      const w = Math.min(260, 40 + c.label.length * 15);
      if (cx + w > W - 36) break;
      rects.push({ kind: 'chip', c, x: cx, y: 272, w, h: 62 });
      cx += w + 12;
    }
    return rects;
  }

  redraw() {
    const g = this.ctx, m = this.model;
    this.rects = this.layout();
    const hit = this.hover && this.rects.find((r) => this.hover.x >= r.x && this.hover.x <= r.x + r.w && this.hover.y >= r.y && this.hover.y <= r.y + r.h);
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(16,16,16,0.92)';
    g.strokeStyle = 'rgba(255,255,255,0.14)';
    g.lineWidth = 2;
    g.beginPath(); g.roundRect(4, 4, W - 8, H - 8, 34); g.fill(); g.stroke();
    // title and time
    const [t, d] = m.time();
    g.font = '600 34px "Segoe UI", system-ui, sans-serif';
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    const timeText = d ? `${fmt(t)} / ${fmt(d)}` : '';
    g.textAlign = 'right';
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillText(timeText, W - 40, 52);
    const tw = g.measureText(timeText).width;
    g.textAlign = 'left';
    g.fillStyle = '#fff';
    let title = m.title() || '';
    while (title.length > 3 && g.measureText(title).width > W - 120 - tw) title = title.slice(0, -2);
    if (title !== (m.title() || '')) title = title.replace(/.$/, '…');
    g.fillText(title, 40, 52);
    for (const r of this.rects) {
      const over = r === hit;
      if (r.kind === 'seek') {
        const f = d ? Math.min(1, t / d) : 0;
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.beginPath(); g.roundRect(r.x, r.y + 11, r.w, 12, 6); g.fill();
        g.fillStyle = ACCENT;
        g.beginPath(); g.roundRect(r.x, r.y + 11, Math.max(12, r.w * f), 12, 6); g.fill();
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(r.x + r.w * f, r.y + 17, over ? 15 : 11, 0, Math.PI * 2); g.fill();
        if (over && d) {
          const ht = ((this.hover.x - r.x) / r.w) * d;
          g.font = '600 24px "Segoe UI", system-ui, sans-serif';
          g.textAlign = 'center';
          g.fillText(fmt(ht), Math.min(W - 70, Math.max(70, this.hover.x)), r.y - 8);
        }
      } else if (r.kind === 'btn') {
        g.fillStyle = r.b.on ? ACCENT : over ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.1)';
        g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, 22); g.fill();
        g.fillStyle = '#fff';
        g.textAlign = 'center';
        g.font = `${r.b.label.length > 2 ? '600 30px' : '42px'} "Segoe UI Symbol", "Segoe UI", system-ui, sans-serif`;
        g.fillText(r.b.label, r.x + r.w / 2, r.y + r.h / 2 + 2);
      } else if (r.kind === 'chip') {
        g.fillStyle = over ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.1)';
        g.beginPath(); g.roundRect(r.x, r.y, r.w, r.h, 31); g.fill();
        g.fillStyle = '#fff';
        g.textAlign = 'center';
        g.font = '500 24px "Segoe UI", system-ui, sans-serif';
        let label = r.c.label;
        while (label.length > 3 && g.measureText(label).width > r.w - 30) label = label.slice(0, -2);
        if (label !== r.c.label) label = label.replace(/.$/, '…');
        g.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 1);
      }
    }
    if (this.rects.some((r) => r.kind === 'chip')) {
      g.textAlign = 'left';
      g.font = '600 24px "Segoe UI", system-ui, sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillText('Up next', 40, 303);
    }
    g.textAlign = 'center';
    g.font = '22px "Segoe UI", system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillText('Point and pull the trigger  ·  B / Y hides this panel  ·  A / X recenters', W / 2, 380);
    this.tex.needsUpdate = true;
    this.view.invalidate?.();
  }

  // called every headset frame
  update(dt, session) {
    for (const src of session.inputSources) {
      const b = !!src.gamepad?.buttons[5]?.pressed;
      if (b && !this.prevB[src.handedness]) this.show(!this.visible);
      this.prevB[src.handedness] = b;
    }
    if (!this.visible) return;
    let best = null;
    const origin = new THREE.Vector3(), dir = new THREE.Vector3();
    (this.view.controllers || []).forEach((c, i) => {
      origin.setFromMatrixPosition(c.matrixWorld);
      dir.set(0, 0, -1).transformDirection(c.matrixWorld);
      this.ray.set(origin, dir);
      const hit = this.ray.intersectObject(this.mesh)[0];
      if (this.lasers[i]) this.lasers[i].scale.z = hit ? hit.distance : 2.5;
      if (hit) { this.hits.set(c, hit.uv.clone()); if (!best) best = hit; } else this.hits.delete(c);
    });
    if (best) {
      this.dot.visible = true;
      this.dot.position.copy(best.point);
      this.dot.quaternion.copy(this.mesh.quaternion);
    } else this.dot.visible = false;
    const hover = best ? { x: best.uv.x * W, y: (1 - best.uv.y) * H } : null;
    // redraw only when the pointer moves onto something else (or along the seek bar)
    const region = (p) => {
      if (!p) return 'none';
      const i = this.rects.findIndex((r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
      return i < 0 ? 'panel' : this.rects[i].kind === 'seek' ? 'seek' + Math.round(p.x / 8) : 'r' + i;
    };
    const changed = region(hover) !== region(this.hover);
    this.hover = hover;
    if (changed) this.redraw();
  }

  // a trigger pull: true when it landed on the panel (so it doesn't also play/pause)
  select(controller) {
    if (!this.visible) return false;
    const uv = this.hits.get(controller);
    if (!uv) return false;
    this.click(uv.x * W, (1 - uv.y) * H);
    return true;
  }
  click(x, y) {
    const r = this.rects.find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
    if (!r) return;
    if (r.kind === 'btn') r.b.run();
    else if (r.kind === 'seek') this.model.seek(Math.min(1, Math.max(0, (x - r.x) / r.w)));
    else if (r.kind === 'chip') r.c.run();
    this.redraw();
  }
}
