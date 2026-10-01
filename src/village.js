// The village's buildings (Blender models, tools/village.py; world.js BUILDINGS says where they stand): thatched
// farmhouses, storehouses and sheds along the lane at the foot of the western slope and above the eastern terraces,
// a waterwheel and its mill on the west bank, and a torii at the foot of the temple's approach by the bridge. Generation only (runs in a worker); drawn by
// lods.js, a full model near and a lighter one beyond.
// Its lights after dusk: a paper lantern under the eaves by each farmhouse's door and the mill's (drawn with the
// riverside ones, fx.js), the light the lit shoji throw on the yard, and stone lanterns in pairs up the temple's
// approach from the torii (temple.js toro), their light on the path (lights.js).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';
import { kit, toro } from './temple.js';

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
  // door lanterns (hang, look as lanterns.js) and the shoji's light on the yard (lights.js lamp: x, y, z, s, r)
  const hang = [], look = [], spill = [];
  // in each model's frame (tools/village.py, y up, its front +z): beside the door under the eave, the eave's
  // underside; the shoji's middle, the front wall's half-length
  const DOOR = { minka0: [6.7, 2.0, 2.9], minka1: [4.85, 1.85, 2.2], suisha: [-1.45, 1.8, 1.95] };
  const SHOJI = { minka0: [3.6, 6.2], minka1: [2.9, 4.4] };
  for (const b of world.BUILDINGS) {
    const sc = b.kind.startsWith('minka') ? 0.95 + rng() * 0.1 : 1;
    put(b.kind, b.x, b.y - 0.05, b.z, b.yaw, sc);
    const at = ([px, py, pz]) => [b.x + sc * (px * b.c + pz * b.s), b.y - 0.05 + sc * py, b.z + sc * (pz * b.c - px * b.s)];
    if (DOOR[b.kind]) {
      hang.push(...at(DOOR[b.kind]));
      // phase, the family crest (LANTERN_TEXTS 0), brightness, yaw: its face to the yard
      look.push(rng() * 6.28, 0, 0.8 + rng() * 0.2, b.yaw);
    }
    if (SHOJI[b.kind]) {
      const [d, half] = SHOJI[b.kind];
      for (const u of [-0.5, 0.5]) spill.push(at([u * half, 1.5, d + 1.4]));
    }
  }
  for (const t of TORII) put('torii', t.x, world.height(t.x, t.z) - 0.1, t.z, t.yaw, 1);
  // the waterwheel: its hub 2.9 m out along the mill's axle, 1.6 m up (tools/village.py), facing as the mill
  const w = world.BUILDINGS.find((b) => b.kind === 'suisha');
  const wheel = w && { pos: [w.x + 2.9 * w.c, w.y - 0.05 + 1.6, w.z - 2.9 * w.s], yaw: w.yaw };
  return {
    lists: lists.map((l) => ({ matrix: new Float32Array(l.m), color: new Float32Array(l.c), n: l.c.length / 3 })), wheel,
    lamps: { hang: new Float32Array(hang), look: new Float32Array(look), n: hang.length / 3 }, spill: new Float32Array(spill.flat()),
    toro: toroData(world),
  };
}

// Stone lanterns in pairs either side of the temple's approach (world.js LANES[1]), from past the torii to short of
// the temple's own at the foot of its steps, none where another lane leaves it: one geometry (color, aGlow) and the
// fireboxes' centres
const TORO = { from: 14, to: 9, every: 10.5, off: 2.1 };
function toroData(world) {
  const k = kit(), path = world.LANES[1];
  const others = world.LANES.filter((l) => l !== path);
  const onLane = (x, z) => others.some((l) => l.some(([ax, az], i) => {
    if (!i) return false;
    const [bx, bz] = l[i - 1], vx = bx - ax, vz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
    return Math.hypot(x - ax - vx * t, z - az - vz * t) < 2.6;
  }));
  const segs = [];
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1], [bx, bz] = path[i], l = Math.hypot(bx - ax, bz - az);
    segs.push({ ax, az, dx: (bx - ax) / l, dz: (bz - az) / l, s0: len, l });
    len += l;
  }
  for (let s = TORO.from; s <= len - TORO.to; s += TORO.every) {
    const g = segs.find((q) => s <= q.s0 + q.l) || segs[segs.length - 1], t = s - g.s0;
    const x = g.ax + g.dx * t, z = g.az + g.dz * t;
    for (const side of [-1, 1]) {
      const px = x - g.dz * side * TORO.off, pz = z + g.dx * side * TORO.off;
      if (!onLane(px, pz)) toro(k, px, world.height(px, pz) - 0.05, pz, Math.atan2(g.dx, g.dz));
    }
  }
  return { geo: mergeGeometries(k.parts), lamps: new Float32Array(k.lamps.flatMap((p) => p.toArray())) };
}
