// The deer's turf, wildflowers, rocks & pebbles, the farmhouses' dry-stone walls, the gorge's rock walls, the woods on the hills
import * as THREE from 'three';
import { mulberry32, makeNoise, clamp, lerp, smoothstep } from './noise.js';
import { WALL } from './world.js';
import { toroSites } from './village.js';

const V = THREE.Vector3;

// ---------- grass ----------
// the deer's cropped turf: many thin, short, upright blades (height, base half-width and lean: [min, spread];
// spread: clump radius)
const TURF = { blades: 6, segs: 2, spread: 0.09, h: [0.1, 0.12], w: [0.008, 0.006], lean: [0.04, 0.16] };

function grassClumpGeometry(rng, { blades, segs, spread, h: H, w: W, lean: L }) {
  const P = [], Nn = [], F = [], C = [], I = [];
  let base = 0;
  for (let b = 0; b < blades; b++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * spread;
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const yaw = rng() * Math.PI * 2;
    const h = H[0] + rng() * H[1], w = W[0] + rng() * W[1];
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

// the deer's turf: one instanced draw over the grazing ground's box, as dense as turf.density(x, z) (0..1). The
// meadow's tall grass is grass.js; here only these short, thin, upright blades.
export function turfData(world, turf) {
  const rng = mulberry32(43), nz = makeNoise(77);
  const cA = new THREE.Color(0.09, 0.26, 0.05), cB = new THREE.Color(0.24, 0.42, 0.08);
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

export function makeTurf(t, mat) {
  const mesh = new THREE.InstancedMesh(t.geo, mat, t.n);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(t.matrix, 16);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(t.color, 3);
  mesh.boundingSphere = new THREE.Sphere(new V(t.bs[0], t.bs[1], t.bs[2]), t.bs[3]);
  mesh.receiveShadow = true;
  mesh.layers.set(1);
  return mesh;
}

// grass.js's fine mask: no grass in the boulders' footprints or round the cherries' trunks (the terrain grid is too
// coarse out along the river for these). bounds: [x0, z0, 1 / width, 1 / depth]
export function grassMask(blockers, trunks, S = 0.2) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of blockers.concat(trunks)) { x0 = Math.min(x0, b.x - b.r - 1); x1 = Math.max(x1, b.x + b.r + 1); z0 = Math.min(z0, b.z - b.r - 1); z1 = Math.max(z1, b.z + b.r + 1); }
  const W = Math.ceil((x1 - x0) / S), H = Math.ceil((z1 - z0) / S);
  const data = new Uint8Array(W * H).fill(255);
  for (const b of blockers.concat(trunks)) {
    const i0 = Math.max(0, Math.floor((b.x - b.r - 0.5 - x0) / S)), i1 = Math.min(W - 1, Math.ceil((b.x + b.r + 0.5 - x0) / S));
    const j0 = Math.max(0, Math.floor((b.z - b.r - 0.5 - z0) / S)), j1 = Math.min(H - 1, Math.ceil((b.z + b.r + 0.5 - z0) / S));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(x0 + (i + 0.5) * S - b.x, z0 + (j + 0.5) * S - b.z) - b.r;
      const k = j * W + i;
      data[k] = Math.min(data[k], Math.round(255 * Math.min(1, Math.max(0, d / 0.35))));
    }
  }
  return { data, W, H, bounds: [x0, z0, 1 / (W * S), 1 / (H * S)] };
}

