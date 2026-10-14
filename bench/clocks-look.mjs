// The running clocks (main.js runClocks), headless WebGL. Two checks:
//   node bench/clocks-look.mjs <build> <prefix> [offsets] [views]
//     Precision: each view with the clocks as after `offset` seconds of running (setClocks), handed to the shaders
//     wrapped as the engine does (unwrapped with WRAP=0): a still of each, and the motion from frame to frame. Prints
//     per view and offset the mean absolute change of 8x8 pixel blocks (0..255; the film grain averages out) between
//     consecutive frames at 60 fps: clocks that have lost precision move in steps, so some pairs barely change and
//     others jump (min/max well under 1). offsets: comma-separated seconds (default 0,1e3,1e4,1e5,1e6).
//   node bench/clocks-look.mjs <build> <prefix> --wrap [views]
//     The wraps: each view rendered with every clock just past its loop, once unwrapped and once wrapped, the scene
//     otherwise the same (dt 0): prints how far the two frames differ (8x8 blocks; pixels over 6/255: the grain alone
//     moves pixels by up to ~3); then the frames running through the wraps, the change across the wrap against the
//     frames' change either side. Then the sky's clouds' restart: frames across it and through its crossfade.
// views: comma-separated names below (default all). The sun's shadow and the reflection are redrawn every frame, so
// only the scene's motion changes between frames. Stills go to bench/<prefix>-<view>-<what>.png.
import { startServer } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';
import { createWorld } from '../src/world.js';

const args = process.argv.slice(2);
const wrapMode = args.includes('--wrap');
const [build, prefix, a3, a4] = args.filter((a) => a !== '--wrap');
const offArg = wrapMode ? null : a3 || '0,1e3,1e4,1e5,1e6', viewArg = wrapMode ? a3 : a4;
const world = createWorld(7);
const rx = (z) => world.riverX(z);
const VIEWS = {
  water: { pos: [rx(20) + 5, 2.2, 26], target: [rx(14), 0, 14], hour: 11 },
  grass: { pos: [-21.2, 2.84, -20], target: [-21.4, 1.2, -32], hour: 11 },
  stars: { pos: [0, 3, 30], target: [0, 80, -40], hour: 23 },
  clouds: { pos: [0, 3, 30], target: [0, 40, -40], hour: 13, weather: 'overcast' },
  lamps: { hero: true, hour: 21 },
  banners: { bridgeEnd: 1, hour: 11 }, // (the nobori at the bridge's east landing)
  rain: { pos: [rx(20) + 5, 2.2, 26], target: [rx(14), 0, 14], hour: 15, weather: 'downpour' },
  tree: { hero: true, hour: 11 }, // (the perched birds, the butterflies)
  crown: { pos: [-20, 3, 0], target: [-17, 4.5, 2.5], hour: 11 },
  fireflies: { pos: [rx(-60) + 8, 2, -50], target: [rx(-75), 0.5, -75], hour: 21.5 },
};
const names = viewArg ? viewArg.split(',') : Object.keys(VIEWS);
const FRAMES = +(process.env.FRAMES || 8);
const f3 = (x) => x.toFixed(3);

