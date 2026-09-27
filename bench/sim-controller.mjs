// Offline check of src/quality.js against a synthetic GPU: settle time and oscillation (scale changes after settling).
//   node bench/sim-controller.mjs
import { QualityController } from '../src/quality.js';
import { mulberry32 } from './lib/stats.mjs';
// Synthetic GPU: fixed + per-pixel cost (per-pixel ballast included, it scales with the render scale too), a
// +-1.5 ms alternation (shadows and reflection update every other frame), noise, rare spikes, and timings that
// arrive `lag` frames late tagged with their frame id, as in the engine.
function run({ fixed, perPixel, ballast = 0, target = 14, frames = 2400, lag = 20, seed = 1 }) {
  const rng = mulberry32(seed);
  const levels = [0.9, 0.85, 0.8].map((k) => ({ apply() { cost.mul *= k; }, revert() { cost.mul /= k; } }));
  const cost = { mul: 1 };
  const changes = [];
  const c = new QualityController({ targetMs: target, levels, onChange: (e) => changes.push({ f, ...e }) });
  let f = 0; const ms = [], inFlight = [];
  for (f = 0; f < frames; f++) {
    const gpu = (fixed + (perPixel + ballast) * c.scale * c.scale) * cost.mul + (f % 2 ? 1.5 : -1.5) + (rng() - 0.5) * 1.0 + (rng() < 0.01 ? 8 : 0);
    ms.push(gpu); inFlight.push([gpu, f]); c.frame = f;
    if (inFlight.length > lag) { const [g, fr] = inFlight.shift(); c.update(g, fr); }
  }
  const last = changes.length ? changes.at(-1).f : 0;
  const tail = ms.slice(-600).sort((a, b) => a - b);
  return { settleFrame: last, changes: changes.length, lateChanges: changes.filter((e) => e.f > 1200).length, scale: c.scale, level: c.level, medianMs: tail[300].toFixed(2) };
}
const cases = {
  'fast desktop (8 ms at scale 1)': { fixed: 3, perPixel: 5 },
  'iGPU-like (30 ms at scale 1)': { fixed: 6, perPixel: 24 },
  'ballast 10 ms (1080p)': { fixed: 2, perPixel: 4.5, ballast: 10 },
  'ballast 20 ms (1080p)': { fixed: 2, perPixel: 4.5, ballast: 20 },
  'ballast 30 ms (1080p)': { fixed: 2, perPixel: 4.5, ballast: 30 },
};
for (const [k, v] of Object.entries(cases)) console.log(k.padEnd(32), JSON.stringify(run(v)));
