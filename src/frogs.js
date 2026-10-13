// Frogs on the paddies' edges beside the lanes: Japanese tree frogs (nihon-amagaeru), bright green, and Daruma pond
// frogs, brown with dark spots, each sitting at the water's edge facing the lane. When the walker comes within JUMP m
// one leaps out into its paddy and is gone (with the frogs' chorus in audio.js after dark, these are what is heard
// plopping in); it is back on its edge a while later, once no one is near. The frog is built here, sitting: body,
// head with its eye bumps, the folded hind legs and the front legs; one instanced draw, its matrices set from the CPU,
// for the frogs near the camera only.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LitMaterial } from './tsl.js';
import { mulberry32 } from './noise.js';

const MAX = 28, APART = 3; // frogs, and how far apart (m)
const SIZE = 2.6; // against life (a 5 cm frog): as large as the scene's other small animals are
const JUMP = 4, BACK = [25, 60], CLEAR = 9; // m; s before it is back, once no one is within CLEAR m
const LEAP = 0.45; // s
const SHOW = 35; // m: drawn within this of the camera

// the frog sitting, nose along +z, on y = 0, life size (m); colours per vertex: 0 the skin, 1 the eyes
function frogGeometry() {
  const parts = [];
  const add = (g, k) => {
    g = g.index ? g.toNonIndexed() : g;
    g.setAttribute('aEye', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(k), 1));
    delete g.attributes.uv;
    parts.push(g);
  };
  const ell = (rx, ry, rz, x, y, z, rot = 0) => new THREE.SphereGeometry(1, 10, 6).scale(rx, ry, rz).rotateX(rot).translate(x, y, z);
  add(ell(0.016, 0.012, 0.022, 0, 0.013, -0.004, -0.35), 0); // the body, sitting up at the front
  add(ell(0.014, 0.009, 0.013, 0, 0.02, 0.016), 0); // the head
  for (const s of [1, -1]) {
    add(ell(0.004, 0.004, 0.004, s * 0.008, 0.027, 0.018), 1); // the eye
    add(ell(0.006, 0.006, 0.018, s * 0.015, 0.006, -0.012, 0.2), 0); // the folded hind leg
    add(ell(0.003, 0.009, 0.003, s * 0.011, 0.007, 0.016, 0.3), 0); // the front leg
  }
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return g;
}

export function makeFrogs(world) {
  const rng = mulberry32(19);
  // where they sit: along each lane, out to the first paddy water either side, a little back from it
  const spots = [];
  for (const L of world.LANES) for (let i = 1; i < L.length; i++) {
    const [ax, az] = L[i - 1], [bx, bz] = L[i], len = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / len, nz = (bx - ax) / len;
    for (let s = 0; s < len; s += 1.5) for (const side of [1, -1]) {
      const x0 = ax + ((bx - ax) * s) / len, z0 = az + ((bz - az) * s) / len;
      for (let o = 0.8; o < 6; o += 0.1) {
        const x = x0 + nx * side * o, z = z0 + nz * side * o, F = world.heightField(x, z).F;
        if (!F || !F.wet || !F.inside) continue;
        const ex = x - nx * side * 0.12, ez = z - nz * side * 0.12; // just on the edge, out of the water
        if (spots.every((p) => Math.hypot(p.x - ex, p.z - ez) > APART)) {
          spots.push({ x: ex, z: ez, y: world.height(ex, ez), water: F.y, ix: x + nx * side * 0.7, iz: z + nz * side * 0.7, yaw: Math.atan2(-nx * side, -nz * side) });
        }
        break;
      }
    }
  }
  const frogs = spots.sort(() => rng() - 0.5).slice(0, MAX).map((p) => ({ ...p, state: 'sit', t: 0, s: SIZE * (0.85 + rng() * 0.3), tree: rng() < 0.55, yaw: p.yaw + (rng() - 0.5) * 0.8 }));
  // two coats: the tree frog's green, the pond frog's brown
  const geo = frogGeometry();
  const mat = new LitMaterial({ vertexColors: true, roughness: 0.35, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.name = 'frogs';
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  const eye = geo.attributes.aEye.array;
  const col = new Float32Array(eye.length * 3);
  for (let i = 0; i < eye.length; i++) col.set(eye[i] ? [0.05, 0.04, 0.02] : [1, 1, 1], i * 3);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const tint = new THREE.Color();
  frogs.forEach((f, i) => mesh.setColorAt(i, f.tree ? tint.setRGB(0.16, 0.42, 0.05) : tint.setRGB(0.24, 0.17, 0.08)));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  const walkerAt = new THREE.Vector3(), events = [];
  let now = 0;

  return {
    mesh, events, // events: calls for the sound (audio.js call), taken each frame
    // ctx: { camera, walker ({x, y, z} or null) }
    update(dt, ctx) {
      now += dt;
      if (ctx.walker) walkerAt.set(ctx.walker.x, ctx.walker.y, ctx.walker.z);
      const cam = ctx.camera.position;
      let n = 0;
      for (const f of frogs) {
        const dw = ctx.walker ? Math.hypot(walkerAt.x - f.x, walkerAt.z - f.z) : Infinity;
        if (f.state === 'sit' && dw < JUMP) { f.state = 'leap'; f.t = now + rng() * 0.3; }
        if (f.state === 'leap' && now > f.t + LEAP) { f.state = 'gone'; f.t = now + BACK[0] + rng() * (BACK[1] - BACK[0]); events.push({ kind: 'plop', x: f.ix, y: f.water, z: f.iz }); }
        if (f.state === 'gone' && now > f.t && dw > CLEAR) f.state = 'sit';
        if (f.state === 'gone' || Math.hypot(cam.x - f.x, cam.z - f.z) > SHOW) continue;
        // the leap: out over the water in an arc, into it
        const u = f.state === 'leap' ? Math.max(0, Math.min(1, (now - f.t) / LEAP)) : 0;
        pv.set(f.x + (f.ix - f.x) * u, f.y + (f.water - 0.04 - f.y) * u + 0.25 * Math.sin(Math.PI * u), f.z + (f.iz - f.z) * u);
        e3.set(-0.6 * Math.sin(Math.PI * u), f.yaw, 0, 'YXZ');
        m4.compose(pv, q.setFromEuler(e3), sv.set(f.s, f.s * (1 - 0.3 * Math.sin(Math.PI * u)), f.s * (1 + 0.6 * Math.sin(Math.PI * u))));
        mesh.setMatrixAt(n, m4);
        mesh.setColorAt(n, f.tree ? tint.setRGB(0.16, 0.42, 0.05) : tint.setRGB(0.24, 0.17, 0.08));
        n++;
      }
      mesh.count = n;
      mesh.visible = n > 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    // debug: each frog's place and state
    info: () => frogs.map((f) => ({ state: f.state, x: +f.x.toFixed(2), z: +f.z.toFixed(2), tree: f.tree })),
  };
}
