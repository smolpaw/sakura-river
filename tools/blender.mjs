// Builds models in src/models/ with Blender and compresses them like the deer: each tools/<name>.py into
// src/models/<name>.glb (the woods' trees, the gorge's rock walls, the bamboo, the river's boulders).
//   node tools/blender.mjs [forest cliffs bamboo rocks ...]     (all by default; needs `blender` on PATH, or BLENDER=/path/to/blender)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { prune, dedup, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODELS = ['forest', 'cliffs', 'bamboo', 'rocks'];

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
for (const name of process.argv.length > 2 ? process.argv.slice(2) : MODELS) {
  const raw = path.join(ROOT, 'tools', '.model-cache', `${name}-raw.glb`), out = path.join(ROOT, 'src', 'models', `${name}.glb`);
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  execFileSync(process.env.BLENDER || 'blender', ['-b', '--factory-startup', '-P', path.join(ROOT, 'tools', `${name}.py`), '--', raw], { stdio: ['ignore', 'inherit', 'inherit'] });
  const doc = await io.read(raw);
  await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  await io.write(out, doc);
  console.log(out, fs.statSync(out).size, 'bytes');
}
