// Impostors for the woods' trees beyond the near ones: each tree a card turned to the camera, showing pictures of its
// full model (crown, limbs and leaf cards) baked at start-up from a hemisphere of directions. The pictures hold the
// tree's colour and its normals, not its shading, so the card is lit like the models it stands for: time of day, the
// valley's and the clouds' shadows, the lamps. Four neighbouring views are blended by where the camera stands, each
// one looked up where the card's point projects into it, so turning round a tree morphs it instead of flicking.
//
// Hemisphere views on an octahedral grid (N x N, the horizon on its edge): grid point (i, j) is the direction decoded
// from (i, j) / (N - 1). Per kind an N x N block of S-pixel cells; the kinds in a 3 x 2 atlas. Colour is stored as its
// square root (8 bits keep the dark woods' shades), both atlases premultiplied by coverage (cleared to 0), so mip
// filtering and blending leave no dark fringe: divided back out when drawn.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, uniform, texture, uv, normalize, cross, dot, max, min, abs, floor, clamp, sqrt, length,
  cameraPosition, positionWorld, positionLocal, normalLocal, modelWorldMatrix, instanceIndex, vertexColor, transformNormalToView, varyingProperty, positionGeometry,
} from 'three/tsl';
import { U, LitMaterial } from './tsl.js';
import { sunShadowAt } from './sunshadow.js';
import { forestLight } from './materials.js';

const N = 8, COLS = 3, ROWS = 2;
// grid coordinates (0..N-1 each way) -> view direction, in the shaders
const decodeGrid = (g) => {
  const p = g.div(N - 1).mul(2.0).sub(1.0);
  const qx = p.x.add(p.y).mul(0.5), qz = p.x.sub(p.y).mul(0.5);
  return normalize(vec3(qx, float(1.0).sub(abs(qx)).sub(abs(qz)), qz));
};

// Bake: `models[k]` = [geometry, matrix] parts (the full model and its leaf cards, in the kind's own frame).
export function bakeImpostors(renderer, models, leafAtlas, cell) {
  const W = COLS * N * cell, H = ROWS * N * cell;
  const target = () => {
    const rt = new THREE.RenderTarget(W, H, { depthBuffer: true });
    const t = rt.texture;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.matrixAutoUpdate = false;
    return rt;
  };
  const albedo = target(), normal = target();
  albedo.texture.name = 'ImpostorAlbedo'; normal.texture.name = 'ImpostorNormal';
  // One instanced draw per kind and pass: instance f is view (f mod N, f / N), each vertex placed straight into its
  // view's cell of the atlas (an orthographic projection along the view; the tree's sphere keeps it in the cell), so the
  // 64 views take one render, not 64 (768 renders had cost ~2 s of start-up on WebGPU)
  const uC = uniform(new THREE.Vector4()); // the tree's sphere: middle and radius
  const uCell = uniform(new THREE.Vector2()); // the kind's block in the atlas
  const place = Fn(() => {
    const f = float(instanceIndex), i = f.sub(floor(f.div(N)).mul(N)), j = floor(f.div(N));
    const d = decodeGrid(vec2(i, j)).toVar();
    const x = normalize(vec3(d.z, 0.0, d.x.negate())), y = cross(d, x);
    const o = modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz.sub(uC.xyz).toVar();
    const q = vec2(dot(o, x), dot(o, y)).div(uC.w.mul(2.0)).add(0.5);
    // pixels from the atlas's top left (as viewports are placed), the picture's up at the cell's top
    const px = uCell.x.mul(N).add(i).add(q.x).mul(cell), py = uCell.y.mul(N).add(j).add(float(1.0).sub(q.y)).mul(cell);
    return vec4(px.div(W).mul(2.0).sub(1.0), float(1.0).sub(py.div(H).mul(2.0)), float(0.5).sub(dot(o, d).div(uC.w).mul(0.5)), 1.0);
  })();
  const leafA = texture(leafAtlas, uv());
  const mats = (leaf) => {
    const make = (col) => {
      const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
      m.vertexNode = place;
      m.colorNode = vec4(col, 1.0);
      if (leaf) m.maskNode = leafA.a.greaterThan(0.5);
      return m;
    };
    const rgb = leaf ? leafA.rgb.mul(vertexColor().rgb) : vertexColor().rgb;
    return [make(sqrt(max(rgb, vec3(0.0)))), make(normalize(normalLocal).mul(0.5).add(0.5))];
  };
  const solid = mats(false), leafy = mats(true);
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(); // (unused by the placement)
  const kinds = models.map((parts, k) => {
    const group = new THREE.Group();
    const box = new THREE.Box3();
    for (const { geometry, matrix, leaf } of parts) {
      const g = new THREE.InstancedBufferGeometry().copy(geometry);
      g.instanceCount = N * N;
      const mesh = new THREE.Mesh(g, solid[0]);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(matrix);
      mesh.frustumCulled = false;
      mesh.userData.leaf = leaf;
      group.add(mesh);
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox.clone().applyMatrix4(matrix));
    }
    group.updateMatrixWorld(true);
    // the tree's sphere: the box's middle, the farthest vertex from it, a little to spare
    const c = box.getCenter(new THREE.Vector3()), v = new THREE.Vector3();
    let r = 0;
    for (const m of group.children) {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) r = Math.max(r, v.fromBufferAttribute(p, i).applyMatrix4(m.matrix).distanceTo(c));
    }
    return { group, c, r: r * 1.02, kx: k % COLS, ky: Math.floor(k / COLS) };
  });

  const prev = { target: renderer.getRenderTarget(), auto: renderer.autoClear, color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() };
  renderer.setClearColor(0x000000, 0);
  for (const [pass, rt] of [[0, albedo], [1, normal]]) {
    renderer.setRenderTarget(rt);
    renderer.autoClear = true;
    renderer.clear();
    renderer.autoClear = false;
    for (const K of kinds) {
      for (const m of K.group.children) m.material = m.userData.leaf ? leafy[pass] : solid[pass];
      uC.value.set(K.c.x, K.c.y, K.c.z, K.r);
      uCell.value.set(K.kx, K.ky);
      scene.add(K.group);
      renderer.render(scene, cam);
      scene.remove(K.group);
    }
  }
  renderer.setRenderTarget(prev.target);
  renderer.autoClear = prev.auto;
  renderer.setClearColor(prev.color, prev.alpha);
  for (const m of [...solid, ...leafy]) m.dispose();
  for (const K of kinds) for (const m of K.group.children) m.geometry.dispose();
  return { albedo: albedo.texture, normal: normal.texture, targets: [albedo, normal], kinds, cell, W, H };
}

