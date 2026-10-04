// QA sweep captures: like look.mjs, but waits for the figures' model (fetched after start-up) before the first shot,
// prints the engine's info and the people/birds state per shot, and can run a time-lapse with captures along it.
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/qa-look.mjs <build> <outPrefix> '<json shots>'
//   GPU=1 node bench/qa-look.mjs ...   headed WebGPU, saved with page.screenshot (as gpu-look.mjs)
// shots: [{ "id": "name", "view": "hero" | "cine250" | [x, y, z, tx, ty, tz], "time": 0.5, "set": { "rain": 1 },
//           "lapse": { "hour": 20, "frames": 600, "every": 150 } }]   (lapse: setTimeOfDay(hour, true, true) after the
//           settle, then frames at 1/60, one per browser frame, capturing every `every`)
import fs from 'node:fs';
import path from 'node:path';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, prefix, json] = process.argv.slice(2);
const shots = JSON.parse(json);
const gpu = !!process.env.GPU;
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look', ...(gpu ? { headless: false } : {}) });
const page = await openHarness(browser, url);
if (gpu) await page.setViewport({ width: 1280, height: 720 });
const shoot = async (name) => {
  if (!gpu) return page.evaluate((o) => H.capture(o, 1 / 60), name);
  for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { H.call('tick', 1, 1 / 60); r(); })));
  await page.screenshot({ path: path.join(BENCH, name) });
};
try {
  const s = await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: process.env.QUALITY || 'high', backend: gpu ? 'webgpu' : process.env.LOOK_BACKEND, settings: V.defaults, extra: {} });
  console.log('setup', JSON.stringify({ createMs: Math.round(s.createMs), backend: s.backend, info: s.info }));
  let figs = {};
  for (let i = 0; i < 150; i++) {
    figs = await page.evaluate(() => H.call('figureInfo'));
    if (Object.keys(figs).length) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log('figures loaded:', Object.keys(figs).length > 0);
  for (const sh of shots) {
    const v = typeof sh.view === 'string' ? V.views.find((x) => x.id === sh.view) : { pos: sh.view.slice(0, 3), target: sh.view.slice(3) };
    await page.evaluate((v, t, x) => H.view({ ...v, settings: { time: t, ...x } }, 90), v, sh.time ?? 0.5, sh.set || {});
    // a few browser frames so the skinned meshes' bones follow
    await page.evaluate(() => H.frames(4, 1 / 60));
    await shoot(`${prefix}-${sh.id}.png`);
    if (sh.lapse) {
      await page.evaluate((h) => H.call('setTimeOfDay', h, true, true), sh.lapse.hour);
      for (let f = sh.lapse.every; f <= sh.lapse.frames; f += sh.lapse.every) {
        await page.evaluate((n) => H.frames(n, 1 / 60), sh.lapse.every - 1);
        await shoot(`${prefix}-${sh.id}-f${String(f).padStart(3, '0')}.png`);
        console.log(sh.id, f, 'hour', (await page.evaluate(() => H.call('timeOfDay'))).toFixed(2), JSON.stringify(await page.evaluate(() => H.call('figureInfo'))).slice(0, 300));
      }
    }
    const st = await page.evaluate(() => ({ fig: H.call('figureInfo'), heron: H.call('heronInfo'), i: H.info() }));
    console.log(sh.id, JSON.stringify({ calls: st.i.calls, tris: st.i.tris, fig: st.fig, heron: st.heron }).slice(0, 700));
  }
  const ms = await page.evaluate(() => H.meshStats());
  const rows = ms.rows || ms;
  if (Array.isArray(rows)) console.log('meshes visible:', rows.filter((r) => r.visible !== false).map((r) => r.name).join(' ').slice(0, 1500));
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
console.log('page log:\n' + page.logs.filter((l) => !/popErrorScope/.test(l)).map((l) => l.slice(0, 400)).join('\n'));
await browser.close(); server.close();
