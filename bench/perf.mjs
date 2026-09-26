// pnpm bench -- --a <build> --b <build> [--workload hero|1080p|stress] [--backend webgl|webgpu] [--runs 5]
//   [--frames 300] [--warmup 120] [--views hero,cine000] [--out <name>] [--seed 1]
// Interleaves runs of builds A and B in random order (A/A when a == b), rejects frames with unstable or
// throttled GPU clocks, and reports B/A ratios with two-level bootstrap 95% CIs.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness, ownPids, assertHardware } from './lib/browser.mjs';
import { idleSnapshot, contention, startLogger, nearest, clockState, THROTTLE } from './lib/gpu.mjs';
import { summarize, bootstrapRatio, shuffle, median } from './lib/stats.mjs';

const { values: o } = parseArgs({ options: {
  a: { type: 'string' }, b: { type: 'string' }, workload: { type: 'string', default: 'hero' }, backend: { type: 'string', default: 'webgl' },
  runs: { type: 'string', default: '5' }, frames: { type: 'string', default: '300' }, warmup: { type: 'string', default: '120' },
  views: { type: 'string' }, out: { type: 'string' }, seed: { type: 'string', default: '1' }, angle: { type: 'string', default: 'default' },
  'clock-tol': { type: 'string', default: '0.05' }, 'stress-a': { type: 'string' }, 'stress-b': { type: 'string' }, 'no-throttle-reject': { type: 'boolean', default: false },
} });
if (!o.a || !o.b) { console.error('need --a and --b'); process.exit(1); }

