// Whole cherry flowers on the grass under the tree, and falling to it: the tree sparrows in its blossom (perched.js)
// bite flowers off at the base for their nectar and let them drop, as they do in Japan each spring, so whole flowers
// lie among the loose petals under a cherry. Each one tumbles down from where it was bitten, drifting with the wind,
// and lies where it lands, face up or face down; some are lying there from the start. One instanced draw of a
// five-petalled flower built here (the petals notched at the tip, cupped a little, pink at the base fading to white),
// at the scene's flower size; the oldest give way to new ones.
import * as THREE from 'three/webgpu';
import { LitMaterial } from './tsl.js';
import { mulberry32 } from './noise.js';

const MAX = 80, SEED = 45; // flowers in all, lying there from the start
const SIZE = 0.17; // across, as the tree's own flowers are drawn (tree.js)
const FALL = 1.4, SPIN = 5; // m/s at most, rad/s

function flowerGeometry() {
  const P = [], C = [], I = [];
  const base = [0.86, 0.45, 0.55], tip = [0.99, 0.9, 0.93];
  const v = (x, y, z, c) => { P.push(x, y, z); C.push(...c); return P.length / 3 - 1; };
  const centre = v(0, 0.02, 0, [0.8, 0.35, 0.45]);
  for (let k = 0; k < 5; k++) {
    const a0 = (k / 5) * Math.PI * 2, N = 6, ring = [];
    // the petal's outline from one side of its base round its notched tip to the other, cupped up towards the edge
    for (let i = 0; i <= N; i++) {
      const s = i / N, a = a0 + (s - 0.5) * 1.1, r = 0.5 * (0.35 + 0.65 * Math.sin(Math.PI * s) ** 0.5) * (1 - 0.12 * Math.exp(-((s - 0.5) ** 2) / 0.004));
      const c = base.map((b, j) => b + (tip[j] - b) * (r / 0.5));
      ring.push(v(Math.cos(a) * r, 0.02 + 0.06 * r, Math.sin(a) * r, c));
    }
    for (let i = 0; i < N; i++) I.push(centre, ring[i + 1], ring[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}

// tree: [x, z] of the cherry tree
export function makeDropped(world, tree) {
  const rng = mulberry32(47);
  const mesh = new THREE.InstancedMesh(flowerGeometry(), new LitMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, side: THREE.DoubleSide }), MAX);
  mesh.name = 'droppedFlowers';
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const flowers = [];
  let next = 0;
  const q = new THREE.Quaternion(), m4 = new THREE.Matrix4(), sv = new THREE.Vector3(SIZE, SIZE, SIZE), e3 = new THREE.Euler();
  // lying: flat on the ground, face up or down, a little tilted
  const lie = (f) => {
    f.falling = false;
    f.p.y = world.height(f.p.x, f.p.z) + 0.012;
    e3.set((rng() < 0.3 ? Math.PI : 0) + (rng() - 0.5) * 0.3, rng() * Math.PI * 2, (rng() - 0.5) * 0.3);
    f.q.setFromEuler(e3);
  };
  const add = (x, y, z) => {
    const f = { p: new THREE.Vector3(x, y, z), q: new THREE.Quaternion().random(), axis: new THREE.Vector3().randomDirection(), v: 0, falling: true };
    if (flowers.length < MAX) flowers.push(f); else { flowers[next] = f; next = (next + 1) % MAX; }
    return f;
  };
  for (let k = 0; k < SEED; k++) {
    const a = rng() * Math.PI * 2, r = 1.5 + 4 * Math.sqrt(rng());
    lie(add(tree[0] + Math.cos(a) * r, 0, tree[1] + Math.sin(a) * r));
  }
  return {
    mesh,
    // a flower bitten off at { x, y, z }
    drop(p) { add(p.x, p.y, p.z); },
    // ctx: { wind (0..1), windDir (Vector2) }
    update(dt, ctx) {
      dt = Math.min(dt, 0.1);
      flowers.forEach((f, i) => {
        if (f.falling) {
          // tumbling down, drifting with the wind, slowed by the air
          f.v = Math.min(FALL, f.v + 9.8 * dt);
          f.p.y -= f.v * dt;
          f.p.x += ctx.windDir.x * ctx.wind * 1.5 * dt; f.p.z += ctx.windDir.y * ctx.wind * 1.5 * dt;
          f.q.premultiply(q.setFromAxisAngle(f.axis, SPIN * dt));
          if (f.p.y <= world.height(f.p.x, f.p.z) + 0.012) lie(f);
        }
        mesh.setMatrixAt(i, m4.compose(f.p, f.q, sv));
      });
      mesh.count = flowers.length;
      mesh.instanceMatrix.needsUpdate = true;
    },
    info: () => ({ n: flowers.length, falling: flowers.filter((f) => f.falling).length }),
  };
}
