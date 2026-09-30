// Builds src/models/forest.glb, the woods' tree kinds, with Blender (tools/forest.py) and compresses it like the deer.
//   node tools/forest.mjs        (needs `blender` on PATH, or BLENDER=/path/to/blender)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { prune, dedup, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'tools', '.model-cache', 'forest-raw.glb');
const OUT = path.join(ROOT, 'src', 'models', 'forest.glb');

fs.mkdirSync(path.dirname(RAW), { recursive: true });
execFileSync(process.env.BLENDER || 'blender', ['-b', '--factory-startup', '-P', path.join(ROOT, 'tools', 'forest.py'), '--', RAW], { stdio: ['ignore', 'inherit', 'inherit'] });
await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(RAW);
await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
await io.write(OUT, doc);
console.log(OUT, fs.statSync(OUT).size, 'bytes');
