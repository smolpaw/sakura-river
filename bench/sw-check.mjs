// Checks the service worker (src/sw.js) on the built site: serves dist/ under /sakura-river/ with GitHub Pages' cache
// headers (max-age=600, ETag, 304s, byte ranges) and loads it headless in one browser profile:
//   1. a first visit (the worker registers once the scene shows and keeps the textures and the transcoder);
//   2. a reload: what still reaches the server (should be the page alone, revalidated);
//   3. a new deploy (a build with one texture changed): the next load gets the new page and the changed file;
//   4. a reload of the new deploy: the page alone again, and the old copy dropped from the worker's cache.
// Prints the requests the server saw per step and fails (exit 1) when a step goes wrong.
//   pnpm build && BENCH_HEADLESS=1 node bench/sw-check.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { build } from 'vite';
import { CHROMIUM } from './lib/browser.mjs';
import { BENCH } from './lib/serve.mjs';

const ROOT = path.resolve(BENCH, '..');
const BASE = '/sakura-river/';
const CHANGED = 'textures/brown_mud_02_diff.ktx2';

// the second deploy: public/ with CHANGED swapped for another valid texture
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-sw-'));
const pub = path.join(tmp, 'public'), distB = path.join(tmp, 'dist');
fs.cpSync(path.join(ROOT, 'public'), pub, { recursive: true });
fs.copyFileSync(path.join(pub, 'textures/forrest_ground_01_diff.ktx2'), path.join(pub, CHANGED));
await build({ root: ROOT, publicDir: pub, logLevel: 'warn', build: { outDir: distB, emptyOutDir: true } });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ktx2': 'image/ktx2' };
let dist = path.join(ROOT, 'dist'), log = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith(BASE)) { res.writeHead(404); res.end(); return; }
  let f = path.join(dist, decodeURIComponent(u.pathname.slice(BASE.length)) || 'index.html');
  if (!f.startsWith(dist) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { log.push(`404 ${u.pathname}`); res.writeHead(404); res.end(); return; }
  const body = fs.readFileSync(f), etag = `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'max-age=600', etag, 'accept-ranges': 'bytes' };
  const name = u.pathname.slice(BASE.length) + u.search;
  if (req.headers['if-none-match'] === etag) { log.push(`304 ${name}`); res.writeHead(304, head); res.end(); return; }
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const a = +range[1], b = range[2] ? Math.min(+range[2], body.length - 1) : body.length - 1;
    log.push(`206 ${name}`);
    res.writeHead(206, { ...head, 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': b - a + 1 });
    res.end(body.subarray(a, b + 1));
    return;
  }
  log.push(`200 ${name}`);
  res.writeHead(200, { ...head, 'content-length': body.length });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}${BASE}`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || CHROMIUM, headless: process.env.BENCH_HEADLESS ? 'new' : false, userDataDir: path.join(tmp, 'profile'),
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=960,540'],
  defaultViewport: { width: 960, height: 540 }, protocolTimeout: 0,
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('sr.quality', 'low'); localStorage.setItem('sr.sound', 'off'); } catch (e) { /* ignore */ }
  try { Object.defineProperty(navigator, 'gpu', { get: () => undefined }); } catch (e) { /* ignore */ } // WebGL: quicker to start headless
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let failed = false;
const check = (ok, what) => { console.log(ok ? '  ok  ' : '  FAIL', what); if (!ok) failed = true; };
async function visit(label, reload) {
  log = [];
  if (reload) await page.reload({ waitUntil: 'load' }); else await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('veil').classList.contains('done') || document.getElementById('veil').classList.contains('failed'), { timeout: 300000 });
  // the worker in control and done with its install (the textures kept)
  await page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.state === 'activated', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500)); // (late fetches: the figures' model)
  const kept = await page.evaluate(async () => (await (await caches.open('sr-files')).keys()).map((r) => new URL(r.url).pathname.split('/').slice(2).join('/') + new URL(r.url).search));
  const failedVeil = await page.evaluate(() => document.getElementById('veil').classList.contains('failed'));
  console.log(`${label}: ${log.length} requests reached the server, ${kept.length} files in the worker's cache`);
  for (const l of log) console.log('    ' + l);
  check(!failedVeil, 'the scene started');
  return { log: [...log], kept };
}

const first = await visit('1. first visit');
check(first.log.some((l) => l.startsWith('200 textures/')), 'textures fetched from the server');
check(first.kept.some((k) => k.startsWith('textures/')) && first.kept.some((k) => k.startsWith('basis/')), 'textures and transcoder kept by the worker');
const again = await visit('2. reload', true);
const pageOnly = (log) => log.every((l) => ['', 'index.html', 'sw.js'].includes(l.split(' ')[1].split('?')[0]));
check(pageOnly(again.log), 'only the page (and the worker script) reached the server');
const changedOld = first.kept.find((k) => k.startsWith(CHANGED));
dist = distB; // the new deploy
const deployed = await visit('3. after a new deploy', true);
const changedNew = deployed.log.find((l) => l.includes(CHANGED));
check(!!changedNew && !changedNew.includes(changedOld.split('?')[1]), 'the changed texture fetched anew by its new URL');
check(deployed.log.includes('200 '), 'the new page fetched (200, not 304)');
const settled = await visit('4. reload of the new deploy', true);
check(pageOnly(settled.log), 'only the page (and the worker script) reached the server');
check(!settled.kept.includes(changedOld), 'the old copy of the changed texture dropped from the cache');
check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close(); server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
