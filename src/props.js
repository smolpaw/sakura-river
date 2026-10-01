// Japanese set pieces: Fuji-style volcano, vermilion arched bridge (taiko-bashi); the temple is in temple.js
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeNoise, mulberry32, clamp, lerp, smoothstep } from './noise.js';
import { LANTERN_TEXTS } from './lanterns.js';
import { kit, skyLight } from './temple.js';

const V = THREE.Vector3;

const STONE = [0.33, 0.31, 0.29];
const VERM = [0.62, 0.055, 0.02], VERM_D = [0.38, 0.03, 0.012];
const BRONZE = [0.5, 0.36, 0.12], LACQUER = [0.03, 0.025, 0.025], COPPER = [0.09, 0.13, 0.1], PLANK = [0.25, 0.19, 0.14];

// ---------------- vermilion arched bridge (taiko-bashi) ----------------
// A lacquered arch on three bents of round piles (through ties, cross braces, copper sheathing at the waterline), the
// deck on two vermilion girders and two stringers, cross beams passing through the girders with gilt caps on their
// ends. Plank deck with foot cleats where it is steep, a kōran railing (round top rail, middle and bottom rails,
// struts) with a bronze giboshi on every post, and coursed stone abutments under the ends. The sky light each part
// sees past the others is baked into the colours (temple.js skyLight). Lanterns hang from brackets on the railing and
// from four tall corner posts; they join the riverside lanterns (fx.js makeLanterns), so the bridge returns their
// hanging points.
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

// where the riverside lantern ropes tie on: the corner posts at each end (side -1: u = 0, +1: u = 1), downstream
// and upstream
export function bridgeRopeAnchors(world) {
  const { width, pt } = bridgeFrame(world, BRIDGE_Z);
  const at = (o) => ({ [-1]: pt(-CORNER, o, 2.42), [1]: pt(1 + CORNER, o, 2.42) });
  return { down: at(cornerOff(width)), up: at(-cornerOff(width)) };
}

