// Old temple on the knoll across the river (world.temple): a stone-walled terrace with a five-storey pagoda, a main
// hall under a hip-and-gable (irimoya) roof, a bell tower, ochre boundary walls with five white lines, and stone
// lanterns along the approach. Weathered bengara wood, white plaster, ribbed grey tile, verdigris bronze. After dusk
// the hall's lattice doors and the lanterns' fireboxes glow (aGlow), and floodlights hidden in the gravel light the
// pagoda from below, as at a temple's spring light-up (materials.js templeMaterial, fx.js makeGlows).
// Generation only (runs in a worker).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, lerp } from './noise.js';

const V = THREE.Vector3;
const WOOD = [0.27, 0.1, 0.06], WOOD_D = [0.1, 0.07, 0.05], PLASTER = [0.8, 0.77, 0.7], TILE = [0.2, 0.21, 0.22], TILE_D = [0.11, 0.115, 0.12];
const ENDS = [0.8, 0.74, 0.58], BRONZE = [0.22, 0.36, 0.3], BRONZE_D = [0.16, 0.2, 0.15], STONE = [0.43, 0.41, 0.38], GRAVEL = [0.6, 0.58, 0.53];
const OCHRE = [0.62, 0.45, 0.22], PAPER = [0.86, 0.8, 0.66], FIREBOX = [0.5, 0.45, 0.38];

// parts in a local frame; at() places what its callback adds (lamps too)
function kit() {
  const parts = [], lamps = [];
  // indexed (a box is 24 vertices, not 36): one colour and glow per part
  const add = (g, c, glow = 0) => {
    g.deleteAttribute('uv');
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aGlow', new THREE.BufferAttribute(new Float32Array(n).fill(glow), 1));
    if (!g.index) g.setIndex([...Array(n).keys()]);
    if (!g.attributes.normal) g.computeVertexNormals();
    parts.push(g);
  };
  const box = (w, h, d, x, y, z, c, ry = 0, glow = 0) => add(new THREE.BoxGeometry(w, h, d).rotateY(ry).translate(x, y, z), c, glow);
  const beam = (a, b, w, h, c) => {
    const d = new V().subVectors(b, a);
    const g = new THREE.BoxGeometry(w, h, d.length());
    g.applyMatrix4(new THREE.Matrix4().lookAt(new V(), d, Math.abs(d.y) > 0.99 * d.length() ? new V(1, 0, 0) : new V(0, 1, 0)));
    const m = a.clone().add(b).multiplyScalar(0.5);
    add(g.translate(m.x, m.y, m.z), c);
  };
  const lathe = (prof, segs, c, y = 0, phi = 0, glow = 0) => add(new THREE.LatheGeometry(prof.map(([r, yy]) => new THREE.Vector2(r, yy + y)), segs, phi), c, glow);
  const at = (x, y, z, ry, fn) => {
    const n = parts.length, nl = lamps.length;
    fn();
    const m = new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z);
    for (let i = n; i < parts.length; i++) parts[i].applyMatrix4(m);
    for (let i = nl; i < lamps.length; i++) lamps[i].applyMatrix4(m);
  };
  return { parts, lamps, add, box, beam, lathe, at };
}

