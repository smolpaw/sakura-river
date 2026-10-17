// The sound's behaviour, checked headless through the engine's debug hooks (soundInfo, soundDebug): the music's
// track by mood, a change of mood handing over at a seam, the hand-over at a track's end, ducking under a near thunderclap,
// a delayed thunderclap dropped after a hidden tab, mute and tab-hide fading out before the music pauses, the loops at
// the scene's levels from the moment sound is back on, the bell only on a time-lapse through dusk or dawn (one rhythm
// through both), the owl only at night, the village by day, rain off the eaves only near a roof
// in the rain, rain on the water near the river, the moored boat, the mandarins, the bridge's creaks, that the walker
// stays out of the water, and the sound stopping on a lost device. It runs in real time (the sound's clock is the browser's), about five minutes.
//   node bench/build.mjs look && BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/sound-check.mjs look [step ...]
// Steps (all by default): mood, seam, end, duck, late, mute, bell, owl, village, roof, boat, ducks, creak, wade, lost.
// It prints what each step saw; it asserts nothing (read the output).
import { startServer } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';

const [build, ...only] = process.argv.slice(2);
const want = (s) => !only.length || only.includes(s);
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'look', extraArgs: ['--autoplay-policy=no-user-gesture-required'] });
const page = await openHarness(browser, url);
page.on('response', (r) => { if (r.status() >= 400) page.logs.push(`[${r.status()}] ${r.url()}`); });
const call = (name, ...a) => page.evaluate((n, a) => H.call(n, ...a), name, a);
const info = () => call('soundInfo');
// render and tick in real time for `sec` s
const run = (sec) => page.evaluate(async (sec) => {
  const end = performance.now() + sec * 1000;
  let last = performance.now();
  while (performance.now() < end) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    H.call('tick', 1, Math.min(0.1, (now - last) / 1000));
    last = now;
  }
}, sec);
const decks = (m) => m.decks.map((d) => `${(d.track || '-').replace('music-', '')} ${d.state}${d.paused ? ' paused' : ''} t${d.t} g${d.gain}`).join(' | ');
const music = (i) => `${(i.music.current || '-').replace('music-', '')} fit ${JSON.stringify(i.music.fit).replace(/music-/g, '')} misfit ${i.music.misfit} swap ${JSON.stringify(i.music.swap)} duck ${i.music.duck} :: ${decks(i.music)}`;
const fired = (i, re) => i.fired.filter((f) => !re || re.test(f.name)).map((f) => `${f.name}@${f.t} g${f.gain} lp${f.lowpass ?? ''} wet${f.wet ?? ''}`).join(', ') || 'none';
const view = (pos, target) => call('setView', pos, target);
const say = (...a) => console.log(...a);
async function hidden(h) {
  await page.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); }, h);
}

