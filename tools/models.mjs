// Builds src/models/ from the deer models credited in README.md (Models).
//   node tools/models.mjs
// Sources are downloaded once into tools/.model-cache/. Each file keeps only the grazing clip; everything the other
// clips used is pruned. The body's parts (one per material) get the sika coat as vertex colours and are joined into
// one mesh, which is subdivided (a rounder shape) and simplified back to DETAIL times the source's triangles. The rest is quantized and
// meshopt-compressed (small enough to inline in the page).
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { prune, dedup, joinPrimitives, simplifyPrimitive, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'tools', '.model-cache');
const OUT = path.join(ROOT, 'src', 'models');

// Quaternius, Ultimate Animated Animal Pack (CC0), as served by Poly Pizza
const SRC = {
  doe: 'https://static.poly.pizza/4b6c2a41-43c7-404c-ae37-e8c4645ff93b.glb',
  stag: 'https://static.poly.pizza/a9c69fbc-bf7c-4585-9a49-a82e0be1ac6b.glb',
};
const KEEP = 'Eating';
const DETAIL = 2; // the body's triangles against the source's: subdivided four times over, then simplified back to this

// sika coat (linear), by the models' material names: chestnut body, pale belly and rump, darker muzzle; the rest
// (hooves, eyes) keeps the model's colours. The stag's light material covers his rump and his neck: pale behind, a
// darker mane in front (y, z: position in the body's box, -1..1; -y is forward, z up).
const CHESTNUT = [0.3, 0.11, 0.04], PALE = [0.62, 0.56, 0.47], MANE = [0.17, 0.075, 0.03];
const COAT = { Main: CHESTNUT, Material: CHESTNUT, Main_Light: PALE, Main_Dark: [0.11, 0.045, 0.02], 'Material.010': [0.16, 0.07, 0.03] };
const coat = (name, base, y, z) => (name === 'Material.003' ? (y > 0.5 && z > -0.1 ? PALE : MANE) : COAT[name] || base);

function bakeCoat(doc, mesh) {
  const prims = mesh.listPrimitives(), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], v = [];
  for (const p of prims) for (let i = 0, a = p.getAttribute('POSITION'); i < a.getCount(); i++) { a.getElement(i, v); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); } }
  const box = (k) => 2 * (v[k] - lo[k]) / (hi[k] - lo[k]) - 1;
  const one = doc.createMaterial('Coat').setRoughnessFactor(0.9).setMetallicFactor(0);
  for (const p of prims) {
    const m = p.getMaterial(), name = m.getName(), base = m.getBaseColorFactor().slice(0, 3), pos = p.getAttribute('POSITION');
    const c = new Float32Array(pos.getCount() * 3);
    for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, v); c.set(coat(name, base, box(1), box(2)), i * 3); }
    p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(c).setBuffer(pos.getBuffer()));
    p.setAttribute('NORMAL', null);
    p.setMaterial(one);
  }
  const joined = joinPrimitives(prims); // join() leaves skinned meshes alone
  for (const p of prims) { mesh.removePrimitive(p); p.dispose(); }
  const body = refine(doc, joined);
  joined.dispose();
  simplifyPrimitive(body, { simplifier: MeshoptSimplifier, ratio: DETAIL / 4, error: 0.01 });
  mesh.addPrimitive(body);
}