// A roof face: f(u, t) is the tiled surface for u 0 (eave) .. 1 (top) and t 0..1 along the eave. Rows of round tiles
// run down the slope as ribs; soff(p) is the soffit's height under p, and a fascia closes the eave.
function face(k, f, K, M, rib, soff) {
  const T = [], B = [];
  for (let i = 0; i <= K; i++) for (let m = 0; m <= M; m++) {
    const p = f(i / K, m / M);
    T.push(p.x, p.y + (m % 2) * rib, p.z);
    B.push(p.x, soff(p, i / K), p.z);
  }
  const grid = (P, up) => {
    const q = (i) => new V(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    const flip = (new V().subVectors(q(1), q(0)).cross(new V().subVectors(q(M + 1), q(0))).y > 0) !== up;
    const I = [];
    for (let i = 0; i < K; i++) for (let m = 0; m < M; m++) {
      const a = i * (M + 1) + m, b = a + 1, c = a + M + 1, d = c + 1;
      if (flip) I.push(a, c, b, b, c, d); else I.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setIndex(I);
    g.computeVertexNormals();
    return g;
  };
  k.add(grid(T, true), TILE);
  k.add(grid(B, false), WOOD);
  const F = [], I = [];
  for (let m = 0; m <= M; m++) F.push(T[m * 3], T[m * 3 + 1], T[m * 3 + 2], B[m * 3], B[m * 3 + 1], B[m * 3 + 2]);
  for (let m = 0; m < M; m++) I.push(m * 2, m * 2 + 1, m * 2 + 2, m * 2 + 1, m * 2 + 3, m * 2 + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(F, 3));
  g.setIndex(I);
  g.computeVertexNormals();
  k.add(g, WOOD_D);
}

// Hip roof over the eave rectangle ±a × ±b from height y0, rising H with a concave sweep and kicked-up corners.
// ridge: half-length of the top ridge (0: pyramid). gable: above that fraction of the slope the roof turns into
// an irimoya gable. Returns the height of the top.
function hipRoof(k, { y0, a, b, H, kick, ridge = 0, gable = 0, rib = 0.09, pitch = 0.5, thick = 0.4 }) {
  const C = [[-a, b], [a, b], [a, -b], [-a, -b]];
  const R = (c) => [Math.sign(c[0]) * ridge, 0];
  const uTop = gable || 1;
  const yAt = (u) => y0 + H * (1 - Math.pow(1 - u, 2.2));
  const lift = (t, u) => kick * Math.pow(Math.abs(2 * t - 1), 3.5) * Math.pow(1 - u, 3);
  const soff = (p) => y0 - thick + (p.y - y0) * 0.45;
  for (let e = 0; e < 4; e++) {
    const c0 = C[e], c1 = C[(e + 1) % 4], r0 = R(c0), r1 = R(c1);
    const M = 2 * Math.max(3, Math.round(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) / pitch));
    const f = (v, t) => {
      const u = v * uTop;
      return new V(lerp(lerp(c0[0], c1[0], t), lerp(r0[0], r1[0], t), u), yAt(u) + lift(t, u), lerp(lerp(c0[1], c1[1], t), lerp(r0[1], r1[1], t), u));
    };
    face(k, f, Math.max(4, Math.round(10 * uTop)), M, rib, soff);
    // hip ridge up the corner line, a ridge-end tile at the eave
    const n = 6;
    for (let i = 0; i < n; i++) k.beam(f(i / n, 0).add(new V(0, rib + 0.12, 0)), f((i + 1) / n, 0).add(new V(0, rib + 0.12, 0)), 0.3, 0.3, TILE_D);
    const c = f(0, 0);
    k.box(0.45, 0.5, 0.45, c.x * 0.99, c.y + 0.3, c.z * 0.99, TILE_D, Math.atan2(c.x, c.z));
  }
  if (!gable) {
    if (ridge > 0) k.box(2 * ridge + 0.6, 0.6, 0.5, 0, y0 + H + 0.25, 0, TILE_D);
    return y0 + H;
  }
  // irimoya: a gable over the hipped skirt, a plastered gable wall with struts, bargeboards and a main ridge with shibi
  const yg = yAt(gable), ax = lerp(a, ridge, gable), bz = b * (1 - gable);
  const X = ax + 0.5, rise = bz * 0.95, prof = (v) => 1 - Math.pow(1 - v, 1.3), top = yg + rise;
  const M = 2 * Math.round((2 * X) / 0.5);
  for (const s of [1, -1]) face(k, (v, t) => new V(lerp(-X, X, t), yg + rise * prof(v), s * bz * (1 - v)), 6, M, 0.09, (p) => p.y - 0.3);
  for (const s of [1, -1]) {
    const xw = s * (ax - 0.4);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([xw, yg, -bz * 0.97, xw, yg, bz * 0.97, xw, top - 0.15, 0], 3));
    tri.computeVertexNormals();
    k.add(tri, PLASTER);
    k.box(0.16, 0.22, 2 * bz, xw + s * 0.06, yg + 0.3, 0, WOOD);
    for (const zz of [-0.6, -0.3, 0, 0.3, 0.6]) k.beam(new V(xw + s * 0.06, yg, zz * bz), new V(xw + s * 0.06, yg + rise * prof(1 - Math.abs(zz)) - 0.15, zz * bz), 0.12, 0.12, WOOD);
    // bargeboards along both gable edges, the pendant (gegyo) at the peak, descending ridges on top
    const edge = (v, sz, dx, dy) => new V(s * (X + dx), yg + rise * prof(v) + dy, sz * bz * (1 - v));
    for (const sz of [1, -1]) for (let i = 0; i < 5; i++) {
      k.beam(edge(i / 5, sz, 0, -0.2), edge((i + 1) / 5, sz, 0, -0.2), 0.18, 0.55, WOOD_D);
      k.beam(edge(i / 5, sz, -0.35, 0.3), edge((i + 1) / 5, sz, -0.35, 0.3), 0.32, 0.32, TILE_D);
    }
    k.box(0.14, 0.9, 0.55, s * (X + 0.05), top - 0.7, 0, ENDS);
    // shibi: a dark tile fin curling up at each end of the main ridge
    for (let j = 0; j < 5; j++) k.box(0.36 - j * 0.03, 0.38, 0.4 - j * 0.04, s * (X - 0.3 + j * j * 0.035), top + 0.75 + j * 0.3, 0, TILE_D);
  }
  k.box(2 * X, 0.75, 0.55, 0, top + 0.3, 0, TILE_D);
  return top;
}

