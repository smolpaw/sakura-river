// The meadow's grass, placed on the GPU around the camera: no per-blade data, only the terrain grid (world.js
// buildTerrain: height and the grass grown at each vertex) and a fine mask round the boulders and trunks.
//
// Blades stand on world-fixed cells in levels: level k's cells are 2^k times the finest, and each blade has a rank
// (level k holds ranks 4^-(k+1) .. 4^-k, the last level everything below). A blade is kept while its rank is under
// keep(d) = (D0 / d)^2 times the ground's density, and shrinks into the ground as keep(d) falls past it, so the
// grass thins smoothly with distance; level k is only needed out to D0 * 2^(k+1), so every level costs about the
// same and the grass reaches MAXD metres for a few levels' worth of blades. Far blades are wider and turn to face
// the camera. Each level is one instanced draw over the tiles of its grid that are in view (culled on the CPU).
import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, int, ivec2, mix, max, min, pow, dot, normalize, clamp, floor, fract, exp, asinh, sin,
  instanceIndex, positionGeometry, cameraPosition, textureLoad, texture, uniform, uniformArray, varyingProperty,
  transformNormalToView, positionWorld, select, length,
} from 'three/tsl';
import { U, vnoise, sstep, LitMaterial, windOffset, lanternLight, SHADOW_NORMAL_BIAS } from './tsl.js';
import { TERRAIN_GRID, terrainSMaxZ } from './world.js';

// c0: finest cell (m), d0: full density out to here (m), wide: blade width (fewer blades, wider), segs: blade
// segments per level. Blades drawn go with (d0 / c0)^2: medium 67% of high, low 25%.
export const GRASS_TIERS = {
  high: { c0: 0.17, d0: 12, wide: 1, segs: [4, 3, 2, 1, 1] },
  medium: { c0: 0.19, d0: 11, wide: 1.1, segs: [3, 2, 2, 1, 1] },
  low: { c0: 0.27, d0: 9.5, wide: 1.4, segs: [2, 2, 1, 1] },
};
export const MAXD = 240; // the grass ends here; the terrain's colour carries on (materials.js terrainMaterial)
const SIDE = 8; // tiles per side of a level's grid, centred on the camera
const MAXT = 40; // tiles drawn per level at most (a level's range circle covers ~28-36 of its 64)

// Hoskins' hash44: four uniform values from a cell
const hash44 = Fn(([p]) => {
  const q = fract(p.mul(vec4(0.1031, 0.103, 0.0973, 0.1099))).toVar();
  q.addAssign(dot(q, q.wzxy.add(33.33)));
  return fract(q.xxyz.add(q.yzzw).mul(q.zywx));
});
const sinh = (x) => exp(x).sub(exp(x.negate())).mul(0.5);

// the terrain under (x, z) as its mesh draws it: the grid cell from the inverse of its sinh spacing, then the
// triangle (the mesh splits each cell along b-c) -> vec4(height, density, length, tint)
export function terrainSampler(gridTex, segX, segZ) {
  const { kx, cx, ox, kz, cz, z0 } = TERRAIN_GRID;
  const sz = terrainSMaxZ() + 1;
  return Fn(([p]) => {
    const fi = asinh(p.x.sub(ox).div(kx)).div(cx).add(1).mul(segX / 2);
    const fj = asinh(p.y.sub(z0).div(kz)).div(cz).add(1).mul(segZ / sz);
    const i0 = clamp(floor(fi), 0, segX - 1), j0 = clamp(floor(fj), 0, segZ - 1);
    const xA = sinh(i0.mul(2 / segX).sub(1).mul(cx)).mul(kx).add(ox), xB = sinh(i0.add(1).mul(2 / segX).sub(1).mul(cx)).mul(kx).add(ox);
    const zA = sinh(j0.mul(sz / segZ).sub(1).mul(cz)).mul(kz).add(z0), zB = sinh(j0.add(1).mul(sz / segZ).sub(1).mul(cz)).mul(kz).add(z0);
    const fx = clamp(p.x.sub(xA).div(xB.sub(xA)), 0, 1), fz = clamp(p.y.sub(zA).div(zB.sub(zA)), 0, 1);
    const ii = int(i0), jj = int(j0);
    const a = textureLoad(gridTex, ivec2(ii, jj)), b = textureLoad(gridTex, ivec2(ii.add(1), jj));
    const c = textureLoad(gridTex, ivec2(ii, jj.add(1))), d = textureLoad(gridTex, ivec2(ii.add(1), jj.add(1)));
    const lower = a.add(b.sub(a).mul(fx)).add(c.sub(a).mul(fz));
    const upper = d.add(c.sub(d).mul(fx.oneMinus())).add(b.sub(d).mul(fz.oneMinus()));
    return select(fx.add(fz).lessThanEqual(1), lower, upper);
  });
}

