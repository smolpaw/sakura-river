// Surface kinds: which photographed texture a surface takes (materials.js PHOTO_KIND), stored per vertex as kind / 8 (a
// float: kinds past 8 go above 1) in the attribute `_kind`. The Blender scripts write the same numbers into their
// models (tools/village.py surface_kind, the lamps' and boats' palettes; tools/forest.py the woods' bark).
import * as THREE from 'three';

export const KIND = { NONE: 0, THATCH: 1, WOOD: 2, PLASTER: 3, STONE: 4, TILE: 5, PAINT: 6, CARVED: 7, BARK: 8, GRAVEL: 9 };

// Tags each part (geometries of one colour each, as temple.js kit() makes them) by its colour: the kind of the palette
// entry it matches exactly, NONE for any other; a part given its own kind (userData.kind: stones each in their own
// tone) keeps that. Run before anything shades the colours (skyLight).
export function tagKinds(parts, palette) {
  for (const g of parts) {
    const c = g.attributes.color.array, n = g.attributes.position.count;
    const hit = palette.find(([p]) => p.every((v, j) => Math.abs(c[j] - v) < 1e-6));
    g.setAttribute('_kind', new THREE.BufferAttribute(new Float32Array(n).fill((g.userData.kind ?? (hit ? hit[1] : KIND.NONE)) / 8), 1));
  }
}
