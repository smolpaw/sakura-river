// Where the walker can stand off the paths' special ground (walk.js): what is solid at body height, taken from the
// scene's own geometry, so nothing stops the walker that it cannot see and nothing it can see lets it through.
// Two fields over the valley, each the distance (cm) from a cell's middle to the nearest blocked cell (CELL metres a
// cell; out to MAXD), so the walker keeps its body's width from them and slides along their edges:
// - `open`: everything that blocks the walker on open ground: what stands between SLAB[0] and SLAB[1] above the ground
//   (trunks, rocks, shrubs, walls, posts, lanterns, the farmhouses, the bridge and the temple's terrace), water (the
//   river, flooded paddies), ground steeper than STEEP (banks, the pads' and terraces' faces; not on the lanes) and the
//   edge of the walkable valley;
// - `on`: what stands on the bridge's landings and the temple's terrace (walk.js ways): the same things, less the
//   bridge's own, the water and the slopes, the temple measured from its terrace's top.
import * as THREE from 'three/webgpu';

export const CELL = 0.2; // m
const SLAB = [0.18, 1.75]; // m above the ground: what reaches into it blocks (lower is stepped over, higher walked under)
const STEEP = 0.85; // rise over run
const MAXD = 600; // cm
const BOUNDS = [-160, -246, 160, 120]; // x0, z0, x1, z1 (the height cache's area: world.js heightFast)

