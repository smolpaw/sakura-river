// Kitten rig: postures, gait, look, tail and leg IK -> one world matrix per bone (kitten-body.js's skeleton).
// A posture is a flat vector of parameters (POSE_KEYS); the behaviour picks a target posture, the rig eases the
// current one towards it and layers the motion on top: stepping feet, breathing, gaze, blinking, tail swish.
import * as THREE from 'three';
import { BONES, BONE, TAIL_N, TAIL_SEG } from './kitten-body.js';

const V = THREE.Vector3, Q = THREE.Quaternion;
const X = new V(1, 0, 0), Y = new V(0, 1, 0), Z = new V(0, 0, 1), NZ = new V(0, 0, -1);
const REST = BONES.map((b) => new V(...b.p));
const off = (a, b) => REST[BONE[b]].clone().sub(REST[BONE[a]]);
const OFF = BONES.map((b, i) => (b.parent < 0 ? new V() : REST[i].clone().sub(REST[b.parent]))); // rest offset from the parent joint
const qa = (axis, a, q = new Q()) => q.setFromAxisAngle(axis, a);
const pitchQ = (p, q) => qa(X, -p, q); // positive: nose up
const yawQ = (a, q) => qa(Y, a, q); // positive: turn left (towards +x)
const rollQ = (r, q) => qa(Z, r, q);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------- postures ----------
// feet: the paw joint (wrist, hind paw) in root space; y is its height above the ground, 'plant' 1 = on the
// ground. hipY/hipZ: pelvis joint; pitch: body angle (nose up); arch: back arched up; chest: extra chest pitch;
// bend: sideways curve; roll: onto the side (+: left side up); flat: hind metatarsals from upright (0) to flat on
// the ground (1); tail: up (-1 down .. 1 up), curl (hooked tip), wrap (around the body, sideways)
export const POSE_KEYS = ['hipY', 'hipZ', 'pitch', 'arch', 'chest', 'bend', 'roll', 'neck', 'head', 'headRoll', 'flat',
  'tailUp', 'tailCurl', 'tailWrap', 'earFwd', 'earOut', 'eyes',
  'FLx', 'FLy', 'FLz', 'FRx', 'FRy', 'FRz', 'HLx', 'HLy', 'HLz', 'HRx', 'HRy', 'HRz', 'plantF', 'plantH', 'lift'];
