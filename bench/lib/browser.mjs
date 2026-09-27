// Dedicated headed Chromium (system binary, own profile) with benchmark flags.
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BENCH } from './serve.mjs';

export const CHROMIUM = process.env.BENCH_CHROMIUM || '/usr/bin/chromium';
const SOFTWARE = /SwiftShader|llvmpipe|softpipe|Software|Microsoft Basic/i;

// ANGLE backends for the WebGL2 smoke tests (constraint 8)
export const ANGLE = { default: [], gl: ['--use-angle=gl'], vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan'], swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };

export function benchFlags(scale) {
  return [
    '--disable-frame-rate-limit', '--disable-gpu-vsync',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--force-device-scale-factor=${scale}`, '--window-size=1280,800',
    '--enable-webgpu-developer-features',
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,MediaRouter', '--disable-extensions',
  ];
}

// headless: no window on the desktop (quick looks); timings need the headed default
export async function launch({ scale = 1, angle = 'default', extraArgs = [], profile = 'default', headless = !!process.env.BENCH_HEADLESS } = {}) {
  const args = [...benchFlags(scale), ...ANGLE[angle], ...(headless ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan'] : []), ...extraArgs];
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: headless ? 'new' : false,
    userDataDir: path.join(BENCH, '.profile', profile),
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null,
    protocolTimeout: 0,
  });
  const version = await browser.version();
  return { browser, args, version };
}

// all PIDs of our browser (main + children, incl. the GPU process)
export function ownPids(browser) {
  const root = browser.process().pid;
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
  const out = new Set([root]);
  const q = [root];
  while (q.length) for (const k of kids.get(q.pop()) || []) if (!out.has(k)) { out.add(k); q.push(k); }
  return out;
}

export async function openHarness(browser, url, query = '') {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warn') logs.push(`[${t}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  await page.goto(url + '/harness.html' + query, { waitUntil: 'load' });
  await page.waitForFunction('window.harnessReady === true');
  page.logs = logs;
  return page;
}

// abort unless both APIs report real hardware (unless software is explicitly allowed)
export function assertHardware(env, { allowSoftware = false, needWebGPU = false } = {}) {
  const gl = String(env.webgl || '');
  const gpu = env.webgpu && typeof env.webgpu === 'object' ? `${env.webgpu.vendor} ${env.webgpu.architecture} ${env.webgpu.description}` : String(env.webgpu);
  if (allowSoftware) return;
  if (!gl || SOFTWARE.test(gl)) throw new Error('WebGL is not on real hardware: ' + gl);
  if (needWebGPU && (!env.webgpu || SOFTWARE.test(gpu))) throw new Error('WebGPU is not on real hardware: ' + gpu);
  if (!/nvidia/i.test(gl)) throw new Error('WebGL renderer is not the NVIDIA GPU: ' + gl);
  if (needWebGPU && !/nvidia/i.test(gpu)) throw new Error('WebGPU adapter is not the NVIDIA GPU: ' + gpu);
}
