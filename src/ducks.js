// A pair of spot-billed ducks (karugamo) on the river: paddling the slack water along the banks of their stretch
// (HOME), the drake keeping a little behind the duck, now and then stopping to up-end and feed (head under, tail and
// orange feet up), to preen, or to rise on the water and beat their wings; each paddle, up-ending and wing beat
// leaving rings on the water (touches.js). When the walker comes within FLUSH m (the camera within CAMERA_FLUSH) they
// spring off the water with a splash, fly off low along the river away from them, land 40-60 m on and, once all is
// quiet, paddle slowly home. After dark they doze by the bank, heads laid back on their shoulders.
// Model: tools/duck.py (Blender, `node tools/blender.mjs duck`), src/models/duck.glb, inlined: the duck (a lighter
// model beyond FAR m) with clips: float (the base: breathing, looking about), paddle (the feet alone, weighted by the
// speed), fly (one wing beat, played at BEAT a second), doze, and the one-shots dabble, preen and flap. Each frame
// sets the clips' weights (summing to 1, so the spread wings, hidden in every clip but fly and flap, never show their
// bind pose). Lit by the herons' material (heron.js); the feathers' pale edges, the dark crown, the stripes through
// the eye and under it, and the eye are drawn over the vertex colours from the bind pose. In the river's reflection;
// no shadows cast.
import * as THREE from 'three/webgpu';
import { Fn, vec2, vec3, mix, abs, atan, floor, fract, length, max, attribute, uniform, positionGeometry, normalGeometry } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { sstep } from './tsl.js';
import { birdMaterial } from './heron.js';
import { mulberry32 } from './noise.js';
// ?url&inline: vite does not take .glb for an asset on its own; inlined, the page stays one file
import duckUrl from './models/duck.glb?url&inline';

const SIZE = 1.3; // against life (57 cm bill to tail): large, as the scene's birds are
const HOME = [-46, 24]; // the stretch they keep to (z)
const FLUSH = 10, CAMERA_FLUSH = 2.5; // m
const QUIET = 40; // s before they head home after a flight
const SWIM = 0.32, FLY = 9; // m/s
const NIGHT = [19.3, 5.0]; // dozing from, until (clock hours)
const BEAT = 5.2; // wing beats a second in flight (the fly clip is one beat long, 1 s)
const FAR = 22; // m: the lighter model beyond
const SHOTS = { dabble: 0.5, preen: 0.8, flap: 1 }; // the one-shots' shares (cumulative) when one is due

