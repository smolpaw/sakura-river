// The traveller: the figure the first-person walk is played as, and who stands where he was left when the camera
// orbits. Model: tools/human.py (Blender, `node tools/blender.mjs human`), public/models/human.glb, fetched when the
// walk first needs him (not inlined: the page stays small). Three meshes on one skeleton: `human` (the body below the
// chest), `human_head` (head, hat, shoulders: hidden from the eye in first person, still casting the sun's shadow and
// showing in the river) and `human_far` (beyond FAR m). Clips in place: idle, walk (1.4 m/s) and hurry (2.6 m/s),
// each one stride from the left heel's strike; the walk and the hurry are played in step, on one phase, blended by
// the speed and run at the rate that carries the feet back at the ground's speed, so they don't slide.
// Lit by the scene's own material, as the deer are: the sun and its shadows, fog, the lamps' light, the ground's
// bounce. The kimono's kasuri (well-curb crosses, their dye ragged along the weft) and the obi's stripes are drawn
// here from the bind pose (so they move with the cloth); the vertex colours carry the base colours and the baked
// occlusion, their alpha which pattern goes where (1 kasuri, 0.5 obi, 0 none).
// First person: `eye` is where the eyes are, and the robe's front is ahead of them, so a camera there looking down
// sees the chest, the obi, the sleeves and the swinging hands; a quarter metre ahead of it (along the facing, main.js
// EYE_AHEAD), looking down past 80 degrees, it sees the hem and the geta stepping out as well. The hidden part is cut level at the chest (tools/human.py Z_CUT), closed by
// a solid inside the robe so the view down never looks into it.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, mix, abs, floor, fract, max, pow, dot, normalize, length, uniform, attribute, positionGeometry, normalGeometry, positionWorld, normalWorld, cameraPosition, diffuseColor } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { U, LitMaterial, lanternLight, hash12, vnoise, sstep } from './tsl.js';
import { groundBounce } from './materials.js';

// The head and what the first-person view hides go on this layer while it is on: the main camera (layers 0, 1)
// doesn't render it, the sun's shadow camera (0, 2) and the river's reflection (0) are given it in loadWalker.
export const HEAD_LAYER = 4;
const EYE = new THREE.Vector3(0, 1.553, 0.081); // between the eyes in the model (tools/human.py EYE, in glTF's axes)
const FAR = 40; // m: the lighter model beyond
const WALK = 1.4, HURRY = 2.6; // the clips' speeds (m/s)

// the cloth's patterns over the vertex colours, from the bind pose in metres (`at`: the mesh's quantized positions
// back to metres, set per mesh in loadWalker)
function clothColor(at) {
  return Fn(() => {
    const c4 = attribute('color', 'vec4');
    const c = c4.rgb.toVar();
    const q = positionGeometry.mul(at.scale).add(at.offset);
    const n = normalGeometry;
    const dist = length(cameraPosition.sub(positionWorld));
    // the weave's plane: the front and back on (x, y), the sides on (z, y)
    const side = sstep(0.55, 0.8, abs(n.x));
    const u = mix(q.x, q.z, side), v = q.y;
    // kasuri: a small well-curb cross (igeta) in each 5 cm cell, the rows half a cell apart; the dye's edges ragged
    // thread by thread along the weft, each cross a little paler or darker
    const kas = sstep(0.75, 0.9, c4.a);
    const row = floor(v.div(0.05));
    const g = vec2(u.div(0.05).add(row.mul(0.5)), v.div(0.05));
    const id = floor(g), f = fract(g).sub(0.5);
    const fx = f.x.add(hash12(vec2(floor(v.mul(700.0)), id.x)).sub(0.5).mul(0.07));
    const vb = sstep(0.045, 0.028, abs(abs(fx).sub(0.1))).mul(sstep(0.26, 0.21, abs(f.y)));
    const hb = sstep(0.045, 0.028, abs(abs(f.y).sub(0.1))).mul(sstep(0.26, 0.21, abs(fx)));
    const motif = max(vb, hb).mul(hash12(id).mul(0.35).add(0.65));
    // far off the crosses blur into the cloth's tone
    const m = mix(motif, 0.06, sstep(14.0, 32.0, dist)).mul(kas);
    c.assign(mix(c, c.mul(vec3(5.5, 4.6, 2.8)), m.mul(0.6)));
    // the obi: hakata stripes along it (it sits lower at the front), a dotted line down its middle
    const obi = sstep(0.3, 0.42, c4.a).mul(sstep(0.7, 0.58, c4.a));
    const s = q.y.sub(sstep(-0.12, 0.12, q.z.negate()).mul(0.05).add(0.94));
    const lines = sstep(0.0032, 0.0018, abs(abs(s).sub(0.03))).add(sstep(0.0035, 0.002, abs(s)).mul(sstep(0.5, 0.45, fract(u.mul(28.0)))));
    c.assign(mix(c, c.mul(vec3(2.6, 2.1, 1.5)), lines.min(1.0).mul(obi).mul(sstep(25.0, 10.0, dist))));
    // the yarn: faint streaks along the weft, close by
    const slub = vnoise(vec2(u.mul(30.0), v.mul(380.0))).sub(0.5).mul(0.14).mul(sstep(8.0, 3.0, dist)).mul(kas.add(obi));
    return c.mul(slub.add(1.0));
  })();
}

