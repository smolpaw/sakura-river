// The village's buildings (Blender models, tools/village.py; world.js BUILDINGS says where they stand): thatched
// farmhouses, storehouses and sheds along the lane at the foot of the western slope and above the eastern terraces,
// a waterwheel and its mill on the west bank, and a torii at the foot of the temple's approach by the bridge. Generation only (runs in a worker); drawn by
// lods.js, a full model near and a lighter one beyond.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';

export const VILLAGE_KINDS = ['minka0', 'minka1', 'kura', 'koya', 'torii', 'suisha'];

// the torii where the approach leaves the bridge, facing back along it
const TORII = [{ x: -9.6, z: -69.5, yaw: -0.37 }];

export function villageData(world) {
  const rng = mulberry32(606);
  const lists = VILLAGE_KINDS.map(() => ({ m: [], c: [] }));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const put = (kind, x, y, z, yaw, scale) => {
    const l = lists[VILLAGE_KINDS.indexOf(kind)];
    p.set(x, y, z);
    q.setFromAxisAngle(up, yaw);
    s.setScalar(scale);
    l.m.push(...m.compose(p, q, s).elements);
    // each building weathered a little differently
    const t = 0.9 + rng() * 0.18;
    l.c.push(t, t * (0.97 + rng() * 0.05), t * (0.94 + rng() * 0.06));
  };
  for (const b of world.BUILDINGS) put(b.kind, b.x, b.y - 0.05, b.z, b.yaw, b.kind.startsWith('minka') ? 0.95 + rng() * 0.1 : 1);
  for (const t of TORII) put('torii', t.x, world.height(t.x, t.z) - 0.1, t.z, t.yaw, 1);
  // the waterwheel: its hub 2.9 m out along the mill's axle, 1.6 m up (tools/village.py), facing as the mill
  const w = world.BUILDINGS.find((b) => b.kind === 'suisha');
  const wheel = w && { pos: [w.x + 2.9 * w.c, w.y - 0.05 + 1.6, w.z - 2.9 * w.s], yaw: w.yaw };
  return { lists: lists.map((l) => ({ matrix: new Float32Array(l.m), color: new Float32Array(l.c), n: l.c.length / 3 })), wheel };
}
