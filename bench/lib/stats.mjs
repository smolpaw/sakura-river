// Robust summary statistics and a two-level bootstrap (Kalibera & Jones 2013) for ratios of medians.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = Float64Array.from(xs).sort();
  const p = (s.length - 1) * q, i = Math.floor(p), f = p - i;
  return i + 1 < s.length ? s[i] * (1 - f) + s[i + 1] * f : s[i];
}
export const median = (xs) => quantile(xs, 0.5);
export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const min = (xs) => Math.min(...xs);

// Sarle's bimodality coefficient; > 0.555 hints at a multimodal distribution
export function bimodality(xs) {
  const n = xs.length;
  if (n < 4) return NaN;
  const m = mean(xs);
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of xs) { const d = x - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
  m2 /= n; m3 /= n; m4 /= n;
  if (m2 === 0) return 0;
  const g = m3 / Math.pow(m2, 1.5), k = m4 / (m2 * m2) - 3;
  return (g * g + 1) / (k + (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3)));
}

export function summarize(xs) {
  return { n: xs.length, median: median(xs), min: xs.length ? min(xs) : NaN, p10: quantile(xs, 0.1), p90: quantile(xs, 0.9), mean: xs.length ? mean(xs) : NaN, bimodality: bimodality(xs) };
}

// runsA/runsB: arrays of per-run sample arrays. Statistic: mean over runs of the per-run median.
// Two-level resampling: runs with replacement, then samples within each chosen run.
export function bootstrapRatio(runsA, runsB, { iters = 2000, seed = 1, stat = median } = {}) {
  const rng = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const level = (runs) => {
    let acc = 0;
    for (let r = 0; r < runs.length; r++) {
      const run = pick(runs);
      const s = new Float64Array(run.length);
      for (let i = 0; i < run.length; i++) s[i] = run[Math.floor(rng() * run.length)];
      acc += stat(s);
    }
    return acc / runs.length;
  };
  const point = mean(runsB.map(stat)) / mean(runsA.map(stat));
  const rs = [];
  for (let i = 0; i < iters; i++) rs.push(level(runsB) / level(runsA));
  return { ratio: point, lo: quantile(rs, 0.025), hi: quantile(rs, 0.975) };
}

export function shuffle(arr, seed) {
  const rng = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
