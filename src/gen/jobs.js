// Procedural generation jobs. Each runs in a worker (or on the main thread as a fallback) and returns plain
// data: typed arrays, packed geometries and small JSON. Every job owns its seeds, so jobs run in any order.
import { createWorld } from '../world.js';
import { paintBlossomAtlas, paintBark, treeData, MAIN_TREE, SMALL_TREE } from '../tree.js';
import { grassData, flowersData, rocksData, rockPlan, forestData } from '../vegetation.js';
import { fujiGeometry, lanternGeometry, bridgeData, pagodaGeometry } from '../props.js';
import { fallenData } from '../petals.js';
import { tessellate } from '../stress.js';
import { layout, rockAvoid, trunkAvoid } from './layout.js';

let W = null;
const world = () => (W ||= createWorld(7));
const L = () => layout(world());
const xz = (p) => ({ x: p[0], y: p[1], z: p[2] });
const tess = (g, m) => (m > 1 ? tessellate(g, m) : g);

export const JOBS = {
  terrain: ({ seg }) => world().buildTerrain(seg[0], seg[1]),
  heightCache: () => world().computeHeightCache(),
  depth: ({ tier }) => world().buildDepthMap(rockPlan(world(), tier, xz(L().tree)).rocksInWater),
  river: () => world().buildRiver(),
  trees: ({ list, triMul }) => list.map((t) => treeData(world(), t.seed, t.small ? SMALL_TREE : MAIN_TREE, xz(t.pos), t.blossomScale, triMul)),
  atlas: ({ size }) => paintBlossomAtlas(5, size),
  bark: () => paintBark(3),
  fuji: () => { const w = world(); return fujiGeometry(w.peak.x, w.peak.z, w.peak.R, 820, 30); },
  props: ({ triMul }) => {
    const b = bridgeData(world(), -60);
    b.geo = tess(b.geo, triMul);
    return { lantern: tess(lanternGeometry(), triMul), bridge: b, pagoda: tess(pagodaGeometry(), triMul) };
  },
  rocks: ({ tier, triMul }) => rocksData(world(), tier, xz(L().tree), triMul),
  grass: ({ count, tier }) => {
    const l = L();
    const avoid = rockAvoid(l, rockPlan(world(), tier, xz(l.tree)).placements);
    return grassData(world(), count, { focus: xz(l.focus), radius: 62, avoid });
  },
  flowers: ({ count, tier }) => {
    const l = L();
    const avoid = rockAvoid(l, rockPlan(world(), tier, xz(l.tree)).placements);
    return flowersData(world(), count, { focus: xz(l.focus), radius: 48, avoid });
  },
  forest: ({ count }) => forestData(world(), count),
  fallen: ({ count }) => fallenData(world(), xz(L().tree), count, trunkAvoid(L())),
};

// rough single-thread cost (ms, high tier on a desktop CPU) for longest-first scheduling
export const COST = { terrain: 330, depth: 220, grass: 150, atlas: 150, bark: 120, heightCache: 90, trees: 60, fuji: 40, props: 25, rocks: 25, forest: 11, flowers: 10, fallen: 7, river: 3 };
