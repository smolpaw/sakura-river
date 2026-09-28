// Sika deer grazing on the far bank: two hinds and a young stag on their patch of cropped grass (GRAZE in
// gen/layout.js). Models: Quaternius (CC0), built into src/models/ by tools/models.mjs and inlined in the page. Each
// deer loops the head-down part of its grazing clip for a while, then plays the rest of it once (head up, a look
// round, head down again). Lit by the scene's own material so fog, shadows and the lanterns fall on them too.
import * as THREE from 'three/webgpu';
import { Fn, positionWorld, diffuseColor } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
const LENGTH = { doe: 1.3, stag: 1.4 }; // nose to tail, m (the stag is a young one: little bigger than the hinds)
// head-down stretch of each clip (s): looped `bout` times before the clip plays through its lift once
const DOWN = { doe: [1.0, 4.0], stag: [2.0, 8.0] };
const BOUT = [3, 8];
const ANTLERS = 0.35; // the young stag's antlers: short spikes
// sika coat (linear), by the models' material names: chestnut body, pale belly and rump, darker muzzle; the rest
// (hooves, eyes, antlers) keeps the model's colours
const CHESTNUT = [0.3, 0.11, 0.04], PALE = [0.62, 0.56, 0.47], MANE = [0.17, 0.075, 0.03];
const COAT = { Main: CHESTNUT, Material: CHESTNUT, Main_Light: PALE, Main_Dark: [0.11, 0.045, 0.02], 'Material.010': [0.16, 0.07, 0.03] };
// the stag's light material covers his rump and his neck: pale behind, a darker mane in front (bind space: -y is
// forward, z up)
const coat = (m, y, z) => (m.name === 'Material.003' ? (y > 0.5 && z > -0.1 ? PALE : MANE) : COAT[m.name] || m.color.toArray());

const litMaterial = (params) => new LitMaterial({ roughness: 0.9, metalness: 0, ...params },
  (out) => Fn(() => out.add(diffuseColor.rgb.mul(lanternLight(positionWorld))))());

// one draw per deer: the model's skinned parts (one per material) merged into one mesh, the coat in its vertices
function mergeSkinned(parent, material) {
  const parts = parent.children.filter((o) => o.isSkinnedMesh);
  const geos = parts.map(({ geometry: g, material: m }) => {
    const n = g.attributes.position.count, out = new THREE.BufferGeometry();
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3), J = new Uint16Array(n * 4), W = new Float32Array(n * 4);
    const { position: p, normal: nm, skinIndex: j, skinWeight: w } = g.attributes;
    for (let i = 0; i < n; i++) {
      P.set([p.getX(i), p.getY(i), p.getZ(i)], i * 3);
      N.set([nm.getX(i), nm.getY(i), nm.getZ(i)], i * 3);
      C.set(coat(m, p.getY(i), p.getZ(i)), i * 3);
      J.set([j.getX(i), j.getY(i), j.getZ(i), j.getW(i)], i * 4);
      W.set([w.getX(i), w.getY(i), w.getZ(i), w.getW(i)], i * 4);
    }
    out.setAttribute('position', new THREE.BufferAttribute(P, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    out.setAttribute('color', new THREE.BufferAttribute(C, 3));
    out.setAttribute('skinIndex', new THREE.BufferAttribute(J, 4));
    out.setAttribute('skinWeight', new THREE.BufferAttribute(W, 4));
    out.setIndex(Array.from(g.index.array));
    return out;
  });
  const mesh = new THREE.SkinnedMesh(mergeGeometries(geos), material);
  mesh.bind(parts[0].skeleton, parts[0].bindMatrix);
  for (const o of parts) parent.remove(o);
  parent.add(mesh);
}

export async function makeDeer(world, at) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const src = {}, coatMaterial = litMaterial({ vertexColors: true });
  for (const [kind, url] of [['doe', doeUrl], ['stag', stagUrl]]) {
    const gltf = await loader.loadAsync(url);
    const box = new THREE.Box3().setFromObject(gltf.scene, true);
    const body = gltf.scene.getObjectByName(kind === 'doe' ? 'Deer' : 'Stag');
    mergeSkinned(body, coatMaterial);
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