function walkerMaterial(at) {
  return new LitMaterial({ roughness: 0.85, metalness: 0, colorNode: clothColor(at) }, (out) => Fn(() => {
    // soft edges catch the sun against it (cloth and skin, less than the deer's fur)
    const v = normalize(cameraPosition.sub(positionWorld));
    const edge = pow(float(1.0).sub(max(dot(normalWorld, v), 0.0)), 3.0);
    const against = pow(max(dot(v.negate(), U.uSunDir), 0.0), 2.0);
    const rim = U.uSunColor.mul(U.uSunVis).mul(edge).mul(against.mul(0.7).add(0.1));
    return out.add(diffuseColor.rgb.mul(lanternLight(positionWorld).add(groundBounce()).add(rim)));
  })());
}

// Loads the traveller. ctx (all optional):
//   url: the model's URL (default: models/human.glb beside the page, as GitHub Pages serves public/)
//   sun: the scene's DirectionalLight, its shadow camera given HEAD_LAYER (the hidden head still casts)
//   reflector: the river's ReflectorNode (water.reflector.reflector in main.js) with camera, the view's camera:
//     the reflection's camera is given HEAD_LAYER (the hidden head still shows in the river)
//   camera: with it, update() picks the full or the far model by its distance (else call setLevel)
// Resolves to { group, setPose, setMotion, update, eye, onStep, setFirstPerson, setLevel, dispose }.
export async function loadWalker(ctx = {}) {
  const url = ctx.url || new URL('models/human.glb', document.baseURI).href;
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const meshes = {};
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    meshes[o.name] = o;
    o.castShadow = true;
    o.receiveShadow = true;
    // the positions are quantized (meshopt): back to metres in the bind pose for the patterns
    o.skeleton.update();
    const q = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
    const w = new THREE.Box3().setFromObject(o, true);
    const scale = (w.max.y - w.min.y) / (q.max.y - q.min.y);
    const at = { scale: uniform(scale), offset: uniform(w.min.clone().sub(q.min.clone().multiplyScalar(scale))) };
    o.material = walkerMaterial(at);
    // in place, the clips reach a little beyond the bind pose (a stride's feet, the hurry's lean)
    o.computeBoundingSphere();
    o.boundingSphere.radius += 0.45;
  });
  const near = [meshes.human, meshes.human_head], far = meshes.human_far;
  const head = meshes.human_head;
  if (ctx.sun) ctx.sun.shadow.camera.layers.enable(HEAD_LAYER);
  if (ctx.reflector && ctx.camera) ctx.reflector.getVirtualCamera(ctx.camera).layers.enable(HEAD_LAYER);

  const group = new THREE.Group();
  group.name = 'walker';
  group.add(root);
  const headBone = root.getObjectByName('head');
  const eyeLocal = headBone.worldToLocal(EYE.clone());

  const mixer = new THREE.AnimationMixer(root);
  const clip = (n) => gltf.animations.find((a) => a.name === n);
  const A = {};
  for (const n of ['idle', 'walk', 'hurry']) {
    A[n] = mixer.clipAction(clip(n));
    A[n].timeScale = 0; // times are set here each frame
    A[n].play();
  }
  const stride = { walk: WALK * clip('walk').duration, hurry: HURRY * clip('hurry').duration }; // m per cycle
  let target = 0, speed = 0, phase = 0, idleT = 0, firstPerson = false, level = 0;
  const steps = [];
  const eye = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const setLevel = (d) => {
    const l = firstPerson || d <= FAR ? 0 : 1;
    if (l === level) return;
    level = l;
    for (const m of near) m.visible = l === 0;
    far.visible = l === 1;
  };
  far.visible = false;
  level = 0;

  const handle = {
    group,
    eye,
    setPose(x, y, z, yaw) {
      group.position.set(x, y, z);
      group.rotation.y = yaw;
    },
    setMotion(s) { target = Math.max(0, s); },
    onStep(cb) { steps.push(cb); },
    setFirstPerson(on) {
      firstPerson = !!on;
      if (firstPerson) head.layers.set(HEAD_LAYER); else head.layers.set(0);
      if (firstPerson) setLevel(0);
    },
    setLevel,
    update(dt) {
      if (ctx.camera && !firstPerson) setLevel(ctx.camera.position.distanceTo(group.position));
      // a little smoothing, so a sudden stop or start doesn't snap the pose
      speed += (target - speed) * Math.min(1, dt * 10);
      if (speed < 1e-3) speed = 0;
      const go = Math.min(1, speed / 0.5); // into the walk from a standstill
      const h = THREE.MathUtils.clamp((speed - WALK) / (HURRY - WALK), 0, 1);
      // one stride per cycle: as far as the blended clips' feet travel
      const len = THREE.MathUtils.lerp(stride.walk, stride.hurry, h);
      const p0 = phase;
      phase = (phase + (dt * Math.max(speed, 0.0)) / len) % 1;
      if (go > 0.3 && dt > 0) {
        if (phase < p0) for (const cb of steps) cb({ foot: 'left' }); // past 0: the left heel down
        else if (p0 < 0.5 && phase >= 0.5) for (const cb of steps) cb({ foot: 'right' });
      }
      idleT = (idleT + dt) % A.idle.getClip().duration;
      A.idle.time = idleT;
      A.walk.time = phase * A.walk.getClip().duration;
      A.hurry.time = phase * A.hurry.getClip().duration;
      A.idle.setEffectiveWeight(1 - go);
      A.walk.setEffectiveWeight(go * (1 - h));
      A.hurry.setEffectiveWeight(go * h);
      mixer.update(0);
      group.updateMatrixWorld(true);
      eye.copy(headBone.localToWorld(tmp.copy(eyeLocal)));
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      group.removeFromParent();
      for (const m of Object.values(meshes)) { m.geometry.dispose(); m.material.dispose(); }
    },
  };
  handle.update(0);
  return handle;
}
