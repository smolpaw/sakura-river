// Instanced Blender models (tools/*.py, built by tools/blender.mjs into src/models/ and inlined in the page) in two
// levels of detail: each kind has a full model for instances within `near` metres of the camera and a lighter one
// (`<kind>_far`) beyond, two instanced draws per kind, the instances re-sorted when the camera has moved STEP metres.
// The woods' trees (forestData in vegetation.js places them) and the gorge's rock walls (cliffData) are drawn so.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const HYST = 5, STEP = 4;

// lists[k]: the instances of kinds[k] ({ matrix, color, n })
export async function makeLods(url, kinds, lists, mat, near) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const group = new THREE.Group(), m = new THREE.Matrix4();
  const sets = lists.map((l, k) => ({
    l,
    far: new Uint8Array(l.n),
    lod: [kinds[k], `${kinds[k]}_far`].map((name) => {
      const src = gltf.scene.getObjectByName(name);
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
    for (const { l, far, lod } of sets) {
      const count = [0, 0];
      for (let i = 0; i < l.n; i++) {
        const o = i * 16, d = Math.hypot(l.matrix[o + 12] - cam.x, l.matrix[o + 13] - cam.y, l.matrix[o + 14] - cam.z);
        far[i] = far[i] ? +(d > near - HYST) : +(d > near + HYST);
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