// the marks over the vertex colours, from the bind pose in metres (glTF axes: y up, facing +z; the waterline y = 0)
function duckColor(at) {
  return Fn(() => {
    const c4 = attribute('color', 'vec4');
    const c = c4.rgb.toVar();
    const p = positionGeometry.mul(at.scale).add(at.offset);
    const body = sstep(0.75, 0.9, c4.a), feather = sstep(0.25, 0.4, c4.a);
    // the head (above the neck, forward of it): the dark crown down to the eye stripe, the stripe from the bill
    // through the eye to the nape, a fainter one from the gape back under the eye, the eye itself
    const head = body.mul(sstep(0.155, 0.17, p.y)).mul(sstep(0.115, 0.13, p.z));
    const dark = vec3(0.075, 0.056, 0.04);
    const eyeY = 0.207, eyeZ = 0.186;
    const crown = sstep(0.0, 0.006, p.y.sub(eyeY).sub(0.013).add(p.z.sub(eyeZ).mul(0.3)));
    const stripe = sstep(0.0026, 0.001, abs(p.y.sub(eyeY).add(p.z.sub(eyeZ).mul(0.13)))).mul(sstep(0.13, 0.15, p.z)).mul(sstep(0.21, 0.2, p.z));
    const cheek = sstep(0.0022, 0.0008, abs(p.y.sub(0.195).add(p.z.sub(0.19).mul(0.1)))).mul(sstep(0.16, 0.175, p.z)).mul(sstep(0.207, 0.198, p.z));
    c.assign(mix(c, dark, crown.mul(head).mul(0.85)));
    c.assign(mix(c, dark, max(stripe, cheek.mul(0.6)).mul(head)));
    const d = length(vec2(p.y.sub(eyeY), p.z.sub(eyeZ))), side = sstep(0.3, 0.6, abs(normalGeometry.x)).mul(head);
    c.assign(mix(c, vec3(0.012, 0.009, 0.007), sstep(0.0036, 0.0028, d).mul(side)));
    c.assign(mix(c, vec3(0.3, 0.27, 0.22), sstep(0.0011, 0.0005, length(vec2(p.y.sub(eyeY + 0.0012), p.z.sub(eyeZ + 0.0008)))).mul(side)));
    // the body's feathers: in rows round it (about 15 round the body, 3 cm long), each dark brown with a pale buff
    // fringe at its tip (towards the tail); bolder on the flanks and the breast, faint over the back; the folded
    // wings' feathers in finer rows
    const a = atan(p.y.sub(0.035), p.x).mul(2.4), row = floor(a), fa = fract(a).sub(0.5);
    const e = fract(p.z.mul(-32.0).add(row.mul(0.5))).add(fa.mul(fa).mul(1.4));
    const fringe = sstep(0.68, 0.8, e).mul(sstep(1.02, 0.9, e));
    const flank = sstep(0.1, 0.075, p.y).mul(sstep(0.13, 0.11, p.z.add(p.y.mul(0.4))));
    c.assign(mix(c, vec3(0.32, 0.25, 0.16), fringe.mul(body.sub(head).max(0.0)).mul(flank.mul(0.4).add(0.1))));
    const wa = fract(p.z.mul(-46.0).add(floor(p.y.mul(70.0)).mul(0.5)));
    c.assign(mix(c, c.mul(1.6).add(0.012), sstep(0.8, 0.95, wa).mul(feather).mul(0.3)));
    return c;
  })();
}

