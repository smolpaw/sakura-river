// Birds in flight, in the background: swallows hunting over the river by day (high in fair weather, skimming the
// water under heavy cloud and in drizzle, as the saying has it before rain; gone in heavy rain), black kites circling
// high on clear days and drifting downwind, and crows flying home to the temple woods at dusk (out again at dawn, the
// odd pair by day). None at night; lightning scatters them for a while. Paths run on the CPU (a few dozen birds);
// the vertex stage flaps the wings.
import * as THREE from 'three/webgpu';
import { vec3, sin, cos, abs, sign, min, max, mix, attribute, positionGeometry, normalGeometry, transformNormalToView, faceDirection } from 'three/tsl';
import { LitMaterial } from './tsl.js';
import { mulberry32, clamp, lerp, smoothstep } from './noise.js';

const TAU = Math.PI * 2;

// Shapes in units of the wingspan, head along +z, wings along x. body: rings [z, half-width, half-height] from the
// beak back; tail: the right half's outline from its root; wing: stations [x, leading edge z, trailing edge z].
// elbow: where the hand bends (x). flap: wing-beat rate, root and hand angles (offset + amplitude, the hand lagging),
// the gliding pose, and how long bursts of beats and glides last (s).
const SPECIES = {
  swallow: {
    span: 0.5, elbow: 0.16, top: [0.015, 0.02, 0.045], belly: [0.75, 0.72, 0.66],
    body: [[0.2, 0, 0], [0.16, 0.028, 0.03], [0.08, 0.04, 0.045], [-0.04, 0.03, 0.035], [-0.12, 0.012, 0.015], [-0.13, 0, 0]],
    tail: [[0.03, -0.1], [0.07, -0.36], [0.03, -0.2], [0, -0.17]],
    wing: [[0.03, 0.07, -0.05], [0.16, 0.07, -0.07], [0.32, 0.0, -0.08], [0.5, -0.14, -0.15]],
    flap: { hz: 8.5, o1: 0.2, a1: 0.6, o2: 0.05, a2: 0.35, lag: 1.0, glide: [0.1, -0.2], on: [0.3, 0.9], off: [0.4, 1.4] },
  },
  kite: {
    span: 1.8, elbow: 0.2, top: [0.1, 0.065, 0.04], belly: [0.14, 0.1, 0.07],
    body: [[0.2, 0, 0], [0.16, 0.03, 0.035], [0.08, 0.05, 0.05], [-0.05, 0.04, 0.045], [-0.12, 0.02, 0.02], [-0.13, 0, 0]],
    tail: [[0.04, -0.1], [0.07, -0.34], [0.03, -0.31], [0, -0.32]],
    wing: [[0.03, 0.08, -0.1], [0.2, 0.08, -0.13], [0.4, 0.05, -0.1], [0.5, 0.01, -0.05]],
    flap: { hz: 2.4, o1: 0.12, a1: 0.35, o2: -0.05, a2: 0.2, lag: 0.8, glide: [0.12, -0.1], on: [1.2, 2.2], off: [15, 40] },
  },
  crow: {
    span: 1.25, elbow: 0.19, top: [0.012, 0.012, 0.016], belly: [0.012, 0.012, 0.016],
    body: [[0.24, 0, 0], [0.19, 0.025, 0.03], [0.13, 0.045, 0.05], [0.02, 0.05, 0.055], [-0.1, 0.03, 0.035], [-0.14, 0, 0]],
    tail: [[0.035, -0.11], [0.07, -0.3], [0.04, -0.33], [0, -0.34]],
    wing: [[0.03, 0.08, -0.1], [0.19, 0.08, -0.13], [0.38, 0.06, -0.11], [0.5, 0.02, -0.05]],
    flap: { hz: 3.6, o1: 0.1, a1: 0.5, o2: 0.05, a2: 0.35, lag: 0.9, glide: [0.06, -0.08], on: [3, 8], off: [0.6, 1.4] },
  },
};
const COUNT = { swallow: 10, kite: 3, crow: 22 };

