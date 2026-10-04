// Butterflies by day over the meadow's flower drifts, round the cherry tree's lawn, along its lantern lines and over
// the paddies pink with renge: mostly cabbage whites (monshirochō), a few yellow sulphurs (monkichō) and the odd
// swallowtail (ageha). Each is two wing cards hinged at a thin body card (6 triangles), one instanced draw. All motion
// is in the vertex stage from the scene's running time: a fluttering path of summed sines round its anchor, 0.3-1.5 m
// up, the wings beating quick down and slower up and now and then holding still in a glide; every 10-24 s it slows
// onto a flower head and sits there a second or two with its wings closed upward, then darts off again. The wings'
// outlines and patterns are painted from their uv in the fragment stage. Out from mid-morning to late afternoon, not
// in rain, fewer under heavy cloud and in strong wind; hidden altogether when none are out.
import * as THREE from 'three/webgpu';
import { Fn, vec2, vec3, float, sin, cos, fract, floor, abs, sign, min, max, mix, clamp, select, length, atan, attribute, uv, positionGeometry, positionWorld, cameraPosition, transformNormalToView, faceDirection, uniform } from 'three/tsl';
import { LitMaterial, U, sstep } from './tsl.js';
import { sunShadow } from './sunshadow.js';
import { mulberry32, smoothstep } from './noise.js';

const TAU = Math.PI * 2;
// how many per quality tier
const COUNT = { ultra: 200, high: 120, medium: 60, low: 24 };
// per species (index in aB.x): wingspan (m), wing beats per second, how much of the time it glides, flight speed
const SPECIES = [
  { name: 'white', span: 0.055, hz: 9, glide: 0.35, speed: 1.0 },
  { name: 'sulphur', span: 0.05, hz: 10, glide: 0.3, speed: 1.15 },
  { name: 'swallowtail', span: 0.1, hz: 5.5, glide: 1.0, speed: 0.85 },
];

// value noise as grass.js's flower drifts compute it on the GPU (tsl.js hash12/vnoise), to find the drifts
const fr = (v) => v - Math.floor(v);
function hash12(x, y) {
  let a = fr(x * 0.1031), b = fr(y * 0.1031), c = fr(x * 0.1031);
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d; b += d; c += d;
  return fr((a + b) * c);
}
function vnoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), u = fr(x), v = fr(y);
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  const a = hash12(i, j), b = hash12(i + 1, j), c = hash12(i, j + 1), d = hash12(i + 1, j + 1);
  return (a + (b - a) * su) * (1 - sv) + (c + (d - c) * su) * sv;
}
const drift = (x, z) => smoothstep(0.5, 0.8, vnoise(x * 0.11 + 17, z * 0.11 + 17));

