// Japanese set pieces: Fuji-style volcano, stone lantern (kasuga-dōrō), vermilion arched bridge (taiko-bashi), five-storey pagoda
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeNoise, mulberry32, clamp, lerp, smoothstep } from './noise.js';
import { patch, U } from './shaders.js';

const V = THREE.Vector3;

function colorize(g, c) {
  if (g.index) g = g.toNonIndexed();
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
// oriented beam between two points
function beam(a, b, w, h, c, up = new V(0, 1, 0)) {
  const d = new V().subVectors(b, a); const L = d.length();
  const g = new THREE.BoxGeometry(w, h, L);
  const m = new THREE.Matrix4().lookAt(new V(), d, up);
  g.applyMatrix4(m);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return colorize(g, c);
}
function lathe(profile, segs, c, phi = 0) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segs, phi);
  return colorize(g, c);
}
// polygonal roof with concave profile and upturned corners (the signature eave line)
function roof(sides, R, H, upturn, c, phi = Math.PI / 4, thick = 0.12) {
  const P = [], I = [];
  const K = 9, M = 12;
  const corners = [];
  for (let e = 0; e < sides; e++) { const a = phi + (e / sides) * Math.PI * 2; corners.push([Math.cos(a), Math.sin(a)]); }
  let base = 0;
  for (const layer of [0, 1]) {
    for (let e = 0; e < sides; e++) {
      const c0 = corners[e], c1 = corners[(e + 1) % sides];
      for (let k = 0; k <= K; k++) {
        const u = k / K; // 0 rim -> 1 apex
        const r = lerp(1, 0.08, u);
        const y = H * (1 - Math.pow(1 - u, 2.2)) - layer * thick * (1 - u);
        for (let m = 0; m <= M; m++) {
          const t = m / M;
          const px = lerp(c0[0], c1[0], t), pz = lerp(c0[1], c1[1], t);
          const edge = Math.pow(Math.abs(2 * t - 1), 3.5);
          const lift = upturn * edge * Math.pow(1 - u, 3);
          P.push(px * R * r, y + lift, pz * R * r);
        }
      }
      for (let k = 0; k < K; k++) for (let m = 0; m < M; m++) {
        const a = base + k * (M + 1) + m, b = a + 1, cc = a + M + 1, d = cc + 1;
        if (layer === 0) I.push(a, b, cc, b, d, cc); else I.push(a, cc, b, b, cc, d);
      }
      base += (K + 1) * (M + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  return colorize(g, c);
}

const STONE = [0.33, 0.31, 0.29], STONE_D = [0.22, 0.21, 0.2];
const VERM = [0.62, 0.055, 0.02], VERM_D = [0.38, 0.03, 0.012];
const WOOD = [0.16, 0.1, 0.07], ROOF = [0.07, 0.07, 0.075], WALL = [0.8, 0.74, 0.62], BRONZE = [0.42, 0.3, 0.1];

function propMaterial(key, extra = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, ...extra });
  patch(m, {
    key,
    fragColor: key === 'stone' ? `
      float mossP = smoothstep(0.45, 0.9, normalize(vNormalW).y + 0.35 * vnoise(vFogWorld.xz * 6.0 + vFogWorld.y * 3.0));
      diffuseColor.rgb = mix(diffuseColor.rgb * (0.8 + 0.4 * vnoise(vFogWorld.xz * 11.0 + vFogWorld.y * 9.0)), vec3(0.1, 0.19, 0.04), mossP * 0.85);` : `
      diffuseColor.rgb *= 0.88 + 0.24 * vnoise(vFogWorld.xz * 4.0 + vFogWorld.y * 6.0);`,
    varyings: 'varying vec3 vNormalW;',
    vertEnd: 'vNormalW = normalize(mat3(modelMatrix) * objectNormal);',
    noFlip: false,
  });
  return m;
}

// ---------------- stone lantern ----------------
export function lanternGeometry() {
  const parts = [];
  const hexR = (r) => r / Math.cos(Math.PI / 6);
  parts.push(lathe([[0, 0], [hexR(0.5), 0], [hexR(0.46), 0.1], [hexR(0.3), 0.26], [hexR(0.2), 0.3], [0, 0.3]], 6, STONE_D, Math.PI / 6)); // kiso
  parts.push(lathe([[0, 0.28], [0.15, 0.28], [0.13, 0.62], [0.16, 0.66], [0.16, 0.72], [0.13, 0.76], [0.12, 1.12], [0, 1.12]], 20, STONE)); // sao
  parts.push(lathe([[0, 1.08], [hexR(0.16), 1.08], [hexR(0.36), 1.22], [hexR(0.38), 1.3], [0, 1.3]], 6, STONE, Math.PI / 6)); // chudai
  // hibukuro: six posts
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k / 6) * Math.PI * 2;
    const r = 0.25;
    parts.push(beam(new V(Math.cos(a) * r, 1.3, Math.sin(a) * r), new V(Math.cos(a) * r, 1.74, Math.sin(a) * r), 0.07, 0.07, STONE));
  }
  parts.push(lathe([[0, 1.72], [hexR(0.3), 1.72], [hexR(0.3), 1.78], [0, 1.78]], 6, STONE, Math.PI / 6));
  parts.push(roof(6, 0.72, 0.36, 0.1, STONE, Math.PI / 6, 0.09).translate(0, 1.78, 0)); // kasa
  parts.push(lathe([[0, 2.1], [0.1, 2.1], [0.13, 2.17], [0.1, 2.24], [0.05, 2.3], [0, 2.34]], 16, STONE)); // hoju
  return mergeGeometries(parts);
}

