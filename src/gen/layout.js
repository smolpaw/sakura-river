// Scene layout shared by the main thread and the generation workers
export const SMALL_SPOTS = [
  { z: -40, side: 1, off: 9, s: 0.95 }, { z: -92, side: -1, off: 12, s: 1.0 }, { z: -150, side: 1, off: 15, s: 1.05 },
  { z: -12, side: 1, off: 24, s: 0.9 }, { z: -225, side: -1, off: 18, s: 1.1 }, { z: -300, side: 1, off: 26, s: 1.1 },
];

// the deer's grazing ground on the far bank (deer.js): centre along z, metres out from the water's edge, radius
export const GRAZE = { z: -25, off: 7, r: 4 };

export function layout(world) {
  const TZ = 2;
  const TX = world.riverX(TZ) - world.riverHW(TZ) - 7.2;
  const small = SMALL_SPOTS.map((sp, k) => ({ ...sp, k, x: world.riverX(sp.z) + sp.side * (world.riverHW(sp.z) + sp.off) }));
  const graze = [world.riverX(GRAZE.z) + world.riverHW(GRAZE.z) + GRAZE.off, GRAZE.z];
  return { TX, TZ, tree: [TX, 0, TZ], focus: [TX + 8, 0, TZ + 8], motes: [TX + 3, 0, TZ + 2], small, graze };
}

// short lawn under the main tree: 0 near the trunk (short grass, kept down in the canopy's shade) .. 1 outside
export const underTree = (L) => (x, z) => { const t = Math.min(1, Math.max(0, (Math.hypot(x - L.TX, z - L.TZ) - 3.4) / 2.8)); return t * t * (3 - 2 * t); };

// short grass (0 .. 1 as above): the lawn under the tree and the deer's grazing ground, stretched along the bank
export const lawn = (L) => {
  const under = underTree(L), [gx, gz] = L.graze;
  return (x, z) => {
    const t = Math.min(1, Math.max(0, (Math.hypot(x - gx, (z - gz) / 1.6) - GRAZE.r) / 3));
    return Math.min(under(x, z), 0.25 + 0.75 * t * t * (3 - 2 * t)); // cropped, not bare
  };
};

export const trunkAvoid = (L) => (x, z) => Math.hypot(x - L.TX, z - L.TZ) < 0.95;

export function rockAvoid(L, blockers) {
  const trunk = trunkAvoid(L);
  return (x, z) => {
    if (trunk(x, z)) return true;
    for (const r of blockers) { if (r.sc > 0.3 && Math.abs(x - r.x) < r.sc && Math.abs(z - r.z) < r.sc && Math.hypot(x - r.x, z - r.z) < r.sc * 0.9) return true; }
    return false;
  };
}
