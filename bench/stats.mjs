// Triangles drawn per object at given views (headless, no images): which content costs what.
//   BENCH_HEADLESS=1 node bench/stats.mjs <build> [view-id|x,y,z:tx,ty,tz ...]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, ...views] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look' });
const page = await openHarness(browser, url);
try {
  await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: process.env.QUALITY || 'high', backend: process.env.LOOK_BACKEND, settings: V.defaults });
  for (const vid of views.length ? views : ['hero']) {
    const v = vid.includes(':') ? { pos: vid.split(':')[0].split(',').map(Number), target: vid.split(':')[1].split(',').map(Number) } : V.views.find((x) => x.id === vid);
    await page.evaluate((v) => H.view({ ...v, settings: {} }, 10), v);
    const r = await page.evaluate(() => { const s = H.call('meshStats'); const by = {}; for (const m of s) by[m.name] = (by[m.name] || 0) + m.total; return { by, info: H.call('info') }; });
    const top = Object.entries(r.by).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `${k} ${(n / 1e3).toFixed(0)}k`).join(', ');
    console.log(vid, '| frame tris', r.info.tris, 'calls', r.info.calls, '|', top);
  }
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
await browser.close(); server.close();
