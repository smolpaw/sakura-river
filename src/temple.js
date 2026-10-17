// Old temple on the knoll across the river (world.temple): a stone-walled terrace with a five-storey pagoda, a main
// hall under a hip-and-gable (irimoya) roof, a bell tower, ochre boundary walls with five white lines, and stone
// lanterns along the approach. The buildings stand on dressed-stone platforms (kidan); their roofs sweep up to the
// corners (sori) over double rafters and stepped bracket sets (roof). Weathered bengara wood (the pagoda lacquered
// vermilion), white plaster, ribbed grey tile, verdigris bronze; the sky light each part sees past the others is baked
// into the colours (skyLight). After dusk
// the hall's lattice doors and the lanterns' fireboxes glow (aGlow), and floodlights hidden in the gravel light the
// pagoda from below, as at a temple's spring light-up (materials.js templeMaterial, fx.js makeGlows).
// Generation only (runs in a worker).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, lerp } from './noise.js';
import { KIND, tagKinds } from './kinds.js';

const V = THREE.Vector3;
const WOOD = [0.27, 0.1, 0.06], WOOD_D = [0.1, 0.07, 0.05], PLASTER = [0.8, 0.77, 0.7], TILE = [0.2, 0.21, 0.22], TILE_D = [0.11, 0.115, 0.12];
const ENDS = [0.8, 0.74, 0.58], BRONZE = [0.22, 0.36, 0.3], BRONZE_D = [0.16, 0.2, 0.15], STONE = [0.43, 0.41, 0.38], GRAVEL = [0.6, 0.58, 0.53];
const STONE_D = [0.19, 0.18, 0.17]; // the joints between cut stones
const OCHRE = [0.62, 0.45, 0.22], PAPER = [0.86, 0.8, 0.66], FIREBOX = [0.5, 0.45, 0.38];
const SHU = [0.56, 0.07, 0.03], SHU_D = [0.3, 0.05, 0.03]; // the pagoda's vermilion lacquer (the bridge's, weathered)
// the photographed textures the parts take, by colour (kinds.js)
const KINDS = [[WOOD, KIND.WOOD], [WOOD_D, KIND.WOOD], [SHU, KIND.PAINT], [SHU_D, KIND.PAINT], [PLASTER, KIND.PLASTER], [TILE, KIND.TILE],
  [TILE_D, KIND.TILE], [STONE, KIND.STONE], [GRAVEL, KIND.GRAVEL]];

// parts in a local frame; at() places what its callback adds (lamps too)
export function kit() {
  const parts = [], lamps = [];
  // indexed (a box is 24 vertices, not 36): one colour and glow per part; `kind` sets its surface kind where its colour
  // is not one of the palette's (tagKinds)
  const add = (g, c, glow = 0, kind) => {
    g.deleteAttribute('uv');
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    if (!g.index) g.setIndex([...Array(n).keys()]);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (kind !== undefined) g.userData.kind = kind;
    parts.push(g);
  };
  const box = (w, h, d, x, y, z, c, ry = 0, glow = 0, kind) => add(new THREE.BoxGeometry(w, h, d).rotateY(ry).translate(x, y, z), c, glow, kind);
  const beam = (a, b, w, h, c) => {
    const d = new V().subVectors(b, a);
    const g = new THREE.BoxGeometry(w, h, d.length());
    g.applyMatrix4(new THREE.Matrix4().lookAt(new V(), d, Math.abs(d.y) > 0.99 * d.length() ? new V(1, 0, 0) : new V(0, 1, 0)));
    const m = a.clone().add(b).multiplyScalar(0.5);
    add(g.translate(m.x, m.y, m.z), c);
  };
  const lathe = (prof, segs, c, y = 0, phi = 0, glow = 0) => add(new THREE.LatheGeometry(prof.map(([r, yy]) => new THREE.Vector2(r, yy + y)), segs, phi), c, glow);
  const at = (x, y, z, ry, fn) => {
    const n = parts.length, nl = lamps.length;
    fn();
    const m = new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z);
    for (let i = n; i < parts.length; i++) parts[i].applyMatrix4(m);
    for (let i = nl; i < lamps.length; i++) lamps[i].applyMatrix4(m);
  };
  // what fn() adds in colour `from` takes colour `to` instead
  const paint = (pairs, fn) => {
    const n = parts.length;
    fn();
    for (let i = n; i < parts.length; i++) {
      const c = parts[i].attributes.color.array, hit = pairs.find(([f]) => f.every((v, j) => Math.abs(c[j] - v) < 1e-6));
      if (hit) for (let j = 0; j < c.length; j += 3) c.set(hit[1], j);
    }
  };
  return { parts, lamps, add, box, beam, lathe, at, paint };
}

