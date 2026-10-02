// Volumetric clouds: a layer between CLOUD_BASE and CLOUD_TOP metres, raymarched in the sky's shader through a tiling
// 3D noise painted at start-up (cloudNoise, in a worker). R: Perlin-Worley (the clouds' billowing shapes), G: Worley
// fbm (the detail eroding their edges). The sky's time-of-day palette lights them (uCloudLit, uCloudShade), the cover
// setting thickens them, and the ground's cloud shadows (sunshadow.js) sample the same density, so shadows and
// clouds agree.
import * as THREE from 'three/webgpu';
import { If, Loop, Break, float, vec3, vec4, uniform, clamp, max, min, exp, mix, dot, renderGroup, nodeObject } from 'three/tsl';
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

// shared by the sky and the cloud shadows: the drift (sky.js uCloud), cover 0..1
export const CLOUD = {
  uDrift: uniform(new THREE.Vector2()).setGroup(renderGroup),
  uCover: uniform(0.35).setGroup(renderGroup),
};

const sstepT = (a, b, x) => { const t = clamp(x.sub(a).div(float(b).sub(a)), 0.0, 1.0); return t.mul(t).mul(float(3.0).sub(t.mul(2.0))); };

// the cloud's density at world point p (y up); `detail`: erode the edges with the detail noise
export const cloudDensity = (p, detail = true) => {
  const drift = vec3(CLOUD.uDrift.x, 0.0, CLOUD.uDrift.y).mul(1000.0);
  const q = p.add(drift);
  const hgt = clamp(p.y.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE), 0.0, 1.0);
  // flat bases, rounded tops; the overcast's layer fills more of the slab
  const profile = sstepT(0.0, 0.08, hgt).mul(sstepT(1.0, mix(float(0.45), float(0.8), CLOUD.uCover), hgt));
  const shape = look(q.div(SHAPE).xzy).r;
  // (fair-weather cumulus at the clear preset's 0.35, a closed deck at 1)
  const cov = mix(float(0.05), float(0.95), CLOUD.uCover.mul(CLOUD.uCover).mul(0.4).add(CLOUD.uCover.mul(0.6)));
  const base = clamp(shape.mul(profile).sub(float(1.0).sub(cov)).div(max(cov, 0.05)), 0.0, 1.0).toVar();
  if (!detail) return base;
  const d = look(q.add(drift.mul(0.5)).div(DETAIL).xzy).g;
  // detail eats the thin edges, wispy at the tops
  return clamp(base.sub(d.mul(0.38).mul(float(1.0).sub(base)).mul(hgt.mul(0.6).add(0.7))).div(0.7), 0.0, 1.0);
};

// March the layer along the view ray d from the camera at height camY (the sky dome sits at the camera) ->
// vec4(light scattered towards the camera, transmittance). steps: samples across the layer.
export const marchClouds = (d, camY, sunDir, lit, shade, steps, jitter) => {
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
    // density -> extinction per metre: thick cumulus go opaque over a few hundred metres
    const sigma = float(1 / 90);
    Loop(steps, () => {
      If(T.lessThan(0.02).or(t.greaterThan(far)), () => { Break(); });
      const p = d.mul(t).add(vec3(0.0, camY, 0.0)).toVar();
      const dens = cloudDensity(p).toVar();
      If(dens.greaterThan(0.002), () => {
        // the sun's light through the cloud above this point: three samples towards it, coarse shape only
        const ls = float(0.0).toVar();
        for (const k of [60, 180, 400]) ls.addAssign(cloudDensity(p.add(sunDir.mul(k)), false));
        const toSun = exp(ls.mul(sigma).mul(-150.0));
        const powder = float(1.0).sub(exp(dens.mul(-6.0)));
        const hgt = clamp(p.y.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE), 0.0, 1.0);
        // sunlit by the time of day's cloud colour, the shaded side its shade colour, darker towards the base
        const c = mix(shade.mul(hgt.mul(0.6).add(0.55)), lit.mul(phase.mul(0.6).add(0.75)), toSun.mul(powder.mul(0.5).add(0.5)));
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

// How much of the sun gets through the clouds to world point p (sunshadow.js): the density on the sun's ray at the
// layer's middle, the coarse shape only
export const cloudShadowAt = (p, sunDir) => {
  const mid = (CLOUD_BASE + CLOUD_TOP) / 2;
  const q = p.add(sunDir.mul(float(mid).sub(p.y).div(max(sunDir.y, 0.12))));
  const dens = cloudDensity(vec3(q.x, mid, q.z), false);
  return exp(dens.mul(-3.0));
};
