// Birds perched where the camera spends its time: tree sparrows (suzume) in little groups of two to five on the
// lantern lines' ropes round the cherry tree and on the bridge's top rails, a jungle crow (hashibuto-garasu) on the
// torii's top beam, Japanese white-eyes (mejiro) and two more sparrows in the cherry tree's blossom, Japanese wagtails
// (seguro-sekirei) on the rocks in the river and a kingfisher (kawasemi) on the lantern ropes along the banks. The sparrows hop a few centimetres along the rope, turn about, look round, preen, puff
// themselves up, and now and then one flies a short loop out over the bank and lands again; when the walker comes
// within FLUSH m (the camera within CAMERA_FLUSH) a group bursts off into the nearest cherry's blossom, sits there, and
// drifts back once all has been quiet a while. The crow looks round, caws (beak open, a bow with each call), hops
// along the beam, and when someone comes within 6 m flies off to the temple woods and comes back a minute later. The
// white-eyes work the blossom in a loose flock, flitting from flower to flower and across the crown, singing now and
// then; the sparrows there bite flowers off for their nectar and let them fall (bitten(), for dropped.js); the wagtails
// stand on the rocks pumping their long tails, flit low from rock to rock, and fly off to a far rock when someone
// comes close; the kingfisher watches the water, dives (a ring where it goes in) and flies back up, or darts along
// the river to another of its perches. Their calls and plops go to the sound as events. One instanced draw for all of them: the crow is the sparrow's mesh in another shape (a second set of
// positions and normals, per instance `kind`), the white-eye, the wagtail and the kingfisher the sparrow's in other
// plumage (the wagtail's tail drawn out, the kingfisher's bill). The perched motion is in the vertex stage from the scene's running time and each bird's
// seed (hops and turns on a jittered step clock, the loops summed sines); the flights from one perch to another, or away
// and back, are set from the CPU per bird (when it left, when it comes back, where to), the vertex stage flying the path.
// By day only: they go to roost over dusk (by rank, like the butterflies), fewer in rain, none in a gale; hidden when
// none are out. Lit like the birds in flight, with the sunlit ground's bounce; no shadows, not in the reflection.
import * as THREE from 'three/webgpu';
import { Fn, vec2, vec3, float, sin, cos, abs, sign, min, max, mix, clamp, select, floor, fract, length, atan, attribute, uniform, positionGeometry, normalGeometry, positionWorld, cameraPosition, transformNormalToView, faceDirection } from 'three/tsl';
import { LitMaterial, U, sstep, hash12, SHADOW_NORMAL_BIAS } from './tsl.js';
import { bridgeFrame, BRIDGE_Z, RAIL_OFF } from './props.js';
import { TORII } from './village.js';
import { groundBounce } from './materials.js';
import { mulberry32, smoothstep } from './noise.js';

const TAU = Math.PI * 2;
const ROPE_R = 0.018; // the lantern ropes' radius (lanterns.js)
const RAIL_TOP = 0.98 + 0.058; // the bridge's round top rail: its axis above the deck line and its radius (props.js)
const KASAGI = { y: 4.78, rise: 0.22, half: 2.6 }; // the torii's top beam: its top at the middle, the ends' sweep (tools/village.py)
const CROW_NEAR = 6; // the crow leaves when the walker or the camera comes this close (m)
const CROW_AWAY = 60; // and comes back this long after (s)
const FLUSH = 5, CAMERA_FLUSH = 2.5; // a sparrow group bursts off when the walker, or the camera, comes this close (m)
const QUIET = [25, 50], CLEAR = 9; // ...and comes back after this long (s), once no one is within CLEAR m
const WAG_FLUSH = 7; // a wagtail leaves its rock when the walker comes this close (the camera: CAMERA_FLUSH)
const SPECIES = { sparrow: 0, crow: 1, mejiro: 2, wagtail: 3, kingfisher: 4 };
const KF_FLUSH = 6; // the kingfisher leaves when the walker comes this close (the camera: CAMERA_FLUSH)

// ---------- the two shapes ----------
// Both in metres, built in a body frame (z forward along the body's axis, y up), then tilted nose-up by `tilt` and set
// on the feet (the origin, on the perch). rings: [z, centre y, half-width, half-height] from the beak's base back to
// the rump, eight vertices round each; beak: the upper and the lower tip [z, y]; tail: root and tip [z, half-width,
// y] when sitting and in flight; wing: three stations (shoulder, wrist, tip), each [leading edge, trailing edge] as
// [x, y, z], folded along the flank and spread; leg: [half-gap, length, z].
const SHAPES = {
  sparrow: {
    tilt: 0.38,
    rings: [[0.058, 0.011, 0.0045, 0.0045], [0.052, 0.012, 0.0105, 0.011], [0.04, 0.0135, 0.0165, 0.016], [0.026, 0.008, 0.0145, 0.0145],
      [0.008, 0.0, 0.024, 0.025], [-0.018, -0.002, 0.022, 0.021], [-0.04, 0.002, 0.012, 0.011]],
    beak: [[0.0705, 0.0112], [0.069, 0.0095]], rump: [-0.05, 0.004],
    tail: { sit: [[-0.042, 0.0085, 0.002], [-0.088, 0.015, -0.006]], fly: [[-0.042, 0.009, 0.002], [-0.086, 0.021, -0.002]] },
    wing: {
      sit: [[[0.021, 0.014, 0.014], [0.024, -0.004, 0.01]], [[0.024, 0.013, -0.012], [0.0255, -0.01, -0.016]], [[0.0125, 0.0105, -0.058], [0.0105, 0.0045, -0.061]]],
      fly: [[[0.012, 0.008, 0.016], [0.012, 0.008, -0.012]], [[0.055, 0.01, 0.016], [0.055, 0.01, -0.026]], [[0.11, 0.01, -0.004], [0.105, 0.01, -0.034]]],
    },
    leg: [0.0055, 0.012, -0.002], legW: 0.0016,
  },
  crow: {
    tilt: 0.45,
    rings: [[0.178, 0.034, 0.014, 0.022], [0.158, 0.04, 0.03, 0.034], [0.125, 0.044, 0.044, 0.044], [0.085, 0.03, 0.035, 0.038],
      [0.02, 0.0, 0.076, 0.078], [-0.07, -0.004, 0.068, 0.066], [-0.14, 0.008, 0.035, 0.03]],
    beak: [[0.254, 0.032], [0.244, 0.022]], rump: [-0.165, 0.012],
    tail: { sit: [[-0.15, 0.028, 0.008], [-0.36, 0.046, -0.075]], fly: [[-0.15, 0.03, 0.01], [-0.36, 0.07, -0.01]] },
    wing: {
      sit: [[[0.066, 0.042, 0.05], [0.074, -0.012, 0.03]], [[0.07, 0.036, -0.045], [0.074, -0.026, -0.065]], [[0.036, 0.032, -0.24], [0.031, 0.016, -0.255]]],
      fly: [[[0.04, 0.02, 0.06], [0.04, 0.02, -0.05]], [[0.22, 0.025, 0.07], [0.22, 0.025, -0.12]], [[0.48, 0.02, 0.0], [0.45, 0.02, -0.1]]],
    },
    leg: [0.016, 0.055, -0.01], legW: 0.006,
  },
};
const ELBOW = { sparrow: 0.055, crow: 0.22 }; // where the spread wing's hand starts (x)
const HZ = { sparrow: 15, crow: 4.2 }; // wing beats per second

