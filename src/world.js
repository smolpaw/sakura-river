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
  // the old temple on its knoll: centre, facing (yaw), terrace half-extents; y (terrace top) is set below
  const temple = { x: 22, z: -192, yaw: -0.6, hw: 17, hd: 12, y: Infinity };
  const tc = Math.cos(temple.yaw), ts = Math.sin(temple.yaw);

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
    // knoll for the temple, its terrace cut into it: nothing rises above the gravel, a bank behind
    const pdx = x - temple.x, pdz = z - temple.z;
    g += 16 * Math.exp(-(pdx * pdx + pdz * pdz) / (2 * 38 * 38));
    g = Math.min(g, temple.y - 0.4 + 0.5 * Math.max(0, templeDist(x, z) - 1.5));
    // river channel; where it cuts through the temple's knoll the banks are rock walls (vegetation.js cliffData): the
    // ground rises straight from the bed to the turf, a metre behind their faces
    const t = d / hw;
    const bank = lerp(smoothstep(0.74, 1.22, t), clamp((t - 0.84) / 0.44, 0, 1), smoothstep(2.5, 4, g));
    const bed = -1.75 * (1 - 0.65 * t * t) + 0.28 * N.fbm2(x * 0.25, z * 0.25, 3);
    return lerp(bed, g, bank);
  }

  temple.y = height(temple.x, temple.z) + 1.6;
  // distance outside the temple's terrace (0 on it)
  function templeDist(x, z) {
    const dx = x - temple.x, dz = z - temple.z;
    return Math.hypot(Math.max(0, Math.abs(dx * tc - dz * ts) - temple.hw), Math.max(0, Math.abs(dx * ts + dz * tc) - temple.hd));
  }

  // density of the woods on the hills (vegetation.js plants them, the terrain darkens under them): 1 in the heart
  // of a grove, a lone tree now and then out in the meadow, none on the valley floor, round the cherry tree or at
  // the temple
  const NG = makeNoise(31);
  function grove(x, z, gn) {
    const open = smoothstep(55, 75, Math.abs(x - riverX(z)) - Math.max(0, -z) * 0.05) * smoothstep(85, 105, Math.hypot(x + 10, z - 10)) * smoothstep(8, 16, templeDist(x, z));
    return open && open * Math.max(0.003, smoothstep(0.24, 0.34, gn ?? groveN(x, z)));
  }
  const groveN = (x, z) => NG.fbm2(x * 0.009, z * 0.009, 3);

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
    // the hills' patchwork: straw (times the ground's brightness), and tints multiplying the ground's colour
    const straw = new THREE.Color(1.5, 1.3, 0.62), fresh = new THREE.Color(1.1, 1.22, 0.7), lush = new THREE.Color(0.55, 0.74, 0.55), one = new THREE.Color(1, 1, 1), tint = new THREE.Color();
    const forest = new THREE.Color(0.07, 0.13, 0.05), woodFloor = new THREE.Color(0.045, 0.07, 0.03), snow = new THREE.Color(0.92, 0.94, 0.98), alpine = new THREE.Color(0.20, 0.22, 0.12);
    const tmp = new THREE.Color();
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const ny = nrm[v * 3 + 1];
      const ri = riverInfo(x, z);
      const n1 = N.fbm2(x * 0.05, z * 0.05, 3), n2 = N.noise2(x * 0.3 + 7, z * 0.3);
      // grass
      c.copy(grassA).lerp(grassB, clamp(0.5 + 0.9 * n1, 0, 1));
      const dry = N.noise2(x * 0.02 - 4, z * 0.02);
      c.lerp(grassDry, clamp(dry * 0.6 - 0.05, 0, 0.45));
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
      // out on the hills (the tall grass covers the ground round the cherry tree): a patchwork of last year's straw,
      // fresh growth, and darker, lusher grass in clumps, in the hollows and round the groves
      const out = smoothstep(75, 115, Math.hypot(x + 10, z - 10)) * smoothstep(1.8, 2.6, ri.t) * (1 - steep);
      const gn = out > 0 ? groveN(x, z) : undefined;
      if (out > 0) {
        const hollow = smoothstep(0.1, -0.35, N.fbm2(x * 0.006 + 5, z * 0.006 - 2, 2));
        c.multiply(tint.copy(one).lerp(fresh, out * smoothstep(0.05, -0.3, dry)));
        c.lerp(tint.copy(straw).multiplyScalar(0.3 * c.r + 0.6 * c.g + 0.1 * c.b), out * smoothstep(0.0, 0.35, dry) * (1 - hollow) * 0.85);
        c.multiply(tint.copy(one).lerp(lush, out * Math.max(hollow, smoothstep(0.06, 0.24, gn), smoothstep(-0.1, -0.45, N2.noise2(x * 0.07, z * 0.07)) * 0.7)));
      }
      // shaded floor under the groves' trees
      c.lerp(woodFloor, grove(x, z, gn) * 0.75 * (1 - steep) * smoothstep(3, 6, y) * smoothstep(175, 160, y));
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
    for (let k = 0; k < W * H; k++) {
      const v = Math.min(255, Math.round((depths[k] / 4) * 255));
      data[k * 4] = v; data[k * 4 + 1] = v; data[k * 4 + 2] = v; data[k * 4 + 3] = 255;
    }
    return { data, W, H, bounds: [HB.x0, HB.z0, 1 / (HB.x1 - HB.x0), 1 / (HB.z1 - HB.z0)], rocks: buildRockMap(rocks) };
  }

  // Rocks sitting in the water on a fine grid of their own (stamped into the coarse depth map above, ~0.9 m
  // texels, they showed as square foam blocks). R: the water depth they leave (depth/4, 255 = no rock).
  // G: where the current breaks on them, shaped by the flow: a pillow of white water on the upstream face, two
  // wake arms opening downstream from the flanks, and churned water in the lee. Rocks whose top stays under the
  // surface leave deeper water and break the current less, or not at all.
  function buildRockMap(rocks) {
    const S = 0.125;
    const reach = (r) => r.r * 4 + 2.5 + r.r * 3; // the wake runs further than the rock's own slope
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const r of rocks) { const e = reach(r); x0 = Math.min(x0, r.x - e); x1 = Math.max(x1, r.x + e); z0 = Math.min(z0, r.z - e); z1 = Math.max(z1, r.z + e); }
    if (!rocks.length) { x0 = z0 = 0; x1 = z1 = 1; }
    const W = Math.ceil((x1 - x0) / S), H = Math.ceil((z1 - z0) / S);
    const data = new Uint8Array(W * H * 2);
    for (let k = 0; k < W * H; k++) data[k * 2] = 255;
    for (const r of rocks) {
      const R = r.r, e = reach(r), L = 1.0 + 1.8 * R;
      const under = Math.max(0, -r.top), breaks = smoothstep(-0.35, 0.05, r.top);
      const [fx, fz] = flowDir(r.z), ax = fz, az = -fx;
      const i0 = Math.floor((r.x - e - x0) / S), i1 = Math.ceil((r.x + e - x0) / S);
      const j0 = Math.floor((r.z - e - z0) / S), j1 = Math.ceil((r.z + e - z0) / S);
      for (let j = Math.max(0, j0); j <= Math.min(H - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(W - 1, i1); i++) {
        const dx = x0 + (i + 0.5) * S - r.x, dz = z0 + (j + 0.5) * S - r.z;
        const dist = Math.hypot(dx, dz), dd = dist / R;
        const k = j * W + i;
        // the slope runs out to full depth, so the rock's footprint has no edge against the river bed
        if (dd < 4) data[k * 2] = Math.min(data[k * 2], Math.round(Math.min(1, (Math.max(0, (dd - 0.85) * 0.8) + under) / 4) * 255));
        if (breaks <= 0) continue;
        const al = dx * fx + dz * fz, ac = Math.abs(dx * ax + dz * az); // along the flow (downstream +), across
        const cos = al / Math.max(dist, 1e-4);
        const g = (x, w) => Math.exp(-(x * x) / (w * w));
        const bow = g(dd - 1.08, 0.36) * smoothstep(0.35, -0.6, cos);
        const a = Math.max(al, 0);
        const arms = g(ac - (R * 1.0 + a * 0.45), 0.14 + a * 0.12) * Math.exp(-a / L) * smoothstep(-0.3 * R, 0.3 * R, al) * smoothstep(0.95, 1.2, dd) * 0.7;
        const lee = g(ac, R * 0.75 + a * 0.2) * smoothstep(0.6 * R, 1.5 * R, al) * Math.exp(-a / (0.8 * L)) * 0.8;
        const f = Math.min(1, Math.max(bow, arms, lee)) * breaks;
        data[k * 2 + 1] = Math.max(data[k * 2 + 1], Math.round(f * 255));
      }
    }
    return { data, W, H, bounds: [x0, z0, 1 / (W * S), 1 / (H * S)] };
  }

  // cached height grid for hot paths (petal sim, camera clamp)
  const HC = { x0: -160, z0: -240, step: 1, nx: 321, nz: 361, data: null };
  function computeHeightCache() {
    const d = new Float32Array(HC.nx * HC.nz);
    for (let j = 0; j < HC.nz; j++) for (let i = 0; i < HC.nx; i++) d[j * HC.nx + i] = height(HC.x0 + i * HC.step, HC.z0 + j * HC.step);
    return d;
  }
  function buildHeightCache() { HC.data = computeHeightCache(); }
  function setHeightCache(d) { HC.data = d; }
  function heightFast(x, z) {
    if (!HC.data) return height(x, z);
    const fx = (x - HC.x0) / HC.step, fz = (z - HC.z0) / HC.step;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= HC.nx - 1 || j >= HC.nz - 1) return height(x, z);
    const u = fx - i, v = fz - j, d = HC.data, k = j * HC.nx + i;
    return (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + HC.nx] * (1 - u) + d[k + HC.nx + 1] * u) * v;
  }
  return { N, height, heightFast, buildHeightCache, heightCacheData: () => HC.data, computeHeightCache, setHeightCache, riverX, riverHW, riverInfo, flowDir, buildTerrain, buildRiver, buildDepthMap, peak: { x: peakX, z: peakZ, R: fujiR }, temple, templeDist, grove };
}

// water depth textures (R = depth / 4) from buildDepthMap's data: terrain, and the fine rock map (G = rock foam)
export function depthTexture(d) {
  const make = (data, W, H, format) => {
    const tex = new THREE.DataTexture(data, W, H, format);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1; // rows of the one- and two-byte formats are not 4-byte aligned
    tex.needsUpdate = true;
    return tex;
  };
  return {
    tex: make(d.data, d.W, d.H, THREE.RGBAFormat), bounds: new THREE.Vector4(...d.bounds),
    rockTex: make(d.rocks.data, d.rocks.W, d.rocks.H, THREE.RGFormat), rockBounds: new THREE.Vector4(...d.rocks.bounds),
  };
}
