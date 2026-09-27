// Renders a list of kitten-viewer shots in one headless session.
//   node bench/kview-shots.mjs <prefix> '<json [{name, only, yaw, pos, target, frames}]>'
import { startServer } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [prefix, json] = process.argv.slice(2);
const shots = JSON.parse(json);
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look', headless: true });
const page = await openHarness(browser, url);
try {
  await page.evaluate((p) => H.setup(p), { engine: './builds/kview/engine.js', cssW: 960, cssH: 640, backend: 'webgl', extra: JSON.parse(process.env.KV_OPTS || '{}') });
  for (const s of shots) {
    await page.evaluate((s) => {
      if (s.only !== undefined) H.set('only', s.only);
      if (s.yaw !== undefined) H.set('yaw', s.yaw);
      H.view({ pos: s.pos || [0, 0.13, 0.75], target: s.target || [0, 0.11, 0] }, s.frames ?? 60);
    }, s);
    await page.evaluate((o) => H.capture(o, 1 / 60), `${prefix}-${s.name}.png`);
  }
} catch (e) { console.log('ERROR', e.message.slice(0, 1500)); }
console.log(page.logs.filter((l) => !/404|GL Driver|toInspector/.test(l)).slice(0, 10).join('\n'));
await browser.close(); server.close();
