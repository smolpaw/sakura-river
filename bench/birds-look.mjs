// Birds in the scene, headless: set the time and weather, simulate, then capture views and print where they fly.
//   node bench/birds-look.mjs <build> <prefix> '<json [{name, time, weather, sim, hero | view:[x,y,z,tx,ty,tz] | follow:[species, i, dist]}]>'
// time: clock hour; follow: the camera `dist` m away from bird i of species ('swallow', 'kite', 'crow'), looking at it.
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
  await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: 'high', backend: process.env.LOOK_BACKEND ?? 'webgl', settings: V.defaults });
  for (const sh of shots) {
    const info = await page.evaluate((sh) => {
      if (sh.weather) H.call('setWeather', sh.weather, 0);
      if (sh.time !== undefined) H.call('setTimeOfDay', sh.time, false);
      if (sh.hero) H.call('heroView');
      else if (sh.view) H.call('setView', sh.view.slice(0, 3), sh.view.slice(3));
      if (sh.sim) H.call('advance', Math.round(sh.sim * 30), 1 / 30);
      const b = H.call('birdInfo');
      if (sh.follow) {
        const [sp, i, d] = sh.follow, p = b[sp][i];
        // the controls keep the target under 40 m: high birds are looked up at from the ground
        if (p && p[1] < 35) H.call('setView', [p[0] + d * 0.7, p[1] + d * 0.05, p[2] + d * 0.7], p);
        else if (p) { const c = [p[0] + d * 0.7, 3, p[2] + d * 0.7], k = (38 - c[1]) / (p[1] - c[1]); H.call('setView', c, p.map((v, j) => c[j] + (v - c[j]) * k)); }
      }
      H.call('advance', 2, 1 / 60);
      return b;
    }, sh);
    console.log(sh.name, JSON.stringify(info));
    if (sh.name) await page.evaluate((o) => H.capture(o, 1 / 60), `${prefix}-${sh.name}.png`);
  }
} catch (e) { console.log('ERROR', e.message.slice(0, 1500)); }
console.log(page.logs.filter((l) => !/404|GL Driver|toInspector/.test(l)).slice(0, 10).join('\n'));
await browser.close(); server.close();