// A sheet over the (K+1)×(M+1) grid of points p(i, m), shaded smooth, facing up (or down)
function sheet(k, p, K, M, c, up) {
  const P = [];
  for (let i = 0; i <= K; i++) for (let m = 0; m <= M; m++) P.push(...p(i, m).toArray());
  const q = (i) => new V(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  const flip = (new V().subVectors(q(1), q(0)).cross(new V().subVectors(q(M + 1), q(0))).y > 0) !== up;
  const I = [];
  for (let i = 0; i < K; i++) for (let m = 0; m < M; m++) {
    const a = i * (M + 1) + m, b = a + 1, c2 = a + M + 1, d = c2 + 1;
    if (flip) I.push(a, c2, b, b, c2, d); else I.push(a, b, c2, b, d, c2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  k.add(g, c);
}

// Flat quads gathered into one part: q(a, b, c, d, out) adds the quad a b c d (in order round it) facing `out`;
// bar(A, B, w, h) a timber hanging under the line A → B (its top's middle): its two sides and underside (its top lies
// against boards), and with `end` the quad closing it at A.
function quads() {
  const P = [], I = [];
  const q = (a, b, c, d, out) => {
    const o = P.length / 3;
    P.push(...a.toArray(), ...b.toArray(), ...c.toArray(), ...d.toArray());
    if (new V().subVectors(b, a).cross(new V().subVectors(d, a)).dot(out) >= 0) I.push(o, o + 1, o + 2, o, o + 2, o + 3);
    else I.push(o, o + 2, o + 1, o, o + 3, o + 2);
  };
  const bar = (A, B, w, h, end) => {
    const s = new V(B.z - A.z, 0, A.x - B.x).normalize().multiplyScalar(w / 2), dn = new V(0, -h, 0);
    const al = A.clone().add(s), ar = A.clone().sub(s), bl = B.clone().add(s), br = B.clone().sub(s);
    const [alb, arb, blb, brb] = [al, ar, bl, br].map((p) => p.clone().add(dn));
    q(al, bl, blb, alb, s); q(ar, arb, brb, br, s.clone().negate()); q(alb, blb, brb, arb, new V(0, -1, 0));
    if (end) end.q(al, ar, arb, alb, new V().subVectors(A, B));
  };
  const add = (k, c) => {
    if (!P.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    k.add(g, c);
  };
  return { q, bar, add };
}

// The eaves from the tiles' edge in (metres below the edge; slopes per metre in): the flying rafters (hiendaruki)
// under their boards, a step up at their feet (the kioi, where they rest on the base rafters' boards), the base rafters
// (jidaruki) under theirs, resting on the eave purlin over the bracket sets and running on in to the wall.
const EAVE = { edge: 0.3, fly: 0.13, kioi: 0.1, base: 0.15, pF: 0.18, pB: 0.3, purlin: 0.2, w: 0.13, gap: 0.42 };
// the bracket sets' courses: the large bearing block on the post, then per step an arm and the small blocks on it
const TOKYO = { daito: 0.22, step: 0.28, arm: 0.15 };

// A roof's shape over the eave rectangle ±a × ±b, in each face's own terms: d metres in from its eave (D to its top),
// s along it (its half-length L(d) shrinks to the hips; ridge: half-length of the top ridge, 0 a pyramid). The tiles
// rise H to the top along a concave sweep (u = d / D; sweep: how much of the rise is in the curve, so the eaves run
// out flatter than the roof near its top) and the corners lift `kick` (sori): the lift rises with the square of the
// way along the eave from its middle and dies away up the slope, so the hips curve up at their feet. The eaves'
// underside lifts as much at the edge and none at the purlin (dP in), where the bracket sets carry it level.
function roofShape({ y0, a, b, H, kick, ridge = 0, sweep = 0.6, dP = 1 }) {
  const C = [[-a, b], [a, b], [a, -b], [-a, -b]];
  const faces = [0, 1, 2, 3].map((fi) => {
    const c0 = C[fi], c1 = C[(fi + 1) % 4], side = fi % 2;
    const L0 = side ? b : a, Lr = side ? 0 : ridge, D = side ? a - ridge : b;
    const tx = Math.sign(c1[0] - c0[0]), tz = Math.sign(c1[1] - c0[1]), nx = -tz, nz = tx, mx = (c0[0] + c1[0]) / 2, mz = (c0[1] + c1[1]) / 2;
    const L = (d) => L0 + ((Lr - L0) * d) / D;
    return { L0, D, nx, nz, L, M: 2 * Math.max(3, Math.round((2 * L0) / 0.5)), P: (s, d, y) => new V(mx + tx * s - nx * d, y, mz + tz * s - nz * d) };
  });
  const rise = (u) => H * ((1 - sweep) * u + sweep * u * u);
  const lift = (e, u) => kick * e * e * Math.pow(Math.max(0, 1 - u), 2.5);
  const liftUnder = (e, d) => (d < dP ? kick * e * e * (1 - d / dP) ** 2 : 0);
  // a point of the tiles (u up the face, t along it)
  const tile = (f, u, t) => { const d = u * f.D, e = 2 * t - 1; return f.P(e * f.L(d), d, y0 + rise(u) + lift(Math.abs(e), u)); };
  return { y0, H, faces, rise, lift, liftUnder, tile };
}

// The tiles of a hipped roof (roofShape), a fascia under their edge EAVE.edge deep, the hip ridges and the ridge-end
// tiles; above the fraction `gable` of the slope the roof turns into an irimoya gable. Returns the height of the top.
function hipRoof(k, R, { gable = 0, rib = 0.09 } = {}) {
  const uTop = gable || 1;
  for (const f of R.faces) {
    const K = Math.max(4, Math.round(10 * uTop)), M = f.M;
    sheet(k, (i, m) => R.tile(f, (i / K) * uTop, m / M).add(new V(0, (m % 2) * rib, 0)), K, M, TILE, true);
    const F = quads(), out = new V(f.nx, 0, f.nz);
    for (let m = 0; m < M; m++) {
      const a = R.tile(f, 0, m / M), b = R.tile(f, 0, (m + 1) / M);
      F.q(a.clone().setY(a.y + (m % 2) * rib), b.clone().setY(b.y + ((m + 1) % 2) * rib), b.clone().setY(b.y - EAVE.edge), a.clone().setY(a.y - EAVE.edge), out);
    }
    F.add(k, WOOD_D);
    // the hip ridge up the corner line (closer pieces where it curves up at its foot), a ridge-end tile at the eave
    const n = 8, hip = (i) => R.tile(f, Math.pow(i / n, 1.4) * uTop, 0).add(new V(0, rib + 0.12, 0));
    for (let i = 0; i < n; i++) k.beam(hip(i), hip(i + 1), 0.3, 0.3, TILE_D);
    const c = R.tile(f, 0, 0);
    k.box(0.45, 0.5, 0.45, c.x * 0.99, c.y + 0.3, c.z * 0.99, TILE_D, Math.atan2(c.x, c.z));
  }
  if (!gable) return R.y0 + R.H;
  // irimoya: a gable over the hipped skirt (its slope running on up to the ridge), a plastered gable wall with struts,
  // bargeboards and a main ridge with shibi
  const f0 = R.faces[0], ax = f0.L(gable * f0.D), bz = f0.D * (1 - gable), yg = R.y0 + R.rise(gable), top = R.y0 + R.H;
  const gy = (v) => R.y0 + R.rise(gable + (1 - gable) * v);
  // its tiles run on from the skirt's top row (the same ribs, the corners' lift dying away up it) and reach out over the
  // gable ends, where a fascia closes them
  const sp = (2 * ax) / f0.M, nx = 2 * Math.max(1, Math.round(0.25 / sp)), X = ax + nx * sp, M = f0.M + 2 * nx;
  for (const s of [1, -1]) {
    const at = (v, t) => {
      const x = lerp(-X, X, t), u = gable + (1 - gable) * v;
      return new V(x, gy(v) + R.lift(Math.min(1, Math.abs(x) / ax), u), s * bz * (1 - v));
    };
    sheet(k, (i, m) => at(i / 6, m / M).add(new V(0, (m % 2) * 0.09, 0)), 6, M, TILE, true);
    sheet(k, (i, m) => at(i / 6, m / M).add(new V(0, -0.3, 0)), 6, M, WOOD, false);
    const F = quads();
    for (let m = 0; m < M; m++) {
      if (m >= nx && m < M - nx) continue;
      const a = at(0, m / M), b = at(0, (m + 1) / M);
      F.q(a.clone().setY(a.y + (m % 2) * 0.09), b.clone().setY(b.y + ((m + 1) % 2) * 0.09), b.clone().setY(b.y - 0.3), a.clone().setY(a.y - 0.3), new V(0, 0, s));
    }
    F.add(k, WOOD_D);
  }
  for (const s of [1, -1]) {
    const xw = s * (ax - 0.4);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([xw, yg, -bz * 0.97, xw, yg, bz * 0.97, xw, top - 0.15, 0], 3));
    tri.computeVertexNormals();
    k.add(tri, PLASTER);
    k.box(0.16, 0.22, 2 * bz, xw + s * 0.06, yg + 0.3, 0, WOOD);
    for (const zz of [-0.6, -0.3, 0, 0.3, 0.6]) k.beam(new V(xw + s * 0.06, yg, zz * bz), new V(xw + s * 0.06, gy(1 - Math.abs(zz)) - 0.15, zz * bz), 0.12, 0.12, WOOD);
    // bargeboards along both gable edges, the pendant (gegyo) at the peak, descending ridges on top
    const edge = (v, sz, dx, dy) => new V(s * (X + dx), gy(v) + dy, sz * bz * (1 - v));
    for (const sz of [1, -1]) for (let i = 0; i < 5; i++) {
      k.beam(edge(i / 5, sz, 0, -0.2), edge((i + 1) / 5, sz, 0, -0.2), 0.18, 0.55, WOOD_D);
      k.beam(edge(i / 5, sz, -0.35, 0.3), edge((i + 1) / 5, sz, -0.35, 0.3), 0.32, 0.32, TILE_D);
    }
    k.box(0.14, 0.9, 0.55, s * (X + 0.05), top - 0.7, 0, ENDS);
    // shibi: a dark tile fin at each end of the main ridge, its tip curling in over the ridge
    const fin = new THREE.Shape();
    fin.moveTo(0, 0); fin.lineTo(1.0, 0);
    fin.quadraticCurveTo(0.42, 0.3, 0.5, 1.55);
    fin.quadraticCurveTo(0.1, 1.35, 0, 0.9);
    fin.lineTo(0, 0);
    const g = new THREE.ExtrudeGeometry(fin, { depth: 0.34, bevelEnabled: false, curveSegments: 5 });
    k.add(g.translate(0, 0, -0.17).scale(-s, 1, 1).translate(s * (X - 0.05), top + 0.6, 0), TILE_D);
  }
  k.box(2 * X, 0.75, 0.55, 0, top + 0.3, 0, TILE_D);
  return top;
}

// The eaves' underside (EAVE) of roof R: the flying and the base rafters' boards (the base ones on in to dIn, inside the
// walls), the kioi's step between them, the double rafters with their ends painted, the eave purlin at dP, and at each
// corner the hip rafters (sumigi), tipped in bronze; `bells`: a wind bell hung from each tip. The faces' undersides
// meet on the diagonals (s = L0 - d), under the hips (which run off them where the faces' pitches differ).
function eaves(k, R, { dF, dP, dIn, bells = false }) {
  const E = EAVE, wood = quads(), ends = quads(), caps = quads();
  const fly = (d) => R.y0 - E.edge + d * E.pF; // the boards' undersides, without the lift
  const base = (d) => fly(dF) - E.fly - E.kioi + (d - dF) * E.pB;
  for (const f of R.faces) {
    // (every other column of the tiles' grid, and rows where the lift bends: it runs straight on from the purlin)
    const M = f.M / 2, out = new V(f.nx, 0, f.nz);
    const L = (d) => f.L0 - d, e = (s, d) => Math.min(1, Math.abs(s) / L(d));
    const at = (s, d, y) => f.P(s, d, y(d) + R.liftUnder(e(s, d), d));
    const boards = (D, y) => sheet(k, (i, m) => { const s = (2 * m / M - 1) * L(D[i]); return at(s, D[i], y); }, D.length - 1, M, WOOD, false);
    boards([0, dF / 2, dF], fly);
    boards([dF, (dF + dP) / 2, dP, dIn], base);
    for (let m = 0; m < M; m++) {
      const s0 = (2 * m / M - 1) * L(dF), s1 = (2 * (m + 1) / M - 1) * L(dF);
      wood.q(at(s0, dF, fly), at(s1, dF, fly), at(s1, dF, base), at(s0, dF, base), out);
    }
    // the rafters, square to the eave, the ones near a corner stopping at the hip rafter (dh: where s meets it)
    const n = Math.floor((2 * f.L0) / E.gap);
    for (let j = 0; j <= n; j++) {
      const s = -f.L0 + ((j + 0.5) * 2 * f.L0) / (n + 1), dh = f.L0 - Math.abs(s);
      // (straight pieces between the depths D, enough to follow the lift: it curves most near the corners, and the
      // base rafters run straight on from the purlin, where it ends)
      const run = (D, y, h) => {
        if (D[D.length - 1] - D[0] < 0.12) return;
        for (let i = 0; i + 1 < D.length; i++) wood.bar(at(s, D[i], y), at(s, D[i + 1], y), E.w, h, i ? null : ends);
      };
      const lift = R.liftUnder(Math.abs(s) / f.L0, 0), d0 = dF - 0.06, d1 = Math.min(dIn, dh - 0.16);
      run([0.04, Math.min(dF, dh - 0.14)], fly, E.fly);
      run([d0, ...(lift > 0.25 && d1 > dP ? [(d0 + dP) / 2] : []), ...(lift > 0.03 && d1 > dP + 0.2 ? [dP] : []), d1], base, E.base);
    }
    // the eave purlin, level, carrying the base rafters
    const yp = base(dP) - E.base - E.purlin / 2, Lp = L(dP);
    k.beam(f.P(-Lp, dP, yp), f.P(Lp, dP, yp), 0.2, E.purlin, WOOD);
    // the hip rafter at the face's +s end, in two tiers as the rafters
    const hip = (d, y, drop) => f.P(L(d), d, y(d) + R.liftUnder(1, d) + drop);
    const tier = (d0, d1, y, h, segs, cap) => {
      const P = Array.from({ length: segs + 1 }, (_, i) => hip(lerp(d0, d1, i / segs), y, 0.04));
      for (let i = 0; i < segs; i++) wood.bar(P[i], P[i + 1], 0.22, h, i ? null : cap);
    };
    tier(-0.32, dF, fly, E.fly + 0.12, 3, caps);
    tier(dF - 0.12, dIn, base, E.base + 0.14, 3, ends);
    if (bells) {
      const p = hip(-0.26, fly, 0.04 - E.fly - 0.12);
      k.at(p.x, p.y, p.z, 0, () => k.lathe([[0, -0.5], [0.12, -0.5], [0.13, -0.45], [0.1, -0.2], [0.03, -0.15], [0.02, 0], [0, 0]], 6, BRONZE));
    }
  }
  // a ceiling over what the boards leave open inside them (seen in the open belfry)
  const cx = R.faces[0].L0 - dIn, cz = R.faces[1].L0 - dIn, yc = base(dIn);
  if (cx > 0 && cz > 0) wood.q(new V(-cx, yc, -cz), new V(cx, yc, -cz), new V(cx, yc, cz), new V(-cx, yc, cz), new V(0, -1, 0));
  wood.add(k, WOOD); ends.add(k, ENDS); caps.add(k, BRONZE);
}

// A bracket set (tokyō) on a post at the origin, its arms stepping out `steps` times `st` along +z, each step an arm
// carrying a crosswise arm with three blocks; on a corner post (the walls running along +x and -z) the arms step out
// along the diagonal and the crosswise ones run along both walls.
function tokyo(k, steps, st, corner) {
  const T = TOKYO, bh = T.step - T.arm;
  k.box(0.56, T.daito, 0.56, 0, T.daito / 2, 0, WOOD);
  for (let j = 1; j <= steps; j++) {
    const y = T.daito + (j - 1) * T.step, ya = y + T.arm / 2, yb = y + T.arm + bh / 2, o = j * st;
    const block = (x, z) => k.box(0.2, bh, 0.2, x, yb, z, WOOD);
    if (!corner) {
      k.box(0.15, T.arm, o + 0.45, 0, ya, (o - 0.15) / 2, WOOD);
      k.box(1.0, T.arm, 0.14, 0, ya, o, WOOD);
      for (const x of [-0.4, 0, 0.4]) block(x, o);
    } else {
      k.beam(new V(0.2, ya, -0.2), new V(-o - 0.12, ya, o + 0.12), 0.16, T.arm, WOOD);
      k.box(o + 0.65, T.arm, 0.14, (0.5 - o - 0.15) / 2, ya, o, WOOD);
      k.box(0.14, T.arm, o + 0.65, -o, ya, (o + 0.15 - 0.5) / 2, WOOD);
      block(-o, o); block(0.4, o); block(-o, -0.4);
    }
  }
}

// A hipped roof on bracket sets over walls ±hx × ±hz topped at Y, bx × bz bays (a set on every bay line; corner sets
// on the corners): `steps` courses of brackets each `st` further out, carrying the eave purlin and the double rafters;
// the eaves `over` beyond the walls, the flying rafters the outer dF of it; H, kick, sweep, ridge, gable as roofShape's
// and hipRoof's. The tiles' edge comes out where the courses and the rafters put it. Returns { y0: that edge, top,
// R: the roof's shape, under(d): the rafters' underside d in from the eave's middle }.
function roof(k, { Y, hx, hz, bx, bz, steps, st, over, dF, H, kick, sweep, ridge = 0, gable = 0, bells = false }) {
  const E = EAVE, dP = over - steps * st;
  const y0 = Y + TOKYO.daito + steps * TOKYO.step + E.purlin + E.edge - dF * E.pF + E.fly + E.kioi - (dP - dF) * E.pB + E.base;
  const sides = [[-hx, hz, 1, 0, 2 * hx, bx], [hx, hz, 0, -1, 2 * hz, bz], [hx, -hz, -1, 0, 2 * hx, bx], [-hx, -hz, 0, 1, 2 * hz, bz]];
  for (const [ox, oz, tx, tz, L, nb] of sides) {
    for (let j = 0; j < nb; j++) k.at(ox + (tx * L * j) / nb, Y, oz + (tz * L * j) / nb, Math.atan2(-tz, tx), () => tokyo(k, steps, st, j === 0));
    // in the wall's plane, an arm along the whole side at every course, a block on it in the middle of each bay
    k.at(ox + (tx * L) / 2, Y, oz + (tz * L) / 2, Math.atan2(-tz, tx), () => {
      for (let j = 0; j < steps; j++) {
        const y = TOKYO.daito + j * TOKYO.step;
        k.box(L + 0.3, TOKYO.arm, 0.14, 0, y + TOKYO.arm / 2, 0, WOOD);
        for (let i = 0; i < nb; i++) k.box(0.2, TOKYO.step - TOKYO.arm, 0.2, ((i + 0.5) / nb - 0.5) * L, y + (TOKYO.step + TOKYO.arm) / 2, 0, WOOD);
      }
    });
  }
  const R = roofShape({ y0, a: hx + over, b: hz + over, H, kick, ridge, sweep, dP });
  eaves(k, R, { dF, dP, dIn: over + 0.4, bells });
  const top = hipRoof(k, R, { gable });
  const under = (d) => (d <= dF ? y0 - E.edge + d * E.pF - E.fly : y0 - E.edge + dF * E.pF - E.fly - E.kioi + (d - dF) * E.pB - E.base);
  return { y0, top, R, under };
}

// Timber-framed walls ±hx × ±hz from y, h tall: posts on the bay lines, plaster between, tie beams. fill(side, bay)
// picks each bay's infill: 'door' (plank), 'glow' (lattice doors over paper, lit from inside), 'window' (slatted).
// Sides: 0 front (+z), 1 right, 2 back, 3 left, bays counted clockwise seen from above.
function body(k, hx, hz, y, h, bx, bz, fill, core = 0) {
  k.box(2 * hx, h + core, 2 * hz, 0, y + (h + core) / 2, 0, PLASTER);
  const sides = [[-hx, hz, 1, 0, 2 * hx, bx], [hx, hz, 0, -1, 2 * hz, bz], [hx, -hz, -1, 0, 2 * hx, bx], [-hx, -hz, 0, 1, 2 * hz, bz]];
  sides.forEach(([ox, oz, tx, tz, L, nb], si) => {
    const nx = -tz, nz = tx, ry = Math.atan2(nx, nz);
    const P = (s, o) => [ox + tx * s + nx * o, oz + tz * s + nz * o];
    for (let j = 0; j < nb; j++) { const [px, pz] = P((L * j) / nb, 0.02); k.box(0.36, h, 0.36, px, y + h / 2, pz, WOOD); }
    for (const [yy, hh] of [[0.3, 0.3], [h - 0.25, 0.26], [h * 0.62, 0.16]]) { const [px, pz] = P(L / 2, 0.1); k.box(L + 0.36, hh, 0.14, px, y + yy, pz, WOOD, ry); }
    for (let j = 0; j < nb; j++) {
      const kind = fill(si, j), w = L / nb - 0.36;
      const [cx, cz] = P((L * (j + 0.5)) / nb, 0);
      const at = (o) => [cx + nx * o, cz + nz * o];
      if (kind === 'door') {
        const [px, pz] = at(0.07); k.box(w * 0.9, h * 0.58, 0.1, px, y + 0.45 + h * 0.29, pz, WOOD_D, ry);
      } else if (kind === 'glow') {
        const dh = h * 0.56, y0 = y + 0.45;
        const [px, pz] = at(0.04); k.box(w, dh, 0.06, px, y0 + dh / 2, pz, PAPER, ry, 1);
        const [lx, lz] = at(0.1);
        const nv = Math.round(w / 0.3), nh = Math.round(dh / 0.3);
        for (let i = 1; i < nv; i++) { const s = (i / nv - 0.5) * w; k.box(0.05, dh, 0.05, lx + tx * s, y0 + dh / 2, lz + tz * s, WOOD_D, ry); }
        for (let i = 1; i < nh; i++) k.box(w, 0.05, 0.05, lx, y0 + (i * dh) / nh, lz, WOOD_D, ry);
        k.box(0.07, dh, 0.07, lx, y0 + dh / 2, lz, WOOD_D, ry);
      } else if (kind === 'window') {
        const wy = y + h * 0.38;
        const [px, pz] = at(0.05); k.box(w * 0.6, h * 0.22, 0.08, px, wy, pz, WOOD_D, ry);
        const [lx, lz] = at(0.1);
        for (let i = 0; i < 7; i++) { const s = ((i + 0.5) / 7 - 0.5) * w * 0.56; k.box(0.07, h * 0.2, 0.07, lx + tx * s, wy, lz + tz * s, WOOD, ry); }
      }
    }
  });
}

// the balcony round an upper storey of the pagoda
function balcony(k, s, y) {
  const r = s + 0.85;
  k.box(2 * r, 0.18, 2 * r, 0, y - 0.09, 0, WOOD);
  for (const [ry, sx, sz] of [[0, 0, 1], [0, 0, -1], [Math.PI / 2, 1, 0], [Math.PI / 2, -1, 0]]) {
    for (const yy of [0.4, 0.8]) k.box(2 * r, 0.08, 0.08, sx * r, y + yy, sz * r, WOOD, ry);
    for (let i = 0; i <= 6; i++) { const t = (i / 6 - 0.5) * 2 * r; k.box(0.1, 0.85, 0.1, sx * r + Math.abs(sz) * t, y + 0.42, sz * r + Math.abs(sx) * t, WOOD); }
  }
}

// stone's colour a shade lighter or darker, by between lo and lo + span (one draw: the hue stays)
const toned = (rng, lo, span) => { const t = lo + rng() * span; return STONE.map((v) => v * t); };
// a cut stone in its own tone, tagged by hand (its colour is not the palette's): dressed (CARVED) or built stone
const stone = (k, rng, w, h, d, x, y, z, ry = 0, m = 1, kind = KIND.CARVED) => k.box(w, h, d, x, y, z, toned(rng, 0.86 * m, 0.26 * m), ry, 0, kind);

// A platform of dressed stone (kidan) ±w × ±d, its top at h: a dark core showing in the joints, face slabs set back
// between posts, a coping overhanging the face, and the top paved in squares outside ±pw × ±pd (where nothing stands
// on it).
function kidan(k, rng, w, d, h, pw = 0, pd = 0) {
  k.box(2 * w - 0.1, h - 0.02, 2 * d - 0.1, 0, (h - 0.02) / 2, 0, STONE_D, 0, 0, KIND.CARVED);
  const cap = Math.min(0.22, h * 0.25), hs = h - cap;
  const sides = [[-w, d, 1, 0, 2 * w], [w, d, 0, -1, 2 * d], [w, -d, -1, 0, 2 * w], [-w, -d, 0, 1, 2 * d]];
  for (const [ox, oz, tx, tz, L] of sides) {
    const nx = -tz, nz = tx, ry = Math.atan2(nx, nz);
    // a stone along the face from s0 to s1, its front o out from the face, bd deep, its top at y
    const put = (s0, s1, o, bh, bd, y, m) => { const c = (s0 + s1) / 2, oc = o - bd / 2; stone(k, rng, s1 - s0 - 0.03, bh, bd, ox + tx * c + nx * oc, y - bh / 2, oz + tz * c + nz * oc, ry, m); };
    const n = Math.max(1, Math.round(L / 1.8));
    const post = (i) => [Math.max(0, (L * i) / n - 0.14 - (i === n) * 0.16), Math.min(L, (L * i) / n + 0.14 + !i * 0.16)];
    for (let i = 0; i <= n; i++) put(...post(i), 0, hs, 0.24, h - cap, 1.04);
    for (let i = 0; i < n; i++) put(post(i)[1], post(i + 1)[0], -0.025, hs - 0.02, 0.2, h - cap - 0.01, 0.97);
    for (let s = -0.07; s < L - 0.05;) { const e = Math.min(L, s + 0.9 + rng() * 0.9); put(s, e, 0.07, cap, 0.55, h, 1.12); s = e; }
  }
  const q = 0.9, x0 = w - 0.48, z0 = d - 0.48, nx = Math.round((2 * x0) / q), nz = Math.round((2 * z0) / q);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x = -x0 + ((i + 0.5) * 2 * x0) / nx, z = -z0 + ((j + 0.5) * 2 * z0) / nz;
    if (Math.abs(x) < pw && Math.abs(z) < pd) continue;
    k.add(new THREE.PlaneGeometry((2 * x0) / nx - 0.04, (2 * z0) / nz - 0.04).rotateX(-Math.PI / 2).translate(x, h - 0.01, z), toned(rng, 0.95, 0.22), 0, KIND.CARVED);
  }
}

function pagoda(k) {
  const rng = mulberry32(5);
  kidan(k, rng, 5.8, 5.8, 1.0, 3.3, 3.3);
  for (let j = 0; j < 3; j++) { const hh = 0.75 - 0.25 * j; stone(k, rng, 2.8, hh, 0.4, 0, hh / 2, 6.0 + 0.4 * j); }
  // storeys diminishing upwards, each on three stepped bracket courses (mitesaki) under double-raftered eaves
  const S = [3.4, 3.1, 2.8, 2.5, 2.2];
  let y = 1.0;
  for (let i = 0; i < 5; i++) {
    const s = S[i], h = i ? 1.9 : 3.0, a = s + 2.5, last = i === 4;
    if (i) balcony(k, s, y);
    const r = roof(k, { Y: y + h, hx: s, hz: s, bx: 3, bz: 3, steps: 3, st: 0.35, over: 2.5, dF: 0.65, H: last ? 3.2 : (5.8 * a) / 5.9, sweep: last ? 0.4 : 0.69, kick: 0.18 * a, bells: true });
    body(k, s, s, y, h, 3, 3, (side, j) => (j === 1 ? 'door' : i === 0 ? 'window' : 'wall'), r.y0 - y - h + 0.5);
    if (!last) y = r.y0 + r.R.rise(1 - (S[i + 1] + 0.85) / a) + 0.12;
    else sorin(k, r.top - 0.3);
  }
}

// the bronze finial: base, inverted bowl, nine rings, the water-flame openwork and the jewel
function sorin(k, y) {
  k.box(1.5, 0.5, 1.5, 0, y + 0.25, 0, BRONZE);
  k.lathe([[0, 0], [0.75, 0], [0.72, 0.3], [0.5, 0.52], [0, 0.56]], 12, BRONZE, y + 0.5);
  const P = [[0, 1.0], [0.14, 1.0]];
  for (let i = 0; i < 9; i++) { const yy = 1.25 + i * 0.5, r = 0.55 - i * 0.02; P.push([0.14, yy], [r, yy + 0.06], [r, yy + 0.18], [0.14, yy + 0.24]); }
  P.push([0.12, 6.0], [0.12, 7.3], [0, 7.3]);
  k.lathe(P, 12, BRONZE, y);
  k.box(1.0, 1.1, 0.05, 0, y + 6.25, 0, BRONZE); k.box(0.05, 1.1, 1.0, 0, y + 6.25, 0, BRONZE);
  k.lathe([[0, 0], [0.2, 0.08], [0.26, 0.26], [0.2, 0.44], [0, 0.5]], 10, BRONZE, y + 6.9);
  k.lathe([[0, 0], [0.16, 0.08], [0.19, 0.22], [0.1, 0.4], [0, 0.55]], 10, BRONZE, y + 7.4);
}

// a lantern's hexagonal cap from y, R across the corners, with the corners kicked up
function kasa(k, R, H, y, c) {
  k.lathe([[0, -0.05], [R * 0.98, -0.05], [R, 0.04], [R * 0.75, H * 0.28], [R * 0.3, H * 0.75], [0, H]], 6, c, y);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; k.box(R * 0.14, R * 0.2, R * 0.14, Math.sin(a) * R * 0.96, y + R * 0.08, Math.cos(a) * R * 0.96, c, a); }
}

// hanging bronze lantern (tsuri-dōrō); yTop is where its chain is fixed
function tsuri(k, x, yTop, z) {
  k.at(x, yTop, z, 0, () => {
    k.box(0.04, 0.5, 0.04, 0, -0.25, 0, BRONZE_D);
    kasa(k, 0.36, 0.24, -0.74, BRONZE);
    k.lathe([[0, -1.2], [0.2, -1.2], [0.23, -0.74], [0, -0.74]], 6, PAPER, 0, 0, 1.6);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; k.box(0.04, 0.46, 0.04, Math.sin(a) * 0.23, -0.97, Math.cos(a) * 0.23, BRONZE); }
    k.lathe([[0, -1.3], [0.25, -1.26], [0.22, -1.2], [0, -1.2]], 6, BRONZE);
    k.lamps.push(new V(0, -0.97, 0));
  });
}

