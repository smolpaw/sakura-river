// Builds public/audio/ from the source recordings credited in README.md (Sound).
//   node tools/audio.mjs [name ...]
// Needs ffmpeg with libmp3lame. Sources are downloaded once into tools/.audio-cache/. Given names, it builds only the
// outputs whose names start with one of them (`node tools/audio.mjs step- frogs`) and leaves the other files as they are.
// - Beds (river, wind, rain, birds, lapping, waterwheel, frogs, bamboo) become seamless loops: the segment's tail is
//   crossfaded into its head, and the file carries PAD seconds of the loop's own end before it and of its start after
//   it, so the page can loop [PAD, PAD + length] and stay seamless whatever the MP3 decoder does with encoder delay and
//   padding.
//   They are levelled to BED_LUFS, with the peak held under -1 dBFS.
// - One-shots (thunder, bush-warbler songs, the temple bell) are trimmed, faded and peak-normalised (the bell
//   levelled); mono, panned by the page.
// - Footsteps (geta on four surfaces) are cut at each step's onset, layered with a geta's wooden knock where the
//   recording is not of geta, and levelled to one loudness; mono.
// - Music tracks are copied without their tags; their loudness is printed for the gains in src/audio.js.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'tools', '.audio-cache');
const OUT = path.join(ROOT, 'public', 'audio');
const RATE = 48000, PAD = 0.5, BED_LUFS = -24;

const BSB = (n) => `https://bigsoundbank.com/UPLOAD/bwf-en/${n}.wav`;
const SRC = {
  river: BSB('2754'),
  breeze: BSB('0907'),
  gale: BSB('1450'),
  drizzle: 'https://archive.org/download/aporee_69094_80175/LDoltonChoishiMichiTrailForestRainBirds250611.wav',
  rain: 'https://opengameart.org/sites/default/files/amb_rain2.flac',
  birds: 'https://archive.org/download/aporee_68851_79871/LDoltonKamikosawaForestBirdsQuiet250612.wav',
  uguisu: 'https://xeno-canto.org/993079/download',
  lapping: 'https://archive.org/download/aporee_24924_28918/12140612binaural2496.mp3',
  bell: 'https://archive.org/download/aporee_31518_36212/54Miidera.mp3',
  waterwheel: BSB('2768'),
  frogs: 'https://archive.org/download/aporee_65287_75404/frogs20240918082339.flac',
  bamboo: 'https://archive.org/download/aporee_43162_49194/WindinBamboo24bit.flac',
  geta: 'https://archive.org/download/aporee_25634_29691/20141031cokli1146.mp3',
  pontoon: BSB('1845'),
  path: BSB('3216'),
  grass: BSB('0854'),
};

// loops: source, start and length in seconds (plus XF of crossfade taken after it), filters
const BEDS = [
  { out: 'river', src: 'river', at: 100, len: 40, af: 'highpass=f=40' },
  { out: 'breeze', src: 'breeze', at: 8, len: 48, af: 'highpass=f=60' },
  // a broad 4.6-5.4 kHz band runs through the storm recording
  { out: 'gale', src: 'gale', at: 0, len: 38, af: 'highpass=f=50,equalizer=f=5100:t=q:w=1.5:g=-8' },
  { out: 'drizzle', src: 'drizzle', at: 10, len: 40, af: 'highpass=f=80' },
  // GoPro recording: heavy low-frequency rumble under the rain
  { out: 'rain', src: 'rain', at: 440, len: 40, af: 'highpass=f=140' },
  { out: 'birds', src: 'birds', at: 60, len: 50, af: 'highpass=f=150' },
  // calm water lapping on rocks, between the recording's bird calls
  { out: 'lapping', src: 'lapping', at: 19, len: 34, af: 'highpass=f=90,acompressor=threshold=0.03:ratio=4:attack=3:release=150' },
  // the wheel's paddles slap about every 1.77 s: 41.33 s is where the recording's beat lines up with its start again
  { out: 'waterwheel', src: 'waterwheel', at: 60, len: 41.33, af: 'highpass=f=50' },
  // a steady stretch of the rice fields' tree-frog chorus; the low band holds only the frogs' own low notes
  { out: 'frogs', src: 'frogs', at: 300, len: 40, af: 'highpass=f=300' },
  // a gusty stretch of wind in the leaves, a culm's knock or two; loud traffic rumble under 250 Hz (a steep cut)
  { out: 'bamboo', src: 'bamboo', at: 140, len: 40, af: 'highpass=f=300,highpass=f=300,highpass=f=280' },
];
const XF = 3;

