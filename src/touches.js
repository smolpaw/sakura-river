// Where things touch the river, its surface shows it: a few points in a uniform array that the water's fragment stage
// reads (water.js) within 30 m of the camera, each only within its own reach of the pixel.
// - Standing wakes, where something stands in the current: a V of small standing ripples downstream of it, its arms
//   at ~23 degrees to the flow, the first crest of each arm the strongest (a faint bright or dark line as it catches
//   the sky), a few weaker ones inside the V, a strip of broken water straight behind; stronger when the river runs
//   faster, none when it stands still. The heron's legs, the moored boat's bow (its arms come out from under the hull
//   alongside it) and square stern, the fisherman's float while it is on the water.
// - Rings, when something disturbs the water: a train of ripples spreading from it at SPEED m/s for LIFE s, drifting
//   with the current, the leading crest strongest, fading as they widen; a slope added to the water's normal, as the
//   rain's rings are, not white lines. From a point or round a capsule (the boat's hull). The float's nibble (once a
//   loop of the fisherman's `sit`) and its being lifted out and cast back; the heron's foot at each `stalk` step; the
//   boat's hull as it rocks; a koi rising under the surface now and then (koi.js).
// The sources keep `wakes` (where each stands, refreshed in their update) and push `splashes` as they happen; update()
// copies the wakes into their slots and gives each splash the next ring slot with the time it happened (the shader
// takes the ring's age from U.uTime). Nothing else on the CPU.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, dot, abs, sin, sign, length, clamp, max, uniformArray, If } from 'three/tsl';
import { U, vnoise, sstep } from './tsl.js';

const N = 12; // points in all
const WAKES = 5; // the first slots: standing wakes (the heron's two legs, the boat's bow and stern, the float)
const LIFE = 3.0, SPEED = 0.42, R0 = 0.03; // a ring's life (s), how fast its front spreads (m/s), its start (m)
const DRIFT = 0.4; // how much of the water's pattern speed (water.js uFlow) the rings drift with
const TAN = 0.42, COS = 1 / Math.hypot(1, TAN), SIN = TAN / Math.hypot(1, TAN); // the wake's arms against the flow
const TAU = Math.PI * 2;

