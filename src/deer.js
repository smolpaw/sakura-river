// Sika deer on the far bank: three hinds and two yearlings (in spring the hinds keep together with last year's
// young; the stags go about on their own, their antlers just cast). Model: tools/deer.py (Blender, `node
// tools/blender.mjs deer`), src/models/deer.glb, inlined: one hind (a lighter model beyond FAR m) with clips for the
// gaits (walk, trot, bound: cycles in place), the postures (stand, graze, alert, bed) and the moves between them
// (down, up, stamp, groom). The yearlings are the same model smaller.
// The herd keeps the day's round of wild sika: grazing their patch of turf on the bank (GRAZE in gen/layout.js) at
// night and in the morning, lying up from mid-morning in the shade of the cherry south of it, chewing the cud, down to
// the river to drink in the afternoon, then back to graze. In heavy rain they stand under the cherry instead. Each
// deer grazes its own way: stepping slowly on with its head down, lifting it now and then to look round and chew,
// grooming, keeping near the lead hind; ears and tail flick on their own.
// They watch the traveller (the walker's body, walking or standing; the orbit camera only up close, at 0.3 of the
// distances): from about 38 m
// a deer stops and lifts its head to stare, the herd following its lead; nearer it stamps a forefoot; nearer still,
// or coming on quickly, they bound away with the white rumps flared, stop a safe way off to look back, and drift home
// once all is quiet; the first to bolt whistles the alarm (events, for audio.js). The river between counts as distance,
// and someone who stands still for a while is first watched, then ignored.
// Animation: per deer, one mixer blends two layers set here each frame (the clips split by bone): the body and legs
// (a gait at the deer's speed, its phase shared between the gaits so the hooves stay put, or a posture) and the neck
// and head (a posture). Over them, set after the mixer: the head turned to what the deer is looking at, the ears and
// the tail. The body follows the ground's slope. Lit by the scene's own material (fog, shadows, the lamps' light,
// the ground's bounce); the coat's spots, the white rump patch (flared wider when alarmed) and the tail's black line are
// painted from the bind pose.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, mix, abs, atan, floor, fract, length, pow, max, dot, normalize, attribute, uniform, positionWorld, positionGeometry, normalGeometry, normalWorld, cameraPosition, diffuseColor } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { U, LitMaterial, lanternLight, hash12, sstep } from './tsl.js';
import { groundBounce } from './materials.js';
import { mulberry32, smoothstep } from './noise.js';
import { GRAZE, STRETCH } from './gen/layout.js';
// ?url&inline: vite does not take .glb for an asset on its own; inlined, the page stays one file
import deerUrl from './models/deer.glb?url&inline';

const HERD = [1.0, 0.96, 1.03, 0.82, 0.79]; // sizes against the model (a hind 1.42 m nose to tail); the lead hind first
const FAR = 35; // m: the lighter model beyond
// tools/deer.py GAITS: ground covered per cycle (m) and the cycle (s), at the model's size
const GAIT = { walk: [0.84, 1.05], trot: [1.32, 0.6], bound: [2.6, 0.44] };
const PACE = { stroll: 0.75, trot: 2.2, flee: 6.5 }; // m/s at the model's size
const POSTURES = ['stand', 'graze', 'alert', 'bed'];
const MOVES = ['down', 'up', 'stamp', 'groom']; // one-shots, each ending in a posture
const AFTER = { down: 'bed', up: 'stand', stamp: 'alert', groom: 'stand' };
// the clips' bones by layer: the body and legs, the neck and head (ears and tail are moved here, not by the clips)
const UPPER = new Set(['neck1', 'neck2', 'head']);
const OWN = new Set(['ear_L', 'ear_R', 'tail']);
// the traveller: alarm from, flight at (m); the orbit camera counts at CAMERA times these
const ALARM = 38, FLIGHT = 12, CAMERA = 0.3;
const ACROSS = 1.25; // the river between: distances count this much more (they watch the far bank's path, but don't run from it)
// the day's round (clock hours): grazing, lying up, drinking
const REST = [9.6, 15.0], DRINK = [15.0, 16.2];

const TAU = Math.PI * 2;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (v, to, rate, dt) => v + (to - v) * (1 - Math.exp(-rate * dt));