// Anchors: what each butterfly flutters round. tree: [x, z] of the cherry tree; flowers: the lawn's wildflowers
// (vegetation.js flowersData); posts: the lantern lines' posts (lanterns.js lists[0]); small: the small cherries.
// Per butterfly aA (x, ground y, z, seed), aB (species, radius, ground slope x, z), aC (sitting height, rank, cycle s,
// flight height).
export function butterflyData(world, { tree, flowers, posts, small, count }) {
  const rng = mulberry32(57);
  const rand = (a, b) => a + (b - a) * rng();
  const [TX, TZ] = tree;
  const out = [];
  // the whole flight clear of the river's water, the woods, the cherries' trunks and the buildings' yards
  const ok = (x, z, R) => {
    const ri = world.riverInfo(x, z);
    if (Math.abs(ri.d) - R * 0.8 < ri.hw * 1.05) return false;
    if (Math.hypot(x - TX, z - TZ) < 3.5 + R * 0.6) return false;
    if (small.some((s) => Math.hypot(x - s.x, z - s.z) < 2.5 + R)) return false;
    return world.grove(x, z) < 0.05 && !world.padAt(x, z) && world.height(x, z) > 0.4;
  };
  const slope = (x, z) => [(world.height(x + 1, z) - world.height(x - 1, z)) / 2, (world.height(x, z + 1) - world.height(x, z - 1)) / 2];
  // a spot holds one butterfly, or two or three of a kind chasing round it; returns how many
  const add = (x, z, R, sitH, left, flat = false) => {
    const [gx, gz] = flat ? [0, 0] : slope(x, z);
    if (Math.hypot(gx, gz) > 0.35) return 0;
    const s = rng(), sp = s < 0.72 ? 0 : s < 0.9 ? 1 : 2, y = world.height(x, z);
    const k = Math.min(left, 1 + (rng() < 0.45) + (rng() < 0.2));
    for (let j = 0; j < k; j++) out.push({ x, y, z, R: R * rand(0.8, 1.1), gx, gz, sitH, sp });
    return k;
  };
  const n = { tree: Math.round(count * 0.15), lawn: Math.round(count * 0.25), meadow: Math.round(count * 0.44), lines: Math.round(count * 0.06) };
  n.renge = count - n.tree - n.lawn - n.meadow - n.lines;
  // round the cherry tree, over its fallen petals
  for (let k = 0, got = 0; got < n.tree && k < n.tree * 40; k++) {
    const r = rand(5, 13), a = rng() * TAU, x = TX + Math.cos(a) * r, z = TZ + Math.sin(a) * r, R = rand(1.5, 2.8);
    if (ok(x, z, R)) got += add(x, z, R, rand(0.55, 0.75), n.tree - got);
  }
  if (out.length) out[0].sp = 2; // a swallowtail by the tree
  // the lawn round the cherry tree, over its wildflowers and fallen petals
  for (let k = 0, got = 0; got < n.lawn && k < n.lawn * 40; k++) {
    const i = Math.floor(rng() * flowers.n) * 16, x = flowers.matrix[i + 12], z = flowers.matrix[i + 14], R = rand(1.8, 3.5);
    if (ok(x, z, R)) got += add(x, z, R, rand(0.55, 0.75), n.lawn - got);
  }
  // the meadow's flower drifts (grass.js), off the farmland, most of them near the cherry tree
  for (let k = 0, got = 0; got < n.meadow && k < n.meadow * 200; k++) {
    const r = 8 + 60 * Math.pow(rng(), 1.3), a = rng() * TAU, x = TX + Math.cos(a) * r, z = TZ + Math.sin(a) * r, R = rand(2.5, 4.5);
    const dr = drift(x, z);
    if (dr < 0.5 || rng() > dr * dr || world.zoneAt(x, z) || world.laneDist(x, z) < 2) continue;
    if (ok(x, z, R)) got += add(x, z, R, rand(0.75, 0.95), n.meadow - got);
  }
  // along the lantern lines by the cherry tree, on their landward side
  const near = [];
  for (let i = 0; i < posts.n; i++) {
    const x = posts.matrix[i * 16 + 12], z = posts.matrix[i * 16 + 14];
    if (Math.hypot(x - TX, z - TZ) < 45) near.push([x, z]);
  }
  for (let k = 0, got = 0; near.length && got < n.lines && k < n.lines * 40; k++) {
    const [px, pz] = near[Math.floor(rng() * near.length)], side = Math.sign(px - world.riverX(pz)) || 1;
    const x = px + side * rand(1.5, 3.5), z = pz + rand(-3, 3), R = rand(1.5, 2.5);
    if (ok(x, z, R)) got += add(x, z, R, rand(0.6, 0.8), n.lines - got);
  }
  // the paddies in renge (dry, pink: world.js fields with cell > 0.9), not the flooded ones; nearer ones likelier
  const boxes = world.ZONES.filter((Z) => !Z.village).map((Z) => Z.box);
  const area = boxes.map((b) => (b[2] - b[0]) * (b[3] - b[1])), total = area.reduce((s, a) => s + a, 0);
  for (let k = 0, got = 0; got < n.renge && k < n.renge * 400; k++) {
    let u = rng() * total, bi = 0;
    while (u > area[bi]) u -= area[bi++];
    const b = boxes[bi], x = rand(b[0], b[2]), z = rand(b[1], b[3]);
    if (rng() > Math.exp(-Math.hypot(x - TX, z - TZ) / 160)) continue;
    const { F } = world.heightField(x, z);
    if (!F || !F.inside || F.wet || !(F.cell > 0.9) || F.q < 1.4) continue;
    const R = Math.min(3, F.q * 0.8);
    if (ok(x, z, R)) got += add(x, z, R, rand(0.1, 0.16), n.renge - got, true);
  }
  const m = out.length;
  const aA = new Float32Array(m * 4), aB = new Float32Array(m * 4), aC = new Float32Array(m * 4), aK = new Float32Array(m * 4);
  out.forEach((b, i) => {
    const k = SPECIES[b.sp];
    aK.set([k.span * rand(0.9, 1.1), k.hz * rand(0.85, 1.15), k.glide, k.speed], i * 4);
    aA.set([b.x, b.y, b.z, rng()], i * 4);
    aB.set([b.sp, b.R, b.gx, b.gz], i * 4);
    aC.set([b.sitH, rng(), rand(10, 24), b.sitH > 0.3 ? rand(1.0, 1.2) : rand(0.5, 0.9)], i * 4);
  });
  return { aA, aB, aC, aK, n: m };
}

