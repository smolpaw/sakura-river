// The people at work (src/figures.js): captures of views at times and weathers, after waiting for their model, with
// their state printed; a shot can start a figure's second clip and capture again some seconds later.
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/figures-look.mjs <build> <outPrefix> '<json shots>'
// shots: [{ "id": "name", "view": "hero" | "cine250" | [x, y, z, tx, ty, tz], "time": 0.35, "set": { "rain": 1 },
//           "act": "fisherman" | "planter", "after": [0, 2] }]   (after: seconds of rendered frames before each
//           capture, one frame per browser frame so the skinned meshes' bones follow)
import fs from 'node:fs';
import path from 'node:path';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, prefix, json] = process.argv.slice(2);
const shots = JSON.parse(json);
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look' });
const page = await openHarness(browser, url);
try {
  await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: process.env.QUALITY || 'high', backend: process.env.LOOK_BACKEND, settings: V.defaults, extra: {} });
  // the model is fetched after start-up
  for (let i = 0; i < 100; i++) {
    const info = await page.evaluate(() => H.call('figureInfo'));
    if (Object.keys(info).length) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const s of shots) {
    const v = typeof s.view === 'string' ? V.views.find((x) => x.id === s.view) : { pos: s.view.slice(0, 3), target: s.view.slice(3) };
    await page.evaluate((v, t, x) => H.view({ ...v, settings: { time: t, rain: 0, ...x } }, 90), v, s.time ?? 0.35, s.set || {});
    if (s.act) await page.evaluate((n) => H.call('figureAct', n), s.act);
    let done = 0;
    for (const a of s.after || [0]) {
      const n = Math.round((a - done) * 60);
      if (n > 0) await page.evaluate((n) => H.frames(n, 1 / 60), n);
      done = a;
      await page.evaluate((o) => H.capture(o, 1 / 60), `${prefix}-${s.id}${s.after ? `-${a}s` : ''}.png`);
      console.log(s.id, a, JSON.stringify(await page.evaluate(() => H.call('figureInfo'))));
    }
  }
  const stats = await page.evaluate(() => H.meshStats());
  console.log('figures meshes', JSON.stringify((stats.rows || stats).filter((r) => /fisherman|planter|seedlings|figureGlows/.test(r.name))));
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
console.log('page log:', page.logs.slice(0, 15).map((l) => l.slice(0, 400)).join('\n'));
await browser.close(); server.close();
