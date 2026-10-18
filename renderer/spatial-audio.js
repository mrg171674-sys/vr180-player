// Spatial audio for first-order ambisonic (AmbiX: ACN order W Y Z X, SN3D) videos.
// The sound field is rotated against where you look, decoded to 6 virtual
// speakers around your head and rendered with HRTF panning, so sounds stay put
// in the scene when you turn.
const SPEAKERS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]; // ambisonic X front, Y left, Z up

export class SpatialAudio {
  constructor(ctx, input, output) {
    this.ctx = ctx;
    this.splitter = ctx.createChannelSplitter(4);
    input.connect(this.splitter);
    // 3x3 rotation of the directional (X, Y, Z) components; W passes straight through
    this.rot = [0, 1, 2].map(() => [0, 1, 2].map(() => ctx.createGain()));
    this.sum = [0, 1, 2].map(() => ctx.createGain());   // rotated X', Y', Z'
    const ACN = { W: 0, Y: 1, Z: 2, X: 3 };
    const inIdx = [ACN.X, ACN.Y, ACN.Z];
    this.rot.forEach((row, o) => row.forEach((g, i) => { this.splitter.connect(g, inIdx[i]); g.connect(this.sum[o]); }));
    this.w = ctx.createGain();
    this.splitter.connect(this.w, ACN.W);

    // Decode: each speaker hears 0.5 * (W + d · v), placed around the listener with HRTF
    this.speakers = SPEAKERS.map(([dx, dy, dz]) => {
      const mix = ctx.createGain();
      const p = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'linear', refDistance: 1, maxDistance: 10000, rolloffFactor: 0,
        positionX: -dy, positionY: dz, positionZ: -dx }); // Web Audio: +X right, +Y up, -Z ahead
      const wg = ctx.createGain(); wg.gain.value = 0.5;
      this.w.connect(wg).connect(mix);
      [dx, dy, dz].forEach((d, axis) => {
        if (!d) return;
        const g = ctx.createGain(); g.gain.value = 0.5 * d;
        this.sum[axis].connect(g).connect(mix);
      });
      mix.connect(p).connect(output);
      return p;
    });
    this.matrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    this.setOrientation(0, 0);
  }

  // yaw: positive = looking left; pitch: positive = looking up (radians)
  setOrientation(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // world -> head: undo the yaw (about Z), then the pitch (about Y)
    const Y = [[cy, sy, 0], [-sy, cy, 0], [0, 0, 1]];
    const P = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]];
    const M = P.map((r) => [0, 1, 2].map((j) => r[0] * Y[0][j] + r[1] * Y[1][j] + r[2] * Y[2][j]));
    this.matrix = M;
    const t = this.ctx.currentTime;
    M.forEach((row, o) => row.forEach((v, i) => this.rot[o][i].gain.setTargetAtTime(v, t, 0.02)));
  }

  // full 3x3 rotation (picture -> head) in ambisonic axes
  setMatrix(M) {
    this.matrix = M;
    const t = this.ctx.currentTime;
    M.forEach((row, o) => row.forEach((v, i) => this.rot[o][i].gain.setTargetAtTime(v, t, 0.02)));
  }

  disconnect() {
    try { this.splitter.disconnect(); } catch {}
    this.speakers.forEach((p) => { try { p.disconnect(); } catch {} });
  }
}

// Plain stereo from first-order ambisonics when spatial audio is off:
// two virtual cardioid microphones pointing left and right (L = W + Y, R = W - Y).
export class AmbiFold {
  constructor(ctx, input, output) {
    this.split = ctx.createChannelSplitter(4);
    this.merge = ctx.createChannelMerger(2);
    input.connect(this.split);
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.nodes = [];
    for (const [out, ysign] of [[0, 1], [1, -1]]) {
      const w = g(0.5), y = g(0.5 * ysign);
      this.split.connect(w, 0); this.split.connect(y, 1);
      w.connect(this.merge, 0, out); y.connect(this.merge, 0, out);
      this.nodes.push(w, y);
    }
    this.merge.connect(output);
  }
  disconnect() { try { this.split.disconnect(); this.merge.disconnect(); } catch {} }
}