// one butterfly: two wing cards hinged on the body's axis (z forward, x out to the right; position in wingspans,
// uv the wing's own coordinates in wingspans, mirrored) and a thin vertical card for the body (aPart 1)
function butterflyGeometry() {
  const P = [], UV = [], PART = [], I = [];
  const quad = (pts, uvs, part, up) => {
    const b = P.length / 3;
    pts.forEach((p) => P.push(...p)); uvs.forEach((t) => UV.push(...t)); pts.forEach(() => PART.push(part));
    // wound so the front face is the wing's top (normal +y) or the body's right side
    const [a, c, d] = [pts[0], pts[1], pts[2]];
    const e1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const flip = nrm[0] * up[0] + nrm[1] * up[1] + nrm[2] * up[2] < 0;
    if (flip) I.push(b, b + 2, b + 1, b, b + 3, b + 2); else I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const W = 0.5, F = 0.22, B = -0.42;
  for (const s of [1, -1]) quad([[0, 0, B], [s * W, 0, B], [s * W, 0, F], [0, 0, F]], [[0, B], [W, B], [W, F], [0, F]], 0, [0, 1, 0]);
  const h = 0.03, b0 = -0.2, b1 = 0.13;
  quad([[0, -h, b0], [0, h, b0], [0, h, b1], [0, -h, b1]], [[-1, -1], [1, -1], [1, 1], [-1, 1]], 1, [1, 0, 0]);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(PART, 1));
  g.setIndex(I);
  return g;
}

// inside an ellipse: centre c, radii r, its long axis turned by a (towards +z); < 1 inside
const ell = (q, c, r, a) => {
  const d = q.sub(vec2(c[0], c[1])), ca = Math.cos(a), sa = Math.sin(a);
  return length(vec2(d.x.mul(ca).add(d.y.mul(sa)).div(r[0]), d.y.mul(ca).sub(d.x.mul(sa)).div(r[1])));
};
const spot = (q, c, r) => sstep(r, r * 0.6, length(q.sub(vec2(c[0], c[1]))));

