// Falling petals simulated on the GPU (WebGPU compute), from every cherry: the same flight as petals.js's CPU system
// (wind with gusts and flutter, landing on the grass to wither or on the river to float downstream), so many more of
// them cost the CPU nothing. Each petal's state lives in storage buffers the compute pass updates and the petal
// material reads. The WebGL fallback keeps the CPU system.
import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, uniform, instancedArray, instanceIndex, sin, cos, abs, max, clamp, floor, sign, exp, select,
} from 'three/tsl';
import { U, hash12 } from './tsl.js';
import { mulberry32 } from './noise.js';
import { petalGeometry } from './petals.js';

// the river (world.js riverX, riverHW), as a node of z
const sstepN = (a, b, x) => { const t = clamp(x.sub(a).div(b - a), 0.0, 1.0); return t.mul(t).mul(float(3.0).sub(t.mul(2.0))); };
const riverX = (z) => sin(z.mul(0.021).add(0.9)).mul(8.5).add(sin(z.mul(0.0072).sub(0.35)).mul(20.0)).add(sin(z.mul(0.047).add(2.2)).mul(3.5))
  .sub(4.0).sub(sstepN(150, 262, z).mul(55.0));
const riverHW = (z) => float(7.6).add(sstepN(20, -520, z).mul(3.4 - 7.6));

