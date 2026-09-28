// Grass clumps, wildflowers, rocks & pebbles, the woods on the hills — all instanced
import * as THREE from 'three';
import { mulberry32, makeNoise, clamp, lerp, smoothstep } from './noise.js';
import { tessellate } from './stress.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const V = THREE.Vector3;

// ---------- grass ----------
// blade height, base half-width and lean: [min, spread]; spread: clump radius
const TALL = { blades: 5, segs: 4, spread: 0.13, h: [0.65, 0.45], w: [0.038, 0.022], lean: [0.12, 0.35] };
// the deer's cropped turf: many thin, short, upright blades
const TURF = { blades: 6, segs: 2, spread: 0.09, h: [0.1, 0.12], w: [0.008, 0.006], lean: [0.04, 0.16] };

function grassClumpGeometry(rng, { blades, segs, spread, h: H, w: W, lean: L } = TALL) {
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

// placement + per-tile instance data (worker-safe)
export function grassData(world, count, opts) {
  const rng = mulberry32(42);
  const nz = makeNoise(77);
  const geo = grassClumpGeometry(rng);
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
  return { geo, tiles: out, total, turf: opts.turf ? turfData(world, opts.turf, nz, cA, cB) : null };
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

export function makeGrass(data, mat) {
  const group = new THREE.Group();
  for (const t of data.turf ? [...data.tiles, data.turf] : data.tiles) {
    const mesh = new THREE.InstancedMesh(t.geo || data.geo, mat, t.n);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(t.matrix, 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(t.color, 3);
    mesh.boundingSphere = new THREE.Sphere(new V(t.bs[0], t.bs[1], t.bs[2]), t.bs[3]);
    mesh.receiveShadow = true; mesh.castShadow = false;
    mesh.layers.set(1);
    mesh.userData.max = t.n;
    group.add(mesh);
  }
  group.userData.total = data.total;
  group.userData.setFraction = (f) => { group.children.forEach((m) => (m.count = Math.max(0, Math.round(m.userData.max * f)))); };
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
function rockGeometry(seed, detail = 4) {
  const nz = makeNoise(seed);
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position;
  const v = new V();
  const sx = 1 + nz.noise2(1, seed) * 0.35, sz = 1 + nz.noise2(seed, 3) * 0.3;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let d = 1 + 0.32 * nz.fbm3(v.x * 1.1, v.y * 1.1, v.z * 1.1, 4) + 0.05 * nz.fbm3(v.x * 5, v.y * 5, v.z * 5, 2);
    // planar facets for a weathered look
    d = Math.min(d, 1.08 - 0.12 * nz.noise3(v.x * 2.2 + 5, v.y * 2.2, v.z * 2.2));
    v.multiplyScalar(d);
    v.x *= 1.25 * sx; v.z *= 1.05 * sz; v.y *= 0.72;
    if (v.y < -0.18) v.y = -0.18 + (v.y + 0.18) * 0.35;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const nrm = g.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = nz.fbm3(x * 2.5, y * 2.5, z * 2.5, 3);
    let r = 0.36 + n * 0.08, gg = 0.34 + n * 0.07, b = 0.32 + n * 0.07;
    // lichen specks
    const lich = smoothstep(0.35, 0.55, nz.noise3(x * 6, y * 6, z * 6));
    r = lerp(r, 0.5, lich * 0.3); gg = lerp(gg, 0.5, lich * 0.3); b = lerp(b, 0.4, lich * 0.3);
    // moss on top
    const mossM = smoothstep(0.35, 0.8, nrm.getY(i) + 0.45 * nz.fbm3(x * 1.8 + 9, y * 1.8, z * 1.8, 3));
    r = lerp(r, 0.12, mossM); gg = lerp(gg, 0.25, mossM); b = lerp(b, 0.05, mossM);
    // darker underside
    const ao = lerp(0.55, 1, smoothstep(-0.2, 0.3, y));
    col[i * 3] = r * ao; col[i * 3 + 1] = gg * ao; col[i * 3 + 2] = b * ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// rock/pebble placements; the returned rng continues into rocksData's instancing (same sequence as before)
export function rockPlan(world, tier, treePos) {
  const rng = mulberry32(1234);
  const variants = 5;
  const placements = [];
  const rocksInWater = [];
  const add = (x, z, sc, sink = 0.3, flatten = 1) => {
    const y = world.height(x, z);
    placements.push({ x, y: y - sc * sink, z, sc, flatten, v: Math.floor(rng() * variants), rot: rng() * Math.PI * 2 });
    if (y < 0.15) rocksInWater.push({ x, z, r: sc * 1.1, top: y + sc * (0.65 - sink) }); // top: roughly, see rockGeometry
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

export function rocksData(world, tier, treePos, triMul = 1) {
  const variants = 5;
  const geos = [];
  for (let i = 0; i < variants; i++) geos.push(rockGeometry(500 + i * 17, tier === 'low' ? 3 : 4));
  const { rng, placements, pebbles, rocksInWater } = rockPlan(world, tier, treePos);
  const all = placements.concat(pebbles);
  const byV = Array.from({ length: variants }, () => []);
  all.forEach((p) => byV[p.v].push(p));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V(), col = new THREE.Color();
  const out = byV.map((list, vi) => {
    const mesh = new THREE.InstancedMesh(geos[vi], undefined, list.length);
    list.forEach((r, i) => {
      p.set(r.x, r.y, r.z);
      q.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.25, r.rot, (rng() - 0.5) * 0.25));
      s.set(r.sc, r.sc * r.flatten * (0.8 + rng() * 0.4), r.sc);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      const tint = 0.8 + rng() * 0.35;
      col.setRGB(tint, tint * (0.97 + rng() * 0.05), tint * (0.93 + rng() * 0.08));
      mesh.setColorAt(i, col);
    });
    return { matrix: mesh.instanceMatrix.array, color: mesh.instanceColor.array, n: list.length };
  });
  return { geos: triMul > 1 ? geos.map((g) => tessellate(g, triMul)) : geos, variants: out, rocksInWater, blockers: placements };
}

export function makeRocks(d, mat) {
  const group = new THREE.Group();
  d.variants.forEach((v, vi) => {
    const mesh = new THREE.InstancedMesh(d.geos[vi], mat, v.n);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(v.matrix, 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(v.color, 3);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
  });
  return { group, rocksInWater: d.rocksInWater, blockers: d.blockers };
}


// ---------- woods on the hills ----------
// A Japanese hillside in spring: dark stands of sugi (cedar) and hinoki (cypress), broadleaf woods in fresh green and
// evergreen oak with wild cherries (yamazakura) flowering pale pink among them, all in groves with meadow between.
// Nothing grows on faces steep enough to show rock; black pines lean out from the cliff rims instead.
// Each kind is one geometry, one unit tall, shaded in its vertices: crowns take normals bent out from their middle
// (soft light over the whole crown) and darken into the creases between their tufts and towards their underside.
const BARK = [0.07, 0.055, 0.045];

// a closed surface of `rings` rings of `seg` points round an axis, bottom to top; at(j, i, v) sets a point
function ringSurface(rings, seg, at) {
  const P = new Float32Array(rings * seg * 3), I = [], v = new V();
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) { at(j, i, v); v.toArray(P, (j * seg + i) * 3); }
  for (let j = 0; j < rings - 1; j++) for (let i = 0; i < seg; i++) {
    const a = j * seg + i, b = j * seg + ((i + 1) % seg);
    I.push(a, a + seg, b, b, a + seg, b + seg);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}

// crown shading (see above): mid(p, o) sets the point the crown bulges out from at p; `low` is the underside's shade
function shadeCrown(g, mid, col, soft, low) {
  const P = g.attributes.position, Nn = g.attributes.normal, C = new Float32Array(P.count * 3);
  const p = new V(), n = new V(), o = new V();
  for (let i = 0; i < P.count; i++) {
    p.fromBufferAttribute(P, i); n.fromBufferAttribute(Nn, i);
    mid(p, o); o.subVectors(p, o).normalize();
    const ao = (0.62 + 0.38 * clamp(n.dot(o), 0, 1)) * lerp(low, 1, smoothstep(-0.7, 0.6, o.y));
    n.lerp(o, soft).normalize();
    Nn.setXYZ(i, n.x, n.y, n.z);
    C[i * 3] = col[0] * ao; C[i * 3 + 1] = col[1] * ao; C[i * 3 + 2] = col[2] * ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  return g;
}

// a limb tapering from r0 to r1 along the points `pts`, in bark colour
function limb(pts, r0, r1, seg = 5) {
  const t = new V(), u = new V(), frames = [];
  pts.forEach((p, j) => {
    t.subVectors(pts[Math.min(j + 1, pts.length - 1)], pts[Math.max(j - 1, 0)]).normalize();
    if (j === 0) u.set(Math.abs(t.y) < 0.9 ? 0 : 1, Math.abs(t.y) < 0.9 ? 1 : 0, 0);
    u.addScaledVector(t, -u.dot(t)).normalize();
    frames.push([u.clone(), u.clone().cross(t)]);
  });
  const g = ringSurface(pts.length, seg, (j, i, v) => {
    const a = (i / seg) * Math.PI * 2, r = lerp(r0, r1, j / (pts.length - 1));
    v.copy(pts[j]).addScaledVector(frames[j][0], Math.cos(a) * r).addScaledVector(frames[j][1], Math.sin(a) * r);
  });
  const C = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < C.length; i += 3) C.set(BARK, i);
  g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  return g;
}

// a lumpy ellipsoid round c (radii s, sy), or with blobs the outer surface of those spheres seen from c
function lobes(c, s, sy, rings, seg, rough, nz, blobs = null) {
  const d = new V(), o = new V();
  return ringSurface(rings, seg, (j, i, v) => {
    const th = (Math.PI * j) / (rings - 1), a = (Math.PI * 2 * i) / seg;
    d.set(Math.sin(th) * Math.cos(a), -Math.cos(th), Math.sin(th) * Math.sin(a));
    let r = 1;
    if (blobs) {
      r = 0;
      for (const b of blobs) {
        o.subVectors(c, b.p);
        const bb = -d.dot(o), q = bb * bb - o.lengthSq() + b.r * b.r;
        if (q > 0) r = Math.max(r, bb + Math.sqrt(q));
      }
    }
    r *= 1 + rough * nz.noise3(d.x * 3 + c.x * 7, d.y * 3 + c.y * 7, d.z * 3);
    v.set(c.x + d.x * r * s, c.y + d.y * r * sy, c.z + d.z * r * s);
  });
}

// sugi / hinoki: a trunk under a tall crown, tufted round its edge and built up in layers, each widest at its foot
function conifer(nz, { w, base, tiers, layer, tuft, rings, seg, col }) {
  const crown = ringSurface(rings, seg, (j, i, v) => {
    const t = j / (rings - 1), a = (i / seg) * Math.PI * 2, k = t * tiers;
    // closed underneath (the first ring is the centre), widest a little above the base, tapering to the tip
    let r = j === 0 ? 0 : w * (0.55 + 0.45 * smoothstep(0, 0.12, t)) * Math.pow(1 - t, 0.85);
    r *= 1 - layer * (k - Math.floor(k));
    r *= 1 + tuft * nz.noise3(Math.cos(a) * 2.2 + w * 9, Math.sin(a) * 2.2, t * 12);
    v.set(Math.cos(a) * r, base + t * (1 - base) + (j === 0 ? 0.02 : 0), Math.sin(a) * r);
  });
  shadeCrown(crown, (p, o) => o.set(0, p.y - 0.5 * Math.hypot(p.x, p.z), 0), col, 0.5, 0.5);
  return mergeGeometries([limb([new V(0, -0.04, 0), new V(0, base + 0.12, 0)], 0.028, 0.018), crown]);
}

// a broadleaf tree (or a wild cherry): a short trunk forking into limbs under a billowy crown of lobes
function broadleaf(nz, rng, { w, n, rough, col, low = 0.4 }) {
  const c = new V(0, 0.56, 0), blobs = [{ p: new V(0, 0.55, 0), r: 0.24 * w }];
  const parts = [limb([new V(0, -0.04, 0), new V(0.01, 0.12, 0), new V(0, 0.24, 0)], 0.03, 0.02)];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng() * 0.8, e = rng() * 1.4 - 0.55;
    const p = new V(Math.cos(a) * Math.cos(e) * 0.24 * w, 0.56 + Math.sin(e) * 0.2, Math.sin(a) * Math.cos(e) * 0.24 * w);
    blobs.push({ p, r: (0.13 + rng() * 0.08) * (0.8 + 0.2 * w) });
    if (k % 2 === 0) parts.push(limb([new V(0, 0.22, 0), new V(p.x * 0.45, 0.36, p.z * 0.45), new V(p.x * 0.8, p.y - 0.04, p.z * 0.8)], 0.016, 0.007, 4));
  }
  parts.push(shadeCrown(lobes(c, 1, 1, 10, 14, rough, nz, blobs), (p, o) => o.copy(c), col, 0.5, low));
  return mergeGeometries(parts);
}

// a black pine leaning out over a drop (+x): a crooked trunk, flat cloud-like pads of needles on its limbs
function pine(nz) {
  const col = [0.05, 0.095, 0.045];
  const trunk = [[0, -0.04, 0], [0.05, 0.22, 0.02], [0.2, 0.42, -0.03], [0.4, 0.55, 0.04], [0.62, 0.6, 0], [0.8, 0.6, 0.05]].map((a) => new V(...a));
  const parts = [limb(trunk, 0.035, 0.012, 6)];
  for (const [x, y, z, s] of [[0.82, 0.66, 0.05, 0.24], [0.6, 0.7, -0.16, 0.2], [0.42, 0.64, 0.2, 0.2], [0.26, 0.8, -0.06, 0.2], [0.5, 0.84, 0.1, 0.17], [0.12, 0.6, 0.14, 0.14], [0.7, 0.78, 0.22, 0.15]]) {
    const c = new V(x, y, z);
    const from = trunk.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    if (from.distanceTo(c) > 0.08) parts.push(limb([from, new V((from.x + x) / 2, Math.max(from.y, y) - 0.02, (from.z + z) / 2), new V(x, y - 0.02, z)], 0.012, 0.006, 4));
    parts.push(shadeCrown(lobes(c, s, s * 0.34, 7, 11, 0.22, nz), (p, o) => o.copy(c).setY(y - 0.06), col, 0.6, 0.35));
  }
  return mergeGeometries(parts);
}

// kinds: geometry and height range (m)
const SUGI = 0, HINOKI = 1, KONARA = 2, KASHI = 3, CHERRY = 4, PINE = 5;
const HEIGHT = [[20, 12], [15, 8], [11, 6], [10, 5], [10, 6], [9, 4]];

export function forestData(world, count) {
  const rng = mulberry32(555);
  const nz = makeNoise(31);
  const kinds = [
    conifer(nz, { w: 0.16, base: 0.12, tiers: 9, layer: 0.14, tuft: 0.4, rings: 14, seg: 9, col: [0.045, 0.085, 0.05] }),
    conifer(nz, { w: 0.24, base: 0.08, tiers: 6, layer: 0.28, tuft: 0.25, rings: 16, seg: 10, col: [0.06, 0.11, 0.05] }),
    broadleaf(nz, mulberry32(3), { w: 1.15, n: 8, rough: 0.07, col: [0.19, 0.3, 0.06] }), // oaks and maples in new leaf
    broadleaf(nz, mulberry32(4), { w: 1, n: 7, rough: 0.05, col: [0.07, 0.13, 0.045] }), // evergreen oak
    broadleaf(nz, mulberry32(5), { w: 1.35, n: 10, rough: 0.09, col: [1.0, 0.58, 0.56], low: 0.75 }), // wild cherry in flower
    pine(nz),
  ];
  const lists = kinds.map(() => []);
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
  const add = (k, x, y, z, a) => {
    const t = { x, y, z, a, h: HEIGHT[k][0] + rng() * HEIGHT[k][1] };
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
      : cedar > 0.12 ? (r < 0.7 ? SUGI : HINOKI)
      : r < 0.16 ? CHERRY : r < 0.62 ? KONARA : r < 0.85 ? KASHI : HINOKI;
    if (crowded(x, z, k <= HINOKI ? 4.5 : 6.5)) continue;
    add(k, x, y, z, rng() * Math.PI * 2);
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
  return { kinds, lists: out };
}

export function makeForest(d, mat) {
  const group = new THREE.Group();
  d.lists.forEach((l, k) => {
    const mesh = new THREE.InstancedMesh(d.kinds[k], mat, l.n);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(l.matrix, 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(l.color, 3);
    group.add(mesh);
  });
  return group;
}
