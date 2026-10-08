// Loads the built site (dist/, `pnpm build` first) as a visitor would, on an emulated weaker device, and prints one
// JSON line: whether the scene started or the page showed its failure screen (and what it said and offered), the load
// time and the engine's start-up marks, the longest main-thread tasks, the WebGL shaders' count and size, memory, the
// frame rate after, the fps counter and the too-slow notice; then the page's warnings and errors.
//   BENCH_HEADLESS=1 node bench/device-probe.mjs <mode> [quality] [options]
// mode: webgl (no WebGPU: the WebGL2 fallback), webgl-soft (the fallback on SwiftShader, a CPU rasterizer: far slower
// than any GPU), gpu (this machine's WebGPU), compat (WebGPU in compatibility mode, what older GPUs and Android on
// OpenGL ES get: the device made without core features and limits), soft (WebGPU on SwiftShader). Headless WebGPU loses
// its device within seconds here, which the page shows as a failure: run gpu and compat headed (no BENCH_HEADLESS,
// under bench/gpu.sh), where they use the real GPU.
// quality: auto (default), low, medium, high, ultra (stored as the page's choice).
// --seconds n: frame rate measured over n s after the scene shows (10); --timeout s: give up loading after s (300);
// --cpu n: the main thread slowed n times; --block s@t: the main thread held busy s seconds, t seconds in;
// --lose s: the WebGL context lost s seconds in (or after the scene shows, if it shows first; webgl modes);
// --time <dawn|afternoon|dusk|night>: that preset's time-lapse (15 s) before --shot file.png, a screenshot (also of the
// failure screen); --trace: the loading screen's text every half second.
// PROBE_UA=<user agent> poses as another device (an Android phone: three and the page take other paths on it);
// PROBE_DUMP=<dir> writes the WebGL shaders' sources longer than PROBE_DUMP_MIN characters (40000) there.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { CHROMIUM } from './lib/browser.mjs';
import { BENCH } from './lib/serve.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  seconds: { type: 'string', default: '10' }, timeout: { type: 'string', default: '300' }, cpu: { type: 'string', default: '1' }, lose: { type: 'string', default: '0' }, trace: { type: 'boolean', default: false }, block: { type: 'string', default: '' }, shot: { type: 'string', default: '' }, time: { type: 'string', default: '' }, width: { type: 'string', default: '1280' }, height: { type: 'string', default: '720' },
} });
const [mode = 'gpu', quality = 'auto'] = positionals;
const DIST = path.join(BENCH, '..', 'dist');
const TYPES = { '.html': 'text/html', '.glb': 'model/gltf-binary', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };
const server = http.createServer((req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p.endsWith('/')) p += 'index.html';
  if (!p.startsWith(DIST) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const FLAGS = {
  gpu: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'],
  compat: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'],
  soft: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  webgl: ['--use-angle=vulkan', '--enable-features=Vulkan'],
  'webgl-soft': ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};
const headless = !!process.env.BENCH_HEADLESS;
const browser = await puppeteer.launch({
  executablePath: CHROMIUM, headless: headless ? 'new' : false, userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sr-probe-')), // fresh: a stale profile can stall a headed run
  args: [...(headless || !['gpu', 'compat'].includes(mode) ? FLAGS[mode] : []), `--window-size=${o.width},${o.height}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: +o.width, height: +o.height }, protocolTimeout: 0,
});
const page = (await browser.pages())[0] || await browser.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message.slice(0, 300)));
page.on('error', (e) => console.log('[crash] ' + e.message));
if (process.env.PROBE_UA) await page.setUserAgent(process.env.PROBE_UA);
await page.evaluateOnNewDocument((mode, quality, dump, dumpMin) => {
  window.__long = [];
  window.__sh = { n: 0, bytes: 0, max: 0, programs: 0 };
  if (window.WebGL2RenderingContext) {
    const P = WebGL2RenderingContext.prototype, src = P.shaderSource, link = P.linkProgram;
    window.__big = [];
    P.shaderSource = function (sh, code) { const S = window.__sh; S.n++; if (dump && code.length > dumpMin) window.__big.push(code); S.bytes += code.length; S.max = Math.max(S.max, code.length); return src.call(this, sh, code); };
    P.linkProgram = function (p) { window.__sh.programs++; return link.call(this, p); };
  }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch (e) { /* ignore */ }
  try { localStorage.setItem('sr.quality', quality); localStorage.setItem('sr.sound', 'off'); } catch (e) { /* ignore */ }
  if (mode.startsWith('webgl')) { try { Object.defineProperty(navigator, 'gpu', { get: () => undefined }); } catch (e) { /* ignore */ } }
  if (mode === 'compat' && navigator.gpu) {
    // the adapter a compatibility-only GPU hands out: the device never gets core features and limits
    const req = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (opts = {}) => {
      const a = await req({ ...opts, featureLevel: 'compatibility' });
      if (!a) return a;
      const rd = a.requestDevice.bind(a);
      const features = new Set([...a.features].filter((f) => f !== 'core-features-and-limits'));
      return new Proxy(a, {
        get(t, k) {
          if (k === 'requestDevice') return (d = {}) => rd({ ...d, requiredFeatures: (d.requiredFeatures || []).filter((f) => f !== 'core-features-and-limits') });
          if (k === 'features') return features;
          const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
        },
      });
    };
  }
}, mode, quality, !!process.env.PROBE_DUMP, +(process.env.PROBE_DUMP_MIN || 40000));
if (+o.cpu > 1) { const c = await page.createCDPSession(); await c.send('Emulation.setCPUThrottlingRate', { rate: +o.cpu }); }
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
const deadline = t0 + +o.timeout * 1000;
let state;
for (;;) {
  state = await page.evaluate(() => ({ done: document.getElementById('veil').classList.contains('done'), failed: document.getElementById('veil').classList.contains('failed'), text: document.getElementById('veil-text').textContent, sub: (document.getElementById('veil-sub') || {}).textContent, q: document.getElementById('quality').options[0].textContent, vis: document.visibilityState }));
  if (o.trace) console.log((Date.now() - t0) / 1000, state.vis, state.text, state.sub);
  if (state.done || state.failed || Date.now() > deadline) break;
  if (o.block && Date.now() - t0 > +o.block.split('@')[1] * 1000) { const ms = +o.block.split('@')[0] * 1000; o.block = ''; page.evaluate((ms) => { const e = performance.now() + ms; while (performance.now() < e); }, ms).catch(() => {}); }
  if (+o.lose && Date.now() - t0 > +o.lose * 1000) { o.lose = 0; await page.evaluate(() => document.getElementById('scene').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()); }
  await new Promise((r) => setTimeout(r, 500));
}
const loadS = (Date.now() - t0) / 1000;
if (process.env.PROBE_DUMP) { const big = await page.evaluate(() => window.__big); fs.mkdirSync(process.env.PROBE_DUMP, { recursive: true }); big.forEach((c, i) => fs.writeFileSync(path.join(process.env.PROBE_DUMP, `big${i}.glsl`), c)); }
const shaders = await page.evaluate(() => ({ ...window.__sh, kb: Math.round(window.__sh.bytes / 1024), maxKb: Math.round(window.__sh.max / 1024) }));
const longest = await page.evaluate(() => window.__long.slice().sort((a, b) => b[1] - a[1]).slice(0, 6));
const marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('sr:')).map((m) => [m.name.slice(3), Math.round(m.startTime)])));
let fps = null;
if (state.done) {
  fps = await page.evaluate((s) => new Promise((res) => {
    let n = 0; const t = performance.now();
    (function f() { n++; if (performance.now() - t < s * 1000) requestAnimationFrame(f); else res(+(n / ((performance.now() - t) / 1000)).toFixed(1)); })();
  }), +o.seconds);
  if (o.time) { // a time-of-day preset (dawn, afternoon, dusk, night), reached as the page's time-lapse
    await page.evaluate((n) => [...document.querySelectorAll('#times button')].find((b) => b.getAttribute('aria-label').toLowerCase() === n).click(), o.time);
    await new Promise((r) => setTimeout(r, 15000));
  }
  if (o.shot) await page.screenshot({ path: o.shot });
  if (+o.lose) await page.evaluate(() => document.getElementById('scene').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await new Promise((r) => setTimeout(r, 500));
  state = await page.evaluate(() => ({ done: document.getElementById('veil').classList.contains('done'), failed: document.getElementById('veil').classList.contains('failed'), text: document.getElementById('veil-text').textContent, sub: (document.getElementById('veil-sub') || {}).textContent, q: document.getElementById('quality').options[0].textContent, stats: document.getElementById('stats').textContent, notice: (document.getElementById('notice') || { hidden: true }).hidden ? '' : document.getElementById('notice-text').textContent }));
}
if (state.failed && o.shot) await page.screenshot({ path: o.shot });
const cdp = await page.createCDPSession();
await cdp.send('Performance.enable');
const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const heapMB = Math.round(metrics.JSHeapUsedSize / 1e6);
const root = browser.process().pid;
const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
const tree = new Set([root]);
for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
const rssMB = Math.round(rows.filter(([pid]) => tree.has(pid)).reduce((a, [, , r]) => a + r, 0) / 1024);
const gpu = await page.evaluate(async () => {
  if (!navigator.gpu) return 'none';
  const a = await navigator.gpu.requestAdapter(); if (!a) return 'no adapter';
  const i = a.info || {}; return `${i.vendor} ${i.architecture} ${i.description}`.trim();
});
console.log(JSON.stringify({ mode, quality, gpu, loaded: state.done, failed: state.failed, loadS, veil: state.text, sub: state.sub, actions: await page.evaluate(() => [...document.querySelectorAll('#veil-actions button')].map((b) => b.textContent)), menu: state.q, stats: state.stats, notice: state.notice, rafFps: fps, heapMB, rssMB, marks, longest, shaders }));
const seen = new Set();
for (const l of logs) { const k = l.replace(/\d+/g, '#'); if (!seen.has(k)) { seen.add(k); console.log('  ' + l); } }
await browser.close(); server.close();
