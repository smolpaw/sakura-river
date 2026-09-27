// Per-pass GPU time breakdown (medians over N frames) for one view, to see where a frame goes.
//   node bench/passes.mjs <build> [--backend webgpu] [--workload hero] [--view hero] [--frames 120] [--extra json]...
// Several --extra values run one after another in the same browser session, for side-by-side comparison.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
import { median } from './lib/stats.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  backend: { type: 'string', default: 'webgpu' }, workload: { type: 'string', default: 'hero' }, view: { type: 'string', default: 'hero' },
  frames: { type: 'string', default: '120' }, extra: { type: 'string', multiple: true, default: ['{}'] },
} });
const build = positionals[0];
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const W = V.workloads[o.workload];
const view = V.views.find((v) => v.id === o.view);
const { server, url } = await startServer();
const { browser } = await launch({ scale: W.scale, profile: 'passes' });
const rows = [];
for (const extra of o.extra) {
  const page = await openHarness(browser, url);
  await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: W.cssW, cssH: W.cssH, quality: W.quality || 'high', backend: o.backend, stress: W.stress, settings: V.defaults, extra: JSON.parse(extra) });
  await page.evaluate((v) => H.view(v, 120), view);
  await page.evaluate(() => H.frames(60)); // warm-up
  const f = await page.evaluate((n) => H.frames(n), +o.frames);
  const g = [...f.gpu, ...(await page.evaluate(() => H.drain()))];
  const labels = [...new Set(g.flatMap((x) => Object.keys(x.gpu)))];
  const per = Object.fromEntries(labels.map((l) => [l, median(g.map((x) => x.gpu[l] || 0))]));
  rows.push({ extra, n: g.length, total: median(g.map((x) => x.total)), per, counters: await page.evaluate(() => { const c = H.counters(); if (c) delete c.renderTargets; return c; }) });
  await page.close();
}
await browser.close(); server.close();
const labels = [...new Set(rows.flatMap((r) => Object.keys(r.per)))].sort((a, b) => (rows[0].per[b] || 0) - (rows[0].per[a] || 0));
console.log(`${build} ${o.backend} ${o.workload} ${o.view}`);
console.log('label'.padEnd(18) + rows.map((r) => r.extra.slice(0, 22).padStart(24)).join(''));
for (const l of labels) console.log(l.padEnd(18) + rows.map((r) => (r.per[l] ?? 0).toFixed(3).padStart(24)).join(''));
console.log('TOTAL'.padEnd(18) + rows.map((r) => r.total.toFixed(3).padStart(24)).join(''));
console.log('frames'.padEnd(18) + rows.map((r) => String(r.n).padStart(24)).join(''));
console.log('drawCalls'.padEnd(18) + rows.map((r) => String(r.counters && r.counters.drawCalls).padStart(24)).join(''));
console.log('triangles'.padEnd(18) + rows.map((r) => String(r.counters && r.counters.triangles).padStart(24)).join(''));
console.log('bandwidthMB'.padEnd(18) + rows.map((r) => (r.counters ? r.counters.bandwidthMB.toFixed(0) : '').padStart(24)).join(''));
