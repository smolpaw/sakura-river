// A tanuki (raccoon dog) about the field edges by the village after dark: out from 19:30 to 04:30, ambling from spot
// to spot among the farmhouses' yards, the lane's verges and the paddies' levees west of the bridge (ROAM), stopping
// to sniff at the ground. When the walker comes within WARY m it freezes and stares, as tanuki do, then trots off
// 20 m or so and goes on with its night. Built here: a round grizzled body, short black legs, the dark mask round the
// eyes with the pale muzzle and cheeks, small rounded ears, a bushy tail; the legs swing about the hips in a walk (a
// trot when it hurries), the head drops to sniff. One mesh; per-object uniforms carry the gait.
import * as THREE from 'three/webgpu';
import { Fn, vec3, float, sin, cos, abs, mix, attribute, uniform, positionGeometry, normalGeometry, transformNormalToView } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LitMaterial, U, sstep, SHADOW_NORMAL_BIAS } from './tsl.js';
import { mulberry32 } from './noise.js';

const SIZE = 1.3; // against life (60 cm nose to tail tip): large, as the scene's other animals are
const ROAM = { x: [-62, -26], z: [-92, -52] }; // where it goes about
const WARY = 10, CAMERA_WARY = 3; // m
const OUT = [19.5, 4.5]; // clock hours
const AMBLE = 0.55, TROT = 2.4; // m/s at life size
const STRIDE = { amble: 0.3, trot: 0.55 }; // m per cycle
const HIP = { f: [0.06, 0.2, 0.17], h: [0.065, 0.2, -0.15] }; // the left legs' roots (life size)

// parts (aPart): 0 body, 1 head, 2 ears, 3 tail, 4-7 legs (front left, front right, hind left, hind right)
function tanukiGeometry() {
  const parts = [];
  const add = (g, k) => {
    g = g.index ? g.toNonIndexed() : g;
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(k), 1));
    delete g.attributes.uv;
    parts.push(g);
  };
  const ell = (rx, ry, rz, x, y, z, rot = 0, seg = 14) => new THREE.SphereGeometry(1, seg, seg >> 1).scale(rx, ry, rz).rotateX(rot).translate(x, y, z);
  add(ell(0.11, 0.1, 0.21, 0, 0.22, 0, 0, 18), 0);
  add(ell(0.075, 0.065, 0.075, 0, 0.26, 0.24), 1);
  add(ell(0.028, 0.026, 0.06, 0, 0.24, 0.31, 0.15, 10), 1);
  for (const s of [1, -1]) add(ell(0.022, 0.026, 0.01, s * 0.045, 0.32, 0.22, 0, 8), 2);
  add(ell(0.045, 0.045, 0.11, 0, 0.18, -0.27, 0.7, 12), 3);
  [[1, 'f'], [-1, 'f'], [1, 'h'], [-1, 'h']].forEach(([s, k], i) => {
    const h = HIP[k], leg = new THREE.CylinderGeometry(0.024, 0.02, h[1], 8, 2).translate(s * h[0], h[1] / 2, h[2]);
    add(leg, 4 + i);
  });
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return g;
}