export const PK = Object.fromEntries(POSE_KEYS.map((k, i) => [k, i]));
const base = {
  hipY: 0.122, hipZ: -0.076, pitch: 0, arch: 0, chest: 0, bend: 0, roll: 0, neck: 0, head: 0, headRoll: 0, flat: 0,
  tailUp: 0.35, tailCurl: 0.25, tailWrap: 0, earFwd: 0, earOut: 0, eyes: 1,
  FLx: 0.03, FLy: 0, FLz: 0.068, FRx: -0.03, FRy: 0, FRz: 0.068, HLx: 0.032, HLy: 0, HLz: -0.08, HRx: -0.032, HRy: 0, HRz: -0.08,
  plantF: 1, plantH: 1, lift: 1,
};
const P = (o) => ({ ...base, ...o });
export const POSTURES = {
  stand: P({ neck: -0.1, head: 0.06 }),
  alert: P({ tailUp: 0.8, tailCurl: 0.5, earFwd: 0.25, neck: 0.12 }),
  crouch: P({ hipY: 0.078, pitch: -0.05, neck: -0.25, head: 0.2, tailUp: -0.55, tailCurl: 0, earFwd: 0.3, FLz: 0.078, HLz: -0.068, HRz: -0.068, FRz: 0.078, arch: -0.08 }),
  sit: P({ hipY: 0.042, hipZ: -0.035, pitch: 0.72, chest: -0.38, arch: 0.05, neck: -0.2, head: -0.15, flat: 1,
    FLx: 0.022, FLz: 0.07, FRx: -0.022, FRz: 0.07, HLx: 0.042, HLz: 0.012, HRx: -0.042, HRz: 0.012, tailUp: -0.6, tailCurl: 0, tailWrap: 0.9 }),
  loaf: P({ hipY: 0.058, hipZ: -0.075, pitch: 0.02, arch: 0.06, chest: 0.0, neck: 0.05, head: 0.05, flat: 1,
    FLx: 0.024, FLy: 0.006, FLz: 0.11, FRx: -0.024, FRy: 0.006, FRz: 0.11, HLx: 0.046, HLz: -0.03, HRx: -0.046, HRz: -0.03, tailUp: -0.6, tailCurl: 0, tailWrap: 1.1, eyes: 0.8 }),
  curl: P({ hipY: 0.046, hipZ: -0.07, pitch: 0.0, roll: 1.45, bend: 0.1, arch: 1.9, neck: -1.1, head: -0.55, flat: 1,
    FLx: 0.03, FLy: 0.05, FLz: 0.1, FRx: -0.03, FRy: 0.05, FRz: 0.1, HLx: 0.035, HLy: 0.05, HLz: -0.02, HRx: -0.035, HRy: 0.05, HRz: -0.02,
    plantF: 0, plantH: 0, tailUp: -0.8, tailCurl: -1.2, tailWrap: 0, eyes: 0, earFwd: -0.1 }),
  bow: P({ hipY: 0.135, pitch: -0.42, chest: -0.1, arch: -0.12, neck: 0.4, head: 0.3, FLz: 0.14, FRz: 0.14, tailUp: 1, tailCurl: 0.6, earFwd: 0.2 }),
  rear: P({ hipY: 0.075, hipZ: -0.02, pitch: 1.25, chest: 0.05, neck: -0.9, head: -0.35, flat: 0.55,
    FLx: 0.035, FLy: 0.2, FLz: 0.12, FRx: -0.035, FRy: 0.2, FRz: 0.12, HLx: 0.04, HLz: 0.0, HRx: -0.04, HRz: 0.0, plantF: 0, tailUp: -0.2, tailCurl: 0, earFwd: 0.1, earOut: 0.3 }),
  leap: P({ hipY: 0.12, pitch: 0.12, arch: -0.3, neck: 0.1, head: 0.1, FLx: 0.028, FLy: 0.04, FLz: 0.15, FRx: -0.028, FRy: 0.04, FRz: 0.15,
    HLx: 0.03, HLy: 0.05, HLz: -0.16, HRx: -0.03, HRy: 0.05, HRz: -0.16, plantF: 0, plantH: 0, tailUp: 0.1, tailCurl: 0, earFwd: 0.4 }),
  pin: P({ hipY: 0.07, pitch: -0.12, arch: 0.05, neck: -0.7, head: 0.05, FLx: 0.012, FLz: 0.115, FRx: -0.012, FRz: 0.115, HLz: -0.07, HRz: -0.07,
    tailUp: -0.3, tailCurl: 0, earFwd: 0.35 }),
  back: P({ hipY: 0.05, hipZ: -0.07, roll: 2.3, bend: 0.3, arch: 0.3, neck: -0.5, head: -0.3, headRoll: -0.6, flat: 0.3,
    FLx: 0.05, FLy: 0.12, FLz: 0.12, FRx: -0.02, FRy: 0.14, FRz: 0.11, HLx: 0.06, HLy: 0.1, HLz: -0.05, HRx: 0.01, HRy: 0.13, HRz: -0.04,
    plantF: 0, plantH: 0, tailUp: 0, tailCurl: 0, tailWrap: 0.6, earOut: 0.5 }),
};
export function postureVector(name, side = 1, out = new Float32Array(POSE_KEYS.length)) {
  const p = POSTURES[name];
  for (let i = 0; i < POSE_KEYS.length; i++) out[i] = p[POSE_KEYS[i]];
  if (side < 0) {
    // mirrored: sideways parameters flip, left and right feet swap
    for (const k of ['roll', 'bend', 'headRoll', 'tailWrap']) out[PK[k]] = -out[PK[k]];
    for (const [a, b] of [['FL', 'FR'], ['HL', 'HR']]) {
      const ax = out[PK[a + 'x']], ay = out[PK[a + 'y']], az = out[PK[a + 'z']];
      out[PK[a + 'x']] = -out[PK[b + 'x']]; out[PK[a + 'y']] = out[PK[b + 'y']]; out[PK[a + 'z']] = out[PK[b + 'z']];
      out[PK[b + 'x']] = -ax; out[PK[b + 'y']] = ay; out[PK[b + 'z']] = az;
    }
  }
  return out;
}