// ---------- wildflowers (small heads among the grass) ----------
// The meadow's spring flowers round the cherry tree, each kind in its own patches and at its own size and height:
// dandelions (tanpopo), white clover heads (shirotsumekusa) where the grass is short, shepherd's purse (nazuna), tiny
// and white on taller stems, violets (sumire) and speedwell (oinu-no-fuguri) low down, purple dead-nettle
// (hime-odorikoso). The low ones show where the grass is short and hide in the long grass.
// [colour, head size (times the disc), height above the ground (m): [min, spread], share, short grass only]
const FLOWER_KINDS = [
  [[0.95, 0.72, 0.08], [0.7, 0.35], [0.1, 0.22], 0.27, false], // dandelion
  [[0.86, 0.85, 0.77], [0.38, 0.14], [0.07, 0.12], 0.17, true], // white clover
  [[0.9, 0.9, 0.85], [0.22, 0.1], [0.22, 0.25], 0.12, false], // shepherd's purse
  [[0.4, 0.27, 0.7], [0.45, 0.15], [0.05, 0.1], 0.15, true], // violet
  [[0.42, 0.55, 0.95], [0.28, 0.08], [0.04, 0.06], 0.11, true], // speedwell
  [[0.72, 0.36, 0.58], [0.5, 0.2], [0.12, 0.14], 0.18, false], // purple dead-nettle
];
export function flowersData(world, count, opts) {
  const rng = mulberry32(9), nk = makeNoise(19);
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
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new V(), p = new V(), c = new THREE.Color();
  // the kind at (x, z): mostly the patch's own (broad noise over the shares), now and then another
  const total = FLOWER_KINDS.reduce((t, k) => t + k[3], 0);
  const kindAt = (x, z) => {
    let u = rng() < 0.75 ? clamp(0.5 + 0.9 * nk.fbm2(x * 0.06, z * 0.06, 2), 0, 0.999) : rng(), k = 0;
    u *= total;
    while (u > FLOWER_KINDS[k][3]) u -= FLOWER_KINDS[k++][3];
    return FLOWER_KINDS[k];
  };
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
    const [col, size, h, , short] = kindAt(x, z), lw = opts.lawn ? opts.lawn(x, z) : 1;
    if (lw < 0.3 || (short && lw > 0.6 && world.laneDist(x, z) > 3 && rng() < 0.7)) continue;
    p.set(x, y + h[0] + rng() * h[1], z);
    e.set((rng() - 0.5) * 0.6, rng() * 6.28, (rng() - 0.5) * 0.6);
    q.setFromEuler(e);
    const sc = size[0] + rng() * size[1];
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    mesh.setMatrixAt(n, m);
    const v = 0.88 + rng() * 0.12;
    mesh.setColorAt(n, c.setRGB(col[0] * v, col[1] * v, col[2] * v));
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
// Boulders along the banks, in the shallows and in outcrops on the hills, stones at the water's edge: Blender models (lods.js, tools/rocks.py),
// a boulder about 2.5 × 2 × 1.2 round its origin at scale 1, the stone the same shape.
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

// How deep each vertex of each copy in list l ({ matrix, n, kind }: the copies and which of `models` each is) lies in
// the joints between the copies, as ambient occlusion from its neighbours. models: the kinds' vertices ({ position,
// normal }, flat arrays; lods.js modelVertices). Each copy taken as a rounded box (its model's bounds, a
// superellipsoid of power 4), the vertex is in the joint as far as the points a little way out along its normal (PROBE,
// metres) lie inside another copy (1: against or under another, 0: open). Per copy, then vertex. (The village's
// dry-stone walls: lods.js makeMerged draws it into their aStone.)
const PROBE = [[0, 1], [0.07, 1], [0.2, 0.6]];
export function stoneJoints(l, models) {
  const K = models.map(({ position, normal }) => {
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(position, 3)).setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    g.computeBoundingBox();
    const c = g.boundingBox.getCenter(new V()), hs = g.boundingBox.getSize(new V()).multiplyScalar(0.5);
    return { pos: g.attributes.position, nrm: g.attributes.normal, nv: position.length / 3, c, hs, inv: new V(1 / hs.x, 1 / hs.y, 1 / hs.z) };
  });
  const n = l.n, kind = l.kind;
  const M = new THREE.Matrix4(), I = new THREE.Matrix4(), N = new THREE.Matrix3(), inv = new Float32Array(n * 16), at = new Float32Array(n * 4);
  const off = new Int32Array(n + 1); // where each copy's vertices start in the output
  const cell = new Map(), C = 2, key = (x, z) => `${Math.floor(x / C)},${Math.floor(z / C)}`;
  for (let i = 0; i < n; i++) {
    const k = K[kind[i]];
    off[i + 1] = off[i] + k.nv;
    M.fromArray(l.matrix, i * 16);
    I.copy(M).invert().toArray(inv, i * 16);
    const e = M.elements, s = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
    const w = new V().copy(k.c).applyMatrix4(M);
    at[i * 4] = w.x; at[i * 4 + 1] = w.y; at[i * 4 + 2] = w.z; at[i * 4 + 3] = k.hs.length() * s;
    const ck = key(w.x, w.z);
    if (!cell.has(ck)) cell.set(ck, []);
    cell.get(ck).push(i);
  }
  const out = new Float32Array(off[n]), p = new V(), d = new V(), near = [], reach = PROBE[PROBE.length - 1][0];
  for (let i = 0; i < n; i++) {
    const { pos, nrm, nv } = K[kind[i]];
    M.fromArray(l.matrix, i * 16);
    N.getNormalMatrix(M);
    const x0 = at[i * 4], y0 = at[i * 4 + 1], z0 = at[i * 4 + 2], r0 = at[i * 4 + 3] + reach;
    near.length = 0;
    const cx = Math.floor(x0 / C), cz = Math.floor(z0 / C);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (const j of cell.get(`${cx + dx},${cz + dz}`) || []) {
      if (j !== i && Math.hypot(at[j * 4] - x0, at[j * 4 + 1] - y0, at[j * 4 + 2] - z0) < r0 + at[j * 4 + 3]) near.push(j);
    }
    for (let v = 0; v < nv; v++) {
      p.fromBufferAttribute(pos, v).applyMatrix4(M);
      d.fromBufferAttribute(nrm, v).applyMatrix3(N).normalize();
      let occ = 0;
      for (let q = 0; q < near.length && occ < 1; q++) {
        const j = near[q], o = j * 16, e = inv, rj = at[j * 4 + 3] + reach, { c, inv: ih } = K[kind[j]];
        // (only the copies whose bounding sphere the probes can reach)
        if ((at[j * 4] - p.x) ** 2 + (at[j * 4 + 1] - p.y) ** 2 + (at[j * 4 + 2] - p.z) ** 2 > rj * rj) continue;
        // the vertex and its normal in copy j's frame, in units of its half-size: then how far inside it each probe is
        // (1 well inside, 0 outside, soft across its surface)
        const px = (e[o] * p.x + e[o + 4] * p.y + e[o + 8] * p.z + e[o + 12] - c.x) * ih.x;
        const py = (e[o + 1] * p.x + e[o + 5] * p.y + e[o + 9] * p.z + e[o + 13] - c.y) * ih.y;
        const pz = (e[o + 2] * p.x + e[o + 6] * p.y + e[o + 10] * p.z + e[o + 14] - c.z) * ih.z;
        const dx = (e[o] * d.x + e[o + 4] * d.y + e[o + 8] * d.z) * ih.x;
        const dy = (e[o + 1] * d.x + e[o + 5] * d.y + e[o + 9] * d.z) * ih.y;
        const dz = (e[o + 2] * d.x + e[o + 6] * d.y + e[o + 10] * d.z) * ih.z;
        for (let r = 0; r < PROBE.length; r++) {
          const s = PROBE[r][0], w = PROBE[r][1];
          if (w <= occ) continue;
          const lx = px + dx * s, ly = py + dy * s, lz = pz + dz * s;
          const t = Math.min(1, Math.max(0, (1.06 - Math.sqrt(Math.sqrt(lx * lx * lx * lx + ly * ly * ly * ly + lz * lz * lz * lz))) / 0.12));
          occ = Math.max(occ, w * t * t * (3 - 2 * t));
        }
      }
      out[off[i] + v] = occ;
    }
  }
  return out;
}