// rafters under the eaves, their ends painted white
function rafters(k, a, b, y0, kick, thick = 0.4, spacing = 0.55) {
  const C = [[-a, b], [a, b], [a, -b], [-a, -b]];
  for (let e = 0; e < 4; e++) {
    const c0 = C[e], c1 = C[(e + 1) % 4];
    const L = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
    const tx = (c1[0] - c0[0]) / L, tz = (c1[1] - c0[1]) / L, nx = -tz, nz = tx; // outward
    const n = Math.floor((L - 1.2) / spacing);
    for (let j = 0; j <= n; j++) {
      const s = 0.6 + (j * (L - 1.2)) / n, t = s / L;
      const y = y0 - thick - 0.1 + kick * Math.pow(Math.abs(2 * t - 1), 3.5) * 0.45;
      const px = c0[0] + tx * s, pz = c0[1] + tz * s;
      k.beam(new V(px - nx * 1.6, y + 0.1, pz - nz * 1.6), new V(px - nx * 0.2, y, pz - nz * 0.2), 0.15, 0.17, WOOD);
      k.add(new THREE.PlaneGeometry(0.16, 0.18).rotateY(Math.atan2(nx, nz)).translate(px - nx * 0.19, y - 0.005, pz - nz * 0.19), ENDS);
    }
  }
}

// three stepped courses of brackets (tokyō) over plaster, their block ends painted white
function brackets(k, hx, hz, y, n = 3) {
  k.box(2 * hx + 0.2, 0.3 * n, 2 * hz + 0.2, 0, y + 0.15 * n, 0, PLASTER);
  for (let j = 0; j < n; j++) {
    const ox = hx + 0.25 * (j + 1), oz = hz + 0.25 * (j + 1), yy = y + 0.3 * j + 0.17;
    k.box(2 * ox + 0.3, 0.14, 0.3, 0, yy, oz, WOOD); k.box(2 * ox + 0.3, 0.14, 0.3, 0, yy, -oz, WOOD);
    k.box(0.3, 0.14, 2 * oz, ox, yy, 0, WOOD); k.box(0.3, 0.14, 2 * oz, -ox, yy, 0, WOOD);
    if (j === n - 1) {
      for (let i = -2; i <= 2; i++) for (const s of [1, -1]) {
        k.box(0.22, 0.16, 0.22, (i * ox) / 2.2, yy - 0.15, s * (oz + 0.12), ENDS);
        k.box(0.22, 0.16, 0.22, s * (ox + 0.12), yy - 0.15, (i * oz) / 2.2, ENDS);
      }
    }
  }
}

