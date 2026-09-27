// Two kittens living under the cherry tree. Each has needs (energy, playfulness, company, grooming) that drift
// with what it does and with the time of day; when an action ends it picks the next one by weighing them. Actions
// are generators (one step per frame) built from a few motor primitives: walk or run to a point, turn, take a
// posture, look at something, reach with a paw, leap. The two play together now and then (stalk and pounce,
// wrestle, chase, box, greet and groom each other) and sleep close together at night. Rain sends them under the
// tree, thunder startles them, falling petals get hunted.
import * as THREE from 'three/webgpu';
import { KittenRig, PK } from './kitten-rig.js';
import { BONE } from './kitten-body.js';
import { makeKittenModel } from './kitten.js';
import { mulberry32, clamp, lerp } from './noise.js';

const V = THREE.Vector3;
const TAU = Math.PI * 2;
const SHELTER_RAIN = 0.2; // drizzle (0.3) and up sends them under the tree
const angDiff = (a, b) => ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

export const KITTENS = [
  { name: 'Mike', coat: 'calico', seed: 1, eyeColor: [0.4, 0.45, 0.1] },
  { name: 'Chatora', coat: 'ginger', seed: 2, eyeColor: [0.75, 0.45, 0.06] },
];

// ---------- motor primitives (generators: one step per frame) ----------
function* wait(k, sec, each) { for (let t = 0; t < sec; t += k.dt) { if (each) each(t); yield; } }

function* walkTo(k, x, z, o = {}) {
  k.goal = { x, z, speed: o.speed ?? 0.32, arrive: o.arrive ?? 0.08, done: false };
  if (o.posture !== false) k.pose(o.posture || 'stand', o.rate ?? 6, o.mods);
  for (let t = 0; !k.goal.done && t < (o.timeout ?? 12); t += k.dt) {
    if (o.each && o.each(t) === false) break;
    yield;
  }
  k.goal = null;
}

// follow a moving point (another kitten) until `until` says stop
function* follow(k, target, o = {}) {
  k.goal = { x: target.x, z: target.z, speed: o.speed ?? 1, arrive: o.arrive ?? 0.2, done: false };
  if (o.posture !== false) k.pose(o.posture || 'stand', o.rate ?? 6, o.mods);
  for (let t = 0; t < (o.timeout ?? 8); t += k.dt) {
    k.goal.x = target.x; k.goal.z = target.z; k.goal.done = false;
    if (o.until && o.until(t)) break;
    yield;
  }
  k.goal = null;
}

function* turnTo(k, x, z, rate = 3) {
  k.faceYaw = Math.atan2(x - k.rig.x, z - k.rig.z); k.faceRate = rate;
  for (let t = 0; t < 3 && Math.abs(angDiff(k.rig.yaw, k.faceYaw)) > 0.15; t += k.dt) yield;
  k.faceYaw = null;
}

function* leap(k, x, z, h = 0.1) {
  const d = Math.hypot(x - k.rig.x, z - k.rig.z);
  k.jump = { x0: k.rig.x, z0: k.rig.z, x1: x, z1: z, t: 0, dur: 0.22 + d * 0.28, h: h + d * 0.08 };
  k.pose('leap', 14);
  while (k.jump) yield;
}

// ---------- looking ----------
const petalPos = (petals, i, out = new V()) => out.set(petals.pos[i * 3], petals.pos[i * 3 + 1], petals.pos[i * 3 + 2]);

// something to glance at: a petal drifting down nearby, the other kitten, the camera if close, or around
function glance(k) {
  const e = k.env, r = k.rng();
  if (r < 0.3) {
    const i = e.findPetal(k, 3.5, false);
    if (i >= 0) { const p = new V(); return () => petalPos(e.petals, i, p); }
  }
  if (r < 0.55 && k.other.visibleTo(k)) return () => k.other.rig.J[BONE.head];
  if (r < 0.7 && e.camera.distanceTo(k.headPos) < 5) return () => e.camera;
  const a = k.rig.yaw + (k.rng() - 0.5) * 2.6, d = 1 + k.rng() * 3, p = new V(k.rig.x + Math.sin(a) * d, e.ground(k.rig.x, k.rig.z) + k.rng() * 1.5, k.rig.z + Math.cos(a) * d);
  return () => p;
}

function* lookAround(k, sec, blinkAtCamera = true) {
  for (let t = 0; t < sec;) {
    const tgt = glance(k), hold = 0.7 + k.rng() * 2.3;
    const atCam = tgt() === k.env.camera;
    for (let s = 0; s < hold && t < sec; s += k.dt, t += k.dt) {
      k.rig.look = tgt();
      // a slow blink back at whoever watches (cats say hello that way)
      if (atCam && blinkAtCamera && s > 0.6 && s < 1.4) k.rig.target[PK.eyes] = 0.25;
      else if (atCam) k.rig.target[PK.eyes] = k.eyesBase;
      yield;
    }
  }
  k.rig.look = null;
}

// ---------- solo actions ----------
function* idle(k) {
  const sit = k.rng() < 0.65;
  k.pose(sit ? 'sit' : 'stand', 3);
  k.tail(0.12, 0.5);
  yield* lookAround(k, 3 + k.rng() * 7);
}

function* wander(k) {
  const p = k.env.spot(k.rig.x, k.rig.z, 0.7, 2.6, k.rng);
  const trot = k.rng() < 0.25 * k.energy;
  k.tail(0.1, 0.8);
  yield* walkTo(k, p.x, p.z, { speed: trot ? 0.75 : 0.26 + k.rng() * 0.1 });
  if (k.rng() < 0.6) {
    // sniff the ground
    k.pose('stand', 4, { neck: -0.75, head: -0.35, earFwd: 0.25 });
    yield* wait(k, 1 + k.rng() * 1.5);
  }
}