// walls: the walls' stones' vertices (lods.js modelVertices), per kind of WALL_KINDS, for their joints (stoneJoints)
const OUTCROPS = 45; // rock outcrops on the hills (rocksData)
export function rocksData(world, tier, treePos, walls) {
  const { rng, placements, pebbles, rocksInWater } = rockPlan(world, tier, treePos);
  const isPebble = new Set(pebbles);
  const all = placements.concat(pebbles);
  const byV = ROCK_KINDS.map(() => []);
  all.forEach((p) => byV[p.v].push(p));
  const m = new THREE.Matrix4(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V();
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
  // outcrops on the hills: two to five boulders, two and a half to ten metres across, set deep into the steeper slopes where
  // the ground shows rock (world.js groundCover), off the valley floor (their own random numbers: the rest stand as
  // they would without them)
  const r3 = mulberry32(2468);
  const slope = (x, z, e = 3) => 1 / Math.hypot((world.height(x + e, z) - world.height(x - e, z)) / (2 * e), (world.height(x, z + e) - world.height(x, z - e)) / (2 * e), 1);
  for (let t = 0, n = 0; t < 6000 && n < OUTCROPS; t++) {
    const x = lerp(-420, 420, r3()), z = lerp(-520, 140, r3());
    const ny = slope(x, z), y = world.height(x, z);
    if (ny < 0.5 || ny > 0.86 || y < 8 || y > 150 || world.wild(x, z) < 0.9 || world.grove(x, z) > 0.5) continue;
    n++;
    for (let i = 0, m = 2 + Math.floor(r3() * 4); i < m; i++) {
      const a = r3() * Math.PI * 2, d = i ? 3 + r3() * 6 : 0, xx = x + Math.cos(a) * d, zz = z + Math.sin(a) * d;
      const sc = (i ? 1 : 2) + r3() * 2;
      p.set(xx, world.height(xx, zz) - sc * 0.35, zz);
      q.setFromEuler(new THREE.Euler((r3() - 0.5) * 0.6, r3() * 6.28, (r3() - 0.5) * 0.6));
      s.set(sc, sc * (0.9 + r3() * 0.5), sc * (0.8 + r3() * 0.4));
      m4.compose(p, q, s);
      const tint = 0.75 + r3() * 0.3;
      const l = lists[Math.floor(r3() * ROCK_KINDS.length)];
      l.m.push(...m4.elements); l.c.push(tint, tint * (0.97 + r3() * 0.05), tint * (0.93 + r3() * 0.08));
    }
  }
  const data = (l) => ({ matrix: new Float32Array(l.m), color: new Float32Array(l.c), n: l.c.length / 3 });
  const groups = wallStones(world).map((w) => ({ ...w, joint: stoneJoints(w, walls) }));
  return { boulders: lists.map(data), pebbles: data(stones), walls: groups, rocksInWater, blockers: placements };
}

// ---------- the farmhouses' dry-stone walls ----------
// The walls (nozura-zumi) on the faces world.js padGround cuts and builds round the pads where they step more than
// WALL.min from the ground: field stones split to a face, of WALL_KINDS (tools/rocks.py: three face stones, blocky to
// rounded, each filling the unit box round its origin, its face out along +z; and a small one for the chinks), laid
// up each side of each pad from the wall's foot (the ground, or the yard below a cut) to its top (the yard, or the
// ground above a cut). Each stone is set on the highest of what lies under it (the ground or the stones laid
// before), so every one rests on the turf or on others: the lowest gap along the wall is filled next, with a stone as
// wide as the gap allows (bigger low down, flatter and smaller towards the top, the top course cut to the wall's
// height), so the courses run roughly level, broken where a big stone spans two. A slot too narrow for a face stone
// takes a chink up to its neighbours, and small chinks are knocked into the gaps at the stones' lower corners. Each
// stone leans back with the face's batter, its face a little proud or sunk, turned a little.
// Returns the copies merged in groups per 50 m square (lods.js makeMerged): { matrix, color, n, kind (its WALL_KINDS
// index), course (0 the wall's foot, 1 its top) }.
export const WALL_KINDS = ['wall0', 'wall1', 'wall2', 'chink'];
const CHINK = 3;
const WALL_CELL = 0.05; // m along the wall: the stones' bed is followed at this step
// m: the stones' faces stand this far out of the ground's face (world.js padGround), so the ground, a flat slope
// between its mesh's vertices half a metre apart, stays inside them and shows only deep in the joints
const PROUD = 0.22;
function wallStones(world) {
  const r2 = mulberry32(4321), groups = new Map();
  const k = WALL.batter, nn = Math.hypot(k, 1);
  const m = new THREE.Matrix4(), R = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(), sc = new V(), at = new V();
  const X = new V(), U = new V(), Nn = new V();
  for (const b of world.BUILDINGS) {
    const gk = `${Math.floor(b.x / 50)},${Math.floor(b.z / 50)}`;
    if (!groups.has(gk)) groups.set(gk, { m: [], c: [], k: [], kind: [] });
    const G = groups.get(gk), P = b.y;
    const put = (kind, tc, yc, w, h, d, out, face, course, tint) => {
      // the stone's frame: along the wall, up its face (the batter), out of it
      X.set(face.ax * b.c + face.az * b.s, 0, -face.ax * b.s + face.az * b.c);
      const ox = face.ox * b.c + face.oz * b.s, oz = -face.ox * b.s + face.oz * b.c, sg = face.fill ? 1 : -1;
      Nn.set(ox * k * sg, 1, oz * k * sg).divideScalar(nn); // (built up: out and up; cut: towards the yard and up)
      U.crossVectors(Nn, X);
      if (U.y < 0) { X.negate(); U.negate(); }
      R.makeBasis(X, U, Nn);
      q.setFromRotationMatrix(R).multiply(new THREE.Quaternion().setFromEuler(e3.set((r2() - 0.5) * 0.1, (r2() - 0.5) * 0.12, (r2() - 0.5) * 0.16)));
      // its face PROUD in front of the ground's (world.js WALL: `top + rise / batter` out from the pad's edge), less
      // `out` metres
      const ef = WALL.top + Math.abs(yc - P) / k;
      const [x, z] = face.toW(tc, ef);
      at.set(x, yc, z).addScaledVector(Nn, PROUD - d / 2 - out);
      sc.set(w, h * nn / k, d);
      m.compose(at, q, sc);
      G.m.push(...m.elements);
      G.c.push(tint, tint * 0.98, tint * 0.93);
      G.k.push(course);
      G.kind.push(kind);
    };
    // the pad's sides: middle and direction along it (in the building's frame), the way out, half its length
    const zc = b.yard / 2, hd = b.hd + b.yard / 2;
    const sides = [[0, zc - hd, 1, 0, 0, -1, b.hw], [b.hw, zc, 0, 1, 1, 0, hd], [0, zc + hd, -1, 0, 0, 1, b.hw], [-b.hw, zc, 0, -1, -1, 0, hd]];
    for (const [cx, cz, ax, az, ox, oz, half] of sides) {
      const toW = (t, e) => {
        const lx = cx + ax * t + ox * e, lz = cz + az * t + oz * e;
        return [b.x + lx * b.c + lz * b.s, b.z - lx * b.s + lz * b.c];
      };
      const ground = (t, e) => world.unlevelled(...toW(t, e)).g;
      // Along the side and past its ends to the corners: where the face starts (past the side's end, the corner's
      // hip, where the next side's face meets it), where it meets the ground (walked out along it from there), and so
      // the wall's foot and top. Sampled every 0.25 m, the cells between take the nearer sample.
      const reach = half + 2.2, n = Math.ceil((2 * reach) / WALL_CELL) + 1, S = 0.25, ns = Math.ceil((2 * reach) / S) + 1;
      const samp = [];
      for (let j = 0; j < ns; j++) {
        const t = -reach + j * S, e0 = Math.max(WALL.top, Math.abs(t) - half), hip = (e0 - WALL.top) * k;
        let e = e0, g = ground(t, e);
        if (Math.abs(g - P) <= hip + 0.05) { samp.push(null); continue; }
        while (e < 2.2 && Math.abs(g - P) > (e - WALL.top) * k) { e += 0.2; g = ground(t, e); }
        let a = Math.max(e0, e - 0.2), c = Math.min(e, 2.2);
        for (let it = 0; it < 4; it++) { const mid = (a + c) / 2, gm = ground(t, mid); if (Math.abs(gm - P) > (mid - WALL.top) * k) a = mid; else c = mid; }
        g = ground(t, c);
        const fill = g < P;
        // (the ground a little further out too, under the foot stones' fronts)
        const foot = fill ? Math.min(g, ground(t, c + 0.3)) - 0.06 : P - 0.06;
        const top = fill ? P - hip + 0.03 : g + 0.03;
        samp.push(top - (fill ? foot : P + hip) >= 0.3 ? { lo: fill ? foot : P + hip - (hip > 0 ? 0 : 0.06), hi: top, fill } : null);
      }
      const lo = new Float32Array(n), hi = new Float32Array(n), sky = new Float32Array(n), ok = new Uint8Array(n), fill = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const sp = samp[Math.min(ns - 1, Math.round((i * WALL_CELL) / S))];
        if (!sp) continue;
        ok[i] = 1; lo[i] = sky[i] = sp.lo; hi[i] = sp.hi; fill[i] = sp.fill ? 1 : 0;
      }
      // (built up or cut, as the ground is where the stone stands)
      const face = (i) => ({ ax, az, ox, oz, toW, fill: fill[i] === 1 });
      const open = (i) => ok[i] && sky[i] < hi[i] - 0.08;
      const T = (i) => -reach + i * WALL_CELL;
      for (let guard = 0; guard < 20000; guard++) {
        // the lowest bed still open, and the run of cells about as low round it
        let i0 = -1;
        for (let i = 0; i < n; i++) if (open(i) && (i0 < 0 || sky[i] < sky[i0])) i0 = i;
        if (i0 < 0) break;
        const low = sky[i0];
        let a = i0, c = i0;
        while (a > 0 && open(a - 1) && sky[a - 1] <= low + 0.07 && hi[a - 1] > low + 0.15) a--;
        while (c < n - 1 && open(c + 1) && sky[c + 1] <= low + 0.07 && hi[c + 1] > low + 0.15) c++;
        const run = (c - a + 1) * WALL_CELL, up = (low - lo[i0]) / Math.max(0.3, hi[i0] - lo[i0]);
        const tint = 0.5 + r2() * 0.28;
        if (run < 0.26) {
          // a slot: a chink up to the lower of its sides (a shallow one is left for the stone over it to bridge)
          const side = Math.min(a > 0 && ok[a - 1] ? sky[a - 1] : Infinity, c < n - 1 && ok[c + 1] ? sky[c + 1] : Infinity, hi[i0]);
          const h = clamp(side - low, 0.06, 0.2);
          if (side - low < 0.1) { for (let i = a; i <= c; i++) sky[i] = Math.max(low + 0.03, Math.min(side, hi[i])); continue; }
          put(CHINK, (T(a) + T(c)) / 2, low + h / 2 - 0.02, run + 0.08, h + 0.05, 0.22, -0.01, face(i0), up, tint);
          for (let i = a; i <= c; i++) sky[i] = low + h;
          continue;
        }
        // the stone: wide and tall low in the wall, smaller and flatter up it; as wide as the run leaves room for
        // (now and then a big one low down)
        let w = lerp(0.42, 1.1, r2() ** 1.4) * (1.15 - 0.35 * up) * (up < 0.5 && r2() < 0.18 ? 1.45 : 1);
        let h = clamp(w * lerp(0.4, 0.75, r2()) * (1.05 - 0.25 * up), 0.18, 0.8);
        w = Math.min(w, run);
        if (run - w < 0.28) w = run;
        const cw = Math.max(1, Math.round(w / WALL_CELL)), s0 = r2() < 0.5 ? a : c - cw + 1;
        let rest = -Infinity, room = Infinity;
        for (let i = s0; i < s0 + cw; i++) { rest = Math.max(rest, sky[i]); room = Math.min(room, hi[i]); }
        room -= rest;
        if (room < 0.1) { sky[i0] = hi[i0]; continue; }
        if (room < h + 0.18) h = room; // (the top course cut to the wall's height)
        const tc = (T(s0) + T(s0 + cw - 1)) / 2, kind = r2() < 0.42 ? 0 : r2() < 0.6 ? 1 : 2;
        put(kind, tc, rest - 0.03 + h / 2, w + 0.06, h + 0.05, lerp(0.4, 0.7, r2()), (r2() - 0.5) * 0.06, face(i0), up, tint);
        for (let i = s0; i < s0 + cw; i++) sky[i] = rest + h - 0.02;
        // chinks knocked into the gaps at its lower corners, where it meets its neighbours
        for (const end of [-1, 1]) {
          if (r2() > 0.3 || rest - low > 0.12) continue;
          const sz = lerp(0.1, 0.2, r2());
          put(CHINK, tc + end * (w / 2 + 0.01), rest + sz * 0.25, sz, sz * lerp(0.6, 0.9, r2()), 0.2, 0.0, face(i0), up, tint * 0.95);
        }
      }
    }
  }
  return [...groups.values()].filter((g) => g.c.length).map((g) => ({
    matrix: new Float32Array(g.m), color: new Float32Array(g.c), n: g.c.length / 3, course: new Float32Array(g.k), kind: new Uint8Array(g.kind),
  }));
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
  // groves behind the farmhouses (yashikirin, the homestead's windbreak), clear of the lanes and the paddies, and
  // well back from the other buildings (on a slope, a grove behind one house would hide the house above it)
  const r2 = mulberry32(929);
  for (const b of world.BUILDINGS) {
    if (!b.kind.startsWith('minka')) continue;
    for (let t = 0, n = 0; t < 160 && n < 16; t++) {
      const lx = lerp(-b.hw - 4, b.hw + 4, r2()), lz = -b.hd - lerp(3.2, 12, r2());
      const x = b.x + lx * b.c + lz * b.s, z = b.z - lx * b.s + lz * b.c;
      if (world.padAt(x, z) || world.zoneAt(x, z) || world.laneDist(x, z) < 3) continue;
      if (world.BUILDINGS.some((o) => o !== b && Math.abs(x - o.x) < 30 && Math.abs(z - o.z) < 30 && world.padDist(o, x, z) < 7)) continue;
      if (placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < 1.9)) continue;
      placed.push([x, z]);
      n++;
      const h = lerp(10, 15, r2());
      p.set(x, world.height(x, z) - 0.3, z);
      q.setFromAxisAngle(up, r2() * Math.PI * 2);
      s.set(h, h, h);
      const g = 0.88 + r2() * 0.24;
      lists[Math.floor(r2() * BAMBOO_KINDS.length)].push({ m: m.compose(p, q, s).toArray(), c: [g * (1 + (r2() - 0.5) * 0.1), g, g * 0.95] });
    }
  }
  return lists.map((list) => ({ matrix: new Float32Array(list.flatMap((c) => c.m)), color: new Float32Array(list.flatMap((c) => c.c)), n: list.length }));
}

