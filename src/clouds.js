// Volumetric clouds: a layer between CLOUD_BASE and CLOUD_TOP metres, raymarched through a tiling 3D noise painted at
// start-up (cloudNoise, in a worker). R: Perlin-Worley (the clouds' billowing shapes), G: Worley fbm (the detail
// eroding their edges). The sky's time-of-day palette lights them (uCloudLit, uCloudShade), the cover setting thickens
// them, and the ground's cloud shadows (sunshadow.js) sample the same density, so shadows and clouds agree.
//
// The march does not run per screen pixel: it fills a panorama of the sky round the camera (makeCloudSky), a slice of
// its rows each frame, and the sky's shader reads the panorama (one lookup). Its cost is fixed by the panorama's size,
// whatever the screen's resolution.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, float, vec2, vec3, vec4, uniform, clamp, max, min, exp, mix, dot, sin, cos, asin, atan, pow,
  renderGroup, nodeObject, positionGeometry, screenUV, screenCoordinate,
} from 'three/tsl';
import { mulberry32 } from './noise.js';

export const CLOUD_BASE = 900, CLOUD_TOP = 1900;
const SHAPE = 6000, DETAIL = 1400; // metres per tile of the noise

// ---------- the noise (worker side) ----------
// Tileable value: perlin gradient noise and Worley (inverted cellular) noise of period `p` cells over the unit cube.
function tileable(seed) {
  const rng = mulberry32(seed), perm = new Uint8Array(512), grads = [];
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  for (let i = 0; i < 256; i++) {
    const z = rng() * 2 - 1, a = rng() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    grads.push([r * Math.cos(a), r * Math.sin(a), z]);
  }
  const h = (x, y, z) => perm[(perm[(perm[x & 255] + y) & 255] + z) & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const perlin = (x, y, z, p) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
    let out = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      const g = grads[h((xi + dx) % p, (yi + dy) % p, (zi + dz) % p)];
      const v = g[0] * (xf - dx) + g[1] * (yf - dy) + g[2] * (zf - dz);
      out += v * (dx ? fade(xf) : 1 - fade(xf)) * (dy ? fade(yf) : 1 - fade(yf)) * (dz ? fade(zf) : 1 - fade(zf));
    }
    return out;
  };
  // each period's feature points, one per cell
  const pts = {};
  for (const p of [4, 8, 16, 32]) {
    const a = new Float32Array(p * p * p * 3);
    for (let i = 0; i < a.length; i++) a[i] = rng();
    pts[p] = a;
  }
  const worley = (x, y, z, p) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), P = pts[p];
    let d = 9;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const cx = xi + a, cy = yi + b, cz = zi + c;
      const o = ((((cz % p) + p) % p) * p * p + (((cy % p) + p) % p) * p + (((cx % p) + p) % p)) * 3;
      const ex = cx + P[o] - x, ey = cy + P[o + 1] - y, ez = cz + P[o + 2] - z;
      const e = ex * ex + ey * ey + ez * ez;
      if (e < d) d = e;
    }
    return 1 - Math.min(1, Math.sqrt(d));
  };
  return { perlin, worley };
}

const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);

export function paintCloudNoise(size = 64, seed = 31) {
  const { perlin, worley } = tileable(seed);
  const n = size * size * size, R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let k = 0; k < size; k++) for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = i / size, y = j / size, z = k / size;
    // perlin fbm (periods 4, 8, 16) carved by worley fbm (4, 8, 16): rounded billows
    let pf = 0, amp = 0.5, tot = 0;
    for (const p of [4, 8, 16]) { pf += amp * perlin(x * p, y * p, z * p, p); tot += amp; amp *= 0.5; }
    pf = pf / tot * 0.5 + 0.5;
    const w1 = worley(x * 4, y * 4, z * 4, 4), w2 = worley(x * 8, y * 8, z * 8, 8), w3 = worley(x * 16, y * 16, z * 16, 16);
    const wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
    const pw = Math.max(0, Math.min(1, remap(pf, wf - 1, 1, 0, 1)));
    // detail: worley fbm at higher frequencies
    const d1 = worley(x * 8, y * 8, z * 8, 8), d2 = worley(x * 16, y * 16, z * 16, 16), d3 = worley(x * 32, y * 32, z * 32, 32);
    const det = d1 * 0.625 + d2 * 0.25 + d3 * 0.125;
    const o = k * size * size + j * size + i;
    R[o] = pw; G[o] = det; B[o] = wf;
  }
  // each channel stretched over the full range
  const out = new Uint8Array(n * 4);
  [R, G, B].forEach((ch, c) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { lo = Math.min(lo, ch[i]); hi = Math.max(hi, ch[i]); }
    for (let i = 0; i < n; i++) out[i * 4 + c] = Math.round(((ch[i] - lo) / (hi - lo)) * 255);
  });
  for (let i = 0; i < n; i++) out[i * 4 + 3] = 255;
  return { data: out, size };
}