// paw targets in the head's frame (from the head joint): at the mouth, over the cheek, behind the ear
const MOUTH = new V(0.009, -0.012, 0.05), CHEEK = new V(0.022, 0.012, 0.035), EAR = new V(0.028, 0.032, 0.012);

function* groom(k) {
  k.pose('sit', 3);
  k.rig.look = null;
  k.tail(0.05, 0.4);
  yield* wait(k, 1);
  for (let n = 1 + Math.floor(k.rng() * 2.5); n > 0; n--) {
    const side = k.rng() < 0.5 ? 1 : -1, kind = k.rng();
    if (kind < 0.55) {
      // lick the paw, then wipe the face with it (a few passes)
      k.reach(side, MOUTH.clone().setX(MOUTH.x * side));
      k.pose('sit', 4, { neck: -0.1, head: -0.35, eyes: 0.45 });
      yield* wait(k, 1.2 + k.rng() * 1.5, (t) => { k.rig.target[PK.head] = -0.35 + Math.sin(t * 11) * 0.09; });
      for (let w = 0; w < 1 + Math.floor(k.rng() * 2.5); w++) {
        yield* wait(k, 0.55, (t) => {
          const f = t / 0.55;
          k.pawLocal.lerpVectors(MOUTH, f < 0.6 ? CHEEK : EAR, f < 0.6 ? f / 0.6 : 1).setX(k.pawLocal.x * side);
          k.rig.target[PK.headRoll] = side * 0.35 * Math.sin(f * Math.PI);
          k.rig.target[PK.head] = -0.2 - 0.25 * Math.sin(f * Math.PI);
        });
        k.pawLocal.copy(MOUTH).setX(MOUTH.x * side);
        yield* wait(k, 0.5, (t) => { k.rig.target[PK.head] = -0.35 + Math.sin(t * 11) * 0.08; });
      }
      k.reach(0);
    } else if (kind < 0.8) {
      // chest
      k.pose('sit', 4, { neck: -1.05, head: -0.55, eyes: 0.35 });
      yield* wait(k, 1.5 + k.rng() * 2, (t) => { k.rig.target[PK.head] = -0.55 + Math.sin(t * 10) * 0.12; });
    } else {
      // flank: the head turned right round to the side
      k.pose('sit', 3, { eyes: 0.4, bend: side * 0.5, headRoll: side * 0.3 });
      const hip = new V();
      yield* wait(k, 1.8 + k.rng() * 2, (t) => {
        hip.copy(k.rig.J[BONE.pelvis]).addScaledVector(k.rig.side, side * 0.12);
        hip.y -= 0.02 - Math.sin(t * 10) * 0.012;
        k.rig.look = hip;
      });
      k.rig.look = null;
    }
    k.pose('sit', 3);
    yield* wait(k, 0.4 + k.rng() * 0.8);
  }
  k.groomNeed = 0;
}

function* stretch(k) {
  k.pose('bow', 2.5, { eyes: 0.35 });
  k.tail(0.05, 0.4);
  yield* wait(k, 1.8);
  // hind legs: body forward, one leg back at a time
  k.pose('stand', 3, { pitch: 0.12, hipZ: -0.06, HLz: -0.13, flat: 0.25, eyes: 0.5 });
  yield* wait(k, 0.9);
  k.pose('stand', 3, { pitch: 0.12, hipZ: -0.06, HRz: -0.13, flat: 0.25, eyes: 0.5 });
  yield* wait(k, 0.9);
  k.pose('stand', 4);
  yield* wait(k, 0.4);
}

function* rest(k) {
  k.pose('loaf', 2);
  k.tail(0.04, 0.3);
  k.eyesBase = 0.55;
  for (let t = 0, T = 10 + k.rng() * 20; t < T && k.energy < 0.97;) {
    const s = 1.5 + k.rng() * 4;
    yield* lookAround(k, s);
    t += s;
    k.rig.target[PK.eyes] = 0.5;
  }
  k.eyesBase = 1;
}

function* sleep(k) {
  const spot = k.env.sleepSpot(k);
  yield* walkTo(k, spot.x, spot.z, { speed: 0.28 });
  // turn once round on the spot, then settle
  k.pose('stand', 4);
  const y0 = k.rig.yaw;
  yield* wait(k, 1.8, (t) => { k.faceYaw = y0 + (t / 1.8) * TAU * 0.9; k.faceRate = 4; });
  k.faceYaw = null;
  k.pose('loaf', 2.5);
  yield* wait(k, 2.2);
  k.sleeping = true;
  k.pose('curl', 1.1, null, k.rng() < 0.5 ? 1 : -1);
  k.rig.breathRate = 1.1;
  k.tail(0.02, 0.2);
  for (let t = 0; k.energy < 0.98 || t < 20; t += k.dt) {
    // ears and the tail tip twitch now and then
    if (k.rng() < k.dt * 0.12) k.twitch = 0.4;
    if (k.env.day > 0.5 && k.env.rain < SHELTER_RAIN && k.energy > 0.9 && t > 25) break;
    if (k.woken) break;
    yield;
  }
  k.sleeping = false; k.woken = false;
  k.rig.breathRate = 1.9;
  k.pose('loaf', 1.5, { eyes: 0.4 });
  yield* wait(k, 2);
  k.pose('loaf', 3);
  yield* wait(k, 1);
  yield* stretch(k);
}

