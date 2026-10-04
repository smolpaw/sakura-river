// Birds perched where the camera spends its time: tree sparrows (suzume) in little groups of two to five on the
// lantern lines' ropes round the cherry tree and on the bridge's top rails, and a jungle crow (hashibuto-garasu) on
// the torii's top beam. The sparrows hop a few centimetres along the rope, turn about, look round, preen, puff
// themselves up, and now and then one flies a short loop out over the bank and lands again; the crow looks round,
// caws (beak open, a bow with each call), hops along the beam, and when the walker or the camera comes within 6 m it
// flies off to the temple woods and comes back a minute later. One instanced draw for all of them: the crow is the
// sparrow's mesh in another shape (a second set of positions and normals, per instance `kind`). All motion is in the
// vertex stage from the scene's running time and each bird's seed (hops and turns on a jittered step clock, the loops
// summed sines); only the crow's take-off is set from the CPU (two uniforms: when it left, when it comes back).
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
const CROW_OUT = 9, CROW_IN = 9; // its flights away and back (s)

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
  return { sit, fly, info, index: I, normal: [...g.attributes.normal.array], neck: toSit([0, c3 * 0.7 + c4 * 0.3, z3 * 0.7 + z4 * 0.3]), hinge: toSit([0, cb, zb]), foot, footLevel };
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
// (y = c s²); aC: kind (0 sparrow, 1 crow), size, how far it hops either way (m), rank; aD: its loops' radius (m),
// how often it flies one, which side it faces most, 0
function perchedMaterial(sc, uAmount, uCrow, uCrowTo) {
  const A = attribute('aA', 'vec4'), B = attribute('aB', 'vec4'), C = attribute('aC', 'vec4'), D = attribute('aD', 'vec4');
  const inf = attribute('aInfo', 'vec4'), part = inf.x;
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
  const looping = h(cyc, 7).lessThan(D.y).and(lu.lessThan(1.0)).select(1.0, 0.0).mul(sparrow);
  const u = clamp(lu, 0.0, 1.0);
  const R = D.x.mul(h(cyc, 8).mul(0.4).add(0.8));
  const lside = select(h(cyc, 10).lessThan(0.5), float(-1.0), float(1.0)), along = select(h(cyc, 11).lessThan(0.5), float(-1.0), float(1.0));
  const T = vec3(B.x, 0.0, B.z).normalize(), Pp = vec3(T.z, 0.0, T.x.negate()).mul(lside);
  const loopOff = Pp.mul(R.mul(cos(u.mul(TAU)).oneMinus().mul(0.5))).add(T.mul(R.mul(0.55).mul(sin(u.mul(TAU))).mul(along)))
    .add(vec3(0.0, R.mul(0.3).mul(sin(u.mul(Math.PI))).add(sin(u.mul(TAU)).mul(-0.1)), 0.0)).mul(looping);
  const loopV = Pp.mul(R.mul(Math.PI).mul(sin(u.mul(TAU)))).add(T.mul(R.mul(0.55 * TAU).mul(cos(u.mul(TAU))).mul(along)))
    .add(vec3(0.0, R.mul(0.3 * Math.PI).mul(cos(u.mul(Math.PI))).sub(cos(u.mul(TAU)).mul(0.2 * Math.PI)), 0.0));
  const loopFly = looping.mul(sstep(0.0, 0.05, u)).mul(sstep(1.0, 0.93, u));

  // ---- the crow's flight away to the woods and back (uCrow: when it left, when it comes back) ----
  const ta = U.uTime.sub(uCrow.x), tb = U.uTime.sub(uCrow.y);
  const goingOut = ta.greaterThanEqual(0.0).and(ta.lessThan(CROW_OUT)).select(1.0, 0.0);
  const comingIn = tb.greaterThanEqual(0.0).and(tb.lessThan(CROW_IN)).select(1.0, 0.0);
  const gone = ta.greaterThanEqual(CROW_OUT).and(tb.lessThan(0.0)).select(1.0, 0.0);
  const cu = clamp(mix(ta.div(CROW_OUT), tb.div(CROW_IN).oneMinus(), comingIn), 0.0, 1.0);
  const crowOn = max(goingOut, comingIn).mul(kind);
  // a jump up off the beam, then out and up over the trees
  const q = cu.mul(0.25).add(cu.mul(cu).mul(0.75)), qy = cu.mul(2.0).sub(cu.mul(cu));
  const crowOff = vec3(uCrowTo.x.mul(q), uCrowTo.y.mul(qy), uCrowTo.z.mul(q)).mul(crowOn);
  const crowV = vec3(uCrowTo.x.mul(cu.mul(1.5).add(0.25)), uCrowTo.y.mul(cu.oneMinus().mul(2.0)), uCrowTo.z.mul(cu.mul(1.5).add(0.25))).mul(select(comingIn.greaterThan(0.5), -1.0, 1.0));

  // ---- how much it is flying, and its wings ----
  const away = max(loopFly, crowOn);
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
  const th = r.greaterThan(elbow).select(a2, a1);
  const flapN = vec3(sx.negate().mul(sin(th)), cos(th), 0.0);
  const tilt = mix(float(SHAPES.sparrow.tilt), float(SHAPES.crow.tilt), kind);
  const m = mix(flyAll, spread, isWing);
  let p = mix(sitP, mix(flyP, flapP, isWing), m);
  let n = mix(sitN, mix(rotX(sitN, tilt.negate()), flapN, isWing), m).normalize();
  // the lower beak opens about its base (the crow's caw)
  const hinge = mix(c3(sc.s.hinge), c3(sc.c.hinge), kind), open = part.equal(5.0).select(caw.mul(0.55), 0.0);
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
  const fv = mix(loopV, crowV, kind);
  const flyYaw = atan(fv.x, fv.z);
  const dirSit = vec3(sin(sitYaw), 0.0, cos(sitYaw)), dirFly = vec3(sin(flyYaw), 0.0, cos(flyYaw));
  const dir = mix(dirSit, dirFly, away).normalize(), yaw = atan(dir.x, dir.z);
  const flyPitch = atan(fv.y, length(fv.xz)).mul(0.5);
  const bow = caw.mul(0.3).add(cawWin.mul(0.12));
  const pitch = mix(bow.negate(), flyPitch, away);
  const bank = sin(u.mul(TAU)).mul(0.5).mul(lside).mul(along).mul(loopFly);
  p = rotY(rotX(rotZ(p, bank), pitch), yaw);
  n = rotY(rotX(rotZ(n, bank), pitch), yaw);
  // gone to roost by rank as fewer are out; the crow hidden while away
  const out = sstep(C.w, C.w.add(0.04), uAmount).mul(gone.mul(kind).oneMinus());
  const anchor = A.xyz.add(B.xyz.mul(s)).add(vec3(0.0, B.w.mul(s).mul(s).add(arc), 0.0));
  const pos = anchor.add(loopOff).add(crowOff).add(p.mul(C.y.mul(out)));

  // ---------- plumage, painted from the sparrow's own body frame ----------
  const st = SHAPES.sparrow, ct = Math.cos(st.tilt), sn = Math.sin(st.tilt), F = sc.s.foot;
  const pr = positionGeometry.add(c3(F)); // back to the tilted body frame, then untilted
  const bp = vec3(pr.x, pr.y.mul(ct).sub(pr.z.mul(sn)), pr.z.mul(ct).add(pr.y.mul(sn)));
  const ax = abs(bp.x), by = bp.y, bz = bp.z, wu = inf.y, wv = inf.z;
  const far = sstep(3.0, 9.0, length(positionWorld.sub(cameraPosition))); // fine marks give way to their average
  const paint = Fn(() => {
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
    const spc = select(part.equal(1.0), w, select(part.equal(2.0), tail, select(part.equal(3.0), legs, select(part.greaterThan(3.5), vec3(0.13, 0.12, 0.11), c))));
    // the crow: black all over, the eye and the bill a shade apart
    const crow = mix(vec3(0.045, 0.045, 0.055), vec3(0.06, 0.055, 0.055), part.greaterThan(3.5).select(1.0, 0.0));
    return mix(spc, crow, kind);
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
// tree: [x, z] of the cherry tree
function perchedData(world, { lantern, tree }) {
  const rng = mulberry32(83);
  const rand = (a, b) => a + (b - a) * rng();
  const [TX, TZ] = tree;
  const birds = [];
  const add = (P, T, curv, kind, range, size, loopR, loopP, face) => birds.push({ P, T, curv, kind, range, size, loopR, loopP, face, seed: rng() });
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
  // the crows' woods: on the knoll round the temple, the nearest grove that way, over the trees
  let to = null;
  for (let k = 0; k < 200; k++) {
    const a = rng() * TAU, d = rand(30, 90), x = world.temple.x + Math.cos(a) * d, z = world.temple.z + Math.sin(a) * d;
    if (world.grove(x, z) > 0.4 && (!to || Math.hypot(x - cp.x, z - cp.z) < Math.hypot(to.x - cp.x, to.z - cp.z))) to = new THREE.Vector3(x, 0, z);
  }
  if (!to) to = new THREE.Vector3(world.temple.x, 0, world.temple.z);
  to.y = Math.max(world.height(to.x, to.z), 0) + 16;

  const n = birds.length;
  const aA = new Float32Array(n * 4), aB = new Float32Array(n * 4), aC = new Float32Array(n * 4), aD = new Float32Array(n * 4);
  birds.forEach((o, i) => {
    aA.set([o.P.x, o.P.y, o.P.z, o.seed], i * 4);
    aB.set([o.T.x, o.T.y, o.T.z, o.curv], i * 4);
    // ranks spread through the groups (golden-ratio steps), so each thins out; the crow goes to roost half-way
    aC.set([o.kind, o.size, o.range, o.kind ? 0.5 : ((i * 0.618034 + 0.3) % 1) * 0.9], i * 4);
    aD.set([o.loopR, o.loopP, o.face, 0], i * 4);
  });
  return { aA, aB, aC, aD, n, crow: { at: cp, to }, spans: spans.map((sp) => sp.mid.toArray().map((v) => +v.toFixed(1))) };
}

// world: heights, groves, the temple; opts: { lantern (lanterns.js data), tree: [x, z] }
export function makePerched(world, opts) {
  const d = perchedData(world, opts);
  const geom = perchedGeometry();
  const geo = geom.g;
  // the four per-bird vec4s in one interleaved instance buffer
  const inst = new Float32Array(d.n * 16);
  ['aA', 'aB', 'aC', 'aD'].forEach((k, j) => { for (let i = 0; i < d.n; i++) inst.set(d[k].subarray(i * 4, i * 4 + 4), i * 16 + j * 4); });
  const ib = new THREE.InstancedInterleavedBuffer(inst, 16, 1);
  ['aA', 'aB', 'aC', 'aD'].forEach((k, j) => geo.setAttribute(k, new THREE.InterleavedBufferAttribute(ib, 4, j * 4)));
  geo.instanceCount = d.n;
  const uAmount = uniform(0), uCrow = uniform(new THREE.Vector2(-1e4, -1e4)), uCrowTo = uniform(d.crow.to.clone().sub(d.crow.at));
  const mesh = new THREE.Mesh(geo, perchedMaterial(geom, uAmount, uCrow, uCrowTo));
  mesh.name = 'perched';
  mesh.frustumCulled = false;
  mesh.layers.set(1); // not in the reflection or the shadow maps
  const crowAt = d.crow.at, tmp = new THREE.Vector3();
  let calm = false;
  return {
    mesh,
    // ctx: { hour, rain, wind (0..1), camera, walker (where the walker's feet are: {x, y, z}, or null), warming }
    update(ctx) {
      const h = ctx.hour;
      const day = smoothstep(5.3, 6.3, h) * (1 - smoothstep(17.2, 18.4, h));
      uAmount.value = day * (1 - 0.7 * smoothstep(0.05, 0.5, ctx.rain)) * (1 - smoothstep(0.5, 0.75, ctx.wind));
      mesh.visible = ctx.warming || uAmount.value > 0.001; // (warm-up builds the pipeline)
      // the crow: off to the woods when someone comes close; back a minute later, or later while they stay near
      const now = U.uTime.value, c = uCrow.value;
      let dist = ctx.camera.position.distanceTo(crowAt);
      if (ctx.walker) dist = Math.min(dist, tmp.set(ctx.walker.x, ctx.walker.y + 1.5, ctx.walker.z).distanceTo(crowAt));
      const perched = now >= c.y + CROW_IN || c.x < -1e3;
      if (perched && !calm && dist < CROW_NEAR && uAmount.value > 0.5) c.set(now, now + CROW_AWAY);
      else if (now > c.x + CROW_OUT && now < c.y && now > c.y - 1 && dist < CROW_NEAR * 1.6) c.y = now + 10;
    },
    // debug: where they sit, the rope spans' middles, the crow's state; calm: the crow stays put (for close looks)
    info(o = {}) {
      if (o.calm !== undefined) calm = !!o.calm;
      const c = uCrow.value, now = U.uTime.value;
      const crow = now < c.x + CROW_OUT && now >= c.x ? 'leaving' : now < c.y ? 'away' : now < c.y + CROW_IN ? 'returning' : 'perched';
      const birds = [];
      for (let i = 0; i < d.n; i++) birds.push([...d.aA.subarray(i * 4, i * 4 + 3)].map((v) => +v.toFixed(2)));
      return { n: d.n, amount: uAmount.value, visible: mesh.visible, crow, crowAt: crowAt.toArray().map((v) => +v.toFixed(2)), birds, spans: d.spans };
    },
  };
}