// ---------- the shaders ----------
// A 3D noise lookup that leaves the coordinates alone (three's own node gives every object sampling a texture a
// per-frame update for its flipY uniform, which a data texture never needs: on WebGL, ~5% of the CPU's frame)
class NoiseLookup extends THREE.Texture3DNode {
  setupUV(builder, uv) { return uv; }
}
const tex = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
tex.format = THREE.RGBAFormat;
tex.minFilter = tex.magFilter = THREE.LinearFilter;
tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
tex.unpackAlignment = 1;
export function setCloudNoise({ data, size }) {
  tex.image = { data, width: size, height: size, depth: size };
  tex.needsUpdate = true;
}
const look = (p) => nodeObject(new NoiseLookup(tex, p));
const fract1 = (x) => x.sub(x.floor());

// shared by the sky and the cloud shadows: the drift (sky.js uCloud), cover 0..1, the time of day's colours of the
// clouds' sunlit and shaded sides (the sky's uCloudLit, uCloudShade)
export const CLOUD = {
  uDrift: uniform(new THREE.Vector2()).setGroup(renderGroup),
  uCover: uniform(0.35).setGroup(renderGroup),
  uLit: uniform(new THREE.Color()).setGroup(renderGroup),
  uShade: uniform(new THREE.Color()).setGroup(renderGroup),
};

const sstepT = (a, b, x) => { const t = clamp(x.sub(a).div(float(b).sub(a)), 0.0, 1.0); return t.mul(t).mul(float(3.0).sub(t.mul(2.0))); };

// the cloud's density at world point p (y up); `detail`: erode the edges with the detail noise
export const cloudDensity = (p, detail = true) => {
  const drift = vec3(CLOUD.uDrift.x, 0.0, CLOUD.uDrift.y).mul(1000.0);
  const q = p.add(drift);
  const hgt = clamp(p.y.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE), 0.0, 1.0);
  const shape = look(q.div(SHAPE).xzy).r;
  // (fair-weather cumulus at the clear preset's 0.35, a closed deck at 1)
  const cov = mix(float(0.05), float(0.95), CLOUD.uCover.mul(CLOUD.uCover).mul(0.4).add(CLOUD.uCover.mul(0.6)));
  // how far into a cloud's core: 0 at its edge
  const core = clamp(shape.sub(float(1.0).sub(cov)).div(max(cov, 0.05)), 0.0, 1.0).toVar();
  // cumulus heaps: a flat base, the core rising highest, its edges low (the overcast's deck fills more of the slab)
  const top = core.pow(0.6).mul(mix(float(0.75), float(1.0), CLOUD.uCover));
  const base = clamp(core.mul(1.8).mul(sstepT(0.0, 0.05, hgt)).mul(sstepT(top, top.mul(0.55), hgt)), 0.0, 1.0).toVar();
  if (!detail) return base;
  const dq = q.add(drift.mul(0.5));
  // (Worley noise is high at its cells' middles: eroding by one minus it leaves round bumps there, cauliflower; B, the
  // coarser fbm, for the lumps, G for the finer ones on them, both stretched, their values bunch round the middle)
  const d = float(1.0).sub(sstepT(0.3, 0.68, look(dq.div(DETAIL * 2.2).xzy).b).mul(0.65).add(sstepT(0.3, 0.68, look(dq.div(DETAIL).xzy).g).mul(0.35)));
  // billows: the detail eats into the outer part of each heap (more towards the tops), leaving the inside dense
  return clamp(base.sub(d.mul(0.75).mul(float(1.0).sub(base.mul(0.5))).mul(hgt.mul(0.4).add(0.8))).div(0.4), 0.0, 1.0);
};