// ---------- gait ----------
// foot phase offsets (HL, HR, FL, FR) and duty factor, blended walk -> trot -> gallop (half bound)
const GAITS = [
  { off: [0, 0.5, 0.25, 0.75], duty: 0.62, lift: 0.018 },
  { off: [0, 0.5, 0.5, 1.0], duty: 0.48, lift: 0.024 },
  { off: [0, 0.1, 0.45, 0.55], duty: 0.36, lift: 0.036 },
];
function gaitAt(v) {
  const g = v < 0.9 ? smooth(0.35, 0.9, v) : 1 + smooth(1.1, 1.7, v);
  const i = Math.min(1, Math.floor(g)), f = g - i, a = GAITS[i], b = GAITS[i + 1];
  return { g, off: a.off.map((o, k) => o + (b.off[k] - o) * f), duty: a.duty + (b.duty - a.duty) * f, lift: a.lift + (b.lift - a.lift) * f };
}
export const strideFreq = (v) => (v < 1 ? 1.15 + 1.5 * v : 2.65 + 0.45 * (v - 1));

// ---------- solver ----------
const LEN = {
  arm: off('armL', 'foreL').length(), fore: off('foreL', 'fpawL').length(),
  thigh: off('thighL', 'shinL').length(), shin: off('shinL', 'metaL').length(), meta: off('metaL', 'hpawL').length(),
};
const FOOT_H = { F: REST[BONE.fpawL].y, H: REST[BONE.hpawL].y };
const REST_DIR = {};
for (const [a, b] of [['armL', 'foreL'], ['foreL', 'fpawL'], ['thighL', 'shinL'], ['shinL', 'metaL'], ['metaL', 'hpawL']]) REST_DIR[a.slice(0, -1)] = off(a, b).normalize();

const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _a = new V(), _b = new V(), _c = new V(), _s = new V();
// rotation taking the rest frame (dir d0, side s0) to the frame (d1, s1)
function aimQ(d0, s0, d1, s1, out) {
  const u0 = _a.copy(s0).addScaledVector(d0, -s0.dot(d0)).normalize(), w0 = _b.crossVectors(d0, u0);
  _m1.makeBasis(d0, u0, w0);
  const u1 = _c.copy(s1).addScaledVector(d1, -s1.dot(d1)).normalize(), w1 = _s.crossVectors(d1, u1);
  _m2.makeBasis(d1, u1, w1);
  return out.setFromRotationMatrix(_m2.multiply(_m1.transpose()));
}

// two-bone IK: knee position for a chain A -(l1)- K -(l2)- end towards T, bending towards `pole`
function ik2(A, T, l1, l2, pole, K, E) {
  const d0 = _a.subVectors(T, A), dist = d0.length();
  const u = d0.divideScalar(dist || 1);
  const d = clamp(dist, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const ca = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1), sa = Math.sqrt(1 - ca * ca);
  const w = _b.copy(pole).addScaledVector(u, -pole.dot(u)).normalize();
  K.copy(A).addScaledVector(u, l1 * ca).addScaledVector(w, l1 * sa);
  E.copy(A).addScaledVector(u, d);
}