// the coat over the model's colours, from the bind pose in metres (glTF axes: y up, the nose towards +z, the deer's
// left +x); per object: how far the rump patch is flared (0..1)
function coatColor(at) {
  const flare = uniform(0).onObjectUpdate(({ object }) => object.userData.flare || 0);
  return Fn(() => {
    const c4 = attribute('color', 'vec4');
    const c = c4.rgb.toVar();
    const coat = c4.a;
    const p = positionGeometry.mul(at.scale).add(at.offset), n = normalGeometry;
    // white spots in rows either side of the spine, scattered lower down the flanks, from the shoulder to the rump
    const a = atan(abs(p.x), p.y.sub(0.6));
    const g = vec2(p.z.mul(15.0), a.mul(7.0)), id = floor(g), f = fract(g).sub(0.5);
    const j = vec2(hash12(id), hash12(id.add(7.1))).sub(0.5).mul(0.4);
    const torso = sstep(-0.52, -0.42, p.z).mul(sstep(0.2, 0.08, p.z)).mul(sstep(1.45, 1.15, a));
    const keep = mix(float(1.0), sstep(0.45, 0.6, hash12(id.add(3.3))), sstep(0.55, 0.8, a)); // the rows, then fewer
    const spot = sstep(0.24, 0.14, length(f.sub(j))).mul(sstep(0.18, 0.3, a)).mul(torso).mul(keep);
    c.assign(mix(c, vec3(0.62, 0.55, 0.45), spot.mul(coat).mul(0.8)));
    // the rump patch: white round the tail, facing back, edged in black above and at the sides; wider when flared
    const back = sstep(-0.2, -0.45, n.z).mul(sstep(-0.45, -0.52, p.z));
    const e = length(vec2(p.x.div(flare.mul(0.035).add(0.07)), p.y.sub(0.64).div(flare.mul(0.03).add(0.095))));
    const patch = sstep(1.0, 0.9, e).mul(back);
    const rim = sstep(1.0, 1.06, e).mul(sstep(1.32, 1.18, e)).mul(back).mul(sstep(0.55, 0.62, p.y));
    c.assign(mix(c, vec3(0.025, 0.02, 0.018), rim.mul(coat).mul(0.85)));
    c.assign(mix(c, vec3(0.74, 0.72, 0.67), patch.mul(coat)));
    // the tail's black line down its back
    const tail = sstep(-0.56, -0.58, p.z).mul(sstep(0.6, 0.63, p.y)).mul(sstep(0.008, 0.004, abs(p.x))).mul(sstep(-0.1, -0.4, n.z).add(sstep(0.2, 0.5, n.y)).min(1.0));
    c.assign(mix(c, vec3(0.03, 0.025, 0.02), tail.mul(coat)));
    return c;
  })();
}

const deerMaterial = (colorNode) => new LitMaterial({ roughness: 0.9, metalness: 0, colorNode }, (out) => Fn(() => {
  // the fur's edges catch the sun, most against it
  const v = normalize(cameraPosition.sub(positionWorld));
  const edge = pow(float(1.0).sub(max(dot(normalWorld, v), 0.0)), 3.0);
  const against = pow(max(dot(v.negate(), U.uSunDir), 0.0), 2.0);
  const rim = U.uSunColor.mul(U.uSunVis).mul(edge).mul(against.mul(1.2).add(0.2));
  return out.add(diffuseColor.rgb.mul(lanternLight(positionWorld).add(groundBounce()).add(rim)));
})());

// a clip's tracks for the bones of one layer
function layerClip(clip, upper) {
  const tracks = clip.tracks.filter((t) => { const b = t.name.split('.')[0]; return !OWN.has(b) && UPPER.has(b) === upper; });
  return new THREE.AnimationClip(`${clip.name}_${upper ? 'upper' : 'body'}`, clip.duration, tracks);
}

// the bone turned about a world axis through its head (its children follow)
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
function turnBone(bone, axis, angle) {
  if (Math.abs(angle) < 1e-5) return;
  bone.parent.getWorldQuaternion(_q1); // (brings the parents' world matrices up to date)
  _q2.setFromAxisAngle(axis, angle);
  bone.quaternion.premultiply(_q3.copy(_q1).invert().multiply(_q2).multiply(_q1));
}