// stone lantern (Kasuga form) standing at (x, y, z) (village.js lines the approach with them)
export function toro(k, x, y, z, ry = 0) {
  k.at(x, y, z, ry, () => {
    k.lathe([[0, 0], [0.42, 0], [0.42, 0.12], [0.34, 0.2], [0.2, 0.26], [0, 0.26]], 6, STONE);
    k.lathe([[0, 0.26], [0.14, 0.26], [0.12, 1.02], [0, 1.02]], 8, STONE);
    k.lathe([[0, 1.02], [0.2, 1.02], [0.36, 1.14], [0.36, 1.22], [0, 1.22]], 6, STONE);
    k.lathe([[0, 1.22], [0.21, 1.22], [0.21, 1.6], [0, 1.6]], 6, FIREBOX, 0, Math.PI / 6, 2.2);
    for (let i = 0; i < 6; i++) { const a = ((i + 0.5) / 6) * Math.PI * 2; k.box(0.08, 0.38, 0.08, Math.sin(a) * 0.24, 1.41, Math.cos(a) * 0.24, STONE); }
    kasa(k, 0.62, 0.36, 1.6, STONE);
    k.lathe([[0, 0], [0.1, 0.02], [0.13, 0.1], [0.08, 0.2], [0, 0.28]], 8, STONE, 1.9);
    k.lamps.push(new V(0, 1.41, 0));
  });
}

