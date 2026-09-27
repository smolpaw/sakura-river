// Japanese set pieces: Fuji-style volcano, vermilion arched bridge (taiko-bashi); the temple is in temple.js
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeNoise, mulberry32, clamp, lerp, smoothstep } from './noise.js';

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
const STONE = [0.33, 0.31, 0.29];
const VERM = [0.62, 0.055, 0.02], VERM_D = [0.38, 0.03, 0.012];
const BRONZE = [0.42, 0.3, 0.1], LACQUER = [0.03, 0.025, 0.025];

// ---------------- vermilion arched bridge (taiko-bashi) ----------------
// Lacquered arch with kōran railings (a bronze giboshi on every post), ribs and cross beams under the deck, braced
// piers on stone footings and stone abutments. Lanterns hang from brackets on the railing and from four tall corner
// posts; they join the riverside lanterns (fx.js makeLanterns), so the bridge returns their hanging points.
export const BRIDGE_Z = -60;

// the bridge's frame: pt(u, side, dy) is u 0..1 across the river (may run past the ends), side along the flow,
// dy above the deck line
function bridgeFrame(world, zc) {
  const rx = world.riverX(zc), hw = world.riverHW(zc);
  const [fx, fz] = world.flowDir(zc);
  const across = new V(fz, 0, -fx).normalize(); // perpendicular to flow
  const along = new V(fx, 0, fz);
  const half = hw * 1.45;
  const center = new V(rx, 0, zc);
  const endY = Math.max(world.height(center.x + across.x * half, center.z + across.z * half), world.height(center.x - across.x * half, center.z - across.z * half), 0.6) + 0.15;
  const rise = 2.4;
  const width = 2.6;
  const pt = (u, side = 0, dy = 0) => {
    const s = (u * 2 - 1) * half;
    const arch = rise * (1 - Math.pow(Math.min(1, Math.abs(u * 2 - 1)), 2.1));
    return center.clone().addScaledVector(across, s).addScaledVector(along, side).add(new V(0, endY + arch + dy, 0));
  };
  return { center, across, along, half, endY, rise, width, pt };
}
const CORNER = 0.035; // corner lamp posts stand this far (in u) past the deck ends
const cornerOff = (width) => width * 0.5 + 0.28;

// where the riverside lantern ropes tie on: the downstream corner post at each end (side -1: u = 0, +1: u = 1)
export function bridgeRopeAnchors(world) {
  const { width, pt } = bridgeFrame(world, BRIDGE_Z);
  return { [-1]: pt(-CORNER, cornerOff(width), 2.42), [1]: pt(1 + CORNER, cornerOff(width), 2.42) };
}