// a drifting petal: watch it fall, stalk its landing spot, wiggle, pounce, pin it; bat it if it passes low
function* hunt(k) {
  const e = k.env, i = e.findPetal(k, 3, true);
  if (i < 0) return;
  const p = new V(), land = new V();
  k.excite = 1;
  k.pose('alert', 5, { earFwd: 0.45 });
  k.tail(0.28, 2.2);
  let last = petalPos(e.petals, i, new V());
  for (let t = 0; t < 7; t += k.dt) {
    petalPos(e.petals, i, p);
    if (p.distanceTo(last) > 0.6) break; // gone (blown away and respawned)
    last.copy(p);
    k.rig.look = p;
    const g = e.ground(p.x, p.z), h = p.y - g;
    const vy = Math.min(-0.2, e.petals.vel[i * 3 + 1]);
    land.set(p.x + e.petals.vel[i * 3] * (h / -vy), g, p.z + e.petals.vel[i * 3 + 2] * (h / -vy));
    const dist = Math.hypot(land.x - k.rig.x, land.z - k.rig.z);
    if (!e.valid(land.x, land.z, 0.1)) break;
    // low and close: bat it out of the air, standing up
    const dx = Math.hypot(p.x - k.rig.x, p.z - k.rig.z);
    if (h > 0.12 && h < 0.34 && dx < 0.24) {
      k.goal = null;
      yield* turnTo(k, p.x, p.z, 6);
      k.pose('rear', 9);
      const side = k.rng() < 0.5 ? 1 : -1;
      k.reach(side, null, p);
      yield* wait(k, 0.45, () => { petalPos(e.petals, i, p); k.pawTarget.copy(p); });
      k.reach(0);
      k.pose('crouch', 5);
      yield* wait(k, 0.5);
      continue;
    }
    if (h < 0.35 && dist < 0.6) {
      // the wiggle, then the pounce
      k.goal = null;
      yield* turnTo(k, land.x, land.z, 5);
      k.pose('crouch', 6, { hipY: 0.07, earFwd: 0.5 });
      k.rig.wiggle = 1;
      yield* wait(k, 0.5 + k.rng() * 0.6, () => { petalPos(e.petals, i, p); k.rig.look = p; });
      k.rig.wiggle = 0;
      const tx = e.petals.mode[i] === 0 ? land.x : p.x, tz = e.petals.mode[i] === 0 ? land.z : p.z;
      const back = Math.max(0, Math.hypot(tx - k.rig.x, tz - k.rig.z) - 0.1) / Math.max(1e-3, Math.hypot(tx - k.rig.x, tz - k.rig.z));
      yield* leap(k, k.rig.x + (tx - k.rig.x) * back, k.rig.z + (tz - k.rig.z) * back, 0.06);
      k.pose('pin', 8);
      k.rig.look = land.set(tx, e.ground(tx, tz), tz);
      yield* wait(k, 1.2 + k.rng());
      k.playful = Math.max(0, k.playful - 0.35);
      break;
    }
    if (h < 1.2 && dist > 0.35) {
      // creep closer, low
      k.goal = { x: land.x - Math.sin(k.rig.yaw) * 0.3, z: land.z - Math.cos(k.rig.yaw) * 0.3, speed: 0.3, arrive: 0.1, done: false };
      k.pose('crouch', 4, { earFwd: 0.45 });
    } else if (h >= 1.2) {
      k.goal = null;
      k.pose('alert', 4, { earFwd: 0.45 });
    }
    yield;
  }
  k.goal = null; k.excite = 0; k.rig.look = null;
}

// racing around the tree, ears back, then stopping dead as if nothing happened
function* zoomies(k) {
  const e = k.env, dir = k.rng() < 0.5 ? 1 : -1, R = 1.7 + k.rng() * 1.1;
  let a = Math.atan2(k.rig.x - e.tx, k.rig.z - e.tz);
  k.excite = 1;
  k.tail(0.1, 1);
  const laps = 0.8 + k.rng() * 0.8;
  for (let s = 0; s < laps * 8; s++) {
    a += (dir * TAU) / 8;
    const x = e.tx + Math.sin(a) * R, z = e.tz + Math.cos(a) * R;
    if (!e.valid(x, z, 0.1)) continue;
    yield* walkTo(k, x, z, { speed: 2.3, arrive: 0.45, mods: { earOut: 0.7, tailUp: 0.9, tailCurl: 0 }, timeout: 3 });
  }
  k.pose('stand', 7, { earFwd: 0.2 });
  yield* wait(k, 0.8);
  k.excite = 0;
  k.energy -= 0.1; k.playful = Math.max(0, k.playful - 0.5);
  if (k.rng() < 0.6) yield* groom(k);
}

// shaking the rain off (or off after a nap)
function* shake(k) {
  k.pose('stand', 5, { eyes: 0.3 });
  yield* wait(k, 0.8, (t) => { k.rig.headTilt = Math.sin(t * 45) * 0.55 * Math.sin((t / 0.8) * Math.PI); });
  k.rig.headTilt = 0;
}

function* shelter(k) {
  const s = k.env.shelterSpot(k);
  yield* walkTo(k, s.x, s.z, { speed: 1.2, mods: { earOut: 0.4 } });
  yield* turnTo(k, s.fx, s.fz);
  k.pose('loaf', 2, { earOut: 0.35, eyes: 0.7 });
  k.tail(0.03, 0.3);
  while (k.env.rain > SHELTER_RAIN - 0.08) {
    if (k.energy < 0.35 && !k.sleeping) { yield* sleep(k); continue; }
    yield* lookAround(k, 2 + k.rng() * 3, false);
  }
  yield* shake(k);
}

// thunder: flinch low, ears flat, stare towards it
function* startle(k) {
  k.goal = null;
  k.pose('crouch', 12, { earOut: 1, earFwd: -0.3, hipY: 0.065, tailUp: -0.8 });
  k.excite = 1;
  yield* wait(k, 1.2 + k.rng());
  k.excite = 0;
}

