// The built page's own behaviour, headless WebGL (pnpm build first): the link in the URL, the copy-link button,
// photo mode, the time slider, reduced motion and a change of the device pixel ratio.
//   BENCH_HEADLESS=1 node bench/page-check.mjs [prefix] [checks]
// checks: comma-separated names below (default all). Prints one line per check, PASS or FAIL with what it saw, and the
// pages' errors; screenshots go to bench/<prefix>-<check>*.png (default prefix out/page).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './lib/browser.mjs';
import { BENCH } from './lib/serve.mjs';

const [prefix = 'out/page', only] = process.argv.slice(2);
const DIST = path.resolve(BENCH, '../dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.jpg': 'image/jpeg', '.png': 'image/png', '.ktx2': 'image/ktx2' };
const server = http.createServer((req, res) => {
  let p = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const { browser } = await launch({ scale: 1, profile: 'page-check' });
await browser.defaultBrowserContext().overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let failed = 0;
const report = (name, ok, seen) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(seen)}`); };
const shot = (page, name) => page.screenshot({ path: path.join(BENCH, `${prefix}-${name}.png`) });

// a page at `hash` (WebGL, fixed High quality), once the scene shows; reduced: prefers-reduced-motion
async function open(hash = '', { reduced = false, scale = 1 } = {}) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/popErrorScope|status of 404/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message.slice(0, 200)));
  await page.evaluateOnNewDocument(() => { sessionStorage.setItem('sr.backend', 'webgl'); localStorage.setItem('sr.quality', 'high'); localStorage.setItem('sr.sound', 'off'); });
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: scale });
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(base + hash);
  await page.waitForFunction(() => document.getElementById('veil').classList.contains('done') || document.getElementById('veil').classList.contains('failed'), { timeout: 120000 });
  return page;
}
const state = (page) => page.evaluate(() => ({
  hash: location.hash, history: history.length, clock: document.getElementById('clock').textContent, weather: document.getElementById('w-name').textContent,
  walk: document.getElementById('btn-walk').getAttribute('aria-pressed'), slider: +document.getElementById('t-day').value, valuetext: document.getElementById('t-day').getAttribute('aria-valuetext'),
}));
// how much two screenshots differ: the mean absolute difference of their 40x40-pixel blocks' means (0..255), so the
// scene's own small motions (grass, petals, birds) count for little and a move of the camera for much
async function moved(page, ms) {
  const a = await page.screenshot({ encoding: 'base64' });
  await sleep(ms);
  return differ(page, a, await page.screenshot({ encoding: 'base64' }));
}
function differ(page, a, b) {
  return page.evaluate(async (a, b) => {
    const img = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); const c = new OffscreenCanvas(i.width, i.height), g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
    const [x, y] = [await img(a), await img(b)];
    const W = 1280, B = 40, m = (d) => { const o = new Float64Array((W / B) * 18 * 3); for (let i = 0; i < d.length; i += 4) { const p = i / 4, k = (((p / W / B) | 0) * (W / B) + (((p % W) / B) | 0)) * 3; o[k] += d[i]; o[k + 1] += d[i + 1]; o[k + 2] += d[i + 2]; } return o; };
    const [p, q] = [m(x), m(y)];
    let s = 0; for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]);
    return s / (p.length * B * B);
  }, a, b);
}

const CHECKS = {
  async plain() {
    const page = await open();
    const early = await moved(page, 400); // the opening flight still on
    await sleep(8000);
    const s = await state(page);
    await shot(page, 'plain');
    report('plain URL: the opening flight, night, clear, no hash once it rests', early > 2 && s.hash === '' && s.clock === '20:45' && s.weather === 'Clear', { early: +early.toFixed(2), ...s });
    await page.close();
  },
  async link() {
    const page = await open('#t=11.5&w=haze&v=-30.5,4.2,10,-12,5,-3');
    await sleep(2500);
    const s = await state(page);
    await shot(page, 'link');
    report('a link opens there', s.clock === '11:30' && s.weather === 'Spring haze' && s.slider === 11.5 && /^#t=11\.5&w=haze&v=/.test(s.hash), s);
    await page.close();
  },
  async invalid() {
    const page = await open('#t=abc&w=nope&v=1,2,NaN,4,5,6&walk=x,1&junk=%E0%A4%A');
    await sleep(8000);
    const s = await state(page);
    // (and the address cleaned of it: the scene rests at its default)
    report('a broken link opens as the plain URL does', s.clock === '20:45' && s.weather === 'Clear' && s.walk === 'false' && s.hash === '', s);
    await page.close();
  },
  async walk() {
    const page = await open('#t=9&w=clear&walk=-21.2,-20,180,-10');
    await sleep(4000);
    const s = await state(page);
    await shot(page, 'walk');
    report('a walk link opens walking there', s.walk === 'true' && s.clock === '09:00' && /&walk=-21\.2,-20,180,-10$/.test(s.hash), s);
    await page.close();
  },
  async updates() {
    const page = await open();
    await sleep(7500);
    const h0 = (await state(page)).history;
    await page.click('#times button:nth-child(1)'); // dawn
    await page.click('#weathers button:nth-child(4)'); // overcast
    await sleep(1200);
    const mid = await state(page);
    await sleep(5000);
    const s = await state(page);
    // a drag of the view: the hash follows
    await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(500, 380, { steps: 10 }); await page.mouse.up();
    await sleep(3500);
    const d = await state(page);
    report('the hash follows the scene, replacing the address', /^#t=5\.5&w=overcast&v=/.test(s.hash) && s.history === h0 && d.history === h0 && d.hash !== s.hash, { during: mid.hash, after: s.hash, dragged: d.hash, history: [h0, s.history, d.history] });
    await page.close();
  },
  async copy() {
    const page = await open('#t=14.5&w=clear&v=-30.5,4.2,10,-12,5,-3');
    await sleep(2500);
    await page.click('#btn-link');
    await sleep(400);
    const r = await page.evaluate(async () => ({ clip: await navigator.clipboard.readText(), href: location.href, toast: document.getElementById('toast').textContent, shown: document.getElementById('toast').classList.contains('show') }));
    await shot(page, 'copy');
    report('copy link', r.clip === r.href && r.toast === 'Link copied' && r.shown, r);
    await page.close();
  },
  async photo() {
    const page = await open();
    await sleep(7000);
    const vis = () => page.evaluate(() => ['.brand', '.top-right', '.side', '#photo-exit'].map((q) => getComputedStyle(document.querySelector(q)).display !== 'none'));
    const v0 = await vis();
    await page.keyboard.press('h');
    const v1 = await vis();
    await sleep(4000);
    const quiet = await page.evaluate(() => getComputedStyle(document.getElementById('photo-exit')).opacity);
    await shot(page, 'photo');
    await page.keyboard.press('h');
    const v2 = await vis();
    await page.click('#btn-photo');
    const v3 = await vis();
    await page.keyboard.press('Escape');
    const v4 = await vis();
    // touch: a tap shows the way back, which brings the controls back
    await page.click('#btn-photo');
    await sleep(4000);
    await page.touchscreen.tap(400, 400);
    await sleep(500);
    const tapped = await page.evaluate(() => getComputedStyle(document.getElementById('photo-exit')).opacity);
    await page.touchscreen.tap(...(await page.evaluate(() => { const r = document.getElementById('photo-exit').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })));
    const v5 = await vis();
    const want = (v, on) => v.slice(0, 3).every((x) => x === !on) && v[3] === on;
    report('photo mode: H, H; the button, Esc; the button, a tap, the way back', want(v0, false) && want(v1, true) && +quiet === 0 && want(v2, false) && want(v3, true) && want(v4, false) && +tapped === 1 && want(v5, false), { v0, v1, quiet, v2, v3, v4, tapped, v5 });
    await page.close();
  },
  async slider() {
    const page = await open('#t=8&w=clear&v=-30.5,4.2,10,-12,5,-3');
    await sleep(2500);
    await page.click('#times button:nth-child(3)'); // dusk, 17.85
    const p = await state(page);
    await sleep(5000);
    const before = await page.screenshot({ encoding: 'base64' });
    // dragged: the scene follows while the thumb moves, before it is let go
    const box = await page.evaluate(() => { const r = document.getElementById('t-day').getBoundingClientRect(); return [r.x, r.y + r.height / 2, r.width]; });
    const at = (h) => box[0] + 8 + (box[2] - 16) * h / 23.5;
    await page.mouse.move(at(17.85), box[1]); await page.mouse.down();
    await page.mouse.move(at(12), box[1], { steps: 8 });
    await sleep(800);
    const held = await state(page);
    const preview = await differ(page, before, await page.screenshot({ encoding: 'base64' }));
    await page.mouse.up();
    // the keys: half-hour steps
    await page.focus('#t-day'); await page.keyboard.press('ArrowRight');
    await sleep(800);
    const key = await state(page);
    report('the time slider: presets exact, a drag previewed, keys by half hours', p.slider === 17.85 && p.valuetext === '17:51' && preview > 10 && Math.abs(held.slider - 12) < 0.3 && held.clock === held.valuetext && key.slider === Math.floor(held.slider * 2 + 1e-6) / 2 + 0.5 && key.clock === key.valuetext, { preset: p, preview: +preview.toFixed(1), held, key });
    await page.close();
  },
  async reduced() {
    // the view as the scene shows against 7 s later: the same view (the scene's own motion apart) without the flight
    const page = await open('', { reduced: true });
    const still = await moved(page, 7000);
    const n = await open('');
    const flying = await moved(n, 7000);
    await n.close();
    await page.click('#times button:nth-child(2)'); // Day (14:30)
    await sleep(300);
    const s = await state(page);
    await page.click('#btn-cine');
    await sleep(300);
    const cine = await moved(page, 500);
    report('reduced motion: no opening flight, the time cut to, the cinematic flight on request', still < flying / 4 && s.clock === '14:30' && cine > 1, { still: +still.toFixed(2), flying: +flying.toFixed(2), clock: s.clock, cine: +cine.toFixed(2) });
    await page.close();
  },
  async dpr() {
    const page = await open('', { scale: 1 });
    const size = () => page.evaluate(() => { const c = document.getElementById('scene'); return [c.width, c.height, devicePixelRatio]; });
    const a = await size();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5 });
    await sleep(800);
    const b = await size();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
    await sleep(800);
    const c = await size();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await sleep(800);
    const d = await size();
    await shot(page, 'dpr');
    const fits = (s) => s[0] === Math.round(1280 * s[2]) && s[1] === Math.round(720 * s[2]);
    report('the drawing buffer follows the device pixel ratio', [a, b, c, d].every(fits), { a, b, c, d });
    await page.close();
  },
};
for (const name of only ? only.split(',') : Object.keys(CHECKS)) {
  try { await CHECKS[name](); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message.slice(0, 300)}`); }
}
console.log(errors.length ? 'page errors:\n' + [...new Set(errors)].slice(0, 20).join('\n') : 'no page errors');
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