// one-shots: [source, start, length]; near thunder cracks, far thunder rolls; bush-warbler songs and a valley trill
const SHOTS = [
  ...[['3179', 0, 14], ['3115', 0.3, 17], ['3114', 0.1, 11.2], ['3182', 0.2, 24]].map(([n, at, len], i) => ({ out: `thunder-near-${i + 1}`, url: BSB(n), at, len })),
  ...[['3116', 0, 22], ['2718', 0.2, 23], ['3181', 0, 26]].map(([n, at, len], i) => ({ out: `thunder-far-${i + 1}`, url: BSB(n), at, len })),
  ...[[3.6, 3.6], [11.4, 3.6], [55.0, 3.8], [18.2, 8.8]].map(([at, len], i) => ({ out: `uguisu-${i + 1}`, src: 'uguisu', at, len, af: 'highpass=f=700', peak: -6 })),
  // the evening bell's last three strikes, about 21 s apart, the last one decaying fully; a faint 5 kHz insect line
  { out: 'bell', src: 'bell', at: 100.0, len: 65, af: 'highpass=f=40,lowpass=f=4000', lufs: -20 },
];

// Footsteps: geta (wooden clogs) recorded on a street in Kyoto give the stone set as they are, and their wooden knock,
// layered at each step's onset, turns ordinary steps on boards, an earth path and grass into geta. Each entry: the
// recording, its filter, and the onsets (s) of the steps cut from it; `len` s per step from LEAD s before the onset;
// `knock`: which geta step the first one borrows (k, then on round GETA), its gain and filter (duller and quieter on
// soft ground). GETA: the geta recording's steps; the louder ones nearer the microphone clip and are left out.
const GETA = [20.636, 21.111, 23.975, 24.460, 24.957, 25.448, 25.923, 27.389];
const STEPS = [
  { surface: 'stone', src: 'geta', af: 'highpass=f=350', len: 0.3, onsets: GETA, knock: null },
  { surface: 'wood', src: 'pontoon', af: 'highpass=f=60', len: 0.36, onsets: [0.339, 0.985, 1.595, 2.226, 2.804, 4.064, 4.705, 5.366], knock: { k: 2, gain: 0.55, af: 'highpass=f=350,lowpass=f=7000' } },
  { surface: 'earth', src: 'path', af: 'highpass=f=80', len: 0.5, onsets: [0.175, 2.367, 3.039, 5.130, 6.487, 7.181, 11.363, 16.781], knock: { k: 5, gain: 0.35, af: 'highpass=f=300,lowpass=f=2800' } },
  // grass steps swell rather than strike: the onset is taken 0.12 s before each swell's peak
  { surface: 'grass', src: 'grass', af: 'highpass=f=100', len: 0.55, onsets: [0.239, 18.601, 5.009, 6.768, 7.831, 15.883, 17.685, 23.017], knock: { k: 3, gain: 0.2, af: 'highpass=f=250,lowpass=f=1300' } },
];
const LEAD = 0.03, STEP_RMS = -18; // loudest 50 ms of each step, dBFS