// parts (aInfo.x): 0 body, 1 wing, 2 tail, 3 leg, 4 upper beak tip, 5 lower beak tip (opens)
function shape(S) {
  const sit = [], fly = [], info = [], I = [];
  const ct = Math.cos(S.tilt), st = Math.sin(S.tilt);
  const tiltP = ([x, y, z]) => [x, y * ct + z * st, z * ct - y * st];
  // the feet: under the belly's ring
  const belly = S.rings[5], legTop = tiltP([0, belly[1] - belly[3] * 0.8, S.leg[2]]);
  const foot = [0, legTop[1] - S.leg[1], legTop[2]];
  const footLevel = [0, belly[1] - belly[3] * 0.8 - S.leg[1], S.leg[2]];
  const toSit = (p) => { const q = tiltP(p); return [q[0] - foot[0], q[1] - foot[1], q[2] - foot[2]]; };
  const toFly = (p) => [p[0] - footLevel[0], p[1] - footLevel[1], p[2] - footLevel[2]];
  const vert = (pSit, pFly, part, u = 0, v = 0, head = 0) => { sit.push(...pSit); fly.push(...pFly); info.push(part, u, v, head); return sit.length / 3 - 1; };
  const body = (p, part, head, u = 0, v = 0) => vert(toSit(p), toFly(p), part, u, v, head);
  // body: rings of eight from the top round by the right
  const HEAD = [1, 1, 1, 0.6, 0, 0, 0];
  const rings = S.rings.map(([z, cy, rx, ry], i) => Array.from({ length: 8 }, (_, j) => {
    const a = (j / 8) * TAU;
    return body([rx * Math.sin(a), cy + ry * Math.cos(a), z], 0, HEAD[i]);
  }));
  for (let i = 0; i + 1 < rings.length; i++) for (let j = 0; j < 8; j++) {
    const a = rings[i][j], b = rings[i][(j + 1) % 8], c = rings[i + 1][j], d = rings[i + 1][(j + 1) % 8];
    I.push(a, b, c, b, d, c);
  }
  // the beak: the upper half of its base to the upper tip, the lower half to the lower tip, the gape's sides between
  const r0 = rings[0], U0 = body([0, S.beak[0][1], S.beak[0][0]], 4, 1), L0 = body([0, S.beak[1][1], S.beak[1][0]], 5, 1);
  for (const j of [6, 7, 0, 1]) I.push(r0[j], U0, r0[(j + 1) % 8]);
  for (const j of [2, 3, 4, 5]) I.push(r0[j], L0, r0[j + 1]);
  I.push(r0[2], U0, L0, r0[6], L0, U0);
  // the rump closed to a point
  const r6 = rings[6], T0 = body([0, S.rump[1], S.rump[0]], 0, 0);
  for (let j = 0; j < 8; j++) I.push(r6[j], r6[(j + 1) % 8], T0);
  // tail: one flat fan, its top up
  const tv = (k, m) => {
    const [z, w, y] = S.tail.sit[k], [zf, wf, yf] = S.tail.fly[k];
    return vert(toSit([m * w, y, z]), toFly([m * wf, yf, zf]), 2, k, (m + 1) / 2);
  };
  const t00 = tv(0, -1), t01 = tv(0, 1), t10 = tv(1, -1), t11 = tv(1, 1);
  I.push(t00, t01, t10, t01, t11, t10);
  // wings: a strip of two quads each, wound with their top up when spread (birds.js)
  for (const m of [1, -1]) {
    const w = [0, 1, 2].map((k) => [0, 1].map((e) => {
      const [x, y, z] = S.wing.sit[k][e], [xf, yf, zf] = S.wing.fly[k][e];
      return vert(toSit([m * x, y, z]), toFly([m * xf, yf, zf]), 1, k / 2, e);
    }));
    const tri = (a, b, c) => (m > 0 ? I.push(a, b, c) : I.push(a, c, b));
    for (let k = 0; k < 2; k++) { tri(w[k][0], w[k + 1][0], w[k][1]); tri(w[k][1], w[k + 1][0], w[k + 1][1]); }
  }
  // legs: a thin quad each, turned 45° out so one shows from any side; tucked into the belly in flight
  const [gx, len] = S.leg, lw = S.legW;
  for (const m of [1, -1]) {
    const top = [m * gx, legTop[1] - foot[1], legTop[2] - foot[2]], dx = lw * 0.7, dz = lw * 0.7 * m;
    const tuck = toFly([m * gx, belly[1] - belly[3] * 0.5, S.leg[2] - 0.004]);
    const q = [[top[0] - dx, top[1], top[2] - dz], [top[0] + dx, top[1], top[2] + dz], [top[0] + dx, top[1] - len, top[2] + dz], [top[0] - dx, top[1] - len, top[2] - dz]]
      .map((p) => vert(p, tuck, 3));
    I.push(q[0], q[1], q[2], q[0], q[2], q[3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(sit, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  // where the head turns about (the neck) and the lower beak opens (its base), in the sitting frame
  const [z3, c3] = S.rings[3], [z4, c4] = S.rings[4], [zb, cb] = S.rings[0];
  return { sit, fly, info, index: I, normal: [...g.attributes.normal.array], neck: toSit([0, c3 * 0.7 + c4 * 0.3, z3 * 0.7 + z4 * 0.3]), hinge: toSit([0, cb, zb]), rump: toSit([0, S.tail.sit[0][2], S.tail.sit[0][0]]), foot, footLevel };
}

// one interleaved buffer for the vertices' seven attributes (WebGPU allows a pipeline 8 vertex buffers)
const VERT = [['position', 3, (s) => s.s.sit], ['normal', 3, (s) => s.s.normal], ['aFly', 3, (s) => s.s.fly], ['aCrow', 3, (s) => s.c.sit],
  ['aCrowN', 3, (s) => s.c.normal], ['aCrowFly', 3, (s) => s.c.fly], ['aInfo', 4, (s) => s.s.info]];
function perchedGeometry() {
  const sc = { s: shape(SHAPES.sparrow), c: shape(SHAPES.crow) };
  const g = new THREE.InstancedBufferGeometry(), n = sc.s.sit.length / 3, stride = VERT.reduce((a, v) => a + v[1], 0);
  const data = new Float32Array(n * stride), buf = new THREE.InterleavedBuffer(data, stride);
  let off = 0;
  for (const [name, size, src] of VERT) {
    const a = src(sc);
    for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) data[i * stride + off + k] = a[i * size + k];
    g.setAttribute(name, new THREE.InterleavedBufferAttribute(buf, size, off));
    off += size;
  }
  g.setIndex(sc.s.index);
  return { g, ...sc };
}

// ---------- TSL helpers ----------
const rotX = (v, a) => { const c = cos(a), s = sin(a); return vec3(v.x, v.y.mul(c).add(v.z.mul(s)), v.z.mul(c).sub(v.y.mul(s))); }; // nose up
const rotY = (v, a) => { const c = cos(a), s = sin(a); return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s))); }; // heading
const rotZ = (v, a) => { const c = cos(a), s = sin(a); return vec3(v.x.mul(c).add(v.y.mul(s)), v.y.mul(c).sub(v.x.mul(s)), v.z); }; // bank: +x down
const c3 = (p) => vec3(p[0], p[1], p[2]);