// ---------- shrubs ----------
// Blender models (lods.js, tools/shrubs.py), one unit tall: azaleas in bloom (magenta, white) clipped into rounded
// mounds along the temple's approach and round the farmhouses, kerria and dwarf bamboo (sasa) along the woods'
// edges and the lanes, a thicket now and then out in the meadow; none in the water, on the farmland, lanes, pads or temple, on
// rock, or near the cherry trees (`trees`) or in the `clear` circles ({ x, z, r }: the wayside's stones).
export const SHRUB_KINDS = ['azalea', 'azalea_w', 'kerria', 'sasa'];
const AZ = 0, AZW = 1, KER = 2, SASA = 3;

export function shrubData(world, trees, clear = []) {
  const rng = mulberry32(737), nz = makeNoise(53);
  const lists = SHRUB_KINDS.map(() => []), placed = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V(), up = new V(0, 1, 0);
  const flat = (x, z, e = 2) => {
    const gx = (world.height(x + e, z) - world.height(x - e, z)) / (2 * e), gz = (world.height(x, z + e) - world.height(x, z - e)) / (2 * e);
    return 1 / Math.hypot(gx, gz, 1);
  };
  const free = (x, z, r) => {
    const ri = world.riverInfo(x, z);
    if (ri.t < 1.7 || world.zoneAt(x, z) || world.laneDist(x, z) < 1.6 + r || world.padAt(x, z) || world.templeDist(x, z) < 1 + r) return false;
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < t.r)) return false;
    return !placed.some(([px, pz, pr]) => Math.hypot(px - x, pz - z) < (pr + r) * 0.85);
  };
  const put = (k, x, z, h, r, sink = 0.12) => {
    placed.push([x, z, r]);
    p.set(x, world.height(x, z) - sink * h, z);
    q.setFromAxisAngle(up, rng() * Math.PI * 2);
    s.set(h * (0.9 + rng() * 0.25), h, h * (0.9 + rng() * 0.25));
    const g = 0.85 + rng() * 0.3, c = [g, g * (0.97 + rng() * 0.06), g * (0.94 + rng() * 0.08)];
    // (one in a `clear` circle is left out after its draws, so the rest stand as they would without it)
    if (clear.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + r * 0.85)) return;
    lists[k].push({ m: m.compose(p, q, s).toArray(), c });
  };
  // the temple's approach: clipped azaleas both sides, every few metres, magenta and white by turns in runs, clear
  // of its stone lanterns
  for (const t of toroSites(world)) placed.push([t.x, t.z, 0.5]);
  // (and clear of the temple's own pair, where the approach ends at the foot of its steps)
  const ap = world.LANES[1], [ex, ez] = ap[ap.length - 1];
  for (let i = 1; i < ap.length; i++) {
    const [ax, az] = ap[i - 1], [bx, bz] = ap[i], len = Math.hypot(bx - ax, bz - az);
    for (let t = 0; t < len; t += 3.2) {
      const x0 = ax + (bx - ax) * t / len, z0 = az + (bz - az) * t / len, nx = -(bz - az) / len, nzz = (bx - ax) / len;
      for (const side of [-1, 1]) {
        const x = x0 + nx * side * 2.7, z = z0 + nzz * side * 2.7;
        if (world.zoneAt(x, z) || world.templeDist(x, z) < 2 || Math.hypot(x - ex, z - ez) < 3.5 || world.riverInfo(x, z).t < 1.7 || flat(x, z) < 0.8) continue;
        if (placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < 1.6)) continue;
        put(nz.noise2(x * 0.05, z * 0.05) > 0 ? AZ : AZW, x, z, 0.75 + rng() * 0.2, 1.1);
      }
    }
  }
  // round the farmhouses: a few azaleas at the yard's edge, kerria by the sheds
  for (const b of world.BUILDINGS) {
    for (let t = 0, n = 0; t < 40 && n < 4; t++) {
      const a = rng() * Math.PI * 2, d = Math.max(b.hw, b.hd) + 2.5 + rng() * 4;
      const x = b.x + Math.cos(a) * d, z = b.z + Math.sin(a) * d;
      if (!free(x, z, 0.9) || flat(x, z) < 0.85) continue;
      put(b.kind === 'koya' ? KER : rng() < 0.6 ? AZ : AZW, x, z, 0.8 + rng() * 0.5, 0.9);
      n++;
    }
  }
  // the woods' edges, the scrub on the hills (world.js scrub) and the lanes' verges: dwarf bamboo and kerria, the odd azalea, in clumps
  for (let t = 0; t < 60000 && placed.length < 1200; t++) {
    const x = lerp(-220, 220, rng()), z = lerp(-330, 220, rng());
    const y = world.height(x, z);
    if (y < 0.5 || y > 130) continue;
    const wl = world.wild(x, z), gr = world.grove(x, z, undefined, wl), ld = world.laneDist(x, z);
    let edge = smoothstep(0.02, 0.12, gr) * smoothstep(0.6, 0.3, gr);
    const verge = smoothstep(6, 3, ld), clump = smoothstep(0.15, 0.5, nz.fbm2(x * 0.03, z * 0.03, 2) + 0.2), u = rng();
    // (the scrub, the costliest test, only where it could let a shrub in)
    if (wl > 0 && u < 0.72 * clump) edge = Math.max(edge, world.scrub(x, z, undefined, wl, flat(x, z, 4)) * 0.8);
    if (u > Math.max(edge * 0.9, verge * 0.3) * clump) continue;
    const k = edge > verge ? (rng() < 0.6 ? SASA : rng() < 0.75 ? KER : AZ) : rng() < 0.6 ? KER : SASA;
    const h = k === SASA ? 0.7 + rng() * 0.5 : k === KER ? 1.2 + rng() * 0.6 : 0.8 + rng() * 0.6;
    const r = h * (k === SASA ? 1.1 : 0.75);
    if (!free(x, z, r) || flat(x, z) < 0.78) continue;
    put(k, x, z, h, r);
  }
  // out in the meadow, now and then a thicket of a few
  for (let t = 0, n = 0; t < 4000 && n < 40; t++) {
    const x = lerp(-200, 200, rng()), z = lerp(-300, 200, rng());
    if (world.grove(x, z) > 0.02 || !free(x, z, 3) || flat(x, z) < 0.85 || world.height(x, z) > 110) continue;
    n++;
    const k = rng() < 0.5 ? KER : rng() < 0.5 ? SASA : AZ;
    for (let i = 0, m = 3 + Math.floor(rng() * 4); i < m; i++) {
      const a = rng() * Math.PI * 2, d = rng() * 2.2, xx = x + Math.cos(a) * d, zz = z + Math.sin(a) * d;
      const h = (k === SASA ? 0.7 : 1.0) + rng() * 0.5;
      if (free(xx, zz, h * 0.5)) put(i === 0 || rng() < 0.7 ? k : KER, xx, zz, h, h * 0.6);
    }
  }
  return lists.map((list) => ({ matrix: new Float32Array(list.flatMap((c) => c.m)), color: new Float32Array(list.flatMap((c) => c.c)), n: list.length }));
}

