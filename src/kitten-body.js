// Kitten body, modelled in code. The torso, legs and head are a signed-distance sculpt (ellipsoids and tapered
// capsules blended smoothly) meshed by surface nets and skinned to a skeleton by each vertex's distance to the
// bones' shapes. Ears and tail are parametric surfaces, the eyes spheres. Units are metres (a ~4-month kitten),
// kitten space: +z forward, +y up, the ground at y = 0. Worker-safe: plain arrays out, no three.js.

// skeleton: rest joint positions; `parent` gives the forward-kinematics chain (kitten.js)
const B = [
  ['root', -1, 0, 0, 0],
  ['pelvis', 0, 0, 0.122, -0.076], ['spine', 1, 0, 0.126, -0.018], ['chest', 2, 0, 0.128, 0.045],
  ['neck', 3, 0, 0.15, 0.088], ['head', 4, 0, 0.18, 0.118],
  ['earL', 5, 0.027, 0.234, 0.134], ['earR', 5, -0.027, 0.234, 0.134],
  ['eyeL', 5, 0.022, 0.205, 0.1685], ['eyeR', 5, -0.022, 0.205, 0.1685],
  ['armL', 3, 0.03, 0.118, 0.068], ['foreL', 10, 0.03, 0.068, 0.06], ['fpawL', 11, 0.03, 0.018, 0.066],
  ['armR', 3, -0.03, 0.118, 0.068], ['foreR', 13, -0.03, 0.068, 0.06], ['fpawR', 14, -0.03, 0.018, 0.066],
  ['thighL', 1, 0.032, 0.118, -0.08], ['shinL', 16, 0.034, 0.08, -0.047], ['metaL', 17, 0.032, 0.04, -0.094], ['hpawL', 18, 0.032, 0.011, -0.083],
  ['thighR', 1, -0.032, 0.118, -0.08], ['shinR', 20, -0.034, 0.08, -0.047], ['metaR', 21, -0.032, 0.04, -0.094], ['hpawR', 22, -0.032, 0.011, -0.083],
];
export const TAIL_N = 6, TAIL_SEG = 0.031;
for (let i = 0; i < TAIL_N; i++) B.push([`tail${i}`, i ? B.length - 1 : 1, 0, 0.132, -0.108 - i * TAIL_SEG]);
export const BONES = B.map(([name, parent, x, y, z]) => ({ name, parent, p: [x, y, z] }));
export const BONE = Object.fromEntries(BONES.map((b, i) => [b.name, i]));

