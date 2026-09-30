// Koi: a dozen carp of the classic varieties cruising just under the river surface near the tree, in two loose
// groups. Each steers on the CPU: a slow wander, kept off the banks, the rocks, the ends of its reach and the other
// fish, drawn a little towards its group; it speeds up now and then and glides. The vertex stage bends the body into
// its turns and runs the swimming wave down it to the tail; the fins flutter. The water clears a little above each
// fish (see water.js), as it does over koi near the surface — through the full river depth they would not show.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, mix, sin, cos, abs, fract, length, attribute, positionGeometry, normalGeometry, transformNormalToView, uniformArray } from 'three/tsl';
import { U, vnoise, sstep, LitMaterial } from './tsl.js';
import { mulberry32 } from './noise.js';

export const KOI_MAX = 12;
const SIZE = 1.5; // body 0.93 m nose to tail at scale 1: large koi, readable from the banks

// Body along +z (nose at +0.32, tail peduncle at -0.3, tail tip -0.5): broadest just behind the head, blunt nosed,
// deeper than wide, the belly flatter than the back. Fins (aFin = 1, drawn from both sides): a forked tail, a long
// dorsal fin, paddle-shaped pectorals, small pelvic and anal fins.
const Z0 = -0.3, LEN = 0.62;
function koiGeometry() {
  const P = [], N = [], F = [], I = [];
  const R = 20, M = 12;
  const ease = (u) => Math.sin(Math.min(1, u) * Math.PI / 2);
  const nose = (t) => Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.72) / 0.28, 2)));
  const hw = (t) => 0.07 * (t < 0.72 ? 0.16 + 0.84 * ease(t / 0.72) : nose(t));
  const hh = (t) => 0.066 * (t < 0.72 ? 0.36 + 0.64 * ease(t / 0.72) : nose(t) * (0.8 + 0.2 * nose(t)));
  const yc = (t) => 0.008 * Math.sin(Math.PI * t) - 0.012 * Math.max(0, t - 0.8) / 0.2;
  const body = (t) => ({ z: Z0 + t * LEN, w: hw(t), h: hh(t), y: yc(t) });
  for (let j = 0; j <= R; j++) {
    const b = body(j / R);
    for (let i = 0; i < M; i++) {
      const a = (i / M) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      P.push(c * b.w, b.y + s * b.h * (s < 0 ? 0.85 : 1), b.z); N.push(0, 0, 0); F.push(0);
    }
  }
  for (let j = 0; j < R; j++) for (let i = 0; i < M; i++) {
    const a = j * M + i, bb = j * M + ((i + 1) % M), c = a + M, d = bb + M;
    I.push(a, bb, c, bb, d, c);
  }
  for (let i = 1; i < M - 1; i++) I.push(0, i + 1, i); // the peduncle's end, under the tail
  const nBody = P.length / 3, nIdx = I.length;
  // fins: flat fans in their own plane, [root, ...outline] in body coordinates
  const fin = (pts, n) => {
    const base = P.length / 3;
    for (const p of pts) { P.push(...p); N.push(...n); F.push(1); }
    for (let k = 1; k < pts.length - 1; k++) I.push(base, base + k, base + k + 1);
  };
  const top = (t) => { const b = body(t); return [0, b.y + b.h, b.z]; };
  // tail: upright, forked, soft lobes
  fin([[0, 0, -0.29], [0, 0.028, -0.29], [0, 0.07, -0.38], [0, 0.1, -0.47], [0, 0.085, -0.5], [0, 0.04, -0.46], [0, 0, -0.43],
    [0, -0.036, -0.46], [0, -0.078, -0.49], [0, -0.09, -0.47], [0, -0.06, -0.38], [0, -0.024, -0.29]], [1, 0, 0]);
  // dorsal: from behind the shoulders to near the tail, highest in front
  const dors = [];
  for (let k = 0; k <= 6; k++) { const t = 0.62 - k * 0.065, p = top(t), fh = 0.05 * (1 - k / 7) + 0.012; dors.push([0, p[1] + fh, p[2] - 0.03]); }
  fin([top(0.64), ...dors, top(0.22)], [1, 0, 0]);
  for (const sd of [1, -1]) {
    // pectorals: rounded paddles out from the lower flank behind the head, swept back and a little down
    const b = body(0.74), rx = sd * b.w * 0.7, ry = b.y - b.h * 0.55;
    fin([[rx, ry, b.z], [rx, ry, b.z + 0.02], [rx + sd * 0.06, ry - 0.02, b.z - 0.0], [rx + sd * 0.1, ry - 0.035, b.z - 0.045], [rx + sd * 0.1, ry - 0.035, b.z - 0.085], [rx + sd * 0.06, ry - 0.025, b.z - 0.1], [rx + sd * 0.02, ry - 0.008, b.z - 0.07]], [0, 1, 0]);
    // pelvics, smaller, under the middle
    const q = body(0.42), px = sd * q.w * 0.5, py = q.y - q.h * 0.8;
    fin([[px, py, q.z], [px, py, q.z + 0.015], [px + sd * 0.04, py - 0.03, q.z - 0.03], [px + sd * 0.035, py - 0.035, q.z - 0.06], [px, py, q.z - 0.035]], [0, 1, 0]);
  }
  // anal fin under the tail stock
  const q = body(0.18);
  fin([[0, q.y - q.h, q.z + 0.03], [0, q.y - q.h - 0.035, q.z - 0.01], [0, q.y - q.h - 0.03, q.z - 0.05], [0, q.y - q.h * 0.8, q.z - 0.06]], [1, 0, 0]);

  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aFin', new THREE.Float32BufferAttribute(F, 1));
  g.setIndex(I);
  // smooth normals over the body only (the fins keep their planes' normals)
  const bodyOnly = new THREE.BufferGeometry();
  bodyOnly.setAttribute('position', new THREE.Float32BufferAttribute(P.slice(0, nBody * 3), 3));
  bodyOnly.setIndex(I.slice(0, nIdx));
  bodyOnly.computeVertexNormals();
  g.attributes.normal.array.set(bodyOnly.attributes.normal.array);
  return g;
}

