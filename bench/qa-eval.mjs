// QA probe runner: starts an engine build in the harness, then hands the page to a probe module, which drives it
// through H (bench/harness.js) and the engine's debug hooks (H.call) and prints what it finds.
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/qa-eval.mjs <build> <probe.mjs> [args...]
//   GPU=1 bench/gpu.sh node bench/qa-eval.mjs ...   headed WebGPU (the look the page has), shots saved with page.screenshot
//   LIVE=1 ...   the engine runs its own frame loop (for real mouse input through page.mouse); shoot then just saves
// The probe module's default export: async (page, { args, shoot(name), gpu }) => void; shoot captures to bench/<name>.
// Probes: bench/probes/ (views.mjs: stills of given views; mouse.mjs: drags, zooms and pans with real mouse input).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, probe, ...args] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const gpu = !!process.env.GPU, W = +(process.env.W || 1280), Hh = +(process.env.H || 720);
const { browser } = await launch({ scale: 1, profile: 'look', ...(gpu ? { headless: false } : {}) });
const page = await openHarness(browser, url);
if (gpu) await page.setViewport({ width: W, height: Hh });
// one frame per browser frame (the skinned meshes' bones and the WebGPU post nodes update once per frame), then save
const shoot = async (name) => {
  if (process.env.LIVE) return gpu ? page.screenshot({ path: path.join(BENCH, name) }) : page.evaluate((o) => H.captureLive(o), name);
  if (!gpu) return page.evaluate((o) => H.capture(o, 1 / 60), name);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { H.call('tick', 1, 1 / 60); r(); })));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  await page.screenshot({ path: path.join(BENCH, name) });
};
try {
  const s = await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: W, cssH: Hh, quality: process.env.QUALITY || 'high', backend: gpu ? 'webgpu' : process.env.LOOK_BACKEND, settings: V.defaults, adaptive: !!process.env.LIVE, extra: JSON.parse(process.env.EXTRA || '{}') });
  console.log('setup', JSON.stringify({ createMs: Math.round(s.createMs), backend: s.backend }));
  const mod = await import(pathToFileURL(path.resolve(probe)).href);
  await mod.default(page, { args, shoot, gpu });
} catch (e) { console.log('ERROR', e.stack ? e.stack.slice(0, 2000) : e); }
console.log('page log:', page.logs.filter((l) => !/popErrorScope/.test(l)).slice(0, 25).map((l) => l.slice(0, 400)).join('\n'));
await browser.close(); server.close();
