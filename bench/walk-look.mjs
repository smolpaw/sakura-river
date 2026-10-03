// Walk mode, headless: enter it, walk each leg of the network with walkInput (steering along a route), capture a
// view every ~20 m of travel and a few looking down, then leave it and capture the orbit view behind the figure.
//   node bench/walk-look.mjs <build> <prefix> [hour] [legs]     legs: comma-separated names below (default all)
// Prints, per leg, whether it got to its end, how long it took, the steepest climb of the eye and the furthest it
// strayed off the network (0: never); the PNGs go to bench/<prefix>-<leg>-<n>.png.
import { startServer } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
import { createWorld } from '../src/world.js';

const [build, prefix, hour = '11', legArg] = process.argv.slice(2);
const world = createWorld(7);
const T = world.temple, tc = Math.cos(T.yaw), ts = Math.sin(T.yaw);
const toW = (x, z) => [T.x + x * tc + z * ts, T.z - x * ts + z * tc]; // the temple's frame (temple.js)

// the legs as routes through the network (net: walkInfo(true) of the page)
function routes(net) {
  const L = world.LANES, [e0, e1] = net.bridgeEnds.map((p) => [p[0], p[2]]);
  const A = [e1[0] - e0[0], e1[1] - e0[1]], al = Math.hypot(...A), F = [A[1] / al, -A[0] / al]; // across, and along -flow
  const off = (p, k, s = 0) => [p[0] + (A[0] / al) * k - F[0] * s, p[1] + (A[1] / al) * k - F[1] * s];
  const link = net.ways.find((w) => w.name === 'stepsLink').pts; // foot, out, bend, join
  const lane1 = L[1].slice(1).filter((p) => world.templeDist(...p) > 2 && p[1] > link[3][1] + 1);
  return {
    // from the footpath's end by the cherry tree down the west bank, round the corner post onto the deck
    tree: [[-22, -4.6], ...L[0].slice().reverse().slice(1, -2), off(e0, -2.2), e0],
    bridge: [e0, e1, off(e1, 2.2)],
    // the approach to the foot of the temple's steps, up them and along the terrace
    temple: [off(e1, 2.2), ...lane1, link[3], link[2], link[1], link[0], toW(-7, 11), toW(0, 10.6), toW(14, 10.6)],
    // back over the bridge's west landing, round the corner post, along the valley lane to the village's end
    village: [off(e0, -2.2), off(e0, -2.4, -2.6), ...L[3]],
    // from the approach along the lane over the terraces to the hamlet
    hamlet: [...L[2]],
  };
}

// steer at a point `ahead` m on along the route from where the walker is; sidestep when stuck
function follower(route, ahead = 2.5) {
  let seg = 0, hist = [], strafeT = 0, side = 1;
  return (st) => {
    const last = route[route.length - 1];
    if (Math.hypot(st.x - last[0], st.z - last[1]) < 0.9) return { done: true };
    let best = Infinity, bi = seg, bt = 0;
    for (let i = seg; i < Math.min(route.length - 1, seg + 4); i++) {
      const [ax, az] = route[i], [bx, bz] = route[i + 1], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz || 1;
      const t = Math.max(0, Math.min(1, ((st.x - ax) * vx + (st.z - az) * vz) / l2));
      const d = Math.hypot(st.x - ax - vx * t, st.z - az - vz * t);
      if (d < best) { best = d; bi = i; bt = t; }
    }
    seg = bi;
    let i = bi, px = route[i][0] + (route[i + 1][0] - route[i][0]) * bt, pz = route[i][1] + (route[i + 1][1] - route[i][1]) * bt, left = ahead;
    for (;;) {
      const r = Math.hypot(route[i + 1][0] - px, route[i + 1][1] - pz);
      if (r >= left || i + 2 >= route.length) { const k = Math.min(1, left / (r || 1)); px += (route[i + 1][0] - px) * k; pz += (route[i + 1][1] - pz) * k; break; }
      left -= r; px = route[i + 1][0]; pz = route[i + 1][1]; i++;
    }
    hist.push([st.x, st.z]);
    if (hist.length > 5) hist.shift();
    let strafe = 0;
    if (strafeT > 0) { strafeT--; strafe = side; }
    else if (hist.length === 5 && Math.hypot(st.x - hist[0][0], st.z - hist[0][1]) < 0.25) { strafeT = 4; side = -side; strafe = side; hist = []; }
    return { yaw: Math.atan2(px - st.x, pz - st.z), strafe };
  };
}