const MUSIC = [
  ['music-sakuya3', 'https://peritune.com/music/PerituneMaterial_Sakuya3.mp3'],
  ['music-oboro', 'https://peritune.com/music/PerituneMaterial_Oboro.mp3'],
  ['music-shizima4', 'https://peritune.com/music/PerituneMaterial_Shizima4.mp3'],
];

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}\n${r.stderr}`);
  return r;
}

function fetchSource(url) {
  const file = path.join(CACHE, url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_'));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true });
    console.log('download', url);
    // xeno-canto challenges user agents that look like a browser
    run('curl', ['-fsSL', '-A', 'sakura-river-audio-prep', '-o', file + '.part', url]);
    fs.renameSync(file + '.part', file);
  }
  return file;
}

// decoded PCM as float32 planar channels
function decode(file, at, len, af, channels) {
  const args = ['-v', 'error', '-ss', String(at), '-t', String(len), '-i', file];
  if (af) args.push('-af', af);
  args.push('-ac', String(channels), '-ar', String(RATE), '-f', 'f32le', 'pipe:1');
  const b = run('ffmpeg', args).stdout;
  const all = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  const n = all.length / channels;
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: n }, (_, i) => all[i * channels + c]));
}

function interleave(ch) {
  const n = ch[0].length, out = new Float32Array(n * ch.length);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch.length; c++) out[i * ch.length + c] = ch[c][i];
  return out;
}

const peakOf = (ch) => ch.reduce((m, a) => a.reduce((mm, v) => Math.max(mm, Math.abs(v)), m), 0);
const scale = (ch, g) => ch.forEach((a) => { for (let i = 0; i < a.length; i++) a[i] *= g; });

function loudness(ch) {
  const r = run('ffmpeg', ['-v', 'info', '-nostats', '-f', 'f32le', '-ar', String(RATE), '-ac', String(ch.length), '-i', 'pipe:0', '-af', 'ebur128', '-f', 'null', '-'], Buffer.from(interleave(ch).buffer));
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.toString().split('Summary:').pop());
  return +m[1];
}

function encode(ch, name, quality) {
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', String(ch.length), '-i', 'pipe:0',
    '-c:a', 'libmp3lame', '-q:a', String(quality), '-map_metadata', '-1', path.join(OUT, name + '.mp3')], Buffer.from(interleave(ch).buffer));
}

fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
const wanted = (name) => !only.length || only.some((p) => name.startsWith(p));

for (const b of BEDS.filter((b) => wanted(b.out))) {
  const src = decode(fetchSource(SRC[b.src]), b.at, b.len + XF, b.af, 2);
  const L = Math.round(b.len * RATE), X = Math.round(XF * RATE), P = Math.round(PAD * RATE);
  const loop = src.map((a) => {
    const o = a.slice(0, L);
    // equal-power: the segment's continuation past L fades out over the head, so o[L-1] -> o[0] is continuous
    for (let i = 0; i < X; i++) { const t = (i / X) * Math.PI / 2; o[i] = a[i] * Math.sin(t) + a[L + i] * Math.cos(t); }
    const f = new Float32Array(L + 2 * P);
    f.set(o.subarray(L - P), 0); f.set(o, P); f.set(o.subarray(0, P), P + L);
    return f;
  });
  const I = loudness(loop.map((a) => a.subarray(P, P + L)));
  const g = Math.min(10 ** ((BED_LUFS - I) / 20), 10 ** (-1 / 20) / peakOf(loop));
  scale(loop, g);
  encode(loop, b.out, 3);
  console.log(`${b.out}: ${b.len}s loop, ${I.toFixed(1)} LUFS -> ${(I + 20 * Math.log10(g)).toFixed(1)}`);
}

for (const s of SHOTS.filter((s) => wanted(s.out))) {
  const [ch] = decode(fetchSource(s.url || SRC[s.src]), s.at, s.len, s.af, 1);
  const fi = Math.round((s.src === 'uguisu' ? 0.25 : 0.02) * RATE), fo = Math.round(Math.min(2.5, s.len * 0.25) * RATE), n = ch.length;
  for (let i = 0; i < fi; i++) ch[i] *= i / fi;
  for (let i = 0; i < fo; i++) ch[n - 1 - i] *= (i / fo) ** 2;
  const pk = 10 ** ((s.peak ?? -1) / 20) / peakOf([ch]);
  scale([ch], s.lufs ? Math.min(pk, 10 ** ((s.lufs - loudness([ch])) / 20)) : pk);
  encode([ch], s.out, 4);
  console.log(`${s.out}: ${(n / RATE).toFixed(1)}s`);
}

// a geta's clack: its first 35 ms, then a quick decay that takes the street's noise out after the knock has rung
function clack(at, af) {
  const [ch] = decode(fetchSource(SRC.geta), at - LEAD, 0.3, af, 1);
  const k0 = Math.round((LEAD + 0.035) * RATE);
  for (let i = k0; i < ch.length; i++) ch[i] *= Math.exp(-(i - k0) / (0.05 * RATE));
  return ch;
}
// a look-ahead peak limiter: the gain each sample needs, held over 1 ms ahead, released over 40 ms
function limit(ch, ceil) {
  const A = Math.round(0.001 * RATE), rel = Math.exp(-1 / (0.04 * RATE)), need = new Float32Array(ch.length);
  for (let i = 0; i < ch.length; i++) need[i] = Math.min(1, ceil / (Math.abs(ch[i]) + 1e-9));
  let g = 1;
  for (let i = 0; i < ch.length; i++) {
    let m = 1;
    for (let j = i; j < Math.min(ch.length, i + A); j++) m = Math.min(m, need[j]);
    g = m < g ? m : m - (m - g) * rel;
    ch[i] *= g;
  }
}
const loudest = (ch, w = Math.round(0.05 * RATE)) => {
  let best = 0, s = 0;
  for (let i = 0; i < ch.length; i++) { s += ch[i] * ch[i]; if (i >= w) s -= ch[i - w] * ch[i - w]; best = Math.max(best, s); }
  return Math.sqrt(best / w);
};
for (const set of STEPS) {
  set.onsets.forEach((t, i) => {
    const out = `step-${set.surface}-${i + 1}`;
    if (!wanted(out)) return;
    const [ch] = set.src === 'geta' ? [clack(t, set.af)] : decode(fetchSource(SRC[set.src]), t - LEAD, set.len, set.af, 1);
    const n = Math.min(ch.length, Math.round(set.len * RATE));
    if (set.knock) {
      const kn = clack(GETA[(i + set.knock.k) % GETA.length], set.knock.af);
      for (let j = 0; j < n && j < kn.length; j++) ch[j] += kn[j] * set.knock.gain;
    }
    const fi = Math.round(0.008 * RATE), fo = Math.round(set.len * 0.45 * RATE);
    for (let j = 0; j < fi; j++) ch[j] *= 0.5 - 0.5 * Math.cos(Math.PI * j / fi);
    for (let j = 0; j < fo; j++) ch[n - 1 - j] *= (j / fo) ** 2;
    const step = ch.subarray(0, n);
    // to STEP_RMS, but the sharpest clacks would then peak over the ceiling: up to 4 dB of their first milliseconds
    // goes to a limiter, beyond that the step stays quieter
    const ceil = 10 ** (-1 / 20);
    scale([step], Math.min(10 ** (STEP_RMS / 20) / loudest(step), ceil * 10 ** (4 / 20) / peakOf([step])));
    limit(step, ceil);
    encode([step], out, 4);
    console.log(`${out}: ${(n / RATE).toFixed(2)}s, peak ${(20 * Math.log10(peakOf([step]))).toFixed(1)} dBFS`);
  });
}

for (const [name, url] of MUSIC.filter(([name]) => wanted(name))) {
  const file = fetchSource(url);
  run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', '0:a', '-c', 'copy', '-map_metadata', '-1', '-id3v2_version', '0', '-write_xing', '1', path.join(OUT, name + '.mp3')]);
  const r = run('ffmpeg', ['-v', 'info', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-']);
  console.log(`${name}: ${/I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.toString().split('Summary:').pop())[1]} LUFS`);
}