export function bridgeData(world, zc) {
  const { center, across, along, half, endY, rise, width, pt } = bridgeFrame(world, zc);
  const rng = mulberry32(17);
  const k = kit();
  const hang = [], look = [];
  const up = new V(0, 1, 0), yaw = Math.atan2(across.x, across.z), W = width / 2;
  // the bridge's lanterns face up and down the river, what they say as the riverside ones (LANTERN_TEXTS)
  const lantern = (p) => { hang.push(p.x, p.y, p.z); look.push(rng() * 6.28, Math.floor(rng() * LANTERN_TEXTS.length), 1.0 + rng() * 0.15, Math.atan2(along.x, along.z) + (rng() - 0.5) * 0.5); };
  const tan = (u) => pt(u + 1e-3).sub(pt(u - 1e-3)).normalize();
  // a box lu (across the river) × h × ls (along the flow) at pt(u, side, dy), tilted with the deck
  const block = (u, side, dy, lu, h, ls, c) => {
    const T = tan(u), N = new V().crossVectors(along, T);
    k.add(new THREE.BoxGeometry(lu, h, ls).applyMatrix4(new THREE.Matrix4().makeBasis(T, N, along).setPosition(pt(u, side, dy))), c);
  };
  // a round (or octagonal) member from a to b
  const pole = (a, b, r, c, sides = 8, r1 = r) => {
    const d = new V().subVectors(b, a), g = new THREE.CylinderGeometry(r1, r, d.length(), sides, 1);
    g.rotateY(yaw + Math.PI / sides).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d.normalize()));
    const m = a.clone().add(b).multiplyScalar(0.5);
    k.add(g.translate(m.x, m.y, m.z), c);
  };
  const giboshi = (t, s = 1) => k.at(t.x, t.y, t.z, 0, () => k.lathe([[0, 0], [0.1, 0], [0.1, 0.05], [0.07, 0.07], [0.12, 0.13], [0.13, 0.19], [0.09, 0.27], [0.03, 0.34], [0.012, 0.42], [0, 0.44]].map(([r, y]) => [r * s, y * s]), 12, BRONZE));
  // a member swept along the arch from u0 to u1: its section [[side, dy], ...] a convex outline, flat faces (or smooth
  // all round), ends capped
  const sweep = (sec, u0, u1, c, { n = 96, smooth = false } = {}) => {
    const m = sec.length, mid = sec.reduce((a, [s, d]) => [a[0] + s / m, a[1] + d / m], [0, 0]);
    const rings = [];
    for (let i = 0; i <= n; i++) rings.push(sec.map(([s, d]) => pt(lerp(u0, u1, i / n), s, d)));
    // faces wound outwards, away from the section's middle
    const out = (a, b, cc, o) => new V().subVectors(b, a).cross(new V().subVectors(cc, a)).dot(new V().subVectors(a, o)) > 0;
    const o0 = pt(u0, mid[0], mid[1]);
    const mesh = (P, I) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I); g.computeVertexNormals(); k.add(g, c); };
    const strips = smooth ? [[...Array(m + 1).keys()].map((e) => e % m)] : sec.map((_, e) => [e, (e + 1) % m]);
    for (const cols of strips) {
      const P = [], I = [], w = cols.length;
      for (const r of rings) for (const e of cols) P.push(r[e].x, r[e].y, r[e].z);
      const flip = !out(rings[0][cols[0]], rings[0][cols[1]], rings[1][cols[0]], o0);
      for (let i = 0; i < n; i++) for (let e = 0; e < w - 1; e++) {
        const a = i * w + e, b = a + 1, cc = a + w, d = cc + 1;
        if (flip) I.push(a, cc, b, b, cc, d); else I.push(a, b, cc, b, d, cc);
      }
      mesh(P, I);
    }
    for (const [r, u, s] of [[rings[0], u0, -1], [rings[n], u1, 1]]) {
      const P = r.flatMap((p) => [p.x, p.y, p.z]), I = [];
      for (let e = 1; e < m - 1; e++) I.push(0, e, e + 1);
      if ((new V().subVectors(r[1], r[0]).cross(new V().subVectors(r[2], r[0])).dot(tan(u)) > 0) !== (s > 0)) for (let t = 0; t < I.length; t += 3) [I[t + 1], I[t + 2]] = [I[t + 2], I[t + 1]];
      mesh(P, I);
    }
  };
  const rect = (s0, s1, d0, d1) => [[s0, d0], [s1, d0], [s1, d1], [s0, d1]];
  const round = (s, d, r, sides = 10) => Array.from({ length: sides }, (_, i) => [s + r * Math.cos((i / sides) * Math.PI * 2), d + r * Math.sin((i / sides) * Math.PI * 2)]);

  // u of arc length along the deck (the planks and posts go at even steps along it)
  const arc = [0];
  for (let i = 1; i <= 400; i++) arc.push(arc[i - 1] + pt(i / 400).distanceTo(pt((i - 1) / 400)));
  const L = arc[400];
  const uAt = (l) => { let i = 1; while (i < 400 && arc[i] < l) i++; return (i - 1 + (l - arc[i - 1]) / (arc[i] - arc[i - 1])) / 400; };

  // deck: weathered planks across it with narrow gaps, foot cleats (sanki) on them where the deck is steep; under
  // them two stringers and the girders, cross beams through all four, their ends capped in gilt bronze
  const NP = Math.round(L / 0.3);
  for (let i = 0; i < NP; i++) {
    const u = uAt((i + 0.5) * L / NP), lu = (L / NP) - 0.014, tone = 0.8 + rng() * 0.4;
    block(u, 0, -0.035, lu, 0.07, 2 * W, PLANK.map((v) => v * tone));
    if (Math.abs(tan(u).y) > 0.16) block(u, 0, 0.015, 0.05, 0.035, 2 * W - 0.5, PLANK.map((v) => v * 0.8));
  }
  sweep(rect(-W + 0.15, W - 0.15, -0.075, -0.07), 0, 1, [0.1, 0.075, 0.055], { n: 48 }); // the dark under the gaps
  for (const sd of [-1, 1]) {
    sweep(rect(sd * 1.12, sd * 1.36, -0.7, -0.07), -0.012, 1.012, VERM);
    sweep(rect(sd * 1.3, sd * 1.4, -0.14, 0.05), -0.012, 1.012, LACQUER); // a black edge board over the planks' ends
    sweep(rect(sd * 0.36, sd * 0.54, -0.56, -0.07), 0, 1, VERM_D, { n: 48 });
  }
  for (let l = 0.45; l < L; l += 0.95) {
    const u = uAt(l);
    block(u, 0, -0.33, 0.15, 0.18, 2 * 1.56, VERM_D);
    for (const sd of [-1, 1]) block(u, sd * 1.575, -0.33, 0.17, 0.2, 0.03, BRONZE);
  }

  // kōran railings: posts with bronze giboshi, a round top rail, a middle and a bottom rail, struts between the posts;
  // lanterns hang from brackets on every other post
  const POSTS = 10;
  for (const sd of [-1, 1]) {
    const off = sd * 1.22;
    const us = Array.from({ length: POSTS + 1 }, (_, j) => uAt((j / POSTS) * L));
    us.forEach((u, j) => {
      const end = j === 0 || j === POSTS, r = end ? 0.12 : 0.08, h = end ? 1.3 : 1.18;
      const b = pt(u, off, 0), t = pt(u, off, h);
      pole(b, t, r, VERM);
      pole(pt(u, off, h - 0.1), t, r + 0.012, LACQUER);
      pole(b, pt(u, off, 0.2), r + 0.012, LACQUER);
      giboshi(t, end ? 1.25 : 1);
      if (!end && j % 2 === 1) {
        const tip = pt(u, off + sd * 0.4, 1.02);
        k.beam(pt(u, off, 0.94), tip, 0.045, 0.06, LACQUER);
        k.beam(pt(u, off + sd * 0.06, 0.62), pt(u, off + sd * 0.3, 1.0), 0.035, 0.035, LACQUER);
        lantern(tip.clone().add(new V(0, -0.04, 0)));
      }
      if (j < POSTS) { const um = (u + us[j + 1]) / 2; pole(pt(um, off, 0.14), pt(um, off, 0.98), 0.035, VERM, 6); }
    });
    sweep(round(off, 0.98, 0.058), us[0], us[POSTS], VERM, { smooth: true, n: 120 });
    sweep(rect(off - 0.04, off + 0.04, 0.5, 0.6), us[0], us[POSTS], VERM);
    sweep(rect(off - 0.07, off + 0.07, 0.0, 0.14), us[0], us[POSTS], VERM);
  }

  // bents: four round piles (the outer two battered out) from the river bed to a cap beam under the girders, two
  // through ties, cross braces between them, copper sheathing where the water rises and falls
  for (const u of [0.28, 0.5, 0.72]) {
    const cap = pt(u, 0, -0.92).y;
    const piles = [[-1.75, -1.3], [-0.45, -0.45], [0.45, 0.45], [1.75, 1.3]].map(([s0, s1]) => {
      const b = pt(u, s0, 0), t = pt(u, s1, 0);
      b.y = world.height(b.x, b.z) - 0.3; t.y = cap;
      pole(b, t, 0.14, VERM_D, 12);
      pole(b, b.clone().lerp(t, (0.35 - b.y) / (t.y - b.y)), 0.155, COPPER, 12);
      return [b, t];
    });
    block(u, 0, -0.81, 0.3, 0.22, 3.4, VERM_D);
    const onPile = ([b, t], y) => b.clone().lerp(t, (y - b.y) / (t.y - b.y));
    const ties = [0.75, lerp(0.75, cap, 0.62)];
    for (const y of ties) {
      const a = onPile(piles[0], y), z = onPile(piles[3], y);
      k.beam(a.clone().addScaledVector(along, -0.3), z.clone().addScaledVector(along, 0.3), 0.13, 0.17, VERM_D);
    }
    for (const [i, j] of [[0, 3], [3, 0]]) k.beam(onPile(piles[i], ties[0] + 0.1), onPile(piles[j], ties[1] - 0.1), 0.09, 0.09, VERM_D);
  }

  // abutments: courses of rough blocks under each end, from the ground up to the girders, battered back
  for (const e of [0, 1]) {
    const dir = e ? 1 : -1, uf = e ? 0.855 : 0.145, bank = across.clone().multiplyScalar(dir);
    const face = pt(uf, 0, 0);
    const gmin = Math.min(...[-2, 0, 2].map((s) => { const p = face.clone().addScaledVector(along, s); return world.height(p.x, p.z); }));
    const yTop = pt(uf, 0, -0.7).y;
    for (let y = yTop; y > gmin - 0.4;) {
      const ch = 0.3 + rng() * 0.18, lean = (yTop - y + ch / 2) * 0.14;
      // each course runs back into the bank until the girders come down to it
      let ub = uf;
      while (Math.abs(ub - e) > 0.005 && pt(ub, 0, -0.7).y > y - 0.05) ub += dir * 0.005;
      const depth = Math.abs(ub - uf) * 2 * half + 0.3;
      for (let s = -1.9 - rng() * 0.6; s < 1.9;) {
        const w = 0.5 + rng() * 0.6, s0 = Math.max(s, -1.9), s1 = Math.min(s + w, 1.9);
        s += w;
        if (s1 - s0 < 0.25) continue;
        const c = face.clone().addScaledVector(along, (s0 + s1) / 2).addScaledVector(bank, depth / 2 - lean + (rng() - 0.5) * 0.05);
        const tone = 0.75 + rng() * 0.4, moss = Math.max(0, 0.6 - (y - gmin)) * 0.15;
        k.add(new THREE.BoxGeometry(s1 - s0 - 0.04, ch - 0.03, depth).rotateY(yaw + (rng() - 0.5) * 0.05).translate(c.x, y - ch / 2, c.z),
          [STONE[0] * tone - moss * 0.3, STONE[1] * tone, STONE[2] * tone - moss * 0.5]);
      }
      y -= ch;
    }
  }

  // tall corner lamp posts on stone bases, each with an arm out along the flow and a lantern at its tip
  for (const e of [0, 1]) {
    const u = e + (e ? 1 : -1) * CORNER;
    for (const sd of [-1, 1]) {
      const off = sd * cornerOff(width);
      const b = pt(u, off, -0.3), t = pt(u, off, 2.5), g = world.height(b.x, b.z);
      k.add(new THREE.BoxGeometry(0.42, 0.5, 0.42).rotateY(yaw).translate(b.x, g + 0.1, b.z), STONE);
      pole(new V(b.x, g + 0.35, b.z), t, 0.1, VERM);
      pole(pt(u, off, 2.36), t, 0.115, LACQUER);
      giboshi(t, 1.1);
      const tip = pt(u, off + sd * 0.55, 2.3);
      k.beam(pt(u, off, 2.3), tip, 0.08, 0.1, LACQUER);
      k.beam(pt(u, off + sd * 0.1, 1.95), pt(u, off + sd * 0.4, 2.28), 0.05, 0.05, LACQUER);
      lantern(tip.clone().add(new V(0, -0.05, 0)));
    }
  }
  skyLight(k.parts);
  const geo = mergeGeometries(k.parts);
  geo.deleteAttribute('aGlow');
  return { geo, center: center.toArray(), half, across: across.toArray(), endY, rise, lamps: { hang: new Float32Array(hang), look: new Float32Array(look), n: hang.length / 3 } };
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
