// Builds src/models/ from the deer models credited in README.md (Models).
//   node tools/models.mjs
// Sources are downloaded once into tools/.model-cache/. Each file keeps only the grazing clip; everything the other
// clips used is pruned, and the rest is quantized and meshopt-compressed (small enough to inline in the page).
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { prune, dedup, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'tools', '.model-cache');
const OUT = path.join(ROOT, 'src', 'models');

// Quaternius, Ultimate Animated Animal Pack (CC0), as served by Poly Pizza
const SRC = {
  doe: 'https://static.poly.pizza/4b6c2a41-43c7-404c-ae37-e8c4645ff93b.glb',
  stag: 'https://static.poly.pizza/a9c69fbc-bf7c-4585-9a49-a82e0be1ac6b.glb',
};
const KEEP = 'Eating';

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
await MeshoptEncoder.ready;
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
  await doc.transform(dedup(), prune(), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  const out = path.join(OUT, `${name}.glb`);
  await io.write(out, doc);
  console.log(out, fs.statSync(out).size, 'bytes');
}
