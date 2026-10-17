// Sound: Japanese background music and the scene's ambience, mixed from the weather, the clock and the camera.
// Loops (river, wind, rain, birds by day, water lapping under the bridge; close by: the waterwheel, frogs in the
// paddies at night, wind in the bamboo groves, rain off the eaves of the houses and the temple and on the river; the
// skylark's song from where it hangs over the fields) play from decoded buffers, loaded when first heard and dropped
// after a minute unheard. One-shots: thunder follows each lightning strike after the sound's travel time; bush warblers
// sing in short bouts by day; the temple's bell tolls when a time-lapse passes dusk or dawn; the fisherman hums or
// whistles his tune to himself, heard only close to him; the walker's geta sound on the ground under them, the bridge's
// boards creaking under some steps; the animals' calls and the moored boat's knocks and creaks (call()) come from where
// each is, as it happens; an owl calls from the woods at night; a dog, an axe and a cock are heard from the villages by
// day. Distant sounds also go through a valley reverb (a generated impulse response: the slopes' reflections and a
// diffuse tail). Music streams through two media elements that hand over at a phrase's end, each track chosen for the
// scene's mood.
// Files: public/audio/, built by tools/audio.mjs. Nothing is fetched or created until sound is turned on.
import { clamp, lerp, smoothstep } from './noise.js';
import { assetUrl } from './assets.js';

// the music (tools/audio.mjs prints each track's loudness and seams): loudness (LUFS) and seams (s, where a phrase
// ends and a change of mood may hand over); it plays at MUSIC_LUFS at full volume, the loops are levelled to -24 LUFS.
// Measured (2-s RMS, bands, onsets): Sakuya3 has a bass line and a beat (below 250 Hz 3.6 dB under its whole, 73
// onsets a minute): the clear day's; Oboro has almost no bass (18 dB under) and few onsets (28 a minute), soft and
// floating: night and haze; Shizima4 is the quietest and steadiest (loudness range 3.6 LU against 6-12), sparse (31
// onsets a minute): rain, overcast and the small hours.
const TRACKS = [
  { name: 'music-sakuya3', lufs: -9.1, seams: [5.5, 21, 43.5, 75.25, 98, 104.25, 119.75, 129.75, 142.25, 174.75, 190.5, 199.5] },
  { name: 'music-oboro', lufs: -8.4, seams: [5.25, 11.5, 22.75, 35, 51.75, 61.5, 70, 76, 82, 93.25, 104.5, 116, 122, 130.75, 141.25, 152.5, 164, 176, 192.75, 202.75, 211.25, 217.25, 223.25, 234.5, 257.25, 263.5, 270.25, 284.5] },
  { name: 'music-shizima4', lufs: -9.7, seams: [5.75, 15.75, 22, 28.25, 38.25, 44.75, 51, 61.25, 68, 76.25, 87.5, 96, 102, 114.25, 120.25, 128, 134, 145.25, 156.25, 162.25, 172.5, 178.75, 185.25, 195.5, 202, 210.25, 230, 236.25, 247.5, 254.25, 260.25, 269] },
];
const SAKUYA = 0, OBORO = 1, SHIZIMA = 2;
const MUSIC_LUFS = -20;
// the hand-over to the next track (s), two tracks never heard at once: a change of mood fades the playing track out
// over the XF_MOOD s before a seam and starts the next at the seam; at a track's end the next starts TAIL s before it,
// where the last chord has died away (35 dB or more under the track's level), cued AHEAD s before; the music's first
// start fades in over FADE_IN
const XF_MOOD = 2, TAIL = 3.5, AHEAD = 15, FADE_IN = 3;
const PAD = 0.5; // each loop file carries PAD s of wrap-around on both ends (tools/audio.mjs)
const THUNDER_NEAR = 4, THUNDER_FAR = 3, SONGS = 4;
// footsteps: variants per surface, and each surface's gain: a walk comes to about -28 LUFS (-30 on grass), a little
// under a loop close by
const STEPS = { stone: 8, wood: 8, earth: 8, grass: 8 };
const STEP_GAIN = { stone: 0.9, wood: 0.95, earth: 0.65, grass: 0.45 };
const CREAKS = 5; // the bridge's boards
// the fisherman's tune (tools/audio.mjs: Auld Lang Syne, 蛍の光), hummed or whistled: each phrase's start and end
// (s) in its file
const TUNE = {
  hum: [[0.23, 5.68], [6.76, 11.0], [13.05, 18.4], [19.66, 24.35], [25.8, 31.37], [32.14, 36.73], [39.65, 46.98]],
  whistle: [[0.08, 9.52], [10.46, 20.43], [20.83, 29.42], [29.75, 39.75]],
};
const SPEED_OF_SOUND = 343;
// the animals' calls and the moored boat's sounds (tools/audio.mjs): variants, gain close by, the distance (m) at
// which one is heard at half that, and its send to the reverb from far off; the sika's alarm whistle, the heron's
// croak, the kingfisher's call, the wagtail's flight call, the spot-billed duck's quack, the mandarin drake's whistle,
// the white-eye's song, the plop of something going into the water, the water knocking on the boat's planks and its
// hull creaking at its rope
const CALLS = {
  sika: [2, 1.0, 35, 0.4], heron: [3, 1.1, 35, 0.35], kawasemi: [3, 0.6, 16, 0.25], sekirei: [3, 0.5, 12, 0.2], karugamo: [3, 0.7, 20, 0.3],
  oshidori: [3, 1.3, 16, 0.3], mejiro: [3, 0.45, 14, 0.2], plop: [1, 0.6, 9, 0.1], knock: [3, 1.0, 4, 0.05], hull: [4, 0.6, 4, 0.05],
};
// the village's sounds, heard from somewhere in a village MIN_FAR m off or more: variants, gain and half distance as
// CALLS
const VILLAGE = { dog: [3, 0.9, 60], chop: [4, 1.6, 70], rooster: [2, 0.8, 80] };
const MIN_FAR = 45;
const BELL_STROKES = { dusk: 5, dawn: 3 }; // strokes the bell is struck at dusk and at dawn
const LATE = 750; // ms: a one-shot this much past its time (the page hidden or stalled meanwhile) is dropped
const TICK = 0.1; // mix update interval, s