export async function makeDucks(world, rocksInWater) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(duckUrl);
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  let mat = null;
  const spheres = {};
  src.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    // the clips reach beyond the bind pose (up-ending, rising to flap)
    o.skeleton.update();
    o.computeBoundingSphere();
    spheres[o.name] = o.boundingSphere.clone();
    spheres[o.name].radius += 0.25;
    if (!mat) {
      // the positions are quantized (meshopt): back to metres in the bind pose for the marks (the far model's box is
      // the same duck's)
      const q = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
      const w = new THREE.Box3().setFromObject(o, true);
      const scale = (w.max.y - w.min.y) / (q.max.y - q.min.y);
      mat = birdMaterial(duckColor({ scale: uniform(scale), offset: uniform(w.min.clone().sub(q.min.clone().multiplyScalar(scale))) }));
    }
  });
  const clip = (n) => gltf.animations.find((a) => a.name === n);
  const rng = mulberry32(73);
  const rand = (a, b) => a + (b - a) * rng();

  // ---------- where they go ----------
  const water = (x, z) => world.height(x, z) < -0.25 && rocksInWater.every((r) => Math.hypot(r.x - x, r.z - z) > r.r + 0.4);
  // a spot near one bank of their stretch (or anywhere on the river: a flight's landing), clear of rocks
  const near = (z0, z1) => {
    for (let k = 0; k < 40; k++) {
      const z = rand(z0, z1), rx = world.riverX(z), hw = world.riverHW(z), x = rx + (rng() < 0.5 ? -1 : 1) * hw * rand(0.35, 0.75);
      if (water(x, z)) return [x, z];
    }
    return [world.riverX((z0 + z1) / 2), (z0 + z1) / 2];
  };
  const group = new THREE.Group();
  group.name = 'ducks';
  const ducks = [0, 1].map((k) => {
    const root = cloneSkinned(src);
    let nearM = null, farM = null;
    root.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.material = mat;
      o.receiveShadow = true;
      o.boundingSphere = spheres[o.name].clone();
      if (o.name.endsWith('_far')) farM = o; else nearM = o;
      o.name = o.name.replace('duck', 'ducks');
    });
    root.scale.setScalar(SIZE * (k ? 1.04 : 0.97));
    group.add(root);
    const mixer = new THREE.AnimationMixer(root);
    const A = {};
    for (const n of ['float', 'paddle', 'fly', 'doze', 'dabble', 'preen', 'flap']) {
      A[n] = mixer.clipAction(clip(n));
      if (n in SHOTS) { A[n].setLoop(THREE.LoopOnce, 1); A[n].clampWhenFinished = true; }
      else { A[n].play(); A[n].time = rng() * clip(n).duration; }
      A[n].setEffectiveWeight(0);
    }
    A.float.timeScale = 0.9 + rng() * 0.2;
    A.fly.timeScale = BEAT;
    return { k, root, nearM, farM, mixer, A, w: { fly: 0, doze: 0 }, shot: null, x: 0, z: 0, y: 0, yaw: rng() * Math.PI * 2, v: 0, goal: null, state: 'swim', next: rand(10, 40), paddle: 0, flight: null, beats: 0 };
  });
  const [hen, drake] = ducks;
  {
    const [x, z] = near(-20, 10);
    hen.x = x; hen.z = z; drake.x = x + 0.8; drake.z = z - 1.2;
  }
  const splashes = [], events = [];
  let quack = rand(10, 40); // the duck's next quack
  const walkerAt = new THREE.Vector3(), tmp = new THREE.Vector3();
  let calm = false, away = 0, now = 0;

  const startShot = (d, name) => {
    d.shot = name; d.state = name; d.beats = 0;
    d.A[name].reset().play();
    d.A[name].timeScale = 0.9 + rng() * 0.2;
    if (name !== 'preen') splashes.push({ x: d.x, z: d.z, amp: 0.4, r: 0.06 });
  };
  const endShot = (d) => {
    if (!d.shot) return;
    d.A[d.shot].stop();
    d.shot = null;
    if (d.state !== 'fly') d.state = 'swim';
  };

  // a flight: up off the water, low along the river away from `from`, down 40-60 m on
  const takeOff = (from) => {
    const down = Math.sign(hen.z - from.z) || 1, dist = rand(40, 60);
    let z1 = THREE.MathUtils.clamp(hen.z + down * dist, -90, 60);
    if (Math.abs(z1 - hen.z) < 20) z1 = THREE.MathUtils.clamp(hen.z - down * dist, -90, 60);
    const [lx, lz] = near(z1 - 4, z1 + 4);
    for (const d of ducks) {
      const off = d === hen ? 0 : 1;
      endShot(d);
      d.flight = { t0: now + off * 0.25, from: new THREE.Vector3(d.x, 0, d.z), to: new THREE.Vector3(lx + off * 0.9, 0, lz - off * 1.4), up: rand(2.5, 4) };
      d.flight.len = d.flight.from.distanceTo(d.flight.to);
      d.state = 'fly'; d.goal = null;
      splashes.push({ x: d.x, z: d.z, amp: 1, r: 0.1 });
    }
    events.push({ kind: 'karugamo', x: hen.x, y: 0.3, z: hen.z }); // quacking as they go
    away = now + QUIET;
  };

  // the clips' weights: flight, dozing and a one-shot over the float, which takes the rest; the feet paddle with
  // the float by the speed
  const pose = (d, dt, night) => {
    const ease = (k, to, rate) => { d.w[k] += THREE.MathUtils.clamp(to - d.w[k], -rate * dt, rate * dt); };
    ease('fly', d.state === 'fly' && now >= d.flight.t0 ? 1 : 0, d.state === 'fly' ? 7 : 2.5);
    ease('doze', night && d.state !== 'fly' ? 1 : 0, 0.5);
    let shot = 0;
    if (d.shot) {
      const a = d.A[d.shot], dur = a.getClip().duration;
      shot = Math.max(0, Math.min(1, a.time / 0.3, (dur - a.time) / 0.35));
    }
    const fly = d.w.fly, doze = Math.min(d.w.doze, 1 - fly), sh = Math.min(shot, 1 - fly - doze);
    const fl = Math.max(0, 1 - fly - doze - sh);
    d.A.fly.setEffectiveWeight(fly);
    d.A.doze.setEffectiveWeight(doze);
    for (const n in SHOTS) d.A[n].setEffectiveWeight(n === d.shot ? sh : 0);
    d.A.float.setEffectiveWeight(fl);
    const pace = Math.min(1, d.v / SWIM);
    d.A.paddle.setEffectiveWeight(fl * Math.min(1, pace * 1.5));
    d.A.paddle.timeScale = 0.6 + 0.8 * pace;
    d.mixer.update(dt);
  };

  return {
    group, splashes, events, // events: calls for the sound (audio.js call), taken each frame
    // ctx: { hour, rain, camera, walker ({x, y, z} or null), warming }
    update(dt, ctx) {
      dt = Math.min(dt, 0.1);
      now += dt;
      const night = ctx.hour > NIGHT[0] || ctx.hour < NIGHT[1];
      if (ctx.walker) walkerAt.set(ctx.walker.x, ctx.walker.y + 1, ctx.walker.z);
      const dist = (x, z) => Math.min(ctx.walker ? Math.hypot(walkerAt.x - x, walkerAt.z - z) / FLUSH : Infinity, Math.hypot(ctx.camera.position.x - x, ctx.camera.position.z - z) / CAMERA_FLUSH);
      const from = ctx.walker && Math.hypot(walkerAt.x - hen.x, walkerAt.z - hen.z) / FLUSH < 1 ? walkerAt : ctx.camera.position;
      if (!calm && !ctx.warming && hen.state !== 'fly' && drake.state !== 'fly' && Math.min(dist(hen.x, hen.z), dist(drake.x, drake.z)) < 1) takeOff(from);
      // the duck quacks now and then by day
      if (!night && hen.state !== 'fly' && (quack -= dt) <= 0) { quack = rand(25, 70); events.push({ kind: 'karugamo', x: hen.x, y: 0.3, z: hen.z }); }
      for (const d of ducks) {
        if (d.state === 'fly') {
          const f = d.flight, u = Math.max(0, (now - f.t0) * FLY / f.len);
          if (u >= 1) { d.state = 'swim'; d.x = f.to.x; d.z = f.to.z; d.y = 0; splashes.push({ x: d.x, z: d.z, amp: 0.8, r: 0.08 }); d.v = 1; continue; }
          // up quickly, along low, down gliding in
          const e = u * u * (3 - 2 * u);
          tmp.lerpVectors(f.from, f.to, e);
          d.x = tmp.x; d.z = tmp.z;
          d.y = f.up * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.6;
          d.yaw = Math.atan2(f.to.x - f.from.x, f.to.z - f.from.z);
          d.A.fly.timeScale = u < 0.85 ? BEAT : BEAT * 0.7;
          continue;
        }
        d.y = Math.max(0, d.y - dt * 2);
        // where to: the duck wanders its stretch (home after a flight); the drake keeps behind her
        if (d === hen) {
          if (!d.goal || Math.hypot(d.goal[0] - d.x, d.goal[1] - d.z) < 0.6) {
            const home = now > away && (d.z < HOME[0] || d.z > HOME[1]);
            d.goal = home ? near(Math.max(HOME[0], Math.min(HOME[1], d.z)) - 6, Math.max(HOME[0], Math.min(HOME[1], d.z)) + 6) : near(Math.max(HOME[0], d.z - 12), Math.min(HOME[1], d.z + 12));
            if (now < away) d.goal = [d.x + Math.sin(d.yaw) * 2, d.z + Math.cos(d.yaw) * 2];
          }
        } else d.goal = [hen.x - Math.sin(hen.yaw) * 1.3 + Math.cos(hen.yaw) * 0.5, hen.z - Math.cos(hen.yaw) * 1.3 - Math.sin(hen.yaw) * 0.5];
        // up-ending, preening or a flap of the wings now and then (not after dark)
        d.next -= dt;
        if (!d.shot && d.next <= 0 && !night) {
          const r = rng();
          startShot(d, Object.keys(SHOTS).find((n) => r < SHOTS[n]));
          d.next = rand(15, 50);
        }
        if (d.shot) {
          const a = d.A[d.shot];
          // the flap's beats ring the water; the up-ending's end too
          if (d.shot === 'flap' && a.time > 0.6 + d.beats * 0.43 && d.beats < 4) { d.beats++; splashes.push({ x: d.x, z: d.z, amp: 0.5, r: 0.07 }); }
          if (a.time >= a.getClip().duration) {
            if (d.shot === 'dabble') splashes.push({ x: d.x, z: d.z, amp: 0.35, r: 0.06 });
            endShot(d);
          }
        }
        const still = !!d.shot || night;
        // paddling: towards the goal, turning gently, round the rocks
        const gx = d.goal[0] - d.x, gz = d.goal[1] - d.z, gd = Math.hypot(gx, gz);
        let head = Math.atan2(gx, gz);
        for (let i = 0; i < 9; i++) {
          const h = head + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.35;
          if (water(d.x + Math.sin(h) * 1.2, d.z + Math.cos(h) * 1.2)) { head = h; break; }
        }
        const turn = Math.atan2(Math.sin(head - d.yaw), Math.cos(head - d.yaw));
        if (!still || d.shot === 'preen') d.yaw += THREE.MathUtils.clamp(turn, -0.8 * dt, 0.8 * dt) * (still ? 0.3 : 1);
        const want = still ? 0 : Math.min(SWIM * (d === drake && gd > 2 ? 1.5 : 1), gd * 0.5) * Math.max(0.2, Math.cos(turn));
        d.v += (want - d.v) * Math.min(1, dt * 1.5);
        const nx = d.x + Math.sin(d.yaw) * d.v * dt, nz = d.z + Math.cos(d.yaw) * d.v * dt;
        if (water(nx, nz)) { d.x = nx; d.z = nz; } else d.v *= 0.5;
        if (d.v > 0.08 && (d.paddle -= dt) <= 0) { d.paddle = rand(1.2, 2); splashes.push({ x: d.x - Math.sin(d.yaw) * 0.25, z: d.z - Math.cos(d.yaw) * 0.25, amp: 0.25, r: 0.05 }); }
      }
      for (const d of ducks) {
        // afloat: the model's waterline on the water, bobbing a little
        const bob = d.state === 'fly' ? 0 : Math.sin(now * 1.7 + d.k * 2) * 0.004;
        d.root.position.set(d.x, d.y + bob, d.z);
        d.root.rotation.set(0, d.yaw, 0);
        const far = ctx.camera.position.distanceTo(d.root.position) > FAR;
        d.nearM.visible = ctx.warming || !far;
        d.farM.visible = ctx.warming || far;
        pose(d, dt, night);
      }
    },
    // debug: each duck's state and place; calm: they mind no one; at: [x, z, yaw]: the pair put there, the duck facing
    // yaw; fly: take off now as if startled; act: the duck starts that one-shot now (dabble, preen, flap)
    info(o = {}) {
      if (o.calm !== undefined) calm = !!o.calm;
      if (o.at) {
        for (const d of ducks) { endShot(d); d.state = 'swim'; d.goal = null; d.v = 0; d.y = 0; d.w.fly = 0; d.yaw = o.at[2] ?? 0; d.next = rand(20, 40); }
        hen.x = o.at[0]; hen.z = o.at[1]; drake.x = o.at[0] + 0.8; drake.z = o.at[1] - 1.2;
      }
      if (o.fly) takeOff(new THREE.Vector3(hen.x, 0, hen.z + 5));
      if (o.act && hen.state !== 'fly') { endShot(hen); startShot(hen, o.act); }
      return ducks.map((d) => ({ state: d.state, x: +d.x.toFixed(2), y: +d.y.toFixed(2), z: +d.z.toFixed(2), yaw: +d.yaw.toFixed(2), v: +d.v.toFixed(2) }));
    },
  };
}