// ---------- together ----------
// A stalks B and pounces; they wrestle (B rolled over, kicking; A batting); then one runs and the other chases
function* ambush(a, b, S) {
  a.contact = true;
  a.excite = 1;
  a.tail(0.3, 2.5);
  yield* follow(a, b.rig, { speed: 0.3, posture: 'crouch', mods: { earFwd: 0.45 }, until: () => Math.hypot(b.rig.x - a.rig.x, b.rig.z - a.rig.z) < 0.55, timeout: 10 });
  a.rig.look = b.rig.J[BONE.head];
  yield* turnTo(a, b.rig.x, b.rig.z, 5);
  a.pose('crouch', 6, { hipY: 0.068, earFwd: 0.5 });
  a.rig.wiggle = 1;
  S.stage = 'wiggle';
  yield* wait(a, 0.6 + a.rng() * 0.6);
  a.rig.wiggle = 0;
  const d = Math.hypot(b.rig.x - a.rig.x, b.rig.z - a.rig.z), f = Math.max(0, d - 0.2) / d;
  S.stage = 'pounce';
  yield* leap(a, a.rig.x + (b.rig.x - a.rig.x) * f, a.rig.z + (b.rig.z - a.rig.z) * f, 0.07);
  S.stage = 'wrestle';
  if (S.plays) yield* wrestleTop(a, b, S);
  else { a.pose('crouch', 6, { earOut: 0.6 }); yield* wait(a, 0.9); S.stage = 'break'; }
}

function* wrestleTop(a, b, S) {
  a.contact = true;
  a.pose('crouch', 8, { hipY: 0.09, pitch: 0.1, earOut: 0.5 });
  a.rig.look = b.rig.J[BONE.head];
  const T = 2 + a.rng() * 2.5;
  let side = 1;
  yield* wait(a, T, (t) => {
    // bat at the other's head, paw after paw
    if (Math.floor(t * 3.2) % 2 === 0) { if (side !== 1) { side = 1; a.reach(1, null, b.rig.J[BONE.head]); } }
    else if (side !== -1) { side = -1; a.reach(-1, null, b.rig.J[BONE.head]); }
    a.pawTarget.copy(b.rig.J[BONE.head]);
    a.rig.target[PK.hipY] = 0.09 + Math.sin(t * 9) * 0.012;
  });
  a.reach(0);
  S.stage = 'break';
}

function* wrestleBottom(b, a, S) {
  b.contact = true;
  b.goal = null;
  // it sees it coming at the last moment
  while (S.stage === 'stalk' || S.stage === 'wiggle') { if (b.rng() < b.dt * 0.6) b.rig.look = a.rig.J[BONE.head]; yield; }
  while (S.stage === 'pounce') { b.rig.look = a.rig.J[BONE.head]; yield; }
  yield* turnTo(b, a.rig.x, a.rig.z, 6);
  const side = b.rng() < 0.5 ? 1 : -1;
  b.pose('back', 6, { earOut: 0.6 }, side);
  b.excite = 1;
  b.rig.look = a.rig.J[BONE.head];
  // bunny kicks and swats from below
  const base = b.rig.target.slice();
  while (S.stage === 'wrestle') {
    const t = (b.kickT = (b.kickT || 0) + b.dt);
    b.rig.target[PK.HLy] = base[PK.HLy] + Math.max(0, Math.sin(t * 13)) * 0.04;
    b.rig.target[PK.HRy] = base[PK.HRy] + Math.max(0, Math.sin(t * 13 + 1.2)) * 0.04;
    b.rig.target[PK.FLz] = base[PK.FLz] + Math.sin(t * 7) * 0.03;
    b.rig.target[PK.FRz] = base[PK.FRz] + Math.sin(t * 7 + 2) * 0.03;
    yield;
  }
  b.pose('stand', 8, { earOut: 0.3 });
  yield* wait(b, 0.35);
}

// the one who runs off, glancing back; the other gives chase
function* flee(k, other, S) {
  k.contact = true;
  k.excite = 1;
  k.tail(0.1, 1.5);
  for (let n = 0; n < 2 + Math.floor(k.rng() * 2); n++) {
    const p = k.env.spot(k.rig.x, k.rig.z, 1.4, 2.8, k.rng);
    yield* walkTo(k, p.x, p.z, { speed: 1.9 + k.rng() * 0.5, arrive: 0.3, mods: { earOut: 0.5, tailUp: 0.9 }, timeout: 4 });
  }
  S.stage = 'caught';
  k.pose('stand', 6);
  k.rig.look = other.rig.J[BONE.head];
  yield* turnTo(k, other.rig.x, other.rig.z, 6);
}
function* chase(k, other, S) {
  k.contact = true;
  k.excite = 1;
  k.tail(0.2, 1.5);
  yield* wait(k, 0.3);
  k.rig.look = other.rig.J[BONE.head];
  yield* follow(k, other.rig, { speed: 1.9, arrive: 0.3, mods: { earOut: 0.3, tailUp: 0.6 }, until: () => S.stage === 'caught', timeout: 14 });
  k.pose('stand', 6);
  yield* turnTo(k, other.rig.x, other.rig.z, 6);
}

// both up on their hind legs, swatting
function* box(k, other, S) {
  k.contact = true;
  k.excite = 1;
  yield* walkTo(k, S.mid.x + (k === S.a ? -1 : 1) * S.dir.x * 0.13, S.mid.z + (k === S.a ? -1 : 1) * S.dir.z * 0.13, { speed: 0.5, arrive: 0.05 });
  yield* turnTo(k, other.rig.x, other.rig.z, 6);
  k.pose('rear', 6, { earOut: 0.5 });
  k.rig.look = other.rig.J[BONE.head];
  let side = 0;
  yield* wait(k, 1.8 + S.len, (t) => {
    const s = Math.floor((t + (k === S.a ? 0 : 0.18)) * 2.6) % 2 ? 1 : -1;
    if (s !== side) { side = s; k.reach(s, null, other.rig.J[BONE.head]); }
    k.pawTarget.copy(other.rig.J[BONE.head]);
  });
  k.reach(0);
  k.pose('stand', 6);
  yield* wait(k, 0.3);
}