function hall(k) {
  // stone podium with a landing and steps at the front, raised floor with a veranda, wooden steps up to it
  const rng = mulberry32(6);
  kidan(k, rng, 8, 6.4, 0.8, 7.2, 5.6);
  stone(k, rng, 4.4, 0.8, 1.2, 0, 0.4, 7.0);
  for (let j = 0; j < 2; j++) { const hh = (0.8 * (2 - j)) / 3; stone(k, rng, 4.4, hh, 0.45, 0, hh / 2, 7.82 + 0.45 * j); }
  const y0 = 1.5, h = 3.6;
  k.box(14.4, 0.7, 11.2, 0, 1.15, 0, WOOD_D);
  k.box(15.2, 0.16, 12.0, 0, y0 - 0.08, 0, WOOD);
  for (let j = 0; j < 3; j++) { const t = y0 - 0.18 * (j + 1); k.box(3.6, t - 0.8, 0.3, 0, (t + 0.8) / 2, 6.15 + 0.3 * j, WOOD); }
  // two stepped bracket courses (futatesaki) under double-raftered eaves
  const r = roof(k, { Y: y0 + h, hx: 6.2, hz: 4.4, bx: 5, bz: 4, steps: 2, st: 0.4, over: 3.0, dF: 0.8, H: 6.8, sweep: 0.55, kick: 0.9, ridge: 2.0, gable: 0.55 });
  body(k, 6.2, 4.4, y0, h, 5, 4, (side, j) => {
    if (side === 0) return j >= 1 && j <= 3 ? 'glow' : 'window';
    if ((side === 1 && j === 0) || (side === 3 && j === 3)) return 'glow';
    return side === 2 && j === 2 ? 'door' : 'wall';
  }, r.y0 - y0 - h + 0.5);
  // veranda railing, open at the front steps
  for (const s of [1, -1]) {
    k.box(5.6, 0.08, 0.08, s * 4.8, y0 + 0.75, 5.95, WOOD);
    k.box(0.08, 0.08, 11.9, s * 7.55, y0 + 0.75, 0, WOOD);
    for (let i = 0; i <= 4; i++) k.box(0.1, 0.8, 0.1, s * (2.0 + i * 1.39), y0 + 0.4, 5.95, WOOD);
    for (let i = 0; i <= 6; i++) k.box(0.1, 0.8, 0.1, s * 7.55, y0 + 0.4, -5.95 + i * 1.98, WOOD);
  }
  for (const x of [-2.6, 2.6]) tsuri(k, x, r.under(7.4 - 5.5), 5.5);
}

