// The data tools/cherry.py builds the cherries' trunks from (tools/blender.mjs writes it to a JSON file and hands it
// over): each tree's roots and main branches as tree.js grows them, from the scene's own layout and ground.
import { createWorld } from '../src/world.js';
import { layout, treeSpecs } from '../src/gen/layout.js';
import { trunkSkeleton, MAIN_TREE, SMALL_TREE } from '../src/tree.js';

export default function () {
  const world = createWorld(7);
  return treeSpecs(layout(world)).map((t, i) => ({
    name: `trunk${i}`, small: !!t.small,
    ...trunkSkeleton(world, t.seed, t.small ? SMALL_TREE : MAIN_TREE, { x: t.pos[0], y: 0, z: t.pos[2] }),
  }));
}