// nose to nose, a head rub, then one grooms the other's head
function* greet(k, other, S) {
  k.contact = true;
  k.tail(0.1, 0.6);
  k.pose('alert', 4, { tailUp: 1, tailCurl: 0.7 });
  if (k === S.a) {
    yield* follow(k, other.rig, { speed: 0.3, arrive: 0.27, posture: 'alert', mods: { tailUp: 1, tailCurl: 0.7 }, until: () => Math.hypot(other.rig.x - k.rig.x, other.rig.z - k.rig.z) < 0.28, timeout: 10 });
    S.stage = 'nose';
  } else {
    while (S.stage === 'approach') { k.rig.look = other.rig.J[BONE.head]; yield; }
  }
  yield* turnTo(k, other.rig.x, other.rig.z, 4);
  k.rig.look = other.rig.J[BONE.head];
  k.pose('alert', 4, { tailUp: 1, tailCurl: 0.7, neck: 0.1 });
  yield* wait(k, 1.2);
  if (k === S.a) {
    // groom: licking the other's head and ears
    k.pose('sit', 3, { eyes: 0.5 });
    const p = new V();
    yield* wait(k, 3 + S.len * 2, (t) => { p.copy(other.rig.J[BONE.head]); p.y += 0.035 + Math.sin(t * 10) * 0.012; k.rig.look = p; });
  } else {
    k.pose('sit', 3, { eyes: 0.3, headRoll: 0.35 });
    k.rig.look = null;
    yield* wait(k, 3 + S.len * 2);
  }
  k.social = 0;
}

// sleeping kitten gets pounced on: it plays along, or swats once and settles again
function* wakeUp(k, other, S) {
  while (S.stage === 'stalk' || S.stage === 'wiggle' || S.stage === 'pounce') yield;
  if (S.plays) yield* wrestleBottom(k, other, S);
  else {
    k.pose('loaf', 6, { earOut: 0.8, eyes: 0.6 });
    k.rig.look = other.rig.J[BONE.head];
    k.reach(1, null, other.rig.J[BONE.head]);
    yield* wait(k, 0.4, () => k.pawTarget.copy(other.rig.J[BONE.head]));
    k.reach(0);
    yield* wait(k, 1.5);
    S.stage = 'break';
    yield* sleep(k);
  }
}

// ---------- the kitten ----------
class Kitten {
  constructor(i, env, model, rng, start) {
    this.i = i; this.env = env; this.m = model; this.rng = rng;
    this.rig = new KittenRig(env.ground, rng);
    this.rig.x = start.x; this.rig.z = start.z; this.rig.yaw = start.yaw;
    this.energy = 0.55 + rng() * 0.4; this.playful = 0.3 + rng() * 0.4; this.social = rng() * 0.5; this.groomNeed = rng() * 0.6;
    this.v = 0; this.goal = null; this.faceYaw = null; this.faceRate = 3; this.jump = null;
    this.gen = null; this.act = 'none'; this.pair = null;
    this.contact = false; this.sleeping = false; this.woken = false;
    this.excite = 0; this.exciteS = 0; this.eyesBase = 1;
    this.swishT = 0.12; this.swishRateT = 0.8; this.twitch = 0;
    this.pawSide = 0; this.pawW = 0; this.pawLocal = new V(); this.pawTarget = new V();
    this.headPos = this.rig.J[BONE.head];
    this.dt = 1 / 60;
  }
  pose(name, rate, mods, side = 1) {
    this.rig.setPosture(name, rate, side);
    if (mods) for (const k in mods) this.rig.target[PK[k]] = mods[k];
    if (this.eyesBase < 1 && !(mods && 'eyes' in mods)) this.rig.target[PK.eyes] = Math.min(this.rig.target[PK.eyes], this.eyesBase);
  }
  tail(swish, rate) { this.swishT = swish; this.swishRateT = rate; }
  // reach with a front paw (side 1 left, -1 right; 0 = put it down): a point in the head's frame or in the world
  reach(side, local, world) {
    if (!side) { this.pawSide = 0; return; }
    if (this.pawSide && this.pawSide !== side) this.rig.paw.w = 0;
    this.pawSide = side; this.rig.paw.side = side;
    if (local) { this.pawLocal.copy(local); this.rig.paw.local = this.pawLocal; }
    else { this.rig.paw.local = null; this.pawTarget.copy(world); this.rig.paw.target = this.pawTarget; }
  }
  visibleTo(k) { return Math.hypot(this.rig.x - k.rig.x, this.rig.z - k.rig.z) < 5; }
  run(gen, name, pair = null) { this.stop(); this.gen = gen; this.act = name; this.pair = pair; }
  stop() {
    this.gen = null; this.goal = null; this.faceYaw = null; this.pair = null; this.contact = false;
    this.reach(0); this.rig.wiggle = 0; this.rig.look = null; this.rig.headTilt = 0; this.excite = 0; this.eyesBase = 1;
    if (this.sleeping) { this.sleeping = false; this.rig.breathRate = 1.9; }
    if (this.jump) { this.rig.x = this.jump.x1; this.rig.z = this.jump.z1; this.jump = null; this.rig.jumpY = 0; this.rig.airborne = 0; this.rig.jumpPitch = 0; }
  }
  // free for a game together (a sleeper only gets pounced on, see decide)
  interruptible() { return !this.pair && !this.jump && ['idle', 'wander', 'rest', 'groom', 'none'].includes(this.act); }