// ---------- spring flowers: rapeseed drifts, dandelions and horsetail by the lanes ----------
// Blender models (tools/nanohana.py, drawn by lods.js): rapeseed (nanohana) in clumps about a metre across, a metre
// tall, three kinds; a dandelion (tanpopo) and a tuft of horsetail shoots (tsukushi).
// The rapeseed in drifts over the open meadow west of the lane to the cherry tree, thinning out at their ragged edges,
// and in a line along the east bank, outside the lantern line, where the cherries stand by the river; the dandelions
// and horsetail in ones and twos along the lanes' verges. None on the lanes, the farmland, the building pads, the
// deer's grazing ground, in the small cherries' clearings (world.js CLEAR) or near the cherry tree; clear of the
// boulders (`rocks`: [{ x, z, r }]) and the wayside's stones (`clear`). `turf(x, z)`: the grazing ground's turf
// density (gen/layout.js); `density`: the tier's share of the clumps.
// (three kinds of rapeseed keep each under 1,024 instances: lods.js)
export const SPRING_KINDS = ['nanohana0', 'nanohana1', 'nanohana2', 'tanpopo', 'tsukushi'];
const RAPE = 3, TANPOPO = 3, TSUKUSHI = 4;
// meadow: the box searched; drift: the drifts' noise frequency; spacing: between clumps (m); grow: [x, z, r] where a
// drift is sure to be (the meadow's open foreground on the cinematic flight's last stretch)
const NANO = { meadow: [-125, -62, -24, 44], drift: 0.022, spacing: 1.05, grow: [[-40, -9, 15]] };
// the east bank's stretches (z ranges) and bands out from the water (t: times the river's half width; the lantern
// line and its bonbori stand at 1.33 .. 1.58) with how full each is
const BANKS = { z: [[-12, 18], [-58, -49]], t: [[1.12, 1.32, 0.8], [1.6, 2.1, 1], [2.1, 2.8, 0.45]] };
export function nanohanaData(world, { tree, small, turf, rocks = [], clear = [], density = 1 }) {
  const rng = mulberry32(919), nz = makeNoise(97);
  const lists = SPRING_KINDS.map(() => []);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V(), up = new V(0, 1, 0);
  const flat = (x, z, e = 1) => {
    const gx = (world.height(x + e, z) - world.height(x - e, z)) / (2 * e), gz = (world.height(x, z + e) - world.height(x, z - e)) / (2 * e);
    return 1 / Math.hypot(gx, gz, 1);
  };
  // whether a plant r across may stand at (x, z)
  const free = (x, z, r, lane = 3) => {
    if (world.laneDist(x, z) < lane + r || world.zoneAt(x, z) || world.padAt(x, z) || world.grove(x, z) > 0.02) return false;
    if (Math.hypot(x - tree[0], z - tree[1]) < 17 || turf(x, z) > 0.005) return false;
    if (world.CLEAR.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < 10 + r)) return false;
    if (small.some((t) => Math.hypot(x - t.x, z - t.z) < 3 + r)) return false;
    return !rocks.some((o) => Math.hypot(x - o.x, z - o.z) < o.r + r) && !clear.some((o) => Math.hypot(x - o.x, z - o.z) < o.r + r);
  };
  const put = (k, x, z, h, w, sink = 0.03) => {
    p.set(x, world.height(x, z) - sink, z);
    q.setFromAxisAngle(up, rng() * Math.PI * 2);
    s.set(w * (0.9 + rng() * 0.2), h, w * (0.9 + rng() * 0.2));
    const g = 0.88 + rng() * 0.22, c = [g, g * (0.97 + rng() * 0.06), g * (0.92 + rng() * 0.1)];
    lists[k].push({ m: m.compose(p, q, s).toArray(), c });
  };
  // the meadow's drifts: clumps on a jittered grid where the drift noise is high, fewer towards its edges
  const [x0, z0, x1, z1] = NANO.meadow, step = NANO.spacing / Math.sqrt(density);
  for (let z = z0; z < z1; z += step) for (let x = x0; x < x1; x += step) {
    const xx = x + (rng() - 0.5) * step * 0.9, zz = z + (rng() - 0.5) * step * 0.9;
    const grow = NANO.grow.reduce((g, [gx, gz, r]) => Math.max(g, smoothstep(r, r * 0.4, Math.hypot(xx - gx, zz - gz))), 0);
    const fine = 0.12 * nz.noise2(xx * 0.3, zz * 0.3);
    const d = Math.max(smoothstep(0.06, 0.26, nz.fbm2(xx * NANO.drift + 5, zz * NANO.drift - 3, 3) + fine), smoothstep(0.1, 0.6, grow + fine));
    if (rng() > d * d) continue;
    if (world.height(xx, zz) < 0.5 || world.riverInfo(xx, zz).t < 1.8 || !free(xx, zz, 0.5) || flat(xx, zz) < 0.85) continue;
    put(Math.floor(rng() * RAPE), xx, zz, (1.0 + rng() * 0.25) * lerp(0.85, 1, d), 0.9 + rng() * 0.3);
  }
  // the east bank: a ragged band of clumps either side of the lanterns, thinning away from the water
  for (const [za, zb] of BANKS.z) for (let z = za; z < zb; z += step * 0.5) {
    if (nz.noise2(z * 0.35, 7.5) < -0.4) continue; // a gap now and then
    for (const [ta, tb, share] of BANKS.t) {
      if (rng() > share) continue;
      const t = lerp(ta, tb, rng()), zz = z + (rng() - 0.5) * step * 0.5, x = world.riverX(zz) + world.riverHW(zz) * t;
      if (world.height(x, zz) < 0.25 || !free(x, zz, 0.4) || flat(x, zz) < 0.7) continue;
      put(Math.floor(rng() * RAPE), x, zz, 1.0 + rng() * 0.25, 0.85 + rng() * 0.3);
    }
  }
  // the lanes' verges: dandelions and horsetail, in ones and twos, more where the verge is open
  for (const L of world.LANES) for (let k = 1; k < L.length; k++) {
    const [ax, az] = L[k - 1], [bx, bz] = L[k], len = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / len, nzz = (bx - ax) / len;
    for (let t = rng() * 4; t < len; t += 2 + rng() * 6 / density) {
      const side = rng() < 0.5 ? -1 : 1, off = 1.1 + rng() * 0.6;
      const x = ax + (bx - ax) * t / len + nx * side * off, z = az + (bz - az) * t / len + nzz * side * off;
      if (world.zoneAt(x, z) || world.padAt(x, z) || world.height(x, z) < 0.3 || world.riverInfo(x, z).t < 1.4 || flat(x, z) < 0.8) continue;
      if (rocks.some((o) => Math.hypot(x - o.x, z - o.z) < o.r + 0.3) || clear.some((o) => Math.hypot(x - o.x, z - o.z) < o.r + 0.3)) continue;
      const k2 = rng() < 0.6 ? TANPOPO : TSUKUSHI;
      // (at the scene's flower scale: the cherry's flowers are drawn about four times their size too)
      const sc = 1.3 + rng() * 0.5;
      put(k2, x, z, sc, sc, 0.005);
      if (rng() < 0.4) put(k2, x + (rng() - 0.5) * 0.6, z + (rng() - 0.5) * 0.6, sc * 0.85, sc * 0.85, 0.005);
    }
  }
  return lists.map((list) => ({ matrix: new Float32Array(list.flatMap((c) => c.m)), color: new Float32Array(list.flatMap((c) => c.c)), n: list.length }));
}