// aA: perch point (x, y, z), seed; aB: along the perch per metre (x, y, z: its slope), the perch's curvature
// (y = c s²); aC: kind (0 the sparrow's shape, 1 the crow's), size, how far it hops either way (m), rank; aD: its
// loops' radius (m), how often it flies one, which side it faces most, its flight's rise (m); aE: when its flight left
// and when it comes back (uTime s), its flight's run (x, z, m); aF: species (SPECIES), 1 if out of sight while away
function perchedMaterial(sc, uAmount) {
  const A = attribute('aA', 'vec4'), B = attribute('aB', 'vec4'), C = attribute('aC', 'vec4'), D = attribute('aD', 'vec4');
  // (rounded: an equality test on the value interpolated to the fragments can miss it by a hair)
  const E = attribute('aE', 'vec4'), Fa = attribute('aF', 'vec4'), species = floor(Fa.x.add(0.5));
  // (rounded: an equality test on the value interpolated to the fragments can miss it by a hair)
  const inf = attribute('aInfo', 'vec4'), part = floor(inf.x.add(0.5));
  const seed = A.w, kind = C.x, sparrow = float(1).sub(kind), range = C.z;
  const t = U.uTime.add(seed.mul(977.0));
  const h = (k, j) => hash12(vec2(k, seed.mul(53.1).add(j * 7.31)));
  const isWing = part.equal(1.0).select(1.0, 0.0);

  // ---- perched: hops and turns on a step clock of 2-6 s, its steps jittered ----
  const H = mix(float(3.0), float(4.5), kind).mul(fract(seed.mul(7.7)).mul(0.8).add(0.6));
  const tw = t.div(H).add(sin(t.mul(1.3).div(H).add(seed.mul(20.0))).mul(0.25));
  const k = floor(tw), f = fract(tw), since = f.mul(H);
  const hop = sstep(0.0, mix(float(0.14), float(0.32), kind), since);
  const sPrev = h(k.sub(1.0), 1).sub(0.5).mul(2.0).mul(range), sCur = h(k, 1).sub(0.5).mul(2.0).mul(range);
  const s = mix(sPrev, sCur, hop);
  const arc = hop.mul(hop.oneMinus()).mul(4.0).mul(mix(float(0.022), float(0.1), kind)).mul(sstep(0.004, 0.012, abs(sCur.sub(sPrev))));
  // it faces off the perch one way or the other (mostly D.z's side), turning about in a hop; the crow looser
  const side = (kk) => select(h(kk, 2).lessThan(mix(float(0.62), float(0.5), kind)), D.z, D.z.oneMinus());
  const jit = (kk) => h(kk, 9).sub(0.5).mul(mix(float(0.5), float(1.2), kind));
  const face = mix(side(k.sub(1.0)).mul(Math.PI).add(jit(k.sub(1.0))), side(k).mul(Math.PI).add(jit(k)), hop);
  const perchYaw = atan(B.x, B.z);
  const sitYaw = perchYaw.add(Math.PI / 2).add(face);
  // what it does through the step: preens, puffs up (sparrows), caws (the crow)
  const b = h(k, 3);
  const preen = b.lessThan(0.16).select(1.0, 0.0).mul(sstep(0.12, 0.22, f)).mul(sstep(0.92, 0.8, f));
  const puff = b.greaterThanEqual(0.16).and(b.lessThan(0.32)).select(1.0, 0.0).mul(sstep(0.05, 0.2, f)).mul(sstep(0.98, 0.85, f)).mul(sparrow);
  const cawWin = b.greaterThan(0.55).select(1.0, 0.0).mul(sstep(0.2, 0.28, f)).mul(sstep(0.75, 0.67, f)).mul(kind);
  const cq = fract(t.mul(1.5));
  const caw = sstep(0.0, 0.06, cq).mul(sstep(0.42, 0.28, cq)).mul(cawWin);
  // the head: quick turns on its own clock, the crow's slower; preening, turned round to the wing and dipping
  const ht = t.mul(mix(float(1.5), float(0.6), kind)).add(seed.mul(3.0)), hk = floor(ht);
  const hTurn = sstep(0.0, mix(float(0.08), float(0.2), kind), fract(ht).div(mix(float(1.5), float(0.6), kind)));
  const pside = h(k, 6).lessThan(0.5).select(-1.0, 1.0);
  const headYaw = mix(mix(h(hk.sub(1.0), 4), h(hk, 4), hTurn).sub(0.5).mul(1.8), pside.mul(2.3).add(sin(t.mul(17.0)).mul(0.12)), preen);
  const headDip = mix(mix(h(hk.sub(1.0), 5), h(hk, 5), hTurn).sub(0.45).mul(0.5), sin(t.mul(23.0)).mul(0.1).add(0.8), preen).add(cawWin.mul(0.3));

  // ---- a sparrow's loop: out over its side of the perch and back, now and then ----
  const Cy = fract(seed.mul(3.3)).mul(22.0).add(16.0), cyc = floor(t.div(Cy));
  const lu = t.sub(cyc.mul(Cy)).div(fract(seed.mul(5.1)).mul(1.6).add(2.8));
  // ---- a flight from the perch, set from the CPU: leaving, there (the crow out of sight in the woods, the others
  // perched where they landed), coming back ----
  const to = vec3(E.z, D.w, E.w), len = length(to);
  const dur = clamp(len.div(mix(float(7.0), float(8.0), kind)), 0.3, 11.0);
  const ta = U.uTime.sub(E.x), tb = U.uTime.sub(E.y);
  const leaving = ta.greaterThanEqual(0.0).and(ta.lessThan(dur)).select(1.0, 0.0);
  const comingIn = tb.greaterThanEqual(0.0).and(tb.lessThan(dur)).select(1.0, 0.0);
  const there = ta.greaterThanEqual(dur).and(tb.lessThan(0.0)).select(1.0, 0.0);
  const flying = max(leaving, comingIn), back = select(comingIn.greaterThan(0.5), float(-1.0), float(1.0));
  const fu = clamp(mix(ta.div(dur), tb.div(dur).oneMinus(), comingIn), 0.0, 1.0);
  // the crow: a jump up off the beam, then out and up over the trees; the small birds: an arc
  const q = fu.mul(0.25).add(fu.mul(fu).mul(0.75)), qy = fu.mul(2.0).sub(fu.mul(fu));
  const sm = fu.mul(fu).mul(fu.mul(-2.0).add(3.0)), arcH = min(len.mul(0.2), 1.2);
  const flightOff = mix(to.mul(sm).add(vec3(0.0, arcH.mul(sin(fu.mul(Math.PI))), 0.0)), vec3(to.x.mul(q), to.y.mul(qy), to.z.mul(q)), kind).mul(max(flying, there));
  const flightV = mix(to.mul(fu.mul(fu.oneMinus()).mul(6.0)).add(vec3(0.0, arcH.mul(Math.PI).mul(cos(fu.mul(Math.PI))), 0.0)),
    vec3(to.x.mul(fu.mul(1.5).add(0.25)), to.y.mul(fu.oneMinus().mul(2.0)), to.z.mul(fu.mul(1.5).add(0.25))), kind).mul(back);
  const gone = there.mul(Fa.y);

  const looping = h(cyc, 7).lessThan(D.y).and(lu.lessThan(1.0)).select(1.0, 0.0).mul(sparrow).mul(flying.oneMinus());
  const u = clamp(lu, 0.0, 1.0);
  const R = D.x.mul(h(cyc, 8).mul(0.4).add(0.8));
  const lside = select(h(cyc, 10).lessThan(0.5), float(-1.0), float(1.0)), along = select(h(cyc, 11).lessThan(0.5), float(-1.0), float(1.0));
  const T = vec3(B.x, 0.0, B.z).normalize(), Pp = vec3(T.z, 0.0, T.x.negate()).mul(lside);
  const loopOff = Pp.mul(R.mul(cos(u.mul(TAU)).oneMinus().mul(0.5))).add(T.mul(R.mul(0.55).mul(sin(u.mul(TAU))).mul(along)))
    .add(vec3(0.0, R.mul(0.3).mul(sin(u.mul(Math.PI))).add(sin(u.mul(TAU)).mul(-0.1)), 0.0)).mul(looping);
  const loopV = Pp.mul(R.mul(Math.PI).mul(sin(u.mul(TAU)))).add(T.mul(R.mul(0.55 * TAU).mul(cos(u.mul(TAU))).mul(along)))
    .add(vec3(0.0, R.mul(0.3 * Math.PI).mul(cos(u.mul(Math.PI))).sub(cos(u.mul(TAU)).mul(0.2 * Math.PI)), 0.0));
  const loopFly = looping.mul(sstep(0.0, 0.05, u)).mul(sstep(1.0, 0.93, u));

  // ---- how much it is flying, and its wings ----
  const away = max(loopFly, flying);
  const flick = kind.mul(sin(hop.mul(Math.PI))).mul(sstep(0.012, 0.05, abs(sCur.sub(sPrev)))).mul(0.6); // the crow's wings open in a hop
  const flyAll = max(away, flick);
  const ph = t.mul(mix(float(HZ.sparrow), float(HZ.crow), kind).mul(TAU));
  // sparrows fly in bursts of beats with the wings shut between (bounding); the crow beats steadily
  const burst = mix(sstep(-0.3, 0.2, sin(t.mul(1.7 * TAU).add(seed.mul(9.0)))), float(1.0), kind);
  // (in a hop the crow half opens its wings, held out level and the hands drooping)
  const a1 = mix(float(0.15), sin(ph).mul(0.75).add(0.15), away), a2 = a1.add(mix(float(-0.3), sin(ph.sub(1.0)).mul(0.35), away));
  const spread = isWing.mul(max(away.mul(burst.mul(0.85).add(0.15)), flick));

  // ---- the vertex: shape, wings, beak, head, puff, then the bird's orientation and place ----
  const sitP = mix(positionGeometry, attribute('aCrow', 'vec3'), kind);
  const flyP = mix(attribute('aFly', 'vec3'), attribute('aCrowFly', 'vec3'), kind);
  const sitN = mix(normalGeometry, attribute('aCrowN', 'vec3'), kind);
  const elbow = mix(float(ELBOW.sparrow), float(ELBOW.crow), kind);
  const sx = sign(flyP.x), r = abs(flyP.x), r1 = min(r, elbow), r2 = max(r.sub(elbow), 0.0);
  const flapP = vec3(sx.mul(r1.mul(cos(a1)).add(r2.mul(cos(a2)))), flyP.y.add(r1.mul(sin(a1))).add(r2.mul(sin(a2))), flyP.z);
  // (a mix, not r > elbow ? a2 : a1: that builds a1 inside a2's branch, and the other branch read it unset)
  const th = mix(a1, a2, r.greaterThan(elbow).select(1.0, 0.0));
  const flapN = vec3(sx.negate().mul(sin(th)), cos(th), 0.0);
  const tilt = mix(float(SHAPES.sparrow.tilt), float(SHAPES.crow.tilt), kind);
  const m = mix(flyAll, spread, isWing);
  let p = mix(sitP, mix(flyP, flapP, isWing), m);
  let n = mix(sitN, mix(rotX(sitN, tilt.negate()), flapN, isWing), m).normalize();
  // the wagtail: a long tail, pumped up and down as it stands; a slimmer body
  const wag = species.equal(3.0).select(1.0, 0.0), rump = c3(sc.s.rump);
  const pump = sin(t.mul(2.4 * TAU)).mul(0.25).add(0.05).mul(flyAll.oneMinus());
  p = mix(p, rotX(p.sub(rump).mul(vec3(1.0, 2.4, 2.4)), pump).add(rump), part.equal(2.0).select(1.0, 0.0).mul(wag));
  p = vec3(p.x.mul(wag.mul(-0.15).add(1.0)), p.y, p.z);
  // the kingfisher: a long dagger of a bill, a stub of a tail
  const kf = species.equal(4.0).select(1.0, 0.0);
  const hinge = mix(c3(sc.s.hinge), c3(sc.c.hinge), kind);
  p = mix(p, p.sub(hinge).mul(3.2).add(hinge), part.greaterThan(3.5).select(1.0, 0.0).mul(kf));
  p = mix(p, p.sub(rump).mul(0.55).add(rump), part.equal(2.0).select(1.0, 0.0).mul(kf));
  // the lower beak opens about its base (the crow's caw)
  const open = part.equal(5.0).select(caw.mul(0.55), 0.0);
  p = rotX(p.sub(hinge), open.negate()).add(hinge);
  // the head turns and dips about the neck (not in flight)
  const neck = mix(c3(sc.s.neck), c3(sc.c.neck), kind), hw = inf.w.mul(flyAll.oneMinus());
  p = rotY(rotX(p.sub(neck), headDip.mul(hw).negate()), headYaw.mul(hw)).add(neck);
  n = rotY(rotX(n, headDip.mul(hw).negate()), headYaw.mul(hw));
  // puffed up: rounder about the belly, not the legs
  const pf = puff.mul(part.equal(3.0).select(0.0, 1.0)).mul(flyAll.oneMinus());
  const belly = mix(float(SHAPES.sparrow.leg[1]), float(SHAPES.crow.leg[1]), kind);
  p = vec3(p.x.mul(pf.mul(0.18).add(1.0)), p.y.sub(belly).mul(pf.mul(0.12).add(1.0)).add(belly), p.z);
  // orientation: sitting, across the perch (the crow bowing as it caws); flying, along its path, banked into turns
  const fv = mix(loopV, flightV, flying);
  // (a flight heads for where it is going: its speed is nothing across at either end)
  const flyXZ = mix(vec2(loopV.x, loopV.z), vec2(to.x, to.z).mul(back), flying);
  const flyYaw = atan(flyXZ.x, flyXZ.y);
  const dirSit = vec3(sin(sitYaw), 0.0, cos(sitYaw)), dirFly = vec3(sin(flyYaw), 0.0, cos(flyYaw));
  const dir = mix(dirSit, dirFly, away).normalize(), yaw = atan(dir.x, dir.z);
  const flyPitch = clamp(atan(fv.y, length(fv.xz)).mul(0.5), -0.6, 0.6);
  const bow = caw.mul(0.3).add(cawWin.mul(0.12));
  const pitch = mix(bow.negate(), flyPitch, away);
  const bank = sin(u.mul(TAU)).mul(0.5).mul(lside).mul(along).mul(loopFly);
  p = rotY(rotX(rotZ(p, bank), pitch), yaw);
  n = rotY(rotX(rotZ(n, bank), pitch), yaw);
  // gone to roost by rank as fewer are out; the crow hidden while away
  const out = sstep(C.w, C.w.add(0.04), uAmount).mul(gone.oneMinus());
  const anchor = A.xyz.add(B.xyz.mul(s)).add(vec3(0.0, B.w.mul(s).mul(s).add(arc), 0.0));
  const pos = anchor.add(loopOff).add(flightOff).add(p.mul(C.y.mul(out)));

  // ---------- plumage, painted from the sparrow's own body frame ----------
  const st = SHAPES.sparrow, ct = Math.cos(st.tilt), sn = Math.sin(st.tilt), F = sc.s.foot;
  const pr = positionGeometry.add(c3(F)); // back to the tilted body frame, then untilted
  const bp = vec3(pr.x, pr.y.mul(ct).sub(pr.z.mul(sn)), pr.z.mul(ct).add(pr.y.mul(sn)));
  const ax = abs(bp.x), by = bp.y, bz = bp.z, wu = inf.y, wv = inf.z;
  const far = sstep(3.0, 9.0, length(positionWorld.sub(cameraPosition))); // fine marks give way to their average
  const paint = Fn(() => {
    // (the part taken first, out here: built inside a species' branch below, it stayed there, and the wing's normal,
    // read after the branches, found it unset for every other species)
    const pt = part.toVar();
    // body: brown streaked back, buff-grey breast, the head's chestnut crown, white cheek with its black spot, black
    // bib and eye stripe, a pale half collar
    // (the mantle's black streaks run along the body, the rump plain grey-brown)
    const streak = sstep(0.45, 0.85, sin(bp.x.mul(520.0).add(sin(bz.mul(140.0)).mul(1.2)))).mul(sstep(-0.034, -0.026, bz)).mul(sstep(0.024, 0.016, bz));
    const back = mix(mix(vec3(0.33, 0.25, 0.18), vec3(0.4, 0.24, 0.11), sstep(-0.036, -0.026, bz)), vec3(0.06, 0.045, 0.035), streak.mul(mix(float(0.85), float(0.35), far)));
    const under = mix(vec3(0.42, 0.42, 0.44), vec3(0.5, 0.5, 0.5), sstep(0.0, -0.03, bz));
    const ringY = mix(float(0.0), float(0.008), sstep(0.0, 0.026, bz)); // the body's axis rising to the head
    let c = mix(under, back, sstep(-0.004, 0.006, by.sub(ringY)));
    const onHead = sstep(0.018, 0.026, bz);
    const crown = vec3(0.4, 0.18, 0.08), cheek = vec3(0.9, 0.88, 0.83), black = vec3(0.025, 0.022, 0.02);
    c = mix(c, vec3(0.78, 0.75, 0.68), sstep(0.012, 0.016, bz).mul(sstep(0.028, 0.024, bz)).mul(sstep(0.02, 0.012, by)));
    c = mix(c, select(by.greaterThan(0.0165), crown, cheek), onHead);
    c = mix(c, black, sstep(0.0045, 0.0032, length(vec3(ax.sub(0.0145), by.sub(0.0085), bz.sub(0.034)))));
    c = mix(c, black, sstep(0.0075, 0.0055, ax).mul(sstep(0.0095, 0.0075, by.sub(bz.sub(0.03).mul(0.3)))).mul(sstep(0.024, 0.03, bz)));
    c = mix(c, black, sstep(0.004, 0.006, ax).mul(sstep(0.0105, 0.0125, by)).mul(sstep(0.018, 0.0155, by)).mul(sstep(0.043, 0.049, bz)));
    c = mix(c, vec3(0.01), sstep(0.0036, 0.0026, length(vec3(ax.sub(0.0128), by.sub(0.0158), bz.sub(0.0455)))));
    c = mix(c, vec3(0.13, 0.12, 0.11), sstep(0.057, 0.059, bz));
    // wing: brown with dark feather centres, two white bars across the coverts, darker flight feathers
    const feather = sstep(0.3, 0.7, abs(fract(wv.mul(4.0).add(wu.mul(1.5))).sub(0.5)).mul(2.0)).mul(far.oneMinus());
    let w = mix(vec3(0.46, 0.3, 0.15), vec3(0.16, 0.1, 0.06), feather.mul(0.7));
    w = mix(w, vec3(0.26, 0.18, 0.11), sstep(0.45, 0.6, wu));
    const bar = (u0) => sstep(0.035, 0.015, abs(wu.sub(u0))).mul(sstep(0.15, 0.25, wv));
    w = mix(w, vec3(0.86, 0.84, 0.78), max(bar(0.17), bar(0.3)).mul(mix(float(1.0), float(0.5), far)));
    const tail = mix(vec3(0.3, 0.2, 0.12), vec3(0.42, 0.32, 0.22), sstep(0.35, 0.5, abs(wv.sub(0.5))));
    const legs = vec3(0.52, 0.4, 0.33);
    const spc = select(pt.equal(1.0), w, select(pt.equal(2.0), tail, select(pt.equal(3.0), legs, select(pt.greaterThan(3.5), vec3(0.13, 0.12, 0.11), c))));
    const eyeD = length(vec3(ax.sub(0.0128), by.sub(0.0158), bz.sub(0.0455)));
    // the white-eye: olive-green above, a yellow throat, a pale grey-white belly washed brown at the flanks, the white
    // ring round the eye; darker wings and tail; grey legs, a dark bill
    let mb = mix(mix(vec3(0.5, 0.49, 0.44), vec3(0.4, 0.33, 0.22), sstep(0.004, 0.012, ax).mul(sstep(0.01, -0.01, bz)).mul(0.6)), vec3(0.2, 0.28, 0.05), sstep(-0.004, 0.006, by.sub(ringY)));
    mb = mix(mb, vec3(0.6, 0.52, 0.05), sstep(0.012, 0.022, bz).mul(sstep(0.012, 0.004, by)));
    mb = mix(mb, vec3(0.24, 0.32, 0.05), onHead.mul(sstep(0.008, 0.013, by)));
    mb = mix(mb, vec3(0.92, 0.92, 0.88), sstep(0.0019, 0.0011, abs(eyeD.sub(0.0048))));
    mb = mix(mb, vec3(0.01), sstep(0.0034, 0.0026, eyeD));
    const mw = mix(vec3(0.17, 0.23, 0.05), vec3(0.08, 0.1, 0.04), max(feather.mul(0.6), sstep(0.45, 0.6, wu)));
    const mej = select(pt.equal(1.0), mw, select(pt.equal(2.0), vec3(0.1, 0.13, 0.05), select(pt.equal(3.0), vec3(0.28, 0.29, 0.32), select(pt.greaterThan(3.5), vec3(0.06, 0.06, 0.07), mb))));
    // the wagtail: black above and on the breast, the white forehead and brow, a white belly; a broad white panel on
    // the black wing, the tail black with white edges; black bill and legs
    let wb = mix(vec3(0.85, 0.85, 0.83), vec3(0.02, 0.02, 0.022), max(sstep(-0.004, 0.006, by.sub(ringY)), sstep(0.0, 0.012, bz)));
    const brow = sstep(0.0035, 0.0012, abs(by.sub(0.0195).sub(bz.sub(0.04).mul(0.25)))).mul(sstep(0.028, 0.034, bz)).mul(sstep(0.004, 0.009, ax));
    wb = mix(wb, vec3(0.88, 0.88, 0.86), max(brow, sstep(0.05, 0.055, bz).mul(sstep(0.012, 0.016, by))));
    wb = mix(wb, vec3(0.01), sstep(0.0034, 0.0026, eyeD));
    const ww = mix(vec3(0.02, 0.02, 0.022), vec3(0.85, 0.85, 0.83), sstep(0.42, 0.32, wu).mul(sstep(0.2, 0.35, wv)));
    const wt = mix(vec3(0.02, 0.02, 0.022), vec3(0.85, 0.85, 0.83), sstep(0.38, 0.45, abs(wv.sub(0.5))));
    const wgt = select(pt.equal(1.0), ww, select(pt.equal(2.0), wt, select(pt.greaterThan(2.5), vec3(0.02, 0.02, 0.02), wb)));
    // the kingfisher: shining blue above with a paler turquoise streak down the back, the crown barred, orange below and
    // behind the eye, a white throat and neck patch; the bill black, the feet red
    let kb = mix(vec3(0.62, 0.22, 0.03), vec3(0.0, 0.2, 0.38), sstep(-0.006, 0.004, by.sub(ringY)));
    kb = mix(kb, vec3(0.05, 0.5, 0.6), sstep(0.006, 0.002, ax).mul(sstep(-0.004, 0.006, by.sub(ringY))).mul(sstep(0.02, 0.012, bz)));
    kb = mix(kb, vec3(0.88, 0.86, 0.8), sstep(0.03, 0.04, bz).mul(sstep(0.008, 0.002, by)));
    kb = mix(kb, vec3(0.62, 0.22, 0.03), sstep(0.0045, 0.002, length(vec2(by.sub(0.0145), bz.sub(0.04)))).mul(sstep(0.008, 0.012, ax)));
    kb = mix(kb, vec3(0.86, 0.85, 0.8), sstep(0.004, 0.0015, length(vec2(by.sub(0.009), bz.sub(0.03)))).mul(sstep(0.008, 0.012, ax)));
    kb = mix(kb, vec3(0.01), sstep(0.0034, 0.0026, eyeD));
    const kw = mix(vec3(0.0, 0.22, 0.32), vec3(0.02, 0.32, 0.42), feather.mul(0.5));
    const kfc = select(pt.equal(1.0), kw, select(pt.equal(2.0), vec3(0.0, 0.25, 0.42), select(pt.equal(3.0), vec3(0.6, 0.08, 0.04), select(pt.greaterThan(3.5), vec3(0.02), kb))));
    const small = select(species.equal(2.0), mej, select(species.equal(3.0), wgt, select(species.equal(4.0), kfc, spc)));
    // the crow: black all over, the eye and the bill a shade apart
    const crow = mix(vec3(0.045, 0.045, 0.055), vec3(0.06, 0.055, 0.055), pt.greaterThan(3.5).select(1.0, 0.0));
    return mix(small, crow, kind);
  });

  const col = paint();
  // the sunlit ground's bounce from below, and in shade the sky's blue pulled towards its grey, or a brown sparrow
  // under the cherry comes out slate
  const mat = new LitMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide }, (o) => {
    const grey = vec3(U.uSkyAmb.dot(vec3(0.3, 0.6, 0.1))).sub(U.uSkyAmb).mul(sstep(0.0, 0.35, U.uSunDir.y).mul(0.25));
    return o.add(col.mul(groundBounce().mul(0.6).add(grey)));
  });
  mat.positionNode = pos;
  mat.receivedShadowPositionNode = pos.add(n.mul(SHADOW_NORMAL_BIAS)); // (tsl.js receiverShadowPosition reads the undisplaced geometry)
  mat.normalNode = transformNormalToView(n).normalize().mul(faceDirection);
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.85), float(0.42), kind); // the crow's plumage glossy
  return mat;
}

