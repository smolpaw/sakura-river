// igpu workload (and ballast test): the engine runs its own adaptive loop at 1920x1080, device scale 1.
//   node bench/igpu.mjs --build <b> [--backend webgpu|webgl] [--seconds 30] [--ballast 0] [--views hero,cine250]
//     [--quality high] [--out name] [--no-visual]
// Records the frame-time trace and controller state, takes the last 10 s as steady state, then freezes the
// quality where it settled and scores each view with FLIP against 1920x1080 goldens (bench/goldens-1080).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness, assertHardware } from './lib/browser.mjs';
import { clockState } from './lib/gpu.mjs';
import { median, quantile } from './lib/stats.mjs';

const { values: o } = parseArgs({ options: {
  build: { type: 'string' }, backend: { type: 'string', default: 'webgpu' }, seconds: { type: 'string', default: '30' },
  ballast: { type: 'string', default: '0' }, views: { type: 'string', default: 'hero,cine250,cine500' }, quality: { type: 'string' },
  out: { type: 'string' }, 'no-visual': { type: 'boolean', default: false }, extra: { type: 'string' },
} });
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const name = o.out || `igpu-${o.build}-${o.backend}${+o.ballast ? `-ballast${o.ballast}` : ''}`;
const outDir = path.join(BENCH, 'out/igpu', name);
fs.rmSync(outDir, { recursive: true, force: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const { server, url } = await startServer();
const { browser, args, version } = await launch({ scale: 1, profile: 'igpu' });
const page = await openHarness(browser, url);
const env = await page.evaluate(() => H.env());
assertHardware(env, { needWebGPU: o.backend === 'webgpu' });
const clocksAtStart = clockState();

await page.evaluate((p) => H.setup(p), {
  engine: `./builds/${o.build}/engine.js`, cssW: 1920, cssH: 1080, quality: o.quality, backend: o.backend, adaptive: true,
  settings: V.defaults, extra: o.extra ? JSON.parse(o.extra) : {},
});
await page.evaluate(() => H.view({ hero: true }, 0));
if (+o.ballast) await page.evaluate((ms) => H.setBallast(ms), +o.ballast);
const samples = await page.evaluate((s) => H.observe(s), +o.seconds);
const tail = samples.filter((x) => x.t > samples.at(-1).t - 10000);
const dts = tail.map((x) => x.dt);
const q = tail.at(-1).q;
const steady = { fps: 1000 / median(dts), frameMsMedian: median(dts), frameMsP90: quantile(dts, 0.9), quality: q,
  gpuMsMedian: median(tail.map((x) => x.q && x.q.gpuMs).filter((x) => x > 0)) };
// settle time: first moment after which the controller state no longer changes
const key = (x) => (x.q ? `${x.q.level}|${x.q.scale}` : '');
let settleT = 0; for (let i = 1; i < samples.length; i++) if (key(samples[i]) !== key(samples[i - 1])) settleT = samples[i].t - samples[0].t;
const changes = samples.filter((x, i) => i && key(x) !== key(samples[i - 1])).length;
log(name, 'steady fps', steady.fps.toFixed(1), 'p90 frame', steady.frameMsP90.toFixed(1), 'ms, quality', JSON.stringify(q), 'settled after', (settleT / 1000).toFixed(1), 's,', changes, 'changes');

const visual = {};
if (!o['no-visual']) {
  await page.evaluate(() => H.setAdaptive(false));
  if (+o.ballast) await page.evaluate(() => H.setBallast(0));
  for (const id of o.views.split(',')) {
    const v = V.views.find((x) => x.id === id);
    await page.evaluate((v) => H.view(v, 120), v);
    for (let k = 0; k < 64; k++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    await page.evaluate((f) => H.captureLive(f), path.relative(BENCH, path.join(outDir, `default-${id}.png`)));
  }
  const py = path.join(BENCH, '.venv/bin/python');
  const r = execFileSync(py, ['-c', `
import sys, json, os; sys.path.insert(0, ${JSON.stringify(BENCH)})
from flip_eval import load, fl
import numpy as np
from PIL import Image
out = {}
for f in sorted(os.listdir(${JSON.stringify(outDir)})):
    c = Image.open(os.path.join(${JSON.stringify(outDir)}, f)).convert('RGB')
    if c.size != (1920, 1080): c = c.resize((1920, 1080), Image.BILINEAR)  # lower render scale: upscaled like the compositor would
    g = load(os.path.join(${JSON.stringify(path.join(BENCH, 'goldens-1080/stills'))}, f))
    out[f[:-4]] = fl(g, np.asarray(c, dtype=np.float32) / 255.0)[1]
print(json.dumps(out))`], { encoding: 'utf8' });
  Object.assign(visual, JSON.parse(r));
  log('visual FLIP vs 1080p goldens', JSON.stringify(visual));
}
await browser.close(); server.close();
const result = { date: new Date().toISOString(), build: o.build, backend: o.backend, ballastMs: +o.ballast, chromium: version, flags: args, env: { webgl: env.webgl, webgpu: env.webgpu && env.webgpu.description },
  clocksAtStart, seconds: +o.seconds, steady, settleSeconds: settleT / 1000, stateChanges: changes, visual,
  trace: samples.filter((_, i) => i % 5 === 0).map((x) => ({ t: Math.round(x.t - samples[0].t), dt: +x.dt.toFixed(2), level: x.q && x.q.level, scale: x.q && x.q.scale })) };
fs.mkdirSync(path.join(BENCH, 'results'), { recursive: true });
fs.writeFileSync(path.join(BENCH, 'results', name + '.json'), JSON.stringify(result, null, 1));