export function bridgeData(world, zc) {
  const { center, across, along, half, endY, rise, width, pt } = bridgeFrame(world, zc);
  const N = 40;
  const rng = mulberry32(17);
  const parts = [], hang = [], look = [];
  const lantern = (p, paper) => { hang.push(p.x, p.y, p.z); look.push(rng() * 6.28, paper, 1.0 + rng() * 0.15, rng() * 6.28); };
  const giboshi = (t, s = 1) => {
    const cap = lathe([[0, 0], [0.1, 0], [0.1, 0.05], [0.07, 0.07], [0.12, 0.13], [0.13, 0.19], [0.09, 0.27], [0.03, 0.34], [0.012, 0.42], [0, 0.44]], 14, BRONZE);
    cap.scale(s, s, s).translate(t.x, t.y, t.z);
    parts.push(cap);
  };

  // deck planks (weathered, alternating tones) over deep vermilion side girders with black lacquered top edges
  for (let i = 0; i < N; i++) {
    const u0 = i / N, u1 = (i + 1) / N;
    const tone = i % 2 ? [0.24, 0.17, 0.12] : [0.2, 0.14, 0.1];
    parts.push(beam(pt(u0, 0), pt(u1, 0), width, 0.12, tone));
    for (const sd of [-1, 1]) {
      parts.push(beam(pt(u0, sd * width * 0.52, -0.26), pt(u1, sd * width * 0.52, -0.26), 0.18, 0.5, VERM));
      parts.push(beam(pt(u0, sd * width * 0.53, 0.02), pt(u1, sd * width * 0.53, 0.02), 0.2, 0.06, LACQUER));
    }
    // three arch ribs under the deck
    for (const sd of [-0.32, 0, 0.32]) parts.push(beam(pt(u0, sd * width, -0.62), pt(u1, sd * width, -0.62), 0.16, 0.22, VERM_D));
    if (i % 4 === 0) parts.push(beam(pt(u0, -width * 0.5, -0.42), pt(u0, width * 0.5, -0.42), 0.14, 0.18, VERM_D, across));
  }

  // railings: posts with bronze giboshi and lacquer bands, top / middle / bottom rails, short struts between posts
  const posts = 10;
  for (const sd of [-1, 1]) {
    const off = sd * width * 0.48;
    for (let k = 0; k <= posts; k++) {
      const u = k / posts, end = k === 0 || k === posts;
      const w = end ? 0.2 : 0.14, h = end ? 1.2 : 1.05;
      const b = pt(u, off, 0.04), t = pt(u, off, h);
      parts.push(beam(b, t, w, w, VERM));
      parts.push(beam(pt(u, off, 0.04), pt(u, off, 0.16), w + 0.03, w + 0.03, LACQUER));
      parts.push(beam(pt(u, off, h - 0.1), pt(u, off, h), w + 0.03, w + 0.03, LACQUER));
      giboshi(t, end ? 1.25 : 1);
      if (!end && k % 2 === 1) {
        // bracket out over the water with a lantern
        const tip = pt(u, off + sd * 0.34, h - 0.02);
        parts.push(beam(pt(u, off, h - 0.2), tip, 0.04, 0.05, LACQUER));
        lantern(tip.clone().add(new V(0, -0.03, 0)), 0);
      }
    }
    for (let i = 0; i < N; i++) {
      const u0 = i / N, u1 = (i + 1) / N;
      parts.push(beam(pt(u0, off, 0.92), pt(u1, off, 0.92), 0.13, 0.1, VERM));
      parts.push(beam(pt(u0, off, 0.52), pt(u1, off, 0.52), 0.08, 0.07, VERM));
      parts.push(beam(pt(u0, off, 0.2), pt(u1, off, 0.2), 0.1, 0.08, VERM));
    }
    for (let k = 0; k < posts; k++) parts.push(beam(pt((k + 0.5) / posts, off, 0.2), pt((k + 0.5) / posts, off, 0.92), 0.06, 0.06, VERM));
  }

  // piers: two columns per bent with through ties and crossed braces, on stone footings in the water
  for (const u of [0.28, 0.5, 0.72]) {
    const cols = [-1, 1].map((sd) => {
      const top = pt(u, sd * width * 0.4, -0.7);
      const bot = top.clone(); bot.y = -1.8;
      parts.push(beam(bot, top, 0.24, 0.24, VERM_D));
      const foot = new THREE.BoxGeometry(0.55, 0.9, 0.55).translate(top.x, -0.3, top.z);
      parts.push(colorize(foot, STONE));
      return top;
    });
    const tieY = (y) => cols.map((c) => new V(c.x, y, c.z));
    for (const y of [0.35, cols[0].y - 0.25]) { const [a, b2] = tieY(y); parts.push(beam(a.clone().addScaledVector(along, -0.25), b2.clone().addScaledVector(along, 0.25), 0.14, 0.12, VERM_D, across)); }
    const [a0, b0] = tieY(0.35), [a1, b1] = tieY(cols[0].y - 0.25);
    parts.push(beam(a0, b1, 0.08, 0.08, VERM_D), beam(b0, a1, 0.08, 0.08, VERM_D));
  }

  // stone abutments (stacked blocks) and tall corner lamp posts
  for (const e of [0, 1]) {
    const dir = e ? 1 : -1;
    for (let l = 0; l < 3; l++) {
      const y = endY - 0.12 - l * 0.34;
      for (const sd of [-1, 0, 1]) {
        const c = pt(e + dir * (0.03 + l * 0.012), sd * (width * 0.36 + (l % 2) * 0.12), 0);
        const tone = 0.9 + rng() * 0.2;
        parts.push(colorize(new THREE.BoxGeometry(1.0, 0.32, 0.95).applyMatrix4(new THREE.Matrix4().makeRotationY(Math.atan2(across.x, across.z) + (rng() - 0.5) * 0.08)).translate(c.x, y, c.z), STONE.map((v) => v * tone)));
      }
    }
    const u = e + dir * CORNER;
    for (const sd of [-1, 1]) {
      const off = sd * cornerOff(width);
      const b = pt(u, off, -0.3), t = pt(u, off, 2.5);
      parts.push(beam(b, t, 0.18, 0.18, VERM));
      parts.push(beam(pt(u, off, 2.4), pt(u, off, 2.5), 0.22, 0.22, LACQUER));
      giboshi(t, 1.1);
      // arm out along the flow, lantern hanging from its tip
      const tip = pt(u, off + sd * 0.55, 2.3);
      parts.push(beam(pt(u, off, 2.3), tip, 0.08, 0.1, LACQUER));
      parts.push(beam(pt(u, off + sd * 0.1, 1.95), pt(u, off + sd * 0.4, 2.28), 0.05, 0.05, LACQUER));
      lantern(tip.clone().add(new V(0, -0.05, 0)), 1);
    }
  }
  return { geo: mergeGeometries(parts), center: center.toArray(), half, across: across.toArray(), endY, rise, lamps: { hang: new Float32Array(hang), look: new Float32Array(look), n: hang.length / 3 } };
}

export function makeBridge(d, mat) {
  const mesh = new THREE.Mesh(d.geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return { mesh, center: new V().fromArray(d.center), half: d.half, across: new V().fromArray(d.across), endY: d.endY, rise: d.rise };
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

export function makeFuji(g, mat) {
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return mesh;
}
function lerp3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