// March the layer along the view ray d from the camera at cam -> vec4(light scattered towards the camera,
// transmittance). steps: samples across the layer; jitter 0..1: where the first one falls in its step.
const marchClouds = (d, cam, sunDir, lit, shade, steps, jitter) => {
  const camY = cam.y;
  const res = vec4(0.0, 0.0, 0.0, 1.0).toVar();
  If(d.y.greaterThan(0.015), () => {
    const t0 = float(CLOUD_BASE).sub(camY).div(d.y), t1 = float(CLOUD_TOP).sub(camY).div(d.y);
    const far = min(t1, 60000.0);
    const ds = far.sub(t0).div(steps).toVar();
    const t = t0.add(ds.mul(jitter)).toVar();
    const T = float(1.0).toVar(), acc = vec3(0.0).toVar();
    const mu = dot(d, sunDir);
    // a strong forward lobe (silver linings), a weak back one
    const hg = (g) => float(1 - g * g).div(float(1 + g * g).sub(mu.mul(2 * g)).pow(1.5)).mul(1 / (4 * Math.PI));
    const phase = mix(hg(-0.15), hg(0.7), 0.35).mul(4 * Math.PI);
    // density -> extinction per metre: thick cumulus go opaque over a hundred metres or so
    const sigma = float(1 / 45);
    Loop(steps, () => {
      If(T.lessThan(0.02).or(t.greaterThan(far)), () => { Break(); });
      const p = d.mul(t).add(cam).toVar();
      const dens = cloudDensity(p).toVar();
      If(dens.greaterThan(0.002), () => {
        // the sun's light through the cloud towards it: four samples, ever further; the nearest with the billows, so
        // they shade each other
        const ls = float(0.0).toVar();
        for (const [k, len, fine] of [[25, 50, true], [80, 80, false], [190, 150, false], [440, 320, false]]) ls.addAssign(cloudDensity(p.add(sunDir.mul(k)), fine).mul(len));
        const tau = ls.mul(sigma);
        // (with a share of light scattered many times over: the shaded side grey, not black)
        const toSun = max(exp(tau.negate()), exp(tau.mul(-0.2)).mul(0.3));
        const powder = float(1.0).sub(exp(dens.mul(-4.0)));
        const hgt = clamp(p.y.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE), 0.0, 1.0);
        // sunlit by the time of day's cloud colour; the sky's light on top of that, darker towards the base
        const c = lit.mul(toSun).mul(phase.mul(0.6).add(0.55)).mul(powder.mul(0.4).add(0.6)).add(shade.mul(hgt.mul(0.75).add(0.3)));
        const a = float(1.0).sub(exp(dens.mul(sigma).mul(ds).negate()));
        acc.addAssign(c.mul(a).mul(T));
        T.mulAssign(float(1.0).sub(a));
      });
      t.addAssign(ds);
    });
    // far off the layer thins into the horizon's haze
    const fade = exp(t0.div(-26000.0));
    res.assign(vec4(acc.mul(fade), mix(float(1.0), T, fade)));
  });
  return res;
};

// ---------- the panorama ----------
// u: azimuth (0..1 round from -z through +x); v: elevation, v^1.5 * 90 degrees, so the rows crowd towards the horizon,
// where the clouds are far and small
const fromPano = (uv) => {
  const az = uv.x.sub(0.5).mul(2 * Math.PI), el = pow(uv.y, 1.5).mul(Math.PI / 2);
  return vec3(sin(az).mul(cos(el)), sin(el), cos(az).mul(cos(el)).negate());
};
export const toPano = (d) => vec2(atan(d.x, d.z.negate()).div(2 * Math.PI).add(0.5), pow(asin(clamp(d.y, 0.0, 1.0)).div(Math.PI / 2), 2 / 3));