  decide() {
    const e = this.env, o = this.other;
    if (e.rain > SHELTER_RAIN) return this.run(shelter(this), 'shelter');
    // together: when both are free and it wants company or play
    if (o.interruptible() && !o.sleeping && this.energy > 0.3 && o.energy > 0.25 && this.rng() < 0.2 + this.social * 0.4 + this.playful * 0.3) {
      if (startPair(this, o)) return;
    }
    if (o.sleeping && this.playful > 0.7 && this.energy > 0.5 && this.rng() < 0.15) { if (startPair(this, o, 'pounceSleeper')) return; }
    const night = e.night, dusk = e.dusk;
    const petalsNear = e.findPetal(this, 3, true) >= 0 ? 1 : 0.05;
    const W = [
      ['idle', 1.2, idle],
      ['wander', 1.1 * this.energy, wander],
      ['groom', this.groomNeed * 2.2, groom],
      ['rest', (1 - this.energy) * 1.6 + night * 0.8, rest],
      ['sleep', this.energy < 0.4 ? (1 - this.energy) * 4 + night * 6 : night * 1.5 * (1 - this.energy), sleep],
      ['hunt', this.playful * this.energy * 3.5 * petalsNear * (1 + e.wind) * (1 - night * 0.7), hunt],
      ['zoomies', this.playful * this.energy * (0.35 + dusk * 1.5) * (1 - night * 0.8), zoomies],
      ['stretch', 0.15, stretch],
    ];
    let sum = 0;
    for (const w of W) sum += Math.max(0, w[1]);
    let r = this.rng() * sum;
    for (const [name, w, fn] of W) { r -= Math.max(0, w); if (r <= 0) return this.run(fn(this), name); }
    this.run(idle(this), 'idle');
  }

  needs(dt) {
    const act = this.act, run = this.v > 1 ? 1 : 0;
    if (this.sleeping) this.energy += dt * 0.012;
    else if (act === 'rest') this.energy += dt * 0.003;
    else this.energy -= dt * (0.0025 + run * 0.012 + this.exciteS * 0.004);
    if (!this.sleeping) {
      this.playful += dt * (this.energy > 0.4 ? 0.012 : 0.003) * (1 + this.env.dusk);
      this.social += dt * 0.005;
      this.groomNeed += dt * (act === 'shelter' ? 0.01 : 0.004);
    }
    this.energy = clamp(this.energy, 0, 1); this.playful = clamp(this.playful, 0, 1); this.social = clamp(this.social, 0, 1); this.groomNeed = clamp(this.groomNeed, 0, 1);
  }

  motor(dt) {
    const r = this.rig, e = this.env;
    if (this.jump) {
      const j = this.jump;
      j.t = Math.min(1, j.t + dt / j.dur);
      const s = j.t;
      r.x = lerp(j.x0, j.x1, s); r.z = lerp(j.z0, j.z1, s);
      r.jumpY = 4 * j.h * s * (1 - s); r.jumpPitch = (0.5 - s) * 0.7; r.airborne = 1;
      r.speed = 0; r.turn = 0;
      if (j.t >= 1) { this.jump = null; r.jumpY = 0; r.jumpPitch = 0; r.airborne = 0; }
      return;
    }
    let want = 0, dir = r.yaw;
    if (this.goal) {
      const g = this.goal, dx = g.x - r.x, dz = g.z - r.z, d = Math.hypot(dx, dz);
      if (d < g.arrive) g.done = true;
      else {
        let sx = dx / d, sz = dz / d;
        // steer round the trunk, rocks and the other kitten
        for (const ob of e.obstacles(this)) {
          const ox = r.x - ob.x, oz = r.z - ob.z, od = Math.hypot(ox, oz) || 1e-3, clear = od - ob.r;
          if (clear > 0.6 || od > d + ob.r) continue;
          const w = ((0.6 - clear) / 0.6) * 1.4;
          sx += (ox / od) * w; sz += (oz / od) * w;
          // slide past on the side nearer the goal
          if (-(ox * dx + oz * dz) > 0) { const c = Math.sign(ox * dz - oz * dx) || 1; sx += (-oz / od) * c * w; sz += (ox / od) * c * w; }
        }
        dir = Math.atan2(sx, sz);
        want = g.speed * clamp(d / (g.speed * 0.5 + 0.08), 0.3, 1);
      }
    } else if (this.faceYaw !== null) dir = this.faceYaw;
    const err = angDiff(r.yaw, dir);
    const maxTurn = lerp(2.6, 5.5, clamp(this.v / 1.5, 0, 1)) * (this.goal ? 1 : this.faceRate / 3);
    const turn = this.goal || this.faceYaw !== null ? clamp(err * 6, -maxTurn, maxTurn) : 0;
    r.yaw += turn * dt;
    want *= clamp(1 - (Math.abs(err) - 0.5) / 1.1, 0.12, 1); // slow down for a sharp turn
    this.v += clamp(want - this.v, -4 * dt, (want > 1 ? 3.5 : 1.6) * dt);
    r.x += Math.sin(r.yaw) * this.v * dt; r.z += Math.cos(r.yaw) * this.v * dt;
    // never inside anything
    for (const ob of e.obstacles(this)) {
      const ox = r.x - ob.x, oz = r.z - ob.z, od = Math.hypot(ox, oz) || 1e-3;
      if (od < ob.r) { r.x = ob.x + (ox / od) * ob.r; r.z = ob.z + (oz / od) * ob.r; }
    }
    r.speed = this.v; r.turn = turn;
  }

  update(dt, t) {
    this.dt = dt;
    if (!this.gen) this.decide();
    if (this.gen && this.gen.next().done) { const p = this.pair; this.stop(); if (p) p.done(this); }
    this.motor(dt);
    this.needs(dt);
    const r = this.rig, k = 1 - Math.exp(-dt * 4);
    r.swish += (this.swishT - r.swish) * k; r.swishRate += (this.swishRateT - r.swishRate) * k;
    if (this.twitch > 0) { this.twitch -= dt; r.target[PK.earOut] = this.twitch > 0.2 ? 0.5 : 0; }
    // paw: reach in, hold, put down
    r.paw.w += ((this.pawSide ? 1 : 0) - r.paw.w) * (1 - Math.exp(-dt * (this.pawSide ? 14 : 8)));
    this.exciteS += (this.excite - this.exciteS) * k;
    this.m.uPupil.value = clamp(0.3 + (1 - this.env.sunVis) * 0.6 + this.exciteS * 0.5, 0, 1);
    r.update(dt, t);
    r.write(this.m.bones);
    this.m.setDistance(this.env.camera.distanceTo(r.J[BONE.chest]));
  }
}