// sources(): { plain: [{ geometry, matrix, kind }], instanced: [{ geometry, matrices (16 a copy, the node folded in),
// n }], boxes, water, templeY, lanes }: kind 'bridge' | 'temple' | undefined; boxes: [{ x, z, c, s, hw, hd }] blocked
// outright (the farmhouses' bodies, whose doorways stand open); water(x, z): true over water; templeY: the terrace's
// top; lanes: world.LANES. A generator: it yields every few milliseconds of work (the page runs it in its idle
// time) and returns { open(x, z), on(x, z) (metres to the nearest blocked cell), flags, nx, nz, cell, bounds }.
export function* walkGridSteps(world, sources) {
  let t0 = performance.now();
  const pause = () => performance.now() - t0 > 3; // (t0: when the work resumed)
  const { plain, instanced, boxes, water, templeY, lanes } = sources();
  yield; t0 = performance.now();
  const nx = Math.round((BOUNDS[2] - BOUNDS[0]) / CELL), nz = Math.round((BOUNDS[3] - BOUNDS[1]) / CELL);
  const x0 = BOUNDS[0], z0 = BOUNDS[1], N = nx * nz;
  const at = (x, z) => { const i = Math.floor((x - x0) / CELL), j = Math.floor((z - z0) / CELL); return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i; };
  // the ground at each cell's middle, and its blocked flags: 1 solid (both fields), 2 bridge, 4 temple from the ground,
  // 8 water or steep or the edge (2, 4, 8: the open field only)
  const G = new Float32Array(N), F = new Uint8Array(N);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) G[j * nx + i] = world.heightFast(x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL);
    if (pause()) { yield; t0 = performance.now(); }
  }
  const ground = (x, z) => { const k = at(x, z); return k < 0 ? world.heightFast(x, z) : G[k]; };

  // a triangle's footprint (its cells' middles inside it, and its edges, so a wall seen edge-on still marks its line)
  const fill = (ax, az, bx, bz, cx, cz, flag) => {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / CELL)), j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - z0) / CELL));
    if (i0 > i1 || j0 > j1) return;
    const d = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(d) > 1e-9) {
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * CELL, pz = z0 + (j + 0.5) * CELL;
        const u = ((bx - px) * (cz - pz) - (bz - pz) * (cx - px)) / d, v = ((cx - px) * (az - pz) - (cz - pz) * (ax - px)) / d;
        if (u >= 0 && v >= 0 && u + v <= 1) F[j * nx + i] |= flag;
      }
    }
    for (const [px, pz, qx, qz] of [[ax, az, bx, bz], [bx, bz, cx, cz], [cx, cz, ax, az]]) {
      const n = Math.ceil(Math.hypot(qx - px, qz - pz) / (CELL * 0.5)) + 1;
      for (let s = 0; s <= n; s++) { const k = at(px + ((qx - px) * s) / n, pz + ((qz - pz) * s) / n); if (k >= 0) F[k] |= flag; }
    }
  };
  // what reaches into the slab over `base` (the ground, or the terrace's top for the temple standing on it)
  const into = (y0, y1, base) => y1 > base + SLAB[0] && y0 < base + SLAB[1];

  const v = new THREE.Vector3(), w = new THREE.Vector3(), u = new THREE.Vector3();
  for (const { geometry: g, matrix, kind } of plain) {
    const p = g.attributes.position, idx = g.index, count = idx ? idx.count : p.count;
    for (let t = 0; t < count; t += 3) {
      if (t % 300 === 0 && pause()) { yield; t0 = performance.now(); }
      const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
      v.fromBufferAttribute(p, a).applyMatrix4(matrix); w.fromBufferAttribute(p, b).applyMatrix4(matrix); u.fromBufferAttribute(p, c).applyMatrix4(matrix);
      const y0 = Math.min(v.y, w.y, u.y), y1 = Math.max(v.y, w.y, u.y);
      const g0 = ground((v.x + w.x + u.x) / 3, (v.z + w.z + u.z) / 3);
      if (kind === 'temple') {
        if (into(y0, y1, templeY)) fill(v.x, v.z, w.x, w.z, u.x, u.z, 1);
        else if (into(y0, y1, g0)) fill(v.x, v.z, w.x, w.z, u.x, u.z, 4);
      } else if (into(y0, y1, g0)) fill(v.x, v.z, w.x, w.z, u.x, u.z, kind === 'bridge' ? 2 : 1);
    }
  }

  // instanced models: each kind's shape as columns (the lowest and highest point over each LC-wide cell of its own
  // ground plan), stamped at every instance; columns starting above any instance's slab dropped first (the crowns)
  const LC = 0.1;
  for (const { geometry: g, matrices: M, n } of instanced) {
    if (!n) continue;
    // the kind's least and greatest scale (world metres per model unit), from its instances' matrices
    let sMin = Infinity, sMax = 0;
    for (let i = 0; i < n; i++) { const o = i * 16, s = Math.hypot(M[o + 4], M[o + 5], M[o + 6]); sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); }
    const lc = LC / sMax; // model units a column (fine enough for the largest instance)
    const p = g.attributes.position, idx = g.index, count = idx ? idx.count : p.count;
    g.computeBoundingBox();
    const bb = g.boundingBox, cw = Math.ceil((bb.max.x - bb.min.x) / lc) + 1, cd = Math.ceil((bb.max.z - bb.min.z) / lc) + 1;
    if (cw * cd > 4e6) continue;
    const lo = new Float32Array(cw * cd).fill(Infinity), hi = new Float32Array(cw * cd).fill(-Infinity);
    const col = (x, z, y0, y1) => {
      const i = Math.floor((x - bb.min.x) / lc), j = Math.floor((z - bb.min.z) / lc), k = j * cw + i;
      if (i < 0 || j < 0 || i >= cw || j >= cd) return;
      if (y0 < lo[k]) lo[k] = y0; if (y1 > hi[k]) hi[k] = y1;
    };
    // (each triangle over the columns whose middles it covers, and along its edges)
    for (let t = 0; t < count; t += 3) {
      if (t % 300 === 0 && pause()) { yield; t0 = performance.now(); }
      const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
      v.fromBufferAttribute(p, a); w.fromBufferAttribute(p, b); u.fromBufferAttribute(p, c);
      const y0 = Math.min(v.y, w.y, u.y), y1 = Math.max(v.y, w.y, u.y);
      const i0 = Math.floor((Math.min(v.x, w.x, u.x) - bb.min.x) / lc), i1 = Math.floor((Math.max(v.x, w.x, u.x) - bb.min.x) / lc);
      const j0 = Math.floor((Math.min(v.z, w.z, u.z) - bb.min.z) / lc), j1 = Math.floor((Math.max(v.z, w.z, u.z) - bb.min.z) / lc);
      const d = (w.x - v.x) * (u.z - v.z) - (w.z - v.z) * (u.x - v.x);
      if (Math.abs(d) > 1e-12) {
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const px = bb.min.x + (i + 0.5) * lc, pz = bb.min.z + (j + 0.5) * lc;
          const e1 = ((w.x - px) * (u.z - pz) - (w.z - pz) * (u.x - px)) / d, e2 = ((u.x - px) * (v.z - pz) - (u.z - pz) * (v.x - px)) / d;
          if (e1 >= 0 && e2 >= 0 && e1 + e2 <= 1) col(px, pz, y0, y1);
        }
      }
      for (const [P, Q] of [[v, w], [w, u], [u, v]]) {
        const m = Math.ceil(Math.hypot(Q.x - P.x, Q.z - P.z) / (lc * 0.5)) + 1;
        for (let k = 0; k <= m; k++) col(P.x + ((Q.x - P.x) * k) / m, P.z + ((Q.z - P.z) * k) / m, y0, y1);
      }
    }
    // the columns that reach low enough for some instance (its origin stands at or near its ground)
    const keep = [];
    for (let k = 0; k < cw * cd; k++) {
      if (k % 100000 === 0 && pause()) { yield; t0 = performance.now(); }
      if (lo[k] !== Infinity && lo[k] * sMin < SLAB[1] + 0.5) keep.push(k);
    }
    if (!keep.length) continue;
    const ks = new Int32Array(keep);
    for (let i = 0; i < n; i++) {
      if (i % 40 === 0 && pause()) { yield; t0 = performance.now(); }
      const e = M.subarray(i * 16, i * 16 + 16), tx = e[12], tz = e[14];
      if (tx < BOUNDS[0] - 20 || tx > BOUNDS[2] + 20 || tz < BOUNDS[1] - 20 || tz > BOUNDS[3] + 20) continue;
      for (const k of ks) {
        const lx = bb.min.x + ((k % cw) + 0.5) * lc, lz = bb.min.z + (Math.floor(k / cw) + 0.5) * lc;
        // the column's foot and top in the world (the model's up turned with the instance)
        const fx = e[0] * lx + e[8] * lz + tx, fz = e[2] * lx + e[10] * lz + tz, fy = e[1] * lx + e[9] * lz + e[13];
        const y0 = fy + e[5] * lo[k], y1 = fy + e[5] * hi[k];
        const cx = fx + e[4] * lo[k], cz = fz + e[6] * lo[k];
        const q = at(cx, cz);
        if (q >= 0 && into(Math.min(y0, y1), Math.max(y0, y1), G[q])) F[q] |= 1;
      }
    }
  }

  // the farmhouses' bodies
  for (const b of boxes) {
    const r = Math.hypot(b.hw, b.hd);
    for (let j = Math.floor((b.z - r - z0) / CELL); j <= Math.floor((b.z + r - z0) / CELL); j++) for (let i = Math.floor((b.x - r - x0) / CELL); i <= Math.floor((b.x + r - x0) / CELL); i++) {
      if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
      const dx = x0 + (i + 0.5) * CELL - b.x, dz = z0 + (j + 0.5) * CELL - b.z;
      if (Math.abs(dx * b.c - dz * b.s) < b.hw && Math.abs(dx * b.s + dz * b.c) < b.hd) F[j * nx + i] |= 1;
    }
  }

  // the lanes (graded: never too steep to walk)
  const lane = new Uint8Array(N);
  for (const L of lanes) for (let k = 1; k < L.length; k++) {
    const [ax, az] = L[k - 1], [bx, bz] = L[k], n = Math.ceil(Math.hypot(bx - ax, bz - az) / CELL);
    for (let s = 0; s <= n; s++) {
      const cx = ax + ((bx - ax) * s) / n, cz = az + ((bz - az) * s) / n;
      for (let dj = -8; dj <= 8; dj++) for (let di = -8; di <= 8; di++) { if (di * di + dj * dj > 64) continue; const q = at(cx + di * CELL, cz + dj * CELL); if (q >= 0) lane[q] = 1; }
    }
  }
  // water, steep ground, the edge
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 && pause()) { yield; t0 = performance.now(); }
    const k = j * nx + i;
    if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) { F[k] |= 8; continue; }
    const x = x0 + (i + 0.5) * CELL, z = z0 + (j + 0.5) * CELL;
    if (G[k] < 0.06 || water(x, z)) { F[k] |= 8; continue; }
    if (!lane[k]) {
      const sx = (G[k + 1] - G[k - 1]) / (2 * CELL), sz = (G[k + nx] - G[k - nx]) / (2 * CELL);
      if (Math.hypot(sx, sz) > STEEP) F[k] |= 8;
    }
  }

  // the distance fields (a two-pass chamfer transform, in cm)
  const field = function* (mask) {
    const D = new Uint16Array(N).fill(MAXD), d1 = Math.round(CELL * 100), d2 = Math.round(CELL * 100 * Math.SQRT2);
    for (let k = 0; k < N; k++) if (F[k] & mask) D[k] = 0;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      if (i === 0 && pause()) { yield; t0 = performance.now(); }
      const k = j * nx + i; let m = D[k];
      if (i > 0) m = Math.min(m, D[k - 1] + d1);
      if (j > 0) { m = Math.min(m, D[k - nx] + d1); if (i > 0) m = Math.min(m, D[k - nx - 1] + d2); if (i < nx - 1) m = Math.min(m, D[k - nx + 1] + d2); }
      D[k] = m;
    }
    for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
      if (i === nx - 1 && pause()) { yield; t0 = performance.now(); }
      const k = j * nx + i; let m = D[k];
      if (i < nx - 1) m = Math.min(m, D[k + 1] + d1);
      if (j < nz - 1) { m = Math.min(m, D[k + nx] + d1); if (i < nx - 1) m = Math.min(m, D[k + nx + 1] + d2); if (i > 0) m = Math.min(m, D[k + nx - 1] + d2); }
      D[k] = m;
    }
    return D;
  };
  const open = yield* field(1 | 2 | 4 | 8), on = yield* field(1);
  // the distance at (x, z) in metres, bilinear between the cells' middles (0 off the grid); its gradient by differences
  const sample = (D) => (x, z) => {
    const fx = (x - x0) / CELL - 0.5, fz = (z - z0) / CELL - 0.5, i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return 0;
    const a = fx - i, b = fz - j, k = j * nx + i;
    return ((D[k] * (1 - a) + D[k + 1] * a) * (1 - b) + (D[k + nx] * (1 - a) + D[k + nx + 1] * a) * b) / 100;
  };
  return { open: sample(open), on: sample(on), cell: CELL, bounds: BOUNDS, flags: F, nx, nz };
}

// the grid at once (walkGridSteps run to its end)
export function buildWalkGrid(world, sources) {
  const it = walkGridSteps(world, sources);
  let r;
  while (!(r = it.next()).done);
  return r.value;
}