// ---------- where they sit ----------
// lantern: lanterns.js data (hang: the rope lanterns' points, three per span at u 1/4, 1/2, 3/4 of a sag parabola);
// tree: [x, z] of the cherry tree; crown: its blossom (crownPoints); rocks: the river's rocks' tops (rockTops)
function perchedData(world, { lantern, tree, crown, rocks }) {
  const rng = mulberry32(83);
  const rand = (a, b) => a + (b - a) * rng();
  const [TX, TZ] = tree;
  const birds = [];
  let group = 0; // the sparrows' groups, one to a rope span or rail
  const add = (P, T, curv, kind, range, size, loopR, loopP, face) => birds.push({ P, T, curv, kind, range, size, loopR, loopP, face, seed: rng(), group });
  // the rope spans back from their lanterns: x, z linear in u, y a parabola sagging `sag` at the middle
  const spans = [];
  for (let i = 0; i + 2 < lantern.n; i += 3) {
    const p = (k) => new THREE.Vector3().fromArray(lantern.hang, (i + k) * 3);
    const p1 = p(0), p2 = p(1), p3 = p(2);
    const d = p3.clone().sub(p1).multiplyScalar(2); // b - a
    const sag = 4 * ((p1.y + p3.y) / 2 - p2.y);
    const lin5 = p2.y + sag, dy = 2 * (p3.y - p1.y);
    const a = new THREE.Vector3(p2.x - d.x / 2, lin5 - dy / 2, p2.z - d.z / 2);
    const L = Math.hypot(d.x, d.z);
    if (!(L > 3 && sag > 0)) continue;
    spans.push({ a, d: new THREE.Vector3(d.x, dy, d.z), sag, L, mid: p2 });
  }
  // the spans nearest these spots ([x, z], from the cherry tree): two on the west bank in front of the opening view,
  // one beside the footpath down to the bridge (close to the walk), one across the river; the group on each
  const SPOTS = [[5.1, 15.7, 3], [4.8, 9.2, 5], [-4.3, -30.8, 4], [22.8, -14.1, 3]];
  const used = [];
  for (const [dx, dz, n] of SPOTS) {
    let best = null, bd = 12;
    for (const sp of spans) {
      const dd = Math.hypot(sp.mid.x - TX - dx, sp.mid.z - TZ - dz);
      if (dd < bd && !used.some((u) => u.sp === sp)) { bd = dd; best = sp; }
    }
    if (best) used.push({ sp: best, n });
  }
  used.forEach(({ sp, n }) => {
    group++;
    // a gap between two lanterns (or a post and one), the group in its middle part, 15-21 cm apart, each hopping
    // within 1.5-4 cm of its place so neighbours keep clear
    const gap = Math.floor(rng() * 4), u0 = gap * 0.25 + 0.04, u1 = (gap + 1) * 0.25 - 0.04;
    const gapM = (u1 - u0) * sp.L, sep = rand(0.15, 0.21), width = (n - 1) * sep;
    const c = (u0 + u1) / 2 + (rng() - 0.5) * Math.max(0, gapM - width - 0.3) / sp.L;
    const face = rng() < 0.5 ? 0 : 1;
    for (let k = 0; k < n; k++) {
      const uk = c + ((k - (n - 1) / 2) * sep + (rng() - 0.5) * 0.02) / sp.L;
      const P = sp.a.clone().add(new THREE.Vector3(sp.d.x * uk, sp.d.y * uk - 4 * sp.sag * uk * (1 - uk) + ROPE_R, sp.d.z * uk));
      // along the rope per horizontal metre, its slope there; the parabola's curvature in those metres
      const T = new THREE.Vector3(sp.d.x / sp.L, (sp.d.y - 4 * sp.sag * (1 - 2 * uk)) / sp.L, sp.d.z / sp.L);
      add(P, T, (4 * sp.sag) / (sp.L * sp.L), 0, Math.min(0.04, sep / 2 - 0.06), rand(0.94, 1.06), rand(1.2, 2.4), 0.45, rng() < 0.8 ? face : 1 - face);
    }
  });
  // the bridge's top rails, half-way between posts in the arch's middle part
  const { pt } = bridgeFrame(world, BRIDGE_Z);
  const arc = [0];
  for (let i = 1; i <= 400; i++) arc.push(arc[i - 1] + pt(i / 400).distanceTo(pt((i - 1) / 400)));
  const uAt = (l) => { let i = 1; while (i < 400 && arc[i] < l) i++; return (i - 1 + (l - arc[i - 1]) / (arc[i] - arc[i - 1])) / 400; };
  for (const [sd, j, n] of [[1, 6.5, 3], [-1, 3.5, 3]]) {
    group++;
    const off = sd * RAIL_OFF, sep = rand(0.15, 0.21), face = rng() < 0.5 ? 0 : 1;
    for (let k = 0; k < n; k++) {
      const l = (j / 10) * arc[400] + (k - (n - 1) / 2) * sep;
      const u = uAt(l), e = 1e-3;
      const P = pt(u, off, RAIL_TOP), P0 = pt(u - e, off, RAIL_TOP), P1 = pt(u + e, off, RAIL_TOP);
      const hz = Math.hypot(P1.x - P0.x, P1.z - P0.z);
      const T = new THREE.Vector3((P1.x - P0.x) / hz, (P1.y - P0.y) / hz, (P1.z - P0.z) / hz);
      const curv = (P1.y - 2 * P.y + P0.y) / ((hz / 2) * (hz / 2)) / 2;
      add(P, T, curv, 0, Math.min(0.04, sep / 2 - 0.06), rand(0.94, 1.06), rand(1.5, 2.6), 0.4, rng() < 0.8 ? face : 1 - face);
    }
  }
  // the crow on the torii's top beam, off its middle
  const tr = TORII[0], base = world.height(tr.x, tr.z) - 0.1, cy = Math.cos(tr.yaw), sy = Math.sin(tr.yaw);
  const beam = (x) => new THREE.Vector3(tr.x + x * cy, base + KASAGI.y + KASAGI.rise * (x / KASAGI.half) ** 4, tr.z - x * sy);
  const x0 = -0.75, cp = beam(x0), e = 0.01, b0 = beam(x0 - e), b1 = beam(x0 + e);
  const crowT = new THREE.Vector3((b1.x - b0.x) / (2 * e), (b1.y - b0.y) / (2 * e), (b1.z - b0.z) / (2 * e));
  add(cp, crowT, (b1.y - 2 * cp.y + b0.y) / (e * e) / 2, 1, 0.45, 1, 0, 0, 0);
  birds[birds.length - 1].species = SPECIES.crow;
  // the crows' woods: on the knoll round the temple, the nearest grove that way, over the trees
  let to = null;
  for (let k = 0; k < 200; k++) {
    const a = rng() * TAU, d = rand(30, 90), x = world.temple.x + Math.cos(a) * d, z = world.temple.z + Math.sin(a) * d;
    if (world.grove(x, z) > 0.4 && (!to || Math.hypot(x - cp.x, z - cp.z) < Math.hypot(to.x - cp.x, to.z - cp.z))) to = new THREE.Vector3(x, 0, z);
  }
  if (!to) to = new THREE.Vector3(world.temple.x, 0, world.temple.z);
  to.y = Math.max(world.height(to.x, to.z), 0) + 16;
  // white-eyes in the cherry tree's blossom, on flowers of its lower crown (each perched a little under its flower,
  // facing any way)
  const spots = twigs(world, crown);
  for (let k = 0; k < MEJIRO && spots.length; k++) {
    const { p, T } = spots[Math.floor(rng() * spots.length)];
    add(p.clone(), T.clone(), 0, 0, 0.02, rand(1.9, 2.2), 0, 0, rng() < 0.5 ? 0 : 1); // (large, as the flowers are)
    birds[birds.length - 1].species = SPECIES.mejiro;
  }
  // and two tree sparrows working the blossom with them, biting off whole flowers for their nectar (outside a group)
  for (let k = 0; k < TREE_SPARROWS && spots.length; k++) {
    const { p, T } = spots[Math.floor(rng() * spots.length)];
    group = -1;
    add(p.clone(), T.clone(), 0, 0, 0.02, rand(1.45, 1.55), 0, 0, rng() < 0.5 ? 0 : 1); // (large, as the white-eyes)
    birds[birds.length - 1].tree = true;
  }
  // wagtails on the river's rocks, on each rock's top
  const tops = [...rocks].sort(() => rng() - 0.5);
  for (let k = 0; k < Math.min(WAGTAILS, tops.length - 1); k++) {
    const r = tops[k], a = rng() * TAU;
    add(r.clone(), new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 0, 0, 0.05, rand(1.45, 1.55), 0, 0, rng() < 0.5 ? 0 : 1); // (large, as the mejiro)
    birds[birds.length - 1].species = SPECIES.wagtail;
  }

  // the kingfisher: on the lantern ropes along the banks, where they run near the water
  const fishing = [];
  for (const sp of spans) for (let u = 0.1; u <= 0.9; u += 0.04) {
    const P = sp.a.clone().add(new THREE.Vector3(sp.d.x * u, sp.d.y * u - 4 * sp.sag * u * (1 - u) + ROPE_R, sp.d.z * u));
    const ri = world.riverInfo(P.x, P.z), off = Math.abs(ri.d) - ri.hw;
    if (off < -0.3 || off > 3.6) continue;
    const T = new THREE.Vector3(sp.d.x / sp.L, (sp.d.y - 4 * sp.sag * (1 - 2 * u)) / sp.L, sp.d.z / sp.L);
    if (!fishing.some((f) => f.P.distanceTo(P) < 3)) fishing.push({ P, T, curv: (4 * sp.sag) / (sp.L * sp.L), dTree: Math.hypot(P.x - TX, P.z - TZ) });
  }
  fishing.sort((a, b) => a.dTree - b.dTree);
  if (fishing.length) {
    const f = fishing[0];
    add(f.P.clone(), f.T.clone(), f.curv, 0, 0.02, 1.6, 0, 0, 0);
    birds[birds.length - 1].species = SPECIES.kingfisher;
  }

  const n = birds.length;
  const aA = new Float32Array(n * 4), aB = new Float32Array(n * 4), aC = new Float32Array(n * 4), aD = new Float32Array(n * 4);
  const aE = new Float32Array(n * 4), aF = new Float32Array(n * 4);
  birds.forEach((o, i) => {
    aA.set([o.P.x, o.P.y, o.P.z, o.seed], i * 4);
    aB.set([o.T.x, o.T.y, o.T.z, o.curv], i * 4);
    // ranks spread through the groups (golden-ratio steps), so each thins out; the crow goes to roost half-way
    aC.set([o.kind, o.size, o.range, o.kind ? 0.5 : ((i * 0.618034 + 0.3) % 1) * 0.9], i * 4);
    aD.set([o.loopR, o.loopP, o.face, 0], i * 4);
    aE.set([-1e4, -1e4 + 1, 0, 0], i * 4); // home: its flight long over
    aF.set([o.species ?? SPECIES.sparrow, o.species === SPECIES.crow ? 1 : 0, 0, 0], i * 4);
  });
  return { aA, aB, aC, aD, aE, aF, n, birds, fishing, crow: { at: cp, to }, spans: spans.map((sp) => sp.mid.toArray().map((v) => +v.toFixed(1))) };
}