// ---------- pair interactions ----------
function startPair(a, b, kind) {
  const d = Math.hypot(a.rig.x - b.rig.x, a.rig.z - b.rig.z);
  if (d > 4.5) return false;
  const r = a.rng();
  kind ||= a.playful > 0.45 && b.energy > 0.35 ? (r < 0.45 ? 'ambush' : r < 0.7 ? 'chase' : 'box') : 'greet';
  const S = { a, b, stage: 'stalk', len: a.rng(), n: 2, done() { if (--S.n <= 0) { a.social = b.social = 0; } } };
  const pair = { done: S.done };
  if (kind === 'ambush' || kind === 'pounceSleeper') {
    // a pounced-on sleeper plays along only if it has slept enough
    S.plays = kind === 'ambush' || b.energy > 0.45;
    a.run((function* () {
      yield* ambush(a, b, S);
      if (!S.plays) { a.pose('sit', 4); a.rig.look = b.rig.J[BONE.head]; yield* wait(a, 1.5); return; }
      S.aChases = a.rng() < 0.5; S.stage = 'run';
      yield* (S.aChases ? chase(a, b, S) : flee(a, b, S));
    })(), 'ambush', pair);
    b.run((function* () {
      yield* (kind === 'pounceSleeper' ? wakeUp(b, a, S) : wrestleBottom(b, a, S));
      if (!S.plays) return;
      while (S.stage !== 'run' && S.stage !== 'caught') yield;
      yield* (S.aChases ? flee(b, a, S) : chase(b, a, S));
    })(), 'wrestle', pair);
  } else if (kind === 'chase') {
    S.stage = 'run';
    const aRuns = a.rng() < 0.5;
    a.run(aRuns ? flee(a, b, S) : chase(a, b, S), aRuns ? 'flee' : 'chase', pair);
    b.run(aRuns ? chase(b, a, S) : flee(b, a, S), aRuns ? 'chase' : 'flee', pair);
  } else if (kind === 'box') {
    S.mid = { x: (a.rig.x + b.rig.x) / 2, z: (a.rig.z + b.rig.z) / 2 };
    if (!a.env.valid(S.mid.x, S.mid.z, 0.35)) return false;
    const l = d || 1; S.dir = { x: (b.rig.x - a.rig.x) / l, z: (b.rig.z - a.rig.z) / l };
    a.run(box(a, b, S), 'box', pair); b.run(box(b, a, S), 'box', pair);
  } else {
    S.stage = 'approach';
    a.run(greet(a, b, S), 'greet', pair); b.run(greet(b, a, S), 'greet', pair);
  }
  a.playful = Math.max(0, a.playful - 0.3); b.playful = Math.max(0, b.playful - 0.2);
  return true;
}

// ---------- assembly ----------
// height of the tree's surface roots at (x, z) (-Infinity off them): each root a tube of points (x, y, z, r)
function rootHeight(roots) {
  const box = roots.map((p) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 4) { x0 = Math.min(x0, p[i] - p[i + 3]); x1 = Math.max(x1, p[i] + p[i + 3]); z0 = Math.min(z0, p[i + 2] - p[i + 3]); z1 = Math.max(z1, p[i + 2] + p[i + 3]); }
    return [x0, x1, z0, z1];
  });
  return (x, z) => {
    let top = -Infinity;
    for (let k = 0; k < roots.length; k++) {
      const b = box[k];
      if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue;
      const p = roots[k];
      for (let i = 0; i + 4 < p.length; i += 4) {
        const ax = p[i], az = p[i + 2], bx = p[i + 4] - ax, bz = p[i + 6] - az;
        const t = clamp(((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz || 1), 0, 1);
        const d = Math.hypot(x - ax - bx * t, z - az - bz * t), r = lerp(p[i + 3], p[i + 7], t);
        if (d < r) top = Math.max(top, lerp(p[i + 1], p[i + 5], t) + Math.sqrt(r * r - d * d));
      }
    }
    return top;
  };
}