export class KittenRig {
  constructor(ground, rng) {
    this.ground = ground; // (x, z) -> ground height
    this.rng = rng; // seeded: the scene replays the same way (bench)
    this.n = BONES.length;
    this.J = BONES.map(() => new V()); // joint positions (world)
    this.R = BONES.map(() => new Q()); // bone rotations (world, relative to rest)
    this.S = BONES.map(() => new V(1, 1, 1));
    this.pose = postureVector('stand');
    this.target = postureVector('stand');
    this.rate = 5;
    // motion state (set by the behaviour / motor)
    this.x = 0; this.z = 0; this.yaw = 0; this.speed = 0; this.turn = 0;
    this.phase = 0; this.jumpY = 0; this.jumpPitch = 0; this.airborne = 0;
    this.look = null; this.lookYaw = 0; this.lookPitch = 0; this.lookW = 0;
    this.tailPhase = rng() * 6; this.swish = 0.15; this.swishRate = 1.2; this.puff = 0;
    this.breath = rng() * 6; this.breathRate = 1.9;
    this.blinkT = 2; this.blink = 0;
    this.wiggle = 0; this.wiggleT = 0;
    // paw action: one front paw reaching for a point (world) or a local offset from the head (grooming)
    this.paw = { side: 1, w: 0, target: new V(), local: null, tw: 0 };
    this.headTilt = 0; this.pupil = 0.4;
    this.q = { yaw: new Q(), pel: new Q(), t: new Q(), t2: new Q() };
    this.fwd = new V(0, 0, 1); this.side = new V(1, 0, 0);
    this.feetW = [new V(), new V(), new V(), new V()]; // resolved foot targets (HL, HR, FL, FR)
  }
  setPosture(name, rate = 5, side = 1) { postureVector(name, side, this.target); this.rate = rate; }

  update(dt, t) {
    this._dt = dt;
    const p = this.pose, T = this.target, k = 1 - Math.exp(-this.rate * dt);
    for (let i = 0; i < p.length; i++) p[i] += (T[i] - p[i]) * k;
    this.phase = (this.phase + dt * strideFreq(this.speed) * smooth(0.005, 0.05, this.speed + Math.abs(this.turn) * 0.1)) % 1;
    this.breath += dt * this.breathRate * Math.PI * 2;
    this.tailPhase += dt * this.swishRate * Math.PI * 2;
    // blinking: every few seconds, a quick close and open
    this.blinkT -= dt;
    if (this.blinkT < 0) { this.blink = 1; this.blinkT = 2 + this.rng() * 5; }
    this.blink = Math.max(0, this.blink - dt * 7);
    if (this.wiggle > 0) this.wiggleT += dt * 9;
    this.solve(t);
  }

