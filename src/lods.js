// Instanced Blender models (tools/*.py, built by tools/blender.mjs into src/models/ and inlined in the page) in levels
// of detail: each kind has a full model for instances within ranges[0] metres of the camera, a lighter one
// (`<kind>_far`) beyond, and with a second range a lighter one again (`<kind>_dist`) beyond that; one instanced draw
// per kind and level, the instances re-sorted when the view has changed (makeView: moved STEP metres, or turned). On
// the Ultra tier a far more detailed `<kind>_near` model (public/models/<name>-ultra.glb, fetched on demand) goes in
// front of them for the instances within `nearRange`, so they hold up from a metre or two away.
// The woods' trees (forestData in vegetation.js places them) and the gorge's rock walls (cliffData) are drawn so.
// Each re-sort also culls the instances outside the view (makeView) for the camera's and the river reflection's
// passes; the shadow passes still draw every instance (docs/performance.md, "Frustum culling").
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const HYST = 5, STEP = 4, SUFFIX = ['', '_far', '_dist'];

// One shader build and one render pipeline per material for all its instanced draws (WebGPU). three keeps an
// InstancedMesh's matrices in a uniform array sized to its count and named after its node's id, so every level of
// every kind gets its own vertex shader and pipeline, each compiling the material's fragment shader again (the
// boulders' stone shader 11 times). With the matrices and colours in storage buffers (runtime-sized arrays) under one
// name, a material's instanced draws share one vertex shader and one pipeline: half the pipelines, the largest part of
// start-up (docs/performance.md, Start-up). three still builds the shader's node graph once per InstancedMesh and pass
// (its render-object cache key holds the mesh's uuid, since the build's bindings hold that mesh's buffers: three PR
// 29066), the longest main-thread task of start-up; with every such mesh's buffers in storage the build is the same
// for all of them, so the key leaves the uuid out and each render object's bindings are pointed at its own mesh's
// buffers instead (three recreates a bind group whose attribute changed: Bindings._update).
// Patches three internals (WGSLNodeBuilder.getUniformFromNode, RenderObject.getCacheKey and getBindings, reached
// through the renderer's RenderObjects); should an upgrade change them, each draw keeps its own build and pipeline
// again (slower start-up, the same image). Not on WebGL (no storage buffers) or where vertex shaders cannot read
// storage buffers (WebGPU's compatibility mode).
let storageMatrices = false;
const sharable = (o) => o && o.isInstancedMesh && o.instanceMatrix.isStorageInstancedBufferAttribute === true
  && (!o.instanceColor || o.instanceColor.isStorageInstancedBufferAttribute === true);
export function shareInstancedPipelines(renderer) {
  const B = renderer.backend, L = B.isWebGPUBackend && B.device.limits;
  if (!L || B.compatibilityMode || !((L.maxStorageBuffersInVertexStage ?? L.maxStorageBuffersPerShaderStage) >= 1) || storageMatrices) return;
  storageMatrices = true;
  const P = THREE.WGSLNodeBuilder.prototype, get = P.getUniformFromNode;
  P.getUniformFromNode = function (node, type, stage, name) {
    const u = get.call(this, node, type, stage, name);
    const o = this.object;
    if (type === 'storageBuffer' && o && o.isInstancedMesh) {
      // (the binding wraps the storage node, so the node carries which of the mesh's buffers it reads)
      if (node.value === o.instanceMatrix) { u.name = 'instanceMatrices'; node.instanceBuffer = 'instanceMatrix'; }
      else if (node.value === o.instanceColor) { u.name = 'instanceColors'; node.instanceBuffer = 'instanceColor'; }
    }
    return u;
  };
  // RenderObject is not exported: its prototype is patched when the renderer makes its first one
  const objects = renderer._objects, create = objects.createRenderObject;
  let patched = false;
  objects.createRenderObject = function (...args) {
    const ro = create.apply(this, args);
    if (!patched) {
      patched = true;
      const R = Object.getPrototypeOf(ro), getCacheKey = R.getCacheKey, getBindings = R.getBindings;
      R.getCacheKey = function () {
        const o = this.object;
        if (!sharable(o)) return getCacheKey.call(this);
        this.object = Object.create(o, { uuid: { value: 'instanced' } }); // the mesh, its uuid shared
        try { return getCacheKey.call(this); } finally { this.object = o; }
      };
      R.getBindings = function () {
        const fresh = this._bindings === null, bindings = getBindings.call(this), o = this.object;
        if (!fresh || !sharable(o)) return bindings;
        for (const group of bindings) {
          for (const b of group.bindings) {
            const node = b.isStorageBuffer && !(b.groupNode && b.groupNode.shared) && b.nodeUniform; // the storage node
            const attr = node && node.instanceBuffer && o[node.instanceBuffer];
            if (attr && node.value !== attr) b.nodeUniform = Object.create(node, { value: { value: attr } });
          }
        }
        return bindings;
      };
      if (sharable(ro.object)) ro.initialCacheKey = ro.getCacheKey(); // made before the patch
    }
    return ro;
  };
}