// bell tower: boarded splayed skirt, open upper storey with the bell and its striking log
function belfry(k) {
  kidan(k, mulberry32(7), 2.8, 2.8, 0.8, 2.35, 2.35);
  k.lathe([[0, 0.8], [2.35 * Math.SQRT2, 0.8], [1.95 * Math.SQRT2, 3.0], [0, 3.0]], 4, WOOD, 0, Math.PI / 4);
  for (let i = 0; i < 9; i++) for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const t = (i / 8 - 0.5) * 3.8;
    k.beam(new V(sx * 2.37 + sz * t * 1.2, 0.8, sz * 2.37 + sx * t * 1.2), new V(sx * 1.97 + sz * t, 3.0, sz * 1.97 + sx * t), 0.06, 0.06, WOOD_D);
  }
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) k.beam(new V(sx * 1.95, 3.0, sz * 1.95), new V(sx * 1.75, 6.4, sz * 1.75), 0.3, 0.3, WOOD);
  for (const yy of [3.15, 5.9]) {
    k.box(3.8, 0.2, 0.2, 0, yy, 1.8, WOOD); k.box(3.8, 0.2, 0.2, 0, yy, -1.8, WOOD);
    k.box(0.2, 0.2, 3.8, 1.8, yy, 0, WOOD); k.box(0.2, 0.2, 3.8, -1.8, yy, 0, WOOD);
  }
  k.box(3.6, 0.3, 0.3, 0, 6.25, 0, WOOD);
  k.lathe([[0, 0], [0.72, 0], [0.7, 0.15], [0.62, 0.4], [0.6, 1.2], [0.55, 1.45], [0.3, 1.6], [0.12, 1.65], [0.12, 1.85], [0, 1.85]], 16, BRONZE_D, 4.25);
  k.beam(new V(0.85, 4.95, 0), new V(2.5, 4.95, 0), 0.24, 0.24, WOOD);
  for (const x of [1.2, 2.2]) k.box(0.03, 1.2, 0.03, x, 5.6, 0, ENDS);
  // one bracket course (demitsudo) on the posts and between them, double-raftered eaves
  roof(k, { Y: 6.4, hx: 1.75, hz: 1.75, bx: 2, bz: 2, steps: 1, st: 0.35, over: 2.15, dF: 0.6, H: 3.9, sweep: 0.55, kick: 0.6, ridge: 1.2, gable: 0.5 });
}