// varieties (linear colours): base, patch and spot colours; how much patch and spot; where the patch lies (1: over the
// back, 0: low on the flanks, as asagi's red); a net of darker scale edges; metallic sheen; tanchō's single red crown
const VARIETIES = [
  { name: 'kohaku', base: [0.86, 0.84, 0.8], patch: [0.8, 0.1, 0.02], spot: [0.02, 0.02, 0.02], p: 0.5, s: 0, back: 1, net: 0, metal: 0, crown: 0 },
  { name: 'sanke', base: [0.86, 0.84, 0.8], patch: [0.82, 0.12, 0.02], spot: [0.015, 0.015, 0.02], p: 0.45, s: 0.28, back: 1, net: 0, metal: 0, crown: 0 },
  { name: 'showa', base: [0.02, 0.02, 0.025], patch: [0.8, 0.13, 0.03], spot: [0.86, 0.84, 0.8], p: 0.45, s: 0.35, back: 1, net: 0, metal: 0, crown: 0 },
  { name: 'tancho', base: [0.88, 0.86, 0.82], patch: [0.8, 0.08, 0.02], spot: [0.02, 0.02, 0.02], p: 0, s: 0, back: 1, net: 0, metal: 0, crown: 1 },
  { name: 'yamabuki ogon', base: [0.95, 0.62, 0.12], patch: [1.0, 0.75, 0.25], spot: [0.02, 0.02, 0.02], p: 0.3, s: 0, back: 1, net: 0.25, metal: 1, crown: 0 },
  { name: 'platinum ogon', base: [0.82, 0.83, 0.84], patch: [0.92, 0.92, 0.9], spot: [0.02, 0.02, 0.02], p: 0.3, s: 0, back: 1, net: 0.25, metal: 1, crown: 0 },
  { name: 'asagi', base: [0.22, 0.3, 0.38], patch: [0.85, 0.3, 0.06], spot: [0.02, 0.02, 0.02], p: 0.8, s: 0, back: 0, net: 1, metal: 0, crown: 0 },
  { name: 'chagoi', base: [0.3, 0.17, 0.08], patch: [0.4, 0.25, 0.12], spot: [0.02, 0.02, 0.02], p: 0.3, s: 0, back: 1, net: 0.8, metal: 0.3, crown: 0 },
];
// which variety each fish is (kohaku, sanke and showa, the big three, most often)
const SCHOOL = [0, 1, 2, 0, 3, 4, 1, 6, 5, 2, 7, 0];

