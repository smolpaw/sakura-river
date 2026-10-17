// The orbit camera's hull round the buildings: a height map of what the farmhouses and the temple reach to (the
// tallest triangle's top over each CELL-metre cell, as groundao.js occluderBoxes gives them), widened into slopes that
// fall SLOPE metres a metre away from them, plus a clearance. main.js clampCamera keeps the camera above it, so a zoom
// or an orbit into a building rides up over its roof instead of ending inside its walls, rising over the last few
// metres before the wall rather than jumping there.
const CELL = 1; // m
const SLOPE = 4; // the hull's fall away from a building, metres per metre (steep: a low view beside a wall stays low)
const CLEAR = 0.8; // m above what stands there

// boxes: occluderBoxes' boxes (x0, z0, x1, z1, top per triangle). Returns { at(x, z) }: the least height there for the
// camera (-Infinity away from the buildings).
export function cameraHull(boxes) {
  if (!boxes.length) return { at: () => -Infinity };
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let t = 0; t < boxes.length; t += 5) {
    x0 = Math.min(x0, boxes[t]); z0 = Math.min(z0, boxes[t + 1]); x1 = Math.max(x1, boxes[t + 2]); z1 = Math.max(z1, boxes[t + 3]);
  }
  // (room round them for the slopes to fall away: the pagoda's 28 m to its terrace)
  const pad = 8;
  x0 -= pad; z0 -= pad; x1 += pad; z1 += pad;
  const nx = Math.ceil((x1 - x0) / CELL) + 1, nz = Math.ceil((z1 - z0) / CELL) + 1;
  const H = new Float32Array(nx * nz).fill(-Infinity);
  for (let t = 0; t < boxes.length; t += 5) {
    const i0 = Math.floor((boxes[t] - x0) / CELL), i1 = Math.floor((boxes[t + 2] - x0) / CELL);
    const j0 = Math.floor((boxes[t + 1] - z0) / CELL), j1 = Math.floor((boxes[t + 3] - z0) / CELL), y = boxes[t + 4] + CLEAR;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (H[j * nx + i] < y) H[j * nx + i] = y;
  }
  // the slopes: a two-pass chamfer distance transform, taking the max of each neighbour's height less the fall to here
  const d1 = SLOPE * CELL, d2 = SLOPE * CELL * Math.SQRT2;
  const relax = (c, n, d) => { const v = H[n] - d; if (v > H[c]) H[c] = v; };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    if (i > 0) relax(c, c - 1, d1);
    if (j > 0) { relax(c, c - nx, d1); if (i > 0) relax(c, c - nx - 1, d2); if (i < nx - 1) relax(c, c - nx + 1, d2); }
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const c = j * nx + i;
    if (i < nx - 1) relax(c, c + 1, d1);
    if (j < nz - 1) { relax(c, c + nx, d1); if (i < nx - 1) relax(c, c + nx + 1, d2); if (i > 0) relax(c, c + nx - 1, d2); }
  }
  // bilinear between the cells' middles, so the camera glides over the slopes
  const cell = (i, j) => (i < 0 || j < 0 || i >= nx || j >= nz ? -Infinity : H[j * nx + i]);
  return {
    at(x, z) {
      const u = (x - x0) / CELL - 0.5, v = (z - z0) / CELL - 0.5, i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      const a = cell(i, j), b = cell(i + 1, j), c = cell(i, j + 1), d = cell(i + 1, j + 1);
      if (a === -Infinity || b === -Infinity || c === -Infinity || d === -Infinity) return Math.max(a, b, c, d);
      return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
    },
  };
}