// Timber-framed walls ±hx × ±hz from y, h tall: posts on the bay lines, plaster between, tie beams. fill(side, bay)
// picks each bay's infill: 'door' (plank), 'glow' (lattice doors over paper, lit from inside), 'window' (slatted).
// Sides: 0 front (+z), 1 right, 2 back, 3 left, bays counted clockwise seen from above.
function body(k, hx, hz, y, h, bx, bz, fill, core = 0) {
  k.box(2 * hx, h + core, 2 * hz, 0, y + (h + core) / 2, 0, PLASTER);
  const sides = [[-hx, hz, 1, 0, 2 * hx, bx], [hx, hz, 0, -1, 2 * hz, bz], [hx, -hz, -1, 0, 2 * hx, bx], [-hx, -hz, 0, 1, 2 * hz, bz]];
  sides.forEach(([ox, oz, tx, tz, L, nb], si) => {
    const nx = -tz, nz = tx, ry = Math.atan2(nx, nz);
    const P = (s, o) => [ox + tx * s + nx * o, oz + tz * s + nz * o];
    for (let j = 0; j < nb; j++) { const [px, pz] = P((L * j) / nb, 0.02); k.box(0.36, h, 0.36, px, y + h / 2, pz, WOOD); }
    for (const [yy, hh] of [[0.3, 0.3], [h - 0.25, 0.26], [h * 0.62, 0.16]]) { const [px, pz] = P(L / 2, 0.1); k.box(L + 0.36, hh, 0.14, px, y + yy, pz, WOOD, ry); }
    for (let j = 0; j < nb; j++) {
      const kind = fill(si, j), w = L / nb - 0.36;
      const [cx, cz] = P((L * (j + 0.5)) / nb, 0);
      const at = (o) => [cx + nx * o, cz + nz * o];
      if (kind === 'door') {
        const [px, pz] = at(0.07); k.box(w * 0.9, h * 0.58, 0.1, px, y + 0.45 + h * 0.29, pz, WOOD_D, ry);
      } else if (kind === 'glow') {
        const dh = h * 0.56, y0 = y + 0.45;
        const [px, pz] = at(0.04); k.box(w, dh, 0.06, px, y0 + dh / 2, pz, PAPER, ry, 1);
        const [lx, lz] = at(0.1);
        const nv = Math.round(w / 0.3), nh = Math.round(dh / 0.3);
        for (let i = 1; i < nv; i++) { const s = (i / nv - 0.5) * w; k.box(0.05, dh, 0.05, lx + tx * s, y0 + dh / 2, lz + tz * s, WOOD_D, ry); }
        for (let i = 1; i < nh; i++) k.box(w, 0.05, 0.05, lx, y0 + (i * dh) / nh, lz, WOOD_D, ry);
        k.box(0.07, dh, 0.07, lx, y0 + dh / 2, lz, WOOD_D, ry);
      } else if (kind === 'window') {
        const wy = y + h * 0.38;
        const [px, pz] = at(0.05); k.box(w * 0.6, h * 0.22, 0.08, px, wy, pz, WOOD_D, ry);
        const [lx, lz] = at(0.1);
        for (let i = 0; i < 7; i++) { const s = ((i + 0.5) / 7 - 0.5) * w * 0.56; k.box(0.07, h * 0.2, 0.07, lx + tx * s, wy, lz + tz * s, WOOD, ry); }
      }
    }
  });
}

// the balcony round an upper storey of the pagoda
function balcony(k, s, y) {
  const r = s + 0.85;
  k.box(2 * r, 0.18, 2 * r, 0, y - 0.09, 0, WOOD);
  for (const [ry, sx, sz] of [[0, 0, 1], [0, 0, -1], [Math.PI / 2, 1, 0], [Math.PI / 2, -1, 0]]) {
    for (const yy of [0.4, 0.8]) k.box(2 * r, 0.08, 0.08, sx * r, y + yy, sz * r, WOOD, ry);
    for (let i = 0; i <= 6; i++) { const t = (i / 6 - 0.5) * 2 * r; k.box(0.1, 0.85, 0.1, sx * r + Math.abs(sz) * t, y + 0.42, sz * r + Math.abs(sx) * t, WOOD); }
  }
}

// wind bells hung from the four corners of an eave
function bells(k, a, y) {
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    k.at(sx * a * 0.97, y, sz * a * 0.97, 0, () => k.lathe([[0, -0.5], [0.12, -0.5], [0.13, -0.45], [0.1, -0.2], [0.03, -0.15], [0.02, 0], [0, 0]], 6, BRONZE));
  }
}

