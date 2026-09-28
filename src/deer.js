// Sika deer grazing on the far bank: two hinds and a young stag on their patch of short turf (GRAZE in
// gen/layout.js). Models: Quaternius (CC0), built into src/models/ by tools/models.mjs (coat colours in the vertices,
// simplified to bigger facets) and inlined in the page. Each deer loops the head-down part of its grazing clip for a
// while, then plays the rest of it once (head up, a look round, head down again). Lit by the scene's own material so fog, shadows and the lanterns fall on them too.
import * as THREE from 'three/webgpu';
import { Fn, positionWorld, diffuseColor } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { LitMaterial, lanternLight } from './tsl.js';
import { mulberry32 } from './noise.js';
// ?url&inline: vite does not take .glb for an asset on its own; inlined, the page stays one file
import doeUrl from './models/doe.glb?url&inline';
import stagUrl from './models/stag.glb?url&inline';

// dx, dz: metres from the grazing ground's centre; yaw: heading (0: nose along +z); scale on top of LENGTH
const HERD = [
  { kind: 'doe', dx: -1.2, dz: 1.5, yaw: 1.9, s: 1 },
  { kind: 'doe', dx: 1.4, dz: -1.8, yaw: 2.6, s: 0.95 },
  { kind: 'stag', dx: 0.6, dz: 3.8, yaw: 1.1, s: 1 },
];
const LENGTH = { doe: 1.56, stag: 1.68 }; // nose to tail, m (the stag is a young one: little bigger than the hinds)
// head-down stretch of each clip (s): looped `bout` times before the clip plays through its lift once
const DOWN = { doe: [1.0, 4.0], stag: [2.0, 8.0] };
const BOUT = [3, 8];
const ANTLERS = 0.35; // the young stag's antlers: short spikes

const litMaterial = (params) => new LitMaterial({ roughness: 0.9, metalness: 0, ...params },
  (out) => Fn(() => out.add(diffuseColor.rgb.mul(lanternLight(positionWorld))))());

export async function makeDeer(world, at) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const src = {}, coatMaterial = litMaterial({ vertexColors: true });
  for (const [kind, url] of [['doe', doeUrl], ['stag', stagUrl]]) {
    const gltf = await loader.loadAsync(url);
    const box = new THREE.Box3().setFromObject(gltf.scene, true);
    gltf.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.geometry = o.geometry.toNonIndexed(); // flat facets
      o.geometry.computeVertexNormals();
      o.material = coatMaterial;
    });
    const horns = gltf.scene.getObjectByName('Stag_Horns');
    if (horns) { horns.scale.multiplyScalar(ANTLERS); horns.material = litMaterial({ color: horns.material.color }); }
    src[kind] = { scene: gltf.scene, clip: gltf.animations[0], scale: LENGTH[kind] / (box.max.z - box.min.z) };
  }
  const group = new THREE.Group();
  group.name = 'deer';
  const rng = mulberry32(31);
  const deer = HERD.map((d) => {
    const s = src[d.kind], root = cloneSkinned(s.scene);
    const x = at[0] + d.dx, z = at[1] + d.dz;
    root.position.set(x, world.height(x, z), z);
    root.rotation.y = d.yaw;
    root.scale.setScalar(s.scale * d.s);
    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(root);
    const mixer = new THREE.AnimationMixer(root);
    const act = mixer.clipAction(s.clip).play();
    const [a, b] = DOWN[d.kind];
    act.time = a + rng() * (b - a);
    act.timeScale = 0.9 + rng() * 0.2;
    return { mixer, act, a, b, bout: BOUT[0] + Math.floor(rng() * (BOUT[1] - BOUT[0] + 1)) };
  });
  return {
    group,
    update(dt) {
      for (const d of deer) {
        const t0 = d.act.time;
        d.mixer.update(dt);
        if (t0 < d.b && d.act.time >= d.b) {
          if (d.bout > 0) { d.bout--; d.act.time -= d.b - d.a; } // keep grazing
          else d.bout = BOUT[0] + Math.floor(rng() * (BOUT[1] - BOUT[0] + 1)); // lift the head this time
        }
      }
    },
  };
}