// ---------- woods on the hills ----------
// A Japanese hillside in early April: dark stands of sugi (cedar) and hinoki (cypress) among broadleaf woods in new
// leaf, pale yellow-green konara oak, fresh green keyaki and maples, some of them reddish, dark evergreen oak (kashi),
// with wild cherries (yamazakura) flowering pinkish-white among them; groves with meadow between, young trees along
// their edges, and lone trees and small clumps out on the open slopes. Each tree has its own tint (forestTint).
// Nothing grows on faces steep enough to show rock; black pines lean out from the cliff rims instead.
// This places them; the kinds are Blender models, one unit tall (lods.js, tools/forest.py).
// kinds: model names and height range (m)
export const FOREST_KINDS = ['sugi', 'hinoki', 'konara', 'kashi', 'cherry', 'pine', 'keyaki', 'momiji'];
const SUGI = 0, HINOKI = 1, KONARA = 2, KASHI = 3, CHERRY = 4, PINE = 5, KEYAKI = 6, MOMIJI = 7;
const HEIGHT = [[18, 8], [15, 8], [11, 6], [10, 5], [10, 6], [9, 4], [14, 7], [7, 4]];
// trees of one kind at most (each draw of a kind holds them all: lods.js makeLods)
const PER_KIND = 1024;

