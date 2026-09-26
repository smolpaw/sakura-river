// Quick functional check: render one view on a backend, save a PNG, print page errors.
//   node bench/smoke.mjs <build> [webgpu|webgl] [view-id] [out.png] [extra-json]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, backend = 'webgpu', viewId = 'hero', out = `out/smoke-${build}-${backend}.png`, extraJson] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'smoke' });
const page = await openHarness(browser, url);
try {
  const s = await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1600, cssH: 900, quality: 'high', backend, settings: V.defaults, extra: extraJson ? JSON.parse(extraJson) : {} });
  console.log('setup', JSON.stringify({ createMs: Math.round(s.createMs), canvas: s.canvas, backend: s.backend, timer: s.timer }));
  await page.evaluate((v) => H.view(v, 120), V.views.find((v) => v.id === viewId));
  const f = await page.evaluate(() => H.frames(30));
  await page.evaluate((o) => H.capture(o, 1 / 60), out);
  const g = await page.evaluate(() => H.drain());
  const gpu = [...f.gpu, ...g].slice(-5);
  console.log('cpu ms', f.cpu.slice(-5).map((x) => x.toFixed(2)).join(' '), '| gpu', gpu.map((x) => x.total.toFixed(2)).join(' '));
  if (gpu.length) console.log('passes', JSON.stringify(Object.fromEntries(Object.entries(gpu.at(-1).gpu).map(([k, v]) => [k, +v.toFixed(3)]))));
  console.log('counters', JSON.stringify(await page.evaluate(() => { const c = H.counters(); if (c) delete c.renderTargets; return c; })));
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
console.log('page log:', page.logs.slice(0, 15).map((l) => l.slice(0, 400)).join('\n'));
await browser.close(); server.close();
