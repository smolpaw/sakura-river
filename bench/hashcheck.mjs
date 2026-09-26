// Phase 1 gate helper: compare generated-buffer hashes of two builds, plus load timing (long tasks, TTFF).
//   node bench/hashcheck.mjs <ref-build> <cand-build> [quality...]
import fs from 'node:fs';
import path from 'node:path';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';

const [ref, cand, ...qs] = process.argv.slice(2);
const qualities = qs.length ? qs : ['high', 'low'];
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'hash' });
const out = { ref, cand, qualities: {} };
let ok = true;
for (const quality of qualities) {
  const res = {};
  for (const b of [ref, cand]) {
    const page = await openHarness(browser, url);
    const s = await page.evaluate((b, quality) => H.setup({ engine: `./builds/${b}/engine.js`, cssW: 1600, cssH: 900, quality }), b, quality);
    res[b] = { hash: await page.evaluate(() => H.hashScene()), createMs: s.createMs, gen: s.info.gen, logs: page.logs };
    await page.close();
  }
  // labels from before the flipped-rows normalisation carried '.flipN'; the hashed bytes are comparable
  const norm = (h) => { const items = h.items.map((x) => x.replace(/\.flip\d/, '')).sort(); return { items, all: items.join('\n') }; };
  const A = norm(res[ref].hash), B = norm(res[cand].hash);
  const onlyA = A.items.filter((x) => !B.items.includes(x)), onlyB = B.items.filter((x) => !A.items.includes(x));
  const same = A.all === B.all;
  ok &&= same;
  out.qualities[quality] = { same, items: A.items.length, onlyRef: onlyA, onlyCand: onlyB, createMs: { [ref]: res[ref].createMs, [cand]: res[cand].createMs }, gen: res[cand].gen, logs: res[cand].logs.slice(0, 5) };
  console.log(quality, same ? 'IDENTICAL' : 'DIFFERENT', `${A.items.length} buffers`, 'create ms', res[ref].createMs.toFixed(0), '->', res[cand].createMs.toFixed(0));
  if (!same) console.log(' only in ref:', onlyA.slice(0, 8), '\n only in cand:', onlyB.slice(0, 8));
}
await browser.close(); server.close();
fs.mkdirSync(path.join(BENCH, 'out'), { recursive: true });
fs.writeFileSync(path.join(BENCH, 'out', `hash-${ref}-${cand}.json`), JSON.stringify(out, null, 1));
process.exit(ok ? 0 : 1);
