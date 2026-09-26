// pnpm bench:visual -- --build <label> [--backend webgl|webgpu] [--angle default|gl|vulkan|swiftshader]
//   [--golden] [--only stills|seq] [--tag <suffix>] [--eval] [--base <dir-name>]
// Renders every still (views x settings) and sequence frame listed in bench/views.json into
// bench/out/visual/<build>-<backend>[-<angle>][-<tag>]/. With --golden it renders at the supersampled size into
// bench/goldens/ and box-downsamples in linear light. With --eval it then runs the FLIP gate (flip_eval.py).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { startServer, BENCH } from './lib/serve.mjs';
import { launch, openHarness, assertHardware } from './lib/browser.mjs';

const { values: o } = parseArgs({ options: {
  build: { type: 'string' }, backend: { type: 'string', default: 'webgl' }, angle: { type: 'string', default: 'default' },
  golden: { type: 'boolean', default: false }, only: { type: 'string' }, tag: { type: 'string' },
  eval: { type: 'boolean', default: false }, base: { type: 'string' }, extra: { type: 'string' }, settings: { type: 'string' }, views: { type: 'string' },
} });
if (!o.build) { console.error('need --build'); process.exit(1); }
const V = JSON.parse(fs.readFileSync(path.join(BENCH, 'views.json'), 'utf8'));
const S = o.golden ? V.visual.supersample : 1;
const cssW = V.visual.cssW * S, cssH = V.visual.cssH * S;
const name = o.golden ? 'goldens/raw' : `out/visual/${o.build}-${o.backend}${o.angle !== 'default' ? '-' + o.angle : ''}${o.tag ? '-' + o.tag : ''}`;
const outDir = path.join(BENCH, name);
if (!o.only) fs.rmSync(outDir, { recursive: true, force: true });
else fs.rmSync(path.join(outDir, o.only === 'seq' ? 'seq' : 'stills'), { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const extra = o.extra ? JSON.parse(o.extra) : {};

const { server, url } = await startServer();
const { browser, args, version } = await launch({ scale: V.visual.scale, angle: o.angle, profile: 'visual' });
const query = o.angle === 'vulkan' || o.angle === 'swiftshader' ? '?preserve' : '';
let page = await openHarness(browser, url, query);
const env = await page.evaluate(() => H.env());
await page.close();
assertHardware(env, { allowSoftware: o.angle === 'swiftshader', needWebGPU: o.backend === 'webgpu' });

async function fresh(settings) {
  page = await openHarness(browser, url, query);
  const setup = await page.evaluate((p) => H.setup(p), {
    engine: `./builds/${o.build}/engine.js`, cssW, cssH, quality: V.visual.quality, backend: o.backend, settings: { ...V.defaults, ...settings }, extra,
  });
  return setup;
}
async function done() {
  const logs = page.logs.slice();
  await page.evaluate(() => H.dispose());
  await page.close();
  return logs;
}

const manifest = { build: o.build, backend: o.backend, angle: o.angle, golden: o.golden, size: [cssW, cssH], chromium: version, flags: args, env, stills: [], sequences: {}, logs: [] };
const t0 = Date.now();
const settingsList = V.settings.filter((s) => !o.settings || o.settings.split(',').includes(s.id));
const viewList = V.views.filter((v) => !o.views || o.views.split(',').includes(v.id));

if (o.only !== 'seq') {
  for (const st of settingsList) {
    const setup = await fresh(st.set);
    manifest.setup = setup;
    for (const v of viewList) {
      await page.evaluate((v, s) => H.view(v, s.settle, s.dt), v, V.still);
      await page.evaluate((n) => H.frames(n, 0), V.still.converge - 1);
      const file = `${name}/stills/${st.id}-${v.id}.png`;
      await page.evaluate((f) => H.capture(f, 0), file);
      manifest.stills.push({ id: `${st.id}-${v.id}`, file: path.relative(outDir, path.join(BENCH, file)) });
    }
    manifest.logs.push(...(await done()));
    log('stills', st.id, 'done');
  }
}

if (o.only !== 'stills') {
  for (const sq of V.sequences) {
    await fresh({});
    const frames = [];
    const cap = async (k, dt) => {
      const file = `${name}/seq/${sq.id}/${String(k).padStart(3, '0')}.png`;
      await page.evaluate((f, dt) => H.capture(f, dt), file, dt);
      frames.push({ k, file: path.relative(outDir, path.join(BENCH, file)) });
    };
    if (sq.kind === 'cine') {
      await page.evaluate((u, s) => { H.view({ cine: u }, s); H.cinematic(true); }, sq.start, sq.settle);
    } else {
      if (sq.kind === 'wind') await page.evaluate(() => H.set('wind', 1));
      await page.evaluate((s) => H.view({ hero: true }, s), sq.settle);
    }
    const dt = sq.kind === 'frozen' ? 0 : 1 / 60;
    if (sq.warm) await page.evaluate((n, dt) => H.frames(n, dt), sq.warm, dt);
    for (let k = 0; k < sq.frames; k++) {
      const want = sq.kind === 'frozen' ? k >= sq.captureFrom : k % sq.every === 0 || k === sq.frames - 1;
      if (want) await cap(k, dt);
      else await page.evaluate((dt) => H.frames(1, dt), dt);
    }
    manifest.sequences[sq.id] = frames;
    manifest.logs.push(...(await done()));
    log('sequence', sq.id, 'done');
  }
}
await browser.close();
server.close();
manifest.seconds = (Date.now() - t0) / 1000;
const prevFile = path.join(outDir, 'manifest.json');
if (o.only && fs.existsSync(prevFile)) {
  const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
  if (o.only === 'seq') manifest.stills = prev.stills; else manifest.sequences = prev.sequences;
}
fs.writeFileSync(prevFile, JSON.stringify(manifest, null, 1));
log('rendered', manifest.stills.length, 'stills +', Object.values(manifest.sequences).reduce((a, s) => a + s.length, 0), 'sequence frames in', manifest.seconds, 's ->', name);
if (manifest.logs.length) log('page warnings/errors:', manifest.logs.slice(0, 10));

const PY = path.join(BENCH, '.venv/bin/python');
if (o.golden) {
  execFileSync(PY, [path.join(BENCH, 'flip_eval.py'), 'downsample', '--src', outDir, '--dst', path.join(BENCH, 'goldens'), '--factor', String(S)], { stdio: 'inherit' });
}
if (o.eval) {
  const a = [path.join(BENCH, 'flip_eval.py'), 'gate', '--cand', outDir];
  if (o.base) a.push('--base', path.join(BENCH, 'out/visual', o.base));
  execFileSync(PY, a, { stdio: 'inherit' });
}