const MEJIRO = 7, WAGTAILS = 3, TREE_SPARROWS = 2;
// a cherry's twigs low enough to see the white-eyes in, out towards the crown's edge
const twigs = (world, crown) => {
  if (!crown) return [];
  const pts = crown.pts.filter(({ p }) => { const h = p.y - world.height(p.x, p.z); return h > 1.6 && h < 5; });
  const r = (q) => Math.hypot(q.p.x - crown.x, q.p.z - crown.z), mid = pts.map(r).sort((a, b) => a - b)[pts.length >> 1];
  return pts.filter((q) => r(q) > mid);
};

// The river's rocks' tops for the wagtails and the turtles (turtles.js): each in-water rock's highest point, from the
// rocks' instanced models (lods.js makeLods: each level's instance matrices with the model's node folded in), and as
// its `surface` the finest level's vertices within 30 cm of it. rocksInWater: [{ x, z, r }]
export function rockTops(world, rocks, rocksInWater) {
  // the river round it, not the bank's grass: water a little way off on three sides at least
  const water = (x, z) => [0, 1, 2, 3].filter((k) => world.height(x + Math.cos(k * Math.PI / 2) * 0.9, z + Math.sin(k * Math.PI / 2) * 0.9) < -0.02).length >= 3;
  const out = [], m = new THREE.Matrix4(), v = new THREE.Vector3();
  for (const r of rocksInWater) {
    let best = null, fine = null;
    rocks.traverse((o) => {
      const L = o.userData.level;
      if (!L || !o.isInstancedMesh) return;
      const pos = L.src.geometry.attributes.position;
      for (let i = 0; i < L.M.length / 16; i++) {
        if (Math.hypot(L.M[i * 16 + 12] - r.x, L.M[i * 16 + 14] - r.z) > r.r * 0.6) continue;
        m.fromArray(L.M, i * 16);
        const pts = [];
        for (let j = 0; j < pos.count; j++) {
          v.fromBufferAttribute(pos, j).applyMatrix4(m);
          pts.push(v.clone());
          if (!best || v.y > best.y) best = v.clone();
        }
        if (!fine || pts.length > fine.length) fine = pts;
      }
    });
    // a top above the water, wide enough to stand on
    if (best && best.y > 0.08 && r.r > 0.35 && out.every((o) => o.distanceTo(best) > 0.3) && water(best.x, best.z)) {
      best.surface = fine.filter((p) => p.y > best.y - 0.3);
      out.push(best);
    }
  }
  return out;
}

