// Bench-only future-content stress scenario: denser geometry, extra objects with distinct materials, rain.
// Enabled with create(canvas, { stress: { grass, triMul, objects, particles } }). Not part of the shipped look.
import * as THREE from 'three';
import { mulberry32 } from './noise.js';
import { patch, U, GLSL_FOG_PARS } from './shaders.js';

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

export function tessellateTree(root, triMul) {
  root.traverse((o) => { if (o.isMesh && !o.userData.noStress) o.geometry = tessellate(o.geometry, triMul); });
}

// 30 small sculptures around the meadow, each with its own material
export function makeStressObjects(world, count, center) {
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
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(rng(), 0.35, 0.45), roughness: 0.3 + rng() * 0.6, metalness: rng() < 0.3 ? 0.6 : 0 });
    patch(mat, { key: 'stress-obj' });
    const m = new THREE.Mesh(shapes[i % shapes.length](), mat);
    m.position.set(x, y + 0.5, z);
    m.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  }
  return group;
}

// rain placeholder: instanced streaks animated entirely in the vertex shader, in a box that follows the camera
export function makeRain(count) {
  const rng = mulberry32(99);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) seed[i] = rng();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  geo.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.uTime, uWind: U.uWind, uWindDir: U.uWindDir, uSunColor: U.uSunColor, uSkyAmb: U.uSkyAmb, uSunDir: U.uSunDir,
      uFogColor: U.uFogColor, uFogSunColor: U.uFogSunColor, uFogDensity: U.uFogDensity, uFogBase: U.uFogBase, uFogFalloff: U.uFogFalloff,
    },
    transparent: true, depthWrite: false,
    vertexShader: /* glsl */`
      attribute vec4 aSeed; uniform float uTime, uWind; uniform vec2 uWindDir;
      varying vec3 vW; varying float vA;
      const vec3 BOX = vec3(60.0, 30.0, 60.0);
      void main(){
        vec3 p = aSeed.xyz * BOX;
        p.y -= uTime * (9.0 + aSeed.w * 3.0);
        p.xz += uWindDir * uWind * uTime * 2.0;
        vec3 c = cameraPosition - BOX * 0.5;
        p = c + mod(p - c, BOX);
        vec3 fall = normalize(vec3(uWindDir.x * uWind * 0.2, -1.0, uWindDir.y * uWind * 0.2));
        vec3 side = normalize(cross(fall, normalize(cameraPosition - p)));
        vec3 w = p + side * position.x * 0.012 + fall * position.y * 0.55;
        vW = w; vA = 0.18 + 0.12 * aSeed.w;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunColor, uSkyAmb; varying vec3 vW; varying float vA;
      ${GLSL_FOG_PARS}
      void main(){ vec3 c = applyFog(uSkyAmb * 1.2 + uSunColor * 0.15, vW); gl_FragColor = vec4(c, vA); }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.layers.set(1);
  return mesh;
}