// View culling. The view is rebuilt (its `rev` moves on, and every group re-sorts) when the camera has moved STEP
// metres or turned more than TURN since the last time, or its field of view changed as much. Between rebuilds the
// camera can be up to STEP metres and TURN away from where the planes were built, so the frustum is widened by MARGIN
// on every side and pushed out by STEP: what the camera sees between re-sorts is always inside it, so nothing pops in
// at the edges. Only the four side planes are tested (the near plane is 0.1 m, the far one beyond the valley).
// The levels of detail are still chosen from where the camera was when it last moved STEP metres (`pos`), not where a
// turn re-sorted them, so turning never switches a level, and culled and unculled frames match pixel for pixel.
// A sphere passes if it is inside the frustum or its mirror image in the river's plane is (the reflection's camera is
// the camera mirrored in that plane, so its frustum is the mirror image of the camera's).
const TURN = 5 * Math.PI / 180, MARGIN = 10 * Math.PI / 180, MAX_HALF = 85 * Math.PI / 180;

// camera: the view's camera; it and the cameras added to `cameras` (the river reflection's) draw the culled lists, every
// other camera (the shadow maps') all instances. mirror: an object in the reflecting plane (its world y), or null.
export function makeView(camera, mirror = null) {
  const P = new Float64Array(16); // four planes (nx, ny, nz, d), their normals pointing in
  const q = new THREE.Quaternion(), q0 = new THREE.Quaternion(), mp = new THREE.Vector3(), at = new THREE.Vector3(Infinity, 0, 0);
  let state = -1, hv0 = 0, hh0 = 0, my = 0;
  const inside = (x, y, z, k) => P[0] * x + P[1] * y + P[2] * z + P[3] >= k && P[4] * x + P[5] * y + P[6] * z + P[7] >= k
    && P[8] * x + P[9] * y + P[10] * z + P[11] >= k && P[12] * x + P[13] * y + P[14] * z + P[15] >= k;
  const plane = (o, nx, ny, nz, p) => { P[o] = nx; P[o + 1] = ny; P[o + 2] = nz; P[o + 3] = -(nx * p.x + ny * p.y + nz * p.z); };
  return {
    camera, mirror,
    cameras: new Set([camera]),
    on: true, // culling (setCulling in main.js)
    culling: false, // in force for the current lists
    rev: 0,
    pos: new THREE.Vector3(Infinity, 0, 0), // where the camera was when it last moved STEP metres: the levels' distances
    stats: { sorts: 0, ms: 0 }, // re-sorts and the main thread's time in them (every group)
    // once a frame, after the camera's matrices are updated; all: draw everything (the warm-up builds every pipeline)
    update(all = false) {
      const e = camera.matrixWorld.elements, pos = this.pos;
      const s = this.on && !all ? 1 : 0;
      const hv = Math.atan(Math.tan(camera.fov * Math.PI / 360) / camera.zoom), hh = Math.atan(Math.tan(hv) * camera.aspect);
      q.setFromRotationMatrix(camera.matrixWorld);
      const far = (p) => !((e[12] - p.x) ** 2 + (e[13] - p.y) ** 2 + (e[14] - p.z) ** 2 < STEP * STEP);
      const moved = far(pos);
      if (moved) pos.set(e[12], e[13], e[14]);
      // (the planes are rebuilt where the camera is: `at`)
      let changed = moved || s !== state || far(at);
      if (!changed && s) changed = 2 * Math.acos(Math.min(1, Math.abs(q.dot(q0)))) + Math.max(Math.abs(hv - hv0), Math.abs(hh - hh0)) > TURN;
      if (!changed) return;
      state = s; this.culling = s === 1; this.rev++; this.stats.sorts++;
      at.set(e[12], e[13], e[14]); q0.copy(q); hv0 = hv; hh0 = hh;
      if (mirror) { mirror.getWorldPosition(mp); my = mp.y; }
      // the camera's right, up and forward (its matrix has no scale)
      const rx = e[0], ry = e[1], rz = e[2], ux = e[4], uy = e[5], uz = e[6], fx = -e[8], fy = -e[9], fz = -e[10];
      const av = Math.min(hv + MARGIN, MAX_HALF), ah = Math.min(hh + MARGIN, MAX_HALF);
      const cv = Math.cos(av), sv = Math.sin(av), ch = Math.cos(ah), sh = Math.sin(ah);
      plane(0, fx * sv - ux * cv, fy * sv - uy * cv, fz * sv - uz * cv, at); // top
      plane(4, fx * sv + ux * cv, fy * sv + uy * cv, fz * sv + uz * cv, at); // bottom
      plane(8, fx * sh - rx * ch, fy * sh - ry * ch, fz * sh - rz * ch, at); // right
      plane(12, fx * sh + rx * ch, fy * sh + ry * ch, fz * sh + rz * ch, at); // left
    },
    // a sphere (centre, radius) in view, or in the reflection's view (always, with culling off)
    visible(x, y, z, r) {
      if (!this.culling) return true;
      const k = -(r + STEP);
      return inside(x, y, z, k) || (mirror !== null && inside(x, 2 * my - y, z, k));
    },
  };
}

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
// The group's userData.lod(view) (a makeView, once a frame) re-sorts the instances when the view has changed;
// userData.counts() gives what the view's camera draws: { drawn, of, tris } (instances and impostor cards in view, of
// those it would draw unculled, and their triangles).
export async function makeLods(url, kinds, lists, mat, ranges, { leavesMat = null, impostor = null, castLayer = 3, nearUrl = null, nearRange = 30, lodScale = 1 } = {}) {
  const [gltf, near] = await Promise.all([
    loadModel(url),
    nearUrl && loadModel(nearUrl).catch((e) => { console.warn('near models not loaded:', nearUrl, e.message); return null; }),
  ]);
  const lead = near ? 1 : 0; // levels in front of the full model
  const R = [...(near ? [nearRange] : []), ...ranges.map((r) => r * lodScale)];
  const group = new THREE.Group(), m = new THREE.Matrix4();
  let cur = null; // the view the lists were last built for
  // A level's draw: the instances in view first (`vis` of them, in their lists' order), then the others (to `all`).
  // The view's cameras draw the first `vis`, every other camera (the sun's shadow maps) all of them, so an instance
  // out of view still casts its shadow into view.
  const instanced = (src, material, l) => {
    const n = Math.max(1, l.n);
    const mesh = new THREE.InstancedMesh(src.geometry, material, n);
    if (storageMatrices) mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(mesh.instanceMatrix.array, 16);
    // (in storage, four floats a colour: three would pad a vec3 array to that itself on upload and swap in its own array)
    const cs = storageMatrices ? 4 : 3;
    mesh.instanceColor = new (storageMatrices ? THREE.StorageInstancedBufferAttribute : THREE.InstancedBufferAttribute)(new Float32Array(n * cs), cs);
    mesh.frustumCulled = false; // culled per instance (lod)
    group.add(mesh);
    // every instance's matrix with the node folded in (it holds the quantized positions' scale and offset), so a
    // re-sort only copies
    const M = new Float32Array(l.n * 16);
    for (let i = 0; i < l.n; i++) m.fromArray(l.matrix, i * 16).multiply(src.matrixWorld).toArray(M, i * 16);
    const g = src.geometry;
    const L = {
      mesh, src, M, mat: mesh.instanceMatrix.array, col: mesh.instanceColor.array, cs,
      ids: new Int32Array(n).fill(-1), dirty: false, // which instance each slot holds; a slot written since the upload
      vis: mesh.count, all: mesh.count, f: 0, b: 0, cull: false, tris: (g.index ? g.index.count : g.attributes.position.count) / 3,
    };
    mesh.onBeforeRender = (renderer, scene, camera) => { mesh.count = cur && cur.cameras.has(camera) ? L.vis : L.all; };
    mesh.userData.level = L;
    return L;
  };
  const sets = lists.map((l, k) => {
    const nearSrc = near && near.scene.getObjectByName(kinds[k] + '_near');
    return {
      l,
      first: lead && !nearSrc ? 1 : 0, // the nearest level this kind has
      level: new Uint8Array(l.n),
      shown: new Uint8Array(l.n), // in view at the last re-sort
      lod: [
        ...(near ? [nearSrc ? instanced(nearSrc, mat, l) : null] : []),
        ...[0, ...ranges].map((_, v) => instanced(gltf.scene.getObjectByName(kinds[k] + SUFFIX[v]), mat, l)),
      ],
    };
  });
  for (const [k, set] of sets.entries()) {
    const src = leavesMat && gltf.scene.getObjectByName(kinds[k] + '_leaves');
    if (src) set.leaves = instanced(src, leavesMat, set.l);
  }
  const imp = impostor && impostor.make(gltf);
  if (imp) {
    group.add(imp.mesh);
    for (const set of sets) set.lod.forEach((L, v) => { if (L && v >= impostor.from + lead) L.mesh.layers.set(castLayer); });
  }
  group.userData.impostors = imp;
  // Each instance's bounding sphere (centre, radius): all its kind's levels and leaf cards, in the instance's frame
  // (the models are not moved in their vertex stage); and its impostor card's (impostors.js: a square turned to the
  // camera on the tree's sphere, its half side the sphere's radius times the larger of the xz and y scales)
  const all = new THREE.Sphere(), one = new THREE.Sphere();
  for (const [k, set] of sets.entries()) {
    const { l } = set, e = l.matrix;
    [...set.lod, set.leaves].filter(Boolean).forEach((L, f) => {
      const g = L.src.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      one.copy(g.boundingSphere).applyMatrix4(L.src.matrixWorld);
      if (f) all.union(one); else all.copy(one);
    });
    const S = set.sphere = new Float32Array(l.n * 4), c = all.center;
    for (let i = 0, o = 0; i < l.n; i++, o += 16) {
      const sc = Math.sqrt(Math.max(e[o] * e[o] + e[o + 1] * e[o + 1] + e[o + 2] * e[o + 2], e[o + 4] * e[o + 4] + e[o + 5] * e[o + 5] + e[o + 6] * e[o + 6], e[o + 8] * e[o + 8] + e[o + 9] * e[o + 9] + e[o + 10] * e[o + 10]));
      S[i * 4] = e[o] * c.x + e[o + 4] * c.y + e[o + 8] * c.z + e[o + 12];
      S[i * 4 + 1] = e[o + 1] * c.x + e[o + 5] * c.y + e[o + 9] * c.z + e[o + 13];
      S[i * 4 + 2] = e[o + 2] * c.x + e[o + 6] * c.y + e[o + 10] * c.z + e[o + 14];
      S[i * 4 + 3] = all.radius * sc;
    }
    if (imp) {
      const K = imp.bake.kinds[k], C = K.c, I = set.card = new Float32Array(l.n * 4);
      for (let i = 0, o = 0; i < l.n; i++, o += 16) {
        I[i * 4] = e[o] * C.x + e[o + 8] * C.z + e[o + 12];
        I[i * 4 + 1] = e[o + 5] * C.y + e[o + 13];
        I[i * 4 + 2] = e[o + 2] * C.x + e[o + 10] * C.z + e[o + 14];
        I[i * 4 + 3] = K.r * Math.max(Math.sqrt(e[o] * e[o] + e[o + 2] * e[o + 2]), e[o + 5]) * Math.SQRT2; // (its corners)
      }
    }
  }
  let rev = -1, cards = 0, cardsOf = 0;
  group.userData.lod = (view) => {
    cur = view;
    if (view.rev === rev) return;
    rev = view.rev;
    const t0 = performance.now();
    const cx = view.pos.x, cy = view.pos.y, cz = view.pos.z, mask = view.camera.layers.mask;
    if (imp) imp.reset();
    cards = cardsOf = 0;
    for (const [k, { l, first, level, shown, lod, leaves, sphere: S, card }] of sets.entries()) {
      // (levels only the shadow maps draw are not culled)
      for (const L of lod) if (L) { L.f = L.b = 0; L.cull = view.culling && (L.mesh.layers.mask & mask) !== 0; }
      if (leaves) { leaves.f = leaves.b = 0; leaves.cull = view.culling; }
      // each instance's level and whether it is in view, counted per level
      for (let i = 0, o = 0, s = 0; i < l.n; i++, o += 16, s += 4) {
        const dx = l.matrix[o + 12] - cx, dy = l.matrix[o + 13] - cy, dz = l.matrix[o + 14] - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // the level whose range holds d, kept while d is within HYST of the old level's range
        let v = first;
        while (v < R.length && d > R[v] + (v < level[i] ? -HYST : HYST)) v++;
        level[i] = v;
        const L = lod[v];
        const vis = view.visible(S[s], S[s + 1], S[s + 2], S[s + 3]);
        shown[i] = vis ? 1 : 0;
        if (vis || !L.cull) L.f++; else L.b++;
        if (leaves && v <= lead) { if (vis) leaves.f++; else leaves.b++; }
        if (imp && v >= impostor.from + lead) {
          cardsOf++;
          if (view.visible(card[s], card[s + 1], card[s + 2], card[s + 3])) { imp.add(k, l.matrix, o, l.color, i * 3); cards++; }
        }
      }
      // each level's buffers: the instances in view in their lists' order, then the others
      for (const L of [...lod, leaves]) if (L) { L.vis = L.f; L.all = L.f + L.b; L.b = L.f; L.f = 0; }
      for (let i = 0; i < l.n; i++) {
        const v = level[i], L = lod[v], j = shown[i] || !L.cull ? L.f++ : L.b++;
        put(L, i, j, l.color);
        if (leaves && v <= lead) put(leaves, i, shown[i] ? leaves.f++ : leaves.b++, l.color);
      }
      for (const L of [...lod, leaves]) {
        if (!L) continue;
        L.mesh.count = L.all;
        if (L.dirty) L.mesh.instanceMatrix.needsUpdate = L.mesh.instanceColor.needsUpdate = true;
        L.dirty = false;
      }
    }
    if (imp) imp.commit();
    view.stats.ms += performance.now() - t0;
  };
  group.userData.counts = () => {
    const out = { drawn: cards, of: cardsOf, tris: cards * 2 };
    const mask = cur ? cur.camera.layers.mask : 0;
    for (const { lod, leaves } of sets) {
      for (const L of [...lod, leaves]) {
        if (!L || !(L.mesh.layers.mask & mask)) continue;
        out.drawn += L.vis; out.of += L.all; out.tris += L.vis * L.tris;
      }
    }
    return out;
  };
  return group;
}