function pagoda(k) {
  k.box(11.6, 1.0, 11.6, 0, 0.5, 0, STONE);
  for (let j = 0; j < 3; j++) k.box(2.8, 0.75 - 0.25 * j, 0.4, 0, (0.75 - 0.25 * j) / 2, 6.0 + 0.4 * j, STONE);
  const S = [3.4, 3.1, 2.8, 2.5, 2.2];
  let y = 1.0;
  for (let i = 0; i < 5; i++) {
    const s = S[i], h = i ? 2.5 : 3.4;
    if (i) balcony(k, s, y);
    body(k, s, s, y, h, 3, 3, (side, j) => (j === 1 ? 'door' : i === 0 ? 'window' : 'wall'), 1.2);
    brackets(k, s, s, y + h);
    const a = s + 2.5, y0 = y + h + 0.45, kick = 1.05;
    rafters(k, a, a, y0, kick);
    bells(k, a, y0 + kick * 0.45 - 0.45);
    if (i < 4) {
      const H = 2.2, u = 1 - (S[i + 1] + 0.85) / a;
      hipRoof(k, { y0, a, b: a, H, kick });
      y = y0 + H * (1 - Math.pow(1 - u, 2.2)) + 0.12;
    } else sorin(k, hipRoof(k, { y0, a, b: a, H: 2.9, kick }) - 0.3);
  }
}

// the bronze finial: base, inverted bowl, nine rings, the water-flame openwork and the jewel
function sorin(k, y) {
  k.box(1.5, 0.5, 1.5, 0, y + 0.25, 0, BRONZE);
  k.lathe([[0, 0], [0.75, 0], [0.72, 0.3], [0.5, 0.52], [0, 0.56]], 12, BRONZE, y + 0.5);
  const P = [[0, 1.0], [0.14, 1.0]];
  for (let i = 0; i < 9; i++) { const yy = 1.25 + i * 0.5, r = 0.55 - i * 0.02; P.push([0.14, yy], [r, yy + 0.06], [r, yy + 0.18], [0.14, yy + 0.24]); }
  P.push([0.12, 6.0], [0.12, 7.3], [0, 7.3]);
  k.lathe(P, 12, BRONZE, y);
  k.box(1.0, 1.1, 0.05, 0, y + 6.25, 0, BRONZE); k.box(0.05, 1.1, 1.0, 0, y + 6.25, 0, BRONZE);
  k.lathe([[0, 0], [0.2, 0.08], [0.26, 0.26], [0.2, 0.44], [0, 0.5]], 10, BRONZE, y + 6.9);
  k.lathe([[0, 0], [0.16, 0.08], [0.19, 0.22], [0.1, 0.4], [0, 0.55]], 10, BRONZE, y + 7.4);
}

// a lantern's hexagonal cap from y, R across the corners, with the corners kicked up
function kasa(k, R, H, y, c) {
  k.lathe([[0, -0.05], [R * 0.98, -0.05], [R, 0.04], [R * 0.75, H * 0.28], [R * 0.3, H * 0.75], [0, H]], 6, c, y);
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; k.box(R * 0.14, R * 0.2, R * 0.14, Math.sin(a) * R * 0.96, y + R * 0.08, Math.cos(a) * R * 0.96, c, a); }
}

// hanging bronze lantern (tsuri-dōrō); yTop is where its chain is fixed
function tsuri(k, x, yTop, z) {
  k.at(x, yTop, z, 0, () => {
    k.box(0.04, 0.5, 0.04, 0, -0.25, 0, BRONZE_D);
    kasa(k, 0.36, 0.24, -0.74, BRONZE);
    k.lathe([[0, -1.2], [0.2, -1.2], [0.23, -0.74], [0, -0.74]], 6, PAPER, 0, 0, 1.6);
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; k.box(0.04, 0.46, 0.04, Math.sin(a) * 0.23, -0.97, Math.cos(a) * 0.23, BRONZE); }
    k.lathe([[0, -1.3], [0.25, -1.26], [0.22, -1.2], [0, -1.2]], 6, BRONZE);
    k.lamps.push(new V(0, -0.97, 0));
  });
}

