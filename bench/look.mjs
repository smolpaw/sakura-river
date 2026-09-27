// Quick headless look: render views at given times of day and save PNGs (no window, no timing).
//   BENCH_HEADLESS=1 node bench/look.mjs <build> <outPrefix> [time,...] [view-id|x,y,z:tx,ty,tz ...]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, prefix, times = '0.92', ...views] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look' });
const page = await openHarness(browser, url);
try {
  const s = await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: 'high', backend: process.env.LOOK_BACKEND, settings: V.defaults });
  console.log('setup', JSON.stringify({ createMs: Math.round(s.createMs), backend: s.backend, info: s.info }));
  for (const t of times.split(',')) for (const vid of views.length ? views : ['hero']) {
    const v = vid.includes(':') ? { pos: vid.split(':')[0].split(',').map(Number), target: vid.split(':')[1].split(',').map(Number) } : V.views.find((x) => x.id === vid);
    await page.evaluate((v, t, x) => H.view({ ...v, settings: { time: +t, ...JSON.parse(x) } }, 90), v, t, process.env.LOOK_SET || '{}');
    await page.evaluate((o) => H.capture(o, 1 / 60), `${prefix}-${vid.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}-t${t}.png`);
  }
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
console.log('page log:', page.logs.slice(0, 15).map((l) => l.slice(0, 400)).join('\n'));
await browser.close(); server.close();