// world: river, temple, village and farmland (src/world.js); bridge: the bridge's centre (a Vector3)
export function createSound(world, bridge) {
  const url = (name) => assetUrl(`audio/${name}.mp3`);
  let ctx = null, on = false, dead = false;
  let master, natureBus, musicBus, duckGain, verb, riverLP, riverPan, lapLP, lapPan, wheelLP, wheelPan, frogPan, bambooPan, larkPan;
  let roofLP, roofPan, splashLP, splashPan;
  let voiceGain, voiceLP, voicePan;
  const vol = { music: 0.75, nature: 0.4 };
  const beds = {};
  const shots = { thunder: null, songs: null, bell: null, steps: null, creak: null, tune: null, calls: null, owl: null, village: null };
  let walked = -Infinity; // when the walk last stepped or moved (performance.now() ms): keeps the footsteps loaded
  let ground = 'earth'; // the surface under the walker at its last step or move
  let lights = -1; // the lanterns' level at the last mix
  let toll = null; // the bell's strokes waiting for its files: { n, wait (s left) }
  let struck = -Infinity; // when the bell was last struck (performance.now() ms)
  let forward = 0; // > 0 while a time-lapse runs forward (s)
  let since = TICK, bout = null, songWait = 4;
  let cam = null; // the camera at the last mix (for the one-shots placed when they play)
  let pauseTimer = 0, musicTimer = 0;
  const lv = { birds: 0, lightning: 0, duck: 1, fit: [0, 0, 0] };
  // the fisherman's voice: the phrases playing (source, envelope, kind, when they end), the wait before the next bout
  const voice = { src: null, env: null, kind: null, until: 0, wait: 4 + Math.random() * 8 };
  // one-shots waiting for their time (performance.now() ms): { due, fn, name }
  const later = [];
  // debug: the one-shots played lately and those dropped as late
  const fired = [], dropped = [];
  const log = (list, e) => { list.push(e); if (list.length > 60) list.shift(); };

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

  // move a loop's (or the voice's) gain, filter or pan towards v with time constant tc s; at once while `snap`
  // (sound turned back on: the first sound heard is the scene's mix now, not the one when it went off)
  let snap = false;
  function glide(param, v, tc = 0.3) {
    if (!snap) { param.setTargetAtTime(v, ctx.currentTime, tc); return; }
    param.cancelScheduledValues(0);
    param.setValueAtTime(v, ctx.currentTime);
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
    if (b.state === 'ready') glide(b.gain.gain, target, 0.6);
  }

  // a set of one-shots, loaded together while `wanted` and dropped after a minute without
  function shotSet(names) {
    return { names, bufs: null, state: 'idle', idle: 0, last: -1 };
  }
  const variants = (stem, n) => [...Array(n)].map((_, i) => `${stem}-${i + 1}`);
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
  // the footsteps' sets and the bridge's creaks: the surface under the walker fetched first, then the creaks, then the
  // other surfaces (the creaks behind all 32 step files would leave a walk's first steps on the bridge without them)
  function keepSteps(wanted) {
    const first = shots.steps[ground];
    keepShots(first, wanted);
    keepShots(shots.creak, wanted);
    for (const set of Object.values(shots.steps)) if (set !== first) keepShots(set, wanted);
  }
  // a variant of a loaded set at random, never the same twice running
  function anyOf(set) {
    const n = set.bufs.length;
    let k = Math.floor(Math.random() * (n > 1 && set.last >= 0 ? n - 1 : n));
    if (n > 1 && set.last >= 0 && k >= set.last) k++;
    set.last = k;
    return k;
  }
  // run fn (given the remaining fraction of a frame as a delay, s) at `delay` s from now: kept by the clock, not the
  // audio context's (it stops while the context is suspended), and dropped if the page was hidden or stalled past it
  function after(delay, name, fn) {
    later.push({ due: performance.now() + delay * 1000, name, fn });
  }
  function due() {
    const now = performance.now();
    for (let i = later.length - 1; i >= 0; i--) {
      const e = later[i];
      if (e.due - now > 40) continue;
      later.splice(i, 1);
      if (now - e.due > LATE) log(dropped, { name: e.name, late: Math.round(now - e.due) });
      else e.fn(Math.max(0, (e.due - now) / 1000));
    }
  }
  // a one-shot: source -> lowpass -> panner -> gain -> nature bus (and `wet` of it to the reverb), after `delay` s
  function play(buf, o) {
    if ((o.delay || 0) > 0.04) { after(o.delay, o.name, (d) => play(buf, { ...o, delay: d })); return; }
    const { gain, pan = 0, rate = 1, lowpass = 20000, delay = 0, wet = 0, name = '' } = o;
    const s = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
    const f = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: lowpass, Q: 0.5 });
    const g = new GainNode(ctx, { gain });
    s.connect(f).connect(new StereoPannerNode(ctx, { pan: clamp(pan, -1, 1) })).connect(g).connect(natureBus);
    if (wet > 0) g.connect(new GainNode(ctx, { gain: wet })).connect(verb);
    const at = ctx.currentTime + delay;
    s.start(at);
    if (o.duck) duckFor(at, o.duck);
    log(fired, { t: +at.toFixed(2), name, gain: +gain.toFixed(3), pan: +clamp(pan, -1, 1).toFixed(2), lowpass: Math.round(lowpass), wet: +wet.toFixed(2) });
  }

  // ---------- the valley's reverb: a generated impulse response ----------
  // An open valley, not a hall: a few early reflections off the slopes and the knoll (delay s, level, side), then a
  // diffuse tail of noise decaying over RT60 s, its top end dying faster (a one-pole lowpass falling from 6 to 0.9
  // kHz); 2.6 s long, unit energy per channel, so a send's level is the wet sound's level against the dry
  const REFLECTIONS = [[0.045, 0.5, -1], [0.07, 0.4, 1], [0.12, 0.3, 1], [0.19, 0.25, -1], [0.31, 0.18, -1], [0.43, 0.14, 1]];
  const RT60 = 2.2;
  function impulse() {
    const rate = ctx.sampleRate, len = Math.round(2.6 * rate);
    const ir = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: rate });
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c), side = c ? 1 : -1;
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate;
        const k = 1 - Math.exp(-2 * Math.PI * lerp(6000, 900, Math.min(1, t / 1.8)) / rate);
        lp += k * (Math.random() * 2 - 1 - lp);
        d[i] = lp * Math.exp((-6.9 * t) / RT60) * smoothstep(0.03, 0.12, t) * 0.5;
      }
      // each reflection a dull 8 ms burst, louder on its own side
      for (const [at, g, s] of REFLECTIONS) {
        const i0 = Math.round(at * rate), n = Math.round(0.008 * rate), gs = g * (s === side ? 1 : 0.45);
        let q = 0;
        for (let i = 0; i < n; i++) { q += 0.3 * (Math.random() * 2 - 1 - q); d[i0 + i] += gs * q * Math.sin((Math.PI * i) / n) * 3; }
      }
      let e = 0;
      for (let i = 0; i < len; i++) e += d[i] * d[i];
      const norm = 1 / Math.sqrt(e);
      for (let i = 0; i < len; i++) d[i] *= norm;
    }
    return ir;
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
    duckGain = new GainNode(ctx);
    duckGain.connect(musicBus);
    verb = new ConvolverNode(ctx, { buffer: impulse(), disableNormalization: true });
    verb.connect(natureBus);

    // the river is heard from where it is: duller with distance, and panned towards it
    riverLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 18000, Q: 0.5 });
    riverPan = new StereoPannerNode(ctx);
    bed('river', [riverLP, riverPan]);
    for (const n of ['breeze', 'gale', 'drizzle', 'rain', 'birds']) bed(n);
    lapLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 16000, Q: 0.5 });
    lapPan = new StereoPannerNode(ctx);
    bed('lapping', [lapLP, lapPan]);
    wheelLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 16000, Q: 0.5 });
    wheelPan = new StereoPannerNode(ctx);
    bed('waterwheel', [wheelLP, wheelPan]);
    frogPan = new StereoPannerNode(ctx);
    bed('frogs', [frogPan]);
    bambooPan = new StereoPannerNode(ctx);
    bed('bamboo', [bambooPan]);
    larkPan = new StereoPannerNode(ctx);
    bed('hibari', [larkPan]);
    roofLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 16000, Q: 0.5 });
    roofPan = new StereoPannerNode(ctx);
    bed('roof', [roofLP, roofPan]);
    splashLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 16000, Q: 0.5 });
    splashPan = new StereoPannerNode(ctx);
    bed('rainwater', [splashLP, splashPan]);
    voiceLP = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 16000, Q: 0.5 });
    voicePan = new StereoPannerNode(ctx);
    voiceGain = new GainNode(ctx, { gain: 0 });
    voiceLP.connect(voicePan).connect(voiceGain).connect(natureBus);
    voiceGain.connect(new GainNode(ctx, { gain: 0.15 })).connect(verb);
    shots.steps = Object.fromEntries(Object.entries(STEPS).map(([s, n]) => [s, shotSet(variants(`step-${s}`, n))]));
    shots.creak = shotSet(variants('creak', CREAKS));
    shots.thunder = shotSet(variants('thunder-near', THUNDER_NEAR).concat(variants('thunder-far', THUNDER_FAR)));
    shots.songs = shotSet(variants('uguisu', SONGS));
    shots.bell = shotSet(variants('bell', 3));
    shots.tune = shotSet(['fisher-hum', 'fisher-whistle']);
    shots.calls = Object.fromEntries(Object.entries(CALLS).map(([k, [n]]) => [k, shotSet(variants(k, n))]));
    shots.owl = shotSet(variants('owl', 3));
    shots.village = Object.fromEntries(Object.entries(VILLAGE).map(([k, [n]]) => [k, shotSet(variants(k, n))]));
  }

  // ---------- music: two decks handing over, the track chosen for the mood ----------
  const decks = [];
  let cur = null; // the deck playing the current track
  let run = { track: -1, n: 0 }; // the track played last and how many times running
  // how long the track has not fitted the mood (s); the change to come: the next track starts when the playing one is
  // at `at` (s), which starts fading out at `out`; `end` at the track's end
  let misfit = 0, swap = null;
  let musicWait = 0; // after a track failed to load, no music until then (performance.now() ms)
  function deck() {
    const el = new Audio();
    el.preload = 'auto';
    const gain = new GainNode(ctx, { gain: 0 });
    ctx.createMediaElementSource(el).connect(gain).connect(duckGain);
    const d = { el, gain, track: -1, state: 'idle', until: 0 };
    el.addEventListener('ended', () => { d.state = 'idle'; if (cur === d) cur = null; });
    // a track that fails to load is fetched again when next cued; the music, if it was the playing track, starts
    // again half a minute later (as a failed loop does)
    el.addEventListener('error', () => {
      if (!el.getAttribute('src')) return; // (the element emptied below)
      console.warn('sound:', d.track >= 0 ? TRACKS[d.track].name : 'music', el.error && el.error.message);
      if (cur === d) {
        if (run.track === d.track) run.n--; // (it did not play)
        cur = null; swap = null; musicWait = performance.now() + 30000;
      }
      d.track = -1; d.state = 'idle';
      el.removeAttribute('src'); el.load();
    });
    return d;
  }
  const level = (k) => 10 ** ((MUSIC_LUFS - TRACKS[k].lufs) / 20);
  // fade a deck's gain from where it is (or `from`) to `to` over `len` s, on an equal-power curve (any fade under way
  // cancelled first: a curve may not overlap another)
  function fade(d, to, len, from = d.gain.gain.value) {
    const g = d.gain.gain, t = ctx.currentTime, N = 48, c = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      c[i] = to > from ? from + (to - from) * Math.sin((u * Math.PI) / 2) : to + (from - to) * Math.cos((u * Math.PI) / 2);
    }
    g.cancelScheduledValues(0);
    g.setValueCurveAtTime(c, t, len);
  }
  // load track k into a free deck (ahead of its start)
  function cue(k) {
    if (!decks.length) decks.push(deck(), deck());
    let d = decks.find((x) => x !== cur && x.state === 'idle' && x.track === k) || decks.find((x) => x !== cur && x.state === 'idle');
    if (!d) { d = decks.find((x) => x !== cur); d.el.pause(); d.state = 'idle'; } // (a deck still fading out)
    if (d.track !== k) { d.track = k; d.el.src = url(TRACKS[k].name); } else if (d.el.currentTime > 0) d.el.currentTime = 0;
    return d;
  }
  function start(k, len) {
    const d = cue(k);
    d.state = 'on';
    fade(d, level(k), len, 0);
    if (live()) d.el.play().catch(() => {});
    cur = d;
    run = run.track === k ? { track: k, n: run.n + 1 } : { track: k, n: 1 };
  }
  function retire(d, len) {
    fade(d, 0, len);
    d.state = 'out'; d.until = ctx.currentTime + len;
  }
  // how well each track fits the scene now (0..1): Sakuya the clear day, Oboro the night and haze, Shizima the rain,
  // the overcast sky and the small hours
  function moods(st) {
    const h = st.hour, day = dayOf(h);
    const late = clamp(smoothstep(21.5, 23, h) + 1 - smoothstep(3, 4.5, h), 0, 1);
    const wet = smoothstep(0.05, 0.4, st.rain), grey = smoothstep(0.6, 0.85, st.clouds);
    const haze = smoothstep(0.55, 0.72, st.fog) * (1 - wet), dull = Math.max(wet, grey);
    return [day * (1 - haze) * (1 - dull), Math.max((1 - day) * (1 - 0.6 * late), haze) * (1 - 0.8 * dull), Math.max(wet, 0.9 * grey, late)];
  }
  // the next track: the moods' fit cubed, so the best fitting mostly, but the one just played only half as likely
  // and not three times running while another fits the mood as well (not `not`): one that did not would only play
  // until the mood's rule (music) took it off again at its first seam, a few seconds in
  function pick(fit, not = -1) {
    const top = Math.max(...fit), others = fit.some((f, i) => i !== run.track && i !== not && f >= top - 0.35);
    const w = fit.map((f, i) => (i === not ? 0 : (0.05 + f) ** 3 * (i === run.track ? (run.n >= 2 && others ? 0 : 0.5) : 1)));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) if ((r -= w[i]) <= 0 && w[i] > 0) return i;
    return w.findIndex((x) => x > 0);
  }
  function music(st) {
    for (const d of decks) if (d !== cur && d.state === 'out' && ctx.currentTime >= d.until) { d.el.pause(); d.state = 'idle'; }
    const fit = (lv.fit = moods(st));
    if (vol.music <= 0) return;
    if (!cur) { if (performance.now() >= musicWait) { start(pick(fit), FADE_IN); misfit = 0; swap = null; } return; }
    const el = cur.el, t = el.currentTime, dur = el.duration, best = fit.indexOf(Math.max(...fit));
    const fading = cur.state === 'out';
    // the next seam far enough ahead for the fade out, and early enough to change before the track's end
    const seam = () => TRACKS[cur.track].seams.find((s) => s > t + XF_MOOD + 0.3 && !(s > dur - AHEAD));
    const ahead = (k) => { if (decks.some((d) => d !== cur && d.state === 'idle')) cue(k); }; // (the free deck, if free)
    // a track that no longer fits the mood gives way at its next seam, once the mood has held for 3 s
    misfit = fit[cur.track] < fit[best] - 0.35 ? misfit + TICK : 0;
    if (!misfit && swap && !swap.end && !fading) swap = null;
    else if (misfit >= 3 && !swap) {
      const at = seam();
      if (at !== undefined) { swap = { at, out: at - XF_MOOD, track: pick(fit, cur.track) }; ahead(swap.track); }
    }
    if (!swap && dur > 0 && t >= dur - AHEAD) { swap = { at: dur - TAIL, out: dur - TAIL, track: pick(fit), end: true }; ahead(swap.track); }
    // (while the last track is still fading out, the change waits for the seam after)
    if (swap && !swap.end && !fading && t >= swap.out && decks.some((d) => d !== cur && d.state === 'out')) {
      const at = seam();
      swap = at === undefined ? null : { ...swap, at, out: at - XF_MOOD };
    }
    if (!swap) return;
    if (!fading && t >= swap.out) retire(cur, swap.end ? TAIL : Math.max(0.1, swap.at - t));
    // (or once faded out, should the track's clock lag the context's)
    if (t >= swap.at || (cur.state === 'out' && ctx.currentTime >= cur.until)) {
      const k = swap.track;
      swap = null; misfit = 0;
      start(k, 0.05); // (the track's own start)
    }
  }
  function playDecks() {
    if (vol.music <= 0) return;
    for (const d of decks) if (d.state !== 'idle' && d.el.paused) d.el.play().catch(() => {});
  }
  const pauseDecks = () => { for (const d of decks) d.el.pause(); };
  // ducking: the music dips under a near thunderclap (depth 0..1 of its level) for 2.5 s, back over the next 5
  const ducks = [];
  function duckFor(at, depth) {
    ducks.push({ at, depth });
    duckGain.gain.setTargetAtTime(1 - depth, at, 0.12);
  }
  function ducking() {
    const t = ctx.currentTime;
    let d = 0;
    for (let i = ducks.length - 1; i >= 0; i--) {
      const age = t - ducks[i].at;
      if (age > 8) { ducks.splice(i, 1); continue; }
      if (age >= 0) d = Math.max(d, ducks[i].depth * (age < 2.5 ? 1 : Math.max(0, 1 - (age - 2.5) / 5)));
    }
    if (Math.abs(1 - d - lv.duck) > 0.005) duckGain.gain.setTargetAtTime(1 - d, t, 1 - d < lv.duck ? 0.12 : 0.4);
    lv.duck = 1 - d;
  }

  // run or pause everything for the on/off switch and the tab's visibility: a fade out, then the music paused and the
  // context suspended; on return the context resumes and the music fades back in where it was
  const live = () => on && !document.hidden;
  let wasLive = false, scene = null; // (scene: the latest update's st, also while sound is off)
  function apply() {
    if (!ctx || dead) return;
    // back on: the loops set at once to the scene's mix now (it does not run while off), before the fade in
    if (live() && !wasLive && scene) { snap = true; mix(scene); snap = false; since = 0; }
    wasLive = live();
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(live() ? 1 : 0, t, live() ? 0.5 : 0.15);
    clearTimeout(pauseTimer);
    if (live()) {
      ctx.resume().catch(() => {});
      playDecks();
    } else {
      pauseTimer = setTimeout(() => {
        if (!ctx || live()) return;
        pauseDecks();
        if (ctx.state === 'running') ctx.suspend();
      }, 800);
    }
  }
  // Browsers may hold audio back until the page gets a click or key press (Chrome lets sites the user often plays
  // sound on start at once). Sound is tried at once, and every gesture tries again until one has run it.
  function unlock(e) {
    if (!on || dead) return;
    if (!ctx) build();
    apply();
    if (e) ctx.resume().then(() => { if (ctx && ctx.state === 'running') removeUnlock(); }, () => {});
  }
  const GESTURES = ['pointerdown', 'keydown', 'touchend', 'click'];
  document.addEventListener('visibilitychange', apply);
  function removeUnlock() { for (const g of GESTURES) window.removeEventListener(g, unlock, true); }

  // ---------- the mix ----------
  const dayOf = (h) => smoothstep(4.6, 5.8, h) * (1 - smoothstep(18.3, 19.4, h));
  // pan (-1 left .. 1 right) of world point x, z from the camera
  function panTo(cam, x, z) {
    const p = cam.position, e = cam.matrixWorld.elements;
    return ((x - p.x) * e[0] + (z - p.z) * e[2]) / ((Math.hypot(e[0], e[2]) || 1) * (Math.hypot(x - p.x, z - p.z) || 1));
  }
  // a sound's lowpass (Hz) at distance d (m): the air takes the top off a sound from far off
  const airLP = (d, near = 16000, far = 2200, from = 10, to = 160) => lerp(near, far, smoothstep(from, to, d));
  // the waterwheel's hub (src/village.js puts it 2.9 m out along the mill's axle, 1.6 m up)
  const mill = world.BUILDINGS.find((b) => b.kind === 'suisha');
  const wheel = mill && { x: mill.x + 2.9 * mill.c, y: mill.y + 1.55, z: mill.z - 2.9 * mill.s };
  // the nearest point of a box [x0, z0, x1, z1] shrunk by `inset` (the point itself inside it) and its distance
  function nearestIn(b, p, inset) {
    const x = clamp(p.x, b[0] + inset, b[2] - inset), z = clamp(p.z, b[1] + inset, b[3] - inset);
    return { x, z, d: Math.hypot(x - p.x, z - p.z) };
  }
  // the paddies: the farmland zones' boxes, less their fading edges
  const fields = world.ZONES.filter((Z) => !Z.village).map((Z) => Z.box);
  function fieldPlace(cam) {
    let best = { d: Infinity, x: 0, z: 0 };
    for (const b of fields) { const n = nearestIn(b, cam.position, 8); if (n.d < best.d) best = n; }
    return best;
  }
  // the bamboo (vegetation.js bambooData): groves behind the temple, about 6-34 m out from its terrace, and a stand
  // behind each farmhouse; the distance to the nearest, and a point in it to pan towards
  const T = world.temple, tc = Math.cos(T.yaw), ts = Math.sin(T.yaw);
  const houses = world.BUILDINGS.filter((b) => b.kind.startsWith('minka'));
  function bambooPlace(cam) {
    const p = cam.position, lz = (p.x - T.x) * ts + (p.z - T.z) * tc, td = world.templeDist(p.x, p.z);
    let best = { d: Math.hypot(Math.max(0, 6 - td, td - 34), Math.max(0, lz + 6)), x: T.x - 22 * ts, z: T.z - 22 * tc };
    for (const b of houses) {
      if (Math.abs(p.x - b.x) > 80 || Math.abs(p.z - b.z) > 80) continue;
      // in the house's frame (world.padDist's): the stand spans the house's width and 3.2-12 m behind it
      const hx = p.x - b.x, hz = p.z - b.z, lx = hx * b.c - hz * b.s, hlz = hx * b.s + hz * b.c;
      const d = Math.hypot(Math.max(0, Math.abs(lx) - b.hw - 4), Math.max(0, hlz + b.hd + 3.2, -b.hd - 12 - hlz));
      const gz = -b.hd - 7.6;
      if (d < best.d) best = { d, x: b.x + gz * b.s, z: b.z + gz * b.c };
    }
    return best;
  }
  // the roofs rain drums on and pours off: the village's buildings (their footprint, plus a metre of eaves; the
  // eaves about 4 m up) and the temple's halls on their terrace; the distance to the nearest eaves, a point there
  const roofs = world.BUILDINGS.filter((b) => b.kind !== 'suisha');
  function roofPlace(cam) {
    const p = cam.position;
    let best = { d: Math.hypot(Math.max(0, world.templeDist(p.x, p.z)), Math.max(0, p.y - T.y - 7)), x: T.x, z: T.z };
    for (const b of roofs) {
      if (Math.abs(p.x - b.x) > 60 || Math.abs(p.z - b.z) > 60) continue;
      const hx = p.x - b.x, hz = p.z - b.z, lx = hx * b.c - hz * b.s, lz = hx * b.s + hz * b.c;
      const ex = clamp(lx, -b.hw - 1, b.hw + 1), ez = clamp(lz, -b.hd - 1, b.hd + 1);
      const d = Math.hypot(lx - ex, lz - ez, Math.max(0, p.y - b.y - 4));
      if (d < best.d) best = { d, x: b.x + ex * b.c + ez * b.s, z: b.z - ex * b.s + ez * b.c };
    }
    return best;
  }
  function riverPlace(cam) {
    // nearest point of the river (its centre line, less the half-width) along the camera's stretch of it
    const p = cam.position;
    let best = Infinity, bx = 0, bz = 0;
    for (let z = p.z - 90; z <= p.z + 90; z += 3) {
      const x = world.riverX(z), d = Math.max(0, Math.hypot(x - p.x, z - p.z) - world.riverHW(z));
      if (d < best) { best = d; bx = x; bz = z; }
    }
    return { dist: Math.hypot(best, Math.max(0, p.y - 0.5)), pan: panTo(cam, bx, bz) };
  }
  // a point in the woods (vegetation.js forestData: the groves on the slopes) `near`-`far` m from the camera
  function woodsPoint(p, near, far) {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, r = lerp(near, far, Math.random()), x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (Math.abs(x) > 560 || z < -700 || z > 140 || world.grove(x, z) < 0.5) continue;
      const y = world.height(x, z);
      if (y >= 4 && y <= 170) return { x, y: y + 10, z };
    }
    return null;
  }
  // a point in one of the villages at least MIN_FAR m from the camera and within `far`, nearer villages likelier
  const villages = world.ZONES.filter((Z) => Z.village).map((Z) => Z.box);
  function villagePoint(p, far) {
    for (let i = 0; i < 20; i++) {
      const b = villages[Math.floor(Math.random() * villages.length)];
      const x = lerp(b[0] + 6, b[2] - 6, Math.random()), z = lerp(b[1] + 6, b[3] - 6, Math.random()), d = Math.hypot(x - p.x, z - p.z);
      if (d >= MIN_FAR && d <= far && Math.random() < 80 / (d + 40)) return { x, y: world.height(x, z) + 1.5, z };
    }
    return null;
  }
  // a one-shot from world point q: quieter and duller with distance, panned towards it, after the sound's travel time,
  // `wet` of it to the reverb from far off
  function from(q, buf, name, gain, half, wet, o = {}) {
    const p = cam.position, d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z), g = gain / (1 + (d / half) ** 2);
    if (g < 0.01) return;
    play(buf, { name, gain: g, pan: panTo(cam, q.x, q.z) * 0.8, lowpass: airLP(d), delay: d / SPEED_OF_SOUND, wet: wet * lerp(0.4, 1, smoothstep(10, 150, d)), ...o });
  }

  function mix(st) {
    cam = st.camera;
    for (const s of Object.values(shots.calls)) keepShots(s, true); // (all small: kept while sound is on)
    const wind = st.wind, rain = st.rain, h = st.hour;
    const gale = smoothstep(0.55, 1, wind);
    const r = riverPlace(st.camera);
    const near = 1 / (1 + (r.dist / 16) ** 1.6);
    setBed(beds.river, (0.45 + 0.6 * st.river) * lerp(0.06, 1, near));
    glide(riverLP.frequency, lerp(1400, 18000, near));
    glide(riverPan.pan, clamp(r.pan * 0.6 * (1 - near * 0.5), -0.7, 0.7));
    setBed(beds.breeze, (0.2 + 0.9 * smoothstep(0.05, 0.7, wind)) * (1 - 0.45 * gale));
    setBed(beds.gale, 1.3 * gale);
    setBed(beds.drizzle, 1.1 * smoothstep(0, 0.3, rain));
    setBed(beds.rain, 1.5 * smoothstep(0.3, 1, rain));
    // rain on the river's surface, close to it (on the bridge too); rain off the eaves of the houses and the temple,
    // within a few metres of them; both heavier with the rain
    const wet = smoothstep(0.02, 0.2, rain) * lerp(0.45, 1, smoothstep(0.3, 1, rain));
    const sn = Math.max(0, 1 / (1 + (r.dist / 7) ** 2) - 0.02) / 0.98;
    setBed(beds.rainwater, 1.3 * wet * sn);
    glide(splashLP.frequency, lerp(3000, 16000, Math.min(1, sn * 1.6)));
    glide(splashPan.pan, clamp(r.pan * 0.6 * (1 - sn * 0.6), -0.6, 0.6));
    const rp = roofPlace(st.camera), rn = Math.max(0, 1 / (1 + (rp.d / 5) ** 2) - 0.02) / 0.98;
    setBed(beds.roof, 1.4 * wet * rn);
    glide(roofLP.frequency, lerp(3000, 16000, Math.min(1, rn * 1.6)));
    glide(roofPan.pan, clamp(panTo(st.camera, rp.x, rp.z) * 0.7 * (1 - rn * 0.5), -0.7, 0.7));
    // a dawn chorus; birds fall quiet in the rain and in a gale
    const dawn = 1 + 0.5 * smoothstep(5, 6, h) * (1 - smoothstep(7, 8.5, h));
    lv.birds = dayOf(h) * dawn * (1 - smoothstep(0.05, 0.4, rain)) * (1 - 0.7 * gale);
    setBed(beds.birds, 0.8 * lv.birds);
    // water lapping around the bridge's posts, heard only close to it
    const bd = st.camera.position.distanceTo(bridge), bn = Math.max(0, 1 / (1 + (bd / 9) ** 2) - 0.02);
    setBed(beds.lapping, 1.5 * bn * (0.7 + 0.5 * st.river));
    glide(lapLP.frequency, lerp(2500, 16000, Math.min(1, bn * 1.6)));
    glide(lapPan.pan, clamp(panTo(st.camera, bridge.x, bridge.z) * 0.7 * (1 - bn * 0.5), -0.7, 0.7));
    // the waterwheel's paddles and churn, heard within about 25 m; it turns faster with the river
    if (wheel) {
      const p = st.camera.position, wd = Math.hypot(p.x - wheel.x, p.y - wheel.y, p.z - wheel.z);
      const wn = Math.max(0, 1 / (1 + (wd / 7) ** 2) - 0.073) / 0.927;
      setBed(beds.waterwheel, 1.4 * wn * (0.6 + 0.6 * st.river));
      glide(wheelLP.frequency, lerp(2500, 16000, Math.min(1, wn * 1.6)));
      glide(wheelPan.pan, clamp(panTo(st.camera, wheel.x, wheel.z) * 0.7 * (1 - wn * 0.5), -0.7, 0.7));
    }
    // frogs in the flooded paddies from dusk (18:00) to dawn (05:00), loud among the fields and carrying a long way;
    // quiet in the rain and in a gale
    const fp = fieldPlace(st.camera), fn = 1 / (1 + (fp.d / 30) ** 2);
    const night = smoothstep(17.6, 18.6, h) + 1 - smoothstep(4.5, 5.4, h);
    setBed(beds.frogs, 0.8 * fn * night * (1 - smoothstep(0.1, 0.5, rain)) * (1 - 0.6 * gale));
    glide(frogPan.pan, clamp(panTo(st.camera, fp.x, fp.z) * 0.5 * (1 - fn), -0.5, 0.5));
    // wind in the bamboo, close to the groves; louder with the wind, a little rustle even in calm air
    const bp = bambooPlace(st.camera), bnear = Math.max(0, 1 / (1 + (bp.d / 12) ** 2) - 0.03) / 0.97;
    setBed(beds.bamboo, 1.4 * bnear * (0.3 + 0.9 * smoothstep(0.05, 0.8, wind)) * (1 - 0.5 * gale));
    glide(bambooPan.pan, clamp(panTo(st.camera, bp.x, bp.z) * 0.6 * (1 - bnear * 0.6), -0.6, 0.6));
    // the skylark singing high over the fields (birds.js lark()), carrying a long way; by day only, quiet in the rain
    // and silent in a gale (a lark already up when night or the weather comes keeps singing on its way down for about
    // a minute)
    const lk = st.lark, ld = lk ? st.camera.position.distanceTo(lk) : Infinity;
    setBed(beds.hibari, (0.9 / (1 + (ld / 50) ** 2)) * dayOf(h) * (1 - smoothstep(0.05, 0.4, rain)) * (1 - gale));
    if (lk) glide(larkPan.pan, clamp(panTo(st.camera, lk.x, lk.z) * 0.6, -0.6, 0.6));
    // the footsteps (and the bridge's creaks) stay loaded while the walk goes on (and drop a minute after it stops)
    keepSteps(performance.now() - walked < 5000);
    bell(st);
    keepShots(shots.songs, lv.birds > 0.2);
    hum(st);
    owl(st, gale);
    village(st, gale);
    lv.lightning = st.lightning;
    keepShots(shots.thunder, st.lightning > 0.02);
    music(st);
    ducking();
  }

  // The temple's bell, struck when a time-lapse forward through the clock passes dusk (the lanterns coming on) or
  // dawn (their going off), not when the clock is set straight there: BELL_STROKES strokes, each struck about 20 s
  // after the last as the recording's are, the earlier ones from its fifth and sixth strokes and the last, ringing
  // out fully, from its seventh; heard from the temple after the sound's travel time
  function bell(st) {
    const queued = later.some((e) => e.name.startsWith('bell'));
    keepShots(shots.bell, st.lapse !== 0 || !!toll || queued);
    forward = st.lapse > 0 ? 2 * TICK : forward - TICK; // (the lapse's last frame can fall between two mixes)
    if (lights >= 0 && forward > 0 && (lights < 0.5) !== (st.lights < 0.5)) toll = { n: st.lights >= 0.5 ? BELL_STROKES.dusk : BELL_STROKES.dawn, wait: 10 };
    lights = st.lights;
    if (!toll) return;
    if (shots.bell.state !== 'ready') { if ((toll.wait -= TICK) <= 0) toll = null; return; }
    // (a bell still tolling stops for the new toll, which keeps its rhythm: a lapse through both dusk and dawn tolls
    // on from the last stroke struck, never two strokes on top of each other)
    for (let i = later.length - 1; i >= 0; i--) if (later[i].name.startsWith('bell')) later.splice(i, 1);
    let at = Math.max(0.5 + Math.random(), (struck - performance.now()) / 1000 + 19.6 + Math.random() * 1.1);
    for (let i = 0; i < toll.n; i++) {
      const last = i === toll.n - 1, k = last ? 2 : Math.floor(Math.random() * 2), g = 0.9 * (0.9 + Math.random() * 0.2);
      after(at, `bell-${k + 1}`, () => {
        if (shots.bell.state !== 'ready') return;
        struck = performance.now();
        from({ x: T.x, y: T.y + 6, z: T.z }, shots.bell.bufs[k], `bell-${k + 1}`, g, 400, 0.5, { lowpass: lerp(4000, 2200, clamp(Math.hypot(T.x - cam.position.x, T.z - cam.position.z) / 400, 0, 1)) });
      });
      at += 19.6 + Math.random() * 1.1;
    }
    toll = null;
  }

  // the fisherman (st.fisher: { pos, busy } while he sits by the river, else null): bouts of 2-4 phrases of his tune,
  // hummed or whistled (never whistled after dark, as in Japan), from the start of a verse or in the middle of it, then
  // a pause of 15-50 s; heard within about 15 m, quiet while he lifts his line and when he goes home
  function hum(st) {
    const f = st.fisher, t = ctx.currentTime;
    const d = f ? st.camera.position.distanceTo(f.pos) : Infinity;
    keepShots(shots.tune, d < 60);
    const n = Math.max(0, 1 / (1 + (d / 4) ** 2) - 0.02) / 0.98;
    glide(voiceGain.gain, 1.3 * n);
    if (f) {
      glide(voiceLP.frequency, lerp(2500, 16000, Math.min(1, n * 1.6)));
      glide(voicePan.pan, clamp(panTo(st.camera, f.pos.x, f.pos.z) * 0.8 * (1 - n * 0.4), -0.8, 0.8));
    }
    if (voice.src && t >= voice.until) voice.src = null;
    if (voice.src && (!f || f.busy)) {
      voice.env.gain.setTargetAtTime(0, t, 0.15);
      voice.src.stop(t + 0.8);
      voice.src = null;
    }
    if (voice.src || !f || f.busy || d > 30 || shots.tune.state !== 'ready' || (voice.wait -= TICK) > 0) return;
    const kind = dayOf(st.hour) > 0.5 && Math.random() < 0.4 ? 'whistle' : 'hum';
    const P = TUNE[kind], k = Math.random() < 0.4 ? 0 : Math.floor(Math.random() * (P.length - 1));
    const m = Math.min(P.length - k, 2 + Math.floor(Math.random() * 3));
    const at = P[k][0] - 0.05, dur = P[k + m - 1][1] + 0.15 - at, rate = 0.97 + Math.random() * 0.05;
    const s = new AudioBufferSourceNode(ctx, { buffer: shots.tune.bufs[kind === 'hum' ? 0 : 1], playbackRate: rate });
    const env = new GainNode(ctx, { gain: 0.8 + Math.random() * 0.3 });
    s.connect(env).connect(voiceLP);
    s.start(t, at, dur);
    Object.assign(voice, { src: s, env, kind, until: t + dur / rate, wait: 15 + Math.random() * 35 });
    log(fired, { t: +t.toFixed(2), name: `fisher-${kind}`, gain: +(1.3 * n).toFixed(3) });
  }

  // the Ural owl at night (19:30-04:30), silent in rain heavier than drizzle and in a gale: bouts of 2-5 songs 25-45 s
  // apart from one spot in the woods 70-260 m off, then 1.5-4 minutes' quiet
  const hoot = { wait: 20 + Math.random() * 40, left: 0, at: null };
  function owl(st, gale) {
    const h = st.hour, night = (h >= 19.5 || h < 4.5) && st.rain < 0.35 && gale < 0.5;
    keepShots(shots.owl, night);
    if (!night || shots.owl.state !== 'ready') { hoot.left = 0; return; }
    if ((hoot.wait -= TICK) > 0) return;
    if (!hoot.left) { hoot.at = woodsPoint(st.camera.position, 70, 260); hoot.left = 2 + Math.floor(Math.random() * 4); }
    if (hoot.at) { const k = anyOf(shots.owl); from(hoot.at, shots.owl.bufs[k], `owl-${k + 1}`, 1.0, 90, 0.45, { rate: 0.99 + Math.random() * 0.02 }); }
    hoot.wait = --hoot.left > 0 ? 25 + Math.random() * 20 : 90 + Math.random() * 150;
  }

  // the villages by day, heard from MIN_FAR-320 m: now and then (every 35-105 s) a dog barking once or a few times,
  // someone splitting logs (3-7 strokes), or before mid-morning a cock crowing; silent in rain heavier than drizzle
  // (the owl's threshold: the drizzle's rain is 0.3) and in a gale
  const vil = { wait: 15 + Math.random() * 30 };
  function village(st, gale) {
    const h = st.hour, p = st.camera.position;
    const near = villages.some((b) => nearestIn(b, p, 0).d < 320);
    const open = near && h > 5 && h < 19 && st.rain < 0.35 && gale < 0.5;
    for (const set of Object.values(shots.village)) keepShots(set, open);
    // (a dog's or an axe's bout stops with the day, or when the camera leaves)
    if (!open) for (let i = later.length - 1; i >= 0; i--) if (later[i].name in VILLAGE) later.splice(i, 1);
    if (!open || (vil.wait -= TICK) > 0) return;
    vil.wait = 35 + Math.random() * 70;
    const w = { dog: 0.45, chop: h > 7.5 && h < 17 ? 0.4 : 0, rooster: h < 8.5 ? 0.6 : 0 };
    let r = Math.random() * (w.dog + w.chop + w.rooster), kind = 'dog';
    for (const k in w) if ((r -= w[k]) <= 0) { kind = k; break; }
    const set = shots.village[kind], q = villagePoint(p, 320);
    if (set.state !== 'ready' || !q) return;
    const [, gain, half] = VILLAGE[kind];
    const n = kind === 'dog' ? 1 + Math.floor(Math.random() * 3) : kind === 'chop' ? 3 + Math.floor(Math.random() * 5) : 1 + (Math.random() < 0.4 ? 1 : 0);
    let at = 0;
    for (let i = 0; i < n; i++) {
      after(at, `${kind}`, () => { if (set.state !== 'ready') return; const k = anyOf(set); from(q, set.bufs[k], `${kind}-${k + 1}`, gain * (0.85 + Math.random() * 0.3), half, 0.45, { rate: 0.97 + Math.random() * 0.06 }); });
      at += kind === 'dog' ? 0.7 + Math.random() * 1.3 : kind === 'chop' ? 1.7 + Math.random() * 1.0 + (Math.random() < 0.2 ? 3 : 0) : 6 + Math.random() * 6;
    }
  }

  // bush warblers: bouts of 2-4 songs from one spot, then a pause
  function sing(dt) {
    if (shots.songs.state !== 'ready' || lv.birds < 0.2) { bout = null; return; }
    if ((songWait -= dt) > 0) return;
    if (!bout) bout = { n: 2 + Math.floor(Math.random() * 3), pan: (Math.random() * 2 - 1) * 0.75, gain: 0.35 + Math.random() * 0.5, lowpass: lerp(5000, 16000, Math.random()) };
    const k = Math.random() < 0.15 ? SONGS - 1 : Math.floor(Math.random() * (SONGS - 1)); // the long trill now and then
    play(shots.songs.bufs[k], { name: `uguisu-${k + 1}`, gain: bout.gain * Math.min(1, lv.birds), pan: bout.pan, rate: 0.97 + Math.random() * 0.06, lowpass: bout.lowpass, wet: 0.12 });
    songWait = shots.songs.bufs[k].duration + (--bout.n > 0 ? 3 + Math.random() * 6 : 14 + Math.random() * 30);
    if (bout.n <= 0) bout = null;
  }

  return {
    get active() { return on && !!ctx && !document.hidden; },
    setEnabled(v) {
      if (dead) return;
      on = !!v;
      if (on) {
        if (navigator.audioSession) navigator.audioSession.type = 'playback'; // iOS: play with the ringer switch off
        lights = -1; // no bell for a dusk that passed while sound was off
        for (const g of GESTURES) window.addEventListener(g, unlock, true);
        unlock();
      } else { removeUnlock(); apply(); }
    },
    // the music's volume fades; at 0 the music pauses once faded, and plays on from there when turned up
    setVolume(which, v) {
      vol[which] = clamp(+v, 0, 1);
      if (!ctx) return;
      (which === 'music' ? musicBus : natureBus).gain.setTargetAtTime(vol[which] ** 2, ctx.currentTime, 0.1);
      if (which !== 'music') return;
      clearTimeout(musicTimer);
      if (vol.music > 0) { if (live()) playDecks(); } else musicTimer = setTimeout(() => { if (vol.music <= 0) pauseDecks(); }, 600);
    },
    // per frame: st = { wind, river, rain, lightning, clouds, fog (0..1 settings), hour, lapse (a time-lapse running:
    // 1 forward, -1 back, else 0), lights (the lanterns, 0..1), camera, fisher ({ pos, busy } or null: figures.js
    // voice), lark (the skylark singing, a Vector3, or null) }
    update(dt, st) {
      scene = st;
      if (!this.active) return;
      due();
      sing(dt);
      if ((since += dt) < TICK) return;
      since = 0;
      mix(st);
    },
    // One footstep of the walker's geta: `surface` 'earth' (lanes, paths), 'wood' (the bridge), 'stone' (the temple's
    // steps and paving) or 'grass'; `hurry` a little louder; `foot` 'left' | 'right' (or -1 | 1) pans it a touch.
    // A variant at random, never the same twice running. On the bridge a third of the steps (half when hurrying) make
    // a board creak under them. Silent until sound runs and the set has loaded (a step starts loading all four sets,
    // so only the walk's very first steps can go unheard).
    footstep({ surface = 'earth', hurry = false, foot = 0 } = {}) {
      walked = performance.now();
      if (surface in STEPS) ground = surface;
      if (!this.active) return;
      const set = shots.steps[surface] || shots.steps.earth;
      keepSteps(true);
      if (set.state !== 'ready') return;
      const k = anyOf(set);
      const side = foot === 'left' ? -1 : foot === 'right' ? 1 : Math.sign(+foot || 0);
      play(set.bufs[k], { name: `step-${surface}-${k + 1}`, gain: (STEP_GAIN[surface] ?? STEP_GAIN.earth) * (hurry ? 1.3 : 1) * (0.9 + Math.random() * 0.15), pan: side * 0.12, rate: 0.94 + Math.random() * 0.14 });
      if (surface === 'wood' && shots.creak.state === 'ready' && Math.random() < (hurry ? 0.5 : 0.33)) {
        const c = anyOf(shots.creak);
        play(shots.creak.bufs[c], { name: `creak-${c + 1}`, gain: (hurry ? 0.5 : 0.38) * (0.8 + Math.random() * 0.4), pan: side * 0.2, rate: 0.92 + Math.random() * 0.16, delay: 0.05 + Math.random() * 0.12, wet: 0.04 });
      }
    },
    // walking(speed, surface): the walk's pace (m/s, 0 standing), every frame or on change. It plays nothing (no
    // recording of cloth in motion was clean enough for a kimono's rustle); while the walker moves it keeps the
    // footsteps loaded, the surface's own set fetched first.
    walking(speed, surface) {
      if (speed > 0) walked = performance.now();
      if (surface in STEPS) ground = surface;
    },
    // An animal's call or the moored boat's sound (CALLS: 'sika', 'heron', 'kawasemi', 'sekirei', 'karugamo', 'oshidori',
    // 'mejiro', 'plop', 'knock', 'hull') from world x, y, z: quieter and duller with distance, panned towards it, after
    // the sound's travel time; a variant at random, never the same twice running. Nothing until its set has loaded.
    call(kind, x, y, z, camera) {
      const set = this.active && shots.calls && shots.calls[kind];
      if (!set || set.state !== 'ready') return;
      const [, gain, half, wet] = CALLS[kind];
      cam = camera;
      const k = anyOf(set);
      from({ x, y, z }, set.bufs[k], `${kind}-${k + 1}`, gain, half, wet, { rate: 0.96 + Math.random() * 0.08, lowpass: airLP(Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z), 16000, 2500, 10, 140) });
    },
    // a lightning strike at world x, z, `dist` metres away; a visible bolt or only a flash in the clouds; a near
    // clap ducks the music
    thunder(x, z, dist, bolt, camera) {
      if (!this.active || shots.thunder.state !== 'ready') return;
      const near = bolt && dist < 650;
      const i = near ? Math.floor(Math.random() * THUNDER_NEAR) : THUNDER_NEAR + Math.floor(Math.random() * THUNDER_FAR);
      const pan = panTo(camera, x, z);
      const k = clamp((dist - 380) / 520, 0, 1);
      play(shots.thunder.bufs[i], {
        name: shots.thunder.names[i], gain: (near ? lerp(1.4, 0.9, k) : 0.8) * lerp(0.6, 1, lv.lightning),
        pan: pan * 0.7, rate: 0.94 + Math.random() * 0.1,
        lowpass: near ? lerp(12000, 5000, k) : 1800, delay: dist / SPEED_OF_SOUND, wet: near ? 0.3 : 0.4, duck: near ? lerp(0.5, 0.3, k) : 0,
      });
    },
    // sound is on but the browser holds it back until the page gets a click or key press
    get waiting() { return on && !document.hidden && (!ctx || ctx.state !== 'running' || (vol.music > 0 && !!cur && cur.el.paused)); },
    // debug: the context's state and master gain; each loop's load state, target and gain now; the music (each deck's track, state,
    // time and gain, the moods' fit per track, a change waiting for its seam, the duck); the one-shots played lately
    // ({ t (context s), name, gain, pan, lowpass, wet }) and those dropped as late; the one-shot sets' load states
    info() {
      const sets = (o) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.state]));
      return {
        state: ctx ? ctx.state : 'none', on, waiting: this.waiting, time: ctx ? +ctx.currentTime.toFixed(2) : 0, master: ctx ? +master.gain.value.toFixed(3) : 0,
        beds: Object.fromEntries(Object.values(beds).map((b) => [b.name, { state: b.state, target: +b.target.toFixed(3), gain: +b.gain.gain.value.toFixed(3) }])),
        music: {
          current: cur ? TRACKS[cur.track].name : null, run, swap: swap && { at: swap.at, out: swap.out, track: TRACKS[swap.track].name }, misfit: +misfit.toFixed(1),
          fit: Object.fromEntries(TRACKS.map((tr, i) => [tr.name, +lv.fit[i].toFixed(2)])), duck: +lv.duck.toFixed(3),
          decks: decks.map((d) => ({ track: d.track >= 0 ? TRACKS[d.track].name : null, state: d.state, paused: d.el.paused, t: +d.el.currentTime.toFixed(2), dur: +(d.el.duration || 0).toFixed(1), gain: +d.gain.gain.value.toFixed(3) })),
        },
        fired: fired.slice(), dropped: dropped.slice(), waitingShots: later.map((e) => ({ name: e.name, in: Math.round(e.due - performance.now()) })),
        shots: { thunder: shots.thunder && shots.thunder.state, songs: shots.songs && shots.songs.state, bell: shots.bell && shots.bell.state, tune: shots.tune && shots.tune.state, owl: shots.owl && shots.owl.state, creak: shots.creak && shots.creak.state, calls: sets(shots.calls), village: sets(shots.village), steps: sets(shots.steps) },
        voice: voice.src ? voice.kind : null, lights,
      };
    },
    // debug: { seek: s } moves the playing track there; { clear: true } empties the played and dropped lists;
    // { thunder: [dist, bolt] } a strike dist m ahead of the camera; { soon: true } the owl and the village next mix
    debug(o = {}) {
      if (o.seek !== undefined && cur) cur.el.currentTime = o.seek;
      if (o.clear) { fired.length = 0; dropped.length = 0; }
      if (o.thunder && cam) {
        const [dist, bolt] = o.thunder, e = cam.matrixWorld.elements, l = Math.hypot(e[8], e[10]) || 1;
        this.thunder(cam.position.x - (e[8] / l) * dist, cam.position.z - (e[10] / l) * dist, dist, bolt, cam);
      }
      if (o.soon) { hoot.wait = 0; vil.wait = 0; }
    },
    // stops the sound for good (the scene's end, or its graphics device lost): a quick fade, then the context closed
    dispose() {
      dead = true; on = false;
      removeUnlock(); clearTimeout(pauseTimer); clearTimeout(musicTimer);
      document.removeEventListener('visibilitychange', apply);
      later.length = 0;
      if (!ctx) return;
      const c = ctx;
      master.gain.cancelScheduledValues(c.currentTime);
      master.gain.setTargetAtTime(0, c.currentTime, 0.05);
      ctx = null;
      setTimeout(() => { pauseDecks(); c.close(); }, 300);
    },
  };
}
