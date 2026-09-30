// Grass clumps, wildflowers, rocks & pebbles, the gorge's rock walls, the woods on the hills — all instanced
import * as THREE from 'three';
import { mulberry32, makeNoise, clamp, lerp, smoothstep } from './noise.js';

const V = THREE.Vector3;

// ---------- grass ----------
// blade height, base half-width and lean: [min, spread]; spread: clump radius
const TALL = { blades: 5, segs: 4, spread: 0.13, h: [0.65, 0.45], w: [0.038, 0.022], lean: [0.12, 0.35] };
// the deer's cropped turf: many thin, short, upright blades
const TURF = { blades: 6, segs: 2, spread: 0.09, h: [0.1, 0.12], w: [0.008, 0.006], lean: [0.04, 0.16] };

// `wScale` widens every blade (the one-segment far version: its straight taper is ~15% thinner than the curved one)
function grassClumpGeometry(rng, { blades, segs, spread, h: H, w: W, lean: L } = TALL, wScale = 1) {
  const P = [], Nn = [], F = [], C = [], I = [];
  let base = 0;
  for (let b = 0; b < blades; b++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * spread;
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const yaw = rng() * Math.PI * 2;
    const h = H[0] + rng() * H[1], w = (W[0] + rng() * W[1]) * wScale;
    const lean = L[0] + rng() * L[1];
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const y = t * h;
      const fwd = lean * t * t * h;
      const width = w * (1 - Math.pow(t, 1.4)) + 0.002;
      for (const side of [-1, 1]) {
        const lx = side * width, lz = fwd;
        const x = ox + lx * cy - lz * sy, z = oz + lx * sy + lz * cy;
        P.push(x, y, z);
        // soft normals: mostly up, a little blade facing
        const nx = -sy * 0.35, nz = cy * 0.35;
        const n = new V(nx, 1, nz).normalize();
        Nn.push(n.x, n.y, n.z);
        F.push(Math.pow(t, 1.5) * h * 0.55);
        const shade = lerp(0.35, 1.0, Math.pow(t, 0.8));
        C.push(shade, shade, shade);
      }
    }
    for (let s = 0; s < segs; s++) {
      const a0 = base + s * 2, a1 = a0 + 1, b0 = a0 + 2, b1 = a0 + 3;
      I.push(a0, a1, b0, a1, b1, b0);
    }
    base += (segs + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(F, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  return g;
}

// placement + per-tile instance data (worker-safe)
export function grassData(world, count, opts) {
  const rng = mulberry32(42);
  const nz = makeNoise(77);
  const geo = grassClumpGeometry(rng);
  // far level of detail: the same blades (same rng draws) in one segment each, a quarter of the triangles
  const farGeo = grassClumpGeometry(mulberry32(42), { ...TALL, segs: 1 }, 1.17);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V();
  const col = new THREE.Color();
  const cA = new THREE.Color(0.09, 0.26, 0.05), cB = new THREE.Color(0.24, 0.42, 0.08), cC = new THREE.Color(0.42, 0.42, 0.14), reed = new THREE.Color(0.2, 0.28, 0.08);
  const focus = opts.focus;
  const items = [];
  let tries = 0;
  while (items.length < count && tries < count * 40) {
    tries++;
    const r = Math.pow(rng(), 0.8) * opts.radius;
    const a = rng() * Math.PI * 2;
    const x = focus.x + Math.cos(a) * r * 1.2, z = focus.z + Math.sin(a) * r;
    const y = world.height(x, z);
    if (y < 0.12) continue;
    const ri = world.riverInfo(x, z);
    if (opts.avoid && opts.avoid(x, z)) continue;
    if (opts.turf && opts.turf.density(x, z) > nz.noise2(x * 2.1, z * 2.1) * 0.5 + 0.5) continue; // cropped: turf instead
    const patchN = nz.fbm2(x * 0.08, z * 0.08, 3);
    const lush = clamp(0.6 + patchN * 0.9, 0.15, 1.2);
    if (rng() > 0.35 + lush * 0.6) continue;
    const nearBank = smoothstep(1.35, 1.0, ri.t);
    const hs = lerp(0.35, 0.8, lush) * (1 + nearBank * 0.9 * rng()) * (opts.lawn ? lerp(0.13, 1, opts.lawn(x, z)) : 1);
    p.set(x, y - 0.03, z);
    q.setFromAxisAngle(new V(0, 1, 0), rng() * Math.PI * 2);
    const ws = 0.9 + rng() * 0.6;
    s.set(ws, hs, ws);
    const mm = new THREE.Matrix4().compose(p, q, s);
    const c = cA.clone().lerp(cB, clamp(0.5 + patchN + (rng() - 0.5) * 0.4, 0, 1)).lerp(cC, clamp(nz.noise2(x * 0.03, z * 0.03) * 0.5, 0, 0.5)).lerp(reed, nearBank * 0.6);
    // distance rank: nearer clumps kept first when quality scales grass down
    items.push({ x, z, mm, c, rank: Math.hypot(x - focus.x, z - focus.z) + rng() * 25 });
  }
  // spatial chunks -> real frustum culling
  const T = opts.tile || 14;
  const tiles = new Map();
  for (const it of items) {
    const key = Math.floor(it.x / T) + ',' + Math.floor(it.z / T);
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(it);
  }
  const out = [];
  let total = 0;
  for (const list of tiles.values()) {
    list.sort((a, b) => a.rank - b.rank);
    const mesh = new THREE.InstancedMesh(geo, undefined, list.length);
    list.forEach((it, i) => { mesh.setMatrixAt(i, it.mm); mesh.setColorAt(i, it.c); });
    mesh.computeBoundingSphere();
    const bs = mesh.boundingSphere;
    out.push({ matrix: mesh.instanceMatrix.array, color: mesh.instanceColor.array, n: list.length, bs: [bs.center.x, bs.center.y, bs.center.z, bs.radius + 1.5] });
    total += list.length;
  }
  return { geo, farGeo, tiles: out, total, turf: opts.turf ? turfData(world, opts.turf, nz, cA, cB) : null };
}

// the turf: one instanced draw over the grazing ground's box, as dense as turf.density(x, z) (0..1)
function turfData(world, turf, nz, cA, cB) {
  const rng = mulberry32(43);
  const geo = grassClumpGeometry(rng, TURF);
  const [x0, z0, x1, z1] = turf.box;
  const mesh = new THREE.InstancedMesh(geo, undefined, turf.count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V(), c = new THREE.Color();
  let n = 0;
  for (let tries = 0; n < turf.count && tries < turf.count * 20; tries++) {
    const x = lerp(x0, x1, rng()), z = lerp(z0, z1, rng()), d = turf.density(x, z);
    if (rng() > d) continue;
    p.set(x, world.height(x, z) - 0.02, z);
    q.setFromAxisAngle(new V(0, 1, 0), rng() * Math.PI * 2);
    const ws = 0.8 + rng() * 0.5;
    s.set(ws, lerp(1.4, 0.9, d) * (0.8 + rng() * 0.4), ws); // a little longer where it meets the tall grass
    mesh.setMatrixAt(n, m.compose(p, q, s));
    mesh.setColorAt(n++, c.copy(cA).lerp(cB, clamp(0.65 + nz.fbm2(x * 0.08, z * 0.08, 3) + (rng() - 0.5) * 0.3, 0, 1)));
  }
  mesh.count = n;
  mesh.computeBoundingSphere();
  const bs = mesh.boundingSphere;
  return { geo, matrix: mesh.instanceMatrix.array.slice(0, n * 16), color: mesh.instanceColor.array.slice(0, n * 3), n, bs: [bs.center.x, bs.center.y, bs.center.z, bs.radius + 0.5] };
}

// Each tile is drawn with the full clumps near the camera and with the one-segment ones (farGeo) from FAR metres
// out, where a blade's curve is a few pixels; both meshes share the tile's instance data.
const FAR = 32;
export function makeGrass(data, mat) {
  const group = new THREE.Group();
  const lods = [];
  const add = (geo, t, inst) => {
    const mesh = new THREE.InstancedMesh(geo, mat, t.n);
    mesh.instanceMatrix = inst ? inst.instanceMatrix : new THREE.InstancedBufferAttribute(t.matrix, 16);
    mesh.instanceColor = inst ? inst.instanceColor : new THREE.InstancedBufferAttribute(t.color, 3);
    mesh.boundingSphere = new THREE.Sphere(new V(t.bs[0], t.bs[1], t.bs[2]), t.bs[3]);
    mesh.receiveShadow = true; mesh.castShadow = false;
    mesh.layers.set(1);
    mesh.userData.max = t.n;
    group.add(mesh);
    return mesh;
  };
  for (const t of data.tiles) {
    const near = add(data.geo, t), far = add(data.farGeo, t, near);
    far.visible = false;
    lods.push({ near, far, c: near.boundingSphere.center, r: near.boundingSphere.radius, isFar: false });
  }
  if (data.turf) add(data.turf.geo, data.turf); // short turf: two segments already
  group.userData.total = data.total;
  group.userData.setFraction = (f) => { group.children.forEach((m) => (m.count = Math.max(0, Math.round(m.userData.max * f)))); };
  // pick each tile's level by its nearest point to the camera (2 m of hysteresis); `both` shows both (warm-up)
  group.userData.lod = (cam, both = false) => {
    for (const l of lods) {
      const d = l.c.distanceTo(cam) - l.r;
      l.isFar = l.isFar ? d > FAR - 2 : d > FAR + 2;
      l.near.visible = both || !l.isFar;
      l.far.visible = both || l.isFar;
    }
  };
  return group;
}

// ---------- wildflowers (tiny heads riding above the grass) ----------
export function flowersData(world, count, opts) {
  const rng = mulberry32(9);
  const shape = new THREE.Shape();
  for (let k = 0; k <= 30; k++) {
    const a = (k / 30) * Math.PI * 2;
    const r = 0.03 * (0.55 + 0.45 * Math.pow(Math.abs(Math.cos(a * 2.5)), 0.6));
    if (k === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r); else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const flex = new Float32Array(geo.attributes.position.count).fill(0.32);
  geo.setAttribute('aFlex', new THREE.BufferAttribute(flex, 1));
  const mesh = new THREE.InstancedMesh(geo, undefined, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new V(), p = new V();
  const palette = [new THREE.Color(1, 1, 0.97), new THREE.Color(1, 0.93, 0.55), new THREE.Color(0.8, 0.72, 1.0), new THREE.Color(1, 0.8, 0.88), new THREE.Color(1, 1, 1)];
  let n = 0, tries = 0;
  while (n < count && tries < count * 30) {
    tries++;
    const r = Math.pow(rng(), 0.7) * opts.radius, a = rng() * Math.PI * 2;
    const x = opts.focus.x + Math.cos(a) * r * 1.2, z = opts.focus.z + Math.sin(a) * r;
    const y = world.height(x, z);
    if (y < 0.3) continue;
    if (opts.avoid && opts.avoid(x, z)) continue;
    // clumped
    if (world.N.noise2(x * 0.09 + 3, z * 0.09) < 0.05) continue;
    if (opts.lawn && opts.lawn(x, z) < 0.5) continue;
    p.set(x, y + 0.28 + rng() * 0.25, z);
    e.set((rng() - 0.5) * 0.6, rng() * 6.28, (rng() - 0.5) * 0.6);
    q.setFromEuler(e);
    const sc = 0.8 + rng() * 0.7;
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    mesh.setMatrixAt(n, m);
    mesh.setColorAt(n, palette[Math.floor(rng() * palette.length)]);
    n++;
  }
  return { geo, matrix: mesh.instanceMatrix.array, color: mesh.instanceColor.array, count, n };
}

export function makeFlowers(d, mat) {
  const mesh = new THREE.InstancedMesh(d.geo, mat, d.count);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(d.matrix, 16);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(d.color, 3);
  mesh.count = d.n;
  mesh.frustumCulled = false;
  mesh.layers.set(1);
  return mesh;
}

// ---------- rocks ----------
// Boulders along the banks and in the shallows, stones at the water's edge: Blender models (lods.js, tools/rocks.py),
// a boulder about 2.5 × 2.1 × 1.4 round its origin at scale 1, the stone the same shape.
export const ROCK_KINDS = ['rock0', 'rock1', 'rock2', 'rock3', 'rock4'];

// rock/pebble placements; the returned rng continues into rocksData's instancing (same sequence as before)
export function rockPlan(world, tier, treePos) {
  const rng = mulberry32(1234);
  const variants = 5;
  const placements = [];
  const rocksInWater = [];
  const add = (x, z, sc, sink = 0.3, flatten = 1) => {
    const y = world.height(x, z);
    placements.push({ x, y: y - sc * sink, z, sc, flatten, v: Math.floor(rng() * variants), rot: rng() * Math.PI * 2 });
    if (y < 0.15) rocksInWater.push({ x, z, r: sc * 1.1, top: y + sc * (0.65 - sink) }); // top: roughly, see tools/rocks.py
  };
  const zR = [-90, 60];
  // boulders along both banks
  for (let i = 0; i < 70; i++) {
    const z = lerp(zR[0], zR[1], rng());
    const side = rng() < 0.5 ? -1 : 1;
    const rx = world.riverX(z), hw = world.riverHW(z);
    const t = lerp(0.72, 1.3, Math.pow(rng(), 1.4));
    add(rx + side * t * hw, z, 0.35 + Math.pow(rng(), 2) * 1.3, 0.3);
  }
  // stepping stones in the shallows
  for (let i = 0; i < 16; i++) {
    const z = lerp(-60, 40, rng());
    const rx = world.riverX(z), hw = world.riverHW(z);
    const side = rng() < 0.5 ? -1 : 1;
    add(rx + side * lerp(0.25, 0.75, rng()) * hw, z, 0.3 + rng() * 0.55, 0.15);
  }
  // around the tree roots
  for (let i = 0; i < 7; i++) {
    const a = rng() * 6.28, r = 2.2 + rng() * 3.5;
    add(treePos.x + Math.cos(a) * r, treePos.z + Math.sin(a) * r, 0.25 + rng() * 0.5, 0.35);
  }
  // pebbles
  const pebbles = [];
  for (let i = 0; i < (tier === 'low' ? 400 : 900); i++) {
    const z = lerp(-70, 50, rng());
    const rx = world.riverX(z), hw = world.riverHW(z);
    const side = rng() < 0.5 ? -1 : 1;
    const t = lerp(0.55, 1.12, rng());
    const x = rx + side * t * hw;
    const y = world.height(x, z);
    pebbles.push({ x, y: y - 0.02, z, sc: 0.05 + Math.pow(rng(), 2) * 0.18, flatten: 0.7, v: Math.floor(rng() * variants), rot: rng() * 6.28 });
  }
  return { rng, placements, pebbles, rocksInWater };
}

export function rocksData(world, tier, treePos) {
  const { rng, placements, pebbles, rocksInWater } = rockPlan(world, tier, treePos);
  const isPebble = new Set(pebbles);
  const all = placements.concat(pebbles);
  const byV = ROCK_KINDS.map(() => []);
  all.forEach((p) => byV[p.v].push(p));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V();
  const lists = ROCK_KINDS.map(() => ({ m: [], c: [] })), stones = { m: [], c: [] };
  // one pass in the old order, so the rng sequence (and every stone's pose and tint) stays as it was
  byV.forEach((list, vi) => list.forEach((r) => {
    p.set(r.x, r.y, r.z);
    q.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.25, r.rot, (rng() - 0.5) * 0.25));
    s.set(r.sc, r.sc * r.flatten * (0.8 + rng() * 0.4), r.sc);
    m.compose(p, q, s);
    const tint = 0.8 + rng() * 0.35;
    const l = isPebble.has(r) ? stones : lists[vi];
    l.m.push(...m.elements); l.c.push(tint, tint * (0.97 + rng() * 0.05), tint * (0.93 + rng() * 0.08));
  }));
  const data = (l) => ({ matrix: new Float32Array(l.m), color: new Float32Array(l.c), n: l.c.length / 3 });
  return { boulders: lists.map(data), pebbles: data(stones), rocksInWater, blockers: placements };
}

// ---------- the gorge's rock walls ----------
// Where the river cuts through the temple's knoll its banks stand up to 11 m high: bedded rock walls line them,
// overlapping, their feet in the water and their tops at the turf. The walls are Blender models (lods.js,
// tools/cliffs.py): one unit tall and 1.2 wide, the face towards +z leaning back 0.24 per unit of depth.
export const CLIFF_KINDS = ['cliff0', 'cliff1', 'cliff2'];

export function cliffData(world) {
  const rng = mulberry32(808);
  const lists = CLIFF_KINDS.map(() => []);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V(), up = new V(0, 1, 0);
  for (const side of [-1, 1]) {
    for (let z = -100; z > -300;) {
      const rx = world.riverX(z), hw = world.riverHW(z), [fx, fz] = world.flowDir(z);
      const nx = fz * side, nz = -fx * side; // across the river, out of it on this side
      // height from the foot (under the water, at the bed) to just under the turf above the bank, the lowest along the
      // wall's width so it never stands up out of the turf
      const top = (dz) => world.height(rx + nx * 1.35 * hw + fx * dz, z + nz * 1.35 * hw + fz * dz) + 0.9;
      let h = top(0);
      const w = clamp(h * 0.8, 4, 9) * (0.85 + rng() * 0.3);
      h = Math.min(h, top(-w * 0.4), top(w * 0.4));
      if (h > 3) {
        // the foot in the water in front of the bank's straight slope (world.js), the depth scaled so the face leans as it does
        const d = (0.74 + (rng() - 0.5) * 0.03) * hw - 0.4;
        p.set(rx + nx * d, -1.2, z + nz * d);
        q.setFromAxisAngle(up, Math.atan2(-nx, -nz) + (rng() - 0.5) * 0.16);
        s.set(w / 1.2, h, 0.44 * hw / 0.24);
        const t = 0.9 + rng() * 0.2;
        lists[Math.floor(rng() * CLIFF_KINDS.length)].push({ m: m.compose(p, q, s).toArray(), c: [t, t * (0.98 + rng() * 0.04), t * (0.95 + rng() * 0.05)] });
      }
      z -= w * 0.7 * fz;
    }
  }
  return lists.map((list) => ({ matrix: new Float32Array(list.flatMap((c) => c.m)), color: new Float32Array(list.flatMap((c) => c.c)), n: list.length }));
}

// ---------- bamboo ----------
// Groves of moso bamboo behind and beside the temple, as round many old temples: stands of culms (Blender models,
// tools/bamboo.py, one unit tall) close together in a few patches, thinning at their edges, none in front of the
// temple, on the terrace, down in the gorge or on slopes steep enough to show rock.
export const BAMBOO_KINDS = ['bamboo0', 'bamboo1'];

export function bambooData(world) {
  const rng = mulberry32(919), nz = makeNoise(47);
  const T = world.temple, tc = Math.cos(T.yaw), ts = Math.sin(T.yaw);
  const lists = BAMBOO_KINDS.map(() => []), placed = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V(), up = new V(0, 1, 0);
  for (let t = 0; t < 20000 && placed.length < 170; t++) {
    const x = T.x + lerp(-60, 60, rng()), z = T.z + lerp(-60, 60, rng());
    const dx = x - T.x, dz = z - T.z, lz = dx * ts + dz * tc; // +lz: the temple's front, towards the river
    const td = world.templeDist(x, z), ri = world.riverInfo(x, z);
    const dens = smoothstep(4, 7, td) * smoothstep(42, 30, td) * smoothstep(4, -10, lz) * smoothstep(0.0, 0.3, nz.fbm2(x * 0.04, z * 0.04, 2) + 0.15);
    if (rng() > dens || Math.abs(ri.d) < ri.hw * 2 + 5) continue;
    const y = world.height(x, z), e = 3;
    if (Math.hypot(world.height(x + e, z) - world.height(x - e, z), world.height(x, z + e) - world.height(x, z - e)) / (2 * e) > 0.55) continue;
    if (placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < 2.6)) continue;
    placed.push([x, z]);
    const h = lerp(10, 15, rng()) * lerp(0.75, 1, dens);
    p.set(x, y - 0.3, z);
    q.setFromAxisAngle(up, rng() * Math.PI * 2);
    s.set(h, h, h);
    const g = 0.88 + rng() * 0.24;
    lists[Math.floor(rng() * BAMBOO_KINDS.length)].push({ m: m.compose(p, q, s).toArray(), c: [g * (1 + (rng() - 0.5) * 0.1), g, g * 0.95] });
  }
  return lists.map((list) => ({ matrix: new Float32Array(list.flatMap((c) => c.m)), color: new Float32Array(list.flatMap((c) => c.c)), n: list.length }));
}

// ---------- woods on the hills ----------
// A Japanese hillside in spring: dark stands of sugi (cedar) and hinoki (cypress), broadleaf woods in fresh green and
// evergreen oak with wild cherries (yamazakura) flowering pale pink among them, all in groves with meadow between.
// Nothing grows on faces steep enough to show rock; black pines lean out from the cliff rims instead.
// This places them; the kinds are Blender models, one unit tall (lods.js, tools/forest.py).
// kinds: model names and height range (m)
export const FOREST_KINDS = ['sugi', 'hinoki', 'konara', 'kashi', 'cherry', 'pine'];
const SUGI = 0, HINOKI = 1, KONARA = 2, KASHI = 3, CHERRY = 4, PINE = 5;
const HEIGHT = [[18, 8], [15, 8], [11, 6], [10, 5], [10, 6], [9, 4]];

export function forestData(world, count) {
  const rng = mulberry32(555);
  const nz = makeNoise(31);
  const lists = FOREST_KINDS.map(() => []);
  // the ground normal's y over about the terrain mesh's spacing out there (the terrain turns to rock from 0.82 to 0.6)
  const flat = (x, z, e = 5) => {
    const gx = (world.height(x + e, z) - world.height(x - e, z)) / (2 * e), gz = (world.height(x, z + e) - world.height(x, z - e)) / (2 * e);
    return 1 / Math.hypot(gx, gz, 1);
  };
  const grid = new Map(), cell = 8;
  const crowded = (x, z, r) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const t of grid.get(`${cx + i},${cz + j}`) || []) if (Math.hypot(t.x - x, t.z - z) < r) return true;
    return false;
  };
  const add = (k, x, y, z, a, hs = 1) => {
    const t = { x, y, z, a, h: (HEIGHT[k][0] + rng() * HEIGHT[k][1]) * hs };
    lists[k].push(t);
    const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    grid.set(key, [...(grid.get(key) || []), t]);
  };
  let tries = 0, n = 0;
  while (n < count && tries < count * 80) {
    tries++;
    const x = lerp(-560, 560, rng()), z = lerp(-700, 140, rng());
    // groves: dense in their middle, thinning out into the meadow
    const grove = world.grove(x, z);
    if (rng() > grove) continue;
    const y = world.height(x, z);
    if (y < 4 || y > 170 || flat(x, z) < 0.74) continue;
    // cedar and cypress are planted, so they stand in blocks (more of them higher up); broadleaf woods elsewhere
    const cedar = nz.fbm2(x * 0.02 - 7, z * 0.02 + 3, 2) + (y - 40) / 160;
    const r = rng();
    const k = grove < 0.3 ? (r < 0.3 ? CHERRY : KONARA)
      : cedar > 0.12 ? (r < 0.7 && grove > 0.55 ? SUGI : HINOKI) // tall sugi only inside a stand, never alone
      : r < 0.16 ? CHERRY : r < 0.62 ? KONARA : r < 0.85 ? KASHI : HINOKI;
    if (crowded(x, z, k <= HINOKI ? 4.5 : 6.5)) continue;
    // conifers shorter towards a stand's edge, so a stand rises to its middle instead of spikes standing out of it
    add(k, x, y, z, rng() * Math.PI * 2, k <= HINOKI ? lerp(0.65, 1, smoothstep(0.3, 0.9, grove)) : 1);
    n++;
  }
  // black pines on cliff rims: level ground with a drop of several metres just past it, leaning out over it
  for (let t = 0, pines = 0; t < 30000 && pines < 14; t++) {
    const x = lerp(-500, 500, rng()), z = lerp(-520, 150, rng());
    const ri = world.riverInfo(x, z);
    if (Math.abs(ri.d) < ri.hw + 1 || Math.hypot(x + 10, z - 10) < 40 || world.templeDist(x, z) < 3) continue;
    if (flat(x, z, 2) < 0.9) continue;
    const y = world.height(x, z);
    let drop = 0, a = 0;
    for (let i = 0; i < 16; i++) {
      const b = (i / 16) * Math.PI * 2, d = y - world.height(x + Math.cos(b) * 7, z + Math.sin(b) * 7);
      if (d > drop) { drop = d; a = b; }
    }
    if (drop < 6 || y - world.height(x + Math.cos(a) * 14, z + Math.sin(a) * 14) < 5) continue;
    if (lists[PINE].some((p) => Math.hypot(p.x - x, p.z - z) < 25)) continue;
    add(PINE, x, y, z, -a);
    pines++;
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V(), c = new THREE.Color(), up = new V(0, 1, 0);
  const out = lists.map((list) => {
    const matrix = new Float32Array(list.length * 16), color = new Float32Array(list.length * 3);
    list.forEach((t, i) => {
      p.set(t.x, t.y - 0.03 * t.h, t.z);
      q.setFromAxisAngle(up, t.a);
      s.set(t.h * (0.9 + rng() * 0.2), t.h, t.h * (0.9 + rng() * 0.2));
      m.compose(p, q, s).toArray(matrix, i * 16);
      const g = 0.82 + rng() * 0.36, h = (rng() - 0.5) * 0.12;
      c.setRGB(g * (1 + h), g, g * (1 - h)).toArray(color, i * 3);
    });
    return { matrix, color, n: list.length };
  });
  return out;
}
