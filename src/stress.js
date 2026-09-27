// Bench-only future-content stress scenario: denser geometry, extra objects with distinct materials, rain.
// Enabled with create(canvas, { stress: { grass, triMul, objects, particles } }). Not part of the shipped look.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';

// split every triangle into n*n (barycentric grid); attributes interpolate linearly, so the surface is unchanged
export function tessellate(geo, triMul) {
  const n = Math.max(1, Math.round(Math.sqrt(triMul)));
  if (n === 1) return geo;
  const idx = geo.index ? geo.index.array : null;
  const triCount = idx ? idx.length / 3 : geo.attributes.position.count / 3;
  const perTri = ((n + 1) * (n + 2)) / 2;
  const names = Object.keys(geo.attributes);
  const src = names.map((k) => geo.attributes[k]);
  const dst = src.map((a) => new Float32Array(triCount * perTri * a.itemSize));
  const index = new Uint32Array(triCount * n * n * 3);
  let v = 0, ii = 0;
  const vid = (i, j) => (i * (2 * n + 3 - i)) / 2 + j; // row i has n+1-i vertices
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const base = v;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const wb = j / n, wc = i / n, wa = 1 - wb - wc;
      for (let k = 0; k < src.length; k++) {
        const s = src[k], d = dst[k], sz = s.itemSize;
        for (let q = 0; q < sz; q++) {
          const ga = s.getComponent ? s.getComponent(a, q) : s.array[a * sz + q];
          const gb = s.getComponent ? s.getComponent(b, q) : s.array[b * sz + q];
          const gc = s.getComponent ? s.getComponent(c, q) : s.array[c * sz + q];
          d[v * sz + q] = ga * wa + gb * wb + gc * wc;
        }
      }
      v++;
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      const p0 = base + vid(i, j), p1 = base + vid(i, j + 1), p2 = base + vid(i + 1, j);
      index[ii++] = p0; index[ii++] = p1; index[ii++] = p2;
      if (j < n - i - 1) { const p3 = base + vid(i + 1, j + 1); index[ii++] = p1; index[ii++] = p3; index[ii++] = p2; }
    }
  }
  const out = new THREE.BufferGeometry();
  names.forEach((k, i) => out.setAttribute(k, new THREE.BufferAttribute(dst[i], src[i].itemSize)));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

// 30 small sculptures around the meadow, each with its own material
export function makeStressObjects(world, count, center, makeMaterial) {
  const rng = mulberry32(31337);
  const group = new THREE.Group();
  const shapes = [
    () => new THREE.TorusKnotGeometry(0.35, 0.11, 128, 16),
    () => new THREE.IcosahedronGeometry(0.45, 4),
    () => new THREE.CylinderGeometry(0.2, 0.32, 1.1, 32, 8),
    () => new THREE.TorusGeometry(0.4, 0.12, 24, 64),
  ];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 0.3, r = 9 + rng() * 14;
    const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
    const y = world.height(x, z);
    if (y < 0.1) continue;
    const mat = makeMaterial(new THREE.Color().setHSL(rng(), 0.35, 0.45), 0.3 + rng() * 0.6, rng() < 0.3 ? 0.6 : 0);
    const m = new THREE.Mesh(shapes[i % shapes.length](), mat);
    m.position.set(x, y + 0.5, z);
    m.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  }
  return group;
}