function birdGeometry(sp) {
  const P = [], N = [], C = [], W = [], I = [], S = sp.span;
  const vert = (x, y, z, n, c, w) => { P.push(x * S, y * S, z * S); N.push(...n); C.push(...c); W.push(w); return W.length - 1; };
  // body: rings of four (top, right, bottom, left)
  const ring = (z, rw, rh) => [vert(0, rh, z, [0, 1, 0], sp.top, 0), vert(rw, 0, z, [1, 0, 0], sp.top, 0), vert(0, -rh, z, [0, -1, 0], sp.belly, 0), vert(-rw, 0, z, [-1, 0, 0], sp.top, 0)];
  const rings = sp.body.map(([z, rw, rh]) => ring(z, rw, rh));
  for (let j = 1; j < rings.length; j++) for (let k = 0; k < 4; k++) {
    const a = rings[j - 1][k], b = rings[j - 1][(k + 1) % 4], c = rings[j][k], d = rings[j][(k + 1) % 4];
    I.push(a, c, b, b, c, d);
  }
  // tail and wings, mirrored; wing vertices are marked for the flap
  for (const m of [1, -1]) {
    const root = vert(0, 0, sp.tail[0][1], [0, 1, 0], sp.top, 0);
    const t = sp.tail.map(([x, z]) => vert(x * m, 0, z, [0, 1, 0], sp.top, 0));
    for (let k = 1; k < t.length; k++) I.push(root, t[k - 1], t[k]);
    const w = sp.wing.map(([x, l, tr]) => [vert(x * m, 0, l, [0, 1, 0], sp.top, 1), vert(x * m, 0, tr, [0, 1, 0], sp.top, 1)]);
    for (let k = 1; k < w.length; k++) I.push(w[k - 1][0], w[k][0], w[k - 1][1], w[k - 1][1], w[k][0], w[k][1]);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(W, 1));
  g.setIndex(I);
  return g;
}

// aPose: position, heading; aLook: root and hand angles of the wings, bank, pitch
function birdMaterial(elbow) {
  const pose = attribute('aPose', 'vec4'), look = attribute('aLook', 'vec4'), wing = attribute('aWing', 'float');
  const p = positionGeometry, s = sign(p.x), r = abs(p.x);
  // the wing folds up about the shoulder (angle look.x) and again at the elbow (look.x + look.y)
  const r1 = min(r, elbow), r2 = max(r.sub(elbow), 0.0), a1 = look.x, a2 = look.x.add(look.y);
  const pw = vec3(s.mul(r1.mul(cos(a1)).add(r2.mul(cos(a2)))), p.y.add(r1.mul(sin(a1))).add(r2.mul(sin(a2))), p.z);
  const th = r.greaterThan(elbow).select(a2, a1);
  const nw = vec3(s.negate().mul(sin(th)), cos(th), 0.0);
  const cb = cos(look.z), sb = sin(look.z), cp = cos(look.w), sp = sin(look.w), cy = cos(pose.w), sy = sin(pose.w);
  const orient = (v) => {
    const a = vec3(v.x.mul(cb).add(v.y.mul(sb)), v.y.mul(cb).sub(v.x.mul(sb)), v.z); // bank: +x side down
    const b = vec3(a.x, a.y.mul(cp).add(a.z.mul(sp)), a.z.mul(cp).sub(a.y.mul(sp))); // pitch: nose up
    return vec3(b.x.mul(cy).add(b.z.mul(sy)), b.y, b.z.mul(cy).sub(b.x.mul(sy))); // heading
  };
  const mat = new LitMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  mat.positionNode = orient(mix(p, pw, wing)).add(pose.xyz);
  mat.normalNode = transformNormalToView(orient(mix(normalGeometry, nw, wing))).normalize().mul(faceDirection);
  return mat;
}

