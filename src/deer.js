// Sika deer grazing on the far bank: two hinds and a young stag on their patch of short turf (GRAZE in
// gen/layout.js). Models: Quaternius (CC0), built into src/models/ by tools/models.mjs (coat colours in the vertices,
// subdivided to a rounder shape) and inlined in the page. Each deer loops the head-down part of its grazing clip for a
// while, then plays the rest of it once (head up, a look round, head down again), or now and then walks a few metres
// to a fresh spot on the grazing ground, turning as it goes, and grazes there. Lit by the scene's own material so
// fog, shadows and the lanterns fall on them too. The models are generic deer, reshaped to a sika's build (sika()):
// shorter legs and neck, a smaller head, smaller overall. The sika's summer coat is painted over the models' colours
// in the shader, from the bind pose (so it moves with the skin): white spots in rows along the back, a dark line down
// the spine, the white rump patch edged in black, the white tail with its black line, a paler belly and greyer lower
// legs; the sunlit ground warms the flanks and the fur's edges catch the sun.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, mix, abs, atan, floor, fract, length, pow, max, dot, normalize, attribute, positionWorld, positionGeometry, normalGeometry, normalWorld, cameraPosition, diffuseColor } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { U, LitMaterial, lanternLight, hash12, sstep } from './tsl.js';
import { groundBounce } from './materials.js';
import { mulberry32 } from './noise.js';
import { GRAZE, STRETCH } from './gen/layout.js';
// ?url&inline: vite does not take .glb for an asset on its own; inlined, the page stays one file
import doeUrl from './models/doe.glb?url&inline';
import stagUrl from './models/stag.glb?url&inline';

// dx, dz: metres from the grazing ground's centre; yaw: heading (0: nose along +z); scale on top of LENGTH
const HERD = [
  { kind: 'doe', dx: -1.2, dz: 1.5, yaw: 1.9, s: 1 },
  { kind: 'doe', dx: 1.4, dz: -1.8, yaw: 2.6, s: 0.95 },
  { kind: 'stag', dx: 0.6, dz: 3.8, yaw: 1.1, s: 1 },
];
const LENGTH = { doe: 1.5, stag: 1.65 }; // nose to tail, m (the stag is a young one: little bigger than the hinds)
// sika proportions on the models' generic deer: shorter legs (front, back: the lower legs and the back legs' thighs),
// a shorter neck, a smaller head
const SIKA = { front: 0.75, back: 0.81, neck: 0.85, head: 0.9 };
// head-down stretch of each clip (s): looped `bout` times before the clip plays through its lift once
const DOWN = { doe: [1.0, 4.0], stag: [2.0, 8.0] };
const BOUT = [3, 8];
const WALK = 0.38 * 0.85; // ground covered by the walk clip, body lengths per second (from its hooves' travel; less on sika legs)
const STROLL = 0.35; // how often a lift of the head becomes a walk instead
const ANTLERS = 0.35; // the young stag's antlers: short spikes