// instance i's matrix and colour into slot j of level L's buffers, unless the slot holds it already (a turn changes
// only what is in view: the levels only the shadow maps draw, and the slots before the first change, stay as they are).
// Plain copies: set(subarray) would make a view object per call.
function put(L, i, j, color) {
  if (L.ids[j] === i) return;
  L.ids[j] = i; L.dirty = true;
  const M = L.M, mat = L.mat, col = L.col, a = i * 16, b = j * 16, c = j * L.cs;
  for (let k = 0; k < 16; k++) mat[b + k] = M[a + k];
  col[c] = color[i * 3]; col[c + 1] = color[i * 3 + 1]; col[c + 2] = color[i * 3 + 2];
}

// a model of a glTF as a plain geometry in metres: its quantized attributes decoded to floats, its node's transform
// applied, a plain index
function plainGeometry(gltf, name) {
  const src = gltf.scene.getObjectByName(name), g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'color']) {
    const a = src.geometry.attributes[k], out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) out[i * a.itemSize + j] = a.getComponent(i, j);
    g.setAttribute(k, new THREE.BufferAttribute(out, a.itemSize));
  }
  g.setIndex(Array.from(src.geometry.index.array));
  return g.applyMatrix4(src.matrixWorld);
}
// the vertices of model `name` in `url` as makeMerged draws it (plainGeometry), for the generation jobs: { position, normal }
export async function modelVertices(url, name) {
  const g = plainGeometry(await loadModel(url), name);
  return { position: g.attributes.position.array, normal: g.attributes.normal.array };
}