// L: the scene's layout (gen/layout.js); posts: the lantern lines' posts (lanterns.js lists[0]), which they go round
export async function makeDeer(world, L, posts) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(deerUrl);
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  let material = null, sphere = null;
  src.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.skeleton.update();
    if (!material) {
      // the positions are quantized (meshopt): back to metres in the bind pose for the coat
      const q = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
      const w = new THREE.Box3().setFromObject(o, true);
      const scale = (w.max.y - w.min.y) / (q.max.y - q.min.y);
      material = deerMaterial(coatColor({ scale: uniform(scale), offset: uniform(w.min.clone().sub(q.min.clone().multiplyScalar(scale))) }));
      o.computeBoundingSphere();
      sphere = o.boundingSphere.clone();
      sphere.radius += 0.6; // the clips reach beyond the bind pose
    }
  });
  const clips = Object.fromEntries(gltf.animations.map((c) => [c.name, c]));
  const rng = mulberry32(31);
  const group = new THREE.Group();
  group.name = 'deer';

  // ---------- places ----------
  const [gx, gz] = L.graze;
  const east = (x, z) => { const ri = world.riverInfo(x, z); return ri.d - ri.hw; }; // m east of the water's edge
  const trunks = L.small.filter((s) => s.side > 0).map((s) => [s.x, s.z]);
  const stems = [...trunks.map(([x, z]) => [x, z, 0.9])];
  for (let i = 0; i < posts.n; i++) stems.push([posts.matrix[i * 16 + 12], posts.matrix[i * 16 + 14], 0.45]);
  // where a deer can stand: the east bank, dry, not steep, off the paddies, clear of the trunks and the posts
  const ground = (x, z) => world.height(x, z);
  const slope = (x, z) => Math.hypot(ground(x + 0.5, z) - ground(x - 0.5, z), ground(x, z + 0.5) - ground(x, z - 0.5));
  const walkable = (x, z) => {
    const e = east(x, z);
    if (e < 0.5 || e > 48 || z < -68 || z > 14) return false;
    if (slope(x, z) > 0.55) return false;
    const F = world.heightField(x, z).F;
    if (F && F.inside) return false;
    return stems.every(([tx, tz, r]) => Math.abs(x - tx) > r || Math.abs(z - tz) > r || Math.hypot(x - tx, z - tz) > r);
  };
  const inMeadow = (x, z) => Math.hypot(x - gx, (z - gz) / STRETCH) < GRAZE.r;
  const meadowSpot = () => {
    for (let k = 0; k < 40; k++) {
      const r = GRAZE.r * 0.9 * Math.sqrt(rng()), t = rng() * TAU, x = gx + Math.cos(t) * r, z = gz + Math.sin(t) * r * STRETCH;
      if (walkable(x, z)) return [x, z];
    }
    return [gx, gz];
  };
  // the cherry they lie up under: the bank's nearest to the grazing ground, south of it
  const tree = trunks.reduce((b, t) => (Math.hypot(t[0] - gx, t[1] - gz) < Math.hypot(b[0] - gx, b[1] - gz) ? t : b), trunks[0]);
  const bedSpot = (k) => {
    for (let n = 0; n < 60; n++) {
      const t = (k / HERD.length + rng() * 0.15) * TAU, r = 1.6 + rng() * 2.2, x = tree[0] + Math.cos(t) * r, z = tree[1] + Math.sin(t) * r;
      if (walkable(x, z) && slope(x, z) < 0.3) return [x, z];
    }
    return meadowSpot();
  };
  // where they drink: the river's banks are too steep, so the edge of a flooded paddy south of the grazing ground,
  // standing on its levee about level with the water, facing it (spots along the edge, the nearest first)
  const sips = [];
  for (let z = gz - 30; z > gz - 46; z -= 0.5) for (let x = gx - 12; x < gx + 16; x += 0.5) {
    const F = world.heightField(x, z).F;
    if (!F || !F.wet || !F.inside || F.q < 0.3) continue;
    const dx = gx - x, dz = gz - z, l = Math.hypot(dx, dz), sx = x + (dx / l) * 1.0, sz = z + (dz / l) * 1.0;
    if (!walkable(sx, sz) || Math.abs(ground(sx, sz) - F.y) > 0.2) continue;
    if (sips.some((p) => Math.hypot(p.x - sx, p.z - sz) < 1.4)) continue;
    sips.push({ x: sx, z: sz, yaw: Math.atan2(x - sx, z - sz), d: l });
  }
  // the nearest spot and those along the edge from it; a deer without one waits a little behind
  sips.sort((a, b) => a.d - b.d);
  if (sips.length) sips.sort((a, b) => Math.hypot(a.x - sips[0].x, a.z - sips[0].z) - Math.hypot(b.x - sips[0].x, b.z - sips[0].z));
  const drinkSpot = (k) => {
    if (!sips.length) return meadowSpot();
    if (k < sips.length) return [sips[k].x, sips[k].z];
    const p = sips[k % sips.length], b = p.yaw + Math.PI + (rng() - 0.5);
    return [p.x + Math.sin(b) * 2, p.z + Math.cos(b) * 2];
  };
  const drinkYaw = (k) => (sips.length ? sips[k % sips.length].yaw : 0);

  // ---------- the deer ----------
  const deer = HERD.map((s, k) => {
    const root = cloneSkinned(src);
    let near = null, far = null;
    root.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.material = material;
      o.castShadow = o.receiveShadow = true;
      o.boundingSphere = sphere.clone();
      o.frustumCulled = true;
      if (o.name.endsWith('_far')) far = o; else near = o;
    });
    far.visible = false;
    root.scale.setScalar(s);
    group.add(root);
    const mixer = new THREE.AnimationMixer(root);
    const act = { body: {}, upper: {} };
    for (const name of ['walk', 'trot', 'bound', ...POSTURES, ...MOVES]) {
      for (const layer of ['body', 'upper']) {
        const a = mixer.clipAction(layerClip(clips[name], layer === 'upper'));
        a.play();
        a.enabled = false;
        a.setEffectiveWeight(0);
        act[layer][name] = { a, w: 0 };
      }
    }
    const bone = (n) => root.getObjectByName(n);
    const [x, z] = meadowSpot();
    const own = ['ear_L', 'ear_R', 'tail'].map((n) => [bone(n), bone(n).quaternion.clone()]); // not in the clips: reset each frame
    return {
      k, s, root, near, far, mixer, act, own, up: 0, turned: ['neck1', 'neck2', 'head'].map((n) => [bone(n), bone(n).quaternion.clone()]),
      bones: { neck1: bone('neck1'), neck2: bone('neck2'), head: bone('head'), earL: bone('ear_L'), earR: bone('ear_R'), tail: bone('tail') },
      x, z, yaw: rng() * TAU, v: 0, phase: rng(), clock: rng() * 30,
      posture: 'graze', move: null, moveT: 0, // the posture held, a one-shot under way
      mode: 'feed', goal: null, pace: 0, // what it is doing; where it is going and how fast
      next: 2 + rng() * 6, step: 4 + rng() * 8, groom: 60 + rng() * 120, // timers: the head's next lift, the next step on, groom
      fear: 0, threat: 0, flare: 0, face: null, look: null, lookW: 0, lookYaw: 0, lookPitch: 0,
      ear: { t: rng() * 5, flick: 0, side: 1, swivel: 0 }, tail: { t: rng() * 8, flick: 0, raise: 0 },
      pitch: 0, roll: 0,
    };
  });
  const lead = deer[0];
  const others = (d) => deer.filter((o) => o !== d);

  // ---------- body: the layers' weights and times, then the head, ears and tail ----------
  const POST_RATE = 2.5, MOVE_RATE = 6;
  const v3 = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3(), fwd = new THREE.Vector3();
  function pose(d, dt) {
    const sv = d.v / d.s; // speed at the model's size
    // gaits by speed, crossfaded; the phase runs at the blended stride
    const gw = { walk: smoothstep(0.02, 0.2, sv) * (1 - smoothstep(1.2, 1.6, sv)), trot: smoothstep(1.2, 1.6, sv) * (1 - smoothstep(3.0, 3.8, sv)), bound: smoothstep(3.0, 3.8, sv) };
    const gsum = gw.walk + gw.trot + gw.bound;
    if (gsum > 0) {
      let stride = 0;
      for (const g in gw) stride += gw[g] * GAIT[g][0];
      d.phase = (d.phase + (sv * dt) / (stride / gsum)) % 1;
    }
    d.clock += dt;
    const moving = Math.min(1, gsum);
    const run = smoothstep(1.0, 1.8, sv);
    for (const layer of ['body', 'upper']) {
      const A = d.act[layer];
      const target = {};
      if (d.move) target[d.move] = 1;
      else {
        const still = layer === 'body' ? 1 - moving : 1 - run;
        target[d.posture] = still;
        for (const g in gw) target[g] = (layer === 'body' ? gw[g] : gw[g] * run / Math.max(gsum, 1e-6)) || 0;
        if (layer === 'upper' && moving > 0 && run < 1) target[d.posture] = 1 - run;
      }
      let sum = 0;
      for (const n in A) {
        const rate = d.move || n === d.move ? MOVE_RATE : POST_RATE;
        A[n].w = approach(A[n].w, target[n] || 0, rate, dt);
        if (A[n].w < 0.002 && !target[n]) A[n].w = 0;
        sum += A[n].w;
      }
      for (const n in A) {
        const { a } = A[n], w = sum > 0 ? A[n].w / sum : 0;
        a.enabled = w > 0;
        a.setEffectiveWeight(w);
        if (!a.enabled) continue;
        const dur = a.getClip().duration;
        a.time = GAIT[n] ? d.phase * dur : MOVES.includes(n) ? Math.min(d.moveT, dur - 1e-3) : d.clock % dur;
      }
    }
    // the mixer writes a bone only when its blended value changed since the last frame; the neck and head are turned
    // after it, so they go back to its last value first (else, on a still clip, the turns pile up frame on frame)
    for (const [b, q] of d.turned) b.quaternion.copy(q);
    d.mixer.update(0);
    for (const [b, q] of d.turned) q.copy(b.quaternion);
    for (const [b, q] of d.own) b.quaternion.copy(q);

    // the root's frame: up and right (the deer's own)
    up.set(0, 1, 0).applyQuaternion(d.root.quaternion);
    right.set(1, 0, 0).applyQuaternion(d.root.quaternion);
    fwd.set(0, 0, 1).applyQuaternion(d.root.quaternion);
    // the head turned towards what it watches (not while grazing, lying or running)
    const B = d.bones;
    let yawTo = 0, pitchTo = 0;
    const lookOK = !d.move && (d.posture === 'stand' || d.posture === 'alert' || d.posture === 'bed') && run < 0.5;
    if (d.look && lookOK) {
      v3.set(d.look.x - d.x, (d.look.y ?? d.root.position.y + 1) - (d.root.position.y + 1.0 * d.s), d.look.z - d.z);
      yawTo = THREE.MathUtils.clamp(wrap(Math.atan2(v3.x, v3.z) - d.yaw), -1.9, 1.9);
      pitchTo = THREE.MathUtils.clamp(Math.atan2(v3.y, Math.hypot(v3.x, v3.z)), -0.4, 0.5);
    }
    d.lookW = approach(d.lookW, d.look && lookOK ? 1 : 0, 4, dt);
    d.lookYaw = approach(d.lookYaw, yawTo, 5, dt);
    d.lookPitch = approach(d.lookPitch, pitchTo, 5, dt);
    const ly = d.lookYaw * d.lookW, lp = d.lookPitch * d.lookW;
    turnBone(B.neck1, up, ly * 0.35);
    turnBone(B.neck2, up, ly * 0.35);
    turnBone(B.head, up, ly * 0.3);
    turnBone(B.head, right, -lp);
    // ears: turned forward to what alarms it, else drifting round on their own and flicked now and then
    const E = d.ear;
    E.t -= dt;
    if (E.t <= 0) { E.t = 0.8 + rng() * 4; E.side = rng() < 0.5 ? 1 : -1; E.swivel = (rng() - 0.3) * 0.7; if (rng() < 0.35) E.flick = 1; }
    E.flick = Math.max(0, E.flick - dt * 6);
    const alarmed = smoothstep(0.25, 0.6, d.fear);
    const fl = Math.sin(E.flick * Math.PI) * 0.9;
    const swivel = approach(E.cur || 0, mix1(E.swivel, -0.5, alarmed), 6, dt);
    E.cur = swivel;
    turnBone(B.earL, up, -swivel - (E.side > 0 ? fl : 0));
    turnBone(B.earR, up, swivel + (E.side < 0 ? fl : 0));
    turnBone(B.earL, fwd, -0.25 * alarmed);
    turnBone(B.earR, fwd, 0.25 * alarmed);
    // tail: raised and flared in alarm, flicked side to side now and then
    const T = d.tail;
    T.t -= dt;
    if (T.t <= 0) { T.t = 3 + rng() * 10; T.flick = 1; }
    T.flick = Math.max(0, T.flick - dt * 2.2);
    T.raise = approach(T.raise, Math.max(d.flare, run * 0.4), 5, dt);
    turnBone(B.tail, right, -1.1 * T.raise);
    turnBone(B.tail, up, Math.sin(T.flick * Math.PI * 4) * 0.5 * T.flick);
    d.near.userData.flare = d.far.userData.flare = d.flare;
  }
  const mix1 = (a, b, t) => a + (b - a) * t;

  // ---------- moving over the ground ----------
  function steer(d, dt) {
    let want = 0, turn = 0;
    if (!d.goal && d.face !== null) {
      // turning on the spot: stepping round slowly
      turn = wrap(d.face - d.yaw);
      if (Math.abs(turn) < 0.08) d.face = null;
      else want = 0.3 * d.s;
    }
    if (d.goal) {
      const dx = d.goal[0] - d.x, dz = d.goal[1] - d.z, dist = Math.hypot(dx, dz);
      if (dist < 0.3 * d.s + (d.pace > 3 ? 1.5 : 0)) { d.goal = null; }
      else {
        let head = Math.atan2(dx, dz);
        // round what it can't cross: the first heading either side clear for a step and further on
        const look = 1.2 + d.v * 0.5, clear = (h) => walkable(d.x + Math.sin(h) * 0.5, d.z + Math.cos(h) * 0.5) && walkable(d.x + Math.sin(h) * look, d.z + Math.cos(h) * look);
        let found = false;
        for (let i = 0; i < 13 && !found; i++) {
          const h = head + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.3;
          if (clear(h)) { head = h; found = true; }
        }
        d.stuck = found ? 0 : (d.stuck || 0) + dt;
        if (d.stuck > 1) { d.goal = null; d.stuck = 0; return; } // nowhere to go that way: give it up
        // apart from the others
        for (const o of others(d)) {
          const ox = d.x - o.x, oz = d.z - o.z, od = Math.hypot(ox, oz);
          if (od < 1.3 * d.s && od > 1e-3) head += wrap(Math.atan2(ox, oz) - head) * 0.3 * (1 - od / (1.3 * d.s));
        }
        turn = wrap(head - d.yaw);
        want = Math.min(d.pace, 0.25 + dist * (d.pace > 3 ? 2.5 : 0.9)) * Math.max(0.25, Math.cos(turn));
      }
    }
    const accel = d.pace > 3 ? 6 : 1.6;
    d.v = approach(d.v, want * (d.move ? 0 : 1), accel, dt);
    const rate = d.v > 2.5 ? 2.6 : 1.4 + d.v;
    d.yaw += THREE.MathUtils.clamp(turn, -rate * dt, rate * dt) * (d.v > 0.05 || turn ? 1 : 0);
    const nx = d.x + Math.sin(d.yaw) * d.v * dt, nz = d.z + Math.cos(d.yaw) * d.v * dt;
    if (walkable(nx, nz) || !walkable(d.x, d.z)) { d.x = nx; d.z = nz; } else d.v *= 0.5;
  }

  // the root on the ground, pitched and rolled with its slope under the hooves
  const eul = new THREE.Euler(0, 0, 0, 'YXZ');
  function place(d, dt) {
    const L = 0.45 * d.s, W = 0.12 * d.s, c = Math.cos(d.yaw), s = Math.sin(d.yaw);
    const hf = ground(d.x + s * L, d.z + c * L), hb = ground(d.x - s * L, d.z - c * L);
    const hl = ground(d.x + c * W, d.z - s * W), hr = ground(d.x - c * W, d.z + s * W);
    d.pitch = approach(d.pitch, Math.atan2(hb - hf, 2 * L) * (d.posture === 'bed' && !d.move ? 0.5 : 1), 6, dt);
    d.roll = approach(d.roll, Math.atan2(hl - hr, 2 * W) * 0.6, 6, dt);
    d.root.position.set(d.x, Math.min((hf + hb) / 2, (hl + hr) / 2 + 0.02), d.z);
    eul.set(d.pitch, d.yaw, d.roll);
    d.root.quaternion.setFromEuler(eul);
  }

  // ---------- behaviour ----------
  const startMove = (d, m) => { d.move = m; d.moveT = 0; d.v = 0; };
  const moveLen = (m) => clips[m].duration;
  // the day's round: where the herd should be
  const plan = (hour, rain) => (rain > 0.6 ? 'shelter' : hour >= REST[0] && hour < REST[1] ? 'rest' : hour >= DRINK[0] && hour < DRINK[1] ? 'drink' : 'feed');
  const spotFor = (d, what) => (what === 'rest' || what === 'shelter' ? bedSpot(d.k) : what === 'drink' ? drinkSpot(d.k) : meadowSpot());
  let calm = false, forced = null, herdPlan = null, lastHour = null, stampT = 0, habit = 0, now = 0, bolted = -Infinity;
  // the two who can be watched: the traveller (where their body stands, walking or not) and the camera; how fast each
  // moves, and where each was last frame
  const seen = { walker: { at: new THREE.Vector3(), prev: new THREE.Vector3(), v: 0, on: false, k: 1 }, camera: { at: new THREE.Vector3(), prev: new THREE.Vector3(), v: 0, on: true, k: CAMERA } };
  let obs = seen.camera.at, alarmCall = 0;

  // put the herd straight where the plan has it (at start, and when the clock jumps)
  function settle(what) {
    for (const d of deer) {
      [d.x, d.z] = spotFor(d, what);
      d.v = 0; d.goal = null; d.move = null; d.fear = 0;
      d.mode = what === 'feed' ? 'feed' : what;
      d.posture = what === 'rest' ? 'bed' : what === 'feed' || what === 'drink' ? 'graze' : 'stand';
      if (what === 'drink') d.yaw = drinkYaw(d.k) + (rng() - 0.5) * 0.3;
      else if (what === 'rest' || what === 'shelter') d.yaw = Math.atan2(tree[0] - d.x, tree[1] - d.z) + Math.PI / 2 + (rng() - 0.5);
      for (const layer of ['body', 'upper']) for (const n in d.act[layer]) d.act[layer][n].w = n === d.posture ? 1 : 0;
    }
  }

  // one deer's choices
  function think(d, dt, hour) {
    // a one-shot runs to its end, then its posture holds
    if (d.move) {
      d.moveT += dt;
      if (d.moveT >= moveLen(d.move)) { d.posture = AFTER[d.move]; d.move = null; }
      return;
    }
    const alarmed = d.fear > 0.35;
    if (d.mode === 'flee') {
      d.look = null;
      if (!d.goal || d.fear < 0.5) { d.mode = 'watch'; d.goal = null; d.pace = 0; d.posture = 'alert'; }
      return;
    }
    if (alarmed && d.mode !== 'watch') {
      // stop and stare; a lying deer gets up first
      if (d.posture === 'bed') { startMove(d, 'up'); return; }
      d.mode = 'watch'; d.goal = null; d.pace = 0; d.posture = 'alert';
    }
    if (d.mode === 'watch') {
      d.look = obs;
      d.posture = 'alert';
      // turn to face it if it is behind
      const off = wrap(Math.atan2(obs.x - d.x, obs.z - d.z) - d.yaw);
      if (Math.abs(off) > 1.6 && d.face === null) d.face = d.yaw + off * 0.7;
      if (d.fear < 0.2) { d.mode = 'return'; d.look = null; }
      return;
    }
    const what = herdPlan;
    // back to where the herd belongs
    if (d.mode !== what || (d.mode === 'feed' && d === lead && !inMeadow(d.x, d.z) && !d.goal)) {
      if (d.posture === 'bed') { startMove(d, 'up'); return; }
      // (a goal set for something else, a grazing step, say, gives way to this part of the round's)
      if (!d.goal || d.goalFor !== what) { d.goal = spotFor(d, what); d.goalFor = what; d.pace = PACE.stroll * d.s; d.posture = 'stand'; }
      d.look = null;
      if (Math.hypot(d.goal[0] - d.x, d.goal[1] - d.z) < 0.6) {
        d.goal = null; d.mode = what;
        if (what === 'drink') d.face = drinkYaw(d.k);
        if (what === 'rest') startMove(d, 'down');
        else d.posture = what === 'shelter' ? 'stand' : 'graze';
      }
      return;
    }
    if (d.goal) return; // a step on while grazing, finishing
    d.pace = 0;
    d.next -= dt; d.groom -= dt; d.step -= dt;
    if (d.mode === 'rest') {
      // lying, chewing the cud, looking round now and then; every several minutes up to stand a while and groom,
      // and down again
      if (d.posture === 'bed') {
        if (d.next <= 0) { d.next = 6 + rng() * 14; d.look = rng() < 0.4 ? { x: d.x + (rng() - 0.5) * 20, z: d.z + (rng() - 0.5) * 20 } : null; }
        if (d.groom <= 0) { d.groom = 300 + rng() * 600; d.up = 1 + Math.floor(rng() * 2); d.look = null; startMove(d, 'up'); d.next = 2 + rng() * 3; }
      } else if (d.next <= 0) {
        d.next = 2 + rng() * 3;
        startMove(d, d.up-- > 0 ? 'groom' : 'down');
      }
      return;
    }
    // grazing (on the meadow, at the water, sheltering): head down most of the time
    if (d.posture === 'graze') {
      if (d.next <= 0) { d.posture = 'stand'; d.next = 1.5 + rng() * 4; d.look = rng() < 0.6 ? { x: d.x + (rng() - 0.5) * 30, z: d.z + (rng() - 0.5) * 30 } : null; }
      else if (d.step <= 0 && d.mode === 'feed') {
        // a few steps on, head still down
        d.step = 5 + rng() * 9;
        const h = d.yaw + (rng() - 0.5) * 1.2, r = (0.6 + rng() * 1.2) * d.s;
        let gxs = d.x + Math.sin(h) * r, gzs = d.z + Math.cos(h) * r;
        // keep with the lead hind and on the turf
        const lx = lead.x - d.x, lz = lead.z - d.z;
        if (d !== lead && Math.hypot(lx, lz) > 6) { gxs = d.x + lx * 0.3; gzs = d.z + lz * 0.3; }
        if (d === lead && !inMeadow(gxs, gzs)) { gxs = d.x + (gx - d.x) * 0.2; gzs = d.z + (gz - d.z) * 0.2; }
        if (walkable(gxs, gzs)) { d.goal = [gxs, gzs]; d.goalFor = null; d.pace = 0.35 * d.s; }
      }
    } else if (d.posture === 'stand') {
      if (d.groom <= 0 && d.mode !== 'shelter') { d.groom = 90 + rng() * 150; startMove(d, 'groom'); }
      else if (d.next <= 0) {
        d.look = null;
        if (d.mode === 'shelter') { d.next = 5 + rng() * 10; d.look = rng() < 0.5 ? { x: d.x + (rng() - 0.5) * 20, z: d.z + (rng() - 0.5) * 20 } : null; }
        else { d.posture = 'graze'; d.next = 4 + rng() * 12; }
      }
    }
  }

  // the traveller (walking) or the camera: how alarming, for one deer
  function threat(d, o) {
    if (!o.on) return 0;
    const P = o.at, dist = Math.hypot(P.x - d.x, P.z - d.z) * (east(P.x, P.z) < 0 ? ACROSS : 1);
    const near = (ALARM * o.k - dist) / ((ALARM - FLIGHT) * o.k);
    // coming on quickly counts more
    const toward = o.v > 0.6 ? 0.25 : 0;
    return THREE.MathUtils.clamp(near + toward - habit * 0.7, 0, 1.2);
  }

  // where to run: away from it, somewhere it can go, 25-40 m on
  function fleeGoal(d) {
    const away = Math.atan2(d.x - obs.x, d.z - obs.z);
    for (let i = 0; i < 24; i++) {
      const h = away + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.2, r = 25 + rng() * 15;
      let ok = true;
      for (let t = 2; t < r && ok; t += 2) ok = walkable(d.x + Math.sin(h) * t, d.z + Math.cos(h) * t);
      if (ok) return [d.x + Math.sin(h) * r, d.z + Math.cos(h) * r];
    }
    return null;
  }

  return {
    group,
    // calls for the sound (audio.js call): { kind: 'sika' (the alarm whistle), x, y, z }, taken each frame
    events: [],
    // o.calm: the herd pays the observer no mind (for close looks at them); o.plan: the herd keeps this part of its
    // round ('feed', 'rest', 'drink', 'shelter'; null: the clock's) whatever the hour; o.settle: that part of the round
    info(o = {}) {
      if (o.calm !== undefined) calm = !!o.calm;
      if (o.plan !== undefined) forced = o.plan;
      if (o.settle) { herdPlan = o.settle; settle(o.settle); } // ...and starts it afresh, each deer in its place
      return deer.map((d) => ({ x: +d.x.toFixed(2), z: +d.z.toFixed(2), yaw: +d.yaw.toFixed(2), v: +d.v.toFixed(2), mode: d.mode, posture: d.posture, move: d.move, fear: +d.fear.toFixed(2), plan: herdPlan }));
    },
    // ctx: { hour, rain, camera, walker (where the traveller's body stands, {x, y, z}, or null), warming }
    update(dt, ctx) {
      dt = Math.min(dt, 0.1);
      const { hour, camera, walker, warming } = ctx;
      const want = forced || plan(hour, ctx.rain || 0);
      // the clock jumped (picked anew, or the first frame): the herd is simply there
      const jumped = lastHour === null || Math.abs(wrap((hour - lastHour) / 24 * TAU)) / TAU * 24 > 0.5;
      lastHour = hour;
      if (jumped) { herdPlan = want; settle(want); }
      else if (want !== herdPlan) herdPlan = want;
      // the traveller and the camera: each deer minds the more alarming, and watches whichever alarms the lead hind more
      seen.walker.on = !!walker;
      if (walker) seen.walker.at.set(walker.x, walker.y, walker.z);
      seen.camera.at.copy(camera.position);
      for (const o of Object.values(seen)) {
        if (dt > 0) o.v = approach(o.v, o.at.distanceTo(o.prev) / dt, 3, dt);
        o.prev.copy(o.at);
      }
      const watched = threat(lead, seen.walker) >= threat(lead, seen.camera) && walker ? seen.walker : seen.camera;
      obs = watched.at;
      // standing still: watched, then ignored; moving: noticed again
      habit = THREE.MathUtils.clamp(habit + (watched.v < 0.25 ? dt / 45 : -dt / 6), 0, 0.6);
      now += dt; stampT -= dt; alarmCall -= dt;
      for (const d of deer) d.threat = calm ? 0 : Math.max(threat(d, seen.walker), threat(d, seen.camera));
      for (const d of deer) {
        // fear rises quickly and fades slowly; the others' unease spreads to it, weaker
        let to = d.threat;
        for (const o of others(d)) if (Math.hypot(o.x - d.x, o.z - d.z) < 15) to = Math.max(to, o.fear * 0.7);
        d.fear = to > d.fear ? approach(d.fear, to, 2.5, dt) : approach(d.fear, to, 1 / 20, dt);
      }
      for (const d of deer) {
        // flight: one too close goes, and calls; the uneasy go with it
        const bolt = d.threat > 0.95, follow = now - bolted < 1.5 && d.fear > 0.45;
        if (d.mode !== 'flee' && (bolt || follow)) {
          const g = fleeGoal(d);
          if (g) {
            if (d.move === 'down' || d.posture === 'bed') { d.move = null; d.posture = 'stand'; }
            d.move = null; d.mode = 'flee'; d.goal = g; d.goalFor = null; d.face = null; d.pace = PACE.flee * d.s;
            if (bolt) bolted = now;
            if (alarmCall <= 0) { this.events.push({ kind: 'sika', x: d.x, y: d.root.position.y + d.s, z: d.z }); alarmCall = 20; }
          }
        }
        // the most alarmed of those watching stamps
        if (d.mode === 'watch' && !d.move && d.fear > 0.6 && stampT <= 0 && d === deer.filter((o) => o.mode === 'watch').sort((a, b) => b.fear - a.fear)[0]) {
          startMove(d, 'stamp'); stampT = 12 + rng() * 10;
        }
        think(d, dt, hour);
        if (d.mode === 'flee' && d.goal) {
          // bounding, slowing to a trot as it gets clear
          const left = Math.hypot(d.goal[0] - d.x, d.goal[1] - d.z);
          d.pace = (left > 10 ? PACE.flee : left > 4 ? PACE.trot : PACE.stroll) * d.s;
        }
        d.flare = approach(d.flare, d.mode === 'flee' ? 1 : smoothstep(0.55, 0.9, d.fear), 4, dt);
        steer(d, dt);
        place(d, dt);
        // the lighter model beyond FAR; both while warming up (their pipelines built behind the loading veil)
        const nearOn = camera.position.distanceTo(d.root.position) < FAR;
        d.near.visible = warming || nearOn; d.far.visible = warming || !nearOn;
        pose(d, dt);
      }
    },
  };
}
