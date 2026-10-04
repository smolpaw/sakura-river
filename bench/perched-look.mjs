// The perched birds (src/perched.js): captures of views at times and weathers, a view can be set relative to one
// bird's perch; prints where they sit and the crow's state.
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/perched-look.mjs <build> <outPrefix> '<json shots>'
// shots: [{ "id": "name", "view": "hero" | [x, y, z, tx, ty, tz] | { "bird": i, "off": [dx, dy, dz], "look": [dx, dy, dz] },
//           or "walk": { "at": [x, z], "bird": i, "look": [dx, dy, dz] }, "time": 0.35, "set": { "rain": 1 }, "calm": true,
//           "after": [0, 0.5] }]
//   (bird: the camera at the bird's perch + off, looking at the perch + look (default 6 cm up); walk: walk mode, the
//   walker standing at [x, z] (on the network) looking at the bird; calm: the crow stays
//   put however close the camera comes; after: seconds of rendered frames before each capture)
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
  const info = await page.evaluate(() => H.call('perchInfo'));
  console.log('perched', JSON.stringify(info));
  for (const s of shots) {
    await page.evaluate((c) => H.call('perchInfo', { calm: c }), !!s.calm);
    if (s.walk) {
      // walk mode: the walker at walk.at [x, z], looking at bird walk.bird (+ look)
      await page.evaluate(() => H.call('setWalk', true));
      const p = info.birds[s.walk.bird], l = s.walk.look || [0, 0.04, 0], at = p.map((x, i) => x + l[i]);
      await page.evaluate((s, t, x) => {
        H.call('walkTo', s.walk.at[0], s.walk.at[1], 0);
        const set = { time: t, rain: 0, ...x };
        for (const k in set) H.set(k, set[k]);
        H.call('advance', 30, 1 / 60);
      }, s, s.time ?? 0.35, s.set || {});
      const eye = (await page.evaluate(() => H.call('walkInfo'))).eye, d = at.map((x, i) => x - eye[i]);
      await page.evaluate((o) => { H.call('walkInput', o); H.call('advance', 60, 1 / 60); }, { forward: 0, strafe: 0, yaw: Math.atan2(d[0], d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) });
      console.log(s.id, 'eye', eye.map((x) => +x.toFixed(2)), 'to bird', +Math.hypot(...d).toFixed(2), 'm');
    } else {
    let v;
    if (s.view === 'hero') v = { hero: true };
    else if (Array.isArray(s.view)) v = { pos: s.view.slice(0, 3), target: s.view.slice(3) };
    else {
      const p = info.birds[s.view.bird], o = s.view.off, l = s.view.look || [0, 0.06, 0];
      // the orbit controls keep the target at least 4 m off: aim past the bird along the same line
      const pos = p.map((x, i) => x + o[i]), at = p.map((x, i) => x + l[i]), d = Math.hypot(...at.map((x, i) => x - pos[i]));
      v = { pos, target: at.map((x, i) => pos[i] + ((x - pos[i]) * Math.max(4.5, d)) / d) };
    }
    await page.evaluate((v, t, x) => H.view({ ...v, settings: { time: t, rain: 0, ...x } }, 90), v, s.time ?? 0.35, s.set || {});
    }
    let done = 0;
    for (const a of s.after || [0]) {
      const n = Math.round((a - done) * 60);
      if (n > 0) await page.evaluate((n) => H.frames(n, 1 / 60), n);
      done = a;
      await page.evaluate((o) => H.capture(o, 1 / 60), `${prefix}-${s.id}${s.after ? `-${a}s` : ''}.png`);
      const st = await page.evaluate(() => H.call('perchInfo'));
      console.log(s.id, a, JSON.stringify({ amount: st.amount, visible: st.visible, crow: st.crow }));
    }
  }
  const stats = await page.evaluate(() => H.meshStats());
  console.log('perched meshes', JSON.stringify((stats.rows || stats).filter((r) => /perched/.test(r.name))));
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
console.log('page log:', page.logs.slice(0, 15).map((l) => l.slice(0, 400)).join('\n'));
await browser.close(); server.close();
