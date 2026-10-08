// Offline check of src/quality.js against a synthetic GPU: settle time and oscillation (scale changes after settling).
//   node bench/sim-controller.mjs
import { QualityController } from '../src/quality.js';
import { mulberry32 } from './lib/stats.mjs';
// Synthetic GPU: fixed + per-pixel cost (per-pixel ballast included, it scales with the render scale too), a
// +-1.5 ms alternation (shadows and reflection update every other frame), noise, rare spikes, and timings that
// arrive `lag` frames late tagged with their frame id, as in the engine. At half rate (30 fps) the shadows and the
// reflection update every frame: no alternation, +1.5 ms each frame, and a GPU with time to spare lowers its clocks
// (up to 1.75x the time below 30% of the frame busy, as the RTX 2060 here at 30 fps). `autoHalf`: the controller may
// halve the rate. `lighten`: the load drops to `mul` times from frame `at` (a lighter view after a heavy one).
function run({ fixed, perPixel, ballast = 0, target = 14, frames = 2400, lag = 20, seed = 1, autoHalf = false, lighten = null }) {
  const rng = mulberry32(seed);
  const levels = [0.9, 0.85, 0.8].map((k) => ({ apply() { cost.mul *= k; }, revert() { cost.mul /= k; } }));
  const cost = { mul: 1 };
  const changes = [];
  const c = new QualityController({ targetMs: target, levels, autoHalf, onChange: (e) => changes.push({ f, ...e }) });
  let f = 0; const ms = [], inFlight = [];
  for (f = 0; f < frames; f++) {
    const alt = c.half ? 1.5 : (f % 2 ? 1.5 : -1.5);
    const load = lighten && f >= lighten.at ? lighten.mul : 1;
    const work = (fixed + (perPixel + ballast) * c.scale * c.scale) * cost.mul * load + alt;
    const clocks = c.half ? 1 + 0.75 * Math.min(1, Math.max(0, (0.8 - work / 33.3) / 0.5)) : 1;
    const gpu = work * clocks + (rng() - 0.5) * 1.0 + (rng() < 0.01 ? 8 : 0);
    ms.push(gpu); inFlight.push([gpu, f]); c.frame = f;
    if (inFlight.length > lag) { const [g, fr] = inFlight.shift(); c.update(g, fr); }
  }
  const last = changes.length ? changes.at(-1).f : 0;
  const tail = ms.slice(-600).sort((a, b) => a - b);
  const halves = changes.filter((e, i) => e.half !== (i ? changes[i - 1].half : false)).length;
  return { settleFrame: last, changes: changes.length, lateChanges: changes.filter((e) => e.f > frames / 2).length, rateSwitches: halves, fps: c.half ? 30 : 60, scale: c.scale, level: c.level, medianMs: tail[300].toFixed(2) };
}
const cases = {
  'fast desktop (8 ms at scale 1)': { fixed: 3, perPixel: 5 },
  'iGPU-like (30 ms at scale 1)': { fixed: 6, perPixel: 24 },
  'ballast 10 ms (1080p)': { fixed: 2, perPixel: 4.5, ballast: 10 },
  'ballast 20 ms (1080p)': { fixed: 2, perPixel: 4.5, ballast: 20 },
  'ballast 30 ms (1080p)': { fixed: 2, perPixel: 4.5, ballast: 30 },
};
for (const [k, v] of Object.entries(cases)) console.log(k.padEnd(32), JSON.stringify(run(v)));
console.log('-- with the 30 fps rung (frame rate auto)');
const rung = {
  ...cases, 'just over (17 ms at scale 1)': { fixed: 4, perPixel: 13 }, 'phone-like (60 ms at scale 1)': { fixed: 10, perPixel: 50 },
  'heavy, then light (0.5x)': { fixed: 2, perPixel: 4.5, ballast: 20, frames: 12000, lighten: { at: 3000, mul: 0.5 } },
  'heavy, then a little lighter': { fixed: 2, perPixel: 4.5, ballast: 20, frames: 12000, lighten: { at: 3000, mul: 0.8 } },
  'stays heavy (long run)': { fixed: 2, perPixel: 4.5, ballast: 20, frames: 30000 },
  'fits 30 easily, not 60 (long)': { fixed: 14, perPixel: 4, frames: 30000 },
};
for (const [k, v] of Object.entries(rung)) console.log(k.padEnd(32), JSON.stringify(run({ ...v, autoHalf: true })));