// ---------- sculpt ----------
// e: ellipsoid [cx, cy, cz, rx, ry, rz]; c: tapered capsule [ax, ay, az, bx, by, bz, ra, rb]; k: blend radius
const SHAPES = [];
const shape = (bone, type, v, k, sub = false) => SHAPES.push({ bone: BONE[bone], type, v, k, sub });
const pair = (bone, type, v, k, sub) => {
  shape(bone + 'L', type, v, k, sub);
  const m = v.slice(); m[0] = -m[0]; if (type === 'c') m[3] = -m[3];
  shape(bone + 'R', type, m, k, sub);
};
shape('pelvis', 'e', [0, 0.127, -0.078, 0.048, 0.049, 0.05], 0);
shape('spine', 'e', [0, 0.12, -0.02, 0.051, 0.052, 0.062], 0.03);
shape('chest', 'e', [0, 0.13, 0.045, 0.046, 0.055, 0.055], 0.03);
shape('neck', 'c', [0, 0.145, 0.083, 0, 0.18, 0.12, 0.032, 0.03], 0.022);
shape('head', 'e', [0, 0.205, 0.14, 0.046, 0.041, 0.043], 0.02);
shape('head', 'e', [0.018, 0.197, 0.155, 0.02, 0.015, 0.019], 0.018);
shape('head', 'e', [-0.018, 0.197, 0.155, 0.02, 0.015, 0.019], 0.018);
shape('head', 'e', [0.0075, 0.192, 0.171, 0.009, 0.0078, 0.0085], 0.008); // whisker pads
shape('head', 'e', [-0.0075, 0.192, 0.171, 0.009, 0.0078, 0.0085], 0.008);
shape('head', 'e', [0, 0.199, 0.171, 0.0095, 0.0095, 0.011], 0.012);
shape('head', 'e', [0, 0.1855, 0.166, 0.0075, 0.0055, 0.0085], 0.01);
pair('arm', 'c', [0.03, 0.121, 0.067, 0.03, 0.068, 0.06, 0.02, 0.015], 0.022);
pair('fore', 'c', [0.03, 0.068, 0.06, 0.03, 0.018, 0.066, 0.0145, 0.0125], 0.009);
pair('fpaw', 'e', [0.03, 0.0115, 0.077, 0.0135, 0.0105, 0.0165], 0.009);
pair('thigh', 'c', [0.032, 0.121, -0.08, 0.034, 0.08, -0.047, 0.028, 0.018], 0.022);
pair('shin', 'c', [0.034, 0.08, -0.047, 0.032, 0.04, -0.094, 0.016, 0.0115], 0.009);
pair('meta', 'c', [0.032, 0.04, -0.094, 0.032, 0.011, -0.083, 0.011, 0.0102], 0.007);
pair('hpaw', 'e', [0.032, 0.0105, -0.071, 0.0125, 0.01, 0.0165], 0.009);
// eye sockets (the eyeballs sit in them)
export const EYE = { x: 0.022, y: 0.205, z: 0.1685, r: 0.0124, yaw: 0.34 };
shape('head', 'e', [EYE.x, EYE.y, EYE.z, 0.0112, 0.0112, 0.0112], 0.003, true);
shape('head', 'e', [-EYE.x, EYE.y, EYE.z, 0.0112, 0.0112, 0.0112], 0.003, true);

// bounding sphere per shape, for skipping shapes that cannot change the blended distance
for (const s of SHAPES) {
  const v = s.v;
  if (s.type === 'e') { s.cx = v[0]; s.cy = v[1]; s.cz = v[2]; s.R = Math.max(v[3], v[4], v[5]); }
  else { s.cx = (v[0] + v[3]) / 2; s.cy = (v[1] + v[4]) / 2; s.cz = (v[2] + v[5]) / 2; s.R = Math.hypot(v[3] - v[0], v[4] - v[1], v[5] - v[2]) / 2 + Math.max(v[6], v[7]); }
}

function shapeDist(s, x, y, z) {
  const v = s.v;
  if (s.type === 'e') {
    const px = x - v[0], py = y - v[1], pz = z - v[2];
    const ax = px / v[3], ay = py / v[4], az = pz / v[5], bx = ax / v[3], by = ay / v[4], bz = az / v[5];
    const k0 = Math.sqrt(ax * ax + ay * ay + az * az), k1 = Math.sqrt(bx * bx + by * by + bz * bz);
    return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(v[3], v[4], v[5]);
  }
  const bx = v[3] - v[0], by = v[4] - v[1], bz = v[5] - v[2];
  const px = x - v[0], py = y - v[1], pz = z - v[2];
  const t = Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / (bx * bx + by * by + bz * bz)));
  const qx = px - bx * t, qy = py - by * t, qz = pz - bz * t;
  return Math.sqrt(qx * qx + qy * qy + qz * qz) - (v[6] + (v[7] - v[6]) * t);
}

