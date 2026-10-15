// The farmhouses' yards' everyday things (Blender models, tools/yard.py): firewood stacked under the eaves, a well, a
// kitchen garden, washing on a pole, straw in sheaves, baskets and a washtub, a handcart, a stone mortar. Each kind of
// building has places for them (SLOTS, in its frame: under the eaves at the back and the end away from the doma, in
// the front yard by the doma's door, before the veranda, in the yard's far corner), each place a few things that
// would stand there; each place takes one of them or nothing, each yard by its own draws, so no two yards are alike. A thing
// stands only where its footprint lies on its pad (world.js), clear of the lanes (walk.js keeps the walker to a
// corridor along them) and of what else stands in the yard. Generation only (in the village's job); drawn by lods.js
// (main.js), the full model within 40 m and a lighter one beyond.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';

export const YARD_KINDS = ['maki', 'ido', 'hatake', 'hoshi', 'wara', 'kago', 'kuruma', 'usu'];
// each kind's footprint in its own frame (tools/yard.py): half its width (x), half its depth (z)
const FOOT = { maki: [0.97, 0.3], ido: [0.95, 0.65], hatake: [1.65, 1.2], hoshi: [1.95, 0.4], wara: [1.1, 0.55], kago: [0.75, 0.4], kuruma: [0.7, 1.4], usu: [0.5, 0.45] };
const B = Math.PI, E = -Math.PI / 2, H = Math.PI / 2;
// per kind of building, its places: where (x, z in the building's frame, +z its front; scaled with the building), the
// turn of what stands there from the building's (0: facing the yard), and what may stand there (null: nothing)
const SLOTS = {
  // the big farmhouse (tools/village.py minka0: walls 12.5 x 7.2 m, eaves 1.15 m beyond them, the doma's door on its
  // +x end; its pad 15.2 m wide, its yard 4 m beyond the veranda)
  minka0: [
    { at: [-2.6, -4.2], yaw: B, kinds: ['maki', 'maki', 'wara'] },
    { at: [2.4, -4.2], yaw: B, kinds: ['wara', 'kago', null] },
    { at: [-6.8, 0.4], yaw: E, kinds: ['maki', null] },
    { at: [5.4, 6.5], yaw: 0, kinds: ['ido', 'ido', 'usu'] },
    { at: [-1.6, 6.9], yaw: 0, kinds: ['hoshi', 'hoshi', null] },
    { at: [-5.4, 7.0], yaw: 0, kinds: ['hatake', 'hatake', 'kuruma', 'wara'] },
    { at: [2.6, 5.5], yaw: 0, kinds: ['usu', 'kago', null] },
  ],
  // the small farmhouse (minka1: walls 8.8 x 5.8 m)
  minka1: [
    { at: [-1.8, -3.55], yaw: B, kinds: ['maki', 'wara'] },
    { at: [1.9, -3.55], yaw: B, kinds: ['kago', 'maki', null] },
    { at: [-5.1, 0.2], yaw: E, kinds: ['maki', 'wara', null] },
    { at: [3.9, 5.9], yaw: 0, kinds: ['ido', 'usu', 'kago'] },
    { at: [0.1, 6.4], yaw: 0, kinds: ['hoshi', null] },
    { at: [-3.9, 6.2], yaw: 0, kinds: ['hatake', 'hatake', 'kuruma', 'wara'] },
  ],
  // the storehouse (kura: 4.6 x 3.6 m on its base) and the shed (koya: 3.6 x 2.6 m, its firewood along its back)
  kura: [
    { at: [1.9, 3.6], yaw: 0, kinds: ['kago', 'usu', 'wara', null] },
    { at: [-2.85, 0.4], yaw: E, kinds: ['maki', null] },
  ],
  koya: [
    { at: [0.7, 2.45], yaw: H, kinds: ['kuruma', 'wara', null] },
    { at: [-1.65, 2.65], yaw: 0, kinds: ['kago', 'usu', null] },
  ],
};
const PAD_MARGIN = 0.15; // m of the pad kept clear round a footprint
const LANE_CLEAR = 1.7; // the footprint's nearest point from a lane's middle (walk.js: the corridor's 1.2 m and the walker's body)

// houses: [{ b: the building (world.js BUILDINGS), sc: its model's scale }]. Returns the instances for lods.js (per kind
// { matrix, color, n }) and what the walker goes round ([{ x, z, r }], walk.js keeps those near a path).
export function yardData(world, houses) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const lists = YARD_KINDS.map(() => ({ m: [], c: [] })), posts = [];
  const hyp = Math.hypot;
  houses.forEach(({ b, sc }, h) => {
    const rng = mulberry32(808 + h * 31); // (each yard its own draws, whatever fits in the others)
    const slots = SLOTS[b.kind];
    if (!slots) return;
    const placed = []; // footprints in this yard so far: { x, z, r }
    for (const slot of slots) {
      const kind = slot.kinds[Math.floor(rng() * slot.kinds.length)];
      const turn = rng(), wear = [rng(), rng(), rng()];
      if (!kind) continue;
      const [hw, hd] = FOOT[kind];
      // where it stands, and which way it faces (its front, +z, turned with the building and by the slot)
      const lx = slot.at[0] * sc, lz = slot.at[1] * sc;
      const x = b.x + lx * b.c + lz * b.s, z = b.z - lx * b.s + lz * b.c, yaw = b.yaw + slot.yaw + (turn - 0.5) * 0.12;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      // the footprint, and a margin round it on the pad (off its wall's top course), every 0.5 m at most
      const ring = (w, d) => {
        const nu = Math.ceil(w / 0.25), nv = Math.ceil(d / 0.25), pts = [];
        for (let i = -nu; i <= nu; i++) for (let j = -nv; j <= nv; j++) {
          const u = (w * i) / nu, v = (d * j) / nv;
          pts.push([x + u * c + v * s, z - u * s + v * c]);
        }
        return pts;
      };
      const fits = ring(hw + PAD_MARGIN, hd + PAD_MARGIN).every(([px, pz]) => world.padDist(b, px, pz) === 0)
        && ring(hw, hd).every(([px, pz]) => world.laneDist(px, pz) >= LANE_CLEAR && !world.zoneAt(px, pz))
        && world.CLEAR.every(([cx, cz]) => hyp(x - cx, z - cz) > 2.5 + hyp(hw, hd))
        && placed.every((o) => hyp(o.x - x, o.z - z) > o.r + Math.min(hw, hd));
      if (!fits) continue;
      const l = lists[YARD_KINDS.indexOf(kind)];
      m4.compose(p.set(x, b.y, z), q.setFromAxisAngle(up, yaw), one);
      l.m.push(...m4.elements);
      const t = 0.92 + wear[0] * 0.14; // each a little different in its wear
      l.c.push(t, t * (0.97 + wear[1] * 0.04), t * (0.94 + wear[2] * 0.06));
      placed.push({ x, z, r: Math.min(hw, hd) });
      // for the walker: circles along its longer side
      const n = Math.max(1, Math.round(hw / hd));
      for (let i = 0; i < n; i++) {
        const u = n === 1 ? 0 : -hw + hd + ((2 * (hw - hd)) * i) / (n - 1);
        posts.push({ x: x + u * c, z: z - u * s, r: n === 1 ? hyp(hw, hd) : hd * 1.42 });
      }
    }
  });
  return { lists: lists.map((l) => ({ matrix: new Float32Array(l.m), color: new Float32Array(l.c), n: l.c.length / 3 })), posts };
}
