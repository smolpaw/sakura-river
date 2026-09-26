// Delivery check: open dist/index.html from disk, wait for the scene, report backend/errors and save a screenshot.
//   node bench/check-dist.mjs [angle] [out.png]
import path from 'node:path';
import { launch } from './lib/browser.mjs';
import { BENCH } from './lib/serve.mjs';
const [angle = 'default', out = 'out/dist-check.png'] = process.argv.slice(2);
const { browser } = await launch({ scale: 1, angle, profile: 'dist', extraArgs: ['--allow-file-access-from-files'] });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
await page.setViewport({ width: 1280, height: 720 });
const t0 = Date.now();
await page.goto('file://' + path.resolve(BENCH, '../dist/index.html'));
await page.waitForFunction(() => document.getElementById('veil').classList.contains('done') || /could not/.test(document.getElementById('veil-text').textContent), { timeout: 60000 });
const ready = Date.now() - t0;
await new Promise((r) => setTimeout(r, 4000));
const state = await page.evaluate(() => ({ veil: document.getElementById('veil-text').textContent, stats: document.getElementById('stats').textContent, gpu: !!navigator.gpu }));
await page.screenshot({ path: path.join(BENCH, out) });
console.log(JSON.stringify({ angle, readyMs: ready, ...state }));
console.log(logs.filter((l) => !/DevTools|GPU stall/.test(l)).slice(0, 10).join('\n'));
await browser.close();
