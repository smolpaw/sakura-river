// The shaders a tier builds, biggest first: per material and object, the generated vertex and fragment code's size.
// Big shaders are what slow drivers compile slowest (ANGLE's D3D11 path on Windows, mobile GLES drivers).
//   BENCH_HEADLESS=1 node bench/shaders.mjs <build> [--quality low] [--backend webgl] [--top 25]
import { parseArgs } from 'node:util';
import { startServer } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  quality: { type: 'string', default: 'low' }, backend: { type: 'string', default: 'webgl' }, top: { type: 'string', default: '25' },
} });
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'shaders' });
const page = await openHarness(browser, url);
// record every node build as the engine makes it (the renderer appears on the debug handle before the first compile)
await page.evaluate(() => {
  window.__builds = [];
  const t = setInterval(() => {
    const r = window.__sakuraDebug && window.__sakuraDebug.renderer;
    if (!r || !r._nodes) return;
    clearInterval(t);
    const N = r._nodes, make = N._createNodeBuilderState.bind(N);
    N._createNodeBuilderState = (b) => {
      const s = make(b);
      let o = b.object, name = '';
      for (; o && !name; o = o.parent) name = o.name;
      window.__builds.push({ material: (b.material && (b.material.name || b.material.type)) || '?', object: name || (b.object && b.object.type) || '?',
        vert: (s.vertexShader || '').length, frag: (s.fragmentShader || '').length });
      return s;
    };
  }, 0);
});
await page.evaluate((p) => H.setup(p), { engine: `./builds/${positionals[0]}/engine.js`, cssW: 1280, cssH: 720, quality: o.quality, backend: o.backend, extra: { debug: true } });
await page.evaluate(() => H.frames(4));
const builds = await page.evaluate(() => window.__builds);
const by = new Map();
for (const b of builds) {
  const k = `${b.material} @ ${b.object}`;
  const e = by.get(k) || { k, n: 0, vert: 0, frag: 0, total: 0 };
  e.n++; e.vert = Math.max(e.vert, b.vert); e.frag = Math.max(e.frag, b.frag); e.total += b.vert + b.frag;
  by.set(k, e);
}
const rows = [...by.values()].sort((a, b) => (b.vert + b.frag) - (a.vert + a.frag));
const kb = (n) => (n / 1024).toFixed(0).padStart(5);
console.log(`${builds.length} node builds, ${kb(builds.reduce((a, b) => a + b.vert + b.frag, 0))} KB of shader code (${o.quality}, ${o.backend})`);
console.log('  vert  frag builds  material @ object');
for (const r of rows.slice(0, +o.top)) console.log(`${kb(r.vert)} ${kb(r.frag)} ${String(r.n).padStart(6)}  ${r.k}`);
await browser.close(); server.close();
