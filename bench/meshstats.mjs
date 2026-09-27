// Triangles per drawable at a view: node bench/meshstats.mjs <build> [webgpu|webgl] [quality] [stress-json]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, backend = 'webgpu', quality = 'high', stress] = process.argv.slice(2);
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'smoke' });
const page = await openHarness(browser, url);
await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1600, cssH: 900, quality, backend, settings: V.defaults, stress: stress ? JSON.parse(stress) : undefined });
const rows = await page.evaluate(() => H.meshStats());
const by = {};
for (const r of rows) { const k = `${r.name} L${r.layers}${r.shadow ? ' shadow' : ''}`; by[k] = by[k] || { tri: 0, draws: 0, inst: 0 }; by[k].tri += r.total; by[k].draws++; by[k].inst += r.n; }
const tot = Object.values(by).reduce((a, b) => a + b.tri, 0);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].tri - a[1].tri)) console.log(k.padEnd(28), String(Math.round(v.tri)).padStart(10), `${(100 * v.tri / tot).toFixed(1)}%`.padStart(7), 'draws', v.draws, 'inst', v.inst);
console.log('total', tot);
await browser.close(); server.close();