// world: height and river; tree: {x, z} of the cherry tree (swallows keep out of its crown)
export function makeBirds(world, tree) {
  const rng = mulberry32(31);
  const rand = (a, b) => a + (b - a) * rng();
  const ground = (x, z) => Math.max(world.heightFast(x, z), 0);
  const group = new THREE.Group();
  group.name = 'birds';
  const kinds = {};
  for (const name in SPECIES) {
    const sp = SPECIES[name], n = COUNT[name];
    const geo = birdGeometry(sp);
    const aPose = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const aLook = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPose', aPose); geo.setAttribute('aLook', aLook);
    geo.instanceCount = n;
    const mesh = new THREE.Mesh(geo, birdMaterial(sp.elbow * sp.span));
    mesh.frustumCulled = false;
    mesh.name = name;
    group.add(mesh);
    const birds = [];
    for (let i = 0; i < n; i++) {
      birds.push({ i, state: 'away', x: 0, y: -1e5, z: 0, yaw: 0, pitch: 0, bank: 0, v: 10, tx: 0, ty: 0, tz: 0, retarget: 0, ph: rng() * TAU, A: 1, beat: true, beatT: rand(...sp.flap.on), a1: 0, a2: 0 });
    }
    kinds[name] = { sp, birds, aPose, aLook };
  }

  // the crows' roosts: woods round the temple's knoll
  const roosts = [];
  for (let k = 0; k < 64 && roosts.length < 8; k++) {
    const a = rng() * TAU, d = rand(35, 110), x = world.temple.x + Math.cos(a) * d, z = world.temple.z + Math.sin(a) * d;
    if (world.grove(x, z) > 0.4) roosts.push([x, z]);
  }
  if (!roosts.length) roosts.push([world.temple.x - 60, world.temple.z]);

  const env = { first: true, scare: 0, lastFlash: 0, crowAcc: 0.7, wind: new THREE.Vector2() };
  const cam = new THREE.Vector3(), fwd = new THREE.Vector3(), view = new THREE.Vector3(), anchor = new THREE.Vector3();

  // ---------- flight ----------
  function wings(b, sp, dt) {
    const f = sp.flap;
    if ((b.beatT -= dt) <= 0) { b.beat = !b.beat; b.beatT = b.beat ? rand(...f.on) : rand(...f.off); }
    b.A += ((b.beat ? 1 : 0) - b.A) * Math.min(1, dt * 6);
    b.ph += dt * TAU * f.hz;
    b.a1 = lerp(f.glide[0], f.o1 + f.a1 * Math.sin(b.ph), b.A);
    b.a2 = lerp(f.glide[1], f.o2 + f.a2 * Math.sin(b.ph - f.lag), b.A);
  }
  // steer towards the target: turn at most `turn` rad/s, climb at most `climb` m/s, banked into the turn, carried by the wind
  function fly(b, dt, turn, climb, drift) {
    let d = Math.atan2(b.tx - b.x, b.tz - b.z) - b.yaw;
    d -= Math.round(d / TAU) * TAU;
    const w = clamp(d * 2, -turn, turn), vy = clamp((b.ty - b.y) * 0.6, -climb, climb), k = 1 - Math.exp(-dt * 4);
    b.yaw += w * dt;
    b.bank += (clamp(Math.atan((b.v * w) / 9.8), -1.1, 1.1) - b.bank) * k;
    b.pitch += (Math.atan2(vy, b.v) - b.pitch) * k;
    b.x += Math.sin(b.yaw) * b.v * dt + env.wind.x * drift * dt;
    b.z += Math.cos(b.yaw) * b.v * dt + env.wind.y * drift * dt;
    b.y += vy * dt;
  }
  const flatDist = (b) => Math.hypot(b.tx - b.x, b.tz - b.z);
  // birds that are no longer wanted fly off away from the camera and are hidden once far out
  function leave(b) {
    const dx = b.x - cam.x, dz = b.z - cam.z, d = Math.hypot(dx, dz) || 1;
    b.state = 'leave'; b.tx = b.x + (dx / d) * 400; b.tz = b.z + (dz / d) * 400; b.ty = b.y + 60;
  }
  function away(b) { b.state = 'away'; b.y = -1e5; }
  // spawn out of sight in the distance, or in place on the first frame
  function arrive(b, x, y, z, far) {
    const a = rng() * TAU;
    b.x = x + (env.first ? 0 : Math.sin(a) * far); b.z = z + (env.first ? 0 : Math.cos(a) * far); b.y = y + (env.first ? 0 : 15);
    b.yaw = Math.atan2(x - b.x, z - b.z) || rng() * TAU;
    b.state = 'in'; b.retarget = 0;
  }

  // ---------- swallows: hawking insects over the river near the view ----------
  function swallows(dt, presence, low) {
    const { birds } = kinds.swallow, n = birds.length;
    const lo = lerp(6, 0.6, low), hi = lerp(18, 2.5, low);
    // ahead of the camera, most of them nearer than what it looks at
    const pick = (b) => {
      const f = rand(-10, 35), sd = rand(-20, 20), z = view.z + fwd.z * f + fwd.x * sd, hw = world.riverHW(z);
      let x = world.riverX(z) + rand(-1, 1) * (low > 0.5 ? hw - 1 : hw + 25);
      const dx = x - tree.x, dz = z - tree.z, d = Math.hypot(dx, dz);
      if (d < 13) x = tree.x + (dx / (d || 1)) * 13; // not through the cherry tree's crown
      b.tx = x; b.tz = z; b.ty = ground(x, z) + rand(lo, hi);
      b.v = rand(9, 13); b.retarget = rand(2, 5);
    };
    for (const b of birds) {
      const want = presence > (b.i + 0.5) / n;
      if (b.state === 'away') { if (want) { pick(b); arrive(b, b.tx, b.ty, b.tz, 120); pick(b); } continue; }
      if (b.state === 'in') {
        if (!want) leave(b);
        else if ((b.retarget -= dt) <= 0 || flatDist(b) < 5) pick(b);
      }
      // swerve round the tree's crown
      const dx = b.x - tree.x, dz = b.z - tree.z, d = Math.hypot(dx, dz);
      if (b.state === 'in' && d < 14 && b.y < 14) { b.tx = tree.x + (dx / d) * 22; b.tz = tree.z + (dz / d) * 22; b.retarget = 0.6; }
      fly(b, dt, 3, 4, 2);
      b.y = Math.max(b.y, ground(b.x, b.z) + 0.3);
      if (b.state === 'leave' && Math.hypot(b.x - cam.x, b.z - cam.z) > 260) away(b);
    }
  }

  // ---------- kites: slow circles high over the valley, the circles drifting downwind ----------
  function kites(dt, presence, t) {
    const { birds } = kinds.kite, n = birds.length;
    const home = (b) => {
      const a = rng() * TAU, d = rand(30, 130);
      b.cx = anchor.x + Math.sin(a) * d; b.cz = anchor.z + Math.cos(a) * d - 40;
      b.cy = ground(b.cx, b.cz) + rand(45, 85); b.R = rand(20, 40); b.dir = rng() < 0.5 ? 1 : -1; b.v = rand(8, 10);
    };
    for (const b of birds) {
      const want = presence > (b.i + 0.5) / n;
      if (b.state === 'away') {
        if (want) { home(b); arrive(b, b.cx + b.R, b.cy, b.cz, 220); }
        continue;
      }
      if (b.state === 'in') {
        if (!want) leave(b);
        else {
          b.cx += env.wind.x * 1.5 * dt; b.cz += env.wind.y * 1.5 * dt;
          if (Math.hypot(b.cx - anchor.x, b.cz - anchor.z) > 200) home(b);
          const ang = Math.atan2(b.x - b.cx, b.z - b.cz) + b.dir * 0.6;
          b.tx = b.cx + Math.sin(ang) * b.R; b.tz = b.cz + Math.cos(ang) * b.R; b.ty = b.cy + 6 * Math.sin(t * 0.05 + b.i * 2);
        }
      }
      fly(b, dt, 0.6, 2, 0.5);
      if (b.state === 'leave' && Math.hypot(b.x - cam.x, b.z - cam.z) > 350) away(b);
    }
  }

  // ---------- crows: loose flocks crossing the view, to the roost at dusk, from it at dawn ----------
  const flocks = [];
  function spawnFlock(mode, size, s0) {
    const free = kinds.crow.birds.filter((b) => b.state === 'away');
    if (free.length < 2) return;
    const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const M = cam.clone().addScaledVector(fwd, rand(80, 200)).addScaledVector(side, rand(-70, 70));
    const R = roosts[Math.floor(rng() * roosts.length)];
    const dir = new THREE.Vector3(R[0] - M.x, 0, R[1] - M.z);
    let dist = dir.length();
    if (mode === 'day' || dist < 120) { dir.copy(side).multiplyScalar(rng() < 0.5 ? 1 : -1).applyAxisAngle(THREE.Object3D.DEFAULT_UP, rand(-0.6, 0.6)); dist = 0; }
    else dir.divideScalar(dist);
    if (mode === 'dawn' && dist) dir.negate();
    // dusk: from far out to the roost; dawn: from the roost out past the view; by day: across the view
    const a = mode === 'dawn' && dist ? new THREE.Vector3(R[0], 0, R[1]) : M.clone().addScaledVector(dir, -260);
    const b = mode === 'dusk' && dist ? new THREE.Vector3(R[0], 0, R[1]) : M.clone().addScaledVector(dir, 260);
    const len = a.distanceTo(b);
    let top = 0;
    for (let k = 0; k <= 8; k++) top = Math.max(top, ground(lerp(a.x, b.x, k / 8), lerp(a.z, b.z, k / 8)));
    const f = { a, b, len, dir: b.clone().sub(a).normalize(), cruise: top + rand(30, 55), s: s0 * len, v: rand(11, 13), mode, members: [] };
    f.side = new THREE.Vector3(-f.dir.z, 0, f.dir.x);
    f.yawDir = Math.atan2(f.dir.x, f.dir.z);
    const spread = 3 + size * 1.5;
    for (const m of free.slice(0, size)) {
      m.state = 'in';
      m.back = rng() * spread * 2.5; m.lat = rand(-1, 1) * spread; m.up = rand(-4, 4); m.wob = rng() * TAU;
      f.members.push(m);
    }
    flocks.push(f);
  }
  // height along a flock's path: roosting crows drop into the trees over the last stretch, dawn ones rise out of them
  function flockY(f, s) {
    const x = lerp(f.a.x, f.b.x, s / f.len), z = lerp(f.a.z, f.b.z, s / f.len), trees = ground(x, z) + 12;
    if (f.mode === 'dusk') return lerp(f.cruise, trees, smoothstep(f.len - 90, f.len, s));
    if (f.mode === 'dawn') return lerp(trees, f.cruise, smoothstep(0, 90, s));
    return f.cruise;
  }
  function crows(dt, rate, mode, t) {
    env.crowAcc += dt * rate;
    if (env.first && rate > 0.03) env.crowAcc = 1;
    if (env.crowAcc >= 1) {
      env.crowAcc = rng() * 0.3;
      spawnFlock(mode, mode === 'day' ? 2 + Math.floor(rng() * 2) : 4 + Math.floor(rng() * 6), env.first ? 0.45 : 0);
    }
    for (let k = flocks.length - 1; k >= 0; k--) {
      const f = flocks[k];
      f.s += f.v * dt;
      f.a.x += env.wind.x * 2 * dt; f.a.z += env.wind.y * 2 * dt; f.b.x += env.wind.x * 2 * dt; f.b.z += env.wind.y * 2 * dt;
      let alive = false;
      for (const m of f.members) {
        const s = f.s - m.back;
        if (s < 0 || s > f.len) { m.y = -1e5; alive ||= s < 0; continue; }
        alive = true;
        const u = s / f.len, wob = Math.sin(t * 0.6 + m.wob);
        const y = flockY(f, s) + m.up + 1.5 * Math.sin(t * 0.9 + m.wob * 2);
        m.pitch = Math.atan2(flockY(f, s + 1) - flockY(f, s), 1);
        m.x = lerp(f.a.x, f.b.x, u) + f.side.x * (m.lat + wob * 2); m.z = lerp(f.a.z, f.b.z, u) + f.side.z * (m.lat + wob * 2); m.y = y;
        m.yaw = f.yawDir + Math.cos(t * 0.6 + m.wob) * 0.12; m.bank = -Math.cos(t * 0.6 + m.wob) * 0.25;
      }
      if (!alive) { for (const m of f.members) away(m); flocks.splice(k, 1); }
    }
  }

  function write(kind, dt) {
    const { sp, birds, aPose, aLook } = kind;
    for (const b of birds) {
      if (b.state !== 'away' && b.y > -1e4) wings(b, sp, dt);
      aPose.array.set([b.x, b.state === 'away' ? -1e5 : b.y, b.z, b.yaw], b.i * 4);
      aLook.array.set([b.a1, b.a2, b.bank, b.pitch], b.i * 4);
    }
    aPose.needsUpdate = true; aLook.needsUpdate = true;
  }

  return {
    group,
    // ctx: { t, hour, rain, clouds, wind (0..1), windDir (Vector2), flash, camera, focus (where the view looks, Vector3) }
    update(dt, ctx) {
      const h = ctx.hour;
      cam.copy(ctx.camera.position);
      ctx.camera.getWorldDirection(fwd).setY(0);
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      view.copy(ctx.focus).lerp(cam, 0.4);
      anchor.copy(ctx.focus).addScaledVector(fwd, 20);
      env.wind.copy(ctx.windDir).multiplyScalar(ctx.wind);
      // a lightning strike scatters them for a while
      if (ctx.flash > 0.5 && env.lastFlash <= 0.5) env.scare = rand(25, 40);
      env.lastFlash = ctx.flash;
      env.scare = Math.max(0, env.scare - dt);
      const calm = env.scare > 0 ? 0 : 1, gale = smoothstep(0.55, 1, ctx.wind);
      const day = smoothstep(5.0, 6.0, h) * (1 - smoothstep(18.5, 19.3, h));
      // swallows: out by day, in the wind too (less so in a gale), not in heavy rain; low under heavy cloud or in drizzle
      const low = Math.max(smoothstep(0.55, 0.8, ctx.clouds), smoothstep(0.05, 0.2, ctx.rain));
      swallows(dt, day * (1 - smoothstep(0.4, 0.75, ctx.rain)) * (1 - 0.4 * gale) * calm, low);
      // kites: on the thermals of clear days, gone under heavy cloud or rain
      const soar = smoothstep(6.8, 8.3, h) * (1 - smoothstep(16.3, 17.6, h));
      kites(dt, soar * (1 - smoothstep(0.55, 0.85, ctx.clouds)) * (1 - smoothstep(0.05, 0.25, ctx.rain)) * calm, ctx.t);
      // crows: flocks home at dusk, out at dawn, a pair now and then by day; not in heavy rain
      const dusk = smoothstep(16.6, 17.3, h) * (1 - smoothstep(18.6, 19.1, h)), dawn = smoothstep(5.0, 5.5, h) * (1 - smoothstep(6.6, 7.3, h));
      const mode = dusk > 0.3 ? 'dusk' : dawn > 0.3 ? 'dawn' : 'day';
      const rate = (1 - smoothstep(0.35, 0.7, ctx.rain)) * calm * (dusk / 14 + dawn / 16 + (day * (1 - dusk) * (1 - dawn)) / 45);
      crows(dt, rate, mode, ctx.t);
      for (const name in kinds) write(kinds[name], dt);
      env.first = false;
    },
    // debug: the birds in the air, per species [x, y, z]
    info() {
      const out = {};
      for (const name in kinds) out[name] = kinds[name].birds.filter((b) => b.state !== 'away' && b.y > -1e4).map((b) => [b.x, b.y, b.z].map((v) => +v.toFixed(1)));
      out.flocks = flocks.length;
      return out;
    },
  };
}
