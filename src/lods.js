// Instanced Blender models (tools/*.py, built by tools/blender.mjs into src/models/ and inlined in the page) in levels
// of detail: each kind has a full model for instances within ranges[0] metres of the camera, a lighter one
// (`<kind>_far`) beyond, and with a second range a lighter one again (`<kind>_dist`) beyond that; one instanced draw
// per kind and level, the instances re-sorted when the camera has moved STEP metres.
// The woods' trees (forestData in vegetation.js places them) and the gorge's rock walls (cliffData) are drawn so.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const HYST = 5, STEP = 4, SUFFIX = ['', '_far', '_dist'];

// lists[k]: the instances of kinds[k] ({ matrix, color, n }). With `leavesMat`, a kind's `<kind>_leaves` model (the
// woods' leaf cards) is drawn with its full model's instances. With `impostor` ({ from, make(gltf) -> impostors.js
// makeImpostors' handle }), trees from level `from` on are drawn as impostors, and those levels' models only cast
// into the valley's shadow map (layer `castLayer`).
export async function makeLods(url, kinds, lists, mat, ranges, leavesMat = null, impostor = null, castLayer = 3) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const group = new THREE.Group(), m = new THREE.Matrix4();
  const sets = lists.map((l, k) => ({
    l,
    level: new Uint8Array(l.n),
    lod: [0, ...ranges].map((_, v) => {
      const src = gltf.scene.getObjectByName(kinds[k] + SUFFIX[v]);
      const mesh = new THREE.InstancedMesh(src.geometry, mat, Math.max(1, l.n));
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, l.n) * 3), 3);
      mesh.frustumCulled = false; // each level's instances change; together they span the valley anyway
      group.add(mesh);
      // the node holds the quantized positions' scale and offset: folded into every instance
      return { mesh, node: src.matrixWorld };
    }),
  }));
  for (const [k, set] of sets.entries()) {
    const src = leavesMat && gltf.scene.getObjectByName(kinds[k] + '_leaves');
    if (!src) continue;
    const mesh = new THREE.InstancedMesh(src.geometry, leavesMat, Math.max(1, set.l.n));
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, set.l.n) * 3), 3);
    mesh.frustumCulled = false;
    group.add(mesh);
    set.leaves = { mesh, node: src.matrixWorld };
  }
  const imp = impostor && impostor.make(gltf);
  if (imp) {
    group.add(imp.mesh);
    for (const set of sets) set.lod.forEach((L, v) => { if (v >= impostor.from) L.mesh.layers.set(castLayer); });
  }
  group.userData.impostors = imp;
  const last = new THREE.Vector3(Infinity, 0, 0);
  // returns true when the draws changed (a render bundle holding them must be recorded again)
  group.userData.lod = (cam) => {
    if (cam.distanceToSquared(last) < STEP * STEP) return false;
    last.copy(cam);
    if (imp) imp.reset();
    for (const [k, { l, level, lod, leaves }] of sets.entries()) {
      const count = lod.map(() => 0);
      for (let i = 0; i < l.n; i++) {
        const o = i * 16, d = Math.hypot(l.matrix[o + 12] - cam.x, l.matrix[o + 13] - cam.y, l.matrix[o + 14] - cam.z);
        // the level whose range holds d, kept while d is within HYST of the old level's range
        let v = 0;
        while (v < ranges.length && d > ranges[v] + (v < level[i] ? -HYST : HYST)) v++;
        level[i] = v;
        const L = lod[v], j = count[v]++;
        m.fromArray(l.matrix, o).multiply(L.node).toArray(L.mesh.instanceMatrix.array, j * 16);
        L.mesh.instanceColor.array.set(l.color.subarray(i * 3, i * 3 + 3), j * 3);
        if (imp && v >= impostor.from) imp.add(k, l.matrix, o, l.color.subarray(i * 3, i * 3 + 3));
        if (leaves && v === 0) {
          m.fromArray(l.matrix, o).multiply(leaves.node).toArray(leaves.mesh.instanceMatrix.array, j * 16);
          leaves.mesh.instanceColor.array.set(l.color.subarray(i * 3, i * 3 + 3), j * 3);
        }
      }
      lod.forEach(({ mesh }, f) => {
        mesh.count = count[f];
        mesh.instanceMatrix.needsUpdate = mesh.instanceColor.needsUpdate = true;
      });
      if (leaves) {
        leaves.mesh.count = count[0];
        leaves.mesh.instanceMatrix.needsUpdate = leaves.mesh.instanceColor.needsUpdate = true;
      }
    }
    if (imp) imp.commit();
    return true;
  };
  return group;
}

// Many copies of one small model as merged meshes, a full one and a far one per group (lists[i]: { matrix, color, n }),
// switched by the camera's distance to the group's middle (with HYST metres of hysteresis). For a model of a few
// dozen triangles in thousands of copies: instanced past 1,024 copies three moves the matrices from a uniform
// buffer to per-instance attributes, which cost ~1.4 ms a frame here for 2,100 stones of 24 triangles (WebGL,
// RTX 2060); merged they cost nothing measurable.
export async function makeMerged(url, kind, lists, mat, range) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
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
    let changed = false;
    for (const s of sets) {
      const d = cam.distanceTo(s.centre), was = s.far;
      s.far = s.far ? d > range - HYST : d > range + HYST;
      s.levels[0].visible = !s.far;
      s.levels[1].visible = s.far;
      changed ||= was !== s.far;
    }
    return changed;
  };
  return group;
}
