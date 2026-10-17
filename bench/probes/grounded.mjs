// What stands off the ground: for each kind of the instanced Blender models (lods.js), the gap between the bottom
// ring of its base (its vertices within 3% of its height from the bottom) and the ground under them, per instance;
// prints per kind how many stand more than 5 cm off it at any point and the worst, with where.
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/look.mjs <build> --probe bench/probes/grounded.mjs
// (Blocky bases on posts, the farmhouses' stone post bases for one, can read a few cm over where their ring is cut.)
import { createWorld } from '../../src/world.js';
const w = createWorld(7);
export default async (page) => {
  const data = await page.evaluate(() => {
    const out = [];
    window.__sakuraDebug.scene.children.forEach((grp) => {
      const S = grp.userData && grp.userData.solids;
      if (!S) return;
      S.forEach((k, ki) => {
        const p = k.geometry.attributes.position;
        k.geometry.computeBoundingBox();
        const lo = k.geometry.boundingBox.min.y, span = k.geometry.boundingBox.max.y - lo, ring = [];
        for (let i = 0; i < p.count; i++) if (p.getY(i) < lo + span * 0.03) ring.push([p.getX(i), p.getY(i), p.getZ(i)]);
        const step = Math.max(1, Math.floor(ring.length / 16)), R = ring.filter((_, i) => i % step === 0);
        for (let i = 0; i < k.n; i++) {
          const e = k.matrices.subarray(i * 16, i * 16 + 16);
          out.push({ kind: `${grp.name}/${ki}`, pts: R.map(([x, y, z]) => [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]) });
        }
      });
    });
    return out;
  });
  const by = {};
  for (const d of data) {
    let worst = -Infinity, at = null;
    for (const [x, y, z] of d.pts) { const gap = y - w.height(x, z); if (gap > worst) { worst = gap; at = [x, z]; } }
    (by[d.kind] ||= []).push({ worst, at });
  }
  for (const [kind, list] of Object.entries(by)) {
    list.sort((a, b) => b.worst - a.worst);
    const off = list.filter((r) => r.worst > 0.05).length;
    console.log(`${off ? 'OFF ' : 'ok  '} ${kind.padEnd(14)} ${String(off).padStart(4)} of ${String(list.length).padStart(4)} over 5 cm; worst ${list[0].worst.toFixed(2)} m at ${list[0].at.map((v) => v.toFixed(1)).join(',')}`);
  }
};
