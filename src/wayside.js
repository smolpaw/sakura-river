// The wayside's stones by the lanes (Blender models, tools/wayside.py): a roku-jizō, six Jizō in red bibs and caps
// under their shelter, where the footpath from the cherry tree meets the valley lane by the bridge's west end; single
// Jizō by the valley lane where it reaches the village and on the hamlet's lane; stone signposts (michishirube) at
// that fork and at the foot of the temple's approach by the torii; roadside shrines (hokora) on the valley lane above
// the village, on its uphill side, and half-way up the approach.
// Each site is a rough spot; the place is searched round it: on firm, fairly level ground beside the lane but out of
// the walker's corridor (walk.js), off the farmland, the buildings' pads, the bridge and its landings and the banks
// (where the lamps stand), clear of the stone lanterns, the torii and the small cherries, facing the lane. The shrubs
// and the grass keep off them (waysideClearings). Generation only (in the village's job); drawn by lods.js (main.js),
// the full model within 40 m and a lighter one beyond.
import * as THREE from 'three';
import { bridgeFrame, BRIDGE_Z } from './props.js';
import { TORII, toroSites } from './village.js';

export const WAYSIDE_KINDS = ['jizo', 'jizo1', 'dohyo', 'hokora'];
// each kind's footprint in its own frame (tools/wayside.py): half its width across the front, half its depth (the
// roku-jizō's roof, the hokora's torii in front)
const FOOT = { jizo: [1.95, 0.85], jizo1: [0.28, 0.32], dohyo: [0.13, 0.13], hokora: [0.34, 0.48] };
// where each stands, roughly, and how far round it to look; placed in this order, each clear of those before
const SITES = [
  { kind: 'jizo', at: [-38.5, -56.5], r: 5 },
  { kind: 'dohyo', at: [-36, -59.5], r: 4 },
  { kind: 'dohyo', at: [-7.5, -66.5], r: 4 },
  { kind: 'jizo1', at: [-69.5, -86], r: 5 },
  { kind: 'jizo1', at: [17, -116], r: 6 },
  { kind: 'hokora', at: [-95, -139.5], r: 5 },
  { kind: 'hokora', at: [0.5, -129], r: 6 },
];
const LANE_CLEAR = 1.55; // the footprint's nearest point from a lane's middle (walk.js: the corridor's 1.2 m and the walker's body)
const LANE_NEAR = 2.3; // ... and beyond this, the further the worse
const LANDING = 3.6; // m round the bridge's deck and its landings kept clear
const BANK = 1.7; // in the river's half-widths from its middle: the banks' lamps stand within (lanterns.js)

const cache = new WeakMap();
// where each stands: [{ kind, x, y, z, yaw, hw, hd }] (once per world: the shrubs' and the grass mask's jobs ask too)
export function waysideSites(world) {
  if (cache.has(world)) return cache.get(world);
  const B = bridgeFrame(world, BRIDGE_Z);
  // what stands by the lanes, as circles { x, z, r }: the stone lanterns, the torii, the small cherries
  const block = [
    ...toroSites(world).map((t) => ({ x: t.x, z: t.z, r: 0.6 })),
    ...TORII.map((t) => ({ x: t.x, z: t.z, r: 2.2 })),
    ...world.CLEAR.map(([x, z]) => ({ x, z, r: 2.5 })),
  ];
  const onBridge = (x, z) => {
    const dx = x - B.center.x, dz = z - B.center.z;
    return Math.abs(dx * B.across.x + dz * B.across.z) < B.half + LANDING && Math.abs(dx * B.along.x + dz * B.along.z) < LANDING;
  };
  // the way to the nearest lane from (x, z), as a yaw (the model's front, +z, turned to it)
  const facing = (x, z) => {
    const e = 0.5, gx = world.laneDist(x + e, z) - world.laneDist(x - e, z), gz = world.laneDist(x, z + e) - world.laneDist(x, z - e);
    return Math.atan2(-gx, -gz);
  };
  // (looked up on a 0.1 m grid: the footprints of neighbouring candidates sample the same ground)
  const memo = new Map();
  const ok = (x, z) => {
    const key = Math.round(x * 10) * 100000 + Math.round(z * 10);
    let v = memo.get(key);
    if (v === undefined) memo.set(key, v = world.laneDist(x, z) >= LANE_CLEAR && !world.padAt(x, z) && !onBridge(x, z) && world.riverInfo(x, z).t > BANK && !world.zoneAt(x, z));
    return v;
  };
  const sites = [];
  for (const site of SITES) {
    const [hw, hd] = FOOT[site.kind];
    const reach = site.r + hw + hd + 3; // (only what stands within reach of the search)
    const near = block.filter((b) => Math.abs(b.x - site.at[0]) < reach + b.r && Math.abs(b.z - site.at[1]) < reach + b.r);
    // a candidate place: its score (the distance from the site, and how far it stands back from the lane beyond
    // LANE_NEAR), or null where it does not fit
    const fit = (x, z) => {
      const d = Math.hypot(x - site.at[0], z - site.at[1]);
      if (d > site.r || !ok(x, z)) return null;
      const yaw = facing(x, z), c = Math.cos(yaw), s = Math.sin(yaw);
      // the footprint sampled along its edges, at most 0.5 m apart
      const nu = Math.ceil(hw / 0.25), nv = Math.ceil(hd / 0.25), pts = [];
      for (let i = -nu; i <= nu; i++) for (let j = -nv; j <= nv; j++) {
        if (Math.abs(i) !== nu && Math.abs(j) !== nv) continue;
        const lx = hw * i / nu, lz = hd * j / nv;
        pts.push([x + lx * c + lz * s, z - lx * s + lz * c]);
      }
      let lo = Infinity, hi = -Infinity, ld = Infinity;
      for (const [px, pz] of pts) {
        if (!ok(px, pz)) return null;
        const h = world.heightFast(px, pz);
        lo = Math.min(lo, h); hi = Math.max(hi, h); ld = Math.min(ld, world.laneDist(px, pz));
      }
      if (hi - lo > 0.32) return null;
      for (const b of near) {
        const dx = b.x - x, dz = b.z - z, lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.hypot(Math.max(0, Math.abs(lx) - hw), Math.max(0, Math.abs(lz) - hd)) <= b.r) return null;
      }
      return { score: d + 1.5 * Math.max(0, ld - LANE_NEAR), x, z, yaw, pts };
    };
    // on a 0.5 m grid round the site, then finer round the best
    let best = null;
    const scan = (x0, z0, r, step) => {
      for (let gx = -r; gx <= r + 1e-6; gx += step) for (let gz = -r; gz <= r + 1e-6; gz += step) {
        const f = fit(x0 + gx, z0 + gz);
        if (f && (!best || f.score < best.score)) best = f;
      }
    };
    scan(site.at[0], site.at[1], site.r, 0.5);
    if (best) scan(best.x, best.z, 0.5, 0.125);
    if (!best) { console.warn('wayside: no room for the', site.kind, 'near', site.at); continue; }
    sites.push({ kind: site.kind, x: best.x, y: Math.min(...best.pts.map(([px, pz]) => world.height(px, pz))), z: best.z, yaw: best.yaw, hw, hd });
    block.push({ x: best.x, z: best.z, r: Math.hypot(hw, hd) + 0.4 }); // (what stands later keeps clear of it)
  }
  cache.set(world, sites);
  return sites;
}

