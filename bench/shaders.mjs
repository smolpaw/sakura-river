// The shaders a tier builds, biggest first: per material and object, the generated vertex and fragment code's size.
// Big shaders are what slow drivers compile slowest (ANGLE's D3D11 path on Windows, mobile GLES drivers).
//   BENCH_HEADLESS=1 node bench/shaders.mjs <build> [--quality low] [--backend webgl] [--top 25] [--unset]
// --unset lists, per material and object, the variables the GLSL reads where none of their assignments need have run:
// a node TSL first builds inside an If keeps its variable there, and reads of it after the branch find it unset
// (CLAUDE.md TSL traps). It reads the WebGL fallback's GLSL; the WGSL comes from the same node graph.
import { parseArgs } from 'node:util';
import { startServer } from './lib/serve.mjs';
import { launch, openHarness } from './lib/browser.mjs';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  quality: { type: 'string', default: 'low' }, backend: { type: 'string', default: 'webgl' }, top: { type: 'string', default: '25' },
  unset: { type: 'boolean', default: false },
} });
const { server, url } = await startServer();
const { browser } = await launch({ scale: 1, profile: 'shaders' });
const page = await openHarness(browser, url);
// record every node build as the engine makes it (the renderer appears on the debug handle before the first compile)
await page.evaluate((keep) => {
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
        vert: (s.vertexShader || '').length, frag: (s.fragmentShader || '').length, ...(keep ? { code: [s.vertexShader || '', s.fragmentShader || ''] } : {}) });
      return s;
    };
  }, 0);
}, o.unset);
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
if (o.unset) {
  const found = new Map();
  for (const b of builds) for (const code of b.code) for (const v of unsetReads(code)) {
    const k = `${b.material} @ ${b.object}`;
    if (!found.has(k)) found.set(k, new Set());
    found.get(k).add(v);
  }
  console.log(found.size ? '\nread where they may be unset:' : '\nno variable is read where it may be unset');
  for (const [k, vs] of found) console.log(`  ${k}: ${[...vs].join(' ')}`);
}
await browser.close(); server.close();

// The variables main() reads at a point no assignment of theirs need have reached: each assignment so far lies in a
// block (an if, an else, a loop) that has closed, short of an if and its else that both assign.
function unsetReads(code) {
  const m = code.indexOf('void main()');
  if (m < 0) return [];
  const stack = [0], assigned = new Map(), partner = new Map(), out = new Set();
  let id = 0;
  const reached = (paths) => {
    if (paths.some((p) => p.every((b, i) => stack[i] === b))) return true;
    const byParent = new Map();
    for (const p of paths) if (p.length > 1) {
      const k = p.slice(0, -1).join(','), kids = byParent.get(k) || new Set();
      kids.add(p[p.length - 1]); byParent.set(k, kids);
    }
    for (const [k, kids] of byParent) {
      const par = k.split(',').map(Number);
      if (par.every((b, i) => stack[i] === b) && [...kids].some((x) => kids.has(partner.get(x)))) return true;
    }
    return false;
  };
  for (const line of code.slice(m).split('\n').slice(1)) {
    const s = line.trim(), a = /^([A-Za-z_]\w*)(\.\w+)?\s*([-+*/]?)=(?!=)/.exec(s);
    const plain = a && !a[2] && !a[3];
    const rhs = a && !/^(if|for|} else)/.test(s) ? s.slice(a[0].length) : s;
    const reads = new Set(rhs.match(/\b(nodeVar\d+|[a-z][A-Za-z]*(?:World|View)[A-Za-z]*)\b/g) || []);
    if (a && !plain) reads.add(a[1]);
    for (const v of reads) if (assigned.has(v) && !reached(assigned.get(v))) out.add(v);
    if (plain) { if (!assigned.has(a[1])) assigned.set(a[1], []); assigned.get(a[1]).push(stack.slice()); }
    if (s.startsWith('} else')) { const closed = stack.pop(); stack.push(++id); partner.set(id, closed); continue; }
    for (const ch of s) {
      if (ch === '{') stack.push(++id);
      else if (ch === '}' && stack.length > 1) stack.pop();
    }
  }
  return [...out];
}
