// Wading birds: a grey heron (aosagi) standing in the shallows at the river's edge on the east bank, upstream of the
// cherry tree across the water, and two little egrets (kosagi) in a flooded paddy by the valley lane. Model:
// tools/heron.py (Blender, `node tools/blender.mjs heron`), src/models/heron.glb, inlined: the heron and the egret
// (each with a lighter model beyond FAR m) on one skeleton, with three clips that begin and end in the rest pose:
// idle (a 10 s loop: breathing, the neck swaying, the head turning to look about), stalk (the neck reaches forward
// and down, one slow step with each foot, a freeze) and preen (the bill down into the breast's plumes). Each bird
// plays its idle and every 15–40 s a stalk or a preen, faded in and out on its mixer; after a stalk it stands where
// the step took it. Over minutes each turns slowly to face another way: the heron between upstream, the river and
// downstream (never the bank), the egrets any way. The heron's feet stand on the river bed DEPTH m under the water,
// and it steps only where the water stays between ankle and shin deep and within RANGE m of where it began (koi.js
// keeps the koi off that stretch, heronClearings); the egrets wade inside their paddy, the feet just under its
// water. The egrets leave for their roost in the evening and come back in the morning. Lit by the scene's own
// material, as the deer are (the sun's shadows, fog, the lamps' light, the ground's bounce); both cast shadows.
// The heron's marks are drawn over its vertex colours from the bind pose: the black stripe from the eye back to the
// crest, the yellow eye, the streaks down the neck's front. The heron's legs leave a wake in the current and each
// step of its stalk sends out rings (touches.js: `wakes`, `splashes`).
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, mix, abs, fract, length, max, pow, dot, normalize, uniform, attribute, positionGeometry, normalGeometry, positionWorld, normalWorld, cameraPosition, diffuseColor } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { U, LitMaterial, lanternLight, sstep } from './tsl.js';
import { groundBounce } from './materials.js';
import { mulberry32 } from './noise.js';
// ?url&inline: vite does not take .glb for an asset on its own; inlined, the page stays one file
import heronUrl from './models/heron.glb?url&inline';

const STALK = 0.17; // the stalk clip's step forward, m (tools/heron.py STALK)
const DEPTH = 0.15; // the water over the heron's feet where it starts, m
const WADE = [0.08, 0.24]; // the depths it steps into
const HOME_Z = -4.5; // the heron's stretch of bank (z), across the river from the cherry tree
const RANGE = 2.5; // how far along it the heron and the egrets wander, m
const EGRET = 0.63; // the egrets' size against the model (about 0.6 m standing)
const PADDY = [-67, -90.5]; // the egrets' paddy, by the valley lane
const FAR = { heron: 30, egret: 18 }; // m: the lighter models beyond
const ROOST = [5.3, 18.7]; // the clock hours the egrets are in their paddy
const PAUSE = [15, 40]; // s of idling between a stalk or a preen
const FOOT_X = 0.032; // tools/heron.py FOOT: each foot this far to its side of the middle
const STEPS = [[-1, 0.9, 2.5], [1, 2.6, 4.2]]; // tools/heron.py stalk_pose: each foot's step (side, lifted, set down, s)

const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const fromRiver = (yaw) => wrap(yaw + Math.PI / 2); // a heading against facing the river from the east bank (0)

// x of the river's east edge at z where the water is `depth` deep
function shallow(world, z, depth = DEPTH) {
  const rx = world.riverX(z), hw = world.riverHW(z);
  for (let x = rx + hw * 0.6; x < rx + hw * 1.5; x += 0.02) if (world.height(x, z) > -depth) return x; // (deep below 0.6)
  return rx + hw;
}

// where the koi keep away from: the heron's stretch of shallows
export function heronClearings(world) {
  const out = [];
  for (let dz = -RANGE - 0.5; dz <= RANGE + 0.5; dz += 1) out.push({ x: shallow(world, HOME_Z + dz), z: HOME_Z + dz, r: 0.7 });
  return out;
}