// stone lantern (Kasuga form) standing at (x, y, z)
function toro(k, x, y, z, ry = 0) {
  k.at(x, y, z, ry, () => {
    k.lathe([[0, 0], [0.42, 0], [0.42, 0.12], [0.34, 0.2], [0.2, 0.26], [0, 0.26]], 6, STONE);
    k.lathe([[0, 0.26], [0.14, 0.26], [0.12, 1.02], [0, 1.02]], 8, STONE);
    k.lathe([[0, 1.02], [0.2, 1.02], [0.36, 1.14], [0.36, 1.22], [0, 1.22]], 6, STONE);
    k.lathe([[0, 1.22], [0.21, 1.22], [0.21, 1.6], [0, 1.6]], 6, FIREBOX, 0, Math.PI / 6, 2.2);
    for (let i = 0; i < 6; i++) { const a = ((i + 0.5) / 6) * Math.PI * 2; k.box(0.08, 0.38, 0.08, Math.sin(a) * 0.24, 1.41, Math.cos(a) * 0.24, STONE); }
    kasa(k, 0.62, 0.36, 1.6, STONE);
    k.lathe([[0, 0], [0.1, 0.02], [0.13, 0.1], [0.08, 0.2], [0, 0.28]], 8, STONE, 1.9);
    k.lamps.push(new V(0, 1.41, 0));
  });
}

function hall(k) {
  // stone podium with a landing and steps at the front, raised floor with a veranda, wooden steps up to it
  k.box(16, 0.8, 12.8, 0, 0.4, 0, STONE);
  k.box(4.4, 0.8, 1.2, 0, 0.4, 7.0, STONE);
  for (let j = 0; j < 2; j++) { const hh = (0.8 * (2 - j)) / 3; k.box(4.4, hh, 0.45, 0, hh / 2, 7.82 + 0.45 * j, STONE); }
  const y0 = 1.5;
  k.box(14.4, 0.7, 11.2, 0, 1.15, 0, WOOD_D);
  k.box(15.2, 0.16, 12.0, 0, y0 - 0.08, 0, WOOD);
  for (let j = 0; j < 3; j++) { const t = y0 - 0.18 * (j + 1); k.box(3.6, t - 0.8, 0.3, 0, (t + 0.8) / 2, 6.15 + 0.3 * j, WOOD); }
  body(k, 6.2, 4.4, y0, 4.0, 5, 4, (side, j) => {
    if (side === 0) return j >= 1 && j <= 3 ? 'glow' : 'window';
    if ((side === 1 && j === 0) || (side === 3 && j === 3)) return 'glow';
    return side === 2 && j === 2 ? 'door' : 'wall';
  }, 2.2);
  // veranda railing, open at the front steps
  for (const s of [1, -1]) {
    k.box(5.6, 0.08, 0.08, s * 4.8, y0 + 0.75, 5.95, WOOD);
    k.box(0.08, 0.08, 11.9, s * 7.55, y0 + 0.75, 0, WOOD);
    for (let i = 0; i <= 4; i++) k.box(0.1, 0.8, 0.1, s * (2.0 + i * 1.39), y0 + 0.4, 5.95, WOOD);
    for (let i = 0; i <= 6; i++) k.box(0.1, 0.8, 0.1, s * 7.55, y0 + 0.4, -5.95 + i * 1.98, WOOD);
  }
  brackets(k, 6.2, 4.4, y0 + 4.0);
  const r0 = y0 + 4.0 + 0.45;
  rafters(k, 9.2, 7.4, r0, 0.9);
  hipRoof(k, { y0: r0, a: 9.2, b: 7.4, H: 5.4, kick: 0.9, ridge: 2.0, gable: 0.55 });
  for (const x of [-2.6, 2.6]) tsuri(k, x, r0 + 0.75, 5.5);
}

