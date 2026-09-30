// The main tree's flowers near the camera drawn as a modelled flower (tools/cherry.py `flower`, 90 triangles) in place
// of the painted card (8): the flowers are grouped into cells CELL metres across, and the cells within `near` metres of
// the camera go to the model's draw while the rest stay cards (the cards' draw and their depth prepass shrink to
// them; their shadow proxy keeps every flower). Re-sorted when the camera has moved STEP metres; the buffers are only
// rewritten when a cell changes sides.
import * as THREE from 'three/webgpu';

const CELL = 1.5, HYST = 1, STEP = 0.5;

// tree: buildTreeObject's result for the main tree; geo: the flower model's geometry
export function nearBlossoms(tree, geo, mat, near) {
  const { data: d, blossoms: cards, pre, group } = tree, n = d.n;
  // the flowers in cell order (a counting sort), kept as the source both draws are filled from
  const keys = new Map(), cellOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 16, k = `${Math.floor(d.matrix[o + 12] / CELL)},${Math.floor(d.matrix[o + 13] / CELL)},${Math.floor(d.matrix[o + 14] / CELL)}`;
    if (!keys.has(k)) keys.set(k, keys.size);
    cellOf[i] = keys.get(k);
  }
  const cells = Array.from({ length: keys.size }, () => ({ start: 0, count: 0, c: new THREE.Vector3(), near: false }));
  for (let i = 0; i < n; i++) {
    const c = cells[cellOf[i]];
    c.count++;
    c.c.x += d.matrix[i * 16 + 12]; c.c.y += d.matrix[i * 16 + 13]; c.c.z += d.matrix[i * 16 + 14];
  }
  let at = 0;
  for (const c of cells) { c.start = at; at += c.count; c.c.multiplyScalar(1 / c.count); c.fill = c.start; }
  const M = new Float32Array(n * 16), C = new Float32Array(n * 3), A = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const j = cells[cellOf[i]].fill++;
    M.set(d.matrix.subarray(i * 16, i * 16 + 16), j * 16);
    C.set(d.color.subarray(i * 3, i * 3 + 3), j * 3);
    A.set(d.attrs.subarray(i * 6, i * 6 + 6), j * 6);
  }

  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.name = 'blossomModels';
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  const ib = new THREE.InstancedInterleavedBuffer(new Float32Array(n * 6), 6);
  geo.setAttribute('aFlex', new THREE.InterleavedBufferAttribute(ib, 1, 0));
  geo.setAttribute('aAtlas', new THREE.InterleavedBufferAttribute(ib, 2, 1));
  geo.setAttribute('aCanopyN', new THREE.InterleavedBufferAttribute(ib, 3, 3));
  mesh.count = 0;
  mesh.boundingSphere = cards.boundingSphere;
  mesh.castShadow = false; mesh.receiveShadow = cards.receiveShadow;
  group.add(mesh);

  const cardAttrs = cards.geometry.getAttribute('aFlex').data;
  const draws = [
    { m: mesh.instanceMatrix, c: mesh.instanceColor, a: ib },
    { m: cards.instanceMatrix, c: cards.instanceColor, a: cardAttrs },
  ];
  const last = new THREE.Vector3(Infinity, 0, 0), cam = new THREE.Vector3();
  let first = true, nearCount = 0;
  return {
    mesh,
    // warming: the page's warm-up frames, which draw one (zero-sized, never yet filled) flower to build its pipeline
    update(camera, warming) {
      mesh.count = warming ? Math.max(1, nearCount) : nearCount;
      group.worldToLocal(cam.copy(camera));
      if (cam.distanceToSquared(last) < STEP * STEP) return;
      last.copy(cam);
      let changed = first;
      first = false;
      for (const c of cells) {
        const was = c.near;
        c.near = c.c.distanceTo(cam) < near + (was ? HYST : 0);
        changed ||= c.near !== was;
      }
      if (!changed) return;
      const count = [0, 0];
      for (const c of cells) {
        const k = c.near ? 0 : 1, D = draws[k], j = count[k];
        D.m.array.set(M.subarray(c.start * 16, (c.start + c.count) * 16), j * 16);
        D.c.array.set(C.subarray(c.start * 3, (c.start + c.count) * 3), j * 3);
        D.a.array.set(A.subarray(c.start * 6, (c.start + c.count) * 6), j * 6);
        count[k] += c.count;
      }
      mesh.count = nearCount = count[0];
      cards.count = count[1];
      if (pre) pre.count = count[1];
      for (const D of draws) D.m.needsUpdate = D.c.needsUpdate = D.a.needsUpdate = true;
    },
  };
}
