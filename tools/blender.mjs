// Builds models in src/models/ with Blender and compresses them like the deer: each tools/<name>.py into
// src/models/<name>.glb (the woods' trees, the gorge's rock walls, the bamboo, the river's boulders, the cherries'
// trunks, the village's buildings, the shrubs, the riverside's lamps). A model built from the scene's own data gets it from tools/<name>.mjs, as a JSON file after the output.
// The Ultra tier's near models (meshes named `<kind>_near`) go to public/models/<name>-ultra.glb instead: fetched on
// demand (lods.js ultraUrl), not inlined in the page.
//   node tools/blender.mjs [forest cliffs bamboo rocks ...]     (all by default; needs `blender` on PATH, or BLENDER=/path/to/blender)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { prune, dedup, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODELS = ['forest', 'cliffs', 'bamboo', 'rocks', 'cherry', 'village', 'shrubs', 'lamps'];
// where a model's meshes go: [file, which meshes (by node name)]; a file no mesh goes to is not written
const targets = (name) => [
  [path.join(ROOT, 'src', 'models', `${name}.glb`), (n) => !n.endsWith('_near')],
  [path.join(ROOT, 'public', 'models', `${name}-ultra.glb`), (n) => n.endsWith('_near')],
];

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
for (const name of process.argv.length > 2 ? process.argv.slice(2) : MODELS) {
  const raw = path.join(ROOT, 'tools', '.model-cache', `${name}-raw.glb`);
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  const args = ['-b', '--factory-startup', '-P', path.join(ROOT, 'tools', `${name}.py`), '--', raw];
  const prep = path.join(ROOT, 'tools', `${name}.mjs`);
  if (fs.existsSync(prep)) {
    const data = path.join(path.dirname(raw), `${name}.json`);
    fs.writeFileSync(data, JSON.stringify((await import(prep)).default()));
    args.push(data);
  }
  execFileSync(process.env.BLENDER || 'blender', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  for (const [out, keep] of targets(name)) {
    const doc = await io.read(raw);
    const nodes = doc.getRoot().listNodes();
    if (!nodes.some((n) => keep(n.getName()))) continue;
    for (const n of nodes) if (!keep(n.getName())) n.dispose();
    await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await io.write(out, doc);
    console.log(out, fs.statSync(out).size, 'bytes');
  }
}
