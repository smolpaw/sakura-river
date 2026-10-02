// Clouds. The cumulus round the horizon are pictures (impostors, like the woods' far trees): a few dozen cards turned to
// the camera, showing cumulus baked at start-up by raymarching real 3D shapes (puffs eroded by a tiling 3D noise). Each
// picture holds the light that reaches the cloud from six directions (six-way lighting, as for game smoke), so the
// card is lit by the sun from wherever it stands: bright tops at noon, pink undersides after sunset, silver edges
// against the sun. The sky right overhead is the same noise as a flat layer (sky.js), and the ground's cloud shadows
// (sunshadow.js) sample that noise too, so the clouds above the valley and their shadows agree.
//
// The noise: 64^3, painted in a worker (cloudNoise). R: Perlin-Worley (billowing shapes), G: Worley fbm (detail).
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, float, vec2, vec3, vec4, uniform, uniformArray, attribute, varyingProperty, texture, uv, clamp, max, min, exp, mix, dot, abs,
  length, normalize, cross, floor, pow, renderGroup, nodeObject, cameraPosition, positionGeometry, positionWorld,
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

// The layer right overhead, seen from below (the cards keep to the horizon): its density where the view ray d from
// the camera at cam meets the layer's middle -> vec4(light, coverage), faded out towards the horizon
export const cloudsAbove = (d, cam, sunDir, lit, shade) => {
  const res = vec4(0.0).toVar();
  If(d.y.greaterThan(0.3), () => {
    const mid = (CLOUD_BASE + CLOUD_TOP) / 2;
    const p = cam.add(d.mul(float(mid).sub(cam.y).div(d.y)));
    const dens = cloudDensity(vec3(p.x, mid, p.z)).toVar();
    // thin parts let the sun through, the thick ones show their grey bases; brightest towards the sun
    const mu = max(dot(d, sunDir), 0.0);
    const thin = float(1.0).sub(sstepT(0.05, 0.6, dens));
    const c = mix(shade.mul(1.15), lit.mul(float(0.55).add(pow(mu, 8.0).mul(0.8))), thin.mul(0.7).add(0.15));
    const a = sstepT(0.0, 0.25, dens).mul(sstepT(0.3, 0.55, d.y));
    res.assign(vec4(c.mul(a), a));
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

// ---------- the cumulus pictures ----------
// Each kind is a picture of S x S/2 pixels (a cloud box 2 wide, 1 tall, its flat base at the bottom), in a COLS x ROWS
// atlas. Two atlases: A holds the light from +x, -x, +y, -y (the picture's right, left, up, down), B the light from
// the front (+z, the camera's side) and the back (-z, through the cloud), the sky's light from above, and coverage.
// All premultiplied by coverage (0 outside), so mip filtering leaves no fringe and the card blends them as they are.
const COLS = 4, ROWS = 4, KINDS = COLS * ROWS, MAXP = 16;
const SIGMA = 42; // extinction per unit of the box at density 1 (the box: ~2 km wide, so opaque in ~25 m)

// the puffs of kind k (x, y, z, radius in the box's units), by type: cumulus mediocris, humilis (flat), congestus
// (towers), fractus (rags)
function puffs(k) {
  const rng = mulberry32(911 + k * 131), r = (a, b) => a + rng() * (b - a), out = [];
  const add = (x, y, z, rad) => {
    rad = Math.min(rad, 0.9 - Math.abs(x), 0.92 - y);
    if (rad > 0.02 && out.length < MAXP) out.push([x, Math.max(y, rad * 0.25), Math.max(-0.6 + rad, Math.min(0.6 - rad, z)), rad]);
  };
  const tops = (n, f) => {
    for (let i = 0; i < n && out.length < MAXP; i++) {
      const p = out[Math.floor(rng() * out.length)];
      add(p[0] + r(-0.5, 0.5) * p[3], p[1] + p[3] * r(0.45, 0.7), p[2] + r(-0.3, 0.3) * p[3], p[3] * r(f[0], f[1]));
    }
  };
  const type = k < 6 ? 0 : k < 10 ? 1 : k < 13 ? 2 : 3;
  if (type === 0) {
    const span = r(0.55, 0.7), n = 7 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) { const x = r(-span, span), rad = 0.27 * (1 - 0.5 * Math.abs(x) / span) + r(0, 0.08); add(x, rad * 0.45, r(-0.2, 0.2), rad); }
    tops(6, [0.5, 0.72]);
  } else if (type === 1) {
    const span = r(0.62, 0.75), n = 10 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) { const x = r(-span, span), rad = r(0.13, 0.21) * (1 - 0.4 * Math.abs(x) / span); add(x, rad * 0.35, r(-0.22, 0.22), rad); }
    tops(3, [0.45, 0.65]);
  } else if (type === 2) {
    const n = 4;
    for (let i = 0; i < n; i++) { const x = r(-0.4, 0.4), rad = r(0.18, 0.24); add(x, rad * 0.5, r(-0.15, 0.15), rad); }
    // a tower or two climbing out of the base
    for (let t = 0; t < 2; t++) {
      let x = r(-0.25, 0.25), y = 0.3, rad = r(0.2, 0.24);
      for (let i = 0; i < 4; i++) { add(x, y, r(-0.1, 0.1), rad); y += rad * r(0.75, 0.95); x += r(-0.08, 0.08); rad *= r(0.78, 0.9); }
    }
    tops(2, [0.5, 0.7]);
  } else {
    const n = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) add(r(-0.65, 0.65), r(0.08, 0.25), r(-0.2, 0.2), r(0.08, 0.17));
  }
  return out;
}