export function makeTanuki(world) {
  const rng = mulberry32(29);
  const rand = (a, b) => a + (b - a) * rng();
  const uPhase = uniform(0).onObjectUpdate(({ object }) => object.userData.phase);
  const uSwing = uniform(0).onObjectUpdate(({ object }) => object.userData.swing);
  const uTrot = uniform(0).onObjectUpdate(({ object }) => object.userData.trot);
  const uSniff = uniform(0).onObjectUpdate(({ object }) => object.userData.sniff);
  const part = attribute('aPart', 'float');
  const is = (k) => sstep(0.5, 0.0, abs(part.sub(k)));
  const q = positionGeometry;
  // legs: each swings about its hip, in the walk's order (hind left, fore left, hind right, fore right) or the trot's
  // diagonal pairs, the foot lifted on the swing forward
  const legs = [[4, 0.25, 0.5, HIP.f], [5, 0.75, 0.0, HIP.f], [6, 0.0, 0.0, HIP.h], [7, 0.5, 0.5, HIP.h]];
  let pl = vec3(q);
  for (const [k, walk, trot, h] of legs) {
    const ph = uPhase.add(mix(float(walk), float(trot), uTrot)).mul(Math.PI * 2);
    const a = sin(ph).mul(uSwing).mul(0.45);
    const y = q.y.sub(h[1]), z = q.z.sub(h[2]);
    const lift = cos(ph).max(0.0).mul(uSwing).mul(0.03).mul(sstep(0.1, 0.0, q.y));
    const sw = vec3(q.x, y.mul(cos(a)).sub(z.mul(sin(a))).add(h[1]).add(lift), y.mul(sin(a)).add(z.mul(cos(a))).add(h[2]));
    pl = mix(pl, sw, is(k));
  }
  let p = pl;
  // the head (and ears) down to sniff
  const hd = is(1.0).add(is(2.0)), sa = uSniff.mul(0.6), hy = q.y.sub(0.26), hz = q.z.sub(0.17);
  p = mix(p, vec3(q.x, hy.mul(cos(sa)).sub(hz.mul(sin(sa))).add(0.26), hy.mul(sin(sa)).add(hz.mul(cos(sa))).add(0.17)), hd);
  // the body's bob in its stride; the tail swings
  p = p.add(vec3(0.0, sin(uPhase.mul(Math.PI * 4)).mul(0.006).mul(uSwing).mul(is(0.0).add(hd).add(is(3.0))), 0.0));
  p = p.add(vec3(sin(uPhase.mul(Math.PI * 2)).mul(0.03).mul(uSwing).mul(is(3.0)).mul(sstep(-0.2, -0.36, q.z)), 0.0, 0.0));

  // coat: grizzled grey-brown, darker along the back and the shoulders' band, black legs; the face's dark mask round
  // the eyes and down the cheeks, the pale muzzle and brows, the ears edged dark; the tail tipped dark
  const color = Fn(() => {
    const ax = abs(q.x);
    const grizzle = sin(q.x.mul(310.0)).mul(sin(q.z.mul(270.0).add(q.y.mul(190.0)))).mul(0.5).add(0.5);
    let c = mix(vec3(0.24, 0.2, 0.15), vec3(0.42, 0.37, 0.29), grizzle.mul(0.6));
    c = mix(c, vec3(0.1, 0.08, 0.06), sstep(0.27, 0.31, q.y).mul(sstep(0.04, 0.0, ax)).mul(0.6));
    c = mix(c, vec3(0.05, 0.04, 0.03), sstep(0.06, 0.12, q.z).mul(sstep(0.17, 0.12, q.z)).mul(sstep(0.24, 0.16, q.y)).mul(is(0.0)));
    const face = is(1.0), fz = q.z.sub(0.24), fy = q.y.sub(0.26);
    // grizzled like the body, pale on the muzzle's sides and in a spot over each eye, the black mask across the eyes
    // and down the cheeks, the nose dark
    let f = mix(vec3(0.24, 0.2, 0.15), vec3(0.42, 0.37, 0.29), grizzle);
    f = mix(f, vec3(0.62, 0.57, 0.48), sstep(0.03, 0.055, fz).mul(sstep(0.008, -0.015, fy)).mul(sstep(0.008, 0.018, ax)));
    f = mix(f, vec3(0.62, 0.57, 0.48), sstep(0.013, 0.008, vec3(ax.sub(0.03), fy.sub(0.032), fz.sub(0.035)).length()));
    f = mix(f, vec3(0.03, 0.025, 0.02), sstep(0.022, 0.014, abs(fy.sub(0.008).add(fz.mul(0.15)))).mul(sstep(-0.01, 0.01, fz)).mul(sstep(0.065, 0.045, fz)).mul(sstep(0.012, 0.022, ax)));
    f = mix(f, vec3(0.03, 0.025, 0.02), sstep(0.095, 0.105, fz));
    c = mix(c, f, face);
    c = mix(c, mix(vec3(0.3, 0.25, 0.2), vec3(0.04, 0.03, 0.03), sstep(0.3, 0.335, q.y)), is(2.0));
    c = mix(c, mix(c, vec3(0.05, 0.04, 0.03), sstep(-0.3, -0.36, q.z)), is(3.0));
    c = mix(c, vec3(0.035, 0.03, 0.025), is(4.0).add(is(5.0)).add(is(6.0)).add(is(7.0)));
    return c;
  })();
  const mat = new LitMaterial({ roughness: 0.95, metalness: 0, colorNode: color });
  mat.positionNode = p;
  mat.receivedShadowPositionNode = p.add(normalGeometry.mul(SHADOW_NORMAL_BIAS));
  mat.normalNode = transformNormalToView(normalGeometry).normalize();
  const mesh = new THREE.Mesh(tanukiGeometry(), mat);
  mesh.name = 'tanuki';
  mesh.castShadow = true;
  mesh.scale.setScalar(SIZE);
  mesh.userData = { phase: 0, swing: 0, trot: 0, sniff: 0 };

  // ---------- where it goes ----------
  const dry = (x, z) => {
    if (x < ROAM.x[0] - 15 || x > ROAM.x[1] + 10 || z < ROAM.z[0] - 15 || z > ROAM.z[1] + 15) return false;
    const ri = world.riverInfo(x, z);
    if (Math.abs(ri.d) < ri.hw + 1) return false;
    const F = world.heightField(x, z).F;
    if (F && F.wet && F.inside) return false;
    // not through a building (its yard is fine)
    return world.BUILDINGS.every((b) => {
      const dx = x - b.x, dz = z - b.z, lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
      return Math.abs(lx) > b.hw + 0.3 || Math.abs(lz) > b.hd + 0.3;
    });
  };
  const spot = () => {
    for (let k = 0; k < 60; k++) {
      const x = rand(...ROAM.x), z = rand(...ROAM.z);
      if (dry(x, z)) return [x, z];
    }
    return [(ROAM.x[0] + ROAM.x[1]) / 2, (ROAM.z[0] + ROAM.z[1]) / 2];
  };
  const t = { x: 0, z: 0, yaw: 0, v: 0, goal: null, state: 'out', wait: 0, flee: null };
  [t.x, t.z] = spot();
  const walkerAt = new THREE.Vector3();
  let calm = false;

  return {
    mesh,
    // ctx: { hour, camera, walker ({x, y, z} or null), warming }
    update(dt, ctx) {
      dt = Math.min(dt, 0.1);
      const out = ctx.hour > OUT[0] || ctx.hour < OUT[1];
      mesh.visible = ctx.warming || out;
      if (!out) { t.goal = null; [t.x, t.z] = spot(); return; }
      if (ctx.walker) walkerAt.set(ctx.walker.x, ctx.walker.y, ctx.walker.z);
      const near = Math.min(ctx.walker ? Math.hypot(walkerAt.x - t.x, walkerAt.z - t.z) / WARY : Infinity, Math.hypot(ctx.camera.position.x - t.x, ctx.camera.position.z - t.z) / CAMERA_WARY);
      const ud = mesh.userData;
      // wary: freeze and stare, then trot off away from them
      if (!calm && near < 1 && t.state !== 'freeze' && t.state !== 'flee') { t.state = 'freeze'; t.wait = rand(1.5, 3.5); t.goal = null; }
      if (t.state === 'freeze') {
        const P = ctx.walker ? walkerAt : ctx.camera.position;
        const to = Math.atan2(P.x - t.x, P.z - t.z);
        t.yaw += Math.atan2(Math.sin(to - t.yaw), Math.cos(to - t.yaw)) * Math.min(1, dt * 3);
        if ((t.wait -= dt) <= 0) {
          const away = to + Math.PI;
          for (let k = 0; k < 12 && t.state === 'freeze'; k++) {
            const h = away + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.35, gx = t.x + Math.sin(h) * 20, gz = t.z + Math.cos(h) * 20;
            if (dry(gx, gz)) { t.goal = [gx, gz]; t.state = 'flee'; }
          }
          if (t.state === 'freeze') t.wait = 2;
        }
      } else if (!t.goal) {
        if (t.state === 'flee') t.state = 'out';
        // sniffing a while, then on to somewhere else
        if ((t.wait -= dt) <= 0) { t.goal = spot(); t.wait = rand(3, 9); }
      }
      // going: turning towards the goal, round what it can't cross
      let want = 0;
      if (t.goal) {
        const gx = t.goal[0] - t.x, gz = t.goal[1] - t.z, d = Math.hypot(gx, gz);
        if (d < 0.4) t.goal = null;
        else {
          let head = Math.atan2(gx, gz);
          for (let i = 0; i < 11; i++) {
            const h = head + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.3;
            if (dry(t.x + Math.sin(h), t.z + Math.cos(h))) { head = h; break; }
          }
          const turn = Math.atan2(Math.sin(head - t.yaw), Math.cos(head - t.yaw));
          t.yaw += THREE.MathUtils.clamp(turn, -2.5 * dt, 2.5 * dt);
          want = (t.state === 'flee' ? TROT : AMBLE) * SIZE * Math.max(0.2, Math.cos(turn));
        }
      }
      t.v += (want - t.v) * Math.min(1, dt * 4);
      const nx = t.x + Math.sin(t.yaw) * t.v * dt, nz = t.z + Math.cos(t.yaw) * t.v * dt;
      if (dry(nx, nz)) { t.x = nx; t.z = nz; } else { t.v = 0; t.goal = null; }
      // the gait: its phase at its stride, walk or trot
      ud.trot += ((t.v > 1.2 ? 1 : 0) - ud.trot) * Math.min(1, dt * 5);
      const stride = (STRIDE.amble + (STRIDE.trot - STRIDE.amble) * ud.trot) * SIZE;
      ud.phase = (ud.phase + (t.v * dt) / stride) % 1;
      ud.swing += ((t.v > 0.05 ? 1 : 0) - ud.swing) * Math.min(1, dt * 6);
      ud.sniff += ((t.state === 'out' && !t.goal ? 1 : 0) - ud.sniff) * Math.min(1, dt * 3);
      // on the ground, pitched with it
      const y = world.height(t.x, t.z), yf = world.height(t.x + Math.sin(t.yaw) * 0.3, t.z + Math.cos(t.yaw) * 0.3);
      mesh.position.set(t.x, y, t.z);
      mesh.rotation.set(Math.atan2(y - yf, 0.3), t.yaw, 0, 'YXZ');
    },
    // debug: where it is and what it is doing; calm: it minds no one; at: [x, z] puts it there
    info(o = {}) {
      if (o.calm !== undefined) calm = !!o.calm;
      if (o.at) { [t.x, t.z] = o.at; t.goal = null; }
      return { state: t.state, x: +t.x.toFixed(2), z: +t.z.toFixed(2), v: +t.v.toFixed(2), visible: mesh.visible };
    },
  };
}