// earthen boundary wall (tsuiji): ochre with five white lines, tiled coping
function tsuiji(k, x0, z0, x1, z1) {
  const L = Math.hypot(x1 - x0, z1 - z0);
  k.at((x0 + x1) / 2, 0, (z0 + z1) / 2, Math.atan2(-(z1 - z0), x1 - x0), () => {
    k.box(L, 0.35, 0.95, 0, 0.175, 0, STONE);
    k.box(L, 2.1, 0.7, 0, 1.4, 0, OCHRE);
    for (let l = 0; l < 5; l++) k.box(L, 0.06, 0.74, 0, 1.4 + l * 0.2, 0, PLASTER);
    for (const s of [1, -1]) k.add(new THREE.BoxGeometry(L + 0.3, 0.12, 0.72).rotateX(s * 0.45).translate(0, 2.6, s * 0.3), TILE);
    k.box(L + 0.35, 0.22, 0.28, 0, 2.8, 0, TILE_D);
  });
}

// Where things stand in the temple's frame (walk.js walks the steps and the terrace round them): the steps down the
// terrace's front, centred on x, from `first` past its edge down `rise` per tread `run` deep, `hw` half-wide between
// low walls `wall` out from the middle; the buildings' centres on the terrace, [x, y, z].
export const STAIR = { x: -7, first: 0.2, run: 0.42, rise: 0.2, hw: 1.7, wall: 1.92 };
export const SITES = { hall: [-7, 0, -4], pagoda: [8.5, 0, 3], belfry: [-13.5, 0, 8.5] };

