import * as THREE from '../node_modules/three/build/three.module.js';

// Renders a video onto the inside of a sphere. A fragment shader turns each view
// direction into a texture coordinate, so fisheye -> VR180 conversion, 360
// playback, per-eye calibration, anaglyph 3D and picture adjustments all happen
// live on the GPU.
const vertexShader = `
  uniform vec3 domeOffset;    // comfort "height": the dome centre, in world space
  varying vec3 vDir;
  void main() {
    // Direction from the eye (not from the sphere centre), turned into the dome's frame.
    // Infinity stays at infinity for each eye and the picture doesn't swim when you lean.
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vDir = (wp.xyz - cameraPosition - domeOffset) * mat3(modelMatrix);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const fragmentShader = `
  #define PI 3.14159265359
  uniform sampler2D map;
  uniform int projection;     // 0 fisheye, 1 equirect 180, 2 equirect 360, 3 flat screen
  uniform int stereoLayout;   // 0 mono, 1 side-by-side, 2 top-bottom
  uniform int viewMode;       // 0 normal, 1 red/cyan anaglyph
  uniform float eye;          // which eye this mesh is drawn for (0 left, 1 right)
  uniform mat3 rotL, rotR;    // per-eye alignment (IPD / vertical / roll)
  uniform float zoomL, zoomR; // angular magnification per eye
  uniform float sideL, sideR; // which half of the frame each eye reads (swap eyes)
  uniform float fov;          // fisheye lens field of view (radians)
  uniform vec2 lensCenter;    // lens centre offset in eye uv
  uniform float stretch;      // anamorphic horizontal stretch
  uniform float screenFov;    // flat mode: horizontal size of the virtual screen (radians)
  uniform float screenAspect; // flat mode: eye width / height
  uniform vec3 picture;       // brightness, contrast, saturation
  uniform float vib;          // "match flat view": vibrance + a little contrast, 0..1
  uniform highp sampler3D lut;// colour look (.cube LUT)
  uniform float lutSize;
  uniform float lutMix;       // 0 = off
  uniform int env;            // flat-screen surroundings: 0 void, 1 cinema, 2 lounge, 3 starfield, 4 sunset
  uniform float time;
  uniform float dim;          // fade to black (slideshow transitions)
  uniform float decodeMap;    // 1 = map holds sRGB-encoded video frames (three only decodes those for built-in materials)
  uniform float sharpen;      // 0..1 contrast-adaptive sharpening
  uniform vec2 texel;         // 1 / texture size
  uniform float vignette;     // 0..1 comfort vignette (narrows the view when the footage moves a lot)
  uniform vec3 viewFwd;       // where the viewer looks, in the dome's frame
  uniform vec3 ambient;       // average colour of the picture (light spill in the virtual cinema)
  uniform float curved;       // flat mode: 1 = curved (cylindrical) screen
  uniform sampler2D depthMap; // 2D -> 3D: relative depth (1 = near)
  uniform float depth3d;      // 2D -> 3D strength (0 = off)
  uniform float depthConv;    // 2D -> 3D convergence: depth that sits at the screen
  varying vec3 vDir;

  const vec3 OUTSIDE = vec3(0.02, 0.02, 0.025);

  // ---- procedural environments around a flat 2D screen
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  vec3 envColor(vec3 d) {
    float fwd = clamp(-d.z, 0.0, 1.0);
    if (env == 1) { // cinema: dark room, seat rows, light spilling from the screen
      float glow = pow(fwd, 6.0) * 0.35;
      vec3 c = vec3(0.035, 0.03, 0.035) + vec3(0.25, 0.22, 0.3) * glow;
      if (d.y < -0.25) {
        float rows = smoothstep(0.35, 0.65, fract((-d.z / -d.y) * 1.6));
        c = mix(vec3(0.045, 0.01, 0.014), vec3(0.12, 0.022, 0.032), rows) * (0.45 + glow * 2.5);
      }
      if (d.y > 0.45) c *= 0.5;
      return c;
    }
    if (env == 2) { // lounge: warm walls, wooden floor, a window
      vec3 c = mix(vec3(0.16, 0.10, 0.06), vec3(0.09, 0.06, 0.04), clamp(d.y * 1.5 + 0.5, 0.0, 1.0));
      if (d.y < -0.3) { vec2 p = d.xz / -d.y; c = mix(vec3(0.20, 0.12, 0.06), vec3(0.16, 0.095, 0.05), step(0.5, fract(p.x * 2.0))); }
      float ax = atan(d.x, -d.z);
      if (ax < -1.2 && ax > -2.0 && d.y > -0.05 && d.y < 0.45) c = vec3(0.55, 0.65, 0.8) * (0.8 + 0.2 * d.y);
      if (d.y > 0.6) c = vec3(0.12, 0.09, 0.07);
      return c + vec3(0.2, 0.18, 0.25) * pow(fwd, 8.0) * 0.4;
    }
    if (env == 3) { // starfield with a slowly drifting nebula
      vec3 q = d;
      float a = time * 0.01;
      q.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * q.xz;
      vec3 cell = floor(q * 180.0);
      float star = step(0.9975, hash(cell)) * (0.5 + 0.5 * hash(cell + 1.3));
      float n = noise(q * 3.0) * 0.6 + noise(q * 7.0) * 0.4;
      vec3 neb = mix(vec3(0.02, 0.0, 0.05), vec3(0.15, 0.04, 0.2), n * n) + vec3(0.0, 0.05, 0.12) * noise(q * 2.0 + 5.0);
      return neb * 0.6 + vec3(star);
    }
    if (env == 4) { // sunset over the sea
      if (d.y > 0.0) {
        vec3 sky = mix(vec3(0.15, 0.12, 0.35), vec3(1.0, 0.45, 0.18), pow(1.0 - d.y, 3.0));
        float sun = smoothstep(0.995, 0.999, dot(d, normalize(vec3(0.0, 0.06, -1.0))));
        return sky + vec3(1.0, 0.8, 0.5) * sun;
      }
      float t = clamp(-d.y * 4.0, 0.0, 1.0);
      vec3 sea = mix(vec3(0.5, 0.22, 0.12), vec3(0.03, 0.05, 0.12), t);
      return sea + vec3(0.6, 0.3, 0.1) * step(0.97, noise(vec3(d.x * 80.0, d.z * 20.0, time * 0.5))) * (1.0 - t);
    }
    return OUTSIDE;
  }
  vec3 outside(vec3 d) {
    if (projection != 3 || env == 0) return OUTSIDE;
    // light spilling from the screen: strongest straight ahead, tinted by the film
    float fwd = clamp(-d.z, 0.0, 1.0);
    return envColor(d) + ambient * (0.08 + 0.55 * pow(fwd, 5.0)) * (env == 3 ? 0.35 : 1.0);
  }

  vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }

  vec3 tap(vec2 uv) {
    vec3 c = texture2D(map, uv).rgb;
    return decodeMap > 0.5 ? toLinear(c) : c;
  }
  // AMD-style contrast-adaptive sharpening on the 4 neighbours
  vec3 sharpTap(vec2 uv) {
    vec3 c = tap(uv);
    if (sharpen <= 0.0) return c;
    vec3 n = tap(uv + vec2(0.0, texel.y)), s = tap(uv - vec2(0.0, texel.y));
    vec3 e = tap(uv + vec2(texel.x, 0.0)), w = tap(uv - vec2(texel.x, 0.0));
    vec3 mn = min(c, min(min(n, s), min(e, w))), mx = max(c, max(max(n, s), max(e, w)));
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0));
    vec3 wgt = amp * (-1.0 / mix(8.0, 4.5, sharpen));
    return clamp((c + (n + s + e + w) * wgt) / (1.0 + 4.0 * wgt), 0.0, 1.0);
  }

  vec3 sampleEye(vec3 dir, mat3 rot, float zoom, float side) {
    vec3 d = rot * dir;
    if (zoom != 1.0) {
      float th = acos(clamp(-d.z, -1.0, 1.0)) / zoom;
      // past straight-behind there is nothing to show (avoids a mirrored ghost in 360 at small scale)
      if (th > PI) return outside(d);
      float ph = atan(d.y, d.x);
      d = vec3(sin(th) * cos(ph), sin(th) * sin(ph), -cos(th));
    }
    vec2 uv = vec2(0.0);
    if (projection == 0) {
      float r = acos(clamp(-d.z, -1.0, 1.0)) / fov;
      if (r > 0.5) return outside(d);
      float phi = atan(d.y, d.x);
      uv = vec2(0.5 + r * cos(phi), 0.5 + r * sin(phi));
    } else if (projection == 1) {
      if (d.z > 0.0) return outside(d);
      uv = vec2(atan(d.x, -d.z) / PI + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
    } else if (projection == 2) {
      uv = vec2(atan(d.x, -d.z) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
    } else if (curved > 0.5) {
      // curved screen: width follows the angle, so the edges aren't stretched
      float ax = atan(d.x, -d.z);
      if (abs(ax) > PI * 0.5) return outside(d);
      float hh = screenFov / screenAspect;
      uv = vec2(ax / screenFov + 0.5, (d.y / length(d.xz)) / (2.0 * tan(hh * 0.5)) + 0.5);
    } else {
      if (d.z > -0.05) return outside(d);
      vec2 p = d.xy / -d.z;
      float hw = tan(screenFov * 0.5);
      uv = p / vec2(2.0 * hw, 2.0 * hw / screenAspect) + 0.5;
    }
    uv.x = (uv.x - 0.5) / stretch + 0.5;
    uv += lensCenter;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return outside(d);
    // 2D -> 3D: shift each eye by the estimated depth (near things move apart)
    if (depth3d > 0.0 && stereoLayout == 0) {
      float sgn = side < 0.5 ? 1.0 : -1.0;
      vec2 u2 = uv;
      for (int i = 0; i < 3; i++) {
        float z = texture2D(depthMap, clamp(u2, 0.0, 1.0)).r;
        u2 = uv - vec2(sgn * depth3d * (z - depthConv), 0.0);
      }
      uv = clamp(u2, 0.0, 1.0);
    }
    if (stereoLayout == 1) uv.x = uv.x * 0.5 + side * 0.5;
    else if (stereoLayout == 2) uv.y = uv.y * 0.5 + (1.0 - side) * 0.5;
    return sharpTap(uv);
  }

  vec3 adjust(vec3 c) {
    if (lutMix > 0.0) {
      // LUTs expect gamma-encoded colour, the texture gives linear
      vec3 g = toSrgb(clamp(c, 0.0, 1.0));
      vec3 graded = texture(lut, g * (lutSize - 1.0) / lutSize + 0.5 / lutSize).rgb;
      c = mix(c, toLinear(graded), lutMix);
    }
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, picture.z);
    c = (c - 0.5) * picture.y + 0.5 + picture.x;
    if (vib > 0.0) {
      // vibrance: boosts dull colours more than already-vivid ones (done on gamma-encoded values, like video players)
      vec3 g = toSrgb(clamp(c, 0.0, 1.0));
      float s = max(g.r, max(g.g, g.b)) - min(g.r, min(g.g, g.b));
      float gl = dot(g, vec3(0.2126, 0.7152, 0.0722));
      g = mix(vec3(gl), g, 1.0 + vib * 0.35 * (1.0 - s));
      g = (g - 0.5) * (1.0 + 0.08 * vib) + 0.5;
      c = toLinear(clamp(g, 0.0, 1.0));
    }
    return c;
  }

  void main() {
    vec3 dir = normalize(vDir);
    vec3 c;
    if (viewMode == 1) {
      // Dubois least-squares red/cyan matrices: much less ghosting than a plain channel split
      vec3 L = adjust(sampleEye(dir, rotL, zoomL, sideL));
      vec3 R = adjust(sampleEye(dir, rotR, zoomR, sideR));
      c = vec3(
        dot(L, vec3(0.437, 0.449, 0.164)) + dot(R, vec3(-0.011, -0.032, -0.007)),
        dot(L, vec3(-0.062, -0.062, -0.024)) + dot(R, vec3(0.377, 0.761, 0.009)),
        dot(L, vec3(-0.048, -0.050, -0.017)) + dot(R, vec3(-0.026, -0.093, 1.234)));
    } else if (eye < 0.5) {
      c = adjust(sampleEye(dir, rotL, zoomL, sideL));
    } else {
      c = adjust(sampleEye(dir, rotR, zoomR, sideR));
    }
    if (vignette > 0.0) {
      // comfort vignette: darken the edges of your view while the footage moves a lot
      float a = acos(clamp(dot(dir, normalize(viewFwd)), -1.0, 1.0));
      float r = mix(1.6, 0.55, vignette);
      c *= 1.0 - smoothstep(r, r + 0.35, a);
    }
    gl_FragColor = vec4(clamp(c, 0.0, 1.0) * (1.0 - dim), 1.0);
    #include <colorspace_fragment>
  }`;

export const DEFAULT_CALIB = {
  eyesOn: true, ipd: 0, leftV: 0, rightV: 0, leftRoll: 0, rightRoll: 0, leftZoom: 100, rightZoom: 100, swap: false,
  comfortOn: true, tilt: 0, roll: 0, height: 0, scale: 100, laydown: false,
  lensOn: true, fov: 180, cx: 0, cy: 0, stretch: 100, screen: 80,
  pictureOn: true, brightness: 0, contrast: 100, saturation: 100
};

const rad = (deg) => (deg * Math.PI) / 180;
const eyeMatrix = (pitch, yaw, roll) =>
  new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rad(pitch), rad(yaw), rad(roll), 'YXZ')));

function blankDepth() {
  const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

function identityLut() {
  const d = new Uint8Array(2 * 2 * 2 * 4);
  let i = 0;
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) { d[i++] = r * 255; d[i++] = g * 255; d[i++] = b * 255; d[i++] = 255; }
  return lutTexture(d, 2);
}
function lutTexture(data, size) {
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export class VRView {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(90, 1, 0.05, 100);
    this.camera.layers.enable(1); // desktop view shows the left eye
    this.scene.add(this.camera);

    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.version = 0;          // bumps whenever something visible changes (render on demand)
    this.lastSig = '';
    // A seek while paused shows a new frame without a frame callback: upload and redraw it.
    const fresh = () => { if (this.texture?.isVideoTexture && video.readyState >= 2) this.texture.needsUpdate = true; this.invalidate(); };
    for (const ev of ['seeked', 'loadeddata', 'emptied']) video.addEventListener(ev, fresh);

    this.dome = new THREE.Group();
    this.scene.add(this.dome);
    const geo = new THREE.SphereGeometry(10, 128, 96);
    this.materials = [0, 1].map((eye) => new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.texture },
        projection: { value: 0 },
        stereoLayout: { value: 0 },
        viewMode: { value: 0 },
        eye: { value: eye },
        rotL: { value: new THREE.Matrix3() }, rotR: { value: new THREE.Matrix3() },
        zoomL: { value: 1 }, zoomR: { value: 1 },
        sideL: { value: 0 }, sideR: { value: 1 },
        fov: { value: Math.PI },
        lensCenter: { value: new THREE.Vector2() },
        stretch: { value: 1 },
        screenFov: { value: rad(80) },
        screenAspect: { value: 16 / 9 },
        picture: { value: new THREE.Vector3(0, 1, 1) },
        vib: { value: 0 },
        lut: { value: identityLut() },
        lutSize: { value: 2 },
        lutMix: { value: 0 },
        env: { value: 0 },
        time: { value: 0 },
        dim: { value: 0 },
        decodeMap: { value: 1 },
        sharpen: { value: 0 },
        texel: { value: new THREE.Vector2(1 / 3840, 1 / 1920) },
        vignette: { value: 0 },
        viewFwd: { value: new THREE.Vector3(0, 0, -1) },
        ambient: { value: new THREE.Vector3() },
        curved: { value: 0 },
        depthMap: { value: blankDepth() },
        depth3d: { value: 0 },
        depthConv: { value: 0.5 },
        domeOffset: { value: new THREE.Vector3() }
      },
      vertexShader, fragmentShader, side: THREE.BackSide, depthWrite: false
    }));
    this.materials.forEach((m, eye) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.layers.set(eye + 1); // WebXR renders layer 1 to the left eye and layer 2 to the right
      this.dome.add(mesh);
    });

    // Subtitle panel for the headset (desktop uses an HTML overlay instead)
    this.subCanvas = document.createElement('canvas');
    this.subCanvas.width = 1024; this.subCanvas.height = 256;
    this.subTexture = new THREE.CanvasTexture(this.subCanvas);
    this.subTexture.colorSpace = THREE.SRGBColorSpace;
    this.subMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), new THREE.MeshBasicMaterial({ map: this.subTexture, transparent: true, depthTest: false }));
    this.subMesh.renderOrder = 10;
    this.subMesh.visible = false;
    this.scene.add(this.subMesh);

    this.format = { projection: 'fisheye', layout: '2d' };
    this.calib = { ...DEFAULT_CALIB };
    this.mode = 'vr';        // 'vr' | 'anaglyph' | 'sbs'
    this.yaw = 0; this.pitch = 0;
    this.onXRInput = null;
    this.onXRSelect = null;
    this.clock = new THREE.Clock();
    this.setupXRControllers();
    this.renderer.setAnimationLoop(() => this.render());
    this.bindControls();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
    this.resize();
  }

  setFormat({ projection, layout, eyeAspect }) {
    if (projection) this.format.projection = projection;
    if (layout) this.format.layout = layout;
    if (eyeAspect) this.eyeAspect = eyeAspect;
    this.apply();
  }

  // ---- colour look: lut = { data: Uint8Array RGBA, size } or null
  setLut(lut, mix = 1) {
    const tex = lut ? lutTexture(lut.data, lut.size) : null;
    for (const m of this.materials) {
      const u = m.uniforms;
      if (tex) { if (u.lut.value.userData?.owned) u.lut.value.dispose(); u.lut.value = tex; u.lutSize.value = lut.size; }
      u.lutMix.value = lut ? mix : 0;
    }
    if (tex) tex.userData.owned = true;
  }
  setLutMix(mix) { for (const m of this.materials) m.uniforms.lutMix.value = m.uniforms.lutSize.value > 2 ? mix : 0; }

  // ---- surroundings for flat 2D video
  setEnv(id) { for (const m of this.materials) m.uniforms.env.value = id || 0; this.invalidate(); }

  // ---- horizon auto-level: extra roll applied to the dome (degrees)
  setLevelRoll(deg) {
    if (Math.abs((this.levelRoll || 0) - deg) < 0.005) return;
    this.levelRoll = deg;
    const c = this.calib.comfortOn ? this.calib : DEFAULT_CALIB;
    this.dome.rotation.z = rad(c.roll + deg);
    this.invalidate();
  }

  // ---- fade to black (0..1), used between slideshow photos
  // "Match flat view" colour boost for every video (0 = off)
  setVibrance(amount) { for (const mat of this.materials) mat.uniforms.vib.value = Math.max(0, Math.min(1, amount)); this.invalidate(); }

  setDim(v) { for (const m of this.materials) m.uniforms.dim.value = v; this.invalidate(); }

  // ---- show a video element or a photo (img / canvas)
  setSource(el) {
    const old = this.texture;
    if (el instanceof HTMLVideoElement) {
      this.texture = this.videoTexture || (this.videoTexture = old);
    } else {
      // photos are static: full mip chain + anisotropic filtering, so 8K stills don't shimmer
      this.texture = new THREE.Texture(el);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.minFilter = THREE.LinearMipmapLinearFilter;
      this.texture.generateMipmaps = true;
      this.texture.anisotropy = this.maxAniso;
      this.texture.needsUpdate = true;
    }
    if (!this.videoTexture && old instanceof THREE.VideoTexture) this.videoTexture = old;
    if (old !== this.texture && !(old instanceof THREE.VideoTexture)) old.dispose();
    const isVideo = this.texture.isVideoTexture === true;
    const w = isVideo ? this.video.videoWidth : el.naturalWidth || el.width;
    const h = isVideo ? this.video.videoHeight : el.naturalHeight || el.height;
    for (const m of this.materials) {
      m.uniforms.map.value = this.texture;
      m.uniforms.decodeMap.value = isVideo ? 1 : 0;
      if (w && h) m.uniforms.texel.value.set(1 / w, 1 / h);
    }
    this.invalidate();
  }

  // ---- picture quality: sharpening 0..1, smooth downscaling of video (mipmaps)
  setQuality({ sharpen, videoMips } = {}) {
    if (sharpen != null) for (const m of this.materials) m.uniforms.sharpen.value = Math.max(0, Math.min(1, sharpen));
    if (videoMips != null && this.videoTexture) {
      const t = this.videoTexture;
      t.generateMipmaps = !!videoMips;
      t.minFilter = videoMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      t.anisotropy = videoMips ? Math.min(8, this.maxAniso) : 1;
      t.needsUpdate = true;
    }
    this.invalidate();
  }
  // the video's real size (after rotation), so sharpening steps exactly one texel
  updateTexel() {
    if (this.texture?.isVideoTexture && this.video.videoWidth) for (const m of this.materials) m.uniforms.texel.value.set(1 / this.video.videoWidth, 1 / this.video.videoHeight);
  }
  // ---- comfort vignette (0..1) and the screen's average colour for the cinema
  setVignette(v) {
    v = Math.max(0, Math.min(1, v));
    if (Math.abs(this.materials[0].uniforms.vignette.value - v) < 1e-4) return;
    for (const m of this.materials) m.uniforms.vignette.value = v;
    this.invalidate();
  }
  setAmbient(r, g, b) { for (const m of this.materials) m.uniforms.ambient.value.set(r, g, b); this.invalidate(); }
  setCurved(on) { for (const m of this.materials) m.uniforms.curved.value = on ? 1 : 0; this.invalidate(); }
  // ---- 2D -> 3D: depth texture (THREE.Texture or null), strength 0..1, convergence 0..1
  setDepth(tex, strength = 0, conv = 0.5) {
    for (const m of this.materials) {
      const u = m.uniforms;
      if (tex) u.depthMap.value = tex;
      u.depth3d.value = tex ? strength * 0.035 : 0;
      u.depthConv.value = conv;
    }
    const on = !!tex && strength > 0;
    if (on !== !!this.depthOn) { this.depthOn = on; this.apply(); this.resize(); }
    this.invalidate();
  }
  // a new depth map arrived (same texture object, new pixels)
  depthUpdated() { this.invalidate(); }
  invalidate() { this.version++; }

  // ---- picture-in-picture: a flat panel floating in the dome
  setPip(opts) {
    if (!opts) { if (this.pip) this.pip.mesh.visible = false; return; }
    if (!this.pip) {
      const tex = new THREE.VideoTexture(opts.video);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.renderOrder = 5;
      this.scene.add(mesh);
      this.pip = { mesh, mat, tex };
    }
    const { mesh, mat } = this.pip;
    const D = 6;
    const yaw = rad(opts.yaw ?? -35), pitch = rad(opts.pitch ?? -15);
    // yaw: positive = to the left (same as looking around); pitch: positive = up
    mesh.position.set(-Math.sin(yaw) * Math.cos(pitch) * D, Math.sin(pitch) * D, -Math.cos(yaw) * Math.cos(pitch) * D);
    mesh.lookAt(0, 0, 0);
    const w = (opts.size ?? 30) / 100 * D * 1.2;
    const aspect = opts.video.videoWidth && opts.video.videoHeight ? opts.video.videoWidth / opts.video.videoHeight : 16 / 9;
    mesh.scale.set(w, w / aspect, 1);
    mat.opacity = (opts.opacity ?? 100) / 100;
    mesh.visible = true;
    this.invalidate();
  }

  setCalib(c) {
    this.calib = { ...DEFAULT_CALIB, ...c };
    this.apply();
  }

  // 'vr' (one eye), 'anaglyph' (red/cyan both eyes), 'sbs' (both eyes next to each other)
  setMode(mode) {
    this.mode = mode;
    this.apply();
    this.resize();
  }

  apply() {
    const f = this.format, c = this.calib, d = DEFAULT_CALIB;
    const e = c.eyesOn ? c : d, lens = c.lensOn ? c : d, comfort = c.comfortOn ? c : d, pic = c.pictureOn ? c : d;
    const proj = { fisheye: 0, equirect180: 1, equirect360: 2, flat: 3 }[f.projection] ?? 0;
    const lay = { '2d': 0, sbs: 1, tb: 2 }[f.layout] ?? 0;
    const swap = e.swap && lay;
    const scale = comfort.scale / 100;
    // IPD turns each eye half the offset outward; vertical and roll are per eye
    const rotL = eyeMatrix(e.leftV, -e.ipd / 2, e.leftRoll);
    const rotR = eyeMatrix(e.rightV, e.ipd / 2, e.rightRoll);
    for (const m of this.materials) {
      const u = m.uniforms;
      u.projection.value = proj;
      u.stereoLayout.value = lay;
      u.viewMode.value = this.mode === 'anaglyph' && (lay || this.depthOn) && !this.renderer.xr.isPresenting ? 1 : 0;
      u.rotL.value.copy(rotL); u.rotR.value.copy(rotR);
      u.zoomL.value = scale * e.leftZoom / 100;
      u.zoomR.value = scale * e.rightZoom / 100;
      u.sideL.value = swap ? 1 : 0;
      u.sideR.value = swap ? 0 : 1;
      u.fov.value = rad(lens.fov);
      u.lensCenter.value.set(lens.cx / 100, lens.cy / 100);
      u.stretch.value = lens.stretch / 100;
      u.screenFov.value = rad(lens.screen);
      u.screenAspect.value = this.eyeAspect || 16 / 9;
      u.picture.value.set(pic.brightness / 100, pic.contrast / 100, pic.saturation / 100);
    }
    const tilt = comfort.tilt + (comfort.laydown && this.renderer.xr.isPresenting ? 60 : 0);
    const recenter = this.renderer.xr.isPresenting ? this.xrYaw || 0 : 0;
    this.dome.rotation.set(rad(tilt), recenter, rad(comfort.roll + (this.levelRoll || 0)), 'YXZ');
    this.domeOffset = new THREE.Vector3(0, comfort.height / 100, 0);
    for (const m of this.materials) m.uniforms.domeOffset.value.copy(this.domeOffset);
    this.invalidate();
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h || this.renderer.xr.isPresenting) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = (this.mode === 'sbs' ? w / 2 : w) / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  render(force) {
    const dt = this.clock.getDelta();
    for (const m of this.materials) m.uniforms.time.value += dt;
    if (this.renderer.xr.isPresenting) {
      this.pollXR(dt);
      this.updateViewFwd(this.renderer.xr.getCamera());
      this.renderer.render(this.scene, this.camera);
      this.frames = (this.frames || 0) + 1;
      return;
    }
    // a phone's tilt sensor can drive the camera instead of mouse/touch drag
    if (this.deviceQuat) this.camera.quaternion.copy(this.deviceQuat);
    else this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    // Render on demand: skip the frame when nothing visible changed (paused video, photos,
    // menus). Animated surroundings (stars, sea) and new video frames still render.
    const u = this.materials[0].uniforms;
    const q = this.camera.quaternion;
    const animated = u.projection.value === 3 && (u.env.value === 3 || u.env.value === 4);
    const sig = [this.texture.version, q.x.toFixed(5), q.y.toFixed(5), q.z.toFixed(5), q.w.toFixed(5), this.camera.fov, this.mode, this.version, this.previewEye || 0, this.pip?.tex?.version || 0].join('|');
    if (!force && !animated && sig === this.lastSig && !this.pip?.mesh.visible) return;
    this.lastSig = sig;
    this.frames = (this.frames || 0) + 1;
    this.updateViewFwd(this.camera);
    if (this.mode === 'sbs' && (this.format.layout !== '2d' || this.depthOn)) {
      // Left eye in the left half, right eye in the right half
      const size = this.renderer.getSize(new THREE.Vector2());
      const hw = Math.floor(size.x / 2);
      this.renderer.setScissorTest(true);
      [[1, 0], [2, hw]].forEach(([layer, x]) => {
        this.camera.layers.set(layer);
        this.renderer.setViewport(x, 0, hw, size.y);
        this.renderer.setScissor(x, 0, hw, size.y);
        this.renderer.render(this.scene, this.camera);
      });
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, size.x, size.y);
      this.camera.layers.set(0);
      this.camera.layers.enable(this.previewEye || 1);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // where the viewer looks, expressed in the dome's frame (for the comfort vignette)
  updateViewFwd(cam) {
    const u = this.materials[0].uniforms;
    if (u.vignette.value <= 0) return;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    f.applyQuaternion(this.dome.getWorldQuaternion(new THREE.Quaternion()).invert());
    for (const m of this.materials) m.uniforms.viewFwd.value.copy(f);
  }

  // Calibrate's "Left eye / Right eye" preview
  showEye(layer) {
    this.previewEye = layer;
    this.camera.layers.set(0);
    this.camera.layers.enable(layer);
    this.invalidate();
  }

  look(dYaw, dPitch) {
    const lim = this.format.projection === 'equirect360' ? Infinity : Math.PI;
    this.yaw = Math.max(-lim, Math.min(lim, this.yaw + dYaw));
    this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch + dPitch));
  }

  // Where the viewer is looking (radians), from the headset when in VR
  viewAngles() {
    if (this.renderer.xr.isPresenting) {
      const cam = this.renderer.xr.getCamera();
      const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
      return { yaw: e.y, pitch: e.x };
    }
    return { yaw: this.yaw, pitch: this.pitch };
  }

  // Rotation from the picture's frame to the listener's head, in ambisonic axes
  // (X front, Y left, Z up). Includes dome tilt, roll, horizon level, lay-down and head roll.
  audioMatrix() {
    const cam = this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
    const qh = cam.getWorldQuaternion(new THREE.Quaternion());
    const qd = this.dome.getWorldQuaternion(new THREE.Quaternion());
    const e = new THREE.Matrix4().makeRotationFromQuaternion(qh.invert().multiply(qd)).elements;
    const R = [[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]];
    const C = [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]; // three (x right, y up, -z ahead) -> ambisonic
    const CR = C.map((r) => [0, 1, 2].map((j) => r[0] * R[0][j] + r[1] * R[1][j] + r[2] * R[2][j]));
    return CR.map((r) => [0, 1, 2].map((j) => r[0] * C[j][0] + r[1] * C[j][1] + r[2] * C[j][2]));
  }

  zoom(delta) {
    this.camera.fov = Math.max(25, Math.min(120, this.camera.fov + delta));
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  reset() {
    this.yaw = 0; this.pitch = 0;
    this.camera.fov = 90;
    this.camera.updateProjectionMatrix();
  }

  snapshot() {
    this.render(true);
    return this.canvas.toDataURL('image/png');
  }

  bindControls() {
    let drag = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = (this.camera.fov / this.canvas.clientHeight) * (Math.PI / 180);
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      this.look(dx * k, dy * k);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    this.canvas.addEventListener('pointerup', () => {
      this.lastDragMoved = drag?.moved;
      drag = null;
    });
    this.canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY * 0.05); }, { passive: false });
  }

  // ---- headset subtitles
  setSubtitle(text, style = {}) {
    const ctx = this.subCanvas.getContext('2d');
    const { width: W, height: H } = this.subCanvas;
    ctx.clearRect(0, 0, W, H);
    this.subText = text;
    this.subMesh.visible = !!text && this.renderer.xr.isPresenting;
    if (!text) return;
    const size = Math.round(54 * (style.size || 100) / 100);
    ctx.font = `600 ${size}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = text.split('\n').slice(0, 3);
    const lh = size * 1.25;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const bh = lines.length * lh + 24;
    ctx.fillStyle = `rgba(0,0,0,${(style.bg ?? 60) / 100})`;
    ctx.beginPath();
    ctx.roundRect((W - widest) / 2 - 24, (H - bh) / 2, widest + 48, bh, 18);
    ctx.fill();
    ctx.fillStyle = '#fff';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, H / 2 + (i - (lines.length - 1) / 2) * lh));
    this.subTexture.needsUpdate = true;
    this.subStyle = style;
  }

  // ---- WebXR headset
  setupXRControllers() {
    this.controllers = [];
    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      this.controllers.push(c);
      c.addEventListener('connected', (e) => (c.userData.hand = e.data.handedness));
      // a trigger pull on the floating panel clicks it instead of playing/pausing
      c.addEventListener('select', () => { if (this.xrPanel?.select(c)) return; this.onXRSelect?.(c.userData.hand, 'trigger'); });
      c.addEventListener('squeezestart', () => (c.userData.grip = true));
      c.addEventListener('squeezeend', () => (c.userData.grip = false));
      this.scene.add(c);
    }
    this.renderer.xr.addEventListener('sessionstart', () => { this.xrYaw = 0; this.subMesh.visible = !!this.subText; this.apply(); });
    this.renderer.xr.addEventListener('sessionend', () => { this.xrPanel?.show(false); this.subMesh.visible = false; this.subMesh.position.set(0, 0, 0); this.apply(); this.resize(); });
  }

  // Recenter in the headset: whatever direction you face becomes "straight ahead"
  recenterXR() {
    if (!this.renderer.xr.isPresenting) return;
    const e = new THREE.Euler().setFromQuaternion(this.renderer.xr.getCamera().quaternion, 'YXZ');
    this.xrYaw = e.y;
    this.apply();
  }
  // Headset render resolution (1 = native, up to 1.6 supersampling); applies to the next session
  setXRScale(scale) {
    this.xrScaleWanted = Math.max(0.5, Math.min(2, scale || 1));
    if (!this.renderer.xr.isPresenting) try { this.renderer.xr.setFramebufferScaleFactor(this.xrScaleWanted); } catch {}
  }

  pollXR(dt) {
    // Subtitles follow your head lazily: ~2 m ahead, a little below eye level
    if (this.subMesh.visible) {
      const cam = this.renderer.xr.getCamera();
      const yaw = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ').y;
      const drop = -0.25 - ((this.subStyle?.height ?? 0) / 100);
      const target = new THREE.Vector3(-Math.sin(yaw) * 2, drop, -Math.cos(yaw) * 2).add(cam.position);
      this.subMesh.position.lerp(target, Math.min(1, dt * 3));
      this.subMesh.lookAt(cam.position);
      this.subMesh.scale.setScalar((this.subStyle?.size || 100) / 100);
    }
    const session = this.renderer.xr.getSession();
    if (session && this.xrPanel) this.xrPanel.update(dt, session);
    if (!session || !this.onXRInput) return;
    for (const src of session.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      const x = gp.axes[2] ?? gp.axes[0] ?? 0, y = gp.axes[3] ?? gp.axes[1] ?? 0;
      const grip = !!gp.buttons[1]?.pressed;
      const a = !!gp.buttons[4]?.pressed;
      this.onXRInput({ hand: src.handedness, x, y, grip, a }, dt);
    }
  }

  async xrSupported() {
    try { return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr')); } catch { return false; }
  }

  async enterXR() {
    this.setXRScale(this.xrScaleWanted || 1);
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    await this.renderer.xr.setSession(session);
    return session;
  }
}
