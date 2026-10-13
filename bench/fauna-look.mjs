// The animals (deer, turtles, ducks, the birds): captures of views at times and weathers, with their states printed.
// A shot can put the traveller somewhere on the paths and walk them (walk mode), call the engine's debug hooks, and
// capture again some seconds later.
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/fauna-look.mjs <build> <outPrefix> '<json shots>'
// shots: [{ "id": "name", "view": "hero" | [x, y, z, tx, ty, tz], "time": 0.3, "set": { "rain": 1 },
//           "calm": true, "from": "feed", "plan": "rest", "call": [["turtleInfo", { "out": true }]], "print": ["turtleInfo"], "sim": 60, "walk": [x, z, yaw], "go": { "forward": 1 }, "then": [x, y, z, tx, ty, tz], "sim2": 30, "after": [0, 2] }]
// calm: the deer ignore the observer (and the others too: perchInfo, turtleInfo { calm }), from: the herd starts afresh
// at that part of its round, plan: keeps to that part (deerInfo { calm, settle, plan }); call: debug hooks called
// with their argument after the view is set; print: the hooks whose state is printed at each capture (deerInfo by
// default); sim: seconds simulated first without rendering (the herd's behaviour moves on; the camera stays); walk: the
// traveller stands there (walk mode; the capture is the traveller's view unless `view` is given after it); go: held
// walk input (walkInput); after: seconds of rendered frames before each capture, one frame per browser frame so the
// skinned meshes' bones follow; then: the camera moves there after `sim` (say, to startle the herd from close by,
// then watch from further off), and sim2 seconds more are simulated.
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
const deer = (info) => info.map((d) => `${d.mode}/${d.move || d.posture} (${d.x},${d.z}) v${d.v} fear${d.fear}`).join(' | ');
const show = async (s) => {
  const out = [];
  for (const n of s.print || ['deerInfo']) { const r = await page.evaluate((n) => H.call(n), n); out.push(n === 'deerInfo' ? deer(r) : JSON.stringify(r)); }
  return out.join('\n  ');
};
try {
  await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: process.env.QUALITY || 'high', backend: process.env.LOOK_BACKEND, settings: V.defaults, extra: {} });
  for (const s of shots) {
    const v = typeof s.view === 'string' ? V.views.find((x) => x.id === s.view) : s.view ? { pos: s.view.slice(0, 3), target: s.view.slice(3) } : V.views[0];
    for (const n of ['deerInfo', 'perchInfo', 'turtleInfo', 'duckInfo', 'heronInfo', 'tanukiInfo']) await page.evaluate((n, c) => H.call(n, { calm: !!c }), n, s.calm);
    await page.evaluate(() => H.call('deerInfo', { plan: null }));
    await page.evaluate((v, t, x) => H.view({ ...v, settings: { time: t, rain: 0, ...x } }, 30), v, s.time ?? 0.3, s.set || {});
    await page.evaluate((p, f) => H.call('deerInfo', { plan: p ?? null, settle: f }), s.plan, s.from);
    for (const [n, a] of s.call || []) await page.evaluate((n, a) => H.call(n, a), n, a);
    if (s.walk) {
      await page.evaluate(() => H.call('setWalk', true));
      await page.evaluate((w) => H.call('walkTo', ...w), s.walk);
      await page.evaluate(() => H.frames(90, 1 / 60));
      if (s.go) await page.evaluate((g) => H.call('walkInput', g), s.go);
    }
    if (s.sim) await page.evaluate((n) => H.call('simulate', n, 1 / 30), s.sim);
    if (s.then) await page.evaluate((t) => H.call('setView', t.slice(0, 3), t.slice(3)), s.then);
    if (s.sim2) await page.evaluate((n) => H.call('simulate', n, 1 / 30), s.sim2);
    console.log(s.id, 'start', await show(s));
    let done = 0;
    for (const a of s.after || [0]) {
      const n = Math.round((a - done) * 60);
      if (n > 0) await page.evaluate((n) => H.frames(n, 1 / 60), n);
      done = a;
      await page.evaluate((o) => H.capture(o, 1 / 60), `${prefix}-${s.id}${s.after ? `-${a}s` : ''}.png`);
      console.log(s.id, a, await show(s));
    }
    if (s.walk) { await page.evaluate(() => H.call('walkInput', { forward: 0, strafe: 0 })); await page.evaluate(() => H.call('setWalk', false)); }
  }
  const stats = await page.evaluate(() => H.meshStats());
  console.log('animal meshes', JSON.stringify((stats.rows || stats).filter((r) => /deer|turtles|ducks|perched|herons|frogs|tanuki|droppedFlowers|bat|heron/.test(r.name))));
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
console.log('page log:', page.logs.slice(0, 15).map((l) => l.slice(0, 400)).join('\n'));
await browser.close(); server.close();