// The compound in the temple's frame (+z faces the river side, y = 0 is the terrace top); ground(x, z) is the terrain
// height in that frame. The terrace's stone walls (ishigaki) and the steps down from it run to the ground.
function compound(k, T, ground) {
  const rng = mulberry32(88), shade = mulberry32(89);
  const W = T.hw, D = T.hd;
  // the gravel, up to the kerb's inner edge (under it by a few cm), the kerb a little proud of it: coplanar, the two
  // fought in the depth buffer and the edge shimmered underfoot
  k.box(2 * W - 1.44, 0.4, 2 * D - 1.44, 0, -0.2, 0, GRAVEL);
  const sides = [[-W, D, 1, 0, 2 * W], [W, D, 0, -1, 2 * D], [W, -D, -1, 0, 2 * W], [-W, -D, 0, 1, 2 * D]];
  for (const [ox, oz, tx, tz, L] of sides) {
    const nx = -tz, nz = tx, ry = Math.atan2(nx, nz); // outward
    for (let s = 0; s < L;) { const w = Math.min(1.6 + rng() * 0.8, L - s); const c = s + w / 2; stone(k, shade, w - 0.05, 0.365, 0.8, ox + tx * c - nx * 0.35, -0.1675, oz + tz * c - nz * 0.35, ry, 1.12, KIND.STONE); s += w; }
    // courses of rough blocks of uneven size down to the ground, battered in a curve that steepens towards the top,
    // each block set a little proud or back, mossier low down
    for (let r = 1, top = -0.35; r < 24; r++) {
      const ch = 0.42 + rng() * 0.3, d = -top + ch / 2, out = -0.4 + 0.1 * d + 0.012 * d * d;
      let any = false;
      for (let s = -rng() * 0.8; s < L;) {
        const w = 0.7 + rng() * 1.2, c = Math.max(0, Math.min(L, s + w / 2)), ww = Math.min(s + w, L) - Math.max(s, 0);
        const o = out + (rng() - 0.5) * 0.08, px = ox + tx * c + nx * o, pz = oz + tz * c + nz * o;
        s += w;
        if (top < ground(px, pz) - 0.2 || ww < 0.3) continue;
        any = true;
        const tone = 0.72 + rng() * 0.45, warm = (rng() - 0.5) * 0.04, moss = rng() * 0.1 + Math.min(0.12, d * 0.012);
        // leaning back with the batter, so the face runs on up the wall instead of stepping out in ledges
        k.add(new THREE.BoxGeometry(ww - 0.05, ch - 0.04 - rng() * 0.07, 0.9).rotateX(-Math.atan(0.1 + 0.024 * d)).rotateY(ry + (rng() - 0.5) * 0.06)
          .translate(px, top - ch / 2 + (rng() - 0.5) * 0.05, pz), [STONE[0] * tone + warm - moss * 0.3, STONE[1] * tone, STONE[2] * tone - warm - moss * 0.5], 0, KIND.STONE);
      }
      top -= ch;
      if (!any) break;
    }
  }
  // stone steps down the front, lanterns at their foot
  const { x: sx, first, run, rise } = STAIR;
  let zf = D + 0.4;
  for (let j = 0; j < 60; j++) {
    const z = D + first + run * (j + 0.5), y = -rise * (j + 1), g = Math.min(ground(sx, z), y) - 0.4;
    k.box(2 * STAIR.hw, y - g, run + 0.04, sx, (y + g) / 2, z, toned(rng, 0.95, 0.15), 0, 0, KIND.STONE);
    for (const s of [1, -1]) k.box(0.45, y - g + 0.25, run + 0.04, sx + s * STAIR.wall, (y + g + 0.25) / 2, z, STONE);
    zf = z + run / 2;
    if (ground(sx, z + run) >= y - rise) break;
  }
  for (const s of [1, -1]) toro(k, sx + s * 2.6, ground(sx + s * 2.6, zf + 0.9) - 0.05, zf + 0.9);
  // flagstone paths to the hall and to the pagoda
  for (let z = D - 0.6; z > 4.8; z -= 0.95) k.box(2.8, 0.1, 0.88, sx, 0.02, z, toned(rng, 1.05, 0.1), (rng() - 0.5) * 0.03, 0, KIND.STONE);
  for (let x = sx + 2.2; x < 8.5; x += 0.95) k.box(0.88, 0.1, 1.6, x, 0.02, 10.8, toned(rng, 1.05, 0.1), (rng() - 0.5) * 0.03, 0, KIND.STONE);
  for (const s of [1, -1]) { toro(k, sx + s * 2.6, 0, 8.2); toro(k, sx + s * 2.6, 0, 4.8); toro(k, 8.5 + s * 3.2, 0, 9.4); }
  k.at(...SITES.hall, 0, () => hall(k));
  k.at(...SITES.pagoda, 0, () => k.paint([[WOOD, SHU], [WOOD_D, SHU_D]], () => pagoda(k)));
  k.at(...SITES.belfry, 0, () => belfry(k));
  tsuiji(k, -W + 0.4, -D + 0.4, W - 0.4, -D + 0.4);
  for (const s of [1, -1]) tsuiji(k, s * (W - 0.4), -D + 0.4, s * (W - 0.4), -1);
  // floodlights hidden in the gravel round the pagoda
  return [[8.5 + 6.5, 3 + 6.5], [8.5 - 6.5, 3 + 6.5], [8.5 + 6.5, 3 - 6.5], [8.5 - 6.5, 3 - 6.5]].map(([x, z]) => new V(x, 0.2, z));
}