// One step of Loop subdivision over the welded body (a rounder shape, four triangles for each), skin weights mixed like
// the positions (top four kept); each new triangle keeps its parent's colour. Smooth normals.
function refine(doc, prim) {
  const P = prim.getAttribute('POSITION'), C = prim.getAttribute('COLOR_0'), J = prim.getAttribute('JOINTS_0'), W = prim.getAttribute('WEIGHTS_0');
  const idx = prim.getIndices().getArray();
  const ids = new Map(), pts = [], at = [];
  for (let i = 0; i < P.getCount(); i++) {
    const p = P.getElement(i, []), k = p.join();
    if (!ids.has(k)) {
      const j = J.getElement(i, []), w = W.getElement(i, []), s = new Map();
      j.forEach((b, q) => { if (w[q] > 0) s.set(b, (s.get(b) || 0) + w[q]); });
      ids.set(k, pts.length); pts.push({ p, s });
    }
    at.push(ids.get(k));
  }
  const faces = [];
  for (let t = 0; t < idx.length; t += 3) {
    const v = [at[idx[t]], at[idx[t + 1]], at[idx[t + 2]]];
    if (v[0] !== v[1] && v[1] !== v[2] && v[0] !== v[2]) faces.push({ v, c: C.getElement(idx[t], []) });
  }
  const mix = (terms) => {
    const p = [0, 0, 0], s = new Map();
    for (const [q, w] of terms) { for (let k = 0; k < 3; k++) p[k] += q.p[k] * w; for (const [b, x] of q.s) s.set(b, (s.get(b) || 0) + x * w); }
    return { p, s };
  };
  const edges = new Map(), key = (a, b) => (a < b ? a + ',' + b : b + ',' + a);
  for (const { v } of faces) for (let e = 0; e < 3; e++) {
    const k = key(v[e], v[(e + 1) % 3]);
    if (!edges.has(k)) edges.set(k, { a: v[e], b: v[(e + 1) % 3], opp: [] });
    edges.get(k).opp.push(v[(e + 2) % 3]);
  }
  // the old points move towards their neighbours (open edges: along the edge only)
  const ring = pts.map(() => ({ all: new Set(), open: new Set() }));
  for (const { a, b, opp } of edges.values()) {
    ring[a].all.add(b); ring[b].all.add(a);
    if (opp.length !== 2) { ring[a].open.add(b); ring[b].open.add(a); }
  }
  const out = pts.map((q, i) => {
    const { all, open } = ring[i];
    if (open.size === 2) return mix([[q, 0.75], ...[...open].map((n) => [pts[n], 0.125])]);
    if (open.size || all.size < 3) return q;
    const n = all.size, beta = n === 3 ? 3 / 16 : 3 / (8 * n);
    return mix([[q, 1 - n * beta], ...[...all].map((m) => [pts[m], beta])]);
  });
  for (const e of edges.values()) {
    e.id = out.length;
    out.push(e.opp.length === 2
      ? mix([[pts[e.a], 3 / 8], [pts[e.b], 3 / 8], [pts[e.opp[0]], 1 / 8], [pts[e.opp[1]], 1 / 8]])
      : mix([[pts[e.a], 0.5], [pts[e.b], 0.5]]));
  }
  const tris = [];
  for (const { v: [a, b, c], c: col } of faces) {
    const ab = edges.get(key(a, b)).id, bc = edges.get(key(b, c)).id, ca = edges.get(key(c, a)).id;
    tris.push([a, ab, ca, col], [ab, b, bc, col], [ca, bc, c, col], [ab, bc, ca, col]);
  }
  // smooth normals per point, then one vertex per point and colour (colour edges stay sharp)
  const nrm = out.map(() => [0, 0, 0]);
  for (const [a, b, c] of tris) {
    const [pa, pb, pc] = [out[a].p, out[b].p, out[c].p];
    const u = pb.map((x, k) => x - pa[k]), w = pc.map((x, k) => x - pa[k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) nrm[i][k] += n[k];
  }
  const verts = new Map(), POS = [], NOR = [], COL = [], JNT = [], WGT = [], IDX = [];
  for (const [a, b, c, col] of tris) for (const i of [a, b, c]) {
    const k = i + ':' + col.join();
    if (!verts.has(k)) {
      verts.set(k, POS.length / 3);
      const n = nrm[i], l = Math.hypot(...n) || 1, top = [...out[i].s].sort((x, y) => y[1] - x[1]).slice(0, 4);
      const sum = top.reduce((t, x) => t + x[1], 0);
      while (top.length < 4) top.push([0, 0]);
      POS.push(...out[i].p); NOR.push(n[0] / l, n[1] / l, n[2] / l); COL.push(...col);
      JNT.push(...top.map((x) => x[0])); WGT.push(...top.map((x) => x[1] / sum));
    }
    IDX.push(verts.get(k));
  }
  const buf = P.getBuffer(), acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
  return doc.createPrimitive().setMaterial(prim.getMaterial())
    .setAttribute('POSITION', acc('VEC3', new Float32Array(POS))).setAttribute('NORMAL', acc('VEC3', new Float32Array(NOR)))
    .setAttribute('COLOR_0', acc('VEC3', new Float32Array(COL))).setAttribute('JOINTS_0', acc('VEC4', new Uint16Array(JNT)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array(WGT))).setIndices(acc('SCALAR', new Uint32Array(IDX)));
}

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
for (const [name, url] of Object.entries(SRC)) {
  const cached = path.join(CACHE, `${name}.glb`);
  if (!fs.existsSync(cached)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
  }
  const doc = await io.read(cached);
  for (const a of doc.getRoot().listAnimations()) {
    if (a.getName() === KEEP) continue;
    for (const s of a.listSamplers()) s.dispose(); // their accessors go in prune() unless the kept clip shares them
    a.dispose();
  }
  for (const node of doc.getRoot().listNodes()) if (node.getSkin() && node.getMesh()) bakeCoat(doc, node.getMesh());
  await doc.transform(
    dedup(), prune(), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  );
  const out = path.join(OUT, `${name}.glb`);
  await io.write(out, doc);
  console.log(out, fs.statSync(out).size, 'bytes');
}