export function makeLantern(world, g, x, z, rot = 0) {
  const mesh = new THREE.Mesh(g, propMaterial('stone'));
  mesh.castShadow = true; mesh.receiveShadow = true;
  // glowing paper core
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.4, 6, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.62, 0.3) }));
  core.position.y = 1.52;
  const glowMat = core.material;
  const light = new THREE.PointLight(0xffa860, 0, 14, 1.6);
  light.position.y = 1.55;
  const group = new THREE.Group();
  group.add(mesh, core, light);
  const y = world.height(x, z);
  group.position.set(x, y - 0.08, z);
  group.rotation.y = rot;
  return {
    group,
    update(sunVis) {
      const k = 1 - smoothstep(0.15, 0.95, sunVis) * 0.8;
      glowMat.color.setRGB(1.0, 0.55, 0.22).multiplyScalar(0.6 + 4.5 * k);
      light.intensity = 0.4 + 5 * k;
    },
  };
}

// ---------------- vermilion arched bridge ----------------
export function bridgeData(world, zc) {
  const rx = world.riverX(zc), hw = world.riverHW(zc);
  const [fx, fz] = world.flowDir(zc);
  const across = new V(fz, 0, -fx).normalize(); // perpendicular to flow
  const along = new V(fx, 0, fz);
  const half = hw * 1.45;
  const center = new V(rx, 0, zc);
  const endY = Math.max(world.height(center.x + across.x * half, center.z + across.z * half), world.height(center.x - across.x * half, center.z - across.z * half), 0.6) + 0.15;
  const rise = 2.6;
  const width = 2.4;
  const N = 36;
  const parts = [];
  const pt = (u, side = 0, dy = 0) => {
    const s = (u * 2 - 1) * half;
    const arch = rise * (1 - Math.pow(Math.abs(u * 2 - 1), 2.1));
    return center.clone().addScaledVector(across, s).addScaledVector(along, side).add(new V(0, endY + arch + dy, 0));
  };
  // deck planks (alternating tones) + vermilion side beams
  for (let i = 0; i < N; i++) {
    const u0 = i / N, u1 = (i + 1) / N;
    const tone = i % 2 ? [0.2, 0.13, 0.09] : [0.17, 0.11, 0.075];
    parts.push(beam(pt(u0, 0), pt(u1, 0), width, 0.14, tone));
    for (const sd of [-1, 1]) parts.push(beam(pt(u0, sd * width * 0.52, -0.16), pt(u1, sd * width * 0.52, -0.16), 0.16, 0.34, VERM));
  }
  // railings: posts with giboshi caps, two rails following the arch
  const posts = 9;
  for (const sd of [-1, 1]) {
    const off = sd * width * 0.5;
    for (let k = 0; k <= posts; k++) {
      const u = k / posts;
      const b = pt(u, off, 0.02), t = pt(u, off, 1.0);
      parts.push(beam(b, t, 0.13, 0.13, VERM));
      if (k === 0 || k === posts || k === Math.floor(posts / 2)) {
        const cap = lathe([[0, 0], [0.09, 0], [0.11, 0.06], [0.1, 0.14], [0.06, 0.2], [0.01, 0.3], [0, 0.32]], 14, BRONZE);
        cap.translate(t.x, t.y, t.z);
        parts.push(cap);
      }
    }
    for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N;
      parts.push(beam(pt(u0, off, 0.95), pt(u1, off, 0.95), 0.11, 0.09, VERM));
      parts.push(beam(pt(u0, off, 0.45), pt(u1, off, 0.45), 0.07, 0.06, VERM));
    }
  }
  // piers in the water
  for (const u of [0.3, 0.5, 0.7]) {
    for (const sd of [-1, 1]) {
      const top = pt(u, sd * width * 0.42, -0.25);
      const bot = top.clone(); bot.y = -1.8;
      parts.push(beam(bot, top, 0.22, 0.22, VERM_D));
    }
    parts.push(beam(pt(u, -width * 0.5, -0.9 - (1 - Math.abs(u - 0.5)) * 0.2), pt(u, width * 0.5, -0.9 - (1 - Math.abs(u - 0.5)) * 0.2), 0.14, 0.14, VERM_D, across));
  }
  return { geo: mergeGeometries(parts), center: center.toArray(), half, across: across.toArray(), endY, rise };
}

