// Grass clumps, wildflowers, rocks & pebbles, distant forest — all instanced
import * as THREE from 'three';
import { mulberry32, makeNoise, clamp, lerp, smoothstep } from './noise.js';
import { tessellate } from './stress.js';

const V = THREE.Vector3;

// ---------- grass ----------
function grassClumpGeometry(rng, blades = 5, segs = 4) {
  const P = [], Nn = [], F = [], C = [], I = [];
  let base = 0;
  for (let b = 0; b < blades; b++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 0.13;
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const yaw = rng() * Math.PI * 2;
    const h = 0.65 + rng() * 0.45, w = 0.038 + rng() * 0.022;
    const lean = 0.12 + rng() * 0.35;
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
  return { geo, tiles: out, total };
}

export function makeGrass(data, mat) {
  const group = new THREE.Group();
  for (const t of data.tiles) {
    const mesh = new THREE.InstancedMesh(data.geo, mat, t.n);
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


// ---------- distant forest on the hills ----------
function coniferGeometry(nz) {
  // stacked, jagged tiers — reads as a spruce silhouette at distance
  const parts = [];
  const tiers = 5;
  for (let k = 0; k < tiers; k++) {
    const t = k / tiers;
    const g = new THREE.ConeGeometry(0.75 * (1 - t * 0.75), 0.9, 9, 1, true);
    const pos = g.attributes.position; const v = new V();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const a = Math.atan2(v.z, v.x);
      const jag = 1 + 0.18 * Math.sin(a * 7 + k * 2) + 0.1 * nz.noise2(a * 2, k);
      v.x *= jag; v.z *= jag;
      v.y += 0.45 + k * 0.55;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    parts.push(g);
  }
  return mergeGeos(parts);
}
function roundTreeGeometry(nz, rng) {
  const parts = [];
  for (let k = 0; k < 5; k++) {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const pos = g.attributes.position; const v = new V();
    const s = 0.4 + rng() * 0.25;
    const o = new V((rng() - 0.5) * 0.9, 0.9 + rng() * 1.1, (rng() - 0.5) * 0.9);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.multiplyScalar(s * (1 + 0.22 * nz.noise3(v.x * 2 + k, v.y * 2, v.z * 2))).add(o);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    parts.push(g);
  }
  return mergeGeos(parts);
}
function mergeGeos(parts) {
  let total = 0; parts.forEach((g) => (total += g.attributes.position.count));
  const P = new Float32Array(total * 3); const I = [];
  let off = 0;
  parts.forEach((g) => {
    P.set(g.attributes.position.array, off * 3);
    if (g.index) { const idx = g.index.array; for (let i = 0; i < idx.length; i++) I.push(idx[i] + off); }
    else for (let i = 0; i < g.attributes.position.count; i++) I.push(i + off);
    off += g.attributes.position.count;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setIndex(I);
  geo.computeVertexNormals();
  return geo;
}

export function forestData(world, count) {
  const rng = mulberry32(555);
  const nz = makeNoise(31);
  const kinds = [coniferGeometry(nz), roundTreeGeometry(nz, rng)];
  const lists = [[], []];
  let tries = 0, n = 0;
  while (n < count && tries < count * 30) {
    tries++;
    const x = lerp(-650, 650, rng()), z = lerp(-800, 160, rng());
    const ri = world.riverInfo(x, z);
    if (Math.abs(ri.d) < 55 + Math.max(0, -z) * 0.05) continue;
    if (Math.hypot(x + 10, z - 10) < 85) continue;
    if (world.templeDist(x, z) < 4) continue;
    const y = world.height(x, z);
    if (y < 4 || y > 170) continue;
    // clustered stands
    if (nz.fbm2(x * 0.012, z * 0.012, 3) < -0.02) continue;
    const kind = y > 30 || rng() < 0.8 ? 0 : 1;
    lists[kind].push({ x, y, z, s: (kind === 0 ? 3.2 : 2.6) + rng() * 2.2 });
    n++;
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), p = new V(), c = new THREE.Color();
  const out = lists.map((list, k) => {
    const mesh = new THREE.InstancedMesh(kinds[k], undefined, list.length);
    list.forEach((t, i) => {
      p.set(t.x, t.y - 0.6, t.z);
      q.setFromAxisAngle(new V(0, 1, 0), rng() * 6.28);
      s.set(t.s, t.s * (k === 0 ? 1.3 + rng() * 0.5 : 1 + rng() * 0.3), t.s);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
      const g = 0.75 + rng() * 0.5;
      if (k === 0) c.setRGB(0.05 * g, 0.11 * g, 0.06 * g);
      else c.setRGB(0.12 * g, 0.2 * g, 0.07 * g);
      
      mesh.setColorAt(i, c);
    });
    return { matrix: mesh.instanceMatrix.array, color: mesh.instanceColor.array, n: list.length };
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