  solve() {
    const p = this.pose, J = this.J, R = this.R, g = this.ground;
    const { yaw: qYaw, pel, t: qt, t2 } = this.q;
    // body height follows the ground smoothly (a root under it lifts it, not a step)
    const g0 = g(this.x, this.z);
    this.gy = this.gy === undefined || Math.abs(g0 - this.gy) > 0.5 ? g0 : this.gy + (g0 - this.gy) * (1 - Math.exp(-14 * (this._dt || 1 / 60)));
    const gy = this.gy;
    yawQ(this.yaw, qYaw);
    const fwd = this.fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)), side = this.side.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // ground slope along the body
    const slope = Math.atan2(g(this.x + fwd.x * 0.09, this.z + fwd.z * 0.09) - g(this.x - fwd.x * 0.09, this.z - fwd.z * 0.09), 0.18);
    // gait
    const moving = smooth(0.005, 0.05, this.speed + Math.abs(this.turn) * 0.1) * (1 - this.airborne) * p[PK.lift];
    const gait = gaitAt(this.speed);
    const vEff = Math.max(this.speed, Math.abs(this.turn) * 0.08);
    const stride = Math.min(0.2, (vEff * gait.duty) / strideFreq(vEff));
    const gal = smooth(1.1, 1.7, this.speed) * moving;
    const flex = Math.sin((this.phase - 0.15) * Math.PI * 2); // spine flexion in the gallop
    const bob = moving * (Math.sin(this.phase * Math.PI * 4) * 0.003 * (1 - gal) + flex * 0.01 * gal);
    const breath = Math.sin(this.breath);
    // root and pelvis
    J[0].set(this.x, gy, this.z); R[0].copy(qYaw);
    const hip = _hip.set(0, p[PK.hipY] + this.jumpY + bob, p[PK.hipZ] - gal * flex * 0.012).applyQuaternion(qYaw).add(J[0]);
    const wig = this.wiggle * Math.sin(this.wiggleT);
    hip.addScaledVector(side, wig * 0.008);
    J[BONE.pelvis].copy(hip);
    // spine: arched up (+) = pelvis tipped up, chest tipped down; bent sideways over pelvis, spine and chest
    const bendS = p[PK.bend] * 0.35 + this.turn * 0.05, archS = p[PK.arch] - gal * flex * 0.28;
    pel.copy(qYaw).multiply(rollQ(p[PK.roll], qt)).multiply(yawQ(p[PK.bend] * 0.25 - this.turn * 0.04 + wig * 0.15, qt)).multiply(pitchQ(p[PK.pitch] + archS * 0.5 + slope + this.jumpPitch + gal * flex * 0.12, qt));
    R[BONE.pelvis].copy(pel);
    const chain = (parent, bone, rot) => { const b = BONE[bone], a = BONE[parent]; J[b].copy(OFF[b]).applyQuaternion(R[a]).add(J[a]); R[b].copy(R[a]).multiply(rot); };
    chain('pelvis', 'spine', yawQ(bendS, qt).multiply(pitchQ(-archS * 0.5, t2)));
    chain('spine', 'chest', yawQ(bendS, qt).multiply(pitchQ(p[PK.chest] - archS * 0.5 - slope * 0.5, t2)));
    this.S[BONE.chest].set(1 + breath * 0.018, 1 + breath * 0.022, 1);
    // gaze: target in the chest frame -> yaw / pitch shared by neck and head
    let ly = 0, lp = 0;
    if (this.look) {
      // from the head's rest place in the chest frame
      const d = _c.subVectors(this.look, J[BONE.chest]).applyQuaternion(_qi.copy(R[BONE.chest]).invert()).sub(HEAD_IN_CHEST);
      ly = clamp(Math.atan2(d.x, d.z), -1.5, 1.5); lp = clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), -1.2, 0.9);
    }
    const lk = 1 - Math.exp(-12 * (this._dt || 1 / 60));
    this.lookW += ((this.look ? 1 : 0) - this.lookW) * lk;
    this.lookYaw += (ly - this.lookYaw) * lk; this.lookPitch += (lp - this.lookPitch) * lk;
    const lw = this.lookW;
    // looking at something replaces the posture's neck and head pitch (they are relative to the chest too)
    const lpN = p[PK.neck] + (this.lookPitch * 0.45 - p[PK.neck]) * lw, lpH = p[PK.head] + (this.lookPitch * 0.55 - p[PK.head]) * lw;
    chain('chest', 'neck', yawQ(this.lookYaw * 0.45 * lw + p[PK.bend] * 0.3, qt).multiply(pitchQ(lpN, t2)));
    chain('neck', 'head', yawQ(this.lookYaw * 0.55 * lw, qt).multiply(pitchQ(lpH, t2)).multiply(rollQ(p[PK.headRoll] + this.headTilt, _q2)));
    // ears: forward / out (airplane) / flat
    for (const s of [1, -1]) {
      const b = s > 0 ? 'earL' : 'earR';
      chain('head', b, rollQ(-s * p[PK.earOut] * 0.9, qt).multiply(pitchQ(-p[PK.earFwd] * 0.6, t2)).multiply(yawQ(-s * p[PK.earOut] * 0.5, _q2)));
    }
    // eyes: gaze and eyelids (the eyeball squashes into its socket)
    const open = clamp(p[PK.eyes] * (1 - this.blink), 0.06, 1);
    for (const b of ['eyeL', 'eyeR']) { chain('head', b, qt.identity()); this.S[BONE[b]].set(1, open * 0.9, 1); }
    // legs
    const feet = [['H', 'L', 'thighL', 'shinL', 'metaL', 'hpawL', 0], ['H', 'R', 'thighR', 'shinR', 'metaR', 'hpawR', 1], ['F', 'L', 'armL', 'foreL', 'fpawL', null, 2], ['F', 'R', 'armR', 'foreR', 'fpawR', null, 3]];
    for (const [fh, lr, b0, b1, b2, b3, gi] of feet) {
      const key = fh + lr, plant = p[PK['plant' + fh]];
      const parent = fh === 'F' ? 'chest' : 'pelvis';
      J[BONE[b0]].copy(OFF[BONE[b0]]).applyQuaternion(R[BONE[parent]]).add(J[BONE[parent]]);
      // gait offset along the heading and lift
      const ph = (this.phase + gait.off[gi]) % 1;
      let dz = 0, lift = 0;
      if (ph < gait.duty) dz = stride * (0.5 - ph / gait.duty);
      else { const s = (ph - gait.duty) / (1 - gait.duty); dz = stride * (-0.5 + s * s * (3 - 2 * s)); lift = Math.sin(Math.PI * s) * gait.lift * Math.min(1, stride * 12 + 0.3); }
      dz *= moving; lift *= moving;
      // planted target: root space on the ground; free target: in the parent bone's frame
      const fx = p[PK[key + 'x']], fy = p[PK[key + 'y']], fz = p[PK[key + 'z']];
      const foot = this.feetW[gi];
      const pw = _p1.set(fx, 0, fz + dz).applyQuaternion(qYaw).add(J[0]);
      pw.y = g(pw.x, pw.z) + FOOT_H[fh] + fy + lift + this.jumpY * 0.3;
      const pf = _p2.set(fx, fy + FOOT_H[fh], fz).sub(_p3.set(0, REST[BONE[parent]].y, REST[BONE[parent]].z)).applyQuaternion(R[BONE[parent]]).add(J[BONE[parent]]);
      foot.lerpVectors(pf, pw, plant);
      // front paw reaching for something
      if (fh === 'F' && this.paw.w > 0.001 && (lr === 'L') === (this.paw.side > 0)) {
        const tgt = this.paw.local ? _p3.copy(this.paw.local).applyQuaternion(R[BONE.head]).add(J[BONE.head]) : this.paw.target;
        foot.lerp(tgt, this.paw.w);
      }
      const bodySide = _p4.set(1, 0, 0).applyQuaternion(R[BONE[parent]]);
      const bodyFwd = _p5.set(0, 0, 1).applyQuaternion(R[BONE[parent]]);
      if (fh === 'F') {
        const pole = _p6.copy(bodyFwd).multiplyScalar(-1).addScaledVector(bodySide, (lr === 'L' ? 1 : -1) * 0.25);
        ik2(J[BONE[b0]], foot, LEN.arm, LEN.fore, pole, _k, _e);
        aimQ(REST_DIR.arm, X, _d.subVectors(_k, J[BONE[b0]]).normalize(), bodySide, R[BONE[b0]]);
        J[BONE[b1]].copy(_k);
        aimQ(REST_DIR.fore, X, _d.subVectors(_e, _k).normalize(), bodySide, R[BONE[b1]]);
        J[BONE[b2]].copy(_e);
        // paw: flat on the ground when planted (curled while lifted), following the forearm when free
        const flatQ = qt.copy(qYaw).multiply(pitchQ(slope - lift * 25, t2));
        R[BONE[b2]].copy(R[BONE[b1]]).slerp(flatQ, plant * (1 - (this.paw.w > 0.001 && (lr === 'L') === (this.paw.side > 0) ? this.paw.w : 0)));
      } else {
        // hind: the metatarsal from upright (standing) to flat behind the paw (sitting), then IK to the hock
        const ang = 0.37 + p[PK.flat] * 1.1;
        const meta = _p6.set(0, Math.cos(ang), -Math.sin(ang)).multiplyScalar(LEN.meta);
        meta.applyQuaternion(plant > 0.5 ? qYaw : R[BONE[parent]]);
        const hock = _p7.copy(foot).add(meta);
        if (plant > 0.5) hock.y = Math.max(hock.y, g(hock.x, hock.z) + 0.009);
        const pole = _p8.copy(bodyFwd).addScaledVector(bodySide, (lr === 'L' ? 1 : -1) * 0.2);
        ik2(J[BONE[b0]], hock, LEN.thigh, LEN.shin, pole, _k, _e);
        aimQ(REST_DIR.thigh, X, _d.subVectors(_k, J[BONE[b0]]).normalize(), bodySide, R[BONE[b0]]);
        J[BONE[b1]].copy(_k);
        aimQ(REST_DIR.shin, X, _d.subVectors(_e, _k).normalize(), bodySide, R[BONE[b1]]);
        J[BONE[b2]].copy(_e);
        aimQ(REST_DIR.meta, X, _d.subVectors(foot, _e).normalize(), bodySide, R[BONE[b2]]);
        J[BONE[b3]].copy(_e).addScaledVector(_d, LEN.meta);
        const flatQ = qt.copy(qYaw).multiply(pitchQ(slope - lift * 20, t2));
        R[BONE[b3]].copy(R[BONE[b2]]).slerp(flatQ, plant);
      }
    }
    // tail: up at the base, hooked tip, wrapped sideways, swishing; kept above the ground
    let prev = BONE.pelvis;
    const up = p[PK.tailUp], curl = p[PK.tailCurl], wrap = p[PK.tailWrap];
    for (let i = 0; i < TAIL_N; i++) {
      const b = BONE.tail0 + i, f = i / (TAIL_N - 1);
      J[b].copy(OFF[b]).applyQuaternion(R[prev]).add(J[prev]);
      const pitchUp = (i === 0 ? up * 1.15 : i === 1 ? up * 0.45 : 0) + (i >= 3 ? curl * 0.5 : 0) + (i === 0 ? -p[PK.pitch] * 0.6 : 0);
      const sw = this.swish * Math.sin(this.tailPhase - i * 0.7) * (0.3 + f) + wrap * 0.33 * (i > 0 ? 1 : 0.3) + (i === 0 ? wig * 0.3 : 0);
      R[b].copy(R[prev]).multiply(pitchQ(-pitchUp, qt)).multiply(yawQ(sw, t2));
      // ground: bend the segment up so its end stays on the ground
      const dir = _d.copy(NZ).applyQuaternion(R[b]);
      const endY = J[b].y + dir.y * TAIL_SEG, gEnd = g(J[b].x + dir.x * TAIL_SEG, J[b].z + dir.z * TAIL_SEG) + 0.011;
      if (endY < gEnd) {
        const h = Math.hypot(dir.x, dir.z) || 1, dy = clamp((gEnd - J[b].y) / TAIL_SEG, -1, 1), s = Math.sqrt(1 - dy * dy);
        const nd = _k.set((dir.x / h) * s, dy, (dir.z / h) * s);
        aimQ(NZ, X, nd, _p4.set(1, 0, 0).applyQuaternion(R[b]), R[b]);
      }
      prev = b;
    }
  }

  // bone world matrices into a skeleton's bones (they are not in the scene graph)
  write(bones) {
    for (let i = 0; i < this.n; i++) bones[i].matrixWorld.compose(this.J[i], this.R[i], this.S[i]);
  }
}
const _qi = new Q(), _q2 = new Q(), _hip = new V();
const HEAD_IN_CHEST = REST[BONE.head].clone().sub(REST[BONE.chest]);
const _p1 = new V(), _p2 = new V(), _p3 = new V(), _p4 = new V(), _p5 = new V(), _p6 = new V(), _p7 = new V(), _p8 = new V(), _k = new V(), _e = new V(), _d = new V();