// a: x, z and (a ring) the capsule's half axis, (a wake) its ripples' wavelength;
// b: radius, (a ring) the time it began or (a wake) its length, strength, kind (0 off, 1 ring, 2 wake)
export function makeTouches() {
  const A = Array.from({ length: N }, () => new THREE.Vector4(0, -1e4, 0, 0));
  const B = Array.from({ length: N }, () => new THREE.Vector4(0, 0, 0, 0));
  const uA = uniformArray(A, 'vec4'), uB = uniformArray(B, 'vec4');
  let next = WAKES, now = 0;
  const ring = (t, p) => {
    A[next].set(p.x, p.z, p.hx || 0, p.hz || 0);
    B[next].set(p.r || 0, t, p.amp, 1);
    next = next + 1 < N ? next + 1 : WAKES;
  };

  // the slope the touches add to the water's surface at world xz; fl: the river's downstream direction there,
  // speed: the river's speed setting
  const slope = Fn(([xz, fl, speed]) => {
    const ac = vec2(fl.y, fl.x.negate());
    const g = vec2(0.0).toVar();
    const run = clamp(speed.mul(2.0), 0.0, 1.6); // (the river speed setting is 0.45 by default)
    for (let i = 0; i < N; i++) {
      const a = uA.element(i), b = uB.element(i);
      If(b.w.greaterThan(1.5), () => {
        const rel = xz.sub(a.xy);
        const u = dot(rel, fl), c = dot(rel, ac), ca = abs(c);
        If(u.greaterThan(-0.1).and(u.lessThan(b.y)).and(ca.lessThan(b.x.add(max(u, 0.0).mul(TAN)).add(0.12))), () => {
          // s: across the arm, 0 on its line, negative inside the V
          const s = ca.sub(b.x).mul(COS).sub(u.mul(SIN));
          const w = max(u, 0.0).mul(0.16).add(0.06);
          const inside = clamp(s.div(w).add(1.0), 0.0, 1.0);
          const env = sstep(0.015, -0.01, s).mul(inside);
          const along = sstep(0.0, 0.2, u).mul(sstep(b.y, b.y.mul(0.3), u)).div(max(u, 0.0).mul(3.0).add(1.0).sqrt());
          // flickering along each arm, as the current is never quite steady
          const flick = vnoise(vec2(u.mul(7.0).sub(U.uTime.mul(0.9)), sign(c).mul(3.0).add(U.uTime.mul(0.4)))).mul(1.1).add(0.2);
          const wave = sin(s.mul(TAU).div(a.z).add(sin(U.uTime.mul(2.3).add(u.mul(5.0))).mul(0.5)));
          const gs = ac.mul(sign(c).mul(COS)).sub(fl.mul(SIN));
          g.addAssign(gs.mul(wave.mul(env).mul(along).mul(flick).mul(b.z).mul(run).mul(0.3)));
          // broken water straight behind it, carried off by the current
          const strip = sstep(b.x.add(u.mul(0.1)).add(0.03), b.x.mul(0.5), ca).mul(sstep(0.0, 0.05, u)).mul(sstep(b.y.mul(0.6), 0.0, u));
          const q = vec2(c.mul(30.0).div(b.x.mul(4.0).add(1.0)), u.sub(U.uFlow.mul(0.8)).mul(9.0));
          const jit = vec2(vnoise(q), vnoise(q.add(vec2(5.3, 2.1)))).sub(0.5);
          g.addAssign(jit.mul(strip.mul(b.z).mul(run).mul(0.6)));
        });
      }).ElseIf(b.w.greaterThan(0.5), () => {
        const age = U.uTime.sub(b.y);
        If(age.greaterThan(0.0).and(age.lessThan(LIFE)), () => {
          const rel = xz.sub(a.xy.add(fl.mul(speed.mul(1.3 * DRIFT).mul(age))));
          const h = a.zw;
          const q = rel.sub(h.mul(clamp(dot(rel, h).div(dot(h, h).add(1e-5)), -1.0, 1.0)));
          const d = length(q);
          const front = age.mul(SPEED).add(R0);
          const x = d.sub(b.x).sub(front);
          const big = b.x.mul(3.0).add(1.0); // a long thing (the hull) moves more water: longer ripples
          const train = age.mul(0.07).add(0.1).mul(big);
          If(x.greaterThan(train.negate()).and(x.lessThan(0.03)), () => {
            const lam = age.mul(0.02).add(0.06).mul(big);
            const back = clamp(x.div(train).add(1.0), 0.0, 1.0);
            const env = back.mul(back).mul(sstep(0.03, 0.0, x));
            const fade = float(1.0).sub(age.div(LIFE)).pow(1.5).div(front.add(1.0));
            const dir = q.div(max(d, 1e-3));
            const uneven = vnoise(dir.mul(2.5).add(b.y.mul(vec2(7.1, 3.3)))).mul(0.8).add(0.5); // never quite round
            g.addAssign(dir.mul(sin(x.mul(TAU).div(lam)).mul(env).mul(fade).mul(uneven).mul(b.z).mul(0.45)));
          });
        });
      });
    }
    return g;
  });

  return {
    slope,
    // sources: objects with `wakes` ([{ x, z, r, len, amp, lambda }], amp 0 for one that is off) and `splashes`
    // ([{ x, z, amp, r?, hx?, hz? }], emptied here); t: U.uTime's value
    update(t, sources) {
      let k = 0;
      now = t;
      for (const s of sources) {
        for (const w of s.wakes || []) {
          if (k >= WAKES) break;
          A[k].set(w.x, w.z, w.lambda || 0.08, 0);
          B[k].set(w.r, w.len, w.amp, w.amp > 0 ? 2 : 0);
          k++;
        }
        for (const p of s.splashes || []) ring(t, p);
        if (s.splashes) s.splashes.length = 0;
      }
    },
    // debug: a ring at (x, z) now (round a capsule of radius r and half axis (hx, hz))
    ring: (x, z, amp, r = 0, hx = 0, hz = 0) => ring(now, { x, z, amp, r, hx, hz }),
    info: () => B.map((b, i) => [A[i].x, A[i].y, b.y, b.z, b.w].map((v) => +v.toFixed(2))),
  };
}