// wet paddy (well inside it, off the levees) at (x, z): its water level, or null
function paddyWater(world, x, z, margin = 0.8) {
  const F = world.heightField(x, z).F;
  return F && F.wet && F.inside && !F.village && F.q > margin ? F.y : null;
}

// the heron's marks over its vertex colours, from the bind pose in metres (glTF axes: y up, facing +z)
function heronColor(at) {
  return Fn(() => {
    const c4 = attribute('color', 'vec4');
    const c = c4.rgb.toVar();
    const p = positionGeometry.mul(at.scale).add(at.offset);
    const plumage = sstep(0.5, 0.6, c4.a);
    const ax = abs(p.x), ey = p.y.sub(0.912), ez = p.z.sub(0.163);
    // the black stripe from over the eye back to the crest, either side of the white crown
    const stripe = sstep(0.0055, 0.0085, ax).mul(sstep(0.006, 0.002, ez)).mul(sstep(-0.05, -0.04, ez))
      .mul(sstep(-0.004, -0.001, ey.add(ez.mul(0.08)))).mul(sstep(0.013, 0.01, ey));
    const nape = sstep(0.128, 0.122, p.z).mul(sstep(0.893, 0.9, p.y)).mul(sstep(0.11, 0.115, p.z));
    c.assign(mix(c, vec3(0.012, 0.012, 0.014), max(stripe, nape).mul(plumage)));
    // the eye: yellow round a black pupil
    const d = length(vec2(ey, ez)), side = sstep(0.011, 0.014, ax).mul(plumage);
    c.assign(mix(c, vec3(0.62, 0.48, 0.06), sstep(0.0042, 0.0034, d).mul(side)));
    c.assign(mix(c, vec3(0.01, 0.01, 0.01), sstep(0.0021, 0.0015, d).mul(side)));
    // the neck's front: two rows of black dashes down the white
    const front = sstep(0.35, 0.6, normalGeometry.z).mul(sstep(0.66, 0.69, p.y)).mul(sstep(0.86, 0.83, p.y)).mul(plumage);
    const dash = sstep(0.25, 0.35, fract(p.y.mul(48.0))).mul(sstep(0.92, 0.82, fract(p.y.mul(48.0))));
    const rows = sstep(0.0027, 0.0015, abs(ax.sub(0.0042)));
    c.assign(mix(c, vec3(0.03, 0.03, 0.035), rows.mul(dash).mul(front).mul(0.85)));
    return c;
  })();
}

const birdMaterial = (colorNode) => new LitMaterial({ roughness: 0.85, metalness: 0, colorNode }, (out) => Fn(() => {
  // the feathers' edges catch the sun, most against it
  const v = normalize(cameraPosition.sub(positionWorld));
  const edge = pow(float(1.0).sub(max(dot(normalWorld, v), 0.0)), 3.0);
  const against = pow(max(dot(v.negate(), U.uSunDir), 0.0), 2.0);
  const rim = U.uSunColor.mul(U.uSunVis).mul(edge).mul(against.mul(0.9).add(0.12));
  return out.add(diffuseColor.rgb.mul(lanternLight(positionWorld).add(groundBounce()).add(rim)));
})());

