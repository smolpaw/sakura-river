// Landscape: height field, river path, terrain mesh, river ribbon, water depth map
import * as THREE from 'three';
import { makeNoise, smoothstep, clamp, lerp } from './noise.js';

const hyp = (a, b) => Math.sqrt(a * a + b * b); // Math.hypot is several times slower, and these run per vertex

// the terrain mesh's grid: x = kx * sinh(cx * s) + ox for s in -1..1, z = z0 + kz * sinh(cz * s) for s in -1..sMaxZ
// (grass.js inverts this on the GPU to find the triangle under a blade)
export const TERRAIN_GRID = { kx: 16, cx: 5.86, ox: -2, kz: 18, cz: 6.2, z0: 4, zMax: 260 };
export const terrainSMaxZ = () => Math.asinh((TERRAIN_GRID.zMax - TERRAIN_GRID.z0) / TERRAIN_GRID.kz) / TERRAIN_GRID.cz;

export function createWorld(seed = 7) {
  const N = makeNoise(seed);
  const N2 = makeNoise(seed * 3 + 11);

  // (downstream, past z = 150, it swings west and out of sight behind the hills, so the valley's end shows hills,
  // not the terrain's edge)
  const riverX = (z) => 8.5 * Math.sin(z * 0.021 + 0.9) + 20 * Math.sin(z * 0.0072 - 0.35) + 3.5 * Math.sin(z * 0.047 + 2.2) - 4 - 55 * smoothstep(150, 262, z);
  const riverHW = (z) => lerp(7.6, 3.4, smoothstep(20, -520, z));
  const valleyW = (z) => 48 + 0.16 * Math.max(0, -z);

  // main mountain peak sits at the river's source
  const peakZ = -3100, peakX = 560, fujiR = 1950;
  // the old temple on its knoll: centre, facing (yaw), terrace half-extents; y (terrace top) is set below
  const temple = { x: 22, z: -192, yaw: -0.6, hw: 17, hd: 12, y: Infinity };
  const tc = Math.cos(temple.yaw), ts = Math.sin(temple.yaw);

  // the meadow's small bumps (the farmland's steps follow the ground without them)
  const meadowFine = (x, z) => 0.22 * N.fbm2(x * 0.07 + 11, z * 0.07, 3) + 0.05 * N.noise2(x * 0.6, z * 0.6);
  function meadow(x, z) {
    return 1.05 + 0.85 * N.fbm2(x * 0.012, z * 0.012, 4) + meadowFine(x, z);
  }

  function mountains(x, z) {
    const m = smoothstep(-650, -1500, z);
    if (m <= 0) return 0;
    const broad = 0.5 + 0.5 * N2.fbm2(x * 0.0006 + 1.3, z * 0.0006 - 0.7, 5);
    const r = N2.ridged2(x * 0.0012 + 3.1, z * 0.0012 - 1.7, 6);
    let h = 210 * broad * broad + 140 * r * (0.3 + broad);
    // keep the ranges low where the volcano stands so its silhouette stays clean
    const df = hyp(x - peakX, (z - peakZ) / 0.92) / fujiR;
    h *= 0.25 + 0.75 * smoothstep(0.55, 1.25, df);
    return h * m;
  }

  // the land before the farmland and the river: meadow, hills, mountains, the temple's knoll
  function ground(x, z) {
    const rx = riverX(z);
    const d = Math.abs(x - rx);
    const vw = valleyW(z);
    const far = smoothstep(-60, -500, z);
    let g = meadow(x, z);
    // valley walls / rolling hills
    const wall = smoothstep(vw * 0.45, vw * 1.9, d);
    const hillN = 0.5 + 0.5 * N.fbm2(x * 0.006 + 5, z * 0.006 - 2, 5);
    g += wall * (10 + 38 * hillN) * (0.55 + 2.2 * far);
    // background hills behind the camera side too (keeps horizon closed), leaving the river its valley
    g += smoothstep(90, 260, z) * 30 * hillN * smoothstep(12, 55, d);
    // far mountains, carved by the river valley
    const carve = lerp(smoothstep(riverHW(z) * 3, riverHW(z) * 3 + 160 + 0.35 * Math.max(0, -z - 600), d), 1, smoothstep(-1000, -1700, z));
    const mv = mountains(x, z) * carve;
    g += mv;
    // knoll for the temple, its terrace cut into it: nothing rises above the gravel, a bank behind
    const pdx = x - temple.x, pdz = z - temple.z;
    g += 16 * Math.exp(-(pdx * pdx + pdz * pdz) / (2 * 38 * 38));
    return Math.min(g, temple.y - 0.4 + 0.5 * Math.max(0, templeDist(x, z) - 1.5));
  }

  // ground height and the farmland there (field(), or null): river bed below 0, water level is y = 0
  function heightField(x, z) {
    let g = ground(x, z);
    const F = field(x, z, g);
    if (F) g = lerp(g, F.y, F.m);
    g -= 0.08 * smoothstep(1.7, 0.7, laneDist(x, z)); // the lanes worn a little into the ground
    const pad = padAt(x, z);
    if (pad) g = lerp(g, pad.y, pad.m);
    // river channel; where it cuts through the temple's knoll the banks are rock walls (vegetation.js cliffData): the
    // ground rises straight from the bed to the turf, a metre behind their faces
    const d = Math.abs(x - riverX(z)), t = d / riverHW(z);
    const bank = lerp(smoothstep(0.74, 1.22, t), clamp((t - 0.84) / 0.44, 0, 1), smoothstep(2.5, 4, g));
    const bed = -1.75 * (1 - 0.65 * t * t) + 0.28 * N.fbm2(x * 0.25, z * 0.25, 3);
    return { y: lerp(bed, g, bank), F };
  }
  const height = (x, z) => heightField(x, z).y;

  // ---------- the village and its farmland ----------
  // Lanes: from the bridge up to the temple's steps, and from the bridge across the paddies to the village and along
  // it at the foot of the western slope; the farmland keeps clear of them.
  const lane = (pts) => pts.map(([x, z]) => [x, z]);
  const LANES = [
    // the footpath from the bridge along the west bank to the cherry tree, outside the lantern line
    lane([[-33, -60], [-32, -50], [-27, -40], [-22, -30], [-20, -20], [-21, -10], [-22, -4]]),
    // the temple's approach, from the torii by the bridge up the knoll; it bends round onto the line of the temple's
    // steps and ends at their foot, between the stone lanterns there (temple.js STAIR: the steps' foot is where the
    // ground meets them, about (2.5, -175.8), their line running out towards (-0.565, 0.825))
    lane([[-13, -61], [-8, -74], [-2, -92], [3, -112], [5, -132], [-1.6, -163.4], [-1.8, -166.1], [-1.3, -169.5], [0.3, -172.6], [2.5, -175.9]]),
    // from the temple's approach across the terraces to the hamlet on the eastern slope
    lane([[5, -117], [16, -114], [28, -112], [37, -112.5], [44, -118], [45, -126], [44.5, -131]]),
    lane([[-33, -60], [-42, -64], [-55, -73], [-70, -84], [-84, -96], [-89, -115], [-91, -140], [-93, -165], [-95, -190], [-93, -215], [-90, -240]]),
  ];
  // distance to the nearest lane: looked up in a 1 m grid made on first use (out to 8 m; beyond, Infinity). Each
  // segment of each lane fills only the cells within 8 m of its bounds, keeping the nearest (every cell as the exact
  // distance to all the segments, clamped to 8, would cost ~50 ms in every worker that asks for a height)
  const LD = { x0: -104, z0: -250, s: 1, nx: 165, nz: 253, d: null };
  function laneDist(x, z) {
    if (!LD.d) {
      const d = LD.d = new Float32Array(LD.nx * LD.nz).fill(8), cell = (v, o) => (v - o) / LD.s;
      for (const L of LANES) for (let k = 1; k < L.length; k++) {
        const [ax, az] = L[k - 1], [bx, bz] = L[k], vx = bx - ax, vz = bz - az, vv = vx * vx + vz * vz;
        const i0 = Math.max(0, Math.floor(cell(Math.min(ax, bx) - 8, LD.x0))), i1 = Math.min(LD.nx - 1, Math.ceil(cell(Math.max(ax, bx) + 8, LD.x0)));
        const j0 = Math.max(0, Math.floor(cell(Math.min(az, bz) - 8, LD.z0))), j1 = Math.min(LD.nz - 1, Math.ceil(cell(Math.max(az, bz) + 8, LD.z0)));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = LD.x0 + i * LD.s, z = LD.z0 + j * LD.s, t = clamp(((x - ax) * vx + (z - az) * vz) / vv, 0, 1);
          const r = hyp(x - ax - vx * t, z - az - vz * t);
          if (r < d[j * LD.nx + i]) d[j * LD.nx + i] = r;
        }
      }
    }
    const fx = (x - LD.x0) / LD.s, fz = (z - LD.z0) / LD.s;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= LD.nx - 1 || j >= LD.nz - 1) return Infinity;
    const u = fx - i, v = fz - j, d = LD.d, k = j * LD.nx + i;
    const r = (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + LD.nx] * (1 - u) + d[k + LD.nx + 1] * u) * v;
    return r >= 8 ? Infinity : r;
  }
  // The village's buildings (village.js draws them): their kind, where, which way their front faces (+z turned by
  // yaw), and the levelled pad each stands on (half-sizes hw, hd round it; its yard reaching `yard` metres out in
  // front). Farmhouses strung along the lane at the foot of the western slope, a hamlet above the eastern terraces.
  const B = (kind, x, z, yaw, hw, hd, yard) => ({ kind, x, z, yaw, hw, hd, yard, c: Math.cos(yaw), s: Math.sin(yaw), y: 0 });
  // the waterwheel's mill on the west bank at z, its axle (local +x) across the river to the wheel 2.9 m out (village.js
  // turns it), the wheel in the water at 0.85 of the river's half-width; its pad low by the water (cut into the bank)
  const mill = (z) => {
    const [fx, fz] = flowDir(z), ax = fz, az = -fx; // across, towards the east bank
    const wx = riverX(z) - riverHW(z) * 0.85 * ax, wz = z - riverHW(z) * 0.85 * az;
    const b = B('suisha', wx - ax * 2.9, wz - az * 2.9, Math.atan2(-az, ax), 2.0, 1.8, 0);
    b.level = 0.25;
    return b;
  };
  const E = Math.PI / 2, Wd = -Math.PI / 2;
  const BUILDINGS = [
    B('minka0', -103, -104, E, 7.6, 5.2, 4), B('kura', -100, -121, E + 0.1, 3.2, 2.7, 2), B('minka1', -79, -130, Wd, 5.8, 4.4, 3.5),
    B('koya', -102, -133, E, 2.6, 2.3, 1), B('minka0', -106, -153, E - 0.12, 7.6, 5.2, 4), B('minka1', -105, -177, E + 0.15, 5.8, 4.4, 3.5),
    B('koya', -83, -185, Wd, 2.6, 2.3, 1), B('minka0', -81, -205, Wd + 0.08, 7.6, 5.2, 4), B('kura', -105, -199, E, 3.2, 2.7, 2),
    B('minka1', -103, -226, E - 0.1, 5.8, 4.4, 3.5),
    // a hamlet on the eastern slope above its terraces, right of the temple from the cherry tree, facing down the valley
    B('minka1', 30, -126, -0.25, 5.8, 4.4, 3.5), B('koya', 20, -134, -0.2, 2.6, 2.3, 1), B('minka0', 44, -146, -0.27, 7.6, 5.2, 4),
    B('kura', 58, -157, -0.3, 3.2, 2.7, 2),
    // the hamlet downstream: a farmhouse, its storehouse and shed among the eastern terraces, one across the river
    B('minka0', 52, 90, -Math.PI / 2 - 0.2, 7.6, 5.2, 4), B('kura', 56, 108, -Math.PI / 2, 3.2, 2.7, 2), B('koya', 50, 78, -Math.PI / 2 - 0.2, 2.6, 2.3, 1),
    B('minka1', -56, 96, Math.PI / 2 + 0.25, 5.8, 4.4, 3.5),
    mill(-108),
  ];
  // signed distance outside a building's pad (its yard included), in its own frame
  const padDist = (b, x, z) => {
    const dx = x - b.x, dz = z - b.z, lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
    const zc = b.yard / 2, hd = b.hd + b.yard / 2;
    return hyp(Math.max(0, Math.abs(lx) - b.hw), Math.max(0, Math.abs(lz - zc) - hd));
  };
  // the pad under (x, z): its level and how much of it there is (1 on it, a steep bank over 2 m), or null
  function padAt(x, z) {
    for (const b of BUILDINGS) {
      if (Math.abs(x - b.x) > 20 || Math.abs(z - b.z) > 20) continue;
      const d = padDist(b, x, z);
      if (d < 2.2) return { y: b.y, m: smoothstep(2.2, 0.15, d), b, d };
    }
    return null;
  }
  // the small cherries along the river stand in their own clearings (their Blender trunks fit the ground there)
  const CLEAR = [[-50.4, -92], [-5.3, -150], [-43.9, -225], [2.2, -40]];
  const FN = makeNoise(seed * 5 + 3);
  // Rice paddies stepped into the land along its contours: the ground without its small bumps cut into flat steps
  // of s metres; each step's lip a low levee (aze) over a riser at the back of the step below (an earth bank, steep
  // where the slope is), cross levees every `len` metres along `axis`, staggered from step to step. On the valley
  // floor the steps are low, irregular paddies following its fall; up the slopes they are terraces (tanada). `wet`:
  // the share flooded for planting, the rest still dry. Each zone fades into the natural ground at its edges.
  const ZONES = [
    // the valley floor west of the river, from below the bridge up past the village: rectangular paddies (fieldFloor)
    { floor: true, row: 21, wet: 0.8, box: [-90, -262, -30, -60], mask: (x, z, rx, hw) => smoothstep(-90, -80, x) * smoothstep(rx - hw - 3, rx - hw - 9, x) * smoothstep(-60, -70, z) * smoothstep(-262, -250, z) },
    // terraces up the slope below the temple, east of the river
    { s: 1.4, len: 21, axis: [0.1, 1], wet: 0.65, box: [-25, -176, 100, -46], mask: (x, z, rx, hw) => smoothstep(rx + hw + 4, rx + hw + 11, x) * smoothstep(98, 86, x) * smoothstep(-62, -72, z) * smoothstep(-174, -162, z) * smoothstep(14, 22, templeDist(x, z)) },
    // terraces above the village, west
    { s: 1.3, len: 18, axis: [0.1, 1], wet: 0.6, box: [-164, -218, -96, -62], mask: (x, z) => smoothstep(-162, -150, x) * smoothstep(-98, -108, x) * smoothstep(-64, -74, z) * smoothstep(-216, -204, z) },
    // downstream, behind the cherry tree: paddies on the floor either side of the river, terraces up both slopes
    { floor: true, row: 19, wet: 0.75, box: [-48, 42, 30, 152], mask: (x, z, rx, hw) => smoothstep(-48, -40, x) * smoothstep(rx - hw - 4, rx - hw - 9, x) * smoothstep(42, 50, z) * smoothstep(152, 144, z) + smoothstep(rx + hw + 4, rx + hw + 9, x) * smoothstep(30, 24, x) * smoothstep(42, 50, z) * smoothstep(152, 144, z) },
    { s: 1.25, len: 19, axis: [0.15, 1], wet: 0.65, box: [22, 38, 92, 158], mask: (x, z) => smoothstep(24, 32, x) * smoothstep(90, 80, x) * smoothstep(38, 48, z) * smoothstep(158, 148, z) },
    { s: 1.25, len: 18, axis: [0.15, 1], wet: 0.6, box: [-86, 50, -38, 158], mask: (x, z) => smoothstep(-86, -78, x) * smoothstep(-38, -46, x) * smoothstep(50, 60, z) * smoothstep(158, 148, z) },
    // the village (no paddies: the fine mesh for the farmhouses' pads, yards and stone walls), west and east
    { village: true, box: [-122, -244, -66, -86], mask: (x, z) => smoothstep(-122, -115, x) * smoothstep(-66, -72, x) * smoothstep(-86, -93, z) * smoothstep(-244, -237, z) },
    { village: true, box: [10, -166, 70, -106], mask: (x, z) => smoothstep(10, 16, x) * smoothstep(70, 64, x) * smoothstep(-166, -160, z) * smoothstep(-106, -112, z) },
    { village: true, box: [34, 70, 72, 124], mask: (x, z) => smoothstep(34, 40, x) * smoothstep(72, 66, x) * smoothstep(70, 76, z) * smoothstep(124, 118, z) },
    { village: true, box: [-72, 80, -42, 112], mask: (x, z) => smoothstep(-72, -66, x) * smoothstep(-42, -48, x) * smoothstep(80, 86, z) * smoothstep(112, 106, z) },
  ];
  // what keeps the farmland back: the lanes, and clearings round the small cherries (signed: < 0 inside)
  function keepOut(x, z) {
    let d = laneDist(x, z) - 2.4;
    for (const [cx, cz] of CLEAR) d = Math.min(d, hyp(x - cx, z - cz) - 10);
    for (const b of BUILDINGS) if (Math.abs(x - b.x) < 30 && Math.abs(z - b.z) < 30) d = Math.min(d, padDist(b, x, z) - 4);
    return d;
  }
  // how far into zone i (x, z) is (0..1), the farmland's edges warped by noise and kept back from lanes, pads and
  // clearings; 0 outside
  function zoneMask(i, x, z) {
    const Z = ZONES[i], b = Z.box;
    if (x < b[0] || z < b[1] || x > b[2] || z > b[3]) return 0;
    let m = Z.mask(x, z, riverX(z), riverHW(z));
    if (m <= 0 || Z.village) return m;
    m *= smoothstep(0.2, 2.6, keepOut(x, z));
    return smoothstep(0.42, 0.58, m + 0.3 * FN.noise2(x * 0.045, z * 0.045));
  }
  // the farmland zone (x, z) is in (not the village's) and how far in, or null
  function zoneAt(x, z) {
    for (let i = 0; i < ZONES.length; i++) {
      if (ZONES[i].village) continue;
      const m = zoneMask(i, x, z);
      if (m > 0) return { m, i, Z: ZONES[i] };
    }
    return null;
  }
  const fieldHash = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
  // the ground without its small bumps on a 2 m lattice (cached): the terraces' slope, for their risers' width
  const LAT = new Map(), lat = (i, j) => {
    const key = i * 100000 + j;
    let v = LAT.get(key);
    if (v === undefined) { v = ground(i * 2, j * 2) - meadowFine(i * 2, j * 2); LAT.set(key, v); }
    return v;
  };
  function slopeAt(x, z) {
    const i = Math.floor(x / 2), j = Math.floor(z / 2), u = x / 2 - i, v = z / 2 - j;
    const a = lat(i, j), b = lat(i + 1, j), c = lat(i, j + 1), d = lat(i + 1, j + 1);
    return hyp(((b - a) * (1 - v) + (d - c) * v) / 2, ((c - a) * (1 - u) + (d - b) * u) / 2);
  }
  // the farmland at (x, z) over ground g: its height y, how far into it m (0..1), and what is there
  function field(x, z, g) {
    for (let i = 0; i < ZONES.length; i++) {
      const Z = ZONES[i], b = Z.box;
      if (x < b[0] || z < b[1] || x > b[2] || z > b[3]) continue;
      let F = null;
      if (Z.floor) F = fieldFloor(x, z, g, { i, Z }); // its fields decide, each wholly farmland or not
      else {
        const m = zoneMask(i, x, z);
        if (m > 0) F = Z.village ? { y: g, m, zone: i, village: true, riser: 0, levee: 0, inside: false } : fieldTerrace(x, z, g, { m, i, Z });
      }
      if (F) return F;
    }
    return null;
  }
  // Terraces (tanada): the ground without its small bumps cut into flat steps of s metres along its contours; each
  // step's lip a low levee (aze) over a riser at the back of the step below (a grassy earth bank), cross levees
  // every `len` metres along `axis`, staggered from step to step. Fades into the natural ground
  // at the zone's edges.
  function fieldTerrace(x, z, g, { m, i, Z }) {
    const hq = g - meadowFine(x, z);
    const slope = Math.max(slopeAt(x, z), 0.012);
    const s = Z.s, hs = hq / s, k = Math.floor(hs), f = hs - k;
    const w = s / slope; // the step's width down the slope (m)
    const fr = Math.min(0.5, Math.max(1.8, s * 1.25) / w); // the riser's share of it (a grassy bank)
    const lev = Math.min(0.55 / w, 0.22); // the lip's levee
    const ca = (x * Z.axis[0] + z * Z.axis[1] + 6 * FN.noise2(x * 0.04 + 9, z * 0.04)) / Z.len + k * 0.37;
    const ci = Math.floor(ca), cf = ca - ci;
    const cross = smoothstep(0.6 / Z.len, 0.2 / Z.len, Math.min(cf, 1 - cf));
    const lip = smoothstep(0, lev * 0.45, f) * smoothstep(lev, lev * 0.55, f);
    const levee = Math.max(lip, cross * smoothstep(1 - fr, 1 - fr - 0.05, f));
    const cell = fieldHash(k + i * 101, ci);
    const wet = cell < Z.wet;
    const base = (wet ? 0.1 : 0.05) * smoothstep(0, lev * 0.5, f);
    const y = s * k + Math.max(s * smoothstep(1 - fr, 1, f), base, 0.26 * levee);
    // in the paddy (not its levees or riser): flooded or not; q: how far in (m; < 0 outside), from the lip, the
    // riser and the cross levee (where it drops under 0.35)
    const inside = f > lev && f < 1 - fr && levee < 0.35;
    const q = Math.min((f - lev) * w, (1 - fr - f) * w, Math.min(cf, 1 - cf) * Z.len - 0.44);
    return { y, m, zone: i, wet, inside, q, levee, riser: f >= 1 - fr ? s : 0, cell };
  }
  // The valley floor: rows of paddies `row` metres long across the floor, each row split into fields 11-19 m wide,
  // each field flat at the floor's height at its middle (cached) a hand under its levees; levees between fields
  // (the higher field's level), banks down or up to the natural ground where a field meets a lane, a clearing or
  // the zone's edge. A field is farmland or not as a whole (the zone's mask at its middle).
  const FLOOR = new Map();
  function floorCell(Z, i, iu, n) {
    const key = (i * 1000 + iu) * 1000 + n;
    let c = FLOOR.get(key);
    if (c) return c;
    const z0 = Z.box[3] - iu * Z.row;
    const xs = [Z.box[0]];
    while (xs[xs.length - 1] < Z.box[2]) xs.push(xs[xs.length - 1] + 11 + 8 * fieldHash(iu * 7 + 3, xs.length));
    const x0 = xs[n], x1 = xs[n + 1], xc = (x0 + x1) / 2, zc = z0 - Z.row / 2;
    const m = Z.mask(xc, zc, riverX(zc), riverHW(zc)) * smoothstep(0, 3, keepOut(xc, zc)) + 0.3 * FN.noise2(xc * 0.045, zc * 0.045);
    let lo = Infinity, hi = -Infinity;
    for (const [px, pz] of [[x0 + 1, z0 - 1], [x1 - 1, z0 - 1], [x0 + 1, z0 - Z.row + 1], [x1 - 1, z0 - Z.row + 1]]) {
      const h = ground(px, pz) - meadowFine(px, pz);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    // level at its middle (neighbours step a little: their shared levee is a low bank), a little into the floor;
    // none where the ground falls too far across it (the field would cut a tall bank into the hill)
    const level = ground(xc, zc) - meadowFine(xc, zc) - 0.12;
    const inside = x1 <= Z.box[2] && z0 - Z.row >= Z.box[1];
    c = { x0, x1, z0, z1: z0 - Z.row, xs, on: inside && m > 0.5 && hi - lo < 2.2, level, cell: fieldHash(iu + i * 101, n) };
    FLOOR.set(key, c);
    return c;
  }
  function fieldFloor(x, z, g, { i, Z }) {
    const iu = Math.floor((Z.box[3] - z) / Z.row);
    const row = floorCell(Z, i, iu, 0).xs;
    let n = 0;
    while (n < row.length - 2 && x >= row[n + 1]) n++;
    const c = floorCell(Z, i, iu, n);
    if (!c.on) return null;
    // the nearest edge, and what lies beyond it
    const edges = [[x - c.x0, iu, n - 1], [c.x1 - x, iu, n + 1], [c.z0 - z, iu - 1, -1], [z - c.z1, iu + 1, -1]];
    let e = edges[0];
    for (const q of edges) if (q[0] < e[0]) e = q;
    let nb = null;
    if (e[2] >= 0) nb = floorCell(Z, i, e[1], e[2]);
    else if (e[1] !== iu) {
      // the next row's field across this edge
      const r2 = floorCell(Z, i, e[1], 0).xs;
      let n2 = 0;
      while (n2 < r2.length - 2 && x >= r2[n2 + 1]) n2++;
      nb = floorCell(Z, i, e[1], n2);
    }
    const ko = keepOut(x, z);
    const wet = c.cell < Z.wet;
    const water = c.level + (wet ? 0.1 : 0.05);
    let y, m, levee, q;
    if (ko < e[0] || !nb || !nb.on) {
      // a levee, then a bank down or up to the natural ground at the field's own edge (beyond: a lane, a clearing,
      // the zone's edge), so the ground runs on without a step
      const d = Math.min(e[0], ko);
      levee = smoothstep(1.9, 1.3, d);
      y = lerp(lerp(water, c.level + 0.25, levee), g, smoothstep(0.9, 0.0, d));
      m = smoothstep(0.0, 0.9, d);
      q = d - 1.83;
    } else {
      // a levee shared with the next field, as high as the higher of the two
      levee = smoothstep(0.75, 0.2, e[0]);
      y = lerp(water, Math.max(c.level, nb.level) + 0.25, levee);
      m = 1;
      q = e[0] - 0.72;
    }
    // q: how far into the paddy (m; < 0 on its levee), where the levee drops under 0.05
    return { y, m, zone: i, wet, inside: levee < 0.05, q, levee, riser: 0, cell: c.cell };
  }

  temple.y = height(temple.x, temple.z) + 1.6;
  for (const b of BUILDINGS) b.y = b.level ?? ground(b.x, b.z) - meadowFine(b.x, b.z); // the pad's level: the ground under the house, half cut, half built up
  // distance outside the temple's terrace (0 on it)
  function templeDist(x, z) {
    const dx = x - temple.x, dz = z - temple.z;
    return hyp(Math.max(0, Math.abs(dx * tc - dz * ts) - temple.hw), Math.max(0, Math.abs(dx * ts + dz * tc) - temple.hd));
  }

  // density of the woods on the hills (vegetation.js plants them, the terrain darkens under them): 1 in the heart
  // of a grove, a lone tree now and then out in the meadow, none on the valley floor, round the cherry tree, at the
  // temple or on the farmland
  const NG = makeNoise(31);
  function grove(x, z, gn) {
    let open = smoothstep(40, 56, Math.abs(x - riverX(z)) - Math.max(0, -z) * 0.05) * smoothstep(85, 105, hyp(x + 10, z - 10)) * smoothstep(8, 16, templeDist(x, z));
    if (open > 0) { const zm = zoneAt(x, z); if (zm) open *= 1 - zm.m; }
    if (open > 0) for (const b of BUILDINGS) if (Math.abs(x - b.x) < 30 && Math.abs(z - b.z) < 30) open *= smoothstep(4, 9, padDist(b, x, z));
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
    const l = hyp(dx, 1);
    return [dx / l, 1 / l];
  }

  // ---------- the ground's colour and its grass ----------
  // At (x, y, z) with the ground's normal ny: its colour (meadow, banks, sand, rock, the hills' patchwork, lanes,
  // yards, the woods' floor, alpine and snow) and the grass grown there: none in the water, on rock, on the temple's
  // gravel, the lanes and yards or high up; thin and short on the woods' floor; in patches, longer by the river
  // (reeds) and in the valley than out on the hills; tint 0 lush .. 1 straw.
  const c = new THREE.Color();
  const grassA = new THREE.Color(0.20, 0.34, 0.075), grassB = new THREE.Color(0.34, 0.44, 0.10), grassDry = new THREE.Color(0.45, 0.45, 0.18);
  const dirt = new THREE.Color(0.34, 0.28, 0.19), moss = new THREE.Color(0.13, 0.24, 0.06), mud = new THREE.Color(0.19, 0.15, 0.10), sand = new THREE.Color(0.36, 0.31, 0.23);
  const bedDeep = new THREE.Color(0.13, 0.13, 0.10), rock = new THREE.Color(0.27, 0.25, 0.25), rockDark = new THREE.Color(0.13, 0.12, 0.13);
  // the hills' patchwork: straw (times the ground's brightness), and tints multiplying the ground's colour
  const straw = new THREE.Color(1.5, 1.3, 0.62), fresh = new THREE.Color(1.1, 1.22, 0.7), lush = new THREE.Color(0.55, 0.74, 0.55), one = new THREE.Color(1, 1, 1), tint = new THREE.Color();
  const forest = new THREE.Color(0.07, 0.13, 0.05), woodFloor = new THREE.Color(0.045, 0.07, 0.03), snow = new THREE.Color(0.92, 0.94, 0.98), alpine = new THREE.Color(0.20, 0.22, 0.12);
  const tmp = new THREE.Color();
  function groundCover(x, y, z, ny) {
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
    const out = smoothstep(75, 115, hyp(x + 10, z - 10)) * smoothstep(1.8, 2.6, ri.t) * (1 - steep);
    const gn = out > 0 ? groveN(x, z) : undefined;
    if (out > 0) {
      const hollow = smoothstep(0.1, -0.35, N.fbm2(x * 0.006 + 5, z * 0.006 - 2, 2));
      c.multiply(tint.copy(one).lerp(fresh, out * smoothstep(0.05, -0.3, dry)));
      c.lerp(tint.copy(straw).multiplyScalar(0.3 * c.r + 0.6 * c.g + 0.1 * c.b), out * smoothstep(0.0, 0.35, dry) * (1 - hollow) * 0.85);
      c.multiply(tint.copy(one).lerp(lush, out * Math.max(hollow, smoothstep(0.06, 0.24, gn), smoothstep(-0.1, -0.45, N2.noise2(x * 0.07, z * 0.07)) * 0.7)));
    }
    // the lanes: bare earth, worn into the grass
    const ld = laneDist(x, z);
    c.lerp(dirt, smoothstep(1.9, 1.1, ld) * (0.8 + 0.2 * n2));
    // the farmhouses' yards: packed earth, grass round the edges
    const pad = padAt(x, z);
    const yard = pad ? smoothstep(1.2, 0.0, pad.d) : 0;
    c.lerp(dirt, yard * (0.75 + 0.25 * n2));
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
    // the grass: none in the water, on rock, on the temple's gravel or high up; thin and short on the woods' floor;
    // in patches, longer by the river (reeds) and in the valley than out on the hills; tint 0 lush .. 1 straw
    const woods = grove(x, z, gn) * (1 - steep) * smoothstep(3, 6, y) * smoothstep(175, 160, y);
    let dens = smoothstep(0.08, 0.3, y) * smoothstep(0.7, 0.86, ny) * (1 - 0.8 * woods) * smoothstep(170, 110, y) * smoothstep(0.3, 1.5, templeDist(x, z));
    dens *= clamp(0.82 + 0.6 * n1, 0.4, 1);
    const nearBank = smoothstep(1.4, 1.0, ri.t);
    let len = clamp(0.55 + 0.45 * N2.fbm2(x * 0.08, z * 0.08, 3), 0.25, 1) * lerp(1, 0.55, out) * (1 - 0.6 * woods) + nearBank * 0.35;
    let gTint = clamp(0.35 + clamp(dry * 0.6 - 0.05, 0, 0.45) * 0.6 - 0.25 * bankT, 0, 1);
    if (out > 0) gTint = clamp(gTint + out * (smoothstep(0.0, 0.35, dry) * 0.4 - 0.3 * Math.max(smoothstep(0.06, 0.24, gn), smoothstep(-0.1, -0.45, N2.noise2(x * 0.07, z * 0.07)))), 0, 1);
    dens *= smoothstep(1.3, 2.3, ld); // none on the lanes
    dens *= 1 - yard;
    // reeds (yoshi) in clumps where the bank meets the river, some standing in the shallows: grass.js grows them where
    // the tint is below zero (its depth: how many)
    const reed = smoothstep(-0.3, -0.08, y) * smoothstep(0.75, 0.4, y) * smoothstep(1.6, 1.3, ri.t) * (1 - steep) *
      smoothstep(0.08, 0.3, N2.noise2(x * 0.22 + 31, z * 0.22)) * smoothstep(1.3, 2.3, ld);
    if (reed > 0.02) { dens = Math.max(dens, Math.min(1, reed * 1.5)); gTint = -reed; }
    return { r: c.r, g: c.g, b: c.b, dens, len, tint: gTint };
  }

  // ---------- terrain mesh (non uniform grid: dense near the scene, sparse far) ----------
  // Besides the mesh, `grid` holds per vertex (row-major, x fastest): height, and the grass grown there (grass.js
  // reads it to stand its blades on this very surface): density 0..1, length 0..1, dryness 0..1. The mesh carries
  // the grass values too (aGround), so the ground under the blades takes their colour. `mask(x, z)` -> [density,
  // length] multipliers from the scene's layout (lawns, the deer's turf, trunks).
  function buildTerrain(segX, segZ, mask = null) {
    const { kx, cx, ox, kz, cz, z0 } = TERRAIN_GRID;
    const sMaxZ = terrainSMaxZ();
    const xs = new Float32Array(segX + 1), zs = new Float32Array(segZ + 1);
    for (let i = 0; i <= segX; i++) { const s = -1 + (2 * i) / segX; xs[i] = kx * Math.sinh(cx * s) + ox; }
    for (let j = 0; j <= segZ; j++) { const s = -1 + ((sMaxZ + 1) * j) / segZ; zs[j] = z0 + kz * Math.sinh(cz * s); }
    const nv = (segX + 1) * (segZ + 1);
    const grid = new Float32Array(nv * 4), ground = new Float32Array(nv * 3);
    const pos = new Float32Array(nv * 3), farm = new Float32Array(nv);
    let k = 0;
    for (let j = 0; j <= segZ; j++) for (let i = 0; i <= segX; i++) {
      const x = xs[i], z = zs[j], h = heightField(x, z);
      // under the farmland the fine mesh (buildFields) draws the ground: this one drops away beneath it
      const m = (farm[k / 3] = h.F ? h.F.m : 0);
      pos[k++] = x; pos[k++] = h.y - 0.5 * smoothstep(0.25, 0.6, m); pos[k++] = z;
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
    // vertex colours and the grass
    const nrm = geo.attributes.normal.array;
    const col = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const g = groundCover(x, y, z, nrm[v * 3 + 1]);
      col[v * 3] = g.r; col[v * 3 + 1] = g.g; col[v * 3 + 2] = g.b;
      let { dens, len } = g;
      dens *= 1 - smoothstep(0.1, 0.3, farm[v]); // no blades on the farmland (they stand on its own mesh there)
      if (mask) { const m = mask(x, z); dens *= m[0]; len *= m[1]; }
      grid[v * 4] = y; grid[v * 4 + 1] = dens; grid[v * 4 + 2] = len; grid[v * 4 + 3] = g.tint;
      ground[v * 3] = dens; ground[v * 3 + 1] = len; ground[v * 3 + 2] = g.tint;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aGround', new THREE.BufferAttribute(ground, 3));
    geo.computeBoundingSphere();
    return { geo, grid, segX, segZ };
  }

  // ---------- the farmland's own mesh ----------
  // A fine grid (step metres) over each farmland zone and the village, sharper than the terrain mesh out there:
  // levees half a metre wide, the paddies' edges and the farmhouses' pads need it. It draws the ground wherever the farmland is (the terrain mesh dips under it,
  // and its own edge dips under the terrain where the zone fades out). `zones`: which of ZONES (the page builds them in
  // a few jobs at once). color: the ground's colour (levees grassy,
  // risers grassy earth banks, dry paddies soil, stubble or renge in flower); aGround: as on the terrain
  // (the grass's colour on levees and the zone's fringe); aWater: over 0.5 in a flooded paddy (materials.js terrainMaterial
  // draws the water there), 0.5 at its edge. grids: per zone, its grid's
  // height and grass (density, length) and where the mesh is, for grass.js to stand blades on.
  function buildFields(step = 0.5, zones = ZONES.map((_, i) => i)) {
    const P = [], I = [], grids = [], verts = [];
    const inBox = (b, x, z) => x >= b[0] && z >= b[1] && x <= b[2] && z <= b[3];
    // the cheap test: could (x, z) be farmland or village at all
    const near = (x, z) => ZONES.some((Z, i) => inBox(Z.box, x, z) && (Z.floor || zoneMask(i, x, z) > 0));
    // each quad is drawn by the first zone whose box holds its middle (boxes overlap; the lattice is shared, so
    // neighbouring zones' meshes meet without a seam)
    const owner = (x, z) => ZONES.findIndex((Z) => inBox(Z.box, x, z));
    for (const zi of zones) {
      const Z = ZONES[zi];
      const bx0 = Math.floor(Z.box[0] / step) * step, bz0 = Math.floor(Z.box[1] / step) * step;
      const nx = Math.round((Math.ceil(Z.box[2] / step) * step - bx0) / step) + 1, nz = Math.round((Math.ceil(Z.box[3] / step) * step - bz0) / step) + 1;
      const idx = new Int32Array(nx * nz).fill(-1);
      const grid = new Float32Array(nx * nz * 4); // y, grass density, grass length, 1 where the mesh is
      grids.push({ grid, nx, nz, box: [bx0, bz0, step] });
      // where the farmland and village are, and a ring of the natural ground round them (so the mesh's edge comes back
      // down to the ground the terrain mesh draws, however steeply the farmland ends)
      const H = new Array(nx * nz).fill(null);
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const x = bx0 + i * step, z = bz0 + j * step;
        if (near(x, z)) { const h = heightField(x, z); if (h.F) H[j * nx + i] = h; }
      }
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        let h = H[k];
        if (!h) {
          let ring = false;
          for (let dj = -1; dj <= 1 && !ring; dj++) for (let di = -1; di <= 1; di++) { const q = (j + dj) * nx + i + di; if (i + di >= 0 && i + di < nx && j + dj >= 0 && j + dj < nz && H[q] && H[q].F) { ring = true; break; } }
          if (!ring) continue;
          const x = bx0 + i * step, z = bz0 + j * step;
          h = { y: height(x, z), F: { y: 0, m: 0, zone: zi, village: true, riser: 0, levee: 0, inside: false } };
        }
        const x = bx0 + i * step, z = bz0 + j * step;
        idx[k] = P.length / 3;
        // (where the farmland fades out the terrain mesh takes over: this one a little under it)
        P.push(x, h.y - 0.15 * (1 - smoothstep(0.02, 0.25, h.F.m)), z);
        verts.push({ x, y: h.y, z, F: h.F, grid, k: k * 4 });
      }
      for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = idx[j * nx + i], b = idx[j * nx + i + 1], c = idx[(j + 1) * nx + i], d = idx[(j + 1) * nx + i + 1];
        if (a < 0 || b < 0 || c < 0 || d < 0 || owner(bx0 + (i + 0.5) * step, bz0 + (j + 0.5) * step) !== zi) continue;
        I.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setIndex(P.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(I, 1) : new THREE.Uint16BufferAttribute(I, 1));
    geo.computeVertexNormals();
    // colours and grass, now the normals are known
    const nrm = geo.attributes.normal.array;
    const C = new Float32Array(verts.length * 3), Gr = new Float32Array(verts.length * 3), Wt = new Float32Array(verts.length);
    const levee = [0.15, 0.27, 0.07], soil = [0.25, 0.18, 0.12], stubble = [0.4, 0.34, 0.2], renge = [0.5, 0.26, 0.42];
    const earth = [0.3, 0.26, 0.17], bank = [0.12, 0.22, 0.06], mud = [0.2, 0.16, 0.11];
    const field = { r: 0, g: 0, b: 0, dens: 1, len: 0.45, tint: 0.32 };
    verts.forEach(({ x, y, z, F, grid, k }, v) => {
      // the ground's own cover where it shows: the village, and the farmland's fringe (elsewhere it is all paddy)
      const fringe = F.village ? 1 : 1 - smoothstep(0.15, 0.5, F.m);
      const g = fringe > 0 ? groundCover(x, y, z, nrm[v * 3 + 1]) : field;
      let c = [g.r, g.g, g.b], dens = g.dens, len = g.len;
      // the pads' banks: dark, mossy earth between the wall's stones (vegetation.js lays them), not bare rock
      if (F.village) c = lerpC(c, [0.075, 0.085, 0.045], smoothstep(0.85, 0.6, nrm[v * 3 + 1]));
      if (!F.village) {
        const n = 0.85 + 0.3 * FN.noise2(x * 0.7, z * 0.7);
        c = levee; dens = 1; len = 0.45;
        if (F.riser) { c = lerpC(bank, earth, 0.25 * smoothstep(0.2, 0.8, FN.noise2(x * 0.3, z * 0.3) + 0.5)); dens = 0.7; len = 0.7; }
        else if (F.inside) { c = F.wet ? mud : F.cell > 0.9 ? renge : F.cell > 0.8 ? stubble : soil; dens = 0; }
        c = c.map((q) => q * n);
        // the zone's fringe: the ground beyond
        c = lerpC(c, [g.r, g.g, g.b], fringe); dens = lerp(dens, g.dens, fringe); len = lerp(len, g.len, fringe);
        // over 0.5: water; from how far into the paddy, so its edge falls where the levee rises, not along the mesh
        Wt[v] = F.wet ? clamp(0.5 + F.q / 0.5, 0, 1) : 0;
      }
      C.set(c, v * 3);
      Gr.set([dens, len, g.tint], v * 3);
      // blades on this mesh (grass.js reads this grid where it is)
      grid.set([y, dens, len, 1], k);
    });
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    geo.setAttribute('aGround', new THREE.BufferAttribute(Gr, 3));
    geo.setAttribute('aWater', new THREE.BufferAttribute(Wt, 1));
    geo.computeBoundingSphere();
    return { geo, grids };
  }
  const lerpC = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  // ---------- river ribbon: follows the meandering centreline ----------
  function buildRiver(stepNear = 0.6) {
    const zs = [];
    let z = 262; // to the terrain's end downstream
    while (z > -980) { zs.push(z); const dist = Math.abs(z - 10); z -= stepNear + dist * 0.012; }
    const across = 10;
    const pos = [], uv = [], riv = [], idx = [];
    let along = 0, prev = null;
    for (let i = 0; i < zs.length; i++) {
      const zz = zs[i], cxv = riverX(zz), hw = riverHW(zz) * 1.32;
      if (prev) along += hyp(cxv - prev[0], zz - prev[1]);
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
  const HB = { x0: -110, z0: -760, x1: 110, z1: 264 };
  function buildDepthMap(rocks = []) {
    const W = 256, H = 1024;
    const data = new Uint8Array(W * H * 4);
    const depths = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const x = HB.x0 + ((i + 0.5) / W) * (HB.x1 - HB.x0);
      const z = HB.z0 + ((j + 0.5) / H) * (HB.z1 - HB.z0);
      // only the river's channel goes under water (the bed rises to the bank by 1.22 half-widths)
      depths[j * W + i] = Math.abs(x - riverX(z)) > riverHW(z) * 1.3 ? 0 : Math.max(0, -height(x, z));
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
        const dist = hyp(dx, dz), dd = dist / R;
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
  return { N, height, heightField, zoneAt, padAt, padDist, BUILDINGS, ground, LANES, CLEAR, laneDist, LANES, ZONES, heightFast, buildHeightCache, heightCacheData: () => HC.data, computeHeightCache, setHeightCache, riverX, riverHW, riverInfo, flowDir, buildTerrain, buildFields, buildRiver, buildDepthMap, peak: { x: peakX, z: peakZ, R: fujiR }, temple, templeDist, grove };
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