export function makeKittens({ world, data, tree, roots, rocks, petals, camera, a2c, shells, seed = 5 }) {
  const rng = mulberry32(seed);
  const R = 4.3; // how far from the trunk they go
  const rootAt = rootHeight(roots);
  const terrain = (x, z) => Math.max(world.heightFast(x, z), 0);
  const ground = (x, z) => Math.max(terrain(x, z), rootAt(x, z)); // they walk over the roots
  const camSide = { x: 13 / Math.hypot(13, 24), z: 24 / Math.hypot(13, 24) }; // the default view looks from here
  const fixed = [{ x: tree.x, z: tree.z, r: 0.85 }, ...rocks.map((r) => ({ x: r.x, z: r.z, r: r.sc * 0.8 + 0.06 }))];
  const env = {
    world, tx: tree.x, tz: tree.z, ground, petals, camera,
    rain: 0, night: 0, dusk: 0, day: 1, wind: 0, sunVis: 1,
    valid(x, z, pad = 0.15) {
      if (Math.hypot(x - tree.x, z - tree.z) > R) return false;
      if (world.heightFast(x, z) < 0.18) return false;
      if (rootAt(x, z) > terrain(x, z) + 0.12) return false; // not on top of a thick root
      for (const o of fixed) if (Math.hypot(x - o.x, z - o.z) < o.r + pad) return false;
      return true;
    },
    // somewhere to go, mostly on the side of the tree the default view sees
    spot(x, z, dmin, dmax, r) {
      for (let i = 0; i < 40; i++) {
        const a = r() * TAU, d = lerp(dmin, dmax, r());
        const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d;
        const dx = px - tree.x, dz = pz - tree.z, side = (dx * camSide.x + dz * camSide.z) / (Math.hypot(dx, dz) || 1);
        if (i < 30 && side < -0.2 && r() < 0.85) continue;
        if (env.valid(px, pz)) return { x: px, z: pz };
      }
      return { x: tree.x + 1.6, z: tree.z + 1.6 };
    },
    sleepSpot(k) {
      const o = k.other;
      if (o.sleeping || o.act === 'rest' || o.act === 'shelter') {
        // curl up against the other one
        const sx = o.rig.x + o.rig.side.x * 0.17, sz = o.rig.z + o.rig.side.z * 0.17;
        if (env.valid(sx, sz, 0.02)) return { x: sx, z: sz };
      }
      // in the open under the canopy, on the side the default view sees
      for (let i = 0; i < 30; i++) {
        const a = Math.atan2(camSide.x, camSide.z) + (k.rng() - 0.5) * 2.4, d = 1.3 + k.rng() * 1.2;
        const x = tree.x + Math.sin(a) * d, z = tree.z + Math.cos(a) * d;
        if (env.valid(x, z, 0.1)) return { x, z };
      }
      return env.spot(k.rig.x, k.rig.z, 0.3, 1.5, k.rng);
    },
    // against the trunk on the side away from the wind, next to each other
    shelterSpot(k) {
      const wd = env.windDir, base = Math.atan2(wd.x, wd.y) + (k.i ? 0.32 : -0.32); // windDir: where it blows to
      for (let i = 0; i < 12; i++) {
        const a = base + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.4;
        const x = tree.x + Math.sin(a) * 1.0, z = tree.z + Math.cos(a) * 1.0;
        if (env.valid(x, z, 0.05)) return { x, z, fx: tree.x + Math.sin(a) * 3, fz: tree.z + Math.cos(a) * 3 };
      }
      return { x: tree.x + 1, z: tree.z, fx: tree.x + 3, fz: tree.z };
    },
    // an airborne petal within reach, low enough to be worth it, landing where the kitten can go
    findPetal(k, maxD, landingOk) {
      const P = petals, n = P.active;
      let best = -1, bd = maxD;
      for (let i = (k.i * 7) % 5; i < n; i += 5) {
        if (P.mode[i] !== 0) continue;
        const x = P.pos[i * 3], y = P.pos[i * 3 + 1], z = P.pos[i * 3 + 2];
        const d = Math.hypot(x - k.rig.x, z - k.rig.z);
        if (d >= bd || y - ground(x, z) > 2.5) continue;
        if (landingOk && !env.valid(x, z, 0.1)) continue;
        best = i; bd = d;
      }
      return best;
    },
    obstacles(k) {
      const o = k.other;
      env._obs[fixed.length] = k.contact || o.contact ? env._far : { x: o.rig.x, z: o.rig.z, r: 0.2 };
      return env._obs;
    },
    _obs: [...fixed, null], _far: { x: 1e5, z: 1e5, r: 0 }, windDir: { x: 0.6, y: 0.8 },
  };
  const group = new THREE.Group();
  group.name = 'kittens';
  const kits = KITTENS.map((c, i) => {
    const model = makeKittenModel(data, { ...c, alphaToCoverage: a2c, shells });
    group.add(model.group);
    const s = env.spot(tree.x + 1.5 - i * 0.4, tree.z + 1.8, 0.2, 1.2, rng);
    return new Kitten(i, env, model, mulberry32(seed * 31 + i * 101), { x: s.x, z: s.z, yaw: rng() * TAU });
  });
  kits[0].other = kits[1]; kits[1].other = kits[0];
  let lastFlash = 0;

  return {
    group, kittens: kits,
    // ctx: { t, rain, wind, windDir, sunVis, lights (0 day .. 1 night), hour, flash }
    update(dt, ctx) {
      env.rain = ctx.rain; env.wind = ctx.wind; env.sunVis = ctx.sunVis; env.windDir = ctx.windDir;
      env.night = ctx.lights; env.day = 1 - ctx.lights;
      env.dusk = Math.exp(-(((ctx.hour - 18.2) / 1.2) ** 2)) + Math.exp(-(((ctx.hour - 6) / 1) ** 2)) * 0.6;
      for (const k of kits) {
        // rain and thunder interrupt whatever they are doing (a pair game included)
        if (env.rain > SHELTER_RAIN && k.act !== 'shelter' && k.act !== 'startle') k.run(shelter(k), 'shelter');
        if (ctx.flash > 0.5 && lastFlash <= 0.5 && k.act !== 'startle') {
          const back = env.rain > SHELTER_RAIN;
          k.run((function* () { yield* startle(k); if (back) { k.act = 'shelter'; yield* shelter(k); } })(), 'startle');
        }
        k.update(dt, ctx.t);
      }
      lastFlash = ctx.flash;
    },
    info() { return kits.map((k) => ({ act: k.act, x: +k.rig.x.toFixed(2), z: +k.rig.z.toFixed(2), energy: +k.energy.toFixed(2), playful: +k.playful.toFixed(2), social: +k.social.toFixed(2), sleeping: k.sleeping })); },
    // debug: make kitten i do something now ('idle', 'wander', 'groom', 'stretch', 'rest', 'sleep', 'hunt', 'zoomies', 'shake', or a pair game)
    act(i, name) {
      const k = kits[i], solo = { idle, wander, groom, stretch, rest, sleep, hunt, zoomies, shake, shelter, startle };
      // a game in progress ends for both (the other would wait on its partner)
      if (k.pair || k.other.pair) { k.stop(); k.other.stop(); }
      if (solo[name]) return k.run(solo[name](k), name), true;
      return startPair(k, k.other, name);
    },
  };
}
