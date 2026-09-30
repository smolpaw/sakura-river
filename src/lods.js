// The woods on the hills: the tree kinds are Blender models (tools/forest.py, built by tools/forest.mjs into
// src/models/forest.glb and inlined in the page) with their shading in the vertex colours; forestData in
// vegetation.js places them. Each kind has a full model for trees within NEAR metres of the camera and a lighter one
// (`<kind>_far`) beyond: two instanced draws per kind, their instances re-sorted when the camera has moved STEP metres.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { FOREST_KINDS } from './vegetation.js';
import forestUrl from './models/forest.glb?url&inline';

const NEAR = 90, HYST = 5, STEP = 4;

export async function makeForest(lists, mat) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(forestUrl);
  gltf.scene.updateMatrixWorld(true);
  const group = new THREE.Group(), m = new THREE.Matrix4();
  const kinds = lists.map((l, k) => ({
    l,
    far: new Uint8Array(l.n),
    lod: [FOREST_KINDS[k], `${FOREST_KINDS[k]}_far`].map((name) => {
      const src = gltf.scene.getObjectByName(name);
      const mesh = new THREE.InstancedMesh(src.geometry, mat, l.n);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(l.n * 3), 3);
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
    for (const { l, far, lod } of kinds) {
      const count = [0, 0];
      for (let i = 0; i < l.n; i++) {
        const o = i * 16, d = Math.hypot(l.matrix[o + 12] - cam.x, l.matrix[o + 13] - cam.y, l.matrix[o + 14] - cam.z);
        far[i] = far[i] ? +(d > NEAR - HYST) : +(d > NEAR + HYST);
        const L = lod[far[i]], j = count[far[i]]++;
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