function butterflyMaterial(uAmount) {
  const A = attribute('aA', 'vec4'), B = attribute('aB', 'vec4'), C = attribute('aC', 'vec4'), K = attribute('aK', 'vec4'), part = attribute('aPart', 'float');
  const seed = A.w, sp = B.x, R = B.y;
  const t = U.uTime.add(seed.mul(997.0));
  // the cycle: flying, then slowing onto a flower (over D s) and sitting there S s; tau, the path's own time, stands
  // still while it sits, so it takes off from where it landed
  const T = C.z, S = seed.mul(7.13).fract().mul(1.6).add(1.2), D = 0.8;
  const F = T.sub(S), n = floor(t.div(T)), u = t.sub(n.mul(T));
  const e = clamp(u.sub(F.sub(D)), 0.0, D);
  const tau = n.mul(F.sub(D * 0.5)).add(min(u, F.sub(D))).add(e).sub(e.mul(e).div(2 * D));
  const sit = max(sstep(F.sub(D * 0.7), F, u), float(1).sub(sstep(0.0, 0.3, u)));
  // the path: two loops of summed sines round the anchor at about `speed` m/s, and a quick zigzag on top
  const h = (k) => fract(seed.mul(13.7 + k * 7.9).add(k * 0.37));
  const w = K.w.mul(0.9).div(R), ph = (k) => h(k).mul(TAU);
  const w1 = w.mul(h(1).mul(0.4).add(0.8)), w2 = w.mul(h(2).mul(0.8).add(2.1)), w3 = w.mul(h(3).mul(0.4).add(0.8)), w4 = w.mul(h(4).mul(0.8).add(1.9));
  const zz = 0.09;
  const px = R.mul(sin(w1.mul(tau).add(ph(1))).mul(0.65).add(sin(w2.mul(tau).add(ph(2))).mul(0.35))).add(sin(tau.mul(5.3).add(ph(5))).mul(zz));
  const pz = R.mul(cos(w3.mul(tau).add(ph(3))).mul(0.65).add(sin(w4.mul(tau).add(ph(4))).mul(0.35))).add(sin(tau.mul(4.1).add(ph(6))).mul(zz));
  const vx = R.mul(cos(w1.mul(tau).add(ph(1))).mul(w1).mul(0.65).add(cos(w2.mul(tau).add(ph(2))).mul(w2).mul(0.35))).add(cos(tau.mul(5.3).add(ph(5))).mul(zz * 5.3));
  const vz = R.mul(sin(w3.mul(tau).add(ph(3))).mul(w3).mul(-0.65).add(cos(w4.mul(tau).add(ph(4))).mul(w4).mul(0.35))).add(cos(tau.mul(4.1).add(ph(6))).mul(zz * 4.1));
  // the wings: a beat quick down (35% of it) and slower up, glides now and then, closed upward while it sits (opened
  // slowly now and then, basking)
  const phase = fract(t.mul(K.y));
  const f = select(phase.lessThan(0.35), phase.div(0.35), float(1).sub(phase.sub(0.35).div(0.65)));
  const glide = sstep(0.45, 0.9, sin(t.mul(h(8).mul(0.5).add(0.7)).add(ph(8)))).mul(K.z);
  const beat = mix(float(1.15), float(-0.5), f.mul(f).mul(float(3).sub(f.mul(2))));
  const bask = sstep(0.6, 0.95, sin(t.mul(0.9).add(ph(9))));
  const th = mix(mix(beat, float(0.15), glide), float(1.42).sub(bask.mul(1.1)), sit);
  // up and down: a flight height between 0.3 and 1.5 m over the ground's slope, lifted a little by each down stroke
  const yg = A.y.add(B.z.mul(px)).add(B.w.mul(pz));
  const fly = clamp(C.w.add(sin(tau.mul(w.mul(1.3)).add(ph(10))).mul(0.3)).add(sin(tau.mul(w.mul(3.4)).add(ph(11))).mul(0.1)), 0.3, 1.5)
    .add(sin(phase.mul(TAU)).mul(0.02).mul(float(1).sub(glide)));
  const pos = vec3(A.x.add(px), yg.add(mix(fly, C.x, sit)), A.z.add(pz));
  // never smaller than a fleck of ~17 px at 1080p (an angle: 1.2% of the distance), up to six times its size; none out
  // (by rank) or beyond 150 m
  const dist = length(pos.sub(cameraPosition)), span = K.x;
  const out = sstep(C.y, C.y.add(0.04), uAmount).mul(sstep(150.0, 130.0, dist));
  const size = clamp(dist.mul(0.012), span, span.mul(6.0)).mul(out);
  // the wing folds about the body's axis; the body pitched up in flight, rolling a little, heading along the path
  const p = positionGeometry, s = sign(p.x), r = abs(p.x);
  const local = vec3(s.mul(r).mul(cos(th)), p.y.add(r.mul(sin(th))), p.z);
  const nl = mix(vec3(s.negate().mul(sin(th)), cos(th), 0.0), vec3(1, 0, 0), part);
  const bank = sin(t.mul(2.3).add(ph(12))).mul(0.15).mul(float(1).sub(sit)), pitch = mix(float(0.3), float(0.08), sit), yaw = atan(vx, vz);
  const cb = cos(bank), sb = sin(bank), cp = cos(pitch), spn = sin(pitch), cy = cos(yaw), sy = sin(yaw);
  const orient = (v) => {
    const a = vec3(v.x.mul(cb).add(v.y.mul(sb)), v.y.mul(cb).sub(v.x.mul(sb)), v.z);
    const b = vec3(a.x, a.y.mul(cp).add(a.z.mul(spn)), a.z.mul(cp).sub(a.y.mul(spn)));
    return vec3(b.x.mul(cy).add(b.z.mul(sy)), b.y, b.z.mul(cy).sub(b.x.mul(sy)));
  };

  // ---------- the wings' paint ----------
  const q = uv(), top = faceDirection.greaterThan(0.0);
  const far = sstep(8.0, 20.0, length(positionWorld.sub(cameraPosition))); // fine marks give way to the wing's average
  const paint = Fn(() => {
    // cabbage white: cream, the forewing's tip dusky, one or two dark spots; underneath the hindwing pale yellow
    const wf = ell(q, [0.25, 0.05], [0.26, 0.12], 0.25), wh = ell(q, [0.15, -0.14], [0.16, 0.15], -0.3);
    const wTip = sstep(0.1, 0.05, length(q.sub(vec2(0.47, 0.12)))).mul(wf.lessThan(1.0).select(1.0, 0.0));
    let white = mix(vec3(0.97, 0.97, 0.93), vec3(0.95, 0.94, 0.72), wf.greaterThan(wh).select(top.select(0.15, 0.7), 0.0));
    white = mix(white, vec3(0.2, 0.2, 0.2), wTip.mul(top.select(0.9, 0.35)).add(spot(q, [0.3, 0.02], 0.024).mul(top.select(0.85, 0.5))).min(1.0));
    white = mix(white, vec3(0.55, 0.56, 0.52), sstep(0.06, 0.0, q.x));
    white = mix(white, vec3(0.9, 0.9, 0.82), far);
    // sulphur: lemon yellow, a dark margin round the forewing and hindwing (not underneath), a dark spot and an orange
    const yf = ell(q, [0.24, 0.04], [0.25, 0.13], 0.2), yh = ell(q, [0.15, -0.14], [0.16, 0.15], -0.3);
    const margin = max(sstep(0.72, 0.8, yf).mul(sstep(0.18, 0.26, q.x)).mul(yf.lessThan(yh).select(1.0, 0.0)), sstep(0.8, 0.88, yh).mul(sstep(0.1, 0.18, q.x)).mul(yh.lessThan(yf).select(1.0, 0.0)));
    let yellow = top.select(vec3(0.96, 0.82, 0.22), vec3(0.88, 0.86, 0.42));
    yellow = mix(yellow, vec3(0.2, 0.13, 0.07), margin.mul(top.select(1.0, 0.0)).add(spot(q, [0.24, 0.05], 0.02)).min(1.0));
    yellow = mix(yellow, vec3(0.95, 0.5, 0.12), spot(q, [0.16, -0.13], 0.022));
    yellow = mix(yellow, vec3(0.85, 0.74, 0.25), far);
    // swallowtail: pale yellow barred with black, black margins with yellow crescents, blue and an orange-red eye on
    // the hindwing, which ends in a tail
    const af = ell(q, [0.25, 0.06], [0.27, 0.1], 0.32), ah = ell(q, [0.14, -0.16], [0.14, 0.15], -0.45), at = ell(q, [0.17, -0.34], [0.025, 0.07], -0.3);
    const ax = q.x.mul(Math.cos(0.32)).add(q.y.mul(Math.sin(0.32))); // along the forewing
    const bars = sstep(0.55, 0.8, sin(ax.mul(62.0))).mul(sstep(0.36, 0.3, ax));
    const edge = select(af.lessThan(ah), sstep(0.76, 0.82, af).mul(float(1).sub(sstep(0.45, 0.8, sin(ax.mul(70.0))).mul(sstep(0.9, 0.85, af)))), sstep(0.7, 0.76, ah));
    const black = max(max(bars.mul(af.lessThan(1.0).select(1.0, 0.0)), edge), max(sstep(0.05, 0.02, q.x), at.lessThan(1.0).select(1.0, 0.0)));
    let ageha = mix(vec3(0.93, 0.86, 0.5), vec3(0.04, 0.035, 0.03), black);
    ageha = mix(ageha, vec3(0.25, 0.4, 0.85), sstep(0.78, 0.82, ah).mul(sstep(0.93, 0.88, ah)).mul(sstep(0.3, 0.7, sin(q.x.mul(80.0)))).mul(ah.lessThan(af).select(1.0, 0.0)));
    ageha = mix(ageha, vec3(0.85, 0.28, 0.08), spot(q, [0.05, -0.27], 0.028));
    ageha = mix(ageha, vec3(0.45, 0.4, 0.22), far);
    // the body: dark, the white's greyer
    const body = select(sp.lessThan(0.5), vec3(0.22, 0.22, 0.21), vec3(0.08, 0.07, 0.06));
    return select(part.greaterThan(0.5), body, select(sp.lessThan(0.5), white, select(sp.lessThan(1.5), yellow, ageha)));
  });
  const opacity = Fn(() => {
    const inWing = select(sp.lessThan(0.5), min(ell(q, [0.25, 0.05], [0.26, 0.12], 0.25), ell(q, [0.15, -0.14], [0.16, 0.15], -0.3)),
      select(sp.lessThan(1.5), min(ell(q, [0.24, 0.04], [0.25, 0.13], 0.2), ell(q, [0.15, -0.14], [0.16, 0.15], -0.3)),
        min(min(ell(q, [0.25, 0.06], [0.27, 0.1], 0.32), ell(q, [0.14, -0.16], [0.14, 0.15], -0.45)), ell(q, [0.17, -0.34], [0.025, 0.07], -0.3))));
    return sstep(1.05, 0.95, select(part.greaterThan(0.5), length(q), inWing));
  });

  const col = paint();
  // light through the thin wings with the sun behind them; in shade the sky's light pulled towards its own grey and
  // the sunlit ground's bounce (as materials.js does for stone), or a white in the cherry's shade comes out navy
  const mat = new LitMaterial({ roughness: 0.8, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5 }, (o) => {
    const back = max(positionWorld.sub(cameraPosition).normalize().dot(U.uSunDir), 0.0);
    const day = sstep(0.0, 0.35, U.uSunDir.y);
    const grey = vec3(U.uSkyAmb.dot(vec3(0.3, 0.6, 0.1))).sub(U.uSkyAmb).mul(0.25).add(U.uSunColor.mul(U.uSunVis).mul(vec3(0.34, 0.36, 0.24)).mul(0.5)).mul(day);
    return o.add(col.mul(grey)).add(col.mul(U.uSunColor).mul(U.uSunVis).mul(sunShadow).mul(back.mul(back).mul(0.5)));
  });
  mat.positionNode = orient(local.mul(size)).add(pos);
  // the thin wings let the light through: lit on either face as the face turned to the sun, bent up to the sky
  const nw = orient(nl).toVarying('vWingN').normalize();
  const ns = nw.mul(select(nw.dot(U.uSunDir).lessThan(0.0), -1.0, 1.0)).add(vec3(0, 0.6, 0)).normalize();
  mat.normalNode = transformNormalToView(ns).normalize();
  mat.colorNode = col;
  mat.opacityNode = opacity();
  return mat;
}

