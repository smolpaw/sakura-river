// Koi: a few colourful carp cruising just under the river surface near the tree. Their paths run on the CPU (a
// dozen fish); the vertex stage bends the body and tail. The water clears a little above each fish (see water.js),
// as it does over koi near the surface — through the full river depth they would not show.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, mix, sin, cos, abs, attribute, positionGeometry, normalGeometry, transformNormalToView, uniformArray } from 'three/tsl';
import { U, vnoise, sstep, LitMaterial } from './tsl.js';
import { mulberry32 } from './noise.js';

export const KOI_MAX = 12;
const SIZE = 1.5; // body 0.93 m: large koi, readable from the banks

// body along +z (head at +z), 0.62 long: a flattened spindle, a fan tail and two pectoral fins
function koiGeometry() {
  const P = [], N = [], F = [], I = [];
  const ring = 10, rows = 14;
  const prof = (t) => Math.sin(Math.PI * Math.pow(t, 0.8)) * (1 - 0.35 * t); // t: 0 tail .. 1 nose
  for (let j = 0; j <= rows; j++) {
    const t = j / rows, z = -0.3 + t * 0.62, r = 0.075 * prof(t) + 0.006;
    for (let i = 0; i <= ring; i++) {
      const a = (i / ring) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      P.push(c * r, s * r * 0.78, z); N.push(c, s * 1.2, 0); F.push(0);
    }
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < ring; i++) {
    const a = j * (ring + 1) + i, b = a + ring + 1;
    I.push(a, b, a + 1, b, b + 1, a + 1);
  }
  // fins: flat fans (F = 1 marks fin vertices, drawn from both sides)
  const fan = (root, pts) => {
    const base = P.length / 3;
    P.push(...root); N.push(0, 1, 0); F.push(1);
    for (const p of pts) { P.push(...p); N.push(0, 1, 0); F.push(1); }
    for (let k = 1; k < pts.length; k++) I.push(base, base + k, base + k + 1, base, base + k + 1, base + k);
  };
  fan([0, 0.01, -0.29], [[-0.09, 0.0, -0.46], [-0.05, 0.0, -0.44], [0, 0.0, -0.4], [0.05, 0.0, -0.44], [0.09, 0.0, -0.46]]); // tail
  fan([0.05, -0.01, 0.14], [[0.14, -0.02, 0.06], [0.13, -0.02, 0.1], [0.07, -0.01, 0.16]]); // pectoral fins
  fan([-0.05, -0.01, 0.14], [[-0.07, -0.01, 0.16], [-0.13, -0.02, 0.1], [-0.14, -0.02, 0.06]]);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aFin', new THREE.Float32BufferAttribute(F, 1));
  g.setIndex(I);
  return g;
}

// varieties: base, patch, spots colours (linear) and how much patch / spots
const VARIETIES = [
  { base: [0.86, 0.84, 0.8], patch: [0.85, 0.12, 0.02], spot: [0.02, 0.02, 0.02], p: 0.5, s: 0.0 }, // kohaku
  { base: [0.86, 0.84, 0.8], patch: [0.85, 0.14, 0.02], spot: [0.02, 0.02, 0.02], p: 0.45, s: 0.25 }, // sanke
  { base: [0.9, 0.52, 0.06], patch: [1.0, 0.7, 0.2], spot: [0.02, 0.02, 0.02], p: 0.3, s: 0.0 }, // yamabuki (gold)
  { base: [0.03, 0.03, 0.035], patch: [0.85, 0.16, 0.03], spot: [0.86, 0.84, 0.8], p: 0.45, s: 0.3 }, // showa
  { base: [0.85, 0.28, 0.04], patch: [0.95, 0.45, 0.08], spot: [0.02, 0.02, 0.02], p: 0.3, s: 0.2 }, // orange with sumi
];