try {
  await page.evaluate((p) => H.setup(p), { engine: `./builds/${build}/engine.js`, cssW: 960, cssH: 540, quality: process.env.QUALITY || 'low', backend: process.env.LOOK_BACKEND, extra: {} });
  await call('setWeather', 'clear', 0);
  await call('setTimeOfDay', 14.5, false);
  await call('heroView');
  await call('setSound', true);
  await run(3);
  let i = await info();
  say('start:', i.state, 'waiting', i.waiting, 'master', i.master);
  say('  clear afternoon:', music(i));

  if (want('mood')) {
    for (const [w, h] of [['haze', 14.5], ['clear', 20.75], ['overcast', 14.5], ['clear', 2.5], ['downpour', 14.5]]) {
      await call('setWeather', w, 0); await call('setTimeOfDay', h, false); await run(0.5);
      i = await info();
      say(`mood ${w} ${h}h fit:`, JSON.stringify(i.music.fit).replace(/music-/g, ''));
    }
    await call('setWeather', 'clear', 0); await call('setTimeOfDay', 14.5, false); await run(1);
  }

  if (want('seam')) {
    // the playing track no longer fits (a downpour): after 3 s a change waits for the next seam, then hands over
    i = await info();
    say('seam: before:', music(i));
    await call('setWeather', 'downpour', 0);
    await run(4);
    i = await info();
    say('  downpour after 4 s:', music(i));
    if (i.music.swap) {
      const playing = i.music.decks.find((d) => d.state === 'on');
      await call('soundDebug', { seek: Math.max(0, i.music.swap.out - 1.5) });
      say('  seek to 1.5 s before the fade out to the seam', i.music.swap.at, 'from', playing && playing.t);
      for (let k = 1; k <= 14; k++) { await run(0.5); i = await info(); say(`  +${k / 2}s:`, music(i)); }
    }
  }

  if (want('end')) {
    await call('setWeather', 'clear', 0); await run(0.5);
    i = await info();
    const d = i.music.decks.find((x) => x.state === 'on');
    if (d && d.dur) {
      await call('soundDebug', { seek: d.dur - 11 });
      say('end: seek to 11 s before the end of', d.track, d.dur);
      for (let k = 0; k < 12; k++) { await run(1); i = await info(); say(`  +${k + 1}s:`, music(i)); }
      say('  run', JSON.stringify(i.music.run));
    }
  }

  if (want('duck')) {
    await call('setWeather', 'storm', 0); await run(4); // thunder loads with the lightning
    await call('soundDebug', { clear: true, thunder: [400, true] });
    for (let k = 0; k < 10; k++) { await run(0.5); i = await info(); say(`duck: +${(k + 1) / 2}s duck ${i.music.duck} thunder ${i.shots.thunder}`); }
    say('  fired:', fired(i, /thunder/));
    await call('soundDebug', { clear: true, thunder: [1200, false] });
    await run(5); i = await info();
    say('  far roll: fired', fired(i, /thunder/), 'min duck seen at end', i.music.duck);
  }

  if (want('late')) {
    // a strike 1000 m off (its clap 2.9 s later); the tab hidden at once for 5 s
    await call('soundDebug', { clear: true, thunder: [1000, true] });
    await hidden(true);
    for (const t of [0.1, 0.3, 0.6, 1.0]) { await new Promise((r) => setTimeout(r, t * 1000 - (t > 0.1 ? 0 : 0))); i = await info(); say(`late: hidden +~${t}s: state ${i.state} master ${i.master} music ${decks(i.music)}`); }
    await new Promise((r) => setTimeout(r, 4000));
    await hidden(false);
    await run(2); i = await info();
    say('  back: state', i.state, 'master', i.master, 'thunder fired:', fired(i, /thunder/), 'dropped:', JSON.stringify(i.dropped));
    await call('setWeather', 'clear', 0); await run(1);
  }

  if (want('mute')) {
    // muted in a downpour, the sky cleared meanwhile: the rain is gone from the first moment back on (target/gain)
    await call('setWeather', 'downpour', 0); await run(3);
    const rain = (i) => `rain ${i.beds.rain.target}/${i.beds.rain.gain} drizzle ${i.beds.drizzle.target}/${i.beds.drizzle.gain}`;
    i = await info(); say(`mute: in a downpour: ${rain(i)}`);
    await call('setSound', false);
    for (let k = 0; k < 5; k++) { await new Promise((r) => setTimeout(r, 250)); i = await info(); say(`mute: +${(k + 1) / 4}s master ${i.master} state ${i.state} ${decks(i.music)}`); }
    await call('setWeather', 'clear', 0); await run(1);
    await call('setSound', true);
    await run(0.3); i = await info(); say(`unmute (cleared while muted): +0.3s master ${i.master} ${rain(i)}`);
    for (let k = 0; k < 4; k++) { await run(0.5); i = await info(); say(`unmute: +${(k + 1) / 2 + 0.3}s master ${i.master} state ${i.state} ${rain(i)} ${decks(i.music)}`); }
  }

  if (want('bell')) {
    const bell = async (label, h, animate, forward = true) => {
      await call('soundDebug', { clear: true });
      await call('setTimeOfDay', h, animate, forward);
      await run(6); i = await info();
      say(`bell: ${label}: fired ${fired(i, /bell/)}; waiting ${JSON.stringify(i.waitingShots.filter((w) => /bell/.test(w.name)))}`);
    };
    await call('setWeather', 'clear', 0);
    await call('setTimeOfDay', 14.5, false); await run(1);
    await bell('jump 14:30 -> 20:45', 20.75, false);
    await bell('jump back 20:45 -> 14:30', 14.5, false);
    await bell('time-lapse forward 14:30 -> 20:45', 20.75, true);
    await bell('time-lapse back 20:45 -> 14:30', 14.5, true, false);
    await call('setTimeOfDay', 20.75, false); await run(1);
    await bell('time-lapse forward 20:45 -> 05:30', 5.5, true);
    await bell('time-lapse forward 05:30 -> 14:30', 14.5, true);
    // through dusk and dawn in one lapse: the dawn's toll keeps the dusk's rhythm (strokes about 20 s apart)
    await bell('time-lapse forward 14:30 -> 05:30', 5.5, true);
  }

  if (want('owl')) {
    await call('setWeather', 'clear', 0); await call('heroView');
    for (const h of [14.5, 22]) {
      await call('setTimeOfDay', h, false); await run(1);
      await call('soundDebug', { clear: true, soon: true });
      await run(4); i = await info();
      say(`owl at ${h}h: owl set ${i.shots.owl}; fired ${fired(i, /owl/)}`);
    }
  }

  if (want('village')) {
    await call('setWeather', 'clear', 0);
    await view([-40, 22, -160], [-95, 8, -150]);
    for (const h of [10, 22]) {
      await call('setTimeOfDay', h, false); await run(1);
      for (let k = 0; k < 3; k++) {
        await call('soundDebug', { clear: true, soon: true });
        await run(5); i = await info();
        say(`village at ${h}h: sets ${JSON.stringify(i.shots.village)}; fired ${fired(i, /dog|chop|rooster/)}`);
      }
    }
  }

  if (want('roof')) {
    await call('setTimeOfDay', 14.5, false);
    const at = async (label, pos, target) => {
      await view(pos, target); await run(3); i = await info();
      say(`roof: ${label}: roof ${JSON.stringify(i.beds.roof)} rainwater ${JSON.stringify(i.beds.rainwater)} rain ${i.beds.rain && i.beds.rain.target}`);
    };
    await call('setWeather', 'downpour', 0);
    await at('downpour, 3 m from a farmhouse', [-103, 10.6, -115], [-103, 9, -104]);
    await at('downpour, by the temple', [22, 21, -176], [22, 20, -192]);
    await at('downpour, on the river bank', [-6, 2.5, 34], [0, 0.3, 34]);
    await at('downpour, high over the fields', [-60, 60, -130], [-60, 0, -100]);
    await call('setWeather', 'clear', 0); await run(0.5);
    await at('clear, 3 m from a farmhouse', [-103, 10.6, -115], [-103, 9, -104]);
  }

  if (want('boat')) {
    await call('setWeather', 'clear', 0);
    await view([-11, 2.2, 31], [-6, 0.3, 34.3]);
    await call('soundDebug', { clear: true });
    await run(20); i = await info();
    say('boat (5 m off, 20 s):', fired(i, /knock|hull/));
    await view([-60, 30, 120], [-6, 0.3, 34.3]);
    await call('soundDebug', { clear: true });
    await run(10); i = await info();
    say('boat (100 m off, 10 s):', fired(i, /knock|hull/));
  }

  if (want('ducks')) {
    await call('setTimeOfDay', 10, false);
    const d = await call('duckInfo');
    const m = d.find((x) => /oshidori/.test(x.kind)) || d[d.length - 1];
    const p = m.pos || [m.x, m.y, m.z];
    await view([p[0] + 8, 3, p[2] + 8], [p[0], 0.3, p[2]]);
    await run(2);
    await call('soundDebug', { clear: true });
    await call('duckInfo', { pair: 1, fly: true });
    await run(4); i = await info();
    say('mandarins (flushed, ~11 m):', fired(i, /oshidori/), 'set', i.shots.calls.oshidori);
  }

  if (want('creak')) {
    await call('setWeather', 'clear', 0); await call('setTimeOfDay', 14.5, false);
    const w = await call('walkInfo', true);
    const [a, b] = w.bridgeEnds;
    await call('setWalk', true);
    await run(3);
    const s0 = [a[0] + (b[0] - a[0]) * 0.1, a[2] + (b[2] - a[2]) * 0.1];
    await call('walkTo', s0[0], s0[1], Math.atan2(b[0] - a[0], b[2] - a[2]));
    await run(1);
    const w0 = await call('walkInfo');
    say(`creak: stands at ${w0.pos.map((v) => v.toFixed(1))} on ${w0.surface}, bridge ${a.map((v) => v.toFixed(1))} -> ${b.map((v) => v.toFixed(1))}`);
    await call('soundDebug', { clear: true });
    await call('walkInput', { forward: 1 });
    await run(8); i = await info();
    say('  steps fired:', i.fired.filter((f) => /^step/.test(f.name)).map((f) => f.name).join(' ') || 'none');
    const steps = i.fired.filter((f) => /^step-wood/.test(f.name)).length, creaks = i.fired.filter((f) => /^creak/.test(f.name)).length;
    say(`creak: on the bridge 8 s: ${steps} wood steps, ${creaks} creaks (set ${i.shots.creak}); surface ${(await call('walkInfo')).surface}; ${fired(i, /creak/)}`);
    await call('walkInput', { forward: 0 });
  }

  if (want('wade')) {
    // the walker pushed towards the river where the lanes come nearest it, and onto the bridge's ends: where it ends up
    // and the ground there (the water is at y 0)
    await call('setWalk', true); await run(2);
    for (const [x, z] of [[-25, -60], [-26, -45], [-15, -30], [-14, -20]]) {
      await call('walkTo', x, z, 0); await run(0.5);
      const w = await call('walkInfo');
      say(`wade: asked (${x}, ${z}) -> stands (${w.pos[0].toFixed(1)}, ${w.pos[2].toFixed(1)}), feet y ${w.pos[1].toFixed(2)}, ground ${w.ground.toFixed(2)}, ${w.surface}`);
    }
    await call('setWalk', false);
  }

  if (want('lost')) {
    await call('loseDevice');
    for (const t of [100, 400, 800]) { await new Promise((r) => setTimeout(r, t)); i = await info(); say(`lost: +${t}ms state ${i.state} master ${i.master} ${decks(i.music)}`); }
  }
  say('page errors:', page.logs.filter((l) => !/popErrorScope/.test(l)).join('\n  ') || 'none');
} finally {
  await browser.close();
  server.close();
}
