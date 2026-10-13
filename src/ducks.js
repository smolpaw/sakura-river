// A pair of spot-billed ducks (karugamo) on the river: paddling the slack water along the banks of their stretch
// (HOME), the drake keeping a little behind the duck, now and then stopping to up-end and feed (head under, tail and
// orange feet up), each paddle and each up-ending leaving rings on the water (touches.js). When the walker comes
// within FLUSH m (the camera within CAMERA_FLUSH) they spring off the water with a splash, fly off low along the river
// away from them, land 40-60 m on and, once all is quiet, paddle slowly home. After dark they doze by the bank, heads
// turned back on their shoulders. The duck is built here (body, tail, neck, head, bill, feet, and wings that lie folded
// on its back and open to beat in flight); its plumage is painted from its own frame: the brown body scaled with pale
// feather edges, the buff face with its dark crown and two dark stripes, the white tertials, the blue speculum, the
// black bill's yellow tip. Two meshes on one geometry and material (per-object uniforms: flight, wing phase, the
// head's dip); in the river's reflection; no shadows.
import * as THREE from 'three/webgpu';
import { Fn, vec3, float, sin, cos, abs, atan, floor, fract, mix, attribute, uniform, positionGeometry, normalGeometry, transformNormalToView, faceDirection } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LitMaterial, U, sstep, SHADOW_NORMAL_BIAS } from './tsl.js';
import { groundBounce } from './materials.js';
import { mulberry32, smoothstep } from './noise.js';

const SIZE = 1.3; // against life (58 cm nose to tail): large, as the scene's birds are
const HOME = [-46, 24]; // the stretch they keep to (z)
const FLUSH = 10, CAMERA_FLUSH = 2.5; // m
const QUIET = 40; // s before they head home after a flight
const SWIM = 0.32, FLY = 9; // m/s
const NIGHT = [19.3, 5.0]; // dozing from, until (clock hours)
const SHOULDER = [0.06, 0.125, 0.04]; // the left wing's root (m, life size)

