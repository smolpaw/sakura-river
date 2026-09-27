// Kittens in the scene, headless: simulate, then capture views of them and print what they are doing.
//   node bench/kittens-look.mjs <build> <prefix> '<json [{name, sim, time, act:[i,name], view:[i,dist,angle] | hero, set:{}}]>'
import { startServer } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { BENCH } from './lib/serve.mjs';
const [build, prefix, json] = process.argv.slice(2);
const shots = JSON.parse(json);
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look', headless: true });
const page = await openHarness(browser, url);
try {
  const s = await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: 'high', backend: process.env.LOOK_BACKEND ?? 'webgl', settings: V.defaults });
  console.log('setup', JSON.stringify({ createMs: Math.round(s.createMs), info: s.info.gen.timing.kitten }));
  for (const sh of shots) {
    const info = await page.evaluate((sh) => {
      for (const k in sh.set || {}) H.set(k, sh.set[k]);
      if (sh.time !== undefined) H.set('time', sh.time);
      if (sh.act) H.call('kittenAct', ...sh.act);
      if (sh.sim) H.call('advance', Math.round(sh.sim * 30), 1 / 30);
      if (sh.watch !== undefined) H.call('watchKittens', sh.watch);
      if (sh.hero) H.call('heroView'); else if (sh.view) H.call('kittenView', ...sh.view);
      H.call('advance', 2, 1 / 60);
      return H.call('kittenInfo');
    }, sh);
    console.log(sh.name, JSON.stringify(info));
    if (sh.seq) {
      // a strip of frames `step` apart, the camera following kitten sh.view[0]
      for (let j = 0; j < sh.seq; j++) {
        await page.evaluate((sh) => { H.call('advance', sh.step || 4, 1 / 60); H.call('kittenView', ...sh.view); }, sh);
        await page.evaluate((o) => H.capture(o, 1 / 60), `${prefix}-${sh.name}-${String(j).padStart(2, '0')}.png`);
      }
    } else if (sh.name) await page.evaluate((o) => H.capture(o, 1 / 60), `${prefix}-${sh.name}.png`);
  }
} catch (e) { console.log('ERROR', e.message.slice(0, 1500)); }
console.log(page.logs.filter((l) => !/404|GL Driver|toInspector/.test(l)).slice(0, 10).join('\n'));
await browser.close(); server.close();