// The cards: one draw for every kind. `add(k, matrix, offset, tint)` queues a tree (its instance matrix as the woods'
// lists hold it), `commit()` uploads the queue.
export function makeImpostors(bake, capacity, { alphaToCoverage = false } = {}) {
  const { kinds, cell, W, H } = bake;
  // per tree: the linear part's xz terms (m0, m2, m8, m10); position and y scale; the sphere's middle (kind frame) and
  // radius; tint and kind
  const data = new Float32Array(capacity * 16);
  const ib = new THREE.InstancedInterleavedBuffer(data, 16).setUsage(THREE.DynamicDrawUsage);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aLin', new THREE.InterleavedBufferAttribute(ib, 4, 0));
  geo.setAttribute('aPos', new THREE.InterleavedBufferAttribute(ib, 4, 4));
  geo.setAttribute('aSphere', new THREE.InterleavedBufferAttribute(ib, 4, 8));
  geo.setAttribute('aTint', new THREE.InterleavedBufferAttribute(ib, 4, 12));
  geo.instanceCount = 0;

  const lin = attribute('aLin', 'vec4'), pos = attribute('aPos', 'vec4'), sph = attribute('aSphere', 'vec4'), tint = attribute('aTint', 'vec4');
  const vUV01 = varyingProperty('vec4', 'vImpUV01'), vUV23 = varyingProperty('vec4', 'vImpUV23'), vW = varyingProperty('vec4', 'vImpW');
  const vCell = varyingProperty('vec4', 'vImpCell'), vLin = varyingProperty('vec4', 'vImpLin'), vY = varyingProperty('vec2', 'vImpY');
  const vCentre = varyingProperty('vec4', 'vImpCentre');
  // world <-> the kind's frame: x' = m0 x + m8 z, z' = m2 x + m10 z, y' = m5 y
  const toWorld = (o) => vec3(lin.x.mul(o.x).add(lin.z.mul(o.z)), pos.w.mul(o.y), lin.y.mul(o.x).add(lin.w.mul(o.z)));
  const det = lin.x.mul(lin.w).sub(lin.z.mul(lin.y));
  const toKind = (v) => vec3(lin.w.mul(v.x).sub(lin.z.mul(v.z)).div(det), v.y.div(pos.w), lin.y.negate().mul(v.x).add(lin.x.mul(v.z)).div(det));
  const position = Fn(() => {
    const C = pos.xyz.add(toWorld(sph.xyz)).toVar();
    const view = cameraPosition.sub(C).toVar();
    // which views: where the camera stands in the kind's frame, on the hemisphere's grid
    const dk = normalize(toKind(view)).toVar();
    const dh = normalize(vec3(dk.x, max(dk.y, 0.0), dk.z));
    const s = abs(dh.x).add(dh.y).add(abs(dh.z));
    const g = vec2(dh.x.add(dh.z), dh.x.sub(dh.z)).div(s).mul(0.5).add(0.5).mul(N - 1).toVar();
    const g0 = clamp(floor(g), 0.0, N - 2).toVar(), f = clamp(g.sub(g0), 0.0, 1.0).toVar();
    vW.assign(vec4(float(1.0).sub(f.x).mul(float(1.0).sub(f.y)), f.x.mul(float(1.0).sub(f.y)), float(1.0).sub(f.x).mul(f.y), f.x.mul(f.y)));
    const k = tint.w;
    vCell.assign(vec4(g0, k.sub(floor(k.div(COLS)).mul(COLS)), floor(k.div(COLS))));
    // the card, square to the camera, the sphere's size in the world
    const sxz = length(vec2(lin.x, lin.y)), rw = sph.w.mul(max(sxz, pos.w));
    const fwd = normalize(view);
    const right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd)), up = cross(fwd, right);
    const off = right.mul(positionGeometry.x).add(up.mul(positionGeometry.y)).mul(rw).toVar();
    // the card's point in each view: projected along it, as its orthographic picture was taken
    const o = toKind(off).toVar();
    const inView = (di, dj) => {
      const d = decodeGrid(g0.add(vec2(di, dj))).toVar();
      const x = normalize(vec3(d.z, 0.0, d.x.negate())), y = cross(d, x);
      return vec2(dot(o, x), dot(o, y)).div(sph.w.mul(2.0)).add(0.5);
    };
    vUV01.assign(vec4(inView(0, 0), inView(1, 0)));
    vUV23.assign(vec4(inView(0, 1), inView(1, 1)));
    vLin.assign(lin); vY.assign(vec2(pos.w, rw));
    vCentre.assign(vec4(C, 1.0));
    return C.add(off);
  })();

  const lookup = (tex) => {
    const at = (uvF, di, dj) => {
      const c = vec2(vCell.z.mul(N).add(vCell.x).add(di), vCell.w.mul(N).add(vCell.y).add(dj));
      // (three samples a render target top-down, as its viewports are placed: the picture's up is the cell's -v)
      const q = clamp(uvF, 0.5 / cell, 1 - 0.5 / cell);
      const p = c.add(vec2(q.x, float(1.0).sub(q.y))).mul(cell).div(vec2(W, H));
      return texture(tex, p);
    };
    return at(vUV01.xy, 0, 0).mul(vW.x).add(at(vUV01.zw, 1, 0).mul(vW.y)).add(at(vUV23.xy, 0, 1).mul(vW.z)).add(at(vUV23.zw, 1, 1).mul(vW.w));
  };
  const A = lookup(bake.albedo).toVar(), Nn = lookup(bake.normal).toVar();
  const cover = max(A.a, 1e-3);
  const col = A.rgb.div(cover);
  const nk = Nn.rgb.div(max(Nn.a, 1e-3)).mul(2.0).sub(1.0);
  // the kind's normal into the world (the inverse transpose of the xz terms; y by its scale)
  const L = vLin, dt = L.x.mul(L.w).sub(L.z.mul(L.y));
  const nw = normalize(vec3(L.w.mul(nk.x).sub(L.y.mul(nk.z)).div(dt), nk.y.div(vY.x), L.z.negate().mul(nk.x).add(L.x.mul(nk.z)).div(dt)));
  // the sun's shadow out on the crown's surface: the card point pushed out along its normal by most of the radius
  // (on the card itself, standing in the tree's middle, the tree's own hull, which casts into the valley's map, would
  // shade it)
  const shadowAt = positionWorld.add(nw.mul(vY.y.mul(0.75))).add(U.uSunDir.mul(vY.y.mul(0.15)));
  const shadow = sunShadowAt(shadowAt, U.uSunDir); // (one node for the lighting and the blossom's glow)
  const mat = new LitMaterial({
    roughness: 1, metalness: 0, side: THREE.DoubleSide, alphaToCoverage,
    colorNode: vec4(col.mul(col).mul(attribute('aTint', 'vec4').xyz), A.a),
    alphaTestNode: float(0.5),
    normalNode: transformNormalToView(nw).normalize(),
    positionNode: position,
  }, forestLight(shadow));
  mat.sunShadowNode = shadow;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'impostors';

  let n = 0;
  return {
    mesh, bake,
    reset() { n = 0; },
    add(k, m, o, tint) {
      const K = kinds[k], i = n++ * 16;
      data[i] = m[o]; data[i + 1] = m[o + 2]; data[i + 2] = m[o + 8]; data[i + 3] = m[o + 10];
      data[i + 4] = m[o + 12]; data[i + 5] = m[o + 13]; data[i + 6] = m[o + 14]; data[i + 7] = m[o + 5];
      data[i + 8] = K.c.x; data[i + 9] = K.c.y; data[i + 10] = K.c.z; data[i + 11] = K.r;
      data[i + 12] = tint[0]; data[i + 13] = tint[1]; data[i + 14] = tint[2]; data[i + 15] = k;
    },
    commit() { geo.instanceCount = n; ib.needsUpdate = true; },
  };
}