// Bake every kind into the atlases (cell: S, the picture's width in pixels). One draw per atlas; each texel
// marches its column of the box front to back, and from each sample marches towards the four side lights.
export function bakeClouds(renderer, S) {
  const CW = S, CH = S / 2, W = COLS * CW, H = ROWS * CH;
  const target = () => {
    const rt = new THREE.RenderTarget(W, H, { depthBuffer: false });
    const t = rt.texture;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.matrixAutoUpdate = false;
    return rt;
  };
  const A = target(), B = target();
  A.texture.name = 'CloudLightA'; B.texture.name = 'CloudLightB';

  // every kind's puffs, and per kind: the noise's offset, how ragged
  const P = [], K = [];
  for (let k = 0; k < KINDS; k++) {
    const ps = puffs(k);
    for (let i = 0; i < MAXP; i++) P.push(ps[i] ? new THREE.Vector4(...ps[i]) : new THREE.Vector4(0, -9, 0, 0.01));
    K.push(new THREE.Vector4(k * 3.17, k >= 13 ? 1 : 0, 0, 0));
  }
  const uP = uniformArray(P, 'vec4'), uK = uniformArray(K, 'vec4');
  // the box's signed distance (negative inside): the puffs, smoothly joined, roughened by the shape noise and
  // billowed by the detail noise, cut flat at the base -> density
  const density = (fine) => Fn(([p, kind]) => {
    const sd = float(9.0).toVar();
    const kk = uK.element(kind);
    // (loop variables named apart: these are inlined into the march's loops)
    Loop({ start: 0, end: MAXP, type: 'int', name: 'puff' }, ({ puff }) => {
      const s = uP.element(kind.mul(MAXP).add(puff));
      const d = length(p.sub(s.xyz)).sub(s.w);
      const h = max(float(0.09).sub(abs(sd.sub(d))), 0.0).div(0.09);
      sd.assign(min(sd, d).sub(h.mul(h).mul(0.09 * 0.25)));
    });
    const q = p.add(vec3(kk.x, kk.x.mul(0.37), kk.x.mul(0.71))).toVar();
    sd.addAssign(look(q.mul(0.55)).r.sub(0.5).mul(float(0.14).add(kk.y.mul(0.12))));
    if (fine) sd.subAssign(look(q.mul(2.1)).g.sub(0.55).mul(0.07));
    // the base: flat, a little ragged
    sd.assign(max(sd, float(0.03).sub(p.y).add(look(q.mul(1.3)).g.sub(0.5).mul(0.03))));
    return clamp(sd.negate().div(0.035), 0.0, 1.0).mul(float(1.0).sub(kk.y.mul(0.4)));
  });
  const densF = density(true), densC = density(false);
  // the light that gets through optical depth tau, with a share of multiple scattering (softer, deeper)
  const ms = (tau) => max(exp(tau.negate()), exp(tau.mul(-0.07)).mul(0.6));
  // optical depth from p towards dir: six samples, ever longer steps
  const SEG = [0.02, 0.035, 0.06, 0.1, 0.17, 0.3];
  const toward = (p, kind, dir) => {
    let tau = float(0.0), t = 0;
    SEG.forEach((len, i) => {
      t += len / 2;
      tau = tau.add((i < 3 ? densF : densC)(p.add(dir.mul(t)), kind).mul(len));
      t += len / 2;
    });
    return tau.mul(SIGMA);
  };
  const STEPS = 56, Z0 = 0.62, DZ = (2 * Z0) / STEPS;
  const bake = (pass) => Fn(() => {
    // the texel's cell (from the atlas's top left, as the sampling expects) and its point in the cell's box
    const px = uv().x.mul(COLS), py = float(1.0).sub(uv().y).mul(ROWS);
    const kind = floor(py).mul(COLS).add(floor(px)).toInt().toVar();
    const x = px.sub(floor(px)).mul(2.0).sub(1.0), y = float(1.0).sub(py.sub(floor(py)));
    // the column's whole optical depth (for the light from behind)
    const total = float(0.0).toVar();
    Loop({ start: 0, end: STEPS, type: 'int', name: 'zi' }, ({ zi }) => { total.addAssign(densF(vec3(x, y, float(Z0 - DZ / 2).sub(float(zi).mul(DZ))), kind)); });
    total.mulAssign(SIGMA * DZ);
    const T = float(1.0).toVar(), front = float(0.0).toVar(), acc = vec4(0.0).toVar(), acc2 = vec3(0.0).toVar();
    If(total.greaterThan(0.01), () => {
      Loop({ start: 0, end: STEPS, type: 'int', name: 'zj' }, ({ zj }) => {
        const p = vec3(x, y, float(Z0 - DZ / 2).sub(float(zj).mul(DZ))).toVar();
        const d = densF(p, kind).toVar();
        If(d.greaterThan(0.004), () => {
          const tau = d.mul(SIGMA * DZ);
          const a = float(1.0).sub(exp(tau.negate()));
          const w = T.mul(a).toVar();
          const mid = front.add(tau.mul(0.5));
          if (pass === 0) {
            acc.addAssign(vec4(ms(toward(p, kind, vec3(1, 0, 0))), ms(toward(p, kind, vec3(-1, 0, 0))), ms(toward(p, kind, vec3(0, 1, 0))), ms(toward(p, kind, vec3(0, -1, 0)))).mul(w));
          } else {
            // the sky's light: from above, less of it under the cloud
            const up = toward(p, kind, vec3(0, 1, 0));
            acc2.addAssign(vec3(ms(mid), ms(total.sub(mid)), exp(up.mul(-0.08)).mul(0.65).add(0.35)).mul(w));
          }
          T.mulAssign(float(1.0).sub(a));
          front.addAssign(tau);
        });
        If(T.lessThan(0.004), () => { Break(); });
      });
    });
    return pass === 0 ? acc : vec4(acc2, float(1.0).sub(T));
  })();

  // one draw per atlas, over all of it
  const mats = [0, 1].map((pass) => {
    const m = new THREE.MeshBasicNodeMaterial({ fog: false, depthTest: false, depthWrite: false, blending: THREE.NoBlending, side: THREE.DoubleSide });
    m.vertexNode = vec4(positionGeometry.xy, 0.5, 1.0);
    m.colorNode = bake(pass);
    return m;
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mats[0]);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera();
  const prev = { target: renderer.getRenderTarget(), auto: renderer.autoClear };
  renderer.autoClear = false;
  for (const [pass, rt] of [[0, A], [1, B]]) {
    renderer.setRenderTarget(rt);
    quad.material = mats[pass];
    renderer.render(scene, cam);
  }
  renderer.setRenderTarget(prev.target);
  renderer.autoClear = prev.auto;
  for (const m of mats) m.dispose();
  quad.geometry.dispose();
  return { A: A.texture, B: B.texture, targets: [A, B], CW, CH, W, H };
}

// the clouds drift through squares round the valley, wrapping round: most in a near one, the rest in a far ring
// towards the horizon (beyond the near square's reach)
const SPREAD = 26000, FAR_SPREAD = 64000, FAR_FROM = 11000;
const R_DRAW = 6400; // where the cards are drawn: inside the sky's dome (scaled about the camera, so seen the same)

// The cards: `count` cumulus scattered over the square, drifting with the clouds' noise. sky: the sky's uniforms (its
// palette); U: tsl.js's (the sun, lightning). update() each frame sorts them far to near and uploads them.
export function makeClouds(bake, count, sky, U) {
  const rng = mulberry32(4711);
  const clouds = [];
  for (let i = 0; i < count; i++) {
    const far = i >= count * 0.65, span = far ? FAR_SPREAD : SPREAD;
    const u = rng();
    const kind = u < 0.42 ? Math.floor(rng() * 6) : u < 0.72 ? 6 + Math.floor(rng() * 4) : u < 0.84 ? 10 + Math.floor(rng() * 3) : 13 + Math.floor(rng() * 3);
    clouds.push({
      x: (rng() - 0.5) * span, z: (rng() - 0.5) * span, y: 1500 + (rng() - 0.5) * 160, span, from: far ? FAR_FROM : 2600,
      w: (kind >= 13 ? 800 : 1600) + rng() * (kind >= 13 ? 800 : 2400), kind, flip: rng() < 0.5 ? -1 : 1,
      rank: rng(), px: 0, pz: 0, fade: 0, d: 0,
    });
  }
  const data = new Float32Array(count * 8);
  const ib = new THREE.InstancedInterleavedBuffer(data, 8).setUsage(THREE.DynamicDrawUsage);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aPos', new THREE.InterleavedBufferAttribute(ib, 4, 0));
  geo.setAttribute('aMeta', new THREE.InterleavedBufferAttribute(ib, 4, 4));
  geo.instanceCount = 0;

  const pos = attribute('aPos', 'vec4'), meta = attribute('aMeta', 'vec4');
  const uSunK = uniform(1);
  const vSun = varyingProperty('vec3', 'vCloudSun'), vCell = varyingProperty('vec4', 'vCloudCell');
  const position = Fn(() => {
    const rel = pos.xyz.sub(cameraPosition).toVar();
    const dist = length(rel).toVar();
    const fwd = rel.div(dist).negate().toVar(); // towards the camera
    const right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd)).toVar(), up = cross(fwd, right).toVar();
    const flip = meta.y;
    // the sun in the picture's frame (mirrored with the picture)
    vSun.assign(vec3(dot(U.uSunDir, right).mul(flip), dot(U.uSunDir, up), dot(U.uSunDir, fwd)));
    const k = meta.x;
    const qx = positionGeometry.x.mul(flip).mul(0.5).add(0.5);
    vCell.assign(vec4(k.sub(floor(k.div(COLS)).mul(COLS)).add(qx), floor(k.div(COLS)).add(float(1.0).sub(positionGeometry.y)), dist, meta.z));
    const off = right.mul(positionGeometry.x).add(up.mul(positionGeometry.y)).mul(pos.w.mul(0.5));
    return cameraPosition.add(rel.add(off).mul(float(R_DRAW).div(dist)));
  })();

  const shade = Fn(() => {
    const at = vec2(vCell.x, vCell.y).mul(vec2(bake.CW, bake.CH)).div(vec2(bake.W, bake.H));
    const a = texture(bake.A, at), b = texture(bake.B, at).toVar();
    const s = vSun;
    const sq = (v) => max(v, 0.0).mul(max(v, 0.0));
    const mu = dot(normalize(positionWorld.sub(cameraPosition)), U.uSunDir);
    // against the sun, the light through the cloud is scattered forward: thin edges shine (silver linings)
    const forward = pow(max(mu, 0.0), 6.0).mul(2.2).add(0.6);
    const sun = a.x.mul(sq(s.x)).add(a.y.mul(sq(s.x.negate()))).add(a.z.mul(sq(s.y))).add(a.w.mul(sq(s.y.negate())))
      .add(b.x.mul(sq(s.z))).add(b.y.mul(sq(s.z.negate())).mul(forward));
    // (under a closing deck the sun no longer reaches them)
    const col = sky.uCloudLit.mul(sun.mul(uSunK)).add(sky.uCloudShade.mul(b.z)).toVar();
    // lightning lights them from inside
    col.addAssign(vec3(0.5, 0.55, 0.75).mul(U.uFlash.mul(0.8)).mul(b.w));
    // far off they fade into the horizon's haze
    const haze = float(1.0).sub(exp(vCell.z.div(-21000.0)));
    const alpha = b.w.mul(vCell.w).mul(float(1.0).sub(haze.mul(0.35)));
    return vec4(mix(col, sky.uHorizon.mul(b.w), haze.mul(0.8)).mul(vCell.w), alpha);
  })();
  const mat = new THREE.MeshBasicNodeMaterial({ fog: false, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  mat.positionNode = position;
  mat.colorNode = shade;
  // premultiplied: the light added, the sky behind dimmed by coverage
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDst = mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -9; // after the sky, before anything else see-through
  mesh.name = 'clouds';

  const sstepJ = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const wrap = (v, span) => v - span * Math.floor(v / span + 0.5);
  const order = [];
  return {
    mesh, bake,
    // camera: its position; drift: CLOUD.uDrift's value (the noise's offset, km); cover 0..1
    update(camPos, drift, cover) {
      // more of them and bigger as the cover thickens
      const shown = Math.min(1, 0.2 + cover * 1.1), grow = 0.85 + 0.55 * sstepJ(0.3, 0.85, cover);
      uSunK.value = 1 - 0.85 * sstepJ(0.55, 0.95, cover);
      order.length = 0;
      for (const c of clouds) {
        c.px = wrap(c.x - drift.x * 1000, c.span); c.pz = wrap(c.z - drift.y * 1000, c.span);
        const hd = Math.hypot(c.px - camPos.x, c.pz - camPos.z);
        // not overhead (the sky's flat layer is), not where they wrap round
        c.fade = sstepJ(c.rank - 0.04, c.rank + 0.04, shown) * sstepJ(c.from, c.from + 2000, hd)
          * sstepJ(c.span / 2, c.span / 2 - 3000, Math.max(Math.abs(c.px), Math.abs(c.pz)));
        if (c.fade <= 0.002) continue;
        c.d = hd;
        order.push(c);
      }
      order.sort((p, q) => q.d - p.d);
      for (let i = 0; i < order.length; i++) {
        const c = order[i], o = i * 8;
        data[o] = c.px; data[o + 1] = c.y; data[o + 2] = c.pz; data[o + 3] = c.w * grow;
        data[o + 4] = c.kind; data[o + 5] = c.flip; data[o + 6] = c.fade; data[o + 7] = 0;
      }
      geo.instanceCount = order.length;
      ib.needsUpdate = true;
    },
  };
}
