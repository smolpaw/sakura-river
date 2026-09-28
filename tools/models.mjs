// Builds src/models/ from the deer models credited in README.md (Models).
//   node tools/models.mjs
// Sources are downloaded once into tools/.model-cache/. Each file keeps only the grazing clip; everything the other
// clips used is pruned. The body's parts (one per material) get the sika coat as vertex colours, the large ones are
// simplified to bigger facets (src/deer.js shades them flat), and they are joined into one mesh. The rest is quantized and
// meshopt-compressed (small enough to inline in the page).
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { prune, dedup, joinPrimitives, weldPrimitive, simplifyPrimitive, quantize, meshopt } from '@gltf-transform/functions';
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
const FACETS = 0.35; // share of a large part's triangles kept: bigger, crisper facets

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
    p.setAttribute('NORMAL', null); // flat normals are made at load
    p.setMaterial(one);
    // the large parts to bigger facets; their edges stay put so the parts still meet, and the small ones (eyes,
    // hooves, muzzle) keep their shape
    weldPrimitive(p);
    if (p.getIndices().getCount() / 3 > 300) simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: FACETS, error: 0.02, lockBorder: true });
  }
  const body = joinPrimitives(prims); // join() leaves skinned meshes alone
  for (const p of prims) { mesh.removePrimitive(p); p.dispose(); }
  mesh.addPrimitive(body);
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