const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const W = V.workloads[o.workload];
if (!W) throw new Error('unknown workload ' + o.workload);
const views = (o.views ? o.views.split(',') : V.perfViews).map((id) => V.views.find((v) => v.id === id));
const RUNS = +o.runs, FRAMES = +o.frames, WARMUP = +o.warmup, TOL = +o['clock-tol'];
const meta = (label) => JSON.parse(fs.readFileSync(path.join(BENCH, 'builds', label, 'meta.json'), 'utf8'));
const stressOf = (s) => (s === undefined ? W.stress : s === 'none' ? undefined : JSON.parse(s));
const arms = { A: { label: o.a, build: meta(o.a), stress: stressOf(o['stress-a']) }, B: { label: o.b, build: meta(o.b), stress: stressOf(o['stress-b']) } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const idle = idleSnapshot();
const { server, url } = await startServer();
const { browser, args, version } = await launch({ scale: W.scale, angle: o.angle });
const own = () => ownPids(browser);

let page = await openHarness(browser, url);
const env = await page.evaluate(() => H.env());
await page.close();
assertHardware(env, { needWebGPU: o.backend === 'webgpu' });
log('chromium', version, '| webgl:', env.webgl, '| webgpu:', env.webgpu && env.webgpu.description);

const schedule = shuffle([...Array(RUNS)].flatMap((_, i) => [{ arm: 'A', i }, { arm: 'B', i }]), +o.seed);
const runs = [];
let clockLock = null;

async function oneRun(job) {
  let contended = null;
  for (let attempt = 0; ; attempt++) {
    const c = contention(idle, own());
    if (!c.busy) break;
    // persistent load (e.g. a media app) must not stall the campaign: run anyway and flag it
    if (attempt >= 30) { contended = { fresh: c.fresh.map((p) => p.name), load: c.load.map((p) => `${p.name}:${p.sm}%`) }; log('contention persisted; running flagged'); break; }
    log('contention, backing off:', JSON.stringify({ fresh: c.fresh.map((p) => p.name), load: c.load.map((p) => `${p.name}:${p.sm}%`) }));
    await sleep(20000);
  }
  const logger = startLogger(100);
  page = await openHarness(browser, url);
  const setup = await page.evaluate((p) => H.setup(p), {
    engine: `./builds/${arms[job.arm].label}/engine.js`, cssW: W.cssW, cssH: W.cssH, quality: W.quality, backend: o.backend, stress: arms[job.arm].stress,
    settings: V.defaults,
  });
  const out = { arm: job.arm, i: job.i, setup, views: {}, contended };
  for (const v of views) {
    await page.evaluate((v) => H.view(v, 120), v);
    let warm = await page.evaluate((n) => H.frames(n), WARMUP);
    // extend warm-up until the GPU sits in P0 with a steady clock (max +5 x 60 frames)
    for (let k = 0; k < 5; k++) {
      const recent = logger.samples.slice(-10);
      const grs = recent.map((s) => s.gr);
      const steady = recent.length >= 5 && recent.every((s) => s.pstate === 'P0') && (Math.max(...grs) - Math.min(...grs)) / median(grs) < 0.03;
      if (steady) break;
      warm = await page.evaluate((n) => H.frames(n), 60);
    }
    const m = await page.evaluate((n) => H.frames(n), FRAMES);
    const late = await page.evaluate(() => H.drain());
    const counters = await page.evaluate(() => H.counters());
    const disjoint = await page.evaluate(() => H.disjoint());
    const gpuByFrame = new Map([...m.gpu, ...late].map((g) => [g.frame, g]));
    const clocks = m.t.map((t) => nearest(logger.samples, t));
    const grMed = median(clocks.filter(Boolean).map((c) => c.gr));
    const frames = [];
    let rejected = { clock: 0, throttle: 0, noGpu: 0, noClock: 0 };
    m.cpu.forEach((cpu, i) => {
      const c = clocks[i], g = gpuByFrame.get(m.pf[i]);
      if (!c) { rejected.noClock++; return; }
      if (Math.abs(c.gr - grMed) / grMed > TOL) { rejected.clock++; return; }
      if (!o['no-throttle-reject'] && (c.reasons & THROTTLE)) { rejected.throttle++; return; }
      if (!g && setup.timer) { rejected.noGpu++; }
      frames.push({ cpu, cpuTotal: m.cpuTotal ? m.cpuTotal[i] : cpu, gpu: g ? g.total : null, labels: g ? g.gpu : null });
    });
    const labels = {};
    for (const f of frames) if (f.labels) for (const k in f.labels) (labels[k] ||= []).push(f.labels[k]);
    out.views[v.id] = {
      cpu: frames.map((f) => f.cpu), cpuTotal: frames.map((f) => f.cpuTotal), gpu: frames.filter((f) => f.gpu !== null).map((f) => f.gpu),
      labels: Object.fromEntries(Object.entries(labels).map(([k, xs]) => [k, median(xs)])),
      rejected, grMedian: grMed, counters, disjoint,
      reasons: clocks.filter(Boolean).reduce((h, c) => { const k = '0x' + c.reasons.toString(16); h[k] = (h[k] || 0) + 1; return h; }, {}),
      clockSamples: clocks.filter(Boolean).length,
    };
    if (clockLock === null && grMed) clockLock = Math.abs(grMed - 1500) < 8;
  }
  out.clocks = summarize(logger.stop().map((s) => s.gr));
  out.logs = page.logs.slice(0, 20);
  await page.evaluate(() => H.dispose());
  await page.close();
  const after = contention(idle, own());
  out.contaminated = after.busy && !contended;
  return out;
}

for (const job of schedule) {
  let r;
  for (let tries = 0; tries < 3; tries++) {
    r = await oneRun(job);
    if (!r.contaminated) break;
    log('run contaminated by another GPU client; repeating');
  }
  const hv = r.views[views[0].id];
  log(`run ${job.arm}${job.i}`, `${views[0].id}: gpu ${median(hv.gpu).toFixed(3)} ms, cpu ${median(hv.cpu).toFixed(3)} ms, rejected ${JSON.stringify(hv.rejected)}, clock ${hv.grMedian}, reasons ${JSON.stringify(hv.reasons)}`);
  runs.push(r);
}
await browser.close();
server.close();

// ---- aggregate ----
const compare = {};
const logRatios = { gpu: [], cpu: [] };
for (const v of views) {
  const pick = (arm, key) => runs.filter((r) => r.arm === arm).map((r) => r.views[v.id][key]).filter((xs) => xs.length);
  const row = { A: {}, B: {} };
  for (const arm of ['A', 'B']) for (const key of ['gpu', 'cpu']) {
    const rs = pick(arm, key);
    row[arm][key] = rs.length ? { runMedians: rs.map(median), ...summarize(rs.flat()) } : null;
  }
  // secondary: GPU time scaled to a 1500 MHz clock (cycles); removes clock drift, biased for memory-bound work
  const cyc = (arm) => runs.filter((r) => r.arm === arm).map((r) => r.views[v.id].gpu.map((x) => (x * r.views[v.id].grMedian) / 1500)).filter((xs) => xs.length);
  if (cyc('A').length && cyc('B').length) row.gpuCyclesRatio = bootstrapRatio(cyc('A'), cyc('B'), { seed: 7 });
  for (const key of ['gpu', 'cpu']) {
    const A = pick('A', key), B = pick('B', key);
    if (A.length && B.length) { row[key + 'Ratio'] = bootstrapRatio(A, B, { seed: 7 }); logRatios[key].push(Math.log(row[key + 'Ratio'].ratio)); }
  }
  row.labelsA = runs.find((r) => r.arm === 'A').views[v.id].labels;
  row.labelsB = runs.find((r) => r.arm === 'B').views[v.id].labels;
  row.counters = { A: runs.find((r) => r.arm === 'A').views[v.id].counters, B: runs.find((r) => r.arm === 'B').views[v.id].counters };
  compare[v.id] = row;
}
const geo = (xs) => (xs.length ? Math.exp(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const result = {
  date: new Date().toISOString(), workload: o.workload, backend: o.backend, angle: o.angle, chromium: version, flags: args, env,
  runsPerArm: RUNS, frames: FRAMES, warmup: WARMUP, clockTolerance: TOL, clockLock, clockAtStart: clockState(),
  idle: { procs: idle.procs.map((p) => p.name), absorbed: idle.absorbed || [] }, arms,
  order: schedule.map((j) => j.arm + j.i),
  geomeanRatio: { gpu: geo(logRatios.gpu), cpu: geo(logRatios.cpu) },
  views: Object.fromEntries(Object.entries(compare).map(([id, r]) => [id, {
    gpuRatio: r.gpuRatio, gpuCyclesRatio: r.gpuCyclesRatio, cpuRatio: r.cpuRatio,
    A: { gpu: r.A.gpu && { median: r.A.gpu.median, runMedians: r.A.gpu.runMedians, bimodality: r.A.gpu.bimodality }, cpu: r.A.cpu && { median: r.A.cpu.median, min: r.A.cpu.min, runMedians: r.A.cpu.runMedians, bimodality: r.A.cpu.bimodality } },
    B: { gpu: r.B.gpu && { median: r.B.gpu.median, runMedians: r.B.gpu.runMedians, bimodality: r.B.gpu.bimodality }, cpu: r.B.cpu && { median: r.B.cpu.median, min: r.B.cpu.min, runMedians: r.B.cpu.runMedians, bimodality: r.B.cpu.bimodality } },
    labelsA: r.labelsA, labelsB: r.labelsB, counters: r.counters,
  }])),
  runs: runs.map((r) => ({ arm: r.arm, i: r.i, contended: r.contended, createMs: r.setup.createMs, canvas: r.setup.canvas, backend: r.setup.backend, contaminated: r.contaminated, clocks: r.clocks, logs: r.logs,
    views: Object.fromEntries(Object.entries(r.views).map(([id, v]) => [id, { rejected: v.rejected, grMedian: v.grMedian, n: v.cpu.length, gpuMedian: median(v.gpu), cpuMedian: median(v.cpu), cpuTotalMedian: median(v.cpuTotal) }])) })),
};
const name = o.out || `perf-${o.workload}-${o.backend}-${o.a}-vs-${o.b}`;
fs.mkdirSync(path.join(BENCH, 'results'), { recursive: true });
fs.writeFileSync(path.join(BENCH, 'results', name + '.json'), JSON.stringify(result, null, 1));
fs.mkdirSync(path.join(BENCH, 'out', 'raw'), { recursive: true });
fs.writeFileSync(path.join(BENCH, 'out', 'raw', name + '.json'), JSON.stringify(runs));
for (const [id, r] of Object.entries(result.views)) {
  const g = r.gpuRatio, c = r.cpuRatio;
  log(`${id}: GPU A ${r.A.gpu?.median?.toFixed(3)} B ${r.B.gpu?.median?.toFixed(3)} ms  B/A ${g ? `${g.ratio.toFixed(3)} [${g.lo.toFixed(3)}, ${g.hi.toFixed(3)}]` : '-'} | CPU B/A ${c ? `${c.ratio.toFixed(3)} [${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]` : '-'}`);
}
log('geomean B/A gpu', result.geomeanRatio.gpu?.toFixed(3), 'cpu', result.geomeanRatio.cpu?.toFixed(3), '->', path.join('bench/results', name + '.json'));