const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look', headless: true });
const page = await openHarness(browser, url);
const call = (name, ...a) => page.evaluate((n, a) => H.call(n, ...a), name, a);
const shot = async (name) => { await call('tick', 2, 1 / 60); await page.evaluate((o) => H.capture(o, 1 / 60), `${prefix}-${name}.png`); };
try {
  await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: process.env.QUALITY || 'high', backend: process.env.LOOK_BACKEND ?? 'webgl', settings: {} });
  await call('setWeather', 'clear', 0);
  await call('setTimeOfDay', +hour, false);
  await call('heroView');
  await call('advance', 30, 1 / 60);
  await page.evaluate(() => H.call('setWalk', true)); // resolves when the walker's body is in the scene
  for (let i = 0; i < 12; i++) await call('advance', 20, 1 / 60); // the flight into the eye
  let info = await call('walkInfo', true);
  console.log('entered', JSON.stringify({ walking: info.walking, flying: info.flying, walker: info.walker, firstPerson: info.firstPerson, pos: info.pos.map((v) => +v.toFixed(2)), eye: info.eye.map((v) => +v.toFixed(2)), fov: info.fov, steps: info.steps, obstacles: info.obstacles.length }));
  await shot('start');
  const R = routes(info);
  const legs = legArg ? legArg.split(',') : Object.keys(R);
  for (const name of legs) {
    const route = R[name], f = follower(route);
    await call('walkTo', route[0][0], route[0][1], Math.atan2(route[1][0] - route[0][0], route[1][1] - route[0][1]));
    let st = await call('walkInfo'), travelled = 0, sinceShot = 0, n = 0, t = 0, maxVy = 0, maxOff = 0, camOff = 0, done = false, downShot = false, prevY = st.pos[1];
    const prof = [];
    while (t < 400) {
      const r = f({ x: st.pos[0], z: st.pos[2] });
      if (r.done) { done = true; break; }
      await call('walkInput', { forward: 1, strafe: r.strafe, hurry: true, yaw: r.yaw, pitch: 0 });
      const before = st.pos;
      await call('advance', 6, 1 / 60); t += 0.1;
      st = await call('walkInfo');
      const d = Math.hypot(st.pos[0] - before[0], st.pos[2] - before[2]);
      travelled += d; sinceShot += d;
      maxVy = Math.max(maxVy, Math.abs(st.pos[1] - prevY) / 0.1); prevY = st.pos[1];
      camOff = Math.max(camOff, Math.hypot(st.eye[0] - st.camera[0], st.eye[1] - st.camera[1], st.eye[2] - st.camera[2]));
      maxOff = Math.max(maxOff, st.off);
      if (prof.length < 400 && Math.round(t * 10) % 20 === 0) prof.push(`${st.pos[0].toFixed(0)},${st.pos[2].toFixed(0)}:${st.pos[1].toFixed(1)}${st.surface[0]}`);
      if (sinceShot >= 20) { sinceShot = 0; await shot(`${name}-${String(++n).padStart(2, '0')}`); }
      // one looking down, half way over the bridge and along the first lane
      if (!downShot && ((name === 'bridge' && travelled > 10) || (name === 'tree' && travelled > 25))) {
        downShot = true;
        await call('walkInput', { forward: 0, strafe: 0, pitch: -70 * Math.PI / 180 });
        await call('advance', 40, 1 / 60);
        await shot(`${name}-down`);
        st = await call('walkInfo');
      }
    }
    await call('walkInput', { forward: 0, strafe: 0 });
    await call('advance', 40, 1 / 60);
    await shot(`${name}-end`);
    st = await call('walkInfo');
    console.log(`${name}: ${done ? 'reached its end' : 'DID NOT reach its end'} after ${travelled.toFixed(0)} m in ${t.toFixed(0)} s; at ${st.pos.map((v) => v.toFixed(2))} on ${st.surface}; eye ${(st.eye[1] - st.pos[1]).toFixed(2)} m over the feet; camera off the eye at most ${camOff.toFixed(3)} m; steepest climb ${maxVy.toFixed(2)} m/s; furthest off the network ${maxOff.toFixed(3)} m`);
    console.log('   ', prof.join(' '));
  }
  // leave: the orbit view behind the figure; then the orbit controls again (the hero view)
  const last = await call('walkInfo');
  await call('setWalk', false);
  for (let i = 0; i < 8; i++) await call('advance', 20, 1 / 60);
  info = await call('walkInfo');
  console.log('left', JSON.stringify({ walking: info.walking, fov: info.fov, figure: info.pos.map((v) => +v.toFixed(2)), was: last.pos.map((v) => +v.toFixed(2)), camera: info.camera.map((v) => +v.toFixed(2)) }));
  await shot('left');
  await call('heroView');
  await call('advance', 30, 1 / 60);
  await shot('hero-after');
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
console.log(page.logs.filter((l) => !/404|GL Driver|toInspector/.test(l)).slice(0, 12).join('\n'));
await browser.close(); server.close();
