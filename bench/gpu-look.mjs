// Headed WebGPU look: renders views like look.mjs but in a window on the desktop and on WebGPU, saving the page as the
// compositor shows it (page.screenshot), since a WebGPU canvas reads back blank headless. The WebGPU-only paths
// (compute petals, ...) show here.
//   node bench/gpu-look.mjs <build> <outPrefix> [time,...] [view-id|x,y,z:tx,ty,tz ...]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, prefix, times = '0.92', ...views] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look', headless: false });
const page = await openHarness(browser, url);
await page.setViewport({ width: 1280, height: 720 });
try {
  const s = await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: process.env.QUALITY || 'high', backend: 'webgpu', settings: V.defaults, extra: JSON.parse(process.env.EXTRA || '{}') });
  console.log('setup', JSON.stringify({ createMs: Math.round(s.createMs), backend: s.backend }));
  for (const t of times.split(',')) for (const vid of views.length ? views : ['hero']) {
    const v = vid.includes(':') ? { pos: vid.split(':')[0].split(',').map(Number), target: vid.split(':')[1].split(',').map(Number) } : V.views.find((x) => x.id === vid);
    await page.evaluate((v, t, x) => H.view({ ...v, settings: { time: +t, ...JSON.parse(x) } }, 90), v, t, process.env.LOOK_SET || '{}');
    for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { H.call('tick', 1, 1 / 60); r(); })));
    await page.screenshot({ path: path.join(BENCH, `${prefix}-${vid.replace(/[^a-z0-9]/gi, '_').slice(0, 30)}-t${t}.png`) });
  }
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
console.log('page log:', page.logs.filter((l) => !/popErrorScope/.test(l)).slice(0, 15).map((l) => l.slice(0, 400)).join('\n'));
await browser.close(); server.close();
