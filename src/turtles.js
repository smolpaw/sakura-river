// Japanese pond turtles (ishigame) basking on a rock in the river: two or three on the top of the river rock nearest
// the lanes that has room, by day in sunshine, each turned to the sun with its neck out. Wary, as basking turtles are:
// when the walker comes within FLEE m (the camera within CAMERA_FLEE) they slide off into the water one after another, each with a plop
// (a ring on the water, touches.js), and a minute or two after all has been quiet they climb back out, one at a time,
// to their places. Out of the water only from mid-morning to mid-afternoon, not in rain, fewer under cloud.
// The turtle is built here: a domed shell with a keel and scutes painted on, the flat plastron, head, legs and tail,
// coloured per vertex; one instanced draw, its matrices set from the CPU; it casts shadows.
import * as THREE from 'three/webgpu';
import { Fn, vec3, float, abs, fract, mix, min, attribute, positionGeometry } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LitMaterial, U, sstep } from './tsl.js';
import { mulberry32, smoothstep } from './noise.js';

const COUNT = 3;
const SIZE = 1.5; // against life (a 20 cm shell): large, as the scene's flowers and birds are
const FLEE = 15, CAMERA_FLEE = 2.5; // m
const QUIET = [60, 120], CLEAR = 10; // back out this long after (s), once no one is within CLEAR m
const SLIDE = 0.9, CLIMB = 4; // s
const HOURS = [9, 16.5];

// the turtle at life size, nose along +z, the plastron on y = 0; part per vertex: 0 shell, 1 skin, 2 plastron
function turtleGeometry() {
  const part = (g, k, col) => {
    g = g.index ? g.toNonIndexed() : g;
    const n = g.attributes.position.count;
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(k), 1));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).map((_, i) => col[i % 3]), 3));
    delete g.attributes.uv;
    return g;
  };
  const ell = (rx, ry, rz, x, y, z, seg = 12, half = false) => {
    const g = new THREE.SphereGeometry(1, seg, half ? seg / 2 : seg, 0, Math.PI * 2, 0, half ? Math.PI / 2 : Math.PI);
    g.scale(rx, ry, rz).translate(x, y, z);
    return g;
  };
  const skin = [0.16, 0.14, 0.08], shell = [0.14, 0.11, 0.06], belly = [0.32, 0.26, 0.12];
  const parts = [
    part(ell(0.1, 0.055, 0.12, 0, 0.012, 0, 20, true), 0, shell), // the shell's dome
    part(ell(0.095, 0.012, 0.115, 0, 0.012, 0, 16), 2, belly), // the plastron
    part(ell(0.022, 0.02, 0.032, 0, 0.03, 0.15, 10), 1, skin), // the head
    part(ell(0.018, 0.017, 0.04, 0, 0.022, 0.11, 8), 1, skin), // the neck
    part(ell(0.008, 0.008, 0.03, 0, 0.012, -0.13, 6), 1, skin), // the tail
  ];
  // legs splayed out on the rock, the front pair forward
  for (const [sx, z, ang] of [[1, 0.07, 0.9], [-1, 0.07, -0.9], [1, -0.07, 2.4], [-1, -0.07, -2.4]]) {
    const g = ell(0.016, 0.01, 0.04, 0, 0, 0.03, 8);
    g.rotateY(ang).translate(sx * 0.075, 0.008, z);
    parts.push(part(g, 1, skin));
  }
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return g;
}

