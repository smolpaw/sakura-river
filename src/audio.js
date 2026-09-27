// Sound: Japanese background music and the scene's ambience, mixed from the weather, the clock and the camera.
// Loops (river, wind, rain, birds by day, frogs at night) play from decoded buffers, loaded when first heard and
// dropped after a minute unheard; thunder follows each lightning strike after the sound's travel time; bush
// warblers sing in short bouts by day. Music streams through a media element. Files: public/audio/, built by
// tools/audio.mjs. Nothing is fetched or created until sound is turned on.
import { clamp, lerp, smoothstep } from './noise.js';

// loudness of each track (tools/audio.mjs prints it); music plays at MUSIC_LUFS at full volume, the loops are
// levelled to -24 LUFS
const TRACKS = [['music-sakuya3', -9.1], ['music-oboro', -8.4], ['music-shizima4', -9.7]];
const MUSIC_LUFS = -20;
const PAD = 0.5; // each loop file carries PAD s of wrap-around on both ends (tools/audio.mjs)
const THUNDER_NEAR = 4, THUNDER_FAR = 3, SONGS = 4;
const SPEED_OF_SOUND = 343;
const TICK = 0.1; // mix update interval, s

export function createSound(world) {
  const base = new URL('audio/', document.baseURI);
  const url = (name) => new URL(name + '.mp3', base).href;
  let ctx = null, on = false;
  let master, natureBus, musicBus, trackGain, el, riverLP, riverPan;
  const vol = { music: 0.7, nature: 0.8 };
  let order = [], ti = 0, nextTimer = 0;
  const beds = {};
  const shots = { thunder: null, songs: null };
  let since = TICK, bout = null, songWait = 4;
  const lv = { birds: 0, lightning: 0 };

  // ---------- loading: compressed bytes stay cached, decoded buffers come and go ----------
  const bytes = new Map();
  function decode(name) {
    if (!bytes.has(name)) bytes.set(name, fetch(url(name)).then((r) => { if (!r.ok) throw new Error(`${name}: ${r.status}`); return r.arrayBuffer(); }));
    return bytes.get(name).then((b) => ctx.decodeAudioData(b.slice(0)));
  }
  // a failed load is tried again half a minute later (a network hiccup should not silence it for good)
  function failed(item, names, e) {
    console.warn('sound:', e.message);
    item.state = 'failed';
    for (const n of names) bytes.delete(n);
    setTimeout(() => { if (item.state === 'failed') item.state = 'idle'; }, 30000);
  }
  // MP3 coding noise makes the two copies of the wrap-around differ slightly: blend the last few ms before the loop
  // end into the samples before the loop start, so the jump back is continuous
  function seam(buf) {
    const P = Math.round(PAD * buf.sampleRate), E = buf.length - P, K = Math.min(1024, P);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < K; i++) { const t = (i + 1) / K; d[E - K + i] = d[E - K + i] * (1 - t) + d[P - K + i] * t; }
    }
    return buf;
  }

  // a looping bed: source -> [chain] -> gain -> nature bus
  function bed(name, chain = []) {
    const gain = new GainNode(ctx, { gain: 0 });
    let head = gain;
    for (let i = chain.length - 1; i >= 0; i--) { chain[i].connect(head); head = chain[i]; }
    gain.connect(natureBus);
    const b = { name, gain, head, target: 0, buf: null, src: null, state: 'idle', idle: 0 };
    beds[name] = b;
    return b;
  }
  function setBed(b, target) {
    b.target = target;
    if (target > 0.002) {
      b.idle = 0;
      if (b.state === 'idle') {
        b.state = 'loading';
        decode(b.name).then((buf) => {
          if (b.state !== 'loading') return;
          b.buf = seam(buf); b.state = 'ready';
          const s = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true, loopStart: PAD, loopEnd: buf.duration - PAD });
          s.connect(b.head);
          s.start(0, PAD + Math.random() * (buf.duration - 2 * PAD));
          b.src = s;
          b.gain.gain.setValueAtTime(0, ctx.currentTime);
        }, (e) => failed(b, [b.name], e));
      }
    } else if (b.state === 'ready' && (b.idle += TICK) > 60) {
      b.src.stop(); b.src.disconnect(); b.src = null; b.buf = null; b.state = 'idle';
    }
    if (b.state === 'ready') b.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.6);
  }

  // a set of one-shots, loaded together while `wanted` and dropped after a minute without
  function shotSet(names) {
    return { names, bufs: null, state: 'idle', idle: 0 };
  }
  function keepShots(set, wanted) {
    if (wanted) {
      set.idle = 0;
      if (set.state === 'idle') {
        set.state = 'loading';
        Promise.all(set.names.map(decode)).then((bufs) => { if (set.state === 'loading') { set.bufs = bufs; set.state = 'ready'; } },
          (e) => failed(set, set.names, e));
      }
    } else if (set.state === 'ready' && (set.idle += TICK) > 60) { set.bufs = null; set.state = 'idle'; }
  }
  function play(buf, { gain, pan = 0, rate = 1, lowpass = 20000, delay = 0 }) {
    const s = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
    const f = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: lowpass, Q: 0.5 });
    s.connect(f).connect(new StereoPannerNode(ctx, { pan: clamp(pan, -1, 1) })).connect(new GainNode(ctx, { gain })).connect(natureBus);
    s.start(ctx.currentTime + delay);
  }

  // ---------- graph, built on the first turn-on ----------
  function build() {
    ctx = new AudioContext({ latencyHint: 'playback' });
    // a gentle limiter for thunder on top of heavy rain
    const limit = new DynamicsCompressorNode(ctx, { threshold: -10, knee: 8, ratio: 8, attack: 0.004, release: 0.3 });
    master = new GainNode(ctx, { gain: 0 });
    master.connect(limit).connect(ctx.destination);
    natureBus = new GainNode(ctx, { gain: vol.nature ** 2 });
    musicBus = new GainNode(ctx, { gain: vol.music ** 2 });
    natureBus.connect(master); musicBus.connect(master);

    // the river is heard from where it is: duller with distance, and panned towards it
    riverLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 18000, Q: 0.5 });
    riverPan = new StereoPannerNode(ctx);
    bed('river', [riverLP, riverPan]);
    for (const n of ['breeze', 'gale', 'drizzle', 'rain', 'birds', 'frogs']) bed(n);
    shots.thunder = shotSet([...Array(THUNDER_NEAR)].map((_, i) => `thunder-near-${i + 1}`).concat([...Array(THUNDER_FAR)].map((_, i) => `thunder-far-${i + 1}`)));
    shots.songs = shotSet([...Array(SONGS)].map((_, i) => `uguisu-${i + 1}`));

    el = new Audio();
    el.preload = 'auto';
    trackGain = new GainNode(ctx);
    ctx.createMediaElementSource(el).connect(trackGain).connect(musicBus);
    el.addEventListener('ended', () => { nextTimer = setTimeout(nextTrack, 2500); });
    order = TRACKS.map((_, i) => i).sort(() => Math.random() - 0.5);
  }
  function nextTrack() {
    nextTimer = 0;
    const [name, lufs] = TRACKS[order[ti++ % order.length]];
    trackGain.gain.value = 10 ** ((MUSIC_LUFS - lufs) / 20);
    el.src = url(name);
    if (on && !document.hidden && vol.music > 0) el.play().catch(() => {});
  }

  // run or pause everything for the on/off switch, the tab's visibility and the music volume
  function apply() {
    if (!ctx) return;
    const live = on && !document.hidden;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(live ? 1 : 0, t, live ? 0.5 : 0.08);
    if (live) {
      ctx.resume().catch(() => {});
      if (vol.music > 0) { if (!el.src) nextTrack(); else if (el.paused && !nextTimer) el.play().catch(() => {}); }
      else el.pause();
    } else {
      el.pause();
      // let the fade finish before the context stops
      setTimeout(() => { if (ctx && !(on && !document.hidden) && ctx.state === 'running') ctx.suspend(); }, 400);
    }
  }
  // browsers start audio only from a user gesture: until one comes, the next click or key starts it
  function unlock() {
    if (!on) return;
    if (!ctx) build();
    apply();
    ctx.resume().then(() => { if (ctx && ctx.state === 'running') removeUnlock(); }, () => {});
  }
  const GESTURES = ['pointerdown', 'keydown', 'touchend'];
  document.addEventListener('visibilitychange', apply);
  function removeUnlock() { for (const g of GESTURES) window.removeEventListener(g, unlock, true); }

  // ---------- the mix ----------
  const dayOf = (h) => smoothstep(4.6, 5.8, h) * (1 - smoothstep(18.3, 19.4, h));
  const nightOf = (h) => Math.max(smoothstep(18.9, 20.2, h), 1 - smoothstep(3.6, 4.9, h));
  function riverPlace(cam) {
    // nearest point of the river (its centre line, less the half-width) along the camera's stretch of it
    const p = cam.position;
    let best = Infinity, bx = 0, bz = 0;
    for (let z = p.z - 90; z <= p.z + 90; z += 3) {
      const x = world.riverX(z), d = Math.max(0, Math.hypot(x - p.x, z - p.z) - world.riverHW(z));
      if (d < best) { best = d; bx = x; bz = z; }
    }
    const e = cam.matrixWorld.elements, rl = Math.hypot(e[0], e[2]) || 1, dl = Math.hypot(bx - p.x, bz - p.z) || 1;
    const pan = ((bx - p.x) * e[0] + (bz - p.z) * e[2]) / (rl * dl);
    return { dist: Math.hypot(best, Math.max(0, p.y - 0.5)), pan };
  }

  function mix(st) {
    const wind = st.wind, rain = st.rain, h = st.hour;
    const gale = smoothstep(0.55, 1, wind);
    const r = riverPlace(st.camera);
    const near = 1 / (1 + (r.dist / 16) ** 1.6);
    setBed(beds.river, (0.45 + 0.6 * st.river) * lerp(0.06, 1, near));
    riverLP.frequency.setTargetAtTime(lerp(1400, 18000, near), ctx.currentTime, 0.3);
    riverPan.pan.setTargetAtTime(clamp(r.pan * 0.6 * (1 - near * 0.5), -0.7, 0.7), ctx.currentTime, 0.3);
    setBed(beds.breeze, (0.2 + 0.9 * smoothstep(0.05, 0.7, wind)) * (1 - 0.45 * gale));
    setBed(beds.gale, 1.3 * gale);
    setBed(beds.drizzle, 1.1 * smoothstep(0, 0.3, rain));
    setBed(beds.rain, 1.5 * smoothstep(0.3, 1, rain));
    // a dawn chorus; birds fall quiet in the rain and in a gale
    const dawn = 1 + 0.5 * smoothstep(5, 6, h) * (1 - smoothstep(7, 8.5, h));
    lv.birds = dayOf(h) * dawn * (1 - smoothstep(0.05, 0.4, rain)) * (1 - 0.7 * gale);
    setBed(beds.birds, 0.8 * lv.birds);
    setBed(beds.frogs, 0.9 * nightOf(h) * (1 - 0.5 * gale));
    keepShots(shots.songs, lv.birds > 0.2);
    lv.lightning = st.lightning;
    keepShots(shots.thunder, st.lightning > 0.02);
  }

  // bush warblers: bouts of 2-4 songs from one spot, then a pause
  function sing(dt) {
    if (shots.songs.state !== 'ready' || lv.birds < 0.2) { bout = null; return; }
    if ((songWait -= dt) > 0) return;
    if (!bout) bout = { n: 2 + Math.floor(Math.random() * 3), pan: (Math.random() * 2 - 1) * 0.75, gain: 0.35 + Math.random() * 0.5, lowpass: lerp(5000, 16000, Math.random()) };
    const k = Math.random() < 0.15 ? SONGS - 1 : Math.floor(Math.random() * (SONGS - 1)); // the long trill now and then
    play(shots.songs.bufs[k], { gain: bout.gain * Math.min(1, lv.birds), pan: bout.pan, rate: 0.97 + Math.random() * 0.06, lowpass: bout.lowpass });
    songWait = shots.songs.bufs[k].duration + (--bout.n > 0 ? 3 + Math.random() * 6 : 14 + Math.random() * 30);
    if (bout.n <= 0) bout = null;
  }

  return {
    get active() { return on && !!ctx && !document.hidden; },
    setEnabled(v) {
      on = !!v;
      if (on) {
        if (navigator.audioSession) navigator.audioSession.type = 'playback'; // iOS: play with the ringer switch off
        for (const g of GESTURES) window.addEventListener(g, unlock, true);
        // no context before the page has had a gesture: the browser would keep it suspended (and warn)
        if (ctx || !navigator.userActivation || navigator.userActivation.hasBeenActive) unlock();
      } else { removeUnlock(); apply(); }
    },
    setVolume(which, v) {
      vol[which] = clamp(+v, 0, 1);
      if (!ctx) return;
      (which === 'music' ? musicBus : natureBus).gain.setTargetAtTime(vol[which] ** 2, ctx.currentTime, 0.1);
      if (which === 'music') apply();
    },
    // per frame: st = { wind, river, rain, lightning (0..1 settings), hour, camera }
    update(dt, st) {
      if (!this.active) return;
      sing(dt);
      if ((since += dt) < TICK) return;
      since = 0;
      mix(st);
    },
    // a lightning strike at world x, z, `dist` metres away; a visible bolt or only a flash in the clouds
    thunder(x, z, dist, bolt, camera) {
      if (!this.active || shots.thunder.state !== 'ready') return;
      const near = bolt && dist < 650;
      const i = near ? Math.floor(Math.random() * THUNDER_NEAR) : THUNDER_NEAR + Math.floor(Math.random() * THUNDER_FAR);
      const p = camera.position, e = camera.matrixWorld.elements;
      const pan = ((x - p.x) * e[0] + (z - p.z) * e[2]) / ((Math.hypot(e[0], e[2]) || 1) * (Math.hypot(x - p.x, z - p.z) || 1));
      const k = clamp((dist - 380) / 520, 0, 1);
      play(shots.thunder.bufs[i], {
        gain: (near ? lerp(1.4, 0.9, k) : 0.8) * lerp(0.6, 1, lv.lightning),
        pan: pan * 0.7, rate: 0.94 + Math.random() * 0.1,
        lowpass: near ? lerp(12000, 5000, k) : 1800, delay: dist / SPEED_OF_SOUND,
      });
    },
    // debug: the context's state and each loop's load state and level
    info() { return { state: ctx ? ctx.state : 'none', on, beds: Object.fromEntries(Object.values(beds).map((b) => [b.name, `${b.state} ${b.target.toFixed(2)}`])), thunder: shots.thunder && shots.thunder.state, songs: shots.songs && shots.songs.state }; },
    dispose() { on = false; removeUnlock(); clearTimeout(nextTimer); document.removeEventListener('visibilitychange', apply); if (el) el.pause(); if (ctx) ctx.close(); ctx = null; },
  };
}