// trees: [{ spawn: Float64Array (x, y, z in the tree's frame), pos: Vector3, scale, weight }]; groundAt: grass.js's
// terrain sampler; count: petals at the most (setAmount 1)
export function makeGpuPetals(trees, groundAt, count, material) {
  const rng = mulberry32(2024);
  // spawn points over all the cherries, each tree's share by its weight
  const pts = [];
  for (const t of trees) {
    const n = t.spawn.length / 3, take = Math.max(1, Math.round(n * t.weight));
    for (let k = 0; k < take; k++) {
      const i = Math.floor(rng() * n) * 3;
      pts.push(t.pos.x + t.spawn[i] * t.scale, t.pos.y + t.spawn[i + 1] * t.scale, t.pos.z + t.spawn[i + 2] * t.scale, 0);
    }
  }
  const nSp = pts.length / 4;
  const spawn = instancedArray(new Float32Array(pts), 'vec4');
  // state: P (x, y, z, mode 0 air 1 water 2 ground), V (velocity, age), R (yaw, pitch, roll, drawn scale),
  // S (spin, life), K (scale, tint, seed, -)
  const init = { P: new Float32Array(count * 4), V: new Float32Array(count * 4), R: new Float32Array(count * 4), S: new Float32Array(count * 4), K: new Float32Array(count * 4) };
  const wind = new THREE.Vector2(0.62, 0.78).normalize();
  for (let i = 0; i < count; i++) {
    const s = Math.floor(rng() * nSp) * 4, t = rng();
    const y = pts[s + 1] + (rng() - 0.5) * 0.6;
    // pre-warmed: scattered along a fall path, and old enough to be anywhere in their lives
    init.P.set([pts[s] + (rng() - 0.5) * 0.6 + wind.x * t * 12, y - t * (y - 0.5) * 0.9, pts[s + 2] + (rng() - 0.5) * 0.6 + wind.y * t * 12, 0], i * 4);
    init.V.set([0, -0.2, 0, 0.6 + rng() * 10], i * 4);
    init.R.set([rng() * 6.28, rng() * 6.28, rng() * 6.28, 0], i * 4);
    init.S.set([(rng() - 0.5) * 3, (rng() - 0.5) * 6, (rng() - 0.5) * 5, 14 + rng() * 16], i * 4);
    init.K.set([0.75 + rng() * 0.5, rng(), rng() * 100, 0], i * 4);
  }
  const P = instancedArray(init.P, 'vec4'), V = instancedArray(init.V, 'vec4'), R = instancedArray(init.R, 'vec4');
  const S = instancedArray(init.S, 'vec4'), K = instancedArray(init.K, 'vec4');
  const u = { dt: uniform(0), time: uniform(0), wind: uniform(0), river: uniform(1) };

  const step = Fn(() => {
    const i = instanceIndex, fi = float(i);
    const p = P.element(i).toVar(), v = V.element(i).toVar(), r = R.element(i).toVar(), s = S.element(i).toVar(), k = K.element(i);
    const dt = u.dt, t = u.time, w = u.wind;
    const kk = float(1.0).sub(exp(dt.mul(-2.2)));
    v.w.addAssign(dt);
    If(p.w.lessThan(0.5), () => {
      // in the air: towards the wind's speed with gusts, fluttering, falling
      const gust = sin(t.mul(0.31)).mul(sin(t.mul(0.19).add(1.3))).mul(0.45).add(0.55);
      const ws = w.mul(3.2).add(0.25).mul(gust.mul(0.8).add(0.6));
      const tx = U.uWindDir.x.mul(ws).add(sin(t.mul(1.3).add(fi.mul(0.37)).add(p.y.mul(0.8))).mul(0.5).mul(w.add(0.3))).add(sin(t.mul(0.7).add(p.z.mul(0.3))).mul(0.25));
      const tz = U.uWindDir.y.mul(ws).add(cos(t.mul(1.1).add(fi.mul(0.53)).add(p.x.mul(0.6))).mul(0.5).mul(w.add(0.3)));
      const ty = float(-0.55).sub(sin(fi.mul(1.7)).mul(0.25)).add(sin(t.mul(2.3).add(fi)).mul(0.35).mul(w.add(0.2)));
      v.xyz.assign(v.xyz.add(vec3(tx, ty, tz).sub(v.xyz).mul(kk)));
      p.xyz.assign(p.xyz.add(v.xyz.mul(dt)));
      r.xyz.assign(r.xyz.add(s.xyz.mul(dt).mul(w.add(0.6))));
      const g = groundAt(p.xz).x;
      If(p.y.lessThanEqual(max(g, 0.0).add(0.02)), () => {
        const h = hash12(vec2(fi, t.mul(7.3)));
        If(g.lessThan(0.0), () => { p.w.assign(1.0); p.y.assign(0.012); v.w.assign(0.0); s.w.assign(h.mul(15.0).add(25.0)); })
          .Else(() => { p.w.assign(2.0); p.y.assign(g.add(0.03)); v.w.assign(0.0); s.w.assign(h.mul(6.0).add(4.0)); });
      });
    }).ElseIf(p.w.lessThan(1.5), () => {
      // on the river: carried downstream, fastest mid-stream, nudged off the banks
      const rx = riverX(p.z), hw = riverHW(p.z);
      const dx = riverX(p.z.add(0.5)).sub(riverX(p.z.sub(0.5)));
      const fl = vec2(dx, 1.0).normalize();
      const tt = abs(p.x.sub(rx)).div(hw);
      const sp = u.river.mul(1.5).mul(clamp(float(1.0).sub(tt.mul(tt)), 0.08, 1.0));
      p.x.addAssign(fl.x.mul(sp).add(sin(t.mul(0.8).add(fi)).mul(0.05)).mul(dt));
      p.z.addAssign(fl.y.mul(sp).mul(dt));
      If(tt.greaterThan(0.8), () => { p.x.subAssign(sign(p.x.sub(rx)).mul(0.3).mul(dt)); });
      p.y.assign(sin(t.mul(2.0).add(p.x.mul(1.3)).add(p.z)).mul(0.008).add(0.012));
      r.y.mulAssign(float(1.0).sub(kk)); r.z.mulAssign(float(1.0).sub(kk));
      r.x.addAssign(sin(t.mul(0.5).add(fi)).mul(dt).mul(0.3));
      If(p.z.greaterThan(70.0).or(p.z.lessThan(-760.0)), () => { v.w.assign(s.w); });
    }).Else(() => {
      r.y.mulAssign(float(1.0).sub(kk)); r.z.mulAssign(float(1.0).sub(kk));
    });
    // grown in after leaving the tree, shrunk away at the end of its life
    const fadeIn = clamp(v.w.div(0.6), 0.0, 1.0), fadeOut = clamp(s.w.sub(v.w).div(1.5), 0.0, 1.0);
    r.w.assign(k.x.mul(select(p.w.lessThan(0.5), fadeIn, float(1.0))).mul(fadeOut));
    // a new petal from the canopy
    If(v.w.greaterThanEqual(s.w).or(p.y.lessThan(-5.0)).or(abs(p.x).greaterThan(400.0)), () => {
      const h1 = hash12(vec2(fi.add(k.z), t)), h2 = hash12(vec2(t.mul(1.7), fi.mul(0.37).add(k.z)));
      const h3 = hash12(vec2(fi.mul(1.31), t.mul(3.1).add(5.0))), h4 = hash12(vec2(t.add(k.z), fi.mul(2.7)));
      const sp0 = spawn.element(floor(h1.mul(nSp - 0.001)));
      p.assign(vec4(sp0.xyz.add(vec3(h2, h3, h4).sub(0.5).mul(0.6)), 0.0));
      v.assign(vec4(0.0, -0.2, 0.0, 0.0));
      s.w.assign(h2.mul(16.0).add(14.0));
      r.assign(vec4(h3.mul(6.28), h4.mul(6.28), h1.mul(6.28), 0.0));
    });
    P.element(i).assign(p); V.element(i).assign(v); R.element(i).assign(r); S.element(i).assign(s);
  })().compute(count);

  const geo = new THREE.InstancedBufferGeometry();
  const g = petalGeometry();
  geo.index = g.index; geo.attributes.position = g.attributes.position; geo.attributes.normal = g.attributes.normal;
  geo.instanceCount = 0;
  const mesh = new THREE.Mesh(geo, material({ pos: P.element(instanceIndex).xyz, rot: R.element(instanceIndex), tint: K.element(instanceIndex).y }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.layers.set(1);

  let target = 0, active = 0;
  return {
    mesh,
    setAmount(f) { target = Math.floor(Math.min(1, Math.max(0, f)) * count); },
    // (the renderer runs the compute pass; the draw shows the first `active` petals)
    update(renderer, dt, time, windAmt, riverSpeed) {
      if (active < target) active = Math.min(target, active + Math.ceil(count * dt * 0.4));
      else if (active > target) active = target;
      u.dt.value = Math.min(dt, 0.05); u.time.value = time; u.wind.value = windAmt; u.river.value = riverSpeed;
      if (dt > 0) renderer.compute(step);
      geo.instanceCount = active;
    },
  };
}
