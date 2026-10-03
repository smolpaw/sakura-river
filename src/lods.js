// Instanced Blender models (tools/*.py, built by tools/blender.mjs into src/models/ and inlined in the page) in levels
// of detail: each kind has a full model for instances within ranges[0] metres of the camera, a lighter one
// (`<kind>_far`) beyond, and with a second range a lighter one again (`<kind>_dist`) beyond that; one instanced draw
// per kind and level, the instances re-sorted when the camera has moved STEP metres. On the Ultra tier a far more
// detailed `<kind>_near` model (public/models/<name>-ultra.glb, fetched on demand) goes in front of them for the
// instances within `nearRange`, so they hold up from a metre or two away.
// The woods' trees (forestData in vegetation.js places them) and the gorge's rock walls (cliffData) are drawn so.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const HYST = 5, STEP = 4, SUFFIX = ['', '_far', '_dist'];

// each file decoded once, however many draw from it (the boulders, pebbles and walls share rocks.glb; the waterwheel,
// main.js, is in the village's files)
const loads = new Map();
export function loadModel(url) {
  if (!loads.has(url)) {
    loads.set(url, new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url).then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      return gltf;
    }));
  }
  return loads.get(url);
}

// the Ultra tier's near models of tools/<name>.py: a file in public/ fetched on demand, its URL built as audio.js
// builds the sounds' so the page's base path holds (GitHub Pages serves the page under /sakura-river/)
export const ultraUrl = (name) => new URL(`models/${name}-ultra.glb`, document.baseURI).href;

// lists[k]: the instances of kinds[k] ({ matrix, color, n }). Options:
// - leavesMat: a kind's `<kind>_leaves` model (the woods' leaf cards) is drawn with its near and full models' instances;
// - impostor ({ from, make(gltf) -> impostors.js makeImpostors' handle }): trees from level `from` (0: the full model)
//   on are drawn as impostors, and those levels' models only cast into the valley's shadow map (layer `castLayer`);
// - lodScale: every range times this (the Ultra tier's models reach further);
// - nearUrl, nearRange: the near models' file (ultraUrl) and their range in metres (not scaled); a kind the file
//   lacks keeps its full model there, and if the file fails to load the levels are as without it.
export async function makeLods(url, kinds, lists, mat, ranges, { leavesMat = null, impostor = null, castLayer = 3, nearUrl = null, nearRange = 30, lodScale = 1 } = {}) {
  const [gltf, near] = await Promise.all([
    loadModel(url),
    nearUrl && loadModel(nearUrl).catch((e) => { console.warn('near models not loaded:', nearUrl, e.message); return null; }),
  ]);
  const lead = near ? 1 : 0; // levels in front of the full model
  const R = [...(near ? [nearRange] : []), ...ranges.map((r) => r * lodScale)];
  const group = new THREE.Group(), m = new THREE.Matrix4();
  const instanced = (src, material, n) => {
    const mesh = new THREE.InstancedMesh(src.geometry, material, Math.max(1, n));
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
    mesh.frustumCulled = false; // each level's instances change; together they span the valley anyway
    group.add(mesh);
    // the node holds the quantized positions' scale and offset: folded into every instance
    return { mesh, node: src.matrixWorld };
  };
  const sets = lists.map((l, k) => {
    const nearSrc = near && near.scene.getObjectByName(kinds[k] + '_near');
    return {
      l,
      first: lead && !nearSrc ? 1 : 0, // the nearest level this kind has
      level: new Uint8Array(l.n),
      lod: [
        ...(near ? [nearSrc ? instanced(nearSrc, mat, l.n) : null] : []),
        ...[0, ...ranges].map((_, v) => instanced(gltf.scene.getObjectByName(kinds[k] + SUFFIX[v]), mat, l.n)),
      ],
    };
  });
  for (const [k, set] of sets.entries()) {
    const src = leavesMat && gltf.scene.getObjectByName(kinds[k] + '_leaves');
    if (src) set.leaves = instanced(src, leavesMat, set.l.n);
  }
  const imp = impostor && impostor.make(gltf);
  if (imp) {
    group.add(imp.mesh);
    for (const set of sets) set.lod.forEach((L, v) => { if (L && v >= impostor.from + lead) L.mesh.layers.set(castLayer); });
  }
  group.userData.impostors = imp;
  const last = new THREE.Vector3(Infinity, 0, 0);
  group.userData.lod = (cam) => {
    if (cam.distanceToSquared(last) < STEP * STEP) return;
    last.copy(cam);
    if (imp) imp.reset();
    for (const [k, { l, first, level, lod, leaves }] of sets.entries()) {
      const count = lod.map(() => 0);
      let nl = 0;
      for (let i = 0; i < l.n; i++) {
        const o = i * 16, d = Math.hypot(l.matrix[o + 12] - cam.x, l.matrix[o + 13] - cam.y, l.matrix[o + 14] - cam.z);
        // the level whose range holds d, kept while d is within HYST of the old level's range
        let v = first;
        while (v < R.length && d > R[v] + (v < level[i] ? -HYST : HYST)) v++;
        level[i] = v;
        const L = lod[v], j = count[v]++;
        m.fromArray(l.matrix, o).multiply(L.node).toArray(L.mesh.instanceMatrix.array, j * 16);
        L.mesh.instanceColor.array.set(l.color.subarray(i * 3, i * 3 + 3), j * 3);
        if (imp && v >= impostor.from + lead) imp.add(k, l.matrix, o, l.color.subarray(i * 3, i * 3 + 3));
        if (leaves && v <= lead) {
          m.fromArray(l.matrix, o).multiply(leaves.node).toArray(leaves.mesh.instanceMatrix.array, nl * 16);
          leaves.mesh.instanceColor.array.set(l.color.subarray(i * 3, i * 3 + 3), nl++ * 3);
        }
      }
      lod.forEach((L, f) => {
        if (!L) return;
        L.mesh.count = count[f];
        L.mesh.instanceMatrix.needsUpdate = L.mesh.instanceColor.needsUpdate = true;
      });
      if (leaves) {
        leaves.mesh.count = nl;
        leaves.mesh.instanceMatrix.needsUpdate = leaves.mesh.instanceColor.needsUpdate = true;
      }
    }
    if (imp) imp.commit();
  };
  return group;
}