// a copy's hash (0..1) from its position
const hashCopy = (matrix, i) => {
  const x = Math.sin(matrix[i * 16 + 12] * 12.9898 + matrix[i * 16 + 14] * 78.233 + matrix[i * 16 + 13] * 37.719) * 43758.5453;
  return x - Math.floor(x);
};

// Many copies of one small model as merged meshes, a full one and a far one per group (lists[i]: { matrix, color, n }),
// switched by the camera's distance to the group's middle at `range` times lodScale (with HYST metres of hysteresis).
// For a model of a few dozen triangles in thousands of copies: instanced past 1,024 copies three moves the matrices
// from a uniform buffer to per-instance attributes, which cost ~1.4 ms a frame here for 2,100 stones of 24 triangles
// (WebGL, RTX 2060); merged they cost nothing measurable. Each group's mesh is culled whole against each pass's camera
// by three (frustumCulled), so it keeps its shadow out of view.
// With `stones` (the village's dry-stone walls) every vertex also carries aStone (bytes): x how deep it lies in the
// joints with the copies round it (lists[i].joint: per copy, then vertex of the full model; vegetation.js stoneJoints,
// worked out in the rocks' generation job), y a hash of its copy (0..1), z its copy's course up the wall
// (lists[i].course: 0 the foot, 1 the top), w 1 on the far level (no joints: drawn as the far stone).
export async function makeMerged(url, kind, lists, mat, range, lodScale = 1, { stones = false } = {}) {
  const gltf = await loadModel(url);
  range *= lodScale;
  const models = [plainGeometry(gltf, kind), plainGeometry(gltf, kind + '_far')];
  const group = new THREE.Group(), m = new THREE.Matrix4();
  const sets = lists.filter((l) => l.n > 0).map((l) => {
    const centre = new THREE.Vector3();
    const levels = models.map((base, far) => {
      // (the far level has no joints: its aStone.w flags it, and the material leaves it as the far stone, since a group
      // switches levels by its middle and a far level can be drawn well within the stone detail's reach)
      const parts = [], joint = stones && (far ? new Float32Array(l.n * base.attributes.position.count) : l.joint);
      for (let i = 0; i < l.n; i++) {
        const g = base.clone().applyMatrix4(m.fromArray(l.matrix, i * 16)), c = g.attributes.color;
        const tint = l.color.subarray(i * 3, i * 3 + 3);
        for (let v = 0; v < c.count; v++) c.setXYZ(v, c.getX(v) * tint[0], c.getY(v) * tint[1], c.getZ(v) * tint[2]);
        if (joint) {
          const a = new Uint8Array(c.count * 4), h = Math.round(hashCopy(l.matrix, i) * 255), course = Math.round((l.course ? l.course[i] : 1) * 255);
          for (let v = 0; v < c.count; v++) { a[v * 4] = Math.round(joint[i * c.count + v] * 255); a[v * 4 + 1] = h; a[v * 4 + 2] = course; a[v * 4 + 3] = far ? 255 : 0; }
          g.setAttribute('aStone', new THREE.BufferAttribute(a, 4, true));
        }
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
  // what `camera` draws of it, as makeLods' counts (groups, not stones)
  const fr = new THREE.Frustum(), pm = new THREE.Matrix4();
  group.userData.counts = (camera) => {
    fr.setFromProjectionMatrix(pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem);
    const out = { drawn: 0, of: 0, tris: 0 };
    for (const { levels } of sets) {
      const L = levels.find((x) => x.visible);
      out.of++;
      if (fr.intersectsObject(L)) { out.drawn++; out.tris += L.geometry.index.count / 3; }
    }
    return out;
  };
  return group;
}
