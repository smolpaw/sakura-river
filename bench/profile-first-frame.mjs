// CPU profile of the first rendered frame (what the first-frame long task consists of).
//   node bench/profile-first-frame.mjs <build> [extra-json]
import { startServer } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, extraJson] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'prof' });
const page = await openHarness(browser, url);
await page.evaluate((b, extra) => H.setup({ engine: `./builds/${b}/engine.js`, cssW: 1920, cssH: 1080, quality: 'high', extra }), build, extraJson ? JSON.parse(extraJson) : {});
await page.evaluate(() => H.view({ hero: true }, 0));
const cdp = await page.createCDPSession();
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
const t = await page.evaluate(() => { const t0 = performance.now(); H.tickRaw(); return performance.now() - t0; });
const { profile } = await cdp.send('Profiler.stop');
const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas; let total = 0;
profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000); total += (dt[i] || 0) / 1000; });
console.log('first frame', t.toFixed(0), 'ms; profiled', total.toFixed(0), 'ms');
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(v.toFixed(1).padStart(8), k);
await browser.close(); server.close();
