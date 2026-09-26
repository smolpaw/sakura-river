// CPU profile of steady-state frames (after warm-up): where does the main thread spend a frame?
//   node bench/profile-frame.mjs <build> [webgpu|webgl] [cssW] [cssH] [scale]
import { startServer } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
const [build, backend = 'webgpu', w = 1920, h = 1080, scale = 2] = process.argv.slice(2);
const { server, url } = await startServer();
const { browser } = await launch({ scale: +scale, profile: 'prof' });
const page = await openHarness(browser, url);
await page.evaluate((b, be, w, h) => H.setup({ engine: `./builds/${b}/engine.js`, cssW: +w, cssH: +h, quality: 'high', backend: be }), build, backend, w, h);
await page.evaluate(() => H.view({ hero: true }, 60));
await page.evaluate(() => H.frames(120));
const cdp = await page.createCDPSession();
await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 100 }); await cdp.send('Profiler.start');
const m = await page.evaluate(() => H.frames(60));
const { profile } = await cdp.send('Profiler.stop');
const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
let total = 0;
profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; const d = (profile.timeDeltas[i] || 0) / 1000; self.set(k, (self.get(k) || 0) + d); total += d; });
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
console.log('60 frames: cpu(work) median', med(m.cpu).toFixed(2), 'ms, cpu(total) median', med(m.cpuTotal).toFixed(2), 'ms, gpu samples', m.gpu.length, '| profiled', total.toFixed(0), 'ms');
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log((v / 60).toFixed(3).padStart(8), 'ms/frame', k);
await browser.close(); server.close();