export async function makeHerons(world) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(heronUrl);
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  const mats = {}, spheres = {};
  src.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    // the clips reach beyond the bind pose (the stalk's step, the preen's bend)
    o.skeleton.update();
    o.computeBoundingSphere();
    spheres[o.name] = o.boundingSphere.clone();
    spheres[o.name].radius += 0.3;
    const kind = o.name.startsWith('egret') ? 'egret' : 'heron';
    if (!mats[kind]) {
      if (kind === 'heron') {
        // the positions are quantized (meshopt): back to metres in the bind pose for the marks (the far model's
        // box is the same bird's)
        const q = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
        const w = new THREE.Box3().setFromObject(o, true);
        const scale = (w.max.y - w.min.y) / (q.max.y - q.min.y);
        mats.heron = birdMaterial(heronColor({ scale: uniform(scale), offset: uniform(w.min.clone().sub(q.min.clone().multiplyScalar(scale))) }));
      } else mats.egret = birdMaterial(attribute('color', 'vec4').rgb);
    }
  });
  const clip = (n) => gltf.animations.find((a) => a.name === n);
  const rng = mulberry32(53);
  const group = new THREE.Group();
  group.name = 'herons';

  const make = (kind, x, y, z, yaw, scale) => {
    const root = cloneSkinned(src);
    const drop = [];
    let near = null, far = null;
    root.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      if (!o.name.startsWith(kind)) { drop.push(o); return; }
      o.material = mats[kind];
      o.castShadow = o.receiveShadow = true;
      o.boundingSphere = spheres[o.name].clone();
      if (o.name.endsWith('_far')) far = o; else near = o;
    });
    for (const o of drop) o.removeFromParent();
    far.visible = false;
    root.position.set(x, y, z);
    root.rotation.y = yaw;
    root.scale.setScalar(scale);
    group.add(root);
    const mixer = new THREE.AnimationMixer(root);
    const A = {};
    for (const n of ['idle', 'stalk', 'preen']) {
      A[n] = mixer.clipAction(clip(n));
      if (n !== 'idle') { A[n].setLoop(THREE.LoopOnce, 1); A[n].clampWhenFinished = true; }
    }
    A.idle.timeScale = 0.9 + rng() * 0.2;
    A.idle.play();
    A.idle.time = rng() * clip('idle').duration;
    return { kind, root, near, far, mixer, A, scale, act: null, next: PAUSE[0] * rng() + 4, yaw, yawTo: yaw, turn: 20 + rng() * 40, home: { x, z } };
  };

  // the heron: feet on the bed DEPTH under the water, facing the river (side on to the views from downstream)
  const hx = shallow(world, HOME_Z);
  const heron = make('heron', hx, world.height(hx, HOME_Z), HOME_Z, -Math.PI / 2 - 0.25, 1);
  // its headings: along the bank half the time (where it can step), else out over the river; never the bank
  const down = Math.atan2(world.riverX(HOME_Z + 1) - world.riverX(HOME_Z - 1), 2); // facing downstream along the bank
  heron.pick = () => {
    const r = rng();
    if (r < 0.3) return down + (rng() - 0.5) * 0.3;
    if (r < 0.6) return down - Math.PI + (rng() - 0.5) * 0.3;
    return -Math.PI / 2 + (rng() * 2 - 1) * 1.1;
  };
  heron.stand = (x, z) => {
    const d = -world.height(x, z);
    return d >= WADE[0] && d <= WADE[1] && Math.abs(z - HOME_Z) < RANGE ? world.height(x, z) : null;
  };
  // the egrets: two in one paddy, a few metres apart, feet just under its water
  const egrets = [];
  for (let r = 0; r < 6 && egrets.length < 2; r += 0.5) {
    for (let k = 0; k < 16 && egrets.length < 2; k++) {
      const a = (k / 16) * Math.PI * 2, x = PADDY[0] + Math.cos(a) * r, z = PADDY[1] + Math.sin(a) * r;
      const y = paddyWater(world, x, z, 1.2);
      if (y === null || egrets.some((e) => Math.hypot(e.home.x - x, e.home.z - z) < 2.2)) continue;
      const e = make('egret', x, y - 0.03, z, rng() * Math.PI * 2, EGRET * (0.95 + rng() * 0.1));
      e.pick = () => rng() * Math.PI * 2;
      e.stand = (sx, sz) => {
        const w = paddyWater(world, sx, sz);
        return w !== null && Math.hypot(sx - e.home.x, sz - e.home.z) < RANGE ? w - 0.03 : null;
      };
      egrets.push(e);
    }
  }
  const birds = [heron, ...egrets];
  const fwd = new THREE.Vector3();
  // the heron's legs in the current, the rings of its steps (touches.js)
  const wakes = STEPS.map(() => ({ x: 0, z: 0, r: 0.012, len: 0.9, amp: 0.85, lambda: 0.045 })), splashes = [];
  let stalkT = 0;
  const legs = () => {
    const t = heron.act === 'stalk' ? heron.A.stalk.time : 0;
    const c = Math.cos(heron.yaw), s = Math.sin(heron.yaw), p = heron.root.position;
    for (let i = 0; i < STEPS.length; i++) {
      const [side, t0, t1] = STEPS[i];
      const lx = side * FOOT_X * heron.scale, lz = STALK * heron.scale * (heron.act === 'stalk' ? smooth((t - t0) / (t1 - t0)) : 0);
      // (three's yaw: local x -> (cos, -sin), local z -> (sin, cos))
      const w = wakes[i];
      w.x = p.x + lx * c + lz * s; w.z = p.z - lx * s + lz * c;
      if (heron.act === 'stalk') {
        if (stalkT < t0 && t >= t0) splashes.push({ x: w.x, z: w.z, amp: 0.45, r: 0.01 });
        if (stalkT < t1 && t >= t1) splashes.push({ x: w.x, z: w.z, amp: 0.9, r: 0.01 });
      }
    }
    stalkT = t;
  };

  return {
    group, wakes, splashes,
    info: () => birds.map((b) => ({ kind: b.kind, x: +b.root.position.x.toFixed(2), y: +b.root.position.y.toFixed(3), z: +b.root.position.z.toFixed(2), yaw: +b.root.rotation.y.toFixed(2), act: b.act, visible: b.root.visible })),
    // warming: the warm-up shows every bird and both its models, so their pipelines are built behind the loading veil,
    // not when one first comes into view
    update(dt, hour, camera, warming = false) {
      dt = Math.min(dt, 0.1);
      const away = hour < ROOST[0] || hour > ROOST[1];
      for (const b of birds) {
        b.root.visible = warming || b.kind === 'heron' || !away;
        if (!b.root.visible) continue;
        const d = camera ? camera.position.distanceTo(b.root.position) : 0;
        const nearOn = d < FAR[b.kind];
        b.near.visible = warming || nearOn; b.far.visible = warming || !nearOn;
        if (!b.act) {
          // turning slowly to a new heading every minute or few, eased
          if ((b.turn -= dt) <= 0) { b.yawTo = b.pick(); b.turn = 60 + rng() * 120; }
          const e = b.kind === 'heron' ? fromRiver(b.yawTo) - fromRiver(b.yaw) : wrap(b.yawTo - b.yaw); // (the heron turns by the river side)
          b.yaw += Math.sign(e) * Math.min(Math.abs(e) * 0.08, 0.05) * dt;
          b.root.rotation.y = b.yaw;
          if ((b.next -= dt) <= 0) {
            // a stalk if the step lands somewhere it can stand, else a preen
            fwd.set(Math.sin(b.yaw), 0, Math.cos(b.yaw)).multiplyScalar(STALK * b.scale);
            const y = b.stand(b.root.position.x + fwd.x, b.root.position.z + fwd.z);
            b.act = y !== null && rng() < 0.6 ? 'stalk' : 'preen';
            b.from = b.root.position.y; b.to = y;
            b.A[b.act].reset().play();
            b.A[b.act].crossFadeFrom(b.A.idle, 0.7, false);
          }
        } else {
          const a = b.A[b.act];
          // the feet go down or up to the new footing's level as the body moves over it (the clip's 0.8–4.2 s)
          if (b.act === 'stalk') b.root.position.y = b.from + (b.to - b.from) * smooth((a.time - 0.8) / 3.4);
          if (a.paused || a.time >= a.getClip().duration) {
            if (b.act === 'stalk') {
              // the clip ends in the rest pose a step on: move the bird there and go on from the idle's rest pose
              fwd.set(Math.sin(b.yaw), 0, Math.cos(b.yaw)).multiplyScalar(STALK * b.scale);
              b.root.position.x += fwd.x; b.root.position.z += fwd.z; b.root.position.y = b.to;
              a.stop();
              b.A.idle.reset().play();
            } else {
              b.A.idle.reset().play();
              b.A.idle.crossFadeFrom(a, 0.6, false);
            }
            b.act = null;
            b.next = PAUSE[0] + rng() * (PAUSE[1] - PAUSE[0]);
          }
        }
        b.mixer.update(dt);
      }
      legs();
    },
  };
}