// a blade's strip: x = side (-1, 1), y = 0 at the root .. 1 at the tip
function bladeGeometry(segs) {
  const P = [], I = [];
  for (let s = 0; s <= segs; s++) P.push(-1, s / segs, 0, 1, s / segs, 0);
  for (let s = 0; s < segs; s++) { const a = s * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I);
  g.instanceCount = 0;
  return g;
}

// the grass's colours by tint (0 lush .. 1 straw), shared with the terrain under it
export const grassColor = Fn(([tint, v]) => {
  const lush = vec3(0.06, 0.17, 0.035), fresh = vec3(0.17, 0.33, 0.06), straw = vec3(0.42, 0.4, 0.15);
  const c = mix(lush, fresh, sstep(0.0, 0.4, tint)).toVar();
  c.assign(mix(c, straw, sstep(0.45, 1.0, tint)));
  return c.mul(v);
});

// patches of darker and lighter, lusher and drier grass a metre or a few across (-1..1), the same on the blades and
// on the ground under the far grass
// (from the two noise octaves the terrain's ground detail uses too, so it shares them: patchFrom)
export const patchFrom = (n012, n09) => n012.mul(1.2).add(n09.mul(0.8)).sub(1.0);
export const grassPatch = Fn(([p]) => patchFrom(vnoise(p.mul(0.12)), vnoise(p.mul(0.9))));

// the wind's waves running over the grass (0..1), as on the blades: the terrain under far grass shows them too
export const grassWave = Fn(([p]) => {
  const w = sin(U.uTime.mul(1.9).sub(dot(p, U.uWindDir).mul(0.22)).add(p.x.mul(0.05).sin().mul(1.5))).mul(0.5).add(0.5);
  return w.mul(w);
});

// world -> fine mask texel (R: 1 grass .. 0 none), outside its bounds 1
const fineMask = (maskTex, b) => Fn(([p]) => {
  const uv = p.sub(vec2(b[0], b[1])).mul(vec2(b[2], b[3]));
  const inside = uv.x.greaterThan(0).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
  return select(inside, texture(maskTex, uv).r, float(1));
});