const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look' });
const page = await openHarness(browser, url);
try {
  await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 1280, cssH: 720, quality: process.env.QUALITY || 'high', backend: 'webgl', settings: { wind: 0.6, river: 0.45 }, extra: { shadowEvery: 1, reflEvery: 1 } });
  await page.evaluate(() => {
    const c = document.querySelector('canvas'), gl = c.getContext('webgl2');
    const B = 8;
    // render one frame (dt s on), read it back
    window.frame = async (dt) => {
      await new Promise((r) => requestAnimationFrame(r));
      H.call('tick', 1, dt);
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const bw = (w / B) | 0, bh = (h / B) | 0, m = new Float32Array(bw * bh * 3);
      for (let y = 0; y < bh * B; y++) for (let x = 0; x < bw * B; x++) {
        const i = (y * w + x) * 4, o = (((y / B) | 0) * bw + ((x / B) | 0)) * 3;
        m[o] += px[i]; m[o + 1] += px[i + 1]; m[o + 2] += px[i + 2];
      }
      return { px, m };
    };
    // how far two frames differ: the mean absolute change of their 8x8 blocks' means (RGB, 0..255), and the pixels
    // that changed by more than 6 in any channel
    window.diff = (a, b) => {
      let s = 0, n = 0;
      for (let i = 0; i < a.m.length; i++) s += Math.abs(a.m[i] - b.m[i]);
      for (let i = 0; i < a.px.length; i += 4) if (Math.abs(a.px[i] - b.px[i]) > 6 || Math.abs(a.px[i + 1] - b.px[i + 1]) > 6 || Math.abs(a.px[i + 2] - b.px[i + 2]) > 6) n++;
      return { block: s / (a.m.length * B * B), px: n };
    };
    window.place = (v) => {
      H.call('setWeather', v.weather || 'clear', 0);
      H.call('setTimeOfDay', v.hour, false);
      if (v.bridgeEnd !== undefined) {
        const e = H.call('walkInfo', true).bridgeEnds[v.bridgeEnd];
        v = { pos: [e[0] + 9, e[1] + 3, e[2] + 9], target: [e[0], e[1] + 1.5, e[2]] };
      }
      H.view(v, 90);
    };
    // n frames running at 60 fps from the clocks `at`: the changes between consecutive frames
    window.run = async (at, n, wrap = true) => {
      H.call('setClocks', at, wrap);
      let prev = await frame(0);
      const out = [];
      for (let i = 0; i < n; i++) { const f = await frame(1 / 60); out.push(diff(prev, f)); prev = f; }
      return out;
    };
  });
  const L = (await page.evaluate(() => H.call('clockInfo'))).loops;
  const wrap = process.env.WRAP !== '0';
  if (!wrapMode) {
    for (const name of names) for (const off of offArg.split(',').map(Number)) {
      await page.evaluate((v) => place(v), VIEWS[name]);
      for (let i = 0; i < 2; i++) await page.evaluate((o, i, off, w) => { if (!i) H.call('setClocks', off, w); return H.capture(o, i ? 1 / 60 : 0); }, `${prefix}-${name}-${off}-f${i}.png`, i, off, wrap);
      const d = (await page.evaluate((off, n, w) => run(off, n, w), off, FRAMES, wrap)).map((x) => x.block).slice(1);
      console.log(name, String(off).padStart(8), 'diffs', d.map(f3).join(' '), ' min/max', (Math.min(...d) / Math.max(...d)).toFixed(2));
    }
  } else {
    // every clock a little past a wrap (the clouds' shadows: their drift's loop); the sky's clouds not near theirs
    const past = (loop, k, s) => loop * k + s;
    const C = { time: past(L.time, 1, 0.37), run: past(L.run, 3, 0.21), flow: past(L.flow, 1, 0.29), cloud: [past(L.cloudShadow, 1, 0.011), -past(L.cloudShadow, 1, 0.007)] };
    // uTime 2.5 frames before its wrap (the others close before theirs), to run through them
    const before = { time: past(L.time, 1, -2.5 / 60), run: past(L.run, 3, -0.02), flow: past(L.flow, 1, -0.05), cloud: [past(L.cloudShadow, 1, -0.0004), -past(L.cloudShadow, 1, -0.0002)] };
    for (const name of names) {
      await page.evaluate((v) => place(v), VIEWS[name]);
      const r = await page.evaluate(async (C, a, b) => {
        H.call('setClocks', C, false); const A = await frame(0); await H.capture(a, 0);
        H.call('setClocks', C, true); const W = await frame(0); await H.capture(b, 0);
        return diff(A, W);
      }, C, `${prefix}-${name}-unwrapped.png`, `${prefix}-${name}-wrapped.png`);
      const seq = await page.evaluate((b, n) => run(b, n), before, 6);
      console.log(name.padEnd(8), 'unwrapped vs wrapped: blocks', f3(r.block), ' pixels >6:', r.px, '  running through the wraps (the 3rd crosses uTime\'s):', seq.map((x) => f3(x.block)).join(' '));
    }
    // the sky's clouds starting again: frames either side of it, then 10 s steps through the crossfade
    await page.evaluate((v) => place(v), VIEWS.clouds);
    const cl = await page.evaluate(async (L, p) => {
      // (at this wind the drift's x part reaches the restart's distance first)
      const x = H.call('clockInfo');
      H.call('setClocks', { time: x.time, run: x.run, flow: x.flow, cloud: [L.cloud - 0.0002, -100] });
      const info = [H.call('clockInfo')];
      let prev = await frame(0); await H.capture(p + '-before.png', 0);
      const out = [];
      for (let i = 0; i < 4; i++) { const f = await frame(1 / 60); out.push(diff(prev, f).block); prev = f; info.push(H.call('clockInfo')); }
      await H.capture(p + '-after.png', 0);
      const fade = [];
      for (let s = 10; s <= 70; s += 10) {
        H.call('advance', 600, 1 / 60);
        const a = await frame(0), b = await frame(1 / 60);
        fade.push({ s, fade: +H.call('clockInfo').cloudFade.toFixed(3), step: diff(a, b).block });
        if (s === 30) await H.capture(p + '-30s.png', 0);
      }
      return { out, fade, info: info.map((i) => [i.cloud.map((v) => +v.toFixed(4)), i.uCloud.map((v) => +v.toFixed(4)), +i.cloudFade.toFixed(4)]) };
    }, L, `${prefix}-clouds-restart`);
    console.log('clouds restart: frame changes across it', cl.out.map(f3).join(' '), ' [drift, uCloud, fade]:', JSON.stringify(cl.info));
    console.log('  through the crossfade (frame change at each 10 s):', cl.fade.map((x) => `${x.s}s fade ${x.fade}: ${f3(x.step)}`).join(', '));
  }
} catch (e) { console.log('ERROR', e.message.slice(0, 2000)); }
console.log('page log:', page.logs.filter((l) => !/popErrorScope|GPU stall due to ReadPixels/.test(l)).slice(0, 20).map((l) => l.slice(0, 300)).join('\n'));
await browser.close(); server.close();