// the coat over the model's colours. Bind-pose coordinates (quantized, -1..1): y from the nose (-1) to the rump (+1),
// z up (hooves -0.97, the back about 0.42), x across
const coat = Fn(() => {
  const q = positionGeometry, n = normalGeometry;
  const c = attribute('color', 'vec3').mul(vec3(0.74, 0.8, 0.92)).toVar(); // a deeper chestnut than the models' orange
  const torso = sstep(-0.48, -0.36, q.y).mul(sstep(0.92, 0.8, q.y)).mul(sstep(-0.3, -0.12, q.z));
  // dark line down the spine
  c.mulAssign(mix(1.0, 0.55, sstep(0.75, 0.95, n.z).mul(sstep(0.08, 0.03, abs(q.x))).mul(torso)));
  // spots: rows of cells round the barrel from the spine (angle a) along the body, a jittered dot in most cells
  const a = atan(abs(q.x), q.z.sub(0.14));
  const g = vec2(q.y.mul(14.0), a.mul(6.5)), id = floor(g), f = fract(g).sub(0.5);
  const j = vec2(hash12(id), hash12(id.add(7.1))).sub(0.5).mul(0.45);
  const spot = sstep(0.23, 0.15, length(f.sub(j))).mul(sstep(0.3, 0.35, hash12(id.add(3.3))))
    .mul(sstep(0.28, 0.42, a)).mul(sstep(1.5, 1.15, a)).mul(torso).mul(sstep(0.78, 0.68, q.y));
  c.assign(mix(c, vec3(0.56, 0.47, 0.36), spot.mul(0.85)));
  // the rump: a white patch facing back, edged in black
  const back = sstep(0.72, 0.82, q.y).mul(sstep(-0.16, -0.04, q.z));
  const patch = sstep(0.3, 0.45, n.y).mul(back), rim = sstep(0.05, 0.25, n.y).mul(back).sub(patch).max(0.0);
  c.assign(mix(c, vec3(0.03, 0.025, 0.02), rim.mul(0.8)));
  c.assign(mix(c, vec3(0.72, 0.7, 0.64), patch));
  // the tail: white, a thin black line down its top
  const tail = sstep(0.83, 0.86, q.y).mul(sstep(0.08, 0.12, q.z)).mul(sstep(0.4, 0.36, q.z)).mul(sstep(0.08, 0.06, abs(q.x)));
  c.assign(mix(c, vec3(0.72, 0.7, 0.64), tail));
  c.assign(mix(c, vec3(0.03, 0.025, 0.02), tail.mul(sstep(0.018, 0.01, abs(q.x))).mul(sstep(-0.2, 0.2, n.y.add(n.z)))));
  // paler belly, greyer lower legs, a dark nose
  c.assign(mix(c, vec3(0.5, 0.44, 0.36), sstep(-0.35, -0.7, n.z).mul(sstep(-0.3, -0.05, q.z)).mul(0.6)));
  c.assign(mix(c, vec3(0.16, 0.12, 0.09), sstep(-0.45, -0.7, q.z).mul(0.6)));
  c.assign(mix(c, vec3(0.02, 0.018, 0.016), sstep(-0.94, -0.98, q.y)));
  return c;
})();

const litMaterial = (params) => new LitMaterial({ roughness: 0.9, metalness: 0, ...params },
  (out) => Fn(() => {
    // the fur's edges catch the sun, most against it
    const v = normalize(cameraPosition.sub(positionWorld));
    const edge = pow(float(1.0).sub(max(dot(normalWorld, v), 0.0)), 3.0);
    const against = pow(max(dot(v.negate(), U.uSunDir), 0.0), 2.0);
    const rim = U.uSunColor.mul(U.uSunVis).mul(edge).mul(against.mul(1.2).add(0.2));
    return out.add(diffuseColor.rgb.mul(lanternLight(positionWorld).add(groundBounce()).add(rim)));
  })());

// Reshapes a model to sika proportions (see SIKA) and returns how far its body must come down (in the armature's units)
// to keep the hooves on the ground. The hooves follow their own leg targets, not the leg bones, so shorter legs
// alone would end above them: the body is lowered by as much as the front legs' ends rise (the back legs are
// shortened less, to rise by the same).
function sika(scene) {
  const mesh = scene.getObjectByProperty('type', 'SkinnedMesh'), bone = (n) => scene.getObjectByName(n);
  const legs = ['FrontLowerLegL', 'FrontLowerLegR'].map((n) => mesh.skeleton.bones.findIndex((b) => b.name === n));
  const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight, p = new THREE.Vector3();
  const lowest = () => {
    scene.updateMatrixWorld(true);
    mesh.skeleton.update();
    let m = Infinity;
    for (let i = 0; i < si.count; i++) {
      let w = 0, j = -1;
      for (let c = 0; c < 4; c++) if (sw.getComponent(i, c) > w) { w = sw.getComponent(i, c); j = si.getComponent(i, c); }
      if (legs.includes(j)) m = Math.min(m, mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld).y);
    }
    return m;
  };
  const y0 = lowest();
  for (const s of ['L', 'R']) {
    bone('FrontLowerLeg' + s).position.y *= SIKA.front; bone('FrontLowerLeg' + s).scale.y = SIKA.front;
    bone('BackUpperLeg' + s).position.y *= SIKA.back; bone('BackLowerLeg' + s).position.y *= SIKA.back; bone('BackLowerLeg' + s).scale.y = SIKA.back;
  }
  for (const n of ['Neck2', 'Neck3', 'Head']) bone(n).position.y *= SIKA.neck;
  bone('Head').scale.setScalar(SIKA.head);
  return (lowest() - y0) / bone('AnimalArmature').scale.z;
}