export function makeGrass({ grid, segX, segZ, mask }, tier) {
  const T = GRASS_TIERS[tier];
  const nLev = T.segs.length;
  const gridTex = new THREE.DataTexture(grid, segX + 1, segZ + 1, THREE.RGBAFormat, THREE.FloatType);
  gridTex.minFilter = gridTex.magFilter = THREE.NearestFilter;
  gridTex.needsUpdate = true;
  const maskTex = new THREE.DataTexture(mask.data, mask.W, mask.H, THREE.RedFormat);
  maskTex.minFilter = maskTex.magFilter = THREE.LinearFilter;
  maskTex.unpackAlignment = 1;
  maskTex.needsUpdate = true;
  const ground = terrainSampler(gridTex, segX, segZ), masked = fineMask(maskTex, mask.bounds);

  // levels: cell size, rank range, range, tile cells per side
  const levels = T.segs.map((segs, k) => {
    const cell = T.c0 * 2 ** k, last = k === nLev - 1;
    const range = last ? MAXD : Math.min(MAXD, T.d0 * 2 ** (k + 1));
    const n = Math.ceil(range / (3 * cell));
    return { k, segs, cell, n, tile: n * cell, range, lo: last ? 0 : 4 ** -(k + 1), hi: 4 ** -k };
  });

  const tiles = Array.from({ length: nLev * MAXT }, () => new THREE.Vector4());
  const uTiles = uniformArray(tiles, 'vec4'); // x, z: a visible tile's first cell
  const uDensity = uniform(1); // the quality controller thins the grass
  // per draw: (cell, rank lo, rank hi, cells per tile side), (first tile in uTiles, level, 0, 0)
  const uLevel = uniform(new THREE.Vector4()).onObjectUpdate(({ object }) => object.userData.lv);
  const uLevel2 = uniform(new THREE.Vector4()).onObjectUpdate(({ object }) => object.userData.lv2);

  const vColor = varyingProperty('vec3', 'vGrassColor'), vTip = varyingProperty('float', 'vGrassTip');
  const vWave = varyingProperty('float', 'vGrassWave'), vNormal = varyingProperty('vec3', 'vGrassNormal');
  const vShadow = varyingProperty('vec3', 'vGrassShadowPos');
  const D0 = float(T.d0);

  const position = Fn(() => {
    const nn = uLevel.w.mul(uLevel.w);
    const inst = float(instanceIndex);
    const slot = floor(inst.add(0.5).div(nn)), local = inst.sub(slot.mul(nn));
    const row = floor(local.add(0.5).div(uLevel.w)), col = local.sub(row.mul(uLevel.w));
    const tile = uTiles.element(int(slot.add(uLevel2.x)));
    const cellId = tile.xy.add(vec2(col, row));
    const h = hash44(vec4(cellId, uLevel2.y.mul(17.0), 3.0)), h2 = hash44(vec4(cellId, uLevel2.y.mul(17.0).add(5.0), 11.0));
    const root = cellId.add(h.xy).mul(uLevel.x);
    const g = ground(root).toVar();
    const y0 = g.x;
    const toCam = cameraPosition.xz.sub(root);
    const d = length(vec3(toCam.x, cameraPosition.y.sub(y0), toCam.y)).toVar();
    // kept while the rank is under keep(d); grows in over the last third
    const rank = mix(uLevel.y, uLevel.z, h.z);
    const keep = min(float(1), D0.div(max(d, 1e-3)).pow(2)).mul(g.y).mul(masked(root)).mul(uDensity).mul(sstep(MAXD, MAXD * 0.8, d));
    const grow = clamp(keep.sub(rank).div(rank.mul(0.5).add(1e-5)), 0, 1);
    // blades faded out collapse to a point under the ground (skipping the rest: about half of those drawn)
    const out = vec3(root.x, y0.sub(1.0), root.y).toVar();
    vColor.assign(vec3(0)); vTip.assign(0); vWave.assign(0); vNormal.assign(vec3(0, 1, 0)); vShadow.assign(out);
    If(grow.greaterThan(0), () => {
      // tufts: neighbours share length and lean (low-frequency noise), each blade its own share of that
      const tuft = vnoise(root.mul(1.7)).toVar(), patch = grassPatch(root);
      const len = g.z.mul(mix(0.55, 1.0, tuft)).mul(h2.x.mul(0.5).add(0.75)).mul(1.05).mul(grow);
      const widen = min(pow(max(d.div(D0), 1), 0.85), 6.0);
      const width = h2.y.mul(0.012).add(0.017).mul(T.wide).mul(widen).mul(grow.mul(0.5).add(0.5));
      // facing: random near, turning to face the camera with distance
      const yaw = h.w.mul(6.2832).add(tuft.mul(2.0));
      const side0 = vec2(yaw.cos(), yaw.sin());
      const camSide = normalize(vec2(toCam.y.negate(), toCam.x));
      const side = normalize(mix(side0, camSide.mul(select(dot(side0, camSide).lessThan(0), -1, 1)), sstep(D0, D0.mul(3), d)));
      const fwd = vec2(side.y, side.x.negate());
      const t = positionGeometry.y;
      const lean = h2.z.mul(0.35).add(0.12).add(tuft.mul(0.15));
      const w = width.mul(float(1).sub(pow(t, 1.4))).add(0.002).mul(positionGeometry.x);
      const rest = vec3(root.x.add(side.x.mul(w)).add(fwd.x.mul(lean).mul(t).mul(t).mul(len)), y0.sub(0.03).add(t.mul(len)), root.y.add(side.y.mul(w)).add(fwd.y.mul(lean).mul(t).mul(t).mul(len))).toVar();
      // the face seen, tilted up; far blades (turned to the camera) lit as the ground is, or looking towards the sun
      // they would all show their shaded side
      const face = vec3(fwd.x, 0, fwd.y).mul(select(dot(fwd, toCam).lessThan(0), -1, 1));
      vNormal.assign(normalize(vec3(0, 1, 0).add(face.mul(mix(0.7, 0.08, sstep(D0, D0.mul(2.5), d))))));
      vShadow.assign(rest.add(vNormal.mul(SHADOW_NORMAL_BIAS)));
      // the wind: the trees' sway, and the waves running through the grass (lean down-wind, a little down)
      const flex = pow(t, 1.5).mul(len).mul(0.55);
      const p = rest.add(windOffset(rest, flex, U.uTime)).toVar();
      const wave = grassWave(root);
      p.addAssign(vec3(U.uWindDir.x, -0.35, U.uWindDir.y).mul(flex).mul(U.uWind).mul(wave).mul(0.55));
      vWave.assign(wave.mul(U.uWind));
      vTip.assign(t);
      // colour: by the ground's tint, each blade a little different; dark at the root close by (the sward's shade); far off the root takes the ground's own tone (terrainMaterial),
      // so thinning blades leave no specks
      const shade = mix(mix(0.3, 0.7, sstep(D0, D0.mul(2.5), d)), 1.0, pow(t, 0.8));
      const tint = clamp(g.w.add(h2.w.sub(0.5).mul(0.3)).add(patch.mul(0.12)), 0, 1);
      vColor.assign(grassColor(tint, fract(h.z.mul(7.31)).mul(0.45).add(0.7).mul(patch.mul(0.12).add(1.0))).mul(shade));
      out.assign(p);
    });
    return out;
  })();

  const mat = new LitMaterial({
    roughness: 0.85, metalness: 0, side: THREE.DoubleSide, positionNode: position, receivedShadowPositionNode: vShadow,
    colorNode: vColor, normalNode: transformNormalToView(vNormal).normalize(),
  }, (out) => Fn(() => {
    const vdir = normalize(positionWorld.sub(cameraPosition));
    const back = pow(max(dot(vdir, U.uSunDir), 0.0), 3.0);
    const tip = vTip;
    const o = out.add(vColor.mul(U.uSunColor).mul(U.uSunVis).mul(back.mul(1.6).add(0.15)).mul(clamp(tip.mul(2.2), 0.0, 1.0)));
    // lantern light at half strength: at full, the lawn under the lines read as floodlit
    return o.mul(float(1.0).add(vWave.mul(clamp(tip.mul(2.0), 0.0, 1.0)).mul(0.35))).add(vColor.mul(lanternLight(positionWorld)).mul(0.5));
  })());

  const group = new THREE.Group();
  const meshes = levels.map((L, k) => {
    const mesh = new THREE.Mesh(bladeGeometry(L.segs), mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.layers.set(1);
    mesh.userData.lv = new THREE.Vector4(L.cell, L.lo, L.hi, L.n);
    mesh.userData.lv2 = new THREE.Vector4(k * MAXT, k, 0, 0);
    group.add(mesh);
    return mesh;
  });

  // each frame: the tiles of each level's grid within its range and in view
  const frustum = new THREE.Frustum(), pv = new THREE.Matrix4(), box = new THREE.Box3();
  const cand = [];
  group.userData.update = (camera, all = false) => {
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pv);
    const cam = camera.position;
    levels.forEach((L, k) => {
      const ox = Math.floor(cam.x / L.tile) - SIDE / 2, oz = Math.floor(cam.z / L.tile) - SIDE / 2;
      cand.length = 0;
      for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) {
        const x0 = (ox + i) * L.tile, z0 = (oz + j) * L.tile;
        const dx = Math.max(x0 - cam.x, 0, cam.x - x0 - L.tile), dz = Math.max(z0 - cam.z, 0, cam.z - z0 - L.tile);
        const dd = Math.hypot(dx, dz);
        if (dd > L.range) continue;
        box.min.set(x0, -3, z0); box.max.set(x0 + L.tile, 260, z0 + L.tile);
        if (!all && !frustum.intersectsBox(box)) continue;
        cand.push(dd, (ox + i) * L.n, (oz + j) * L.n);
      }
      // nearest first, in case there are more than MAXT
      const order = [];
      for (let c = 0; c < cand.length; c += 3) order.push(c);
      if (order.length > MAXT) order.sort((a, b) => cand[a] - cand[b]);
      const n = Math.min(MAXT, order.length);
      for (let s = 0; s < n; s++) tiles[k * MAXT + s].set(cand[order[s] + 1], cand[order[s] + 2], 0, 0);
      meshes[k].geometry.instanceCount = n * L.n * L.n;
      meshes[k].visible = n > 0;
    });
  };
  group.userData.setFraction = (f) => { uDensity.value = f; };
  group.userData.levels = levels;
  return group;
}
