// Drifting petals (CPU-simulated, GPU instanced), the fallen petals under the tree and the rafts on the water; the
// material comes from fx.js
import * as THREE from 'three';
import { mulberry32, makeNoise, clamp, lerp, smoothstep } from './noise.js';

// A petal lying flat: its pitch (rot.y) a quarter turn, face up or face down (the petal is drawn in its xy plane).
export const FLAT = Math.PI / 2;

export function petalGeometry() {
  // cherry petal: rounded with a notch, gently cupped
  const s = new THREE.Shape();
  const L = 1, W = 0.62;
  s.moveTo(0, 0);
  s.bezierCurveTo(W * 0.9, L * 0.2, W * 1.0, L * 0.78, W * 0.3, L);
  s.quadraticCurveTo(0, L * 0.84, -W * 0.3, L);
  s.bezierCurveTo(-W * 1.0, L * 0.78, -W * 0.9, L * 0.2, 0, 0);
  const g = new THREE.ShapeGeometry(s, 6);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setXYZ(i, x, y - 0.5, 0.35 * x * x - 0.12 * (y - 0.5) * (y - 0.5));
  }
  g.computeVertexNormals();
  g.scale(0.1, 0.1, 0.1);
  return g;
}

// the nearest pitch at which a petal lies flat, face up or down, to a petal's pitch p
const toFlat = (p) => FLAT + Math.round((p - FLAT) / Math.PI) * Math.PI;

