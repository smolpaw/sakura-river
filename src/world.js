// Landscape: height field, river path, terrain mesh, river ribbon, water depth map
import * as THREE from 'three';
import { makeNoise, smoothstep, clamp, lerp } from './noise.js';

export function createWorld(seed = 7) {
  const N = makeNoise(seed);
  const N2 = makeNoise(seed * 3 + 11);

  const riverX = (z) => 8.5 * Math.sin(z * 0.021 + 0.9) + 20 * Math.sin(z * 0.0072 - 0.35) + 3.5 * Math.sin(z * 0.047 + 2.2) - 4;
  const riverHW = (z) => lerp(7.6, 3.4, smoothstep(20, -520, z));
  const valleyW = (z) => 48 + 0.16 * Math.max(0, -z);

  // main mountain peak sits at the river's source
  const peakZ = -3100, peakX = 560, fujiR = 1950;
  const pagoda = { x: 38, z: -300 };

  function meadow(x, z) {
    return 1.05 + 0.85 * N.fbm2(x * 0.012, z * 0.012, 4) + 0.22 * N.fbm2(x * 0.07 + 11, z * 0.07, 3) + 0.05 * N.noise2(x * 0.6, z * 0.6);
  }

  function mountains(x, z) {
    const m = smoothstep(-650, -1500, z);
    if (m <= 0) return 0;
    const broad = 0.5 + 0.5 * N2.fbm2(x * 0.0006 + 1.3, z * 0.0006 - 0.7, 5);
    const r = N2.ridged2(x * 0.0012 + 3.1, z * 0.0012 - 1.7, 6);
    let h = 210 * broad * broad + 140 * r * (0.3 + broad);
    // keep the ranges low where the volcano stands so its silhouette stays clean
    const df = Math.hypot(x - peakX, (z - peakZ) / 0.92) / fujiR;
    h *= 0.25 + 0.75 * smoothstep(0.55, 1.25, df);
    return h * m;
  }

  // returns ground height (river bed below 0, water level is y = 0)
  function height(x, z) {
    const rx = riverX(z), hw = riverHW(z);
    const d = Math.abs(x - rx);
    const vw = valleyW(z);
    const far = smoothstep(-60, -500, z);
    let g = meadow(x, z);
    // valley walls / rolling hills
    const wall = smoothstep(vw * 0.45, vw * 1.9, d);
    const hillN = 0.5 + 0.5 * N.fbm2(x * 0.006 + 5, z * 0.006 - 2, 5);
    g += wall * (10 + 38 * hillN) * (0.55 + 2.2 * far);
    // background hills behind the camera side too (keeps horizon closed)
    g += smoothstep(90, 260, z) * 30 * hillN;
    // far mountains, carved by the river valley
    const carve = lerp(smoothstep(hw * 3, hw * 3 + 160 + 0.35 * Math.max(0, -z - 600), d), 1, smoothstep(-1000, -1700, z));
    const mv = mountains(x, z) * carve;
    g += mv;
    // knoll for the pagoda
    const pdx = x - pagoda.x, pdz = z - pagoda.z;
    g += 16 * Math.exp(-(pdx * pdx + pdz * pdz) / (2 * 38 * 38));
    // river channel
    const t = d / hw;
    const bank = smoothstep(0.74, 1.22, t);
    const bed = -1.75 * (1 - 0.65 * t * t) + 0.28 * N.fbm2(x * 0.25, z * 0.25, 3);
    return lerp(bed, g, bank);
  }

  function riverInfo(x, z) {
    const rx = riverX(z), hw = riverHW(z);
    return { rx, hw, d: x - rx, t: Math.abs(x - rx) / hw };
  }

  // flow direction (downstream = +z)
  function flowDir(z) {
    const dx = riverX(z + 0.5) - riverX(z - 0.5);
    const l = Math.hypot(dx, 1);
    return [dx / l, 1 / l];
  }

  // ---------- terrain mesh (non uniform grid: dense near the scene, sparse far) ----------
  function buildTerrain(segX, segZ) {
    const kx = 16, cx = 5.86; // x = kx*sinh(cx*s)
    const kz = 18, cz = 6.2, z0 = 4;
    const sMaxZ = Math.asinh(260 / kz) / cz;
    const xs = new Float32Array(segX + 1), zs = new Float32Array(segZ + 1);
    for (let i = 0; i <= segX; i++) { const s = -1 + (2 * i) / segX; xs[i] = kx * Math.sinh(cx * s) - 2; }
    for (let j = 0; j <= segZ; j++) { const s = -1 + ((sMaxZ + 1) * j) / segZ; zs[j] = z0 + kz * Math.sinh(cz * s); }
    const nv = (segX + 1) * (segZ + 1);
    const pos = new Float32Array(nv * 3);
    let k = 0;
    for (let j = 0; j <= segZ; j++) for (let i = 0; i <= segX; i++) {
      const x = xs[i], z = zs[j];
      pos[k++] = x; pos[k++] = height(x, z); pos[k++] = z;
    }
    const idx = new Uint32Array(segX * segZ * 6);
    k = 0;
    for (let j = 0; j < segZ; j++) for (let i = 0; i < segX; i++) {
      const a = j * (segX + 1) + i, b = a + 1, c = a + segX + 1, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    // vertex colours
    const nrm = geo.attributes.normal.array;
    const col = new Float32Array(nv * 3);
    const c = new THREE.Color();
    const grassA = new THREE.Color(0.20, 0.34, 0.075), grassB = new THREE.Color(0.34, 0.44, 0.10), grassDry = new THREE.Color(0.45, 0.45, 0.18);
    const moss = new THREE.Color(0.13, 0.24, 0.06), mud = new THREE.Color(0.19, 0.15, 0.10), sand = new THREE.Color(0.36, 0.31, 0.23);
    const bedDeep = new THREE.Color(0.13, 0.13, 0.10), rock = new THREE.Color(0.27, 0.25, 0.25), rockDark = new THREE.Color(0.13, 0.12, 0.13);
    const forest = new THREE.Color(0.07, 0.13, 0.05), snow = new THREE.Color(0.92, 0.94, 0.98), alpine = new THREE.Color(0.20, 0.22, 0.12);
    const tmp = new THREE.Color();
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const ny = nrm[v * 3 + 1];
      const ri = riverInfo(x, z);
      const n1 = N.fbm2(x * 0.05, z * 0.05, 3), n2 = N.noise2(x * 0.3 + 7, z * 0.3);
      // grass
      c.copy(grassA).lerp(grassB, clamp(0.5 + 0.9 * n1, 0, 1));
      c.lerp(grassDry, clamp(N.noise2(x * 0.02 - 4, z * 0.02) * 0.6 - 0.05, 0, 0.45));
      // bank: moss & mud
      const bankT = smoothstep(1.45, 1.0, ri.t);
      tmp.copy(moss).lerp(mud, clamp(0.5 + n2, 0, 1));
      c.lerp(tmp, bankT * 0.9);
      // shore sand / pebbles
      if (y < 0.35) { c.lerp(sand, smoothstep(0.35, 0.05, y) * 0.85); }
      if (y < 0) { c.lerp(bedDeep, smoothstep(0, -1.4, y)); }
      // steep = rock
      const steep = smoothstep(0.82, 0.6, ny);
      tmp.copy(rock).lerp(rockDark, clamp(0.5 + n2, 0, 1));
      c.lerp(tmp, steep);
      // far hills: forest tone
      const hillT = smoothstep(4, 22, y) * smoothstep(-40, -200, z) + smoothstep(8, 20, y) * smoothstep(60, 140, z);
      c.lerp(forest, clamp(hillT, 0, 1) * 0.75 * (1 - steep * 0.6));
      // mountains: alpine -> rock -> snow
      if (y > 90) {
        c.lerp(alpine, smoothstep(90, 170, y) * (1 - steep));
        c.lerp(tmp, smoothstep(150, 260, y) * 0.85);
        const snowLine = 300 + 50 * N2.noise2(x * 0.006, z * 0.006);
        const s = smoothstep(snowLine, snowLine + 80, y) * smoothstep(0.12, 0.42, ny + 0.18 * N2.noise2(x * 0.02, z * 0.02));
        c.lerp(snow, clamp(s + smoothstep(480, 600, y) * 0.8, 0, 1));
      }
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    return geo;
  }

  // ---------- river ribbon: follows the meandering centreline ----------
  function buildRiver(stepNear = 0.6) {
    const zs = [];
    let z = 190;
    while (z > -980) { zs.push(z); const dist = Math.abs(z - 10); z -= stepNear + dist * 0.012; }
    const across = 10;
    const pos = [], uv = [], riv = [], idx = [];
    let along = 0, prev = null;
    for (let i = 0; i < zs.length; i++) {
      const zz = zs[i], cxv = riverX(zz), hw = riverHW(zz) * 1.32;
      if (prev) along += Math.hypot(cxv - prev[0], zz - prev[1]);
      prev = [cxv, zz];
      const [fx, fz] = flowDir(zz);
      const nx = fz, nz = -fx; // perpendicular
      for (let a = 0; a <= across; a++) {
        const u = a / across, o = (u * 2 - 1) * hw;
        pos.push(cxv + nx * o, 0, zz + nz * o);
        uv.push(u, along);
        riv.push(o, -along, fx, fz);
      }
    }
    const rows = zs.length;
    for (let j = 0; j < rows - 1; j++) for (let a = 0; a < across; a++) {
      const p0 = j * (across + 1) + a, p1 = p0 + 1, p2 = p0 + across + 1, p3 = p2 + 1;
      idx.push(p0, p1, p2, p1, p3, p2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aRiver', new THREE.Float32BufferAttribute(riv, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  // water depth texture around the river (R = depth/4)
  const HB = { x0: -110, z0: -760, x1: 110, z1: 200 };
  function buildDepthMap(rocks = []) {
    const W = 256, H = 1024;
    const data = new Uint8Array(W * H * 4);
    const depths = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = HB.x0 + ((i + 0.5) / W) * (HB.x1 - HB.x0);
      const z = HB.z0 + ((j + 0.5) / H) * (HB.z1 - HB.z0);
      depths[j * W + i] = Math.max(0, -height(x, z));
    }
    // stamp rocks sitting in the water
    for (const r of rocks) {
      const i0 = Math.floor(((r.x - r.r - HB.x0) / (HB.x1 - HB.x0)) * W), i1 = Math.ceil(((r.x + r.r - HB.x0) / (HB.x1 - HB.x0)) * W);
      const j0 = Math.floor(((r.z - r.r - HB.z0) / (HB.z1 - HB.z0)) * H), j1 = Math.ceil(((r.z + r.r - HB.z0) / (HB.z1 - HB.z0)) * H);
      for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) {
        const x = HB.x0 + ((i + 0.5) / W) * (HB.x1 - HB.x0), z = HB.z0 + ((j + 0.5) / H) * (HB.z1 - HB.z0);
        const dd = Math.hypot(x - r.x, z - r.z) / r.r;
        if (dd < 1.35) depths[j * W + i] = Math.min(depths[j * W + i], Math.max(0, (dd - 0.85) * 0.8));
      }
    }
    for (let k = 0; k < W * H; k++) {
      const v = Math.min(255, Math.round((depths[k] / 4) * 255));
      data[k * 4] = v; data[k * 4 + 1] = v; data[k * 4 + 2] = v; data[k * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return { tex, bounds: new THREE.Vector4(HB.x0, HB.z0, 1 / (HB.x1 - HB.x0), 1 / (HB.z1 - HB.z0)) };
  }

  // cached height grid for hot paths (petal sim, camera clamp)
  const HC = { x0: -160, z0: -240, step: 1, nx: 321, nz: 361, data: null };
  function buildHeightCache() {
    const d = new Float32Array(HC.nx * HC.nz);
    for (let j = 0; j < HC.nz; j++) for (let i = 0; i < HC.nx; i++) d[j * HC.nx + i] = height(HC.x0 + i * HC.step, HC.z0 + j * HC.step);
    HC.data = d;
  }
  function heightFast(x, z) {
    if (!HC.data) return height(x, z);
    const fx = (x - HC.x0) / HC.step, fz = (z - HC.z0) / HC.step;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= HC.nx - 1 || j >= HC.nz - 1) return height(x, z);
    const u = fx - i, v = fz - j, d = HC.data, k = j * HC.nx + i;
    return (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + HC.nx] * (1 - u) + d[k + HC.nx + 1] * u) * v;
  }
  return { N, height, heightFast, buildHeightCache, riverX, riverHW, riverInfo, flowDir, buildTerrain, buildRiver, buildDepthMap, peak: { x: peakX, z: peakZ, R: fujiR }, pagoda };
}
