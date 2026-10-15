// The check before publishing (.github/workflows/pages.yml): loads dist/ headless as a visitor would and fails (exit 1)
// unless the scene starts. Served over HTTP under /sakura-river/ as GitHub Pages serves it (or opened as a file with
// --file), on the WebGL2 fallback in SwiftShader (a CPU rasterizer: what the CI runner has; slow, so Low quality and
// generous time). Passes when the loading screen gives way to the scene (no failure screen), a frame of the scene is
// drawn (not blank), and the page logs no uncaught exception and no console error beyond KNOWN.
//   pnpm build && node bench/check-dist.mjs [--file] [--timeout s] [--shot out.png]
// CHROME=<path> picks the browser (the CI runner's google-chrome; here /usr/bin/chromium). Prints one JSON line.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const { values: o } = parseArgs({ options: { file: { type: 'boolean', default: false }, timeout: { type: 'string', default: '900' }, shot: { type: 'string', default: '' } } });
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const BASE = '/sakura-river/';
// console errors every load shows, harmless: none so far
const KNOWN = [];

let url, server;
if (o.file) url = 'file://' + path.join(DIST, 'index.html');
else {
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ktx2': 'image/ktx2' };
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const f = path.join(DIST, decodeURIComponent(u.pathname.slice(BASE.length)) || 'index.html');
    if (!u.pathname.startsWith(BASE) || !f.startsWith(DIST) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}${BASE}`;
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/chromium', headless: 'new', userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sr-check-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--allow-file-access-from-files', ...(process.env.CI ? ['--no-sandbox'] : [])],
  defaultViewport: { width: 1280, height: 720 }, protocolTimeout: 0,
});
const page = await browser.newPage();
const problems = [], logs = [];
page.on('pageerror', (e) => problems.push('uncaught: ' + e.message.slice(0, 300)));
page.on('console', (m) => {
  const t = `[${m.type()}] ${m.text().slice(0, 300)}`;
  if (m.type() === 'error' && !KNOWN.some((k) => k.test(m.text()))) problems.push(t);
  else if (m.type() === 'warn') logs.push(t);
});
await page.evaluateOnNewDocument(() => {
  try { localStorage.setItem('sr.quality', 'low'); localStorage.setItem('sr.sound', 'off'); } catch (e) { /* ignore */ }
  try { Object.defineProperty(navigator, 'gpu', { get: () => undefined }); } catch (e) { /* ignore */ } // the WebGL2 fallback
});
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
const veil = () => page.evaluate(() => ({ done: document.getElementById('veil').classList.contains('done'), failed: document.getElementById('veil').classList.contains('failed'), text: document.getElementById('veil-text').textContent }));
let state = await veil();
while (!state.done && !state.failed && Date.now() - t0 < +o.timeout * 1000) { await new Promise((r) => setTimeout(r, 1000)); state = await veil(); }
const loadS = (Date.now() - t0) / 1000;
// a frame of the scene: the canvas read back just after the engine draws (an animation frame callback queued after
// its own), its luminance's mean and spread over a 64 x 36 grid
let frame = null;
if (state.done) {
  await new Promise((r) => setTimeout(r, 3000));
  frame = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
    const src = document.getElementById('scene'), c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(src, 0, 0, 64, 36);
    const d = cx.getImageData(0, 0, 64, 36).data;
    let s = 0, s2 = 0;
    for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; s += l; s2 += l * l; }
    const n = d.length / 4, mean = s / n;
    resolve({ mean: +mean.toFixed(1), spread: +Math.sqrt(Math.max(0, s2 / n - mean * mean)).toFixed(1), stats: document.getElementById('stats').textContent });
  })));
}
if (o.shot) await page.screenshot({ path: o.shot });
await browser.close();
if (server) server.close();

if (!state.done) problems.push(state.failed ? `failure screen: ${state.text}` : `no scene after ${o.timeout} s: ${state.text}`);
if (frame && !(frame.mean > 8 && frame.spread > 4)) problems.push(`blank frame (luminance mean ${frame.mean}, spread ${frame.spread})`);
console.log(JSON.stringify({ url: o.file ? 'file' : url, ok: !problems.length, loadS, veil: state.text, frame, problems, warnings: [...new Set(logs)].slice(0, 8) }));
process.exit(problems.length ? 1 : 0);
