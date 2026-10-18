// UI sound effects, synthesized with Web Audio so there are no sound files to ship.
let ctx = null, master = null;
const cfg = { on: true, volume: 40, quietWhen: () => false };

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  master.gain.value = (cfg.volume / 100) * 0.5;
  return ctx;
}

function tone(freq, { type = 'sine', dur = 0.08, gain = 0.3, slide = 0, delay = 0, attack = 0.004 } = {}) {
  const c = audio(), t = c.currentTime + delay;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise({ dur = 0.15, gain = 0.25, from = 2000, to = 600, q = 1, delay = 0 } = {}) {
  const c = audio(), t = c.currentTime + delay;
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  src.buffer = buf;
  f.type = 'bandpass'; f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

const SOUNDS = {
  click: () => tone(1800, { type: 'triangle', dur: 0.035, gain: 0.12 }),
  tab: () => { tone(900, { type: 'sine', dur: 0.06, gain: 0.12, slide: 1.4 }); noise({ dur: 0.09, gain: 0.05, from: 3000, to: 1500 }); },
  on: () => { tone(660, { type: 'triangle', dur: 0.05, gain: 0.15 }); tone(990, { type: 'triangle', dur: 0.07, gain: 0.15, delay: 0.045 }); },
  off: () => { tone(880, { type: 'triangle', dur: 0.05, gain: 0.13 }); tone(560, { type: 'triangle', dur: 0.08, gain: 0.13, delay: 0.045 }); },
  whoosh: () => noise({ dur: 0.28, gain: 0.18, from: 400, to: 3500, q: 0.8 }),
  open: () => tone(520, { type: 'sine', dur: 0.12, gain: 0.14, slide: 1.6 }),
  close: () => tone(700, { type: 'sine', dur: 0.1, gain: 0.12, slide: 0.6 }),
  shutter: () => { noise({ dur: 0.05, gain: 0.35, from: 5000, to: 2500, q: 0.6 }); noise({ dur: 0.07, gain: 0.25, from: 3000, to: 1200, q: 0.6, delay: 0.07 }); },
  success: () => [523, 659, 784].forEach((f, i) => tone(f, { dur: 0.22, gain: 0.13, delay: i * 0.07 })),
  chime: () => [784, 988, 1319].forEach((f, i) => tone(f, { type: 'sine', dur: 0.5, gain: 0.12, delay: i * 0.11 })),
  error: () => { tone(220, { type: 'square', dur: 0.12, gain: 0.08 }); tone(165, { type: 'square', dur: 0.18, gain: 0.08, delay: 0.1 }); },
  pop: () => tone(600, { type: 'sine', dur: 0.09, gain: 0.18, slide: 2.2, attack: 0.002 }),
  tick: () => tone(2400, { type: 'sine', dur: 0.02, gain: 0.07 })
};

export const sfx = {
  configure(patch) { Object.assign(cfg, patch); },
  get settings() { return { on: cfg.on, volume: cfg.volume }; },
  play(name) {
    if (!cfg.on || cfg.quietWhen()) return;
    try { SOUNDS[name]?.(); } catch {}
  },
  names: Object.keys(SOUNDS)
};