// Many copies of one small model as merged meshes, a full one and a far one per group (lists[i]: { matrix, color, n }),
// switched by the camera's distance to the group's middle at `range` times lodScale (with HYST metres of hysteresis).
// For a model of a few dozen triangles in thousands of copies: instanced past 1,024 copies three moves the matrices
// from a uniform buffer to per-instance attributes, which cost ~1.4 ms a frame here for 2,100 stones of 24 triangles
// (WebGL, RTX 2060); merged they cost nothing measurable.
export async function makeMerged(url, kind, lists, mat, range, lodScale = 1) {
  const gltf = await loadModel(url);
  range *= lodScale;
  const plain = (name) => {
    const src = gltf.scene.getObjectByName(name), g = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'color']) {
      const a = src.geometry.attributes[k], out = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) out[i * a.itemSize + j] = a.getComponent(i, j);
      g.setAttribute(k, new THREE.BufferAttribute(out, a.itemSize));
    }
    g.setIndex(Array.from(src.geometry.index.array));
    return g.applyMatrix4(src.matrixWorld);
  };
  const models = [plain(kind), plain(kind + '_far')];
  const group = new THREE.Group(), m = new THREE.Matrix4();
  const sets = lists.filter((l) => l.n > 0).map((l) => {
    const centre = new THREE.Vector3();
    const levels = models.map((base) => {
      const parts = [];
      for (let i = 0; i < l.n; i++) {
        const g = base.clone().applyMatrix4(m.fromArray(l.matrix, i * 16)), c = g.attributes.color;
        const tint = l.color.subarray(i * 3, i * 3 + 3);
        for (let v = 0; v < c.count; v++) c.setXYZ(v, c.getX(v) * tint[0], c.getY(v) * tint[1], c.getZ(v) * tint[2]);
        parts.push(g);
      }
      const mesh = new THREE.Mesh(mergeGeometries(parts), mat);
      group.add(mesh);
      return mesh;
    });
    for (let i = 0; i < l.n; i++) centre.add(new THREE.Vector3(l.matrix[i * 16 + 12], l.matrix[i * 16 + 13], l.matrix[i * 16 + 14]));
    centre.divideScalar(l.n);
    levels[1].visible = false;
    return { centre, levels, far: false };
  });
  group.userData.lod = (cam) => {
    for (const s of sets) {
      const d = cam.distanceTo(s.centre);
      s.far = s.far ? d > range - HYST : d > range + HYST;
      s.levels[0].visible = !s.far;
      s.levels[1].visible = s.far;
    }
  };
  return group;
}
