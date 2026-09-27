// Builds public/audio/ from the source recordings credited in README.md (Sound).
//   node tools/audio.mjs
// Needs ffmpeg with libmp3lame. Sources are downloaded once into tools/.audio-cache/.
// - Beds (river, wind, rain, birds, frogs) become seamless loops: the segment's tail is crossfaded into its head,
//   and the file carries PAD seconds of the loop's own end before it and of its start after it, so the page can
//   loop [PAD, PAD + length] and stay seamless whatever the MP3 decoder does with encoder delay and padding.
//   They are levelled to BED_LUFS, with the peak held under -1 dBFS.
// - One-shots (thunder, bush-warbler songs) are trimmed, faded and peak-normalised; mono, panned by the page.
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
  frogs: 'https://archive.org/download/aporee_68909_79946/LDoltonKudoyamaRiceFieldsEveChorusCloser250612.wav',
  uguisu: 'https://xeno-canto.org/993079/download',
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
  { out: 'frogs', src: 'frogs', at: 15, len: 50, af: 'highpass=f=150' },
];
const XF = 3;

// one-shots: [source, start, length]; near thunder cracks, far thunder rolls; bush-warbler songs and a valley trill
const SHOTS = [
  ...[['3179', 0, 14], ['3115', 0.3, 17], ['3114', 0.1, 11.2], ['3182', 0.2, 24]].map(([n, at, len], i) => ({ out: `thunder-near-${i + 1}`, url: BSB(n), at, len })),
  ...[['3116', 0, 22], ['2718', 0.2, 23], ['3181', 0, 26]].map(([n, at, len], i) => ({ out: `thunder-far-${i + 1}`, url: BSB(n), at, len })),
  ...[[3.6, 3.6], [11.4, 3.6], [55.0, 3.8], [18.2, 8.8]].map(([at, len], i) => ({ out: `uguisu-${i + 1}`, src: 'uguisu', at, len, af: 'highpass=f=700', peak: -6 })),
];

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

for (const b of BEDS) {
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

for (const s of SHOTS) {
  const [ch] = decode(fetchSource(s.url || SRC[s.src]), s.at, s.len, s.af, 1);
  const fi = Math.round((s.src ? 0.25 : 0.02) * RATE), fo = Math.round(Math.min(2.5, s.len * 0.25) * RATE), n = ch.length;
  for (let i = 0; i < fi; i++) ch[i] *= i / fi;
  for (let i = 0; i < fo; i++) ch[n - 1 - i] *= (i / fo) ** 2;
  scale([ch], 10 ** ((s.peak ?? -1) / 20) / peakOf([ch]));
  encode([ch], s.out, 4);
  console.log(`${s.out}: ${(n / RATE).toFixed(1)}s`);
}

for (const [name, url] of MUSIC) {
  const file = fetchSource(url);
  run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-map', '0:a', '-c', 'copy', '-map_metadata', '-1', '-id3v2_version', '0', '-write_xing', '1', path.join(OUT, name + '.mp3')]);
  const r = run('ffmpeg', ['-v', 'info', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-']);
  console.log(`${name}: ${/I:\s+(-?[\d.]+) LUFS/.exec(r.stderr.toString().split('Summary:').pop())[1]} LUFS`);
}