// bell tower: boarded splayed skirt, open upper storey with the bell and its striking log
function belfry(k) {
  k.box(5.6, 0.8, 5.6, 0, 0.4, 0, STONE);
  k.lathe([[0, 0.8], [2.35 * Math.SQRT2, 0.8], [1.95 * Math.SQRT2, 3.0], [0, 3.0]], 4, WOOD, 0, Math.PI / 4);
  for (let i = 0; i < 9; i++) for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const t = (i / 8 - 0.5) * 3.8;
    k.beam(new V(sx * 2.37 + sz * t * 1.2, 0.8, sz * 2.37 + sx * t * 1.2), new V(sx * 1.97 + sz * t, 3.0, sz * 1.97 + sx * t), 0.06, 0.06, WOOD_D);
  }
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) k.beam(new V(sx * 1.95, 3.0, sz * 1.95), new V(sx * 1.75, 6.4, sz * 1.75), 0.3, 0.3, WOOD);
  for (const yy of [3.15, 5.9]) {
    k.box(3.8, 0.2, 0.2, 0, yy, 1.8, WOOD); k.box(3.8, 0.2, 0.2, 0, yy, -1.8, WOOD);
    k.box(0.2, 0.2, 3.8, 1.8, yy, 0, WOOD); k.box(0.2, 0.2, 3.8, -1.8, yy, 0, WOOD);
  }
  k.box(3.6, 0.3, 0.3, 0, 6.25, 0, WOOD);
  k.lathe([[0, 0], [0.72, 0], [0.7, 0.15], [0.62, 0.4], [0.6, 1.2], [0.55, 1.45], [0.3, 1.6], [0.12, 1.65], [0.12, 1.85], [0, 1.85]], 16, BRONZE_D, 4.25);
  k.beam(new V(0.85, 4.95, 0), new V(2.5, 4.95, 0), 0.24, 0.24, WOOD);
  for (const x of [1.2, 2.2]) k.box(0.03, 1.2, 0.03, x, 5.6, 0, ENDS);
  brackets(k, 1.75, 1.75, 6.4, 2);
  const r0 = 6.4 + 0.6 + 0.3;
  rafters(k, 3.9, 3.9, r0, 0.6);
  hipRoof(k, { y0: r0, a: 3.9, b: 3.9, H: 2.6, kick: 0.6, ridge: 1.2, gable: 0.5 });
}

// earthen boundary wall (tsuiji): ochre with five white lines, tiled coping
function tsuiji(k, x0, z0, x1, z1) {
  const L = Math.hypot(x1 - x0, z1 - z0);
  k.at((x0 + x1) / 2, 0, (z0 + z1) / 2, Math.atan2(-(z1 - z0), x1 - x0), () => {
    k.box(L, 0.35, 0.95, 0, 0.175, 0, STONE);
    k.box(L, 2.1, 0.7, 0, 1.4, 0, OCHRE);
    for (let l = 0; l < 5; l++) k.box(L, 0.06, 0.74, 0, 1.4 + l * 0.2, 0, PLASTER);
    for (const s of [1, -1]) k.add(new THREE.BoxGeometry(L + 0.3, 0.12, 0.72).rotateX(s * 0.45).translate(0, 2.6, s * 0.3), TILE);
    k.box(L + 0.35, 0.22, 0.28, 0, 2.8, 0, TILE_D);
  });
}