// The panorama, refreshed a slice of rows per frame (a thirty-second: all of it twice a second): each refresh marches
// from a fresh random start along each ray and is blended with what was there (a share NEW new), so the grain of a
// coarse march averages out over a second or two.
// After a jump (the first frame, a cut of the camera, a jump of the clock or the cover) all of it is redrawn at once.
// size: [width, height]; steps: samples across the layer; sunDir: tsl.js's
export function makeCloudSky(renderer, { size, steps, slices = 32 }, sunDir) {
  const NEW = 0.35;
  const rt = new THREE.RenderTarget(size[0], size[1], { type: THREE.HalfFloatType, depthBuffer: false });
  const pano = rt.texture;
  pano.name = 'CloudSky';
  pano.generateMipmaps = false;
  pano.minFilter = pano.magFilter = THREE.LinearFilter;
  pano.wrapS = THREE.RepeatWrapping;
  const u = { cam: uniform(new THREE.Vector3()), seed: uniform(0), y0: uniform(-1), y1: uniform(1) };
  const mat = new THREE.MeshBasicNodeMaterial({ fog: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  // a band of rows across the whole width
  mat.vertexNode = vec4(positionGeometry.x.mul(2.0), mix(u.y0, u.y1, positionGeometry.y.add(0.5)), 0.5, 1.0);
  mat.colorNode = Fn(() => {
    const jitter = fract1(sin(dot(screenCoordinate.xy.add(u.seed), vec2(12.9898, 78.233))).mul(43758.5453));
    return marchClouds(fromPano(screenUV), u.cam, sunDir, CLOUD.uLit, CLOUD.uShade, steps, jitter);
  })();
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = mat.blendSrcAlpha = THREE.ConstantColorFactor;
  mat.blendDst = mat.blendDstAlpha = THREE.OneMinusConstantColorFactor;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera();
  const last = { cam: new THREE.Vector3(1e9, 0, 0), sun: new THREE.Vector3(), cover: -1 };
  let slice = 0, frame = 0;

  function draw(from, to, k) {
    mat.blendColor.setRGB(k, k, k);
    mat.blendAlpha = k;
    u.y0.value = -1 + (2 * from) / slices; u.y1.value = -1 + (2 * to) / slices;
    u.seed.value = (frame++ % 1024) * 7.31;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    renderer.autoClear = auto;
  }
  return {
    texture: pano,
    // camPos: the camera's position; sun: towards the sun; cover: CLOUD.uCover's value
    update(camPos, sun, cover) {
      u.cam.value.copy(camPos);
      const moved = camPos.distanceTo(last.cam), turned = Math.acos(Math.min(1, sun.dot(last.sun))) * 180 / Math.PI;
      const jumped = moved > 150 || turned > 3 || Math.abs(cover - last.cover) > 0.08;
      if (jumped || last.cover < 0) {
        draw(0, slices, 1);
        slice = 0;
      } else {
        // more of it at a time while things change fast (a time-lapse, the camera flying), so the slices agree
        const n = turned > 0.08 || moved > 4 ? 4 : 1;
        for (let i = 0; i < n; i++) { draw(slice, slice + 1, n > 1 ? 0.6 : NEW); slice = (slice + 1) % slices; }
      }
      last.cam.copy(camPos); last.sun.copy(sun); last.cover = cover;
    },
  };
}

// How much of the sun gets through the clouds to world point p (sunshadow.js): the density on the sun's ray at the
// layer's lower part, the coarse shape only
export const cloudShadowAt = (p, sunDir) => {
  const mid = CLOUD_BASE + (CLOUD_TOP - CLOUD_BASE) * 0.25; // (low in the layer, where the heaps are widest)
  const q = p.add(sunDir.mul(float(mid).sub(p.y).div(max(sunDir.y, 0.12))));
  const dens = cloudDensity(vec3(q.x, mid, q.z), false);
  return exp(dens.mul(-3.0));
};