// a tree's tint (times its model's colours), from its kind and two random numbers: brightness, and the hue of its new
// leaves (pale yellow-green to fresh green; the maples reddish, bronze or green; the cherries whiter or pinker)
function forestTint(k, rng) {
  const g = 0.85 + rng() * 0.3, h = rng();
  const mix = (a, b, t) => a.map((x, i) => g * lerp(x, b[i], t));
  switch (k) {
    case KONARA: case KEYAKI: return mix([1.14, 1.05, 0.78], [0.88, 1.0, 1.06], h);
    case KASHI: return h < 0.25 ? mix([1.25, 1.1, 0.85], [1.1, 1.05, 0.9], h * 4) : mix([0.95, 1.0, 1.0], [1.05, 1.0, 0.95], h);
    case MOMIJI: return h < 0.3 ? mix([1.25, 0.75, 0.95], [1.1, 0.85, 0.95], h / 0.3) : h < 0.5 ? [g, g, g] : mix([0.75, 1.55, 1.1], [0.85, 1.7, 1.0], (h - 0.5) / 0.5);
    case CHERRY: { const b = 0.92 + (g - 0.85) * 0.47; return [b, b * lerp(0.95, 1.02, h), b * lerp(0.97, 1.03, h)]; }
    default: { const d = (h - 0.5) * 0.12; return [g * (1 + d), g, g * (1 - d)]; }
  }
}

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
  const add = (k, x, y, z, a, hs = 1, R = rng) => {
    if (lists[k].length >= PER_KIND) return false;
    const t = { x, y, z, a, h: (HEIGHT[k][0] + R() * HEIGHT[k][1]) * hs };
    lists[k].push(t);
    const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    grid.set(key, [...(grid.get(key) || []), t]);
    return true;
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
    const k = grove < 0.3 ? (r < 0.3 ? CHERRY : r < 0.45 ? MOMIJI : KONARA)
      : cedar > 0.12 ? (r < 0.7 && grove > 0.55 ? SUGI : HINOKI) // tall sugi only inside a stand, never alone
      : r < 0.15 ? CHERRY : r < 0.47 ? KONARA : r < 0.57 ? KEYAKI : r < 0.67 ? MOMIJI : r < 0.85 ? KASHI : HINOKI;
    if (crowded(x, z, k <= HINOKI ? 4.5 : 6.5)) continue;
    // conifers shorter towards a stand's edge, so a stand rises to its middle instead of spikes standing out of it
    if (add(k, x, y, z, rng() * Math.PI * 2, k <= HINOKI ? lerp(0.65, 1, smoothstep(0.3, 0.9, grove)) : 1)) n++;
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
  // (their own random numbers: the groves' trees and the pines stand where they did without them)
  const r2 = mulberry32(556);
  // the groves' edges: young broadleaf trees, half grown, in a band round each grove (the hills' shrubs from afar)
  const young = Math.round(count * 0.16);
  for (let t = 0, m = 0; t < young * 60 && m < young; t++) {
    const x = lerp(-560, 560, r2()), z = lerp(-700, 140, r2());
    const gr = world.grove(x, z);
    if (r2() > smoothstep(0.02, 0.1, gr) * smoothstep(0.45, 0.2, gr)) continue;
    const y = world.height(x, z);
    if (y < 4 || y > 160 || flat(x, z) < 0.76 || crowded(x, z, 3.5)) continue;
    const r = r2(), k = r < 0.35 ? KONARA : r < 0.55 ? MOMIJI : r < 0.8 ? KASHI : r < 0.9 ? CHERRY : KEYAKI;
    if (add(k, x, y, z, r2() * Math.PI * 2, lerp(0.35, 0.6, r2()), r2)) m++;
  }
  // steep faces off the valley floor, too steep to farm or graze: broadleaf woods and a little hinoki cling to them
  const cling = Math.round(count * 0.2);
  for (let t = 0, m = 0; t < cling * 60 && m < cling; t++) {
    const x = lerp(-560, 560, r2()), z = lerp(-700, 140, r2());
    const w = world.wild(x, z);
    if (!w || world.grove(x, z) > 0.3) continue;
    const ny = flat(x, z), y = world.height(x, z);
    const clump = smoothstep(-0.2, 0.3, nz.fbm2(x * 0.025 - 13, z * 0.025 + 4, 2));
    if (r2() > w * smoothstep(0.88, 0.66, ny) * (0.35 + 0.65 * clump) || ny < 0.45 || y < 6 || y > 150 || crowded(x, z, 5.5)) continue;
    const r = r2(), k = r < 0.25 ? KONARA : r < 0.5 ? KASHI : r < 0.6 ? KEYAKI : r < 0.75 ? MOMIJI : r < 0.9 ? CHERRY : HINOKI;
    if (add(k, x, y, z, r2() * Math.PI * 2, lerp(0.7, 1, r2()), r2)) m++;
  }
  // the open slopes between the groves: lone trees and small clumps of a few, so the hills nearest the valley are
  // not bald
  const lone = Math.round(count * 0.3);
  for (let t = 0, m = 0; t < lone * 80 && m < lone; t++) {
    const x = lerp(-560, 560, r2()), z = lerp(-700, 140, r2());
    const w = world.wild(x, z);
    if (!w || world.grove(x, z) > 0.25) continue;
    const clump = smoothstep(0.05, 0.45, nz.fbm2(x * 0.03 + 11, z * 0.03 - 5, 2) + 0.1);
    if (r2() > w * (0.12 + 0.88 * clump)) continue;
    const y = world.height(x, z);
    if (y < 6 || y > 150 || flat(x, z) < 0.6 || crowded(x, z, 7)) continue;
    const r = r2(), k = r < 0.25 ? CHERRY : r < 0.6 ? KONARA : r < 0.72 ? MOMIJI : r < 0.84 ? KEYAKI : KASHI;
    if (add(k, x, y, z, r2() * Math.PI * 2, lerp(0.7, 1, r2()), r2)) m++;
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V(), up = new V(0, 1, 0);
  const out = lists.map((list, k) => {
    // (the broadleaf crowns wider or narrower from tree to tree, so no two read alike)
    const wv = k <= HINOKI || k === PINE ? 0.2 : 0.45;
    const matrix = new Float32Array(list.length * 16), color = new Float32Array(list.length * 3);
    list.forEach((t, i) => {
      p.set(t.x, t.y - 0.03 * t.h, t.z);
      q.setFromAxisAngle(up, t.a);
      s.set(t.h * (1 - wv / 2 + rng() * wv), t.h, t.h * (1 - wv / 2 + rng() * wv));
      m.compose(p, q, s).toArray(matrix, i * 16);
      color.set(forestTint(k, rng), i * 3);
    });
    return { matrix, color, n: list.length };
  });
  return out;
}

// The woods' leaf cards' atlas (tools/forest.py leaf_cards), 2x2 cells painted near white (the trees' vertex colours
// give the hue): 0 a broadleaf spray (konara, kashi, keyaki, momiji), 1 sugi/hinoki fronds of scale-leaf shoots, 2 pine needles in
// tufts, 3 wild cherry blossom among young bronze leaves (painted in their colour). Each spray fills its cell's middle and thins to its edge.
export function paintLeafAtlas(seed = 11, size = 1024) {
  const rng = mulberry32(seed);
  const cv = new OffscreenCanvas(size, size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cell = size / 2, R = cell * 0.46;
  const grey = (v, a = 1) => `rgba(${Math.round(255 * v)},${Math.round(255 * v)},${Math.round(255 * v)},${a})`;
  // a point in the spray's disc, denser towards its middle
  const inDisc = (k = 1) => { const a = rng() * Math.PI * 2, r = R * Math.pow(rng(), 0.7) * k; return [Math.cos(a) * r, Math.sin(a) * r]; };
  const leaf = (x, y, len, wid, rot, v, fill = grey(v)) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.bezierCurveTo(wid, len * 0.25, wid * 0.8, len * 0.8, 0, len);
    ctx.bezierCurveTo(-wid * 0.8, len * 0.8, -wid, len * 0.25, 0, 0);
    ctx.fill();
    ctx.strokeStyle = grey(v * 0.7, 0.6); ctx.lineWidth = Math.max(1, wid * 0.08);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, len * 0.9); ctx.stroke();
    ctx.restore();
  };
  const cells = [
    () => { // broadleaf: twigs from the middle, leaves along them, the far side darker
      for (let t = 0; t < 7; t++) {
        const a = rng() * Math.PI * 2, L = R * (0.6 + rng() * 0.4);
        ctx.strokeStyle = grey(0.3); ctx.lineWidth = cell * 0.008;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * L, Math.sin(a) * L); ctx.stroke();
      }
      for (let i = 0; i < 110; i++) {
        const [x, y] = inDisc(0.92), len = cell * (0.1 + rng() * 0.06);
        leaf(x, y, len, len * 0.38, Math.atan2(y, x) - Math.PI / 2 + (rng() - 0.5) * 1.6, 0.55 + 0.45 * rng());
      }
    },
    () => { // sugi / hinoki: overlapping fronds, each a drooping stem thick with short scale-leaf shoots
      for (let f = 0; f < 11; f++) {
        const y0 = (rng() - 0.5) * R * 1.3, x0 = -R * (0.75 + rng() * 0.2), L = R * (1.3 + rng() * 0.4), droop = R * (0.15 + rng() * 0.25);
        const v0 = 0.5 + 0.5 * rng();
        for (let s = 0; s < 40; s++) {
          const t = s / 40, x = x0 + L * t, y = y0 + droop * t * t, along = Math.atan2(2 * droop * t, L);
          const half = cell * 0.075 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + cell * 0.01;
          if (x * x + y * y > R * R) continue;
          for (const side of [-1, 1]) {
            const a = along + side * (1.0 + rng() * 0.25);
            ctx.strokeStyle = grey(v0 * (0.8 + 0.2 * rng())); ctx.lineWidth = cell * 0.014; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * half, y + Math.sin(a) * half); ctx.stroke();
          }
        }
      }
    },
    () => { // pine: tufts of long needles from short twigs
      for (let i = 0; i < 26; i++) {
        const [x, y] = inDisc(0.7), base = Math.atan2(y, x), v = 0.5 + 0.5 * rng();
        for (let k = 0; k < 22; k++) {
          const a = base + (rng() - 0.5) * 2.2, l = cell * (0.08 + rng() * 0.07);
          ctx.strokeStyle = grey(v * (0.8 + 0.2 * rng())); ctx.lineWidth = cell * 0.007;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
        }
      }
    },
    () => { // blossom: small five-petalled flowers in bunches among young reddish-bronze leaves (yamazakura)
      for (let i = 0; i < 16; i++) {
        const [x, y] = inDisc(0.95), len = cell * (0.08 + rng() * 0.03);
        leaf(x, y, len, len * 0.4, rng() * Math.PI * 2, 0.62, `rgb(${150 + Math.round(rng() * 40)},${70 + Math.round(rng() * 25)},${45 + Math.round(rng() * 15)})`);
      }
      for (let i = 0; i < 95; i++) {
        const [x, y] = inDisc(0.95), r = cell * (0.035 + rng() * 0.015), v = 0.86 + 0.14 * rng(), rot = rng() * 6.28;
        ctx.fillStyle = grey(v);
        for (let k = 0; k < 5; k++) {
          const a = rot + (k / 5) * Math.PI * 2;
          ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.55, r * 0.4, a, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = 'rgba(228,190,198,1)';
        ctx.beginPath(); ctx.arc(x, y, r * 0.2, 0, Math.PI * 2); ctx.fill();
      }
    },
  ];
  cells.forEach((paint, c) => {
    ctx.save();
    ctx.beginPath(); ctx.rect((c % 2) * cell + 1, Math.floor(c / 2) * cell + 1, cell - 2, cell - 2); ctx.clip();
    ctx.translate((c % 2) * cell + cell / 2, Math.floor(c / 2) * cell + cell / 2);
    paint();
    ctx.restore();
  });
  // un-premultiplied, the transparent texels filled grey: no dark fringes in the mips
  const d = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    for (let j = 0; j < 3; j++) d[i + j] = Math.round(d[i + j] * a + 175 * (1 - a));
  }
  return { data: new Uint8Array(d.buffer.slice(0)), size };
}