export class PetalSystem {
  constructor(world, spawnPoints, max, material, windDir) {
    this.isPetalSystem = true;
    this.windDir = windDir;
    this.world = world; this.spawn = spawnPoints; this.max = max;
    this.rng = mulberry32(2024);
    const g = petalGeometry();
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = g.index; ig.attributes.position = g.attributes.position; ig.attributes.normal = g.attributes.normal;
    this.pos = new Float32Array(max * 3); this.rot = new Float32Array(max * 4); this.tint = new Float32Array(max);
    this.lie = new Float32Array(max); // 1 lying on the grass or the water (fx.js petalMaterial lights it as the ground)
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.InstancedBufferAttribute(this.rot, 4).setUsage(THREE.DynamicDrawUsage);
    this.aLie = new THREE.InstancedBufferAttribute(this.lie, 1).setUsage(THREE.DynamicDrawUsage);
    ig.setAttribute('iPos', this.aPos); ig.setAttribute('iRot', this.aRot); ig.setAttribute('iLie', this.aLie);
    ig.setAttribute('iTint', new THREE.InstancedBufferAttribute(this.tint, 1));
    ig.instanceCount = 0;
    this.geo = ig;
    this.mesh = new THREE.Mesh(ig, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.layers.set(1);
    // state
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.mode = new Uint8Array(max); // 0 air, 1 water, 2 ground
    this.spin = new Float32Array(max * 3);
    this.scale = new Float32Array(max);
    this.active = 0;
    this.target = Math.floor(max * 0.5);
    for (let i = 0; i < max; i++) { this.tint[i] = this.rng(); this.respawn(i, true); }
  }
  setAmount(f) { this.target = Math.floor(clamp(f, 0, 1) * this.max); }
  respawn(i, initial = false) {
    const r = this.rng;
    // every petal leaves from the canopy
    const s = this.spawn[Math.floor(r() * this.spawn.length)];
    let x = s.x + (r() - 0.5) * 0.6, y = s.y + (r() - 0.5) * 0.6, z = s.z + (r() - 0.5) * 0.6;
    if (initial) {
      // pre-warm: scatter along a plausible fall path
      const t = r();
      x += this.windDir.x * t * 12; z += this.windDir.y * t * 12; y -= t * (y - 0.5) * 0.9;
    }
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = 0; this.vel[i * 3 + 1] = -0.2; this.vel[i * 3 + 2] = 0;
    this.age[i] = 0; this.life[i] = 14 + r() * 16; this.mode[i] = 0; this.lie[i] = 0;
    this.rot[i * 4] = r() * 6.28; this.rot[i * 4 + 1] = r() * 6.28; this.rot[i * 4 + 2] = r() * 6.28;
    this.spin[i * 3] = (r() - 0.5) * 3; this.spin[i * 3 + 1] = (r() - 0.5) * 6; this.spin[i * 3 + 2] = (r() - 0.5) * 5;
    this.scale[i] = 0.75 + r() * 0.5;
    this.rot[i * 4 + 3] = 0;
  }
  update(dt, time, wind, riverSpeed) {
    // ramp active count toward target smoothly
    if (this.active < this.target) this.active = Math.min(this.target, this.active + Math.ceil(this.max * dt * 0.4));
    else if (this.active > this.target) this.active = this.target;
    const W = this.windDir;
    const world = this.world;
    const k = 1 - Math.exp(-dt * 2.2);
    const gust = 0.55 + 0.45 * Math.sin(time * 0.31) * Math.sin(time * 0.19 + 1.3);
    const ws = (0.25 + wind * 3.2) * (0.6 + gust * 0.8);
    for (let i = 0; i < this.active; i++) {
      const i3 = i * 3, i4 = i * 4;
      let x = this.pos[i3], y = this.pos[i3 + 1], z = this.pos[i3 + 2];
      this.age[i] += dt;
      const mode = this.mode[i];
      let sc = this.scale[i];
      const a = this.age[i], life = this.life[i];
      if (mode === 0) {
        const tx = W.x * ws + Math.sin(time * 1.3 + i * 0.37 + y * 0.8) * 0.5 * (0.3 + wind) + Math.sin(time * 0.7 + z * 0.3) * 0.25;
        const tz = W.y * ws + Math.cos(time * 1.1 + i * 0.53 + x * 0.6) * 0.5 * (0.3 + wind);
        const ty = -0.55 - 0.25 * Math.sin(i * 1.7) + Math.sin(time * 2.3 + i) * 0.35 * (0.2 + wind);
        this.vel[i3] += (tx - this.vel[i3]) * k;
        this.vel[i3 + 1] += (ty - this.vel[i3 + 1]) * k;
        this.vel[i3 + 2] += (tz - this.vel[i3 + 2]) * k;
        x += this.vel[i3] * dt; y += this.vel[i3 + 1] * dt; z += this.vel[i3 + 2] * dt;
        const spinK = 0.6 + wind;
        this.rot[i4] += this.spin[i3] * dt * spinK;
        this.rot[i4 + 1] += this.spin[i3 + 1] * dt * spinK;
        this.rot[i4 + 2] += this.spin[i3 + 2] * dt * spinK;
        const g = world.heightFast(x, z);
        if (y <= Math.max(g, 0) + 0.02) {
          if (g < 0) { this.mode[i] = 1; y = 0.012; this.age[i] = 0; this.life[i] = 25 + this.rng() * 15; }
          else { this.mode[i] = 2; y = g + 0.012; this.age[i] = 0; this.life[i] = 4 + this.rng() * 6; }
        }
      } else if (mode === 1) {
        // floating downstream
        const ri = world.riverInfo(x, z);
        const [fx, fz] = world.flowDir(z);
        const sp = riverSpeed * 1.5 * clamp(1 - ri.t * ri.t, 0.08, 1);
        x += (fx * sp + Math.sin(time * 0.8 + i) * 0.05) * dt;
        z += fz * sp * dt;
        // drift back toward centre if stranded
        if (ri.t > 0.8) x -= Math.sign(ri.d) * 0.3 * dt;
        y = 0.012 + Math.sin(time * 2 + x * 1.3 + z) * 0.008;
        this.rot[i4 + 1] += (toFlat(this.rot[i4 + 1]) - this.rot[i4 + 1]) * k;
        this.lie[i] = Math.min(1, a / 0.6);
        this.rot[i4] += Math.sin(time * 0.5 + i) * dt * 0.3;
        if (z > 70 || z < -760) this.age[i] = life;
      } else {
        this.rot[i4 + 1] += (toFlat(this.rot[i4 + 1]) - this.rot[i4 + 1]) * k;
        this.lie[i] = Math.min(1, a / 0.6);
      }
      // scale in/out
      const fadeIn = clamp(this.age[i] / 0.6, 0, 1);
      const fadeOut = clamp((this.life[i] - this.age[i]) / 1.5, 0, 1);
      this.rot[i4 + 3] = sc * (mode === 0 ? fadeIn : 1) * fadeOut;
      this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
      if (this.age[i] >= this.life[i] || y < -5 || Math.abs(x) > 400) this.respawn(i);
    }
    this.geo.instanceCount = this.active;
    this.aPos.needsUpdate = true; this.aRot.needsUpdate = true; this.aLie.needsUpdate = true;
    this.aPos.clearUpdateRanges(); this.aPos.addUpdateRange(0, this.active * 3);
    this.aRot.clearUpdateRanges(); this.aRot.addUpdateRange(0, this.active * 4);
    this.aLie.clearUpdateRanges(); this.aLie.addUpdateRange(0, this.active);
  }
}

// The petals lying under the tree: in drifts where wind and obstacles leave them, and a thin scatter between. Piled
// against the root flare (most on its lee side), along the lane's verges with a few on its bare earth, at the
// water's edge, in the lee of the stones round the roots and in the ground's hollows; the scatter under the crown and
// downwind of it. They lie on the ground, flat or propped on a blade at an angle, so the grass hides all but those on
// the short lawn, the lane and the bank; a few are caught up in the blades. Sizes vary (the small ones curled or half
// hidden). center: the trunk; avoid(x, z): no petals (the trunk itself); lawn(x, z): 0 short grass .. 1 tall;
// stones: [{ x, z, r }]; wind: [x, z] the prevailing wind (towards).
const DRIFTS = { root: 0.3, lane: 0.16, bank: 0.12, stones: 0.08, hollows: 0.08, scatter: 0.26 }; // shares of the petals
export function fallenData(world, center, count, { avoid, lawn, stones = [], wind = [0.62, 0.78] }) {
  const rng = mulberry32(88), nz = makeNoise(89);
  const wl = Math.hypot(wind[0], wind[1]), wx = wind[0] / wl, wz = wind[1] / wl;
  const pos = new Float32Array(count * 3), rot = new Float32Array(count * 4), tint = new Float32Array(count);
  const near = stones.filter((s) => Math.hypot(s.x - center.x, s.z - center.z) < 16);
  // as far as the wind carries them along the ground, downwind of the crown (1 .. 0)
  const reach = (x, z) => smoothstep(18, 9, Math.hypot(x - center.x - wx * 2, z - center.z - wz * 2));
  // drifts in patches with gaps between (0.15 .. 1)
  const patchy = (x, z) => clamp(0.55 + 0.9 * nz.noise2(x * 0.55, z * 0.55), 0.15, 1);
  const curv = (x, z, y) => (world.height(x + 0.8, z) + world.height(x - 0.8, z) + world.height(x, z + 0.8) + world.height(x, z - 0.8) - 4 * y) / 0.64;
  // a point under or downwind of the crown
  const under = (R) => { const r = Math.sqrt(rng()) * R, a = rng() * 6.28; return [center.x + wx * 2 + Math.cos(a) * r, center.z + wz * 2 + Math.sin(a) * r]; };
  // each kind of place: a candidate point and how likely a petal is to lie there (0..1)
  const sites = {
    root: () => {
      const a = rng() * 6.28, r = Math.max(1.15, 1.7 + (rng() + rng() + rng() - 1.5) * 0.6), x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
      return [x, z, (0.55 + 0.45 * (Math.cos(a) * wx + Math.sin(a) * wz)) * patchy(x, z)];
    },
    lane: () => {
      const [x, z] = under(17), ld = world.laneDist(x, z);
      return [x, z, ld > 3 ? 0 : reach(x, z) * (ld < 1.1 ? 0.06 : Math.exp(-(((ld - 1.5) / 0.3) ** 2))) * patchy(x, z)];
    },
    bank: () => { const [x, z] = under(17); return [x, z, reach(x, z) * Math.exp(-(((world.riverInfo(x, z).t - 1.06) / 0.06) ** 2)) * patchy(x, z)]; },
    stones: () => {
      if (!near.length) return [0, 0, 0];
      const s = near[Math.floor(rng() * near.length)], a = rng() * 6.28, r = s.r + 0.1 + rng() * 0.6, x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
      return [x, z, reach(x, z) * Math.max(0, Math.cos(a) * wx + Math.sin(a) * wz)];
    },
    hollows: () => { const [x, z] = under(12); return [x, z, smoothstep(0.15, 0.45, curv(x, z, world.height(x, z))) * patchy(x, z)]; },
    scatter: () => { const [x, z] = under(14); return [x, z, smoothstep(14, 5, Math.hypot(x - center.x - wx * 2.5, z - center.z - wz * 2.5))]; },
  };
  let n = 0;
  for (const [kind, share] of Object.entries(DRIFTS)) {
    const end = Math.min(count, n + Math.round(count * share)), site = sites[kind];
    for (let tries = 0; n < end && tries < count * 40; tries++) {
      const [x, z, w] = site();
      if (rng() > w) continue;
      const y = world.height(x, z);
      if (y < 0.03 || (avoid && avoid(x, z))) continue;
      // in a deep drift they lie on each other; some caught up in the grass, where it is long
      const pile = kind === 'root' || kind === 'lane' ? rng() * rng() * 0.03 : 0;
      const caught = lawn && kind === 'scatter' && rng() < 0.15 ? rng() * 0.22 * lerp(0.2, 1, lawn(x, z)) : 0;
      pos[n * 3] = x; pos[n * 3 + 1] = y + 0.012 + pile + caught; pos[n * 3 + 2] = z;
      // flat, face up or (a third) face down, or propped at an angle on a blade or a neighbour
      const prop = rng() < 0.25 ? (rng() - 0.5) * 1.6 : (rng() - 0.5) * 0.5;
      rot[n * 4] = rng() * 6.28; rot[n * 4 + 1] = (rng() < 0.33 ? FLAT : -FLAT) + prop; rot[n * 4 + 2] = rng() * 6.28;
      rot[n * 4 + 3] = 0.45 + Math.pow(rng(), 0.7) * 0.75;
      tint[n] = rng();
      n++;
    }
  }
  return { pos, rot, tint, n };
}

// Hanaikada ("flower rafts"): mats of fallen petals caught on the slack water along the banks and behind the rocks
// that break the surface, drawn as the fallen carpet is. Each raft is an ellipse stretched along the current; the
// petals are shuffled across rafts so any leading share of them (instanceCount, set by the petal amount) thins
// every raft evenly.
export function raftData(world, count, rocksInWater) {
  const rng = mulberry32(61);
  const rafts = [];
  for (let i = 0; i < 22; i++) {
    const z = lerp(-75, 45, rng()), side = rng() < 0.5 ? -1 : 1;
    const hw = world.riverHW(z);
    rafts.push({ x: world.riverX(z) + side * hw * lerp(0.74, 0.86, rng()), z, len: 3 + rng() * 5, wid: 0.6 + rng() * 0.7, lean: side });
  }
  for (const r of rocksInWater) {
    if (r.top < 0.05 || r.z < -110 || r.z > 60) continue; // under water: nothing to catch on
    const zz = r.z + r.r * (1.1 + rng() * 0.6); // in its lee, downstream (+z)
    rafts.push({ x: r.x + (rng() - 0.5) * r.r * 0.5, z: zz, len: r.r * (1.4 + rng()), wid: r.r * (0.5 + rng() * 0.3), lean: 0 });
  }
  const weight = rafts.map((r) => r.len * r.wid), total = weight.reduce((a, b) => a + b, 0);
  const pts = [];
  rafts.forEach((r, k) => {
    const [fx, fz] = world.flowDir(r.z);
    const m = Math.round((count * weight[k]) / total);
    for (let j = 0; j < m; j++) {
      // denser in the middle, and against the bank for the bank rafts
      const a = rng() * Math.PI * 2, d = Math.pow(rng(), 0.7);
      let u = Math.cos(a) * d * r.len * 0.5, v = Math.sin(a) * d * r.wid * 0.5;
      if (r.lean) v = Math.abs(v) * r.lean * (rng() < 0.8 ? 1 : -1);
      const x = r.x + fx * u + fz * v, z = r.z + fz * u - fx * v;
      if (world.height(x, z) > -0.02) continue; // stays on the water
      pts.push([x, z]);
    }
  });
  for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
  const n = pts.length;
  const pos = new Float32Array(n * 3), rot = new Float32Array(n * 4), tint = new Float32Array(n);
  pts.forEach(([x, z], i) => {
    pos[i * 3] = x; pos[i * 3 + 1] = 0.012 + rng() * 0.006; pos[i * 3 + 2] = z;
    rot[i * 4] = rng() * 6.28; rot[i * 4 + 1] = (rng() < 0.2 ? FLAT : -FLAT) + (rng() - 0.5) * 0.3; rot[i * 4 + 2] = rng() * 6.28; rot[i * 4 + 3] = 0.75 + rng() * 0.45;
    tint[i] = rng();
  });
  return { pos, rot, tint, n };
}

export function makeFallenPetals({ pos, rot, tint, n }, material) {
  const g = petalGeometry();
  const ig = new THREE.InstancedBufferGeometry();
  ig.index = g.index; ig.attributes.position = g.attributes.position; ig.attributes.normal = g.attributes.normal;
  ig.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
  ig.setAttribute('iRot', new THREE.InstancedBufferAttribute(rot, 4));
  ig.setAttribute('iTint', new THREE.InstancedBufferAttribute(tint, 1));
  ig.instanceCount = n;
  const mesh = new THREE.Mesh(ig, material);
  mesh.frustumCulled = false;
  mesh.layers.set(1);
  return mesh;
}