const smin = (a, b, k) => {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

const subReach = (d, k) => k - d; // a subtracted shape changes the distance only where it is nearer than this

function sdf(x, y, z) {
  let d = 1e9;
  for (const s of SHAPES) {
    const dx = x - s.cx, dy = y - s.cy, dz = z - s.cz;
    const lb = Math.sqrt(dx * dx + dy * dy + dz * dz) - s.R; // lower bound of this shape's distance
    if (s.sub) { if (lb < subReach(d, s.k)) d = -smin(-d, shapeDist(s, x, y, z), s.k); continue; }
    if (lb > d + s.k) continue;
    d = smin(d, shapeDist(s, x, y, z), s.k);
  }
  return d;
}

// surface nets over a grid of cell size h -> positions, normals, triangles
function surfaceNets(h) {
  const x0 = -0.075, y0 = -0.006, z0 = -0.14, x1 = 0.075, y1 = 0.255, z1 = 0.2;
  const nx = Math.ceil((x1 - x0) / h) + 1, ny = Math.ceil((y1 - y0) / h) + 1, nz = Math.ceil((z1 - z0) / h) + 1;
  const F = new Float32Array(nx * ny * nz);
  const id = (i, j, k) => i + nx * (j + ny * k);
  // a coarse pass first: blocks whose centre is far from the surface only need its sign
  const C = 4, far = C * h * 1.2;
  for (let k0 = 0; k0 < nz; k0 += C) for (let j0 = 0; j0 < ny; j0 += C) for (let i0 = 0; i0 < nx; i0 += C) {
    const d = sdf(x0 + (i0 + C / 2) * h, y0 + (j0 + C / 2) * h, z0 + (k0 + C / 2) * h);
    const exact = Math.abs(d) < far;
    for (let k = k0; k < Math.min(nz, k0 + C); k++) for (let j = j0; j < Math.min(ny, j0 + C); j++) for (let i = i0; i < Math.min(nx, i0 + C); i++) {
      F[id(i, j, k)] = exact ? sdf(x0 + i * h, y0 + j * h, z0 + k * h) : d;
    }
  }
  const cellV = new Int32Array(nx * ny * nz).fill(-1);
  const P = [];
  const E = [[0, 0, 0, 1, 0, 0], [0, 1, 0, 1, 1, 0], [0, 0, 1, 1, 0, 1], [0, 1, 1, 1, 1, 1], [0, 0, 0, 0, 1, 0], [1, 0, 0, 1, 1, 0],
    [0, 0, 1, 0, 1, 1], [1, 0, 1, 1, 1, 1], [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [0, 1, 0, 0, 1, 1], [1, 1, 0, 1, 1, 1]];
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const e of E) {
      const a = F[id(i + e[0], j + e[1], k + e[2])], b = F[id(i + e[3], j + e[4], k + e[5])];
      if ((a < 0) === (b < 0)) continue;
      const t = a / (a - b);
      sx += e[0] + (e[3] - e[0]) * t; sy += e[1] + (e[4] - e[1]) * t; sz += e[2] + (e[5] - e[2]) * t; n++;
    }
    if (!n) continue;
    cellV[id(i, j, k)] = P.length / 3;
    P.push(x0 + (i + sx / n) * h, y0 + (j + sy / n) * h, z0 + (k + sz / n) * h);
  }
  const I = [];
  const quad = (a, b, c, d, flip) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) I.push(a, c, b, a, d, c); else I.push(a, b, c, a, c, d); };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const inside = F[id(i, j, k)] < 0;
    if (inside !== (F[id(i + 1, j, k)] < 0)) quad(cellV[id(i, j - 1, k - 1)], cellV[id(i, j, k - 1)], cellV[id(i, j, k)], cellV[id(i, j - 1, k)], !inside);
    if (inside !== (F[id(i, j + 1, k)] < 0)) quad(cellV[id(i - 1, j, k - 1)], cellV[id(i - 1, j, k)], cellV[id(i, j, k)], cellV[id(i, j, k - 1)], !inside);
    if (inside !== (F[id(i, j, k + 1)] < 0)) quad(cellV[id(i - 1, j - 1, k)], cellV[id(i, j - 1, k)], cellV[id(i, j, k)], cellV[id(i - 1, j, k)], !inside);
  }
  // pull the vertices onto the surface and take normals from the distance gradient
  // (tetrahedral samples: the mean is the distance, the differences the gradient)
  const N = new Float32Array(P.length), e = h * 0.3;
  for (let v = 0; v < P.length; v += 3) {
    let x = P[v], y = P[v + 1], z = P[v + 2], gx = 0, gy = 0, gz = 0;
    for (let it = 0; it < 3; it++) {
      const a = sdf(x + e, y - e, z - e), b = sdf(x - e, y - e, z + e), c = sdf(x - e, y + e, z - e), d = sdf(x + e, y + e, z + e);
      gx = a - b - c + d; gy = -a - b + c + d; gz = -a + b - c + d;
      const g2 = (gx * gx + gy * gy + gz * gz) / (16 * e * e), dist = (a + b + c + d) / 4;
      if (it < 2 && g2 > 1e-6) { const s = dist / g2 / (4 * e); x -= gx * s; y -= gy * s; z -= gz * s; }
    }
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
    P[v] = x; P[v + 1] = y; P[v + 2] = z; N[v] = gx / l; N[v + 1] = gy / l; N[v + 2] = gz / l;
  }
  orient(P, N, I);
  return { P, N: Array.from(N), I };
}