export function makeBridge(d) {
  const mesh = new THREE.Mesh(d.geo, propMaterial('wood', { roughness: 0.55 }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  return { mesh, center: new V().fromArray(d.center), half: d.half, across: new V().fromArray(d.across), endY: d.endY, rise: d.rise };
}

// ---------------- five-storey pagoda ----------------
export function pagodaGeometry() {
  const parts = [];
  let y = 0;
  const base = 7.2;
  parts.push(lathe([[0, -3], [base * 0.95, -3], [base * 0.95, 0.9], [base * 0.8, 1.1], [0, 1.1]], 4, STONE, Math.PI / 4));
  y = 1.1;
  for (let i = 0; i < 5; i++) {
    const w = base * (0.62 - i * 0.07);
    const h = i === 0 ? 3.4 : 2.6;
    // walls + vermilion corner pillars
    parts.push(lathe([[0, y], [w * 0.98, y], [w * 0.98, y + h], [0, y + h]], 4, WALL, Math.PI / 4));
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k / 4) * Math.PI * 2;
      const r = w * 1.0;
      parts.push(beam(new V(Math.cos(a) * r, y, Math.sin(a) * r), new V(Math.cos(a) * r, y + h, Math.sin(a) * r), 0.45, 0.45, VERM));
    }
    // vermilion band + bracket block under eaves
    parts.push(lathe([[0, y + h - 0.6], [w * 1.08, y + h - 0.6], [w * 1.2, y + h], [0, y + h]], 4, VERM, Math.PI / 4));
    const R = w * 1.75 + 1.4;
    parts.push(roof(4, R, 1.6, 0.9, ROOF, Math.PI / 4, 0.3).translate(0, y + h, 0));
    y += h + 0.9;
  }
  // sorin spire
  const spire = [[0, y], [0.5, y], [0.4, y + 0.6], [0.18, y + 0.8]];
  for (let k = 0; k < 9; k++) { const yy = y + 0.9 + k * 0.55; spire.push([0.18, yy], [0.42, yy + 0.08], [0.42, yy + 0.18], [0.18, yy + 0.26]); }
  spire.push([0.14, y + 6.2], [0.3, y + 6.5], [0.2, y + 7.0], [0, y + 7.4]);
  parts.push(lathe(spire, 12, BRONZE));
  return mergeGeometries(parts);
}

