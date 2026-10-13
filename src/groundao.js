// The ground's occlusion by the buildings: how much of the sky a point of the ground sees past the farmhouses, the
// temple and the dry-stone walls close by, as a texture over their ground (CELL m a texel) that the terrain's colour is
// multiplied by (materials.js terrainMaterial). It darkens the ground along a wall's foot and under the eaves, where a
// building meets the ground; the sun's shadow does the rest. The page makes the texture empty (no occlusion) before
// the terrain's material, gathers the buildings' triangles once they stand (occluderBoxes), works the occlusion out
// in a generation worker (groundOcclusion, the groundAO job) while it builds the rest, and sets it before the first
// compile uploads the texture (a data texture keeps the size it is first uploaded at).
import * as THREE from 'three/webgpu';

const CELL = 0.5; // m
const REACH = 5; // m: how far a building occludes the ground
const DIRS = 16;
const MIN = 0.35; // the least the ground keeps (under the eaves the sky still shows below them)

export function makeGroundAO() {
  const tex = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  // (where the texture lies: x0, z0 and its size in m)
  const frame = new THREE.Vector4(0, 0, 1, 1);
  // r: groundOcclusion's result
  function set(r) {
    if (!r) return;
    tex.image = { data: r.data, width: r.nx, height: r.nz };
    tex.unpackAlignment = 1; // (rows of one byte a texel are not 4-byte aligned)
    tex.needsUpdate = true;
    frame.set(r.x0, r.z0, r.nx * CELL, r.nz * CELL);
  }
  return { tex, frame, set };
}

// The buildings' triangles in the world, each as its box seen from above and its top: [x0, z0, x1, z1, top, ...].
// occluders: [{ geometry, matrices (Float32Array, 16 a copy) or matrix (THREE.Matrix4) }]
export function occluderBoxes(occluders) {
  let n = 0;
  for (const o of occluders) n += ((o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3) * (o.matrices ? o.matrices.length / 16 : 1);
  const out = new Float32Array(n * 5), m = new THREE.Matrix4();
  let t = 0;
  for (const o of occluders) {
    const g = o.geometry, p = g.attributes.position, idx = g.index, count = idx ? idx.count : p.count;
    const w = new Float32Array(p.count * 3);
    for (let i = 0, copies = o.matrices ? o.matrices.length / 16 : 1; i < copies; i++) {
      if (o.matrices) m.fromArray(o.matrices, i * 16); else m.copy(o.matrix);
      const e = m.elements;
      for (let v = 0; v < p.count; v++) {
        const x = p.getX(v), y = p.getY(v), z = p.getZ(v);
        w[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        w[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        w[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      for (let k = 0; k < count; k += 3) {
        const a = (idx ? idx.getX(k) : k) * 3, b = (idx ? idx.getX(k + 1) : k + 1) * 3, c = (idx ? idx.getX(k + 2) : k + 2) * 3;
        out[t++] = Math.min(w[a], w[b], w[c]); out[t++] = Math.min(w[a + 2], w[b + 2], w[c + 2]);
        out[t++] = Math.max(w[a], w[b], w[c]); out[t++] = Math.max(w[a + 2], w[b + 2], w[c + 2]);
        out[t++] = Math.max(w[a + 1], w[b + 1], w[c + 1]);
      }
    }
  }
  return out;
}

// The occlusion over the buildings' ground from their boxes (occluderBoxes) and the ground's height(x, z): { data
// (bytes, 255 open), nx, nz, x0, z0 }, or null without buildings.
export function groundOcclusion(boxes, height) {
  if (!boxes.length) return null;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let t = 0; t < boxes.length; t += 5) {
    x0 = Math.min(x0, boxes[t]); z0 = Math.min(z0, boxes[t + 1]); x1 = Math.max(x1, boxes[t + 2]); z1 = Math.max(z1, boxes[t + 3]);
  }
  // (a margin of twice REACH: a cell within REACH of a building looks out REACH further; the edge texels occlude
  // nothing, which clamping carries beyond)
  x0 -= 2 * REACH + CELL; z0 -= 2 * REACH + CELL; x1 += 2 * REACH + CELL; z1 += 2 * REACH + CELL;
  const nx = Math.ceil((x1 - x0) / CELL) + 1, nz = Math.ceil((z1 - z0) / CELL) + 1;
  // the tallest of the buildings over each cell
  const H = new Float32Array(nx * nz).fill(-Infinity);
  for (let t = 0; t < boxes.length; t += 5) {
    const i0 = Math.floor((boxes[t] - x0) / CELL), i1 = Math.floor((boxes[t + 2] - x0) / CELL);
    const j0 = Math.floor((boxes[t + 1] - z0) / CELL), j1 = Math.floor((boxes[t + 3] - z0) / CELL), top = boxes[t + 4];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (H[j * nx + i] < top) H[j * nx + i] = top;
  }
  // where any building is within REACH (the rest stays open)
  const near = new Uint8Array(nx * nz), r = Math.ceil(REACH / CELL);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (H[j * nx + i] === -Infinity) continue;
    for (let b = j - r; b <= j + r; b++) near.fill(1, b * nx + i - r, b * nx + i + r + 1);
  }
  // each direction's cells out to REACH, as offsets in the grid and their distances squared
  const steps = Math.ceil(REACH / CELL), off = new Int32Array(DIRS * (steps + 1)), d2 = new Float32Array(DIRS * (steps + 1));
  for (let d = 0, k = 0; d < DIRS; d++) {
    const dx = Math.cos((d / DIRS) * Math.PI * 2), dz = Math.sin((d / DIRS) * Math.PI * 2);
    for (let s = 0; s <= steps; s++, k++) {
      const dist = Math.max(s, 0.5) * CELL;
      off[k] = Math.round((dz * dist) / CELL) * nx + Math.round((dx * dist) / CELL);
      d2[k] = dist * dist;
    }
  }
  const data = new Uint8Array(nx * nz).fill(255);
  for (let j = 1; j < nz - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const c = j * nx + i;
    if (!near[c]) continue;
    const g = height(x0 + (i + 0.5) * CELL, z0 + (j + 0.5) * CELL);
    // the sky each way: the sine of the highest building's angle above the ground, out to REACH (horizon-based)
    let occ = 0;
    for (let d = 0, k = 0; d < DIRS; d++) {
      let best = 0;
      for (let s = 0; s <= steps; s++, k++) {
        const h = H[c + off[k]] - g;
        if (h > 0.1) { const t = h / Math.sqrt(h * h + d2[k]); if (t > best) best = t; }
      }
      occ += best;
    }
    data[c] = Math.round(255 * Math.max(MIN, 1 - occ / DIRS));
  }
  return { data, nx, nz, x0, z0 };
}