// wind every triangle outwards (along its vertex normals)
function orient(P, N, I) {
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
    if (fx * (N[a] + N[b] + N[c]) + fy * (N[a + 1] + N[b + 1] + N[c + 1]) + fz * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) { const s = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = s; }
  }
}

// ---------- mesh builder ----------
function builder() {
  const m = { P: [], N: [], SI: [], SW: [], MK: [], I: [] };
  m.vert = (p, n, bones, mark) => {
    const k = m.P.length / 3;
    m.P.push(p[0], p[1], p[2]); m.N.push(n[0], n[1], n[2]);
    for (let i = 0; i < 4; i++) { m.SI.push(bones[i] ? bones[i][0] : 0); m.SW.push(bones[i] ? bones[i][1] : 0); }
    m.MK.push(mark[0], mark[1]);
    return k;
  };
  return m;
}

// skin weights from the distance to each bone's shapes: a soft minimum, four strongest bones
function skinBody(x, y, z) {
  const best = new Map();
  for (const s of SHAPES) {
    if (s.sub) continue;
    const d = shapeDist(s, x, y, z);
    if (!best.has(s.bone) || d < best.get(s.bone)) best.set(s.bone, d);
  }
  let dmin = Infinity;
  for (const d of best.values()) dmin = Math.min(dmin, d);
  const w = [...best.entries()].map(([b, d]) => [b, Math.exp(-(d - dmin) / 0.0065)]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const keep = w.filter((a, i) => i === 0 || a[1] > 0.004 * w[0][1]);
  const sum = keep.reduce((s, a) => s + a[1], 0);
  return keep.map(([b, v]) => [b, v / sum]);
}

// tail: a tapered tube along the tail bones (rest pose: straight back), rounded at the tip
function addTail(m) {
  const ring = 12, rows = 30, z0 = BONES[BONE.tail0].p[2] + 0.02, len = TAIL_N * TAIL_SEG + 0.02, y = BONES[BONE.tail0].p[1];
  const base = m.P.length / 3;
  for (let r = 0; r <= rows; r++) {
    const t = r / rows, z = z0 - t * len;
    const tip = Math.max(0, (t - 0.92) / 0.08);
    const rad = (0.0165 - 0.005 * t) * Math.sqrt(Math.max(0, 1 - tip * tip)) + 0.0004;
    const zz = z - (tip > 0 ? 0.004 * tip : 0);
    // bones: position along the chain
    const f = (BONES[BONE.tail0].p[2] - zz) / TAIL_SEG;
    let bones;
    if (f < 0) { const w = Math.min(1, -f * 2); bones = [[BONE.tail0, 1 - w * 0.5], [BONE.pelvis, w * 0.5]]; }
    else { const i = Math.min(TAIL_N - 1, Math.floor(f)), g = Math.min(1, f - i); bones = i < TAIL_N - 1 ? [[BONE.tail0 + i, 1 - g], [BONE.tail0 + i + 1, g]] : [[BONE.tail0 + i, 1]]; }
    for (let s = 0; s <= ring; s++) {
      const a = (s / ring) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      const nz = tip > 0 ? -tip : 0, nl = Math.sqrt(1 - nz * nz);
      m.vert([c * rad, y + sn * rad, zz], [c * nl, sn * nl, nz], bones, [0, 1.35]);
    }
  }
  for (let r = 0; r < rows; r++) for (let s = 0; s < ring; s++) {
    const a = base + r * (ring + 1) + s, b = a + ring + 1;
    m.I.push(a, a + 1, b, b, a + 1, b + 1);
  }
}

// ears: a cupped triangle opening forward, a back and a front sheet that meet at the rim (front: pink inside)
function addEar(m, side) {
  const bone = side > 0 ? BONE.earL : BONE.earR, bp = BONES[bone].p;
  const W = 0.02, H = 0.038, depth = 0.011;
  const tilt = 0.36, yaw = 0.42 * side; // leaning outwards, turned a little out
  const up = [Math.sin(tilt) * side, Math.cos(tilt), -0.1], fw = [Math.sin(yaw), 0, Math.cos(yaw)];
  const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const U = norm(up), F0 = norm(fw);
  const S = norm([U[1] * F0[2] - U[2] * F0[1], U[2] * F0[0] - U[0] * F0[2], U[0] * F0[1] - U[1] * F0[0]]);
  const F = [S[1] * U[2] - S[2] * U[1], S[2] * U[0] - S[0] * U[2], S[0] * U[1] - S[1] * U[0]];
  const cols = 10, rows = 10;
  const pt = (u, v, sheet) => {
    const w = W * (1 - Math.pow(Math.max(v, 0), 1.15)) * (1 + 0.15 * Math.sin(Math.PI * Math.max(v, 0)));
    const cup = (1 - u * u) * depth * (1 - Math.max(v, 0) * 0.7);
    const thick = sheet * 0.0042 * (1 - u * u) * (1 - Math.max(v, 0));
    const a = u * w, b = v * H, c = -cup + thick;
    return [bp[0] + S[0] * a + U[0] * b + F[0] * c, bp[1] + S[1] * a + U[1] * b + F[1] * c, bp[2] + S[2] * a + U[2] * b + F[2] * c];
  };
  for (const sheet of [0, 1]) {
    const base = m.P.length / 3;
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const u = (c / cols) * 2 - 1, v = -0.3 + (r / rows) * 1.3;
      const p = pt(u, v, sheet), du = 0.01, dv = 0.01;
      const pu = pt(Math.min(1, u + du), v, sheet), pu0 = pt(Math.max(-1, u - du), v, sheet), pv = pt(u, v + dv, sheet), pv0 = pt(u, v - dv, sheet);
      const tu = [pu[0] - pu0[0], pu[1] - pu0[1], pu[2] - pu0[2]], tv = [pv[0] - pv0[0], pv[1] - pv0[1], pv[2] - pv0[2]];
      let n = norm([tu[1] * tv[2] - tu[2] * tv[1], tu[2] * tv[0] - tu[0] * tv[2], tu[0] * tv[1] - tu[1] * tv[0]]);
      const want = sheet ? 1 : -1; // front sheet faces forward, back sheet backward
      if (n[0] * F[0] + n[1] * F[1] + n[2] * F[2] < 0 !== want < 0) n = n.map((x) => -x);
      const we = Math.min(1, Math.max(0, (v + 0.3) / 0.4));
      const inner = sheet ? Math.max(0, 1 - Math.pow(Math.abs(u) / 0.8, 4)) * Math.min(1, (1 - v) * 3) * Math.min(1, (v + 0.1) * 5) : 0;
      m.vert(p, n, [[bone, we], [BONE.head, 1 - we]], [Math.max(0, inner), sheet ? 0.55 : 0.4]);
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const a = base + r * (cols + 1) + c, b = a + cols + 1;
      m.I.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
}

// the body: sculpt + tail + ears. `h`: grid cell size (smaller: finer mesh)
export function kittenBodyData(h = 0.0034) {
  const m = builder();
  const s = surfaceNets(h);
  for (let v = 0; v < s.P.length; v += 3) {
    const x = s.P[v], y = s.P[v + 1], z = s.P[v + 2];
    m.vert([x, y, z], [s.N[v], s.N[v + 1], s.N[v + 2]], skinBody(x, y, z), [0, 1]);
  }
  for (const i of s.I) m.I.push(i);
  addTail(m);
  addEar(m, 1); addEar(m, -1);
  orient(m.P, m.N, m.I);
  return {
    position: new Float32Array(m.P), normal: new Float32Array(m.N), skinIndex: new Uint16Array(m.SI), skinWeight: new Float32Array(m.SW),
    mark: new Float32Array(m.MK), index: new Uint32Array(m.I),
  };
}

// eyeballs: spheres around each eye's forward axis; aEye holds the point in the eye's own frame (z: forward)
export function kittenEyeData() {
  const P = [], N = [], SI = [], SW = [], EY = [], I = [];
  const rings = 14, segs = 18;
  for (const side of [1, -1]) {
    const bone = side > 0 ? BONE.eyeL : BONE.eyeR, c = BONES[bone].p, yaw = EYE.yaw * side;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const base = P.length / 3;
    for (let r = 0; r <= rings; r++) {
      const th = (r / rings) * Math.PI; // 0: front pole
      for (let s = 0; s <= segs; s++) {
        const ph = (s / segs) * Math.PI * 2;
        const ex = Math.sin(th) * Math.cos(ph), ey = Math.sin(th) * Math.sin(ph), ez = Math.cos(th);
        const wx = ex * cy + ez * sy, wz = -ex * sy + ez * cy; // eye frame -> kitten space (turned out by yaw)
        P.push(c[0] + wx * EYE.r, c[1] + ey * EYE.r, c[2] + wz * EYE.r);
        N.push(wx, ey, wz);
        SI.push(bone, 0, 0, 0); SW.push(1, 0, 0, 0);
        EY.push(ex * side, ey, ez);
      }
    }
    for (let r = 0; r < rings; r++) for (let s = 0; s < segs; s++) {
      const a = base + r * (segs + 1) + s, b = a + segs + 1;
      I.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { position: new Float32Array(P), normal: new Float32Array(N), skinIndex: new Uint16Array(SI), skinWeight: new Float32Array(SW), eye: new Float32Array(EY), index: new Uint32Array(I) };
}

// whiskers: thin tapered ribbons fanning out of the whisker pads, drooping a little (skinned to the head)
export function kittenWhiskerData() {
  const P = [], N = [], SI = [], SW = [], I = [];
  for (const side of [1, -1]) for (let k = 0; k < 5; k++) {
    const y0 = 0.1935 - k * 0.0018, a = (0.25 - k * 0.12) , len = 0.042 - Math.abs(k - 1.5) * 0.004;
    const base = P.length / 3, segs = 6;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, r = len * t;
      const x = side * (0.0085 + r * Math.cos(0.35) * 0.95), y = y0 + r * Math.sin(a) - 0.25 * r * r / len * 0.4, z = 0.176 + 0.004 * (1 - t) - r * 0.3;
      const w = 0.00045 * (1 - t) + 0.00008;
      // two crossed ribbons, so a whisker shows from the front and from the side
      P.push(x, y + w, z, x, y - w, z, x, y, z + w, x, y, z - w);
      N.push(0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0);
      for (let j = 0; j < 4; j++) { SI.push(BONE.head, 0, 0, 0); SW.push(1, 0, 0, 0); }
      if (i < segs) for (const o of [0, 2]) { const b = base + i * 4 + o; I.push(b, b + 1, b + 4, b + 1, b + 5, b + 4); }
    }
  }
  return { position: new Float32Array(P), normal: new Float32Array(N), skinIndex: new Uint16Array(SI), skinWeight: new Float32Array(SW), index: new Uint32Array(I) };
}
