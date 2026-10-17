// Looks at an engine build: stills of views at times of day, or a probe module driving the page.
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/look.mjs <build> <outPrefix> [time,...] [view ...]
//     views: a bench/views.json id (hero, cine250, ...), cine:<0..1> (a point of the cinematic flight) or
//     x,y,z:tx,ty,tz; times in set('time') units (0..1 from 05:00 to 19:00). PNGs: bench/<outPrefix>-<view>-t<time>.png
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/look.mjs <build> --probe <probe.mjs> [args...]
//     a probe's default export: async (page, { args, shoot(name), gpu }) => void; shoot(name) saves bench/<name>.
//     The engine runs with { debug: true } (window.__sakuraDebug: the scene, THREE). Probes: bench/probes/.
// Environment:
//   GPU=1       headed WebGPU, the look the page has (headless WebGPU canvases read back blank); run it under
//               bench/gpu.sh. Shots are saved as the compositor shows the page.
//   LIVE=1      the engine runs its own frame loop and adaptive quality (real mouse input through page.mouse)
//   QUALITY=ultra|high|medium|low, W=, H= (CSS px, 1280×720), LOOK_SET='{"rain":1}' (settings for the stills),
//   EXTRA='{...}' (create() options)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';

const argv = process.argv.slice(2), build = argv[0];
const probeAt = argv.indexOf('--probe');
const probe = probeAt > 0 ? argv[probeAt + 1] : null;
const gpu = !!process.env.GPU, live = !!process.env.LIVE, W = +(process.env.W || 1280), Hh = +(process.env.H || 720);
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look', ...(gpu ? { headless: false } : {}) });
const page = await openHarness(browser, url);
if (gpu) await page.setViewport({ width: W, height: Hh });
// one rendered frame per browser frame (the skinned meshes' bones and the WebGPU post nodes update once per frame)
const shoot = async (name) => {
  if (gpu) fs.mkdirSync(path.dirname(path.join(BENCH, name)), { recursive: true }); // (the harness's /save makes its own)
  if (live) return gpu ? page.screenshot({ path: path.join(BENCH, name) }) : page.evaluate((o) => H.captureLive(o), name);
  if (!gpu) return page.evaluate((o) => H.capture(o, 1 / 60), name);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { H.call('tick', 1, 1 / 60); r(); })));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  await page.screenshot({ path: path.join(BENCH, name) });
};
const viewOf = (v) => {
  if (v.startsWith('cine:')) return { cine: +v.slice(5) };
  if (v.includes(':')) { const [p, q] = v.split(':').map((s) => s.split(',').map(Number)); return { pos: p, target: q }; }
  const named = V.views.find((x) => x.id === v);
  if (!named) throw new Error(`no view ${v} in bench/views.json`);
  return named;
};
try {
  const extra = { ...(probe ? { debug: true } : {}), ...JSON.parse(process.env.EXTRA || '{}') };
  const s = await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: W, cssH: Hh, quality: process.env.QUALITY || 'high', backend: gpu ? 'webgpu' : process.env.LOOK_BACKEND, settings: V.defaults, adaptive: live, extra });
  console.log('setup', JSON.stringify({ createMs: Math.round(s.createMs), backend: s.backend, info: s.info }));
  if (probe) {
    const mod = await import(pathToFileURL(path.resolve(probe)).href);
    await mod.default(page, { args: argv.slice(probeAt + 2), shoot, gpu });
  } else {
    const [, prefix, times = '0.92', ...views] = argv;
    const set = JSON.parse(process.env.LOOK_SET || '{}');
    for (const t of times.split(',')) for (const vid of views.length ? views : ['hero']) {
      await page.evaluate((v, t, x) => H.view({ ...v, settings: { time: +t, ...x } }, 90), viewOf(vid), t, set);
      // drawn frames, so the valley's shadow map (redrawn at most every 15 of them) catches up with the new time: H.view's
      // settling simulates without drawing, and a capture after a jump in time would keep the old sun's shadows
      await page.evaluate(() => H.call('tick', 32));
      await shoot(`${prefix}-${vid.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}-t${t}.png`);
    }
  }
} catch (e) { console.log('ERROR', (e.stack || String(e)).slice(0, 2000)); }
console.log('page log:', page.logs.filter((l) => !/popErrorScope/.test(l)).slice(0, 25).map((l) => l.slice(0, 400)).join('\n'));
await browser.close(); server.close();
