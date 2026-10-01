// Procedural generation jobs. Each runs in a worker (or on the main thread as a fallback) and returns plain
// data: typed arrays, packed geometries and small JSON. Every job owns its seeds, so jobs run in any order.
import { createWorld } from '../world.js';
import { paintFlowerAtlas, paintBark, treeData, MAIN_TREE, SMALL_TREE } from '../tree.js';
import { turfData, grassMask, flowersData, rocksData, rockPlan, cliffData, forestData, bambooData, shrubData } from '../vegetation.js';
import { fujiGeometry, bridgeData, bridgeRopeAnchors, BRIDGE_Z } from '../props.js';
import { templeData } from '../temple.js';
import { fallenData, raftData } from '../petals.js';
import { lanternData, lanternGeometry, paintLanternInk } from '../lanterns.js';
import { tessellate } from '../stress.js';
import { villageData } from '../village.js';
import { lerp } from '../noise.js';
import { layout, rockAvoid, trunkAvoid, underTree, lawn, turf } from './layout.js';

let W = null;
const world = () => (W ||= createWorld(7));
const L = () => layout(world());
const xz = (p) => ({ x: p[0], y: p[1], z: p[2] });
const tess = (g, m) => (m > 1 ? tessellate(g, m) : g);

export const JOBS = {
  // the meadow's grass grows into the terrain grid: short on the lawn under the tree, thinned where the deer's turf is
  terrain: ({ seg }) => {
    const l = L(), lw = lawn(l), tf = turf(l, 0);
    return world().buildTerrain(seg[0], seg[1], (x, z) => [1 - 0.85 * tf.density(x, z), lerp(0.13, 1, lw(x, z))]);
  },
  heightCache: () => world().computeHeightCache(),
  depth: ({ tier }) => world().buildDepthMap(rockPlan(world(), tier, xz(L().tree)).rocksInWater),
  river: () => world().buildRiver(),
  trees: ({ list, tier, triMul }) => list.map((t) => treeData(world(), t.seed, t.small ? SMALL_TREE : MAIN_TREE, xz(t.pos), tier, triMul)),
  atlas: ({ size }) => paintFlowerAtlas(5, size),
  bark: () => paintBark(3),
  fuji: () => { const w = world(); return fujiGeometry(w.peak.x, w.peak.z, w.peak.R, 820, 30); },
  props: ({ triMul }) => {
    const b = bridgeData(world(), BRIDGE_Z);
    b.geo = tess(b.geo, triMul);
    const t = templeData(world());
    t.geo = tess(t.geo, triMul);
    t.y = world().temple.y;
    return { bridge: b, temple: t };
  },
  rocks: ({ tier }) => rocksData(world(), tier, xz(L().tree)),
  fields: ({ zones }) => world().buildFields(0.5, zones),
  village: () => villageData(world()),
  // no grass in the boulders or round the cherries' trunks
  grassMask: ({ tier }) => {
    const l = L();
    const rocks = rockPlan(world(), tier, xz(l.tree)).placements.filter((r) => r.sc > 0.3).map((r) => ({ x: r.x, z: r.z, r: r.sc * 0.95 }));
    const trunks = [{ x: l.TX, z: l.TZ, r: 0.95 }, ...l.small.map((sp) => ({ x: sp.x, z: sp.z, r: 0.45 * sp.s }))];
    return grassMask(rocks, trunks);
  },
  turf: ({ count }) => turfData(world(), turf(L(), count)),
  flowers: ({ count, tier }) => {
    const l = L();
    const avoid = rockAvoid(l, rockPlan(world(), tier, xz(l.tree)).placements);
    return flowersData(world(), count, { focus: xz(l.focus), radius: 48, avoid, lawn: lawn(l) });
  },
  forest: ({ count }) => forestData(world(), count),
  cliffs: () => cliffData(world()),
  bamboo: () => bambooData(world()),
  // clear of the cherries: the main tree's lawn and crown, the small trees' clearings
  shrubs: () => { const l = L(); return shrubData(world(), [{ x: l.TX, z: l.TZ, r: 22 }, ...l.small.map((sp) => ({ x: sp.x, z: sp.z, r: 8 }))]); },
  lanterns: ({ tier }) => {
    const l = L();
    const trees = [l.tree, ...l.small.map((sp) => [sp.x, 0, sp.z])].map(([x, , z]) => ({ x, z, r: 1 }));
    const rocks = rockPlan(world(), tier, xz(l.tree)).placements.map((r) => ({ x: r.x, z: r.z, r: r.sc }));
    return { ...lanternData(world(), rocks.concat(trees), bridgeRopeAnchors(world()), xz(l.tree)), lantern: lanternGeometry(), ink: paintLanternInk() };
  },
  fallen: ({ count }) => fallenData(world(), xz(L().tree), count, trunkAvoid(L()), underTree(L())),
  rafts: ({ count, tier }) => raftData(world(), count, rockPlan(world(), tier, xz(L().tree)).rocksInWater),
};

// rough single-thread cost (ms, high tier on a desktop CPU) for longest-first scheduling
export const COST = { terrain: 800, depth: 220, grassMask: 5, fields: 400, village: 2, turf: 10, atlas: 60, bark: 120, heightCache: 90, trees: 150, fuji: 40, props: 200, rocks: 80, lanterns: 20, forest: 11, cliffs: 1, bamboo: 5, shrubs: 60, flowers: 10, fallen: 7, rafts: 8, river: 3 };