// the instances for lods.js: per kind { matrix, color, n }
export function waysideData(world) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  return WAYSIDE_KINDS.map((kind) => {
    const list = waysideSites(world).filter((s) => s.kind === kind), matrix = new Float32Array(list.length * 16), color = new Float32Array(list.length * 3);
    list.forEach((s, i) => {
      m4.compose(p.set(s.x, s.y - 0.03, s.z), q.setFromAxisAngle(up, s.yaw), one).toArray(matrix, i * 16);
      const t = 0.94 + i * 0.05; // each stone weathered a little differently
      color.set([t, t, t * 0.98], i * 3);
    });
    return { matrix, color, n: list.length };
  });
}

// circles { x, z, r } over each footprint and a little round it, for what keeps off them: the shrubs, the grass
export function waysideClearings(world, pad = 0.3) {
  const out = [];
  for (const s of waysideSites(world)) {
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw), n = Math.max(1, Math.round(s.hw / s.hd));
    for (let i = 0; i < n; i++) {
      const lx = n === 1 ? 0 : -s.hw + s.hd + (2 * (s.hw - s.hd) * i) / (n - 1);
      out.push({ x: s.x + lx * c, z: s.z - lx * sn, r: (n === 1 ? Math.hypot(s.hw, s.hd) : s.hd * 1.42) + pad });
    }
  }
  return out;
}

// the roku-jizō's roof as triangles in the world (positions, tools/wayside.py roku_jizo: the ridge 1.9 m up, the eaves
// 1.44 m up and 0.8 m out front and back, 1.9 m either side), closed into a solid under its slopes: the shadow it casts
// into the valley's map (its own shingles, seen edge-on from a low sun, rasterize there into stripes of shadow, and its
// statues and plinth are too small to cast cleanly)
export function waysideRoofs(world) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const out = [];
  for (const s of waysideSites(world).filter((w) => w.kind === 'jizo')) {
    m4.compose(p.set(s.x, s.y - 0.03, s.z), q.setFromAxisAngle(up, s.yaw), one);
    const v = ([x, y, z]) => out.push(...p.set(x, y, z).applyMatrix4(m4).toArray());
    const P = [[-1.9, 1.44, 0.8], [1.9, 1.44, 0.8], [1.9, 1.9, 0], [-1.9, 1.9, 0], [-1.9, 1.44, -0.8], [1.9, 1.44, -0.8]];
    // the two slopes, the eaves' plane under them, the gable ends
    for (const t of [[0, 1, 2], [0, 2, 3], [5, 4, 3], [5, 3, 2], [0, 4, 5], [0, 5, 1], [0, 3, 4], [1, 5, 2]]) t.forEach((i) => v(P[i]));
  }
  return new Float32Array(out);
}
