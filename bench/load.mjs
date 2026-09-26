// Phase 1 gate: load behaviour of two builds, interleaved.
//   node bench/load.mjs <ref-build> <cand-build> [--runs 7] [--quality high] [--out name] [--extra '{"workers":false}']
// Reports time to first frame (from navigation start), main-thread long tasks during loading (split into
// "before the engine resolved" = generation + assembly, and "first frame" = GPU pipeline creation + uploads),
// and the largest rAF gap while loading.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
import { median, shuffle } from './lib/stats.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'string', default: '7' }, quality: { type: 'string', default: 'high' }, out: { type: 'string' }, extra: { type: 'string' } } });
const [ref, cand] = positionals;
const extra = o.extra ? JSON.parse(o.extra) : {};
const { server, url } = await startServer();
const { browser, version } = await launch({ scale: 1, profile: 'load' });
const rows = { [ref]: [], [cand]: [] };
for (const job of shuffle([...Array(+o.runs)].flatMap(() => [ref, cand]), 3)) {
  const page = await openHarness(browser, url);
  const p = await page.evaluate((b, q, extra) => H.loadProfile({ engine: `./builds/${b}/engine.js`, cssW: 1920, cssH: 1080, quality: q, extra }), job, o.quality, job === cand ? extra : {});
  const lt = p.longtasks.filter((t) => t.start + t.dur > p.tImport && t.start < p.ttff);
  const before = lt.filter((t) => t.start < p.tCreated), after = lt.filter((t) => t.start >= p.tCreated);
  rows[job].push({ marks: p.marks, t0: p.t0, tImport: p.tImport, longtasks: lt.map((t) => [+t.start.toFixed(0), +t.dur.toFixed(0)]), ttff: p.ttff, firstFrameMs: p.firstFrameMs, createMs: p.tCreated - p.tImport, maxGap: p.maxGap,
    longBefore: before.map((t) => +t.dur.toFixed(1)), longFirstFrame: after.map((t) => +t.dur.toFixed(1)), gen: p.gen && { workers: p.gen.workers, ms: p.gen.ms } });
  await page.evaluate(() => H.dispose());
  await page.close();
}
await browser.close(); server.close();
const sum = (b) => {
  const r = rows[b];
  return { ttffMedian: median(r.map((x) => x.ttff)), createMedian: median(r.map((x) => x.createMs)), firstFrameMedian: median(r.map((x) => x.firstFrameMs)),
    maxLongBefore: Math.max(0, ...r.flatMap((x) => x.longBefore)), maxLongFirstFrame: Math.max(0, ...r.flatMap((x) => x.longFirstFrame)), maxGapMedian: median(r.map((x) => x.maxGap)) };
};
const result = { date: new Date().toISOString(), chromium: version, quality: o.quality, extra, runs: +o.runs, summary: { [ref]: sum(ref), [cand]: sum(cand) }, rows };
console.log(JSON.stringify(result.summary, null, 1));
fs.mkdirSync(path.join(BENCH, 'results'), { recursive: true });
fs.writeFileSync(path.join(BENCH, 'results', (o.out || `load-${ref}-vs-${cand}`) + '.json'), JSON.stringify(result, null, 1));