export async function makeDeer(world, at) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const src = {}, coatMaterial = litMaterial({ colorNode: coat });
  for (const [kind, url] of [['doe', doeUrl], ['stag', stagUrl]]) {
    const gltf = await loader.loadAsync(url);
    const box = new THREE.Box3().setFromObject(gltf.scene, true);
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh) o.material = coatMaterial; });
    const horns = gltf.scene.getObjectByName('Stag_Horns');
    if (horns) { horns.scale.multiplyScalar(ANTLERS); horns.material = litMaterial({ color: horns.material.color }); }
    const clip = (name) => gltf.animations.find((c) => c.name === name);
    src[kind] = { scene: gltf.scene, eat: clip('Eating'), walk: clip('Walk'), scale: LENGTH[kind] / (box.max.z - box.min.z), drop: sika(gltf.scene) };
  }
  const group = new THREE.Group();
  group.name = 'deer';
  const rng = mulberry32(31);
  const bout = () => BOUT[0] + Math.floor(rng() * (BOUT[1] - BOUT[0] + 1));
  const deer = HERD.map((d) => {
    const s = src[d.kind], root = cloneSkinned(s.scene);
    const x = at[0] + d.dx, z = at[1] + d.dz;
    root.position.set(x, world.height(x, z), z);
    root.rotation.y = d.yaw;
    root.scale.setScalar(s.scale * d.s);
    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(root);
    const mixer = new THREE.AnimationMixer(root);
    const eat = mixer.clipAction(s.eat).play(), walk = mixer.clipAction(s.walk);
    const [a, b] = DOWN[d.kind];
    eat.time = a + rng() * (b - a);
    eat.timeScale = walk.timeScale = 0.9 + rng() * 0.2;
    return { root, body: root.getObjectByName('Body'), drop: s.drop, mixer, eat, walk, a, b, bout: bout(), to: null, speed: WALK * LENGTH[d.kind] * d.s * walk.timeScale };
  });
  // somewhere else on the grazing ground, clear of the others and of where they are heading
  const spot = (me) => {
    for (let k = 0; k < 20; k++) {
      const r = GRAZE.r * 0.8 * Math.sqrt(rng()), t = rng() * Math.PI * 2;
      const p = new THREE.Vector2(at[0] + Math.cos(t) * r, at[1] + Math.sin(t) * r * STRETCH);
      const d = p.distanceTo(new THREE.Vector2(me.root.position.x, me.root.position.z));
      if (d > 1.5 && d < 4.5 && deer.every((o) => o === me || (p.distanceTo(new THREE.Vector2(o.root.position.x, o.root.position.z)) > 2 && (!o.to || p.distanceTo(o.to) > 2)))) return p;
    }
    return null;
  };
  return {
    group,
    update(dt) {
      for (const d of deer) {
        if (d.to) {
          // walking: turn towards the spot, move with the clip's weight (so the fades in and out ease the pace)
          const p = d.root.position, dx = d.to.x - p.x, dz = d.to.y - p.z, dist = Math.hypot(dx, dz);
          let e = Math.atan2(dx, dz) - d.root.rotation.y;
          e = Math.atan2(Math.sin(e), Math.cos(e));
          d.root.rotation.y += Math.max(-1, Math.min(1, e * 2)) * 0.9 * dt;
          const v = d.speed * d.walk.getEffectiveWeight() * Math.max(0, Math.cos(e));
          p.x += Math.sin(d.root.rotation.y) * v * dt; p.z += Math.cos(d.root.rotation.y) * v * dt;
          p.y = world.height(p.x, p.z);
          if (dist < 0.3) {
            // there: head down and graze again
            d.to = null;
            d.eat.reset().play();
            d.eat.crossFadeFrom(d.walk, 0.8, false);
            d.bout = bout();
          }
          d.mixer.update(dt);
          d.body.position.z -= d.drop;
          continue;
        }
        const t0 = d.eat.time;
        d.mixer.update(dt);
        d.body.position.z -= d.drop; // keyed in both clips, so set afresh each update
        if (t0 < d.b && d.eat.time >= d.b) {
          if (d.bout > 0) { d.bout--; d.eat.time -= d.b - d.a; } // keep grazing
          else if (rng() < STROLL && (d.to = spot(d))) { d.walk.reset().play(); d.walk.crossFadeFrom(d.eat, 0.8, false); } // move on
          else d.bout = bout(); // lift the head this time
        }
      }
    },
  };
}