// rocks: perched.js rockTops ({ x, y, z, surface }); turtles keep to one's upper surface
export function makeTurtles(world, rocks) {
  const rng = mulberry32(61);
  const geo = turtleGeometry();
  // the shell's scutes: seams on the dome and the keel along it; the skin's yellow streaks on the head and neck
  const color = Fn(() => {
    const c = attribute('color', 'vec3').toVar(), p = positionGeometry, k = attribute('aPart', 'float');
    const isShell = sstep(0.5, 0.0, abs(k));
    const seam = min(sstep(0.004, 0.0015, abs(fract(p.z.mul(12.0).add(0.5)).sub(0.5).div(12.0))), float(1.0))
      .max(sstep(0.004, 0.0015, abs(abs(p.x).sub(0.035)))).mul(sstep(0.03, 0.045, p.y));
    const keel = sstep(0.01, 0.003, abs(p.x)).mul(sstep(0.05, 0.065, p.y));
    c.assign(mix(c, vec3(0.05, 0.04, 0.025), seam.mul(isShell).mul(0.8)));
    c.assign(mix(c, vec3(0.24, 0.19, 0.1), keel.mul(isShell).mul(0.6)));
    const isSkin = sstep(0.5, 0.0, abs(k.sub(1.0)));
    const streak = sstep(0.003, 0.0012, abs(abs(p.x).sub(0.012))).mul(sstep(0.09, 0.11, p.z));
    c.assign(mix(c, vec3(0.42, 0.36, 0.1), streak.mul(isSkin)));
    return c;
  })();
  const mat = new LitMaterial({ roughness: 0.55, metalness: 0, colorNode: color });
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.name = 'turtles';
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.count = 0;

  // the rock: of those with room on top, the nearest a lane (world.js LANES), where the walker can come upon them
  const lanePts = world.LANES.flatMap((L) => L.flatMap(([x0, z0], i) => (i ? [...Array(10)].map((_, k) => [L[i - 1][0] + (x0 - L[i - 1][0]) * k / 10, L[i - 1][1] + (z0 - L[i - 1][1]) * k / 10]) : [])));
  const toLane = (r) => Math.min(...lanePts.map(([x, z]) => Math.hypot(x - r.x, z - r.z)));
  const dry = (r) => (r.surface || []).filter((p) => p.y > 0.1);
  const roomy = rocks.filter((r) => dry(r).length > 20).sort((a, b) => toLane(a) - toLane(b));
  // places on a rock's top: level enough (its neighbours within 12 cm at about its height), apart from each other
  const places = (rock) => {
    const level = (p) => rock.surface.every((q) => Math.hypot(q.x - p.x, q.z - p.z) > 0.12 || Math.abs(q.y - p.y) < 0.06);
    const out = [];
    for (const p of dry(rock).filter((q) => q.y > rock.y - 0.18 && level(q)).sort(() => rng() - 0.5)) {
      if (out.length < COUNT && out.every((o) => Math.hypot(o.x - p.x, o.z - p.z) >= 0.3 * SIZE)) out.push(p);
    }
    return out;
  };
  // the first rock with room for two at least
  let rock = null, spots = [];
  for (const r of roomy) { spots = places(r); if (spots.length >= 2) { rock = r; break; } }
  const turtles = [];
  for (const p of rock ? spots : []) {
    // where it goes in: straight out from the rock's middle to water a little deep
    const out = new THREE.Vector3(p.x - rock.x, 0, p.z - rock.z);
    if (out.lengthSq() < 1e-4) out.set(1, 0, 0);
    out.normalize();
    const e = p.clone();
    for (let k = 0; k < 40 && world.height(e.x, e.z) > -0.15; k++) e.addScaledVector(out, 0.05);
    e.y = -0.12;
    turtles.push({ at: p.clone(), in: e, yaw: 0, state: 'new', t: 0, back: 0, skew: (rng() - 0.5) * 0.8, s: SIZE * (0.85 + rng() * 0.25) });
  }
  const splashes = [], events = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(0, 0, 0, 'YXZ'), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  const walkerAt = new THREE.Vector3();
  let now = 0, calm = false;

  return {
    mesh, splashes, events, // events: calls for the sound (audio.js call), taken each frame
    // ctx: { hour, rain, clouds, camera, walker ({x, y, z} or null), warming }
    update(dt, ctx) {
      now += dt;
      const sun = smoothstep(HOURS[0], HOURS[0] + 0.5, ctx.hour) * (1 - smoothstep(HOURS[1] - 0.5, HOURS[1], ctx.hour)) * (1 - smoothstep(0.1, 0.3, ctx.rain));
      const wanted = Math.round(COUNT * sun * (1 - 0.7 * smoothstep(0.6, 0.95, ctx.clouds)));
      if (ctx.walker) walkerAt.set(ctx.walker.x, ctx.walker.y + 1, ctx.walker.z);
      const near = (P, r, k) => Math.min(ctx.walker ? walkerAt.distanceTo(P) / r : Infinity, ctx.camera.position.distanceTo(P) / (r * k));
      // facing the sun to bask, each a little off it
      const sunYaw = Math.atan2(U.uSunDir.value.x, U.uSunDir.value.z);
      let n = 0;
      turtles.forEach((t, k) => {
        if (t.state === 'new') { t.state = k < wanted ? 'bask' : 'gone'; t.yaw = sunYaw + t.skew; } // (at start: simply there)
        const scared = !calm && near(t.at, FLEE, CAMERA_FLEE / FLEE) < 1;
        if (t.state === 'bask' && (scared || k >= wanted)) { t.state = 'slide'; t.t = now + rng() * 0.8; }
        else if (t.state === 'gone' && k < wanted && now > t.back && near(t.at, CLEAR, 0.5) > 1) { t.state = 'climb'; t.t = now + k * 3 * rng(); }
        if (t.state === 'slide' && now > t.t + SLIDE) { t.state = 'gone'; t.back = now + QUIET[0] + rng() * (QUIET[1] - QUIET[0]); splashes.push({ x: t.in.x, z: t.in.z, amp: 0.7, r: 0.04 }); events.push({ kind: 'plop', x: t.in.x, y: 0, z: t.in.z }); }
        if (t.state === 'climb' && now > t.t + CLIMB) t.state = 'bask';
        // where it is: on its place, or between it and the water
        let u = 0;
        if (t.state === 'slide') u = Math.max(0, now - t.t) / SLIDE;
        else if (t.state === 'climb') u = 1 - Math.max(0, now - t.t) / CLIMB;
        else if (t.state === 'gone') u = 1;
        if (u >= 1 && !ctx.warming) return;
        const e = u * u * (3 - 2 * u);
        pv.lerpVectors(t.at, t.in, e);
        const toWater = Math.atan2(t.in.x - t.at.x, t.in.z - t.at.z);
        // basking: to the sun; going in or coming out: along the way (nose first going in, coming out too)
        const yaw = t.state === 'bask' ? sunYaw + t.skew : t.state === 'slide' ? toWater : toWater + Math.PI;
        t.yaw += Math.atan2(Math.sin(yaw - t.yaw), Math.cos(yaw - t.yaw)) * Math.min(1, dt * (t.state === 'bask' ? 0.5 : 6));
        const pitch = (t.state === 'slide' ? 0.5 : t.state === 'climb' ? -0.3 : 0) * Math.sin(Math.PI * Math.min(1, e * 1.2));
        e3.set(pitch, t.yaw, 0);
        m4.compose(pv, q.setFromEuler(e3), sv.setScalar(t.s));
        mesh.setMatrixAt(n++, m4);
      });
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.visible = n > 0;
    },
    // debug: each turtle's state and place; calm: they mind no one; out: all out of the water now
    info(o = {}) {
      if (o.calm !== undefined) calm = !!o.calm;
      if (o.out) for (const t of turtles) { t.state = 'bask'; }
      return { rock: rock ? rock.toArray().map((v) => +v.toFixed(2)) : null, turtles: turtles.map((t) => ({ state: t.state, at: t.at.toArray().map((v) => +v.toFixed(2)) })) };
    },
  };
}