// world: heights, river, farmland; opts: { tree: [x, z], flowers, posts, small, tier } (see butterflyData)
export function makeButterflies(world, opts) {
  const d = butterflyData(world, { ...opts, count: COUNT[opts.tier] ?? COUNT.high });
  const geo = butterflyGeometry();
  geo.setAttribute('aA', new THREE.InstancedBufferAttribute(d.aA, 4));
  geo.setAttribute('aB', new THREE.InstancedBufferAttribute(d.aB, 4));
  geo.setAttribute('aC', new THREE.InstancedBufferAttribute(d.aC, 4));
  geo.setAttribute('aK', new THREE.InstancedBufferAttribute(d.aK, 4));
  geo.instanceCount = d.n;
  const uAmount = uniform(0);
  const mesh = new THREE.Mesh(geo, butterflyMaterial(uAmount));
  mesh.name = 'butterflies';
  mesh.frustumCulled = false;
  mesh.layers.set(1); // not in the reflection or the shadow maps
  return {
    mesh,
    // ctx: { hour, rain, clouds, wind (0..1), warming }
    update(ctx) {
      const h = ctx.hour;
      const day = smoothstep(7.2, 8.6, h) * (1 - smoothstep(16.4, 17.6, h));
      uAmount.value = day * (1 - smoothstep(0.02, 0.12, ctx.rain)) * (1 - 0.6 * smoothstep(0.6, 0.95, ctx.clouds)) * (1 - 0.75 * smoothstep(0.3, 0.7, ctx.wind));
      mesh.visible = ctx.warming || uAmount.value > 0.001; // (warm-up builds the pipeline)
    },
    info: () => ({ n: d.n, amount: uAmount.value, visible: mesh.visible }),
  };
}