// Sky light in the vertex colours: how much of the sky each vertex sees past the roofs, walls and lanterns (the
// temple casts no shadows, so without it the walls under the eaves are lit like the ridges). The compound is
// rasterized top-down into a height map (each triangle's top over its footprint, CELL metres), then from each
// vertex rays towards DIRS points of the sky march through it; the walls in the eaves' shade see little of it.
const CELL = 0.3, DIRS = 20, STEPS = [0.25, 0.5, 0.8, 1.2, 1.7, 2.4, 3.3, 4.5, 6.2, 8.5];
export function skyLight(parts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, top = -Infinity;
  for (const g of parts) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 2]); z1 = Math.max(z1, p[i + 2]); top = Math.max(top, p[i + 1]);
    }
  }
  const nx = Math.ceil((x1 - x0) / CELL) + 1, nz = Math.ceil((z1 - z0) / CELL) + 1, H = new Float32Array(nx * nz).fill(-Infinity);
  for (const g of parts) {
    const p = g.attributes.position.array, I = g.index.array;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const y = Math.max(p[a + 1], p[b + 1], p[c + 1]);
      const i0 = Math.floor((Math.min(p[a], p[b], p[c]) - x0) / CELL), i1 = Math.floor((Math.max(p[a], p[b], p[c]) - x0) / CELL);
      const j0 = Math.floor((Math.min(p[a + 2], p[b + 2], p[c + 2]) - z0) / CELL), j1 = Math.floor((Math.max(p[a + 2], p[b + 2], p[c + 2]) - z0) / CELL);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (H[j * nx + i] < y) H[j * nx + i] = y;
    }
  }
  const at = (x, z) => {
    const i = Math.floor((x - x0) / CELL), j = Math.floor((z - z0) / CELL);
    return i < 0 || j < 0 || i >= nx || j >= nz ? -Infinity : H[j * nx + i];
  };
  // the sky's points, spread evenly over the upper hemisphere (none right on the horizon)
  const D = [];
  for (let i = 0; i < DIRS; i++) {
    const y = 0.08 + 0.92 * (i + 0.5) / DIRS, r = Math.sqrt(1 - y * y), a = i * 2.39996;
    D.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  for (const g of parts) {
    const p = g.attributes.position.array, n = g.attributes.normal.array, col = g.attributes.color.array;
    for (let v = 0; v < p.length; v += 3) {
      const ox = p[v] + n[v] * 0.08, oy = p[v + 1] + n[v + 1] * 0.08, oz = p[v + 2] + n[v + 2] * 0.08;
      let sum = 0, seen = 0;
      for (const [dx, dy, dz] of D) {
        const w = dx * n[v] + dy * n[v + 1] + dz * n[v + 2];
        if (w <= 0) continue;
        sum += w;
        let open = 1;
        for (const s of STEPS) {
          const y = oy + dy * s;
          if (y > top) break;
          if (at(ox + dx * s, oz + dz * s) > y) { open = 0; break; }
        }
        seen += w * open;
      }
      // faces turned down see no sky, only what the ground throws back
      const k = sum > 0 ? 0.5 + 0.5 * seen / sum : 0.5;
      col[v] *= k; col[v + 1] *= k; col[v + 2] *= k;
    }
  }
}

// the temple in world space: one geometry (color, aGlow), its lamp and floodlight positions
export function templeData(world) {
  const T = world.temple;
  const m = new THREE.Matrix4().makeRotationY(T.yaw).setPosition(T.x, T.y, T.z);
  const ground = (x, z) => { const p = new V(x, 0, z).applyMatrix4(m); return world.height(p.x, p.z) - T.y; };
  const k = kit();
  const flood = compound(k, T, ground);
  tagKinds(k.parts, KINDS);
  skyLight(k.parts);
  for (const g of k.parts) g.applyMatrix4(m);
  const flat = (list) => new Float32Array(list.flatMap((p) => p.applyMatrix4(m).toArray()));
  return { geo: mergeGeometries(k.parts), lamps: flat(k.lamps), flood: flat(flood) };
}

export function makeTemple(d, mat) {
  const mesh = new THREE.Mesh(d.geo, mat);
  mesh.castShadow = false; mesh.receiveShadow = true;
  return mesh;
}