// Places in a cherry's crown to land on: by its flowering twigs (tree.js treeData `perches`, in the tree's group), on
// the outside of the twig's cluster (the scene's flowers are drawn large: inside it a bird would be lost), each
// { p, T (along the twig) }
export function crownPoints(tree) {
  tree.group.updateMatrixWorld(true);
  const P = tree.data.perches, M = tree.group.matrixWorld, R = new THREE.Matrix3().setFromMatrix4(M), pts = [];
  const cx = tree.group.position.x, cz = tree.group.position.z, s = tree.group.scale.x;
  for (let i = 0; i < P.length; i += 6) {
    const T = new THREE.Vector3(P[i + 3], P[i + 4], P[i + 5]).applyMatrix3(R).normalize();
    const p = new THREE.Vector3(P[i], P[i + 1], P[i + 2]).applyMatrix4(M);
    const out = new THREE.Vector3(p.x - cx, 0, p.z - cz).normalize().multiplyScalar(0.2 * s);
    pts.push({ p: p.add(out).add(new THREE.Vector3(0, -0.06 * s, 0)), T });
  }
  return { x: cx, z: cz, pts };
}

// world: heights, groves, the temple; opts: { lantern (lanterns.js data), tree: [x, z], crowns (crownPoints of the
// cherries, the main tree first), rocks (rockTops) }
export function makePerched(world, opts) {
  const d = perchedData(world, { ...opts, crown: opts.crowns[0] });
  const geom = perchedGeometry();
  const geo = geom.g;
  // the six per-bird vec4s in one interleaved instance buffer
  const K = ['aA', 'aB', 'aC', 'aD', 'aE', 'aF'], W = K.length * 4;
  const inst = new Float32Array(d.n * W);
  K.forEach((k, j) => { for (let i = 0; i < d.n; i++) inst.set(d[k].subarray(i * 4, i * 4 + 4), i * W + j * 4); });
  const ib = new THREE.InstancedInterleavedBuffer(inst, W, 1);
  K.forEach((k, j) => geo.setAttribute(k, new THREE.InterleavedBufferAttribute(ib, 4, j * 4)));
  geo.instanceCount = d.n;
  const uAmount = uniform(0);
  const mesh = new THREE.Mesh(geo, perchedMaterial(geom, uAmount));
  mesh.name = 'perched';
  mesh.frustumCulled = false;
  mesh.layers.set(1); // not in the reflection or the shadow maps
  const rng = mulberry32(97);
  const rand = (a, b) => a + (b - a) * rng();

  // ---------- each bird's flight: written into its instance ----------
  const at = (i) => new THREE.Vector3(inst[i * W], inst[i * W + 1], inst[i * W + 2]);
  const dur = (i, len) => Math.min(11, Math.max(0.3, len / (d.birds[i].kind ? 8 : 7))); // as the vertex stage has it
  // off to P (leaving at t0, back at t1: Infinity for not yet)
  const fly = (i, P, t0, t1 = Infinity) => {
    const a = at(i), o = i * W;
    inst[o + 15] = P.y - a.y; // aD.w
    inst[o + 16] = t0; inst[o + 17] = Math.min(t1, 1e6); inst[o + 18] = P.x - a.x; inst[o + 19] = P.z - a.z;
    ib.needsUpdate = true;
    return t0 + dur(i, a.distanceTo(P));
  };
  const comeBack = (i, t1) => { inst[i * W + 17] = t1; ib.needsUpdate = true; return t1 + dur(i, Math.hypot(inst[i * W + 15], inst[i * W + 18], inst[i * W + 19])); };
  // landed: where it went is its perch now (facing `yaw` along it), its flight cleared
  const land = (i, yaw = rng() * TAU) => {
    const o = i * W;
    inst[o] += inst[o + 18]; inst[o + 1] += inst[o + 15]; inst[o + 2] += inst[o + 19];
    inst[o + 4] = Math.cos(yaw); inst[o + 5] = 0; inst[o + 6] = Math.sin(yaw); inst[o + 7] = 0;
    inst[o + 15] = 0; inst[o + 16] = -1e4; inst[o + 17] = -1e4 + 1; inst[o + 18] = 0; inst[o + 19] = 0;
    ib.needsUpdate = true;
  };

  // ---------- the sparrows' groups: each on its rope or rail, off together into the nearest cherry ----------
  const groups = new Map();
  d.birds.forEach((b, i) => {
    if ((b.species !== undefined && b.species !== SPECIES.sparrow) || b.tree) return;
    const key = b.group;
    if (!groups.has(key)) groups.set(key, { ids: [], c: new THREE.Vector3(), state: 'home', t: 0, home: 0 });
    groups.get(key).ids.push(i);
  });
  for (const g of groups.values()) {
    for (const i of g.ids) g.c.add(at(i));
    g.c.divideScalar(g.ids.length);
    // the nearest cherry's blossom on the group's side of it
    let best = null;
    for (const cr of opts.crowns) { const dd = Math.hypot(cr.x - g.c.x, cr.z - g.c.z); if (dd < 40 && (!best || dd < best.d)) best = { cr, d: dd }; }
    g.refuge = best ? best.cr.pts.filter(({ p }) => p.y - world.height(p.x, p.z) > 1.8).sort((a, b) => a.p.distanceTo(g.c) - b.p.distanceTo(g.c)).slice(0, 40) : [];
  }
  const crowId = d.birds.findIndex((b) => b.species === SPECIES.crow);
  const crow = { state: 'home', t: 0 };
  // in the cherry's blossom: the white-eyes, and the sparrows that bite flowers off
  const mejiro = d.birds.map((b, i) => (b.species === SPECIES.mejiro || b.tree ? { i, next: rand(1, 5), lands: 0, bites: !!b.tree } : null)).filter(Boolean);
  const bites = []; // whole flowers bitten off ({ x, y, z }), taken each frame (dropped.js)
  const wagtails = d.birds.map((b, i) => (b.species === SPECIES.wagtail ? { i, next: rand(6, 20), lands: 0 } : null)).filter(Boolean);
  const mejiroSpots = twigs(world, opts.crowns[0]);
  const rocks = opts.rocks;
  const kingfisher = d.birds.map((b, i) => (b.species === SPECIES.kingfisher ? { i, next: rand(5, 15), lands: 0, dive: null, home: d.fishing[0] } : null)).filter(Boolean)[0];
  const splashes = [], events = [];
  let song = rand(4, 15), lastT = null; // the white-eyes' next song (s); the clock at the last update
  const tmp = new THREE.Vector3(), walkerAt = new THREE.Vector3();
  let calm = false;

  return {
    mesh,
    // ctx: { hour, rain, wind (0..1), camera, walker (where the walker's feet are: {x, y, z}, or null), warming }
    update(ctx) {
      const h = ctx.hour;
      const day = smoothstep(5.3, 6.3, h) * (1 - smoothstep(17.2, 18.4, h));
      uAmount.value = day * (1 - 0.7 * smoothstep(0.05, 0.5, ctx.rain)) * (1 - smoothstep(0.5, 0.75, ctx.wind));
      mesh.visible = ctx.warming || uAmount.value > 0.001; // (warm-up builds the pipeline)
      const now = U.uTime.value, out = uAmount.value > 0.5 && !calm;
      if (ctx.walker) walkerAt.set(ctx.walker.x, ctx.walker.y + 1.2, ctx.walker.z);
      // how near someone is: the walker, or the camera at `k` of the walker's distances
      const near = (P, r, k) => Math.min(ctx.walker ? walkerAt.distanceTo(P) / r : Infinity, ctx.camera.position.distanceTo(P) / (r * k));
      // sparrows: off into the blossom, staggered; back once it has been quiet a while
      for (const g of groups.values()) {
        if (g.state === 'home' && now > g.home && out && g.refuge.length && near(g.c, FLUSH, CAMERA_FLUSH / FLUSH) < 1) {
          g.state = 'away'; g.t = now + rand(QUIET[0], QUIET[1]);
          for (const i of g.ids) fly(i, g.refuge[Math.floor(rng() * g.refuge.length)].p, now + rng() * 0.35);
        } else if (g.state === 'away' && now > g.t && near(g.c, CLEAR, 0.5) > 1) {
          g.state = 'home';
          for (const i of g.ids) g.home = Math.max(g.home, comeBack(i, now + rng() * 4));
        }
      }
      // the crow: off to the woods when someone comes close; back a minute later, or later while they stay near
      if (crowId >= 0) {
        const c = at(crowId);
        if (crow.state === 'home' && out && near(c, CROW_NEAR, 1) < 1) { crow.state = 'away'; crow.t = now + CROW_AWAY; fly(crowId, d.crow.to, now); }
        else if (crow.state === 'away' && now > crow.t) {
          if (near(c, CROW_NEAR * 1.6, 1) < 1) crow.t = now + 10;
          else { crow.state = 'home'; comeBack(crowId, now); }
        }
      }
      // white-eyes: a song from one of them now and then; flitting from flower to flower, a few metres at most, now and then across the crown
      song -= lastT === null ? 0 : now - lastT;
      lastT = now;
      if (mejiro.length && out && song <= 0) {
        song = rand(10, 30);
        const a = at(mejiro[Math.floor(rng() * mejiro.length)].i);
        events.push({ kind: 'mejiro', x: a.x, y: a.y, z: a.z });
      }
      for (const m of mejiro) {
        if (m.lands && now >= m.lands) {
          land(m.i, m.yaw); m.lands = 0;
          // a sparrow nips off the flower it lands by, drinks from its base and lets it fall
          if (m.bites && out && rng() < 0.6) { const a = at(m.i); bites.push({ x: a.x, y: a.y + 0.05, z: a.z, t: now + rand(1, 2.5) }); }
        }
        if (!m.lands && now >= m.next && mejiroSpots.length) {
          const a = at(m.i), far = rng() < 0.2;
          let P = null;
          for (let k = 0; k < 20 && !P; k++) {
            const c = mejiroSpots[Math.floor(rng() * mejiroSpots.length)], dd = c.p.distanceTo(a);
            if (dd > 0.25 && dd < (far ? 6 : 1.8)) P = c;
          }
          if (P) { m.lands = fly(m.i, P.p, now); m.yaw = Math.atan2(P.T.z, P.T.x); }
          m.next = (m.lands || now) + rand(1.5, 6);
        }
      }
      // wagtails: rock to rock, low over the water; to the far side when someone comes near
      for (const w of wagtails) {
        if (w.lands && now >= w.lands) { land(w.i); w.lands = 0; }
        const a = at(w.i);
        const scared = out && near(a, WAG_FLUSH, CAMERA_FLUSH / WAG_FLUSH) < 1;
        if (!w.lands && (now >= w.next || scared) && rocks.length > 1) {
          let P = null, bd = -Infinity;
          for (let k = 0; k < 12; k++) {
            const r = rocks[Math.floor(rng() * rocks.length)], dd = r.distanceTo(a);
            if (dd < 1 || dd > 22 || wagtails.some((o) => o !== w && at(o.i).distanceTo(r) < 0.5)) continue;
            // scared: the rock furthest from whoever came; else a near one
            const score = scared ? near(r, 1, 1) : -dd + rng() * 6;
            if (score > bd) { bd = score; P = r; }
          }
          if (P) { w.lands = fly(w.i, P.clone(), now); events.push({ kind: 'sekirei', x: a.x, y: a.y, z: a.z }); }
          w.next = (w.lands || now) + rand(8, 25);
        }
      }
      // the kingfisher: watching the water from the rope, diving now and then (in, a ring, straight back up), or off
      // along the river to another of its perches; away to the furthest when someone comes near
      if (kingfisher) {
        const k = kingfisher, a = at(k.i);
        if (k.dive && now >= k.dive.t) { splashes.push({ x: k.dive.x, z: k.dive.z, amp: 0.8, r: 0.02 }); events.push({ kind: 'plop', x: k.dive.x, y: 0, z: k.dive.z }); k.dive = null; }
        if (k.lands && now >= k.lands) { land(k.i, Math.atan2(k.to.T.z, k.to.T.x)); k.lands = 0; }
        const scared = out && near(a, KF_FLUSH, CAMERA_FLUSH / KF_FLUSH) < 1;
        if (!k.lands && !k.dive && (now >= k.next || scared)) {
          // a dive: 4.5-7.5 m out (the ropes run about 3.3 m back from the water), over deeper water
          const ri = world.riverInfo(a.x, a.z), side = Math.sign(ri.d) || 1, out_ = 4.5 + rng() * 3;
          const W = new THREE.Vector3(a.x - side * out_, -0.05, a.z + (rng() - 0.5) * 2);
          if (!scared && rng() < 0.6 && world.height(W.x, W.z) < -0.3) {
            const t1 = fly(k.i, W, now);
            if (rng() < 0.5) events.push({ kind: 'kawasemi', x: a.x, y: a.y, z: a.z });
            comeBack(k.i, t1);
            k.dive = { t: t1, x: W.x, z: W.z };
            k.next = t1 + dur(k.i, a.distanceTo(W)) + rand(10, 25);
          } else if (d.fishing.length > 1) {
            let best = null, bd = -Infinity;
            for (const f of d.fishing) {
              const dd = f.P.distanceTo(a);
              if (dd < 2 || dd > 40) continue;
              const score = scared ? near(f.P, 1, 1) : -dd + rng() * 10;
              if (score > bd) { bd = score; best = f; }
            }
            if (best) { k.to = best; k.lands = fly(k.i, best.P, now); events.push({ kind: 'kawasemi', x: a.x, y: a.y, z: a.z }); }
            k.next = (k.lands || now) + rand(15, 40);
          }
        }
      }
    },
    splashes, // rings on the water (touches.js)
    events, // calls for the sound (audio.js call), taken each frame
    // whole flowers bitten off and let fall: those due, taken each frame
    bitten() { const now = U.uTime.value, due = bites.filter((b) => now >= b.t); for (const b of due) bites.splice(bites.indexOf(b), 1); return due; },
    // debug: where each sits (now), its species, the rope spans' middles, the crow's and the sparrow groups' states, how
    // many rocks the wagtails have; calm: no bird minds anyone (for close looks)
    info(o = {}) {
      if (o.calm !== undefined) calm = !!o.calm;
      const birds = [];
      for (let i = 0; i < d.n; i++) birds.push(at(i).toArray().map((v) => +v.toFixed(2)));
      const species = [...Array(d.n)].map((_, i) => Object.keys(SPECIES)[inst[i * W + 20]]);
      return { n: d.n, amount: uAmount.value, visible: mesh.visible, crow: crow.state, groups: [...groups.values()].map((g) => g.state), crowAt: d.crow.at.toArray().map((v) => +v.toFixed(2)), birds, species, spans: d.spans, rocks: rocks.length };
    },
  };
}
