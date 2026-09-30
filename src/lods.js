// Instanced Blender models (tools/*.py, built by tools/blender.mjs into src/models/ and inlined in the page) in levels
// of detail: each kind has a full model for instances within ranges[0] metres of the camera, a lighter one
// (`<kind>_far`) beyond, and with a second range a lighter one again (`<kind>_dist`) beyond that; one instanced draw
// per kind and level, the instances re-sorted when the camera has moved STEP metres.
// The woods' trees (forestData in vegetation.js places them) and the gorge's rock walls (cliffData) are drawn so.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const HYST = 5, STEP = 4, SUFFIX = ['', '_far', '_dist'];

// lists[k]: the instances of kinds[k] ({ matrix, color, n })
export async function makeLods(url, kinds, lists, mat, ranges) {
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
  const last = new THREE.Vector3(Infinity, 0, 0);
  group.userData.lod = (cam) => {
    if (cam.distanceToSquared(last) < STEP * STEP) return;
    last.copy(cam);
    for (const { l, level, lod } of sets) {
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
      }
      lod.forEach(({ mesh }, f) => {
        mesh.count = count[f];
        mesh.instanceMatrix.needsUpdate = mesh.instanceColor.needsUpdate = true;
      });
    }
  };
  return group;
}