export function makePagoda(world, g, x, z, scale = 1) {
  const mesh = new THREE.Mesh(g, propMaterial('pagoda', { roughness: 0.7 }));
  mesh.scale.setScalar(scale);
  mesh.position.set(x, world.height(x, z) - 0.3, z);
  mesh.rotation.y = 0.35;
  mesh.castShadow = false; mesh.receiveShadow = false;
  return mesh;
}

// ---------------- Fuji-style stratovolcano (own radial mesh for crisp snow streaks) ----------------
export function fujiGeometry(cx, cz, R = 1850, H = 700, baseY = 40) {
  const nz = makeNoise(4242);
  const rings = 110, segs = 300;
  const P = [], C = [], I = [];
  const snow = [0.93, 0.95, 1.0], rock = [0.16, 0.13, 0.15], rockL = [0.24, 0.2, 0.2], forest = [0.05, 0.09, 0.05];
  const hAt = (r, a) => {
    const u = r / R;
    if (u >= 1) return -60 * (u - 1) * 10;
    let h = H * Math.pow(1 - u, 1.75);
    // truncated summit crater rim
    const top = H * 0.935;
    if (h > top) h = top + (h - top) * 0.15 - 3 * smoothstep(0.0, 0.03, 0.03 - u);
    // radial gullies (erosion), stronger mid-slope
    const g = Math.abs(nz.noise2(a * 11, u * 3)) + 0.5 * Math.abs(nz.noise2(a * 29 + 5, u * 7));
    h -= H * 0.035 * g * Math.sin(Math.PI * clamp(u * 1.4, 0, 1));
    h += 14 * nz.noise2(a * 3, u * 5) * u;
    return h;
  };
  for (let i = 0; i <= rings; i++) {
    const u = Math.pow(i / rings, 1.35) * 1.08;
    const r = u * R;
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const rr = r * (1 + 0.04 * nz.noise2(Math.cos(a) * 2, Math.sin(a) * 2) * u);
      const h = hAt(r, a);
      P.push(cx + Math.cos(a) * rr, baseY + h, cz + Math.sin(a) * rr * 0.92);
      // snow: streaky fingers running down the gullies
      const g = Math.abs(nz.noise2(a * 11, u * 3));
      const line = 0.5 + 0.13 * nz.noise2(a * 7, 1.3) + 0.09 * nz.noise2(a * 23, 7.7) - 0.18 * (1 - smoothstep(0.0, 0.35, g));
      const hf = h / H;
      const sn = smoothstep(line - 0.02, line + 0.05, hf);
      let c = lerp3(forest, rock, smoothstep(0.08, 0.3, hf));
      c = lerp3(c, rockL, smoothstep(0.35, 0.6, hf) * 0.5);
      c = lerp3(c, snow, sn);
      C.push(...c);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = i * (segs + 1) + j, b = a + 1, c = a + segs + 1, d = c + 1;
    I.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}

export function makeFuji(g) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  patch(mat, {
    key: 'fuji',
    fragColor: 'diffuseColor.rgb *= 0.9 + 0.2 * vnoise(vFogWorld.xz * 0.05);',
    // snow picks up sky light (cool) and alpenglow
    fragLight: `
      float snowAmt = smoothstep(0.6, 0.85, diffuseColor.b);
      outgoingLight += diffuseColor.rgb * uSkyAmb * snowAmt * 0.35;
      outgoingLight += diffuseColor.rgb * uSunColor * uSunVis * snowAmt * 0.18 * pow(max(dot(normal, normalize((viewMatrix * vec4(uSunDirV, 0.0)).xyz)), 0.0), 0.6);`,
    fragPars: 'uniform vec3 uSunDirV;',
    uniforms: { uSunDirV: U.uSunDir },
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return mesh;
}
function lerp3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