// The compound in the temple's frame (+z faces the river side, y = 0 is the terrace top); ground(x, z) is the terrain
// height in that frame. The terrace's stone walls (ishigaki) and the steps down from it run to the ground.
function compound(k, T, ground) {
  const rng = mulberry32(88);
  const W = T.hw, D = T.hd;
  k.box(2 * W - 0.4, 0.4, 2 * D - 0.4, 0, -0.2, 0, GRAVEL);
  const sides = [[-W, D, 1, 0, 2 * W], [W, D, 0, -1, 2 * D], [W, -D, -1, 0, 2 * W], [-W, -D, 0, 1, 2 * D]];
  for (const [ox, oz, tx, tz, L] of sides) {
    const nx = -tz, nz = tx, ry = Math.atan2(nx, nz); // outward
    for (let s = 0; s < L;) { const w = Math.min(1.6 + rng() * 0.8, L - s); const c = s + w / 2; k.box(w - 0.04, 0.35, 0.8, ox + tx * c - nx * 0.35, -0.175, oz + tz * c - nz * 0.35, STONE.map((v) => v * 1.12), ry); s += w; }
    // battered courses of rough blocks, down to the ground
    for (let r = 1; r < 14; r++) {
      const top = -0.35 - (r - 1) * 0.6, out = -0.45 + r * 0.1;
      let any = false;
      for (let s = (r % 2) * -0.6; s < L;) {
        const w = 1.1 + rng() * 0.7, c = Math.max(0, Math.min(L, s + w / 2)), ww = Math.min(s + w, L) - Math.max(s, 0);
        const px = ox + tx * c + nx * out, pz = oz + tz * c + nz * out;
        s += w;
        if (top < ground(px, pz) - 0.2 || ww < 0.3) continue;
        any = true;
        const tone = 0.78 + rng() * 0.36, moss = rng() * 0.12;
        k.box(ww - 0.06, 0.56 + rng() * 0.06, 0.9, px, top - 0.3, pz, [STONE[0] * tone - moss * 0.3, STONE[1] * tone, STONE[2] * tone - moss * 0.5], ry + (rng() - 0.5) * 0.04);
      }
      if (!any) break;
    }
  }
  // stone steps down the front, lanterns at their foot
  const sx = -7;
  let zf = D + 0.4;
  for (let j = 0; j < 60; j++) {
    const z = D + 0.2 + 0.42 * j + 0.21, y = -0.2 * (j + 1), g = Math.min(ground(sx, z), y) - 0.4;
    k.box(3.4, y - g, 0.46, sx, (y + g) / 2, z, STONE.map((v) => v * (0.95 + rng() * 0.15)));
    for (const s of [1, -1]) k.box(0.45, y - g + 0.25, 0.46, sx + s * 1.92, (y + g + 0.25) / 2, z, STONE);
    zf = z + 0.21;
    if (ground(sx, z + 0.42) >= y - 0.2) break;
  }
  for (const s of [1, -1]) toro(k, sx + s * 2.6, ground(sx + s * 2.6, zf + 0.9) - 0.05, zf + 0.9);
  // flagstone paths to the hall and to the pagoda
  for (let z = D - 0.6; z > 4.8; z -= 0.95) k.box(2.8, 0.1, 0.88, sx, 0.02, z, STONE.map((v) => v * (1.05 + rng() * 0.1)), (rng() - 0.5) * 0.03);
  for (let x = sx + 2.2; x < 8.5; x += 0.95) k.box(0.88, 0.1, 1.6, x, 0.02, 10.8, STONE.map((v) => v * (1.05 + rng() * 0.1)), (rng() - 0.5) * 0.03);
  for (const s of [1, -1]) { toro(k, sx + s * 2.6, 0, 8.2); toro(k, sx + s * 2.6, 0, 4.8); toro(k, 8.5 + s * 3.2, 0, 9.4); }
  k.at(-7, 0, -4, 0, () => hall(k));
  k.at(8.5, 0, 3, 0, () => pagoda(k));
  k.at(-13.5, 0, 8.5, 0, () => belfry(k));
  tsuiji(k, -W + 0.4, -D + 0.4, W - 0.4, -D + 0.4);
  for (const s of [1, -1]) tsuiji(k, s * (W - 0.4), -D + 0.4, s * (W - 0.4), -1);
  // floodlights hidden in the gravel round the pagoda
  return [[8.5 + 6.5, 3 + 6.5], [8.5 - 6.5, 3 + 6.5], [8.5 + 6.5, 3 - 6.5], [8.5 - 6.5, 3 - 6.5]].map(([x, z]) => new V(x, 0.2, z));
}

// the temple in world space: one geometry (color, aGlow), its lamp and floodlight positions
export function templeData(world) {
  const T = world.temple;
  const m = new THREE.Matrix4().makeRotationY(T.yaw).setPosition(T.x, T.y, T.z);
  const ground = (x, z) => { const p = new V(x, 0, z).applyMatrix4(m); return world.height(p.x, p.z) - T.y; };
  const k = kit();
  const flood = compound(k, T, ground);
  for (const g of k.parts) g.applyMatrix4(m);
  const flat = (list) => new Float32Array(list.flatMap((p) => p.applyMatrix4(m).toArray()));
  return { geo: mergeGeometries(k.parts), lamps: flat(k.lamps), flood: flat(flood) };
}

export function makeTemple(d, mat) {
  const mesh = new THREE.Mesh(d.geo, mat);
  mesh.castShadow = false; mesh.receiveShadow = false;
  return mesh;
}
