// The farmhouses' cart ramps (world.js rampOf): a view of each from beside its foot, looking up it into the yard
// (bench/out/ramp-<building>.png).
//   GPU=1 bench/gpu.sh node bench/look.mjs <build> --probe bench/probes/ramps.mjs [time]
import { createWorld } from '../../src/world.js';
const w = createWorld(7);
export default async (page, { args, shoot }) => {
  const t = +(args[0] ?? 0.4);
  for (const [i, b] of w.BUILDINGS.entries()) {
    const r = b.ramp;
    if (!r) continue;
    const fx = r.x0 + r.dx * (r.len + 4) - r.dz * 2.5, fz = r.z0 + r.dz * (r.len + 4) + r.dx * 2.5;
    const ex = r.x0 - r.dx * 1.5, ez = r.z0 - r.dz * 1.5;
    await page.evaluate((p, q, t) => { H.view({ pos: p, target: q, settings: { time: t } }, 60); H.call('tick', 20); }, [fx, w.height(fx, fz) + 2.2, fz], [ex, b.y + 0.6, ez], t);
    await shoot(`out/ramp-${i}.png`);
  }
};