export function makeKoi(world, count, center) {
  const n = Math.min(count, KOI_MAX);
  const rng = mulberry32(77);
  const fish = [];
  for (let i = 0; i < n; i++) {
    fish.push({
      zc: center.z + (rng() - 0.5) * 50, zA: 4 + rng() * 9, w: 0, ph: rng() * 6.28,
      oc: (rng() - 0.5) * 0.9, oA: 0.1 + rng() * 0.2, w2: 0.05 + rng() * 0.08, ph2: rng() * 6.28,
      y: -0.14 - rng() * 0.1, tail: rng() * 6.28, v: i % VARIETIES.length,
    });
    fish[i].w = (0.25 + rng() * 0.25) / fish[i].zA; // ~0.25-0.5 m/s at mid-stroke
  }
  // per fish: world xz + heading (x, z, dir.x, dir.z) for the water shader; y, heading angle, tail phase, variety
  const state = Array.from({ length: KOI_MAX }, () => new THREE.Vector4(0, -1e4, 0, 1));
  const aPose = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); // x, y, z, heading
  const aLook = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); // tail phase, variety, seed, speed
  const geo = koiGeometry();
  geo.setAttribute('aPose', aPose); geo.setAttribute('aLook', aLook);
  geo.instanceCount = n;
  for (let i = 0; i < n; i++) { aLook.array[i * 4 + 1] = fish[i].v; aLook.array[i * 4 + 2] = rng() * 50; }

  const pose = attribute('aPose', 'vec4'), look = attribute('aLook', 'vec4'), fin = attribute('aFin', 'float');
  // swim: a travelling wave down the body, stronger towards the tail; fins flutter
  const bend = Fn(() => {
    const p = positionGeometry.toVar();
    const back = sstep(0.2, -0.46, p.z); // 0 at the head .. 1 at the tail tip
    p.x.addAssign(sin(look.x.sub(p.z.mul(9.0))).mul(back.mul(back)).mul(float(0.05).add(look.w.mul(0.03))));
    p.y.addAssign(sin(look.x.mul(1.3).add(p.x.mul(20.0))).mul(fin).mul(abs(p.x)).mul(0.25));
    return p;
  });
  const c = cos(pose.w), s = sin(pose.w);
  const rot = (v) => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
  const mat = new LitMaterial({ roughness: 0.42, metalness: 0, side: THREE.DoubleSide });
  mat.positionNode = rot(bend().mul(SIZE)).add(pose.xyz);
  mat.normalNode = transformNormalToView(rot(normalGeometry)).normalize();
  mat.colorNode = Fn(() => {
    const v = look.y, seed = look.z;
    const pick = (k) => {
      let o = vec3(...VARIETIES[0][k]);
      for (let i = 1; i < VARIETIES.length; i++) o = mix(o, vec3(...VARIETIES[i][k]), sstep(i - 0.5, i - 0.49, v));
      return o;
    };
    const amt = (k) => {
      let o = float(VARIETIES[0][k]);
      for (let i = 1; i < VARIETIES.length; i++) o = mix(o, float(VARIETIES[i][k]), sstep(i - 0.5, i - 0.49, v));
      return o;
    };
    const q = positionGeometry;
    const top = sstep(-0.03, 0.02, q.y); // patterns on the back, pale belly
    const pn = vnoise(vec2(q.x.mul(9.0), q.z.mul(7.0)).add(seed));
    const sn = vnoise(vec2(q.x.mul(26.0), q.z.mul(22.0)).add(seed.mul(1.7)));
    const pT = float(1.0).sub(amt('p')), sT = float(1.0).sub(amt('s').mul(0.5));
    const col = pick('base').toVar();
    col.assign(mix(col, pick('patch'), sstep(pT.sub(0.03), pT.add(0.03), pn).mul(top)));
    col.assign(mix(col, pick('spot'), sstep(sT.sub(0.03), sT.add(0.03), sn).mul(top).mul(sstep(0.01, 0.02, amt('s')))));
    col.assign(mix(col, vec3(0.9, 0.88, 0.85), float(1.0).sub(top).mul(0.5))); // belly
    col.assign(mix(col, col.mul(0.6).add(vec3(0.05, 0.08, 0.07)), fin.mul(0.5))); // translucent fins
    return vec4(col.mul(0.85), 1.0); // a little light lost to the water
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.layers.set(1); // not in the reflection or the shadow map

  const dz = 0.5;
  return {
    mesh, state: uniformArray(state, 'vec4'), count: n,
    update(dt, t) {
      for (let i = 0; i < n; i++) {
        const f = fish[i];
        const z = f.zc + f.zA * Math.sin(f.w * t + f.ph);
        const vz = f.zA * f.w * Math.cos(f.w * t + f.ph);
        const hw = world.riverHW(z);
        const o = (f.oc + f.oA * Math.sin(f.w2 * t + f.ph2)) * hw;
        const vo = f.oA * f.w2 * Math.cos(f.w2 * t + f.ph2) * hw;
        const x = world.riverX(z) + o;
        const vx = ((world.riverX(z + dz) - world.riverX(z - dz)) / (2 * dz)) * vz + vo;
        const sp = Math.hypot(vx, vz) + 1e-4;
        const hx = vx / sp, hz = vz / sp;
        f.tail += dt * (4 + sp * 10);
        aPose.array.set([x, f.y + Math.sin(t * 0.7 + f.ph) * 0.02, z, Math.atan2(hx, hz)], i * 4);
        aLook.array[i * 4] = f.tail; aLook.array[i * 4 + 3] = Math.min(1, sp * 2);
        state[i].set(x, z, hx, hz);
      }
      aPose.needsUpdate = true; aLook.needsUpdate = true;
    },
  };
}

// how much the water clears over the koi at world xz (0..1)
export const koiClearing = (state, count) => Fn(([xz]) => {
  let c = float(0);
  for (let i = 0; i < count; i++) {
    const f = state.element(i);
    const d = xz.sub(f.xy);
    const along = d.x.mul(f.z).add(d.y.mul(f.w)).add(0.05 * SIZE), side = d.x.mul(f.w).sub(d.y.mul(f.z));
    c = c.max(along.mul(along).mul(1 / (0.34 * 0.34 * SIZE * SIZE)).add(side.mul(side).mul(1 / (0.12 * 0.12 * SIZE * SIZE))).negate().exp());
  }
  return c;
});