// parts (aPart): 0 body, 1 head and neck, 2 bill, 3 feet, 4 wing (aWing: its side), 5 tail
function duckGeometry() {
  const parts = [];
  const add = (g, part, side = 0, spread = null) => {
    g = g.index ? g.toNonIndexed() : g;
    const n = g.attributes.position.count;
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
    g.setAttribute('aWing', new THREE.Float32BufferAttribute(new Float32Array(n).fill(side), 1));
    g.setAttribute('aSpread', new THREE.Float32BufferAttribute(spread || g.attributes.position.array.slice(), 3));
    delete g.attributes.uv;
    parts.push(g);
  };
  const ell = (rx, ry, rz, x, y, z, seg = 14) => new THREE.SphereGeometry(1, seg, Math.max(6, seg >> 1)).scale(rx, ry, rz).translate(x, y, z);
  add(ell(0.11, 0.085, 0.22, 0, 0.05, -0.01, 20), 0);
  const tail = ell(0.055, 0.025, 0.08, 0, 0.0, 0, 10);
  tail.rotateX(-0.35).translate(0, 0.085, -0.22);
  add(tail, 5);
  const neck = ell(0.04, 0.07, 0.045, 0, 0, 0, 10);
  neck.rotateX(0.35).translate(0, 0.15, 0.15);
  add(neck, 1);
  add(ell(0.042, 0.043, 0.06, 0, 0.215, 0.19, 12), 1);
  add(ell(0.022, 0.01, 0.042, 0, 0.205, 0.265, 8), 2);
  for (const s of [1, -1]) {
    const foot = ell(0.03, 0.006, 0.04, 0, 0, 0, 8);
    foot.translate(s * 0.05, -0.04, -0.12);
    add(foot, 3);
  }
  // wings: a strip along the span (u) by the chord (v); folded along the back, spread out level
  for (const s of [1, -1]) {
    const U_ = 7, V_ = 3, pos = [], spr = [], idx = [];
    for (let i = 0; i < U_; i++) for (let j = 0; j < V_; j++) {
      const u = i / (U_ - 1), v = j / (V_ - 1);
      pos.push(s * (0.102 - 0.04 * u - 0.006 * v), 0.105 - 0.032 * v + 0.012 * u, 0.06 - 0.24 * u - 0.05 * v); // on the flank, inside the body's outline
      spr.push(s * (SHOULDER[0] + 0.36 * u), SHOULDER[1], SHOULDER[2] - 0.17 * v * (1 - 0.45 * u) - 0.06 * u * u);
    }
    for (let i = 0; i + 1 < U_; i++) for (let j = 0; j + 1 < V_; j++) {
      const a = i * V_ + j, b = a + V_, c = a + 1, d = b + 1;
      if (s > 0) idx.push(a, b, c, c, b, d); else idx.push(a, c, b, c, d, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const ng = g.toNonIndexed();
    const sp = new Float32Array(idx.length * 3);
    idx.forEach((k, n) => sp.set(spr.slice(k * 3, k * 3 + 3), n * 3));
    add(ng, 4, s, sp);
  }
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return g;
}

export function makeDucks(world, rocksInWater) {
  const rng = mulberry32(73);
  const rand = (a, b) => a + (b - a) * rng();
  const geo = duckGeometry();

  // per duck (each mesh's userData): how far in flight (0..1), its wing beat's phase offset, its head's dip (0 up ..
  // 1 under: up-ending), dozing (head back)
  const uFly = uniform(0).onObjectUpdate(({ object }) => object.userData.fly);
  const uBeat = uniform(0).onObjectUpdate(({ object }) => object.userData.beat);
  const uDoze = uniform(0).onObjectUpdate(({ object }) => object.userData.doze);
  const part = attribute('aPart', 'float'), side = attribute('aWing', 'float');
  const is = (k) => sstep(0.5, 0.0, abs(part.sub(k)));
  const isWing = is(4.0), isHead = is(1.0).add(is(2.0));
  // the wing: folded, or spread and beating about its root (a downstroke quicker than the up)
  const beat = U.uTime.mul(5.5 * Math.PI * 2).add(uBeat);
  const ang = sin(beat).mul(0.75).add(sin(beat.mul(2.0)).mul(0.12)).add(0.15).mul(uFly);
  const sp = attribute('aSpread', 'vec3');
  const r = abs(sp.x).sub(SHOULDER[0]);
  const flap = vec3(side.mul(r.mul(cos(ang)).add(SHOULDER[0])), sp.y.add(r.mul(sin(ang))), sp.z);
  let p = mix(positionGeometry, flap, isWing.mul(sstep(0.0, 0.15, uFly)));
  // dozing: the head laid back on the shoulders, the bill tucked
  const headBack = vec3(positionGeometry.x.mul(0.9).add(0.03), positionGeometry.y.sub(0.07), positionGeometry.z.negate().add(0.2).mul(0.6).sub(0.02));
  p = mix(p, headBack, isHead.mul(uDoze));
  const n = mix(normalGeometry, vec3(side.negate().mul(sin(ang)), cos(ang), 0.0), isWing.mul(sstep(0.0, 0.15, uFly))).normalize();

  // plumage, from the duck's own frame (life size, metres)
  const q = positionGeometry, ax = abs(q.x);
  const color = Fn(() => {
    const brown = vec3(0.17, 0.11, 0.06), edge = vec3(0.42, 0.34, 0.22), buff = vec3(0.6, 0.52, 0.38), dark = vec3(0.06, 0.045, 0.035);
    // the body: dark brown feathers each with a pale crescent at its end, in rows offset round the body; the tail darker
    const a = atan(q.y.sub(0.05), q.x).mul(7.0), row = floor(a), fa = fract(a).sub(0.5);
    const sc = sstep(0.78, 0.97, fract(q.z.mul(26.0).add(row.mul(0.5))).add(fa.mul(fa).mul(1.2)));
    const body = mix(brown, edge, sc.mul(0.28)).mul(mix(float(1.0), float(0.75), sstep(-0.16, -0.24, q.z)));
    // the white tertials at the back of the folded wing; folded wing brown
    const tert = sstep(-0.11, -0.14, q.z).mul(sstep(-0.2, -0.17, q.z)).mul(sstep(0.09, 0.1, q.y)).mul(sstep(0.06, 0.08, ax));
    // head and neck: buff, the dark crown and nape, a dark stripe through the eye and another below it on the cheek
    const hy = q.y.sub(0.215), hz = q.z.sub(0.19);
    let head = mix(buff, vec3(0.3, 0.22, 0.14), sstep(0.18, 0.12, q.y)); // the neck browner towards the body
    head = mix(head, dark, sstep(0.026, 0.034, hy).add(sstep(-0.01, -0.035, hz).mul(sstep(0.012, 0.03, hy))).min(1.0));
    head = mix(head, dark, sstep(0.006, 0.002, abs(hy.sub(0.004).add(hz.mul(0.12)))).mul(sstep(-0.04, -0.02, hz)));
    head = mix(head, dark, sstep(0.005, 0.0015, abs(hy.add(0.014).add(hz.mul(0.1)))).mul(sstep(-0.035, -0.015, hz)).mul(sstep(0.04, 0.025, hz)));
    head = mix(head, vec3(0.01), sstep(0.008, 0.005, abs(hy.sub(0.006))).mul(sstep(0.006, 0.003, abs(hz.sub(0.02)))).mul(sstep(0.03, 0.038, ax)));
    // the bill: black, its tip yellow; the feet orange
    const bill = mix(vec3(0.03, 0.03, 0.03), vec3(0.7, 0.52, 0.04), sstep(0.285, 0.295, q.z));
    const feet = vec3(0.75, 0.32, 0.05);
    // the open wing: brown above, the blue speculum edged in white, pale below
    const wv = q.z.negate().add(0.04).div(0.07); // across the folded chord: 0 front .. 1 back
    const spec = sstep(0.55, 0.65, wv).mul(sstep(0.35, 0.2, abs(q.z.add(0.1))));
    let wing = mix(mix(brown, edge, sc.mul(0.3)), vec3(0.04, 0.12, 0.42), spec.mul(uFly));
    wing = mix(wing, vec3(0.85, 0.84, 0.8), tert);
    let c = mix(body, vec3(0.85, 0.84, 0.8), tert);
    c = mix(c, head, is(1.0));
    c = mix(c, bill, is(2.0));
    c = mix(c, feet, is(3.0));
    c = mix(c, wing, isWing);
    c = mix(c, body.mul(0.7), is(5.0));
    return c;
  })();
  const mat = new LitMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide, colorNode: color }, (o) => o.add(color.mul(groundBounce().mul(0.4))));
  mat.positionNode = p;
  mat.normalNode = transformNormalToView(n).normalize().mul(faceDirection);
  mat.receivedShadowPositionNode = p.add(n.mul(SHADOW_NORMAL_BIAS));

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
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'ducks';
    mesh.userData = { fly: 0, beat: rng() * 6, doze: 0 };
    mesh.scale.setScalar(SIZE * (k ? 1.04 : 0.97));
    group.add(mesh);
    return { k, mesh, x: 0, z: 0, y: 0, yaw: rng() * Math.PI * 2, v: 0, goal: null, state: 'swim', t: 0, dip: 0, next: rand(10, 40), paddle: 0, flight: null };
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

  // a flight: up off the water, low along the river away from `from`, down 40-60 m on
  const takeOff = (from) => {
    const down = Math.sign(hen.z - from.z) || 1, dist = rand(40, 60);
    let z1 = THREE.MathUtils.clamp(hen.z + down * dist, -90, 60);
    if (Math.abs(z1 - hen.z) < 20) z1 = THREE.MathUtils.clamp(hen.z - down * dist, -90, 60);
    const [lx, lz] = near(z1 - 4, z1 + 4);
    for (const d of ducks) {
      const off = d === hen ? 0 : 1;
      d.flight = { t0: now + off * 0.25, from: new THREE.Vector3(d.x, 0, d.z), to: new THREE.Vector3(lx + off * 0.9, 0, lz - off * 1.4), up: rand(2.5, 4) };
      d.flight.len = d.flight.from.distanceTo(d.flight.to);
      d.state = 'fly'; d.goal = null; d.dip = 0;
      splashes.push({ x: d.x, z: d.z, amp: 1, r: 0.1 });
    }
    events.push({ kind: 'karugamo', x: hen.x, y: 0.3, z: hen.z }); // quacking as they go
    away = now + QUIET;
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
      if (!calm && hen.state !== 'fly' && drake.state !== 'fly' && Math.min(dist(hen.x, hen.z), dist(drake.x, drake.z)) < 1) takeOff(from);
      // the duck quacks now and then by day
      if (!night && hen.state !== 'fly' && (quack -= dt) <= 0) { quack = rand(25, 70); events.push({ kind: 'karugamo', x: hen.x, y: 0.3, z: hen.z }); }
      for (const d of ducks) {
        if (d.state === 'fly') {
          const f = d.flight, u = Math.max(0, (now - f.t0) * FLY / f.len);
          if (u >= 1) { d.state = 'swim'; d.x = f.to.x; d.z = f.to.z; splashes.push({ x: d.x, z: d.z, amp: 0.8, r: 0.08 }); d.v = 1; continue; }
          // up quickly, along low, down gliding
          const e = u * u * (3 - 2 * u);
          tmp.lerpVectors(f.from, f.to, e);
          d.x = tmp.x; d.z = tmp.z;
          d.y = f.up * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.6;
          d.yaw = Math.atan2(f.to.x - f.from.x, f.to.z - f.from.z);
          d.mesh.userData.fly = Math.min(1, (now - f.t0) * 4) * (u < 0.85 ? 1 : 0.6);
          continue;
        }
        d.mesh.userData.fly = Math.max(0, d.mesh.userData.fly - dt * 3);
        d.y = Math.max(0, d.y - dt * 2);
        // where to: the duck wanders its stretch (home after a flight); the drake keeps behind her
        if (d === hen) {
          if (!d.goal || Math.hypot(d.goal[0] - d.x, d.goal[1] - d.z) < 0.6) {
            const home = now > away && (d.z < HOME[0] || d.z > HOME[1]);
            d.goal = home ? near(Math.max(HOME[0], Math.min(HOME[1], d.z)) - 6, Math.max(HOME[0], Math.min(HOME[1], d.z)) + 6) : near(Math.max(HOME[0], d.z - 12), Math.min(HOME[1], d.z + 12));
            if (now < away) d.goal = [d.x + Math.sin(d.yaw) * 2, d.z + Math.cos(d.yaw) * 2];
          }
        } else d.goal = [hen.x - Math.sin(hen.yaw) * 1.3 + Math.cos(hen.yaw) * 0.5, hen.z - Math.cos(hen.yaw) * 1.3 - Math.sin(hen.yaw) * 0.5];
        // up-ending now and then (not after dark)
        d.next -= dt;
        if (d.state === 'swim' && d.next <= 0 && !night) { d.state = 'dabble'; d.t = rand(3, 6); d.next = rand(20, 60); splashes.push({ x: d.x, z: d.z, amp: 0.4, r: 0.06 }); }
        if (d.state === 'dabble' && (d.t -= dt) <= 0) d.state = 'swim';
        const still = d.state === 'dabble' || night;
        // paddling: towards the goal, turning gently, round the rocks
        const gx = d.goal[0] - d.x, gz = d.goal[1] - d.z, gd = Math.hypot(gx, gz);
        let head = Math.atan2(gx, gz);
        for (let i = 0; i < 9; i++) {
          const h = head + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.35;
          if (water(d.x + Math.sin(h) * 1.2, d.z + Math.cos(h) * 1.2)) { head = h; break; }
        }
        const turn = Math.atan2(Math.sin(head - d.yaw), Math.cos(head - d.yaw));
        d.yaw += THREE.MathUtils.clamp(turn, -0.8 * dt, 0.8 * dt);
        const want = still ? 0 : Math.min(SWIM * (d === drake && gd > 2 ? 1.5 : 1), gd * 0.5) * Math.max(0.2, Math.cos(turn));
        d.v += (want - d.v) * Math.min(1, dt * 1.5);
        const nx = d.x + Math.sin(d.yaw) * d.v * dt, nz = d.z + Math.cos(d.yaw) * d.v * dt;
        if (water(nx, nz)) { d.x = nx; d.z = nz; } else d.v *= 0.5;
        d.dip += ((d.state === 'dabble' ? 1 : 0) - d.dip) * Math.min(1, dt * 4);
        d.mesh.userData.doze += ((night ? 1 : 0) - d.mesh.userData.doze) * Math.min(1, dt);
        if (d.v > 0.08 && (d.paddle -= dt) <= 0) { d.paddle = rand(1.2, 2); splashes.push({ x: d.x - Math.sin(d.yaw) * 0.25, z: d.z - Math.cos(d.yaw) * 0.25, amp: 0.25, r: 0.05 }); }
      }
      for (const d of ducks) {
        // afloat, a third under; up-ending: pitched nose down about the waterline
        const bob = d.state === 'fly' ? 0 : Math.sin(now * 1.7 + d.k * 2) * 0.006;
        d.mesh.position.set(d.x, d.y - 0.02 * SIZE + bob, d.z);
        d.mesh.rotation.set(1.6 * d.dip * d.dip * (3 - 2 * d.dip), d.yaw, 0, 'YXZ');
        d.mesh.visible = true;
      }
    },
    // debug: each duck's state and place; calm: they mind no one; fly: take off now as if startled
    info(o = {}) {
      if (o.calm !== undefined) calm = !!o.calm;
      if (o.fly) takeOff(new THREE.Vector3(hen.x, 0, hen.z + 5));
      return ducks.map((d) => ({ state: d.state, x: +d.x.toFixed(2), y: +d.y.toFixed(2), z: +d.z.toFixed(2), yaw: +d.yaw.toFixed(2), v: +d.v.toFixed(2) }));
    },
  };
}