export function makeKoi(world, count, center, rocks = []) {
  const n = Math.min(count, KOI_MAX);
  const rng = mulberry32(77);
  const zLo = center.z - 30, zHi = center.z + 28;
  const fish = [];
  for (let i = 0; i < n; i++) {
    const g = i % 2, z = center.z + (g ? 12 : -10) + (rng() - 0.5) * 12;
    fish.push({
      g, x: world.riverX(z) + (rng() - 0.5) * world.riverHW(z) * 0.8, z, h: rng() * 6.28, sp: 0.3, turn: 0, burst: 0,
      y: -0.14 - rng() * 0.12, dive: rng() * 6.28, tail: rng() * 6.28, v: SCHOOL[i % SCHOOL.length], scale: 0.8 + rng() * 0.35,
      f: [0.07 + rng() * 0.05, 0.19 + rng() * 0.08, 0.023 + rng() * 0.02], ph: [rng() * 6.28, rng() * 6.28, rng() * 6.28],
      cruise: 0.22 + rng() * 0.12,
    });
  }
  // per fish: world xz + heading (x, z, dir.x, dir.z) for the water shader
  const state = Array.from({ length: KOI_MAX }, () => new THREE.Vector4(0, -1e4, 0, 1));
  const aPose = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); // x, y, z, heading
  const aLook = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); // tail phase, variety, seed, beat strength
  const aMove = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2); // turn (bend), size
  const geo = koiGeometry();
  geo.setAttribute('aPose', aPose); geo.setAttribute('aLook', aLook); geo.setAttribute('aMove', aMove);
  geo.instanceCount = n;
  for (let i = 0; i < n; i++) { aLook.array[i * 4 + 1] = fish[i].v; aLook.array[i * 4 + 2] = rng() * 50; aMove.array[i * 2 + 1] = fish[i].scale; }

  const pose = attribute('aPose', 'vec4'), look = attribute('aLook', 'vec4'), move = attribute('aMove', 'vec2'), fin = attribute('aFin', 'float');
  // swim: the body curls into its turn; a travelling wave runs down it, stronger towards the tail; fins flutter
  const bend = Fn(() => {
    const p = positionGeometry.toVar();
    const zc = p.z.sub(0.02);
    p.x.addAssign(move.x.mul(zc).mul(zc).mul(1.6));
    const back = sstep(0.22, -0.5, p.z); // 0 at the head .. 1 at the tail tip
    p.x.addAssign(sin(look.x.sub(p.z.mul(8.0))).mul(back.mul(back)).mul(float(0.03).add(look.w.mul(0.045))));
    p.y.addAssign(sin(look.x.mul(0.7).add(p.x.mul(18.0)).add(p.z.mul(9.0))).mul(fin).mul(abs(p.x).add(abs(p.y).mul(0.3))).mul(0.2));
    return p;
  });
  const c = cos(pose.w), s = sin(pose.w);
  const rot = (v) => vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
  const pick = (k) => Fn(() => {
    let o = typeof VARIETIES[0][k] === 'number' ? float(VARIETIES[0][k]) : vec3(...VARIETIES[0][k]);
    for (let i = 1; i < VARIETIES.length; i++) {
      const x = VARIETIES[i][k];
      o = mix(o, typeof x === 'number' ? float(x) : vec3(...x), sstep(i - 0.5, i - 0.49, look.y));
    }
    return o;
  })();
  const mat = new LitMaterial({ roughness: 0.4, metalness: 0, side: THREE.DoubleSide });
  mat.positionNode = rot(bend().mul(move.y.mul(SIZE))).add(pose.xyz);
  mat.normalNode = transformNormalToView(rot(normalGeometry)).normalize();
  const metal = pick('metal');
  mat.roughnessNode = mix(float(0.42), float(0.22), metal);
  mat.metalnessNode = metal.mul(0.45);
  mat.colorNode = Fn(() => {
    const seed = look.z, q = positionGeometry;
    const up = sstep(-0.02, 0.025, q.y); // over the back (the belly stays pale)
    // hi: red patches with crisp edges over the back (asagi's low on the flanks), broken into steps along the body
    const pn = vnoise(vec2(q.x.mul(7.0), q.z.mul(6.0)).add(seed)).mul(0.8).add(vnoise(vec2(q.x.mul(19.0), q.z.mul(15.0)).add(seed.mul(0.7))).mul(0.2));
    const pT = float(1.0).sub(pick('p'));
    const where = mix(sstep(-0.01, -0.03, q.y).mul(sstep(-0.07, -0.04, q.y)), up, pick('back'));
    const patch = sstep(pT.sub(0.015), pT.add(0.015), pn).mul(where);
    // tanchō: one round red crown on the head
    const crown = sstep(0.032, 0.026, length(vec2(q.x, q.z.sub(0.225)))).mul(up).mul(pick('crown'));
    // sumi: small black (showa: white) blotches
    const sn = vnoise(vec2(q.x.mul(24.0), q.z.mul(20.0)).add(seed.mul(1.7)));
    const sT = float(1.0).sub(pick('s').mul(0.5));
    const spot = sstep(sT.sub(0.02), sT.add(0.02), sn).mul(up).mul(sstep(0.01, 0.02, pick('s')));
    const col = pick('base').toVar();
    col.assign(mix(col, pick('patch'), patch.max(crown)));
    col.assign(mix(col, pick('spot'), spot));
    // fukurin: the scales' edges, a darker net over the back (asagi's blue, the ogons' sheen)
    const sc = vec2(q.z.add(q.x).mul(55.0), q.z.sub(q.x).mul(55.0)), e = abs(fract(sc).sub(0.5)).max(abs(fract(sc.add(0.5)).sub(0.5)));
    col.mulAssign(mix(1.0, 0.7, sstep(0.34, 0.46, e.x.min(e.y)).mul(pick('net')).mul(up)));
    col.assign(mix(col, vec3(0.92, 0.9, 0.86), float(1.0).sub(up).mul(0.55).mul(float(1.0).sub(fin)))); // belly
    // eyes: a dark spot each side of the head
    const eye = sstep(0.011, 0.007, length(vec2(abs(q.x).sub(0.036), q.z.sub(0.265))).add(abs(q.y.sub(0.012)).mul(0.6)));
    col.assign(mix(col, vec3(0.02, 0.02, 0.02), eye.mul(float(1.0).sub(fin))));
    // fins: translucent, their tips paler; showa's pectorals black at the root (motoguro)
    const finC = mix(pick('base'), vec3(0.8, 0.8, 0.76), 0.4).mul(0.85);
    col.assign(mix(col, mix(finC, pick('spot'), sstep(0.07, 0.04, abs(q.x)).mul(sstep(-0.01, -0.03, q.y)).mul(float(1.0).sub(pick('back')).max(sstep(0.3, 0.35, pick('s'))).mul(0.8))), fin));
    return vec4(col.mul(0.85), 1.0); // a little light lost to the water
  })();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.layers.set(1); // not in the reflection or the shadow map

  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  return {
    mesh, state: uniformArray(state, 'vec4'), count: n,
    info: () => fish.map((f) => [f.x, f.y, f.z, f.h].map((v) => +v.toFixed(2))),
    update(dt, t) {
      dt = Math.min(dt, 0.1);
      const cx = [0, 0], cz = [0, 0], cn = [0, 0];
      for (const f of fish) { cx[f.g] += f.x; cz[f.g] += f.z; cn[f.g]++; }
      for (let i = 0; i < n; i++) {
        const f = fish[i];
        const hx = Math.sin(f.h), hz = Math.cos(f.h);
        // wander, then steer: each pull is a heading it would rather have and how hard it pulls
        let turn = 0.35 * Math.sin(t * f.f[0] + f.ph[0]) + 0.2 * Math.sin(t * f.f[1] + f.ph[1]);
        const toward = (dx, dz, w) => { turn += wrap(Math.atan2(dx, dz) - f.h) * w; };
        const rx = world.riverX(f.z), hw = world.riverHW(f.z), o = (f.x - rx) / hw;
        if (Math.abs(o) > 0.5) toward(rx - f.x, hz * 2, (Math.abs(o) - 0.5) * 6);
        if (f.z < zLo) toward(0, 1, (zLo - f.z) * 0.3);
        if (f.z > zHi) toward(0, -1, (f.z - zHi) * 0.3);
        for (const r of rocks) {
          const dx = f.x - r.x, dz = f.z - r.z, d = Math.hypot(dx, dz) - r.r;
          if (d < 1.2 && dx * hx + dz * hz < 0) toward(dx, dz, (1.2 - Math.max(d, 0)) * 1.5);
        }
        for (let j = 0; j < n; j++) {
          if (j === i) continue;
          const dx = f.x - fish[j].x, dz = f.z - fish[j].z, d = Math.hypot(dx, dz);
          if (d < 1.5) toward(dx, dz, (1.5 - d) * 1.2);
        }
        const gx = cx[f.g] / cn[f.g] - f.x, gz = cz[f.g] / cn[f.g] - f.z;
        if (Math.hypot(gx, gz) > 4) toward(gx, gz, 0.12);
        turn = Math.max(-1.1, Math.min(1.1, turn));
        f.turn += (turn - f.turn) * Math.min(1, dt * 2.5);
        f.h = wrap(f.h + f.turn * dt);
        // speed: a cruise, a burst of beats now and then, gliding after; slower in a hard turn
        if (f.burst <= 0 && Math.sin(t * f.f[2] + f.ph[2]) > 0.97) f.burst = 1.5 + rng();
        f.burst -= dt;
        const want = (f.burst > 0 ? f.cruise * 2 : f.cruise) * (1 - 0.35 * Math.abs(f.turn));
        f.sp += (want - f.sp) * Math.min(1, dt * (want > f.sp ? 1.5 : 0.4));
        f.x += Math.sin(f.h) * f.sp * dt; f.z += Math.cos(f.h) * f.sp * dt;
        const beat = Math.min(1, Math.max(0, (want - f.sp * 0.6) * 4));
        f.tail += dt * (3 + beat * 7 + Math.abs(f.turn) * 3);
        f.dive += dt * 0.15;
        const y = f.y + Math.sin(f.dive) * 0.05;
        aPose.array.set([f.x, y, f.z, f.h], i * 4);
        aLook.array[i * 4] = f.tail; aLook.array[i * 4 + 3] = beat;
        aMove.array[i * 2] = Math.max(-0.5, Math.min(0.5, f.turn * 0.5));
        state[i].set(f.x, f.z, Math.sin(f.h), Math.cos(f.h));
      }
      aPose.needsUpdate = aLook.needsUpdate = aMove.needsUpdate = true;
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
