// The lamps' light on what is near them after dusk: the lanterns along the river and on the bridge, the stone
// lanterns up the temple's approach, the temple's own, the farmhouses' door lanterns and the light from their shoji.
// Summed into one map over the valley at start-up, so any number of lamps costs one texture read where tsl.js
// lanternLight is used (terrain, grass, trees, rocks, rain...).
import { DataUtils } from 'three';

// the map's extent (x0, z0 its corner, `cell` metres a texel); a lamp keeps 2.6 r inside it (its pool's reach: the
// edge texels stretch out over everything beyond)
export const LIGHTMAP = { x0: -128, z0: -252, cell: 0.5, nx: 480, nz: 784 };

// a light: where (y: its height, from which the light fades up and down, tsl.js), strength, and r: its pool's
// radius, exp(-d² / r²) across the ground
export const lamp = (x, y, z, s, r) => ({ x, y, z, s, r });

// RG half floats: R the light, G the light times its lamps' height (the shader divides it back out)
export function lightMap(lamps) {
  const { x0, z0, cell, nx, nz } = LIGHTMAP;
  const I = new Float32Array(nx * nz), Y = new Float32Array(nx * nz);
  for (const L of lamps) {
    const R = L.r * 2.6, k = 1 / (L.r * L.r);
    const i0 = Math.max(0, Math.floor((L.x - R - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((L.x + R - x0) / cell));
    const j0 = Math.max(0, Math.floor((L.z - R - z0) / cell)), j1 = Math.min(nz - 1, Math.ceil((L.z + R - z0) / cell));
    for (let j = j0; j <= j1; j++) {
      const dz = z0 + (j + 0.5) * cell - L.z; // texel centres
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) * cell - L.x, w = L.s * Math.exp(-(dx * dx + dz * dz) * k);
        I[j * nx + i] += w; Y[j * nx + i] += w * L.y;
      }
    }
  }
  const out = new Uint16Array(nx * nz * 2);
  for (let k = 0; k < nx * nz; k++) if (I[k] > 0) { out[k * 2] = DataUtils.toHalfFloat(I[k]); out[k * 2 + 1] = DataUtils.toHalfFloat(Y[k]); }
  return out;
}
