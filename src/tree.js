// Procedural cherry tree: recursive branch growth -> merged tube geometry + blossom anchors
import * as THREE from 'three';
import { mulberry32, makeNoise, clamp, lerp, smoothstep } from './noise.js';
import { tessellate } from './stress.js';

const V = THREE.Vector3;

// Somei Yoshino form: a short trunk that splits at the top into 5-6 wide-spreading limbs; each branch then carries a
// leader (continues almost straight) and side shoots. Limbs rise, twigs droop. Lengths are scaled by `scale`.
export const MAIN_TREE = {
  scale: 1.25,
  trunk: { length: 2.5, radius: 0.46, lean: 0.1 },
  limbs: [5, 6],
  maxDepth: 5,
  umbels: [0, 0, 0, 3, 5, 10], // blossom umbels per branch, by depth
  fill: [0, 0, 2, 6, 6, 3], // more umbels along the branches (full bloom), from their own rng: same tree
  spray: [0, 0, 0, 0, 2, 0], // more flowering twigs off the branches of each depth, from their own rng: same tree
  tip: [0, 0, 0, 0, 1, 3], // more umbels crowded at the branches' far ends, from their own rng: same tree
  droop: [0, 0, 0, 0, 1, 1], // umbels hanging below the branches' outer halves (see treeData), from the tips' rng
  flowerSize: 1,
  minY: 2.2,
  roots: 6,
  fused: 2, // the roots and the branches to this depth are the Blender model's (see trunkSkeleton)
};

export const SMALL_TREE = {
  scale: 1.25,
  trunk: { length: 2.1, radius: 0.36, lean: 0.12 },
  limbs: [4, 5],
  maxDepth: 4,
  umbels: [0, 0, 2, 5, 9],
  fill: [0, 0, 2, 4, 2],
  tip: [0, 0, 0, 1, 3],
  droop: [0, 0, 0, 1, 1],
  flowerSize: 1.7, // seen from afar: fewer, larger flowers
  minY: 1.8,
  roots: 0,
  fused: 1,
};

const TAU = Math.PI * 2;

function anyPerp(d) {
  const a = Math.abs(d.y) < 0.9 ? new V(0, 1, 0) : new V(1, 0, 0);
  return new V().crossVectors(d, a).normalize();
}

export function growTree(seed, cfg, groundAt = () => 0) {
  const main = mulberry32(seed), rngFill = mulberry32(seed + 3), rngSpray = mulberry32(seed + 5), rngTip = mulberry32(seed + 7);
  const nz = makeNoise(seed + 99);
  const k = cfg.scale, D = cfg.maxDepth;
  const branches = [];
  const anchors = []; // umbel sites: { p, d, f, depth, br, i } (on branch br past its point i)
  let limbs = 0;

  // rng: the stream this branch and its offshoots draw from (the sprays have their own, so the rest stays the same);
  // up: the wind's hinges between the root and this branch's start (see bendAt); sys: the limb system it belongs to
  function grow(start, dir, length, radius, depth, pathLen, rng = main, up = [], sys = null) {
    const rr = (a, b) => a + (b - a) * rng();
    const n = depth < 2 ? 6 : 4;
    const step = length / n;
    const r1 = radius * (depth === D ? 0.28 : depth === 0 ? 0.8 : 0.66);
    const wob = depth === 0 ? 0.12 : 0.2;
    const pts = [start.clone()], rad = [radius], flex = [pathLen], dirs = [dir.clone()];
    let p = start.clone();
    const d = dir.clone(), bend = new V();
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      // the turn carries on from one step to the next: branches wind in curves rather than kinking at each step
      bend.x = bend.x * 0.55 + rr(-wob, wob); bend.z = bend.z * 0.55 + rr(-wob, wob);
      d.x += bend.x; d.z += bend.z; d.y += rr(-0.08, 0.08);
      d.y += depth === 0 ? 0.05 : depth <= 2 ? 0.022 : -0.05 * (depth - 2) * t; // limbs rise, twigs droop
      if (depth > 0 && p.y < cfg.minY && d.y < 0.2) d.y += 0.25; // no twig trails on the grass
      d.normalize();
      p = p.clone().addScaledVector(d, step);
      pts.push(p); dirs.push(d.clone());
      rad.push(lerp(radius, r1, t));
      flex.push(pathLen + step * i);
    }
    // the first branch past the Blender model starts a limb system, which bobs in the wind on its own phase
    if (depth === cfg.fused + 1) sys = { phase: (limbs++ * 0.618034) % 1 };
    const hinges = [];
    for (let i = 0; i < n; i++) hinges.push(hinge(pts[i], pts[i + 1], (rad[i] + rad[i + 1]) / 2, flex[i], depth > cfg.fused));
    const br = { pts, rad, flex, depth, up, hinges, sys };
    branches.push(br);

    const at = (t) => {
      const f = t * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
      return {
        p: pts[i].clone().lerp(pts[i + 1], u),
        d: dirs[i].clone().lerp(dirs[i + 1], u).normalize(),
        r: lerp(rad[i], rad[i + 1], u),
        f: lerp(flex[i], flex[i + 1], u),
        i,
      };
    };

    const nU = cfg.umbels[depth] || 0;
    for (let u = 0; u < nU; u++) {
      const s = at(depth === D ? 1 - rng() * rng() * 0.75 : rr(0.3, 1)); // terminal twigs flower towards the tip
      anchors.push({ p: s.p, d: s.d, f: s.f, depth, br, i: s.i });
    }
    for (let u = 0; u < ((cfg.fill && cfg.fill[depth]) || 0); u++) {
      const s = at(0.25 + 0.75 * rngFill());
      anchors.push({ p: s.p, d: s.d, f: s.f, depth, br, i: s.i });
    }
    for (let u = 0; u < ((cfg.tip && cfg.tip[depth]) || 0); u++) {
      const s = at(1 - 0.3 * rngTip() * rngTip());
      anchors.push({ p: s.p, d: s.d, f: s.f, depth, br, i: s.i });
    }
    // drooping clusters: hung below the branch on longer stalks, so the crown's masses round off underneath
    for (let u = 0; u < ((cfg.droop && cfg.droop[depth]) || 0); u++) {
      const s = at(0.5 + 0.5 * rngTip());
      anchors.push({ p: s.p, d: s.d, f: s.f, depth, br, i: s.i, droop: (0.12 + 0.16 * rngTip()) * k });
    }
    if (depth === D) return;

    const kids = depth === 0 ? cfg.limbs[0] + Math.floor(rng() * (cfg.limbs[1] - cfg.limbs[0] + 1)) : depth === D - 1 ? 2 : 3;
    const az0 = rng() * TAU;
    // a side shoot (or the leader) off this branch
    const shoot = (lead, rng) => {
      const rr = (a, b) => a + (b - a) * rng();
      const s = at(lead ? 1 : rr(0.4, 0.88));
      const axis = anyPerp(s.d).applyAxisAngle(s.d, rng() * TAU);
      const cd = s.d.clone().applyAxisAngle(axis, lead ? rr(0.12, 0.32) : rr(0.5, 0.95));
      const out = new V(s.p.x, 0, s.p.z);
      if (out.lengthSq() > 1e-4) cd.addScaledVector(out.normalize(), 0.22); // open crown
      cd.normalize();
      const clen = length * (lead ? rr(0.72, 0.84) : rr(0.55, 0.74)), crad = s.r * (lead ? 0.8 : rr(0.52, 0.68));
      grow(s.p.clone().addScaledVector(cd, -crad * 0.5), cd, clen, crad, depth + 1, s.f, rng, up.concat(hinges.slice(0, s.i + 1)), sys);
    };
    for (let c = 0; c < kids; c++) {
      if (depth === 0) {
        let s, cd, clen, crad;
        // limbs: evenly around the trunk, 53-70 degrees from vertical
        s = at(rr(0.8, 1));
        const az = az0 + (c / kids) * TAU + rr(-0.3, 0.3), pol = rr(0.92, 1.22);
        cd = new V(Math.sin(pol) * Math.cos(az), Math.cos(pol), Math.sin(pol) * Math.sin(az));
        clen = (length - 0.5) * rr(1.1, 1.35);
        crad = s.r * rr(0.66, 0.78);
        grow(s.p.clone().addScaledVector(cd, -crad * 0.5), cd, clen, crad, depth + 1, s.f, rng, up.concat(hinges.slice(0, s.i + 1)), sys);
      } else shoot(c === 0, rng);
    }
    // more flowering twigs for full bloom, from their own stream
    for (let c = 0; c < ((cfg.spray && cfg.spray[depth]) || 0); c++) shoot(false, rngSpray);
  }

  // trunk (starts half a unit below the ground so the flare sits in it)
  const T = cfg.trunk;
  const g0 = groundAt(0, 0);
  const tdir = new V((main() - 0.5) * T.lean, 1, (main() - 0.5) * T.lean).normalize();
  grow(new V(0, g0 - 0.5, 0), tdir, T.length * k + 0.5, T.radius * k, 0, 0);

  // surface roots
  const roots = [];
  for (let i = 0; i < cfg.roots; i++) {
    const a = (i / cfg.roots) * Math.PI * 2 + main() * 0.6;
    const len = 1.6 + main() * 1.6;
    const pts = [], rad = [], flex = [];
    const segs = 10;
    for (let k = 0; k <= segs; k++) {
      const t = k / segs;
      const r = 0.25 + t * len;
      const aa = a + Math.sin(t * 3 + i) * 0.25;
      const x = Math.cos(aa) * r, z = Math.sin(aa) * r;
      const rr = lerp(0.24, 0.025, Math.pow(t, 0.7));
      const y = groundAt(x, z) + lerp(0.45, -0.02, Math.pow(t, 0.6)) - rr * 0.35;
      pts.push(new V(x, y, z)); rad.push(rr); flex.push(0);
    }
    roots.push({ pts, rad, flex, depth: -1, up: [], hinges: [], sys: null });
  }
  branches.push(...roots);

  // the crown's centre and extents: its outward normal for the flowers where crownLight finds no way out, and the
  // shade the Blender trunk darkens towards
  const c = new V();
  for (const b of anchors) c.add(b.p);
  c.multiplyScalar(1 / Math.max(1, anchors.length));
  let ext = new V(1e-3, 1e-3, 1e-3);
  for (const b of anchors) { ext.x = Math.max(ext.x, Math.abs(b.p.x - c.x)); ext.y = Math.max(ext.y, Math.abs(b.p.y - c.y)); ext.z = Math.max(ext.z, Math.abs(b.p.z - c.z)); }
  c.y -= ext.y * 0.25;
  return { branches, anchors, canopy: { center: c, ext }, nz };
}

// a branch's centreline as rendered: Catmull-Rom smoothed (rings per depth), plus a closing tip; seg: the branch's
// own segment each point is on
const RINGS = [24, 14, 10, 7, 5, 4];
function branchPath(br) {
  let { pts, rad, flex } = br, seg = pts.map((_, i) => i);
  if (br.depth >= 0) {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const n = RINGS[Math.min(br.depth, RINGS.length - 1)];
    const np = curve.getPoints(n);
    const r2 = [], f2 = [], s2 = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * (pts.length - 1), k = Math.min(pts.length - 2, Math.floor(t)), u = t - k;
      r2.push(lerp(rad[k], rad[k + 1], u)); f2.push(lerp(flex[k], flex[k + 1], u)); s2.push(k);
    }
    pts = np; rad = r2; flex = f2; seg = s2;
  }
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const tipDir = last.clone().sub(prev).normalize();
  return {
    pts: pts.concat([last.clone().addScaledVector(tipDir, rad[rad.length - 1] * 0.8)]),
    rad: rad.concat([0.0005]),
    flex: flex.concat([flex[flex.length - 1]]),
    seg: seg.concat([seg[seg.length - 1]]),
  };
}

// parallel-transport frames along a polyline
function frames(pts) {
  const n = pts.length, Ts = [], Ns = [];
  for (let i = 0; i < n; i++) Ts.push(pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
  Ns.push(anyPerp(Ts[0]));
  for (let i = 1; i < n; i++) {
    const axis = new V().crossVectors(Ts[i - 1], Ts[i]);
    const nn = Ns[i - 1].clone();
    const l = axis.length();
    if (l > 1e-5) { axis.multiplyScalar(1 / l); nn.applyAxisAngle(axis, Math.acos(clamp(Ts[i - 1].dot(Ts[i]), -1, 1))); }
    Ns.push(nn);
  }
  return { Ts, Ns };
}

// wind flexibility from path length along the tree (0 at the trunk): how much the flowers flutter
const flexOf = (f) => Math.pow(clamp((f - 2.2) / 14, 0, 1.4), 1.55);

// ---------- the wind's bend ----------
// Wood bends, it doesn't stretch: each segment of a branch is a hinge at its start that turns everything beyond it by
// an angle proportional to the wind's push across it and to its compliance (longer and thinner: more; the trunk below
// BEND_F0 m of path stays put). A point's offset is then the sum of the small turns of the hinges between it and the
// root, which is linear in the push: bendAt gives it for a unit push along x and along z, which the shader scales by
// the wind of the moment (tsl.js treeWindPosition), and for a unit push up of the point's own limb system alone (the
// hinges past the Blender model), which bobs on its own phase. Linear turns lengthen a branch by the square of their
// angle, so the angles stay small: a point moves by the hinges' sum over long levers, not by any one bending far.
const BEND = 0.012, BEND_R = 0.1, BEND_P = 0.6, BEND_F0 = 1.6, BEND_F1 = 4;
function hinge(a, b, r, f, own) {
  const T = b.clone().sub(a), len = T.length();
  return { p: a, T: T.multiplyScalar(1 / len), c: BEND * len * Math.pow(BEND_R / r, BEND_P) * smoothstep(BEND_F0, BEND_F1, f), own };
}
const turn = (out, c, T, w, r) => out.addScaledVector(w, c * T.dot(r)).addScaledVector(T, -c * w.dot(r));
const AX = new V(1, 0, 0), AY = new V(0, 1, 0), AZ = new V(0, 0, 1);
// p: a point of branch br past its point k (the hinges up to and including k turn it)
function bendAt(br, k, p) {
  const x = new V(), z = new V(), b = new V(), r = new V();
  const add = (h) => {
    r.subVectors(p, h.p);
    turn(x, h.c, h.T, AX, r); turn(z, h.c, h.T, AZ, r);
    if (h.own) turn(b, h.c, h.T, AY, r);
  };
  for (const h of br.up) add(h);
  for (let i = 0; i <= Math.min(k, br.hinges.length - 1); i++) add(br.hinges[i]);
  return { x, z, b };
}

// ---------- geometry ----------
// the bark of the branches past cfg.fused (the rest is the Blender model's)
export function buildBarkGeometry(tree, cfg, groundAt = () => 0) {
  const P = [], Nn = [], UV = [], BX = [], BZ = [], BB = [], C = [], I = [];
  const nz = tree.nz;
  const { center, ext } = tree.canopy;
  let vbase = 0;
  const tmpN = new V(), tmpB = new V();
  for (const br of tree.branches) {
    if (br.depth <= cfg.fused) continue;
    const { pts, rad, seg } = branchPath(br);
    const r0 = rad[0];
    const radial = br.depth <= 0 ? 18 : r0 > 0.2 ? 14 : r0 > 0.09 ? 10 : r0 > 0.04 ? 7 : r0 > 0.02 ? 5 : 4;
    const n = pts.length;
    const { Ts, Ns } = frames(pts);
    let s = 0;
    const circ = Math.max(1, Math.round(r0 * 7));
    for (let i = 0; i < n; i++) {
      if (i > 0) s += pts[i].distanceTo(pts[i - 1]);
      const T = Ts[i], Nv = Ns[i];
      const B = new V().crossVectors(T, Nv);
      const p = pts[i];
      const hg = p.y - groundAt(p.x, p.z);
      const bend = bendAt(br, seg[i], p), phase = br.sys ? br.sys.phase : 0;
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        tmpN.copy(Nv).multiplyScalar(ca).addScaledVector(B, sa);
        let r = rad[i];
        if (br.depth <= 1 && r > 0.06) {
          r *= 1 + 0.07 * nz.noise2(ca * 1.5 + s * 0.8, sa * 1.5 + br.depth * 9) + 0.025 * Math.sin(a * 9 + s * 0.6);
        }
        // a collar where a branch leaves its parent, and the trunk swelling where the limbs fork from it
        if (br.depth > 0) r *= 1 + 0.45 * Math.exp(-s / (r0 * 2.5));
        if (br.depth === 0) {
          r *= 1 + 0.22 * smoothstep(0.6, 1, i / (n - 1));
          const fl = Math.exp(-Math.max(0, hg + 0.3) * 1.9);
          r *= 1 + 0.85 * fl * (0.7 + 0.3 * Math.pow(0.5 + 0.5 * Math.sin(a * 5 + 1.3), 2));
        }
        P.push(p.x + tmpN.x * r, p.y + tmpN.y * r, p.z + tmpN.z * r);
        Nn.push(tmpN.x, tmpN.y, tmpN.z);
        UV.push((j / radial) * circ, s * 0.9);
        // the ring moves with its centreline (bendAt); wood doesn't flutter
        BX.push(bend.x.x, bend.x.y, bend.x.z, 0); BZ.push(bend.z.x, bend.z.y, bend.z.z, phase); BB.push(bend.b.x, bend.b.y, bend.b.z);
        // bark AO + moss near ground
        const q = new V((p.x - center.x) / ext.x, (p.y - center.y) / ext.y, (p.z - center.z) / ext.z).length();
        let ao = lerp(0.7, 1.0, smoothstep(0.2, 1.05, q));
        ao *= lerp(0.7, 1.0, smoothstep(-0.2, 1.2, hg));
        const moss = (br.depth <= 0 ? 1 : 0) * smoothstep(1.4, 0.0, hg) * clamp(0.4 + tmpN.y * 0.4 + 0.5 * nz.noise2(a * 1.3, s * 1.5), 0, 1);
        const cr = lerp(1, 0.62, moss) * ao, cg = lerp(1, 1.05, moss) * ao, cb = lerp(1, 0.5, moss) * ao;
        C.push(cr, cg, cb);
      }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
      const a = vbase + i * (radial + 1) + j, b = a + 1, c2 = a + radial + 1, d = c2 + 1;
      I.push(a, b, c2, b, d, c2);
    }
    vbase += n * (radial + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setAttribute('aBendX', new THREE.Float32BufferAttribute(BX, 4));
  g.setAttribute('aBendZ', new THREE.Float32BufferAttribute(BZ, 4));
  g.setAttribute('aBob', new THREE.Float32BufferAttribute(BB, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setIndex(vbase > 65535 ? new THREE.Uint32BufferAttribute(I, 1) : new THREE.Uint16BufferAttribute(I, 1));
  g.computeBoundingSphere();
  return g;
}

// one cupped flower card (2x2 quads), facing +z
export function buildFlowerGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 2, 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, (x * x + y * y) * 0.4); }
  g.computeVertexNormals();
  g.deleteAttribute('uv');
  const uvs = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uvs[i * 2] = p.getX(i) + 0.5; uvs[i * 2 + 1] = p.getY(i) + 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return g;
}

// single-flower atlas (2x2 variants) painted procedurally: Somei Yoshino flowers, five broad rounded petals each with
// the small notch at its tip, blush pink at the base fading to near white, the petals' cup shaded softly (each casts
// a faint shadow on the one under it) and fine veins; a small red-pink eye with its stamens
export function paintFlowerAtlas(seed = 5, size = 1024) {
  const rng = mulberry32(seed);
  const cv = new OffscreenCanvas(size, size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cell = size / 2;
  // obovate: narrow at the claw, broadest past the middle, a rounded tip with a shallow notch in it
  const petalPath = (ctx, len, wid) => {
    const nw = wid * 0.16, nd = len * 0.07;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(wid * 0.55, len * 0.12, wid * 1.08, len * 0.5, wid * 0.98, len * 0.78);
    ctx.bezierCurveTo(wid * 0.9, len * 0.96, wid * 0.45, len * 1.02, nw, len * 0.99);
    ctx.quadraticCurveTo(nw * 0.3, len * 0.99 - nd * 0.4, 0, len - nd);
    ctx.quadraticCurveTo(-nw * 0.3, len * 0.99 - nd * 0.4, -nw, len * 0.99);
    ctx.bezierCurveTo(-wid * 0.45, len * 1.02, -wid * 0.9, len * 0.96, -wid * 0.98, len * 0.78);
    ctx.bezierCurveTo(-wid * 1.08, len * 0.5, -wid * 0.55, len * 0.12, 0, 0);
    ctx.closePath();
  };
  const flower = (x, y, r, rot, tone, open) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    // tip, middle, base
    const pal = [
      ['#ffe6ee', '#f8bfd1', '#e0708f'],
      ['#ffdde8', '#f4b0c6', '#d8648a'],
      ['#ffecf2', '#fac9d8', '#e5809f'],
      ['#ffd9e5', '#f0a2bc', '#cf5a80'],
    ][tone];
    for (let k = 0; k < 5; k++) {
      ctx.save();
      ctx.rotate((k / 5) * Math.PI * 2 + (rng() - 0.5) * 0.2);
      const len = r * (0.94 + rng() * 0.1) * open, wid = r * 0.43 * (0.92 + rng() * 0.16);
      const gr = ctx.createLinearGradient(0, 0, 0, len);
      gr.addColorStop(0, pal[2]); gr.addColorStop(0.4, pal[1]); gr.addColorStop(1, pal[0]);
      ctx.fillStyle = gr;
      petalPath(ctx, len, wid);
      // the shadow it casts on the petals under it (the cup's overlap, soft), on them only
      ctx.globalCompositeOperation = 'source-atop';
      ctx.shadowColor = 'rgba(160,60,100,0.3)'; ctx.shadowBlur = r * 0.05; ctx.shadowOffsetY = -r * 0.01;
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over'; ctx.shadowColor = 'transparent';
      ctx.fill();
      ctx.save();
      ctx.clip();
      // the cup: the petal's sides curl up and catch more light than its middle
      const side = ctx.createLinearGradient(-wid, 0, wid, 0);
      side.addColorStop(0, 'rgba(255,255,255,0.3)'); side.addColorStop(0.3, 'rgba(255,255,255,0)');
      side.addColorStop(0.7, 'rgba(255,255,255,0)'); side.addColorStop(1, 'rgba(255,255,255,0.3)');
      ctx.fillStyle = side; ctx.fillRect(-wid * 1.2, 0, wid * 2.4, len * 1.1);
      // veins fanning from the claw
      ctx.strokeStyle = 'rgba(214,110,148,0.09)'; ctx.lineWidth = Math.max(0.5, r * 0.008);
      for (let v = -3; v <= 3; v++) {
        ctx.beginPath(); ctx.moveTo(0, len * 0.04);
        ctx.quadraticCurveTo(v * wid * 0.16, len * 0.45, v * wid * 0.24, len * 0.95); ctx.stroke();
      }
      ctx.restore();
      ctx.restore();
    }
    // the eye: a small red cup, the stamens round it
    const eye = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.14);
    eye.addColorStop(0, '#c23a62'); eye.addColorStop(0.6, 'rgba(214,92,130,0.8)'); eye.addColorStop(1, 'rgba(236,150,178,0)');
    ctx.fillStyle = eye;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.14, 0, Math.PI * 2); ctx.fill();
    for (let k = 0; k < 22; k++) {
      const a = (k / 22) * Math.PI * 2 + rng() * 0.3, l = r * (0.24 + rng() * 0.14);
      ctx.strokeStyle = 'rgba(252,236,242,0.85)'; ctx.lineWidth = Math.max(0.5, r * 0.012);
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.05, Math.sin(a) * r * 0.05); ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l); ctx.stroke();
      ctx.fillStyle = k % 3 ? '#f0c65a' : '#e3a94a';
      ctx.beginPath(); ctx.arc(Math.cos(a) * l, Math.sin(a) * l, Math.max(0.8, r * 0.026), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };
  const opens = [1.0, 0.96, 0.9, 0.8];
  for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
    const v = cy * 2 + cx;
    ctx.save();
    ctx.beginPath(); ctx.rect(cx * cell + 1, cy * cell + 1, cell - 2, cell - 2); ctx.clip();
    flower(cx * cell + cell / 2, cy * cell + cell / 2, cell * 0.42, rng() * 6.28, [2, 0, 1, 3][v], opens[v]);
    ctx.restore();
  }
  // un-premultiplied data with pink-filled transparent texels: no dark fringes in mips
  const id = ctx.getImageData(0, 0, size, size);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    d[i] = Math.round(d[i] * a + 244 * (1 - a)); d[i + 1] = Math.round(d[i + 1] * a + 178 * (1 - a)); d[i + 2] = Math.round(d[i + 2] * a + 198 * (1 - a));
  }
  return { data: new Uint8Array(d.buffer.slice(0)), size };
}

export function atlasTexture({ data, size }) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

export function paintBark(seed = 3, size = 512) {
  const rng = mulberry32(seed);
  const nz = makeNoise(seed);
  const cv = new OffscreenCanvas(size, size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  const bump = new OffscreenCanvas(size, size);
  const bctx = bump.getContext('2d', { willReadFrequently: true });
  const bimg = bctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    // tileable-ish via sin wrap
    const n1 = nz.noise3(Math.cos(u * 6.283) * 1.2, Math.sin(u * 6.283) * 1.2, v * 3);
    const n2 = nz.noise3(Math.cos(u * 6.283) * 5, Math.sin(u * 6.283) * 5, v * 14);
    const streak = nz.noise3(Math.cos(u * 6.283) * 9, Math.sin(u * 6.283) * 9, v * 2.0);
    let r = 74 + 18 * n1 + 10 * n2 + 10 * streak, g = 56 + 12 * n1 + 7 * n2 + 6 * streak, b = 52 + 12 * n1 + 6 * n2 + 8 * streak;
    const k = (y * size + x) * 4;
    img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
    const h = 120 + 50 * n2 + 40 * streak;
    bimg.data[k] = bimg.data[k + 1] = bimg.data[k + 2] = h; bimg.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0); bctx.putImageData(bimg, 0, 0);
  // horizontal lenticels — the signature of cherry bark
  for (let i = 0; i < 520; i++) {
    const x = rng() * size, y = rng() * size, w = 6 + rng() * 26, h = 1.2 + rng() * 2.4;
    ctx.fillStyle = `rgba(${150 + rng() * 40},${110 + rng() * 30},${90 + rng() * 20},${0.35 + rng() * 0.35})`;
    ctx.beginPath(); ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(25,15,12,0.35)';
    ctx.beginPath(); ctx.ellipse(x, y + h * 0.7, w / 2, h / 3, 0, 0, Math.PI * 2); ctx.fill();
    bctx.fillStyle = 'rgba(230,230,230,0.8)';
    bctx.beginPath(); bctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2); bctx.fill();
    if (x + w > size) { ctx.beginPath(); ctx.ellipse(x - size, y, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  // lichen dabs
  for (let i = 0; i < 60; i++) {
    const x = rng() * size, y = rng() * size, r = 3 + rng() * 10;
    ctx.fillStyle = `rgba(${120 + rng() * 30},${135 + rng() * 25},${95 + rng() * 20},${0.12 + rng() * 0.18})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // rows bottom-up: the same bytes a flipY canvas upload produces, so the textures need no flipY
  const rows = (c) => {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data, out = new Uint8Array(d.length), row = size * 4;
    for (let y = 0; y < size; y++) out.set(d.subarray(y * row, y * row + row), (size - 1 - y) * row);
    return out;
  };
  return { size, map: rows(cv), bump: rows(bump) };
}

export function barkTextures({ size, map, bump }) {
  const make = (data) => {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.userData.rowsFlipped = true;
    t.needsUpdate = true;
    return t;
  };
  const m = make(map); m.colorSpace = THREE.SRGBColorSpace; m.anisotropy = 4;
  return { map: m, bump: make(bump) };
}

// flowers per umbel by quality tier
const UMBEL = { high: [3, 5], medium: [2, 5], low: [2, 3] };
// floats per flower in treeData's attrs: aBendX (bend for a push along x, flex), aBendZ (along z, limb phase), aBob,
// aAtlas.xy, aCrown (crownLight's light: its direction part xyz, its mean w)
export const FLOWER_ATTRS = 17;
// how far the flowers turn to face out of their masses (0: as they grow on their umbels)
const FACE_OUT = 0.7;

// The light inside the crown. The flowers' petal area is splatted onto a grid of CELL m cells and blurred a little,
// and from every cell holding flowers the light that gets in is marched along DIRS directions: the transmittance
// exp(-EXT × the petal area passed per m²) over MARCH m. Per flower, from the cells round it, it is kept as a first-
// order spherical harmonic, T(dir) ≈ w + xyz·dir: w the cell's mean openness to the sky and xyz the way out of its
// mass (towards the light), so the shader can ask how much of the sun, the sky or the ground gets to it.
// pos: the flowers' positions (n × 3), area: their cards' area; returns n × 4 floats.
const CELL = 0.5, MARCH = 4.5, EXT = 0.4, DIRS = 24;
const dirs = Array.from({ length: DIRS }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / DIRS, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5));
  return [r * Math.cos(a), y, r * Math.sin(a)];
});
export function crownLight(pos, area, n) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], pos[i * 3 + c]); hi[c] = Math.max(hi[c], pos[i * 3 + c]); }
  const pad = 2, o = lo.map((v) => v - pad * CELL), N = [0, 1, 2].map((c) => Math.ceil((hi[c] - lo[c]) / CELL) + 2 * pad + 1);
  const [nx, ny, nz] = N, idx = (x, y, z) => (z * ny + y) * nx + x;
  let d = new Float32Array(nx * ny * nz);
  // the cards' area per cell volume (each card's area is about 0.55 × its square's, the flower's outline)
  const g = (i, c) => (pos[i * 3 + c] - o[c]) / CELL - 0.5;
  for (let i = 0; i < n; i++) {
    const fx = g(i, 0), fy = g(i, 1), fz = g(i, 2), x = Math.floor(fx), y = Math.floor(fy), z = Math.floor(fz), u = fx - x, v = fy - y, w = fz - z;
    const a = (area[i] * 0.55) / (CELL * CELL * CELL);
    for (let k = 0; k < 8; k++) {
      const dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2;
      d[idx(x + dx, y + dy, z + dz)] += a * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    }
  }
  // a [1 2 1] blur along each axis
  for (let c = 0; c < 3; c++) {
    const s = c === 0 ? 1 : c === 1 ? nx : nx * ny, len = N[c], b = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) {
      const p = Math.floor(i / s) % len;
      b[i] = 0.5 * d[i] + 0.25 * (p > 0 ? d[i - s] : 0) + 0.25 * (p < len - 1 ? d[i + s] : 0);
    }
    d = b;
  }
  // the cells the flowers interpolate from, lit on demand
  const lit = new Float32Array(nx * ny * nz * 4), done = new Uint8Array(nx * ny * nz), steps = Math.round(MARCH / CELL);
  const cellLight = (x, y, z) => {
    const j = idx(x, y, z);
    if (done[j]) return j * 4;
    done[j] = 1;
    let mean = 0, bx = 0, by = 0, bz = 0;
    for (const [ux, uy, uz] of dirs) {
      let tau = 0;
      for (let s = 1; s <= steps; s++) {
        const px = Math.round(x + ux * s), py = Math.round(y + uy * s), pz = Math.round(z + uz * s);
        if (px < 0 || py < 0 || pz < 0 || px >= nx || py >= ny || pz >= nz) break;
        tau += d[idx(px, py, pz)];
      }
      // (the cell's own half step too: a flower deep in a clump is dimmer than one at its edge)
      const T = Math.exp(-EXT * CELL * (tau + 0.5 * d[j]));
      mean += T; bx += T * ux; by += T * uy; bz += T * uz;
    }
    lit[j * 4] = (3 * bx) / DIRS; lit[j * 4 + 1] = (3 * by) / DIRS; lit[j * 4 + 2] = (3 * bz) / DIRS; lit[j * 4 + 3] = mean / DIRS;
    return j * 4;
  };
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const fx = g(i, 0), fy = g(i, 1), fz = g(i, 2), x = Math.floor(fx), y = Math.floor(fy), z = Math.floor(fz), u = fx - x, v = fy - y, w = fz - z;
    for (let k = 0; k < 8; k++) {
      const dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2, wt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
      const j = cellLight(x + dx, y + dy, z + dz);
      for (let c = 0; c < 4; c++) out[i * 4 + c] += lit[j + c] * wt;
    }
  }
  return out;
}

// one tree: bark geometry and flower instance data
export function treeData(world, seed, cfg, pos, tier = 'high', triMul = 1) {
  const groundAt = (x, z) => world.height(x + pos.x, z + pos.z);
  const t = growTree(seed, cfg, groundAt);
  const bark = triMul > 1 ? tessellate(buildBarkGeometry(t, cfg, groundAt), triMul) : buildBarkGeometry(t, cfg, groundAt);
  const k = cfg.scale;

  const rng = mulberry32(seed + 1);
  const rr = (a, b) => a + (b - a) * rng();
  let per = UMBEL[tier] || UMBEL.high;
  if (cfg.flowerSize > 1) per = [1, Math.max(2, per[1] - 3)];
  const max = t.anchors.length * per[1];
  const matrix = new Float32Array(max * 16), color = new Float32Array(max * 3);
  const attrs = new Float32Array(max * FLOWER_ATTRS);
  const spawn = [], perches = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), sv = new V(), col = new THREE.Color();
  const Z = new V(0, 0, 1), UP = new V(0, 1, 0);
  const { center, ext } = t.canopy;
  // the flowers first (where, which way, how big), then the light in the crown round them (crownLight), which turns
  // them out of their masses and darkens them inside
  const fl = [], fpos = new Float32Array(max * 3), area = new Float32Array(max);
  for (const [ai, an] of t.anchors.entries()) {
    // every fifth flowering point: a place on its twig for a bird (perched.js), along the twig
    if (ai % 5 === 0 && !an.droop) perches.push(an.p.x, an.p.y, an.p.z, an.d.x, an.d.y, an.d.z);
    const perp = anyPerp(an.d).applyAxisAngle(an.d, rng() * TAU);
    const mid = an.p.clone().addScaledVector(perp, rr(0.03, 0.12) * k).addScaledVector(UP, 0.03 * k - (an.droop || 0));
    const nF = per[0] + Math.floor(rng() * (per[1] - per[0] + 1));
    const flex = flexOf(an.f) * (an.droop ? 1.3 : 1), bend = bendAt(an.br, an.i, an.p), phase = an.br.sys ? an.br.sys.phase : 0;
    // a hanging cluster is longer than it is wide
    const spread = new V(1, an.droop ? 1.5 : 1, 1).multiplyScalar(0.12 * k * Math.sqrt(cfg.flowerSize));
    for (let f = 0; f < nF; f++) {
      const p = mid.clone().add(new V(rr(-1, 1), rr(-1, 1), rr(-1, 1)).multiply(spread));
      const nrm = p.clone().sub(an.p).normalize().add(new V(rr(-0.6, 0.6), rr(-0.3, 0.7), rr(-0.6, 0.6))).normalize();
      const spin = rng() * TAU, sz = rr(0.14, 0.21) * k * cfg.flowerSize;
      const atlas = [rng() < 0.5 ? 0 : 0.5, rng() < 0.5 ? 0 : 0.5], blush = Math.pow(rng(), 1.5);
      if (rng() < 0.3) spawn.push(p.x, p.y, p.z);
      p.toArray(fpos, fl.length * 3);
      area[fl.length] = sz * sz;
      fl.push({ p, nrm, spin, sz, atlas, blush, flex, bend, phase });
    }
  }
  const n = fl.length, light = crownLight(fpos, area, n);
  for (let i = 0; i < n; i++) {
    const { p, nrm, spin, sz, atlas, blush, flex, bend, phase } = fl[i];
    const o = i * FLOWER_ATTRS, L = light.subarray(i * 4, i * 4 + 4);
    // the way out of the crown (where the light comes from), or the crown's own outward normal where no way is clear
    const out = new V(L[0], L[1], L[2]);
    const cn = new V((p.x - center.x) / ext.x, (p.y - center.y) / ext.y * 0.8, (p.z - center.z) / ext.z).normalize();
    out.addScaledVector(cn, 0.05);
    // flowers turn to the light: facing out of their mass, they show their faces to whoever looks at it
    nrm.addScaledVector(out.clone().normalize(), FACE_OUT).normalize();
    q.setFromUnitVectors(Z, nrm).multiply(q2.setFromAxisAngle(Z, spin));
    m.compose(p, q, sv.set(sz, sz, sz));
    m.toArray(matrix, i * 16);
    // the flower moves with the point of the branch it grows from
    attrs.set([bend.x.x, bend.x.y, bend.x.z, flex, bend.z.x, bend.z.y, bend.z.z, phase, bend.b.x, bend.b.y, bend.b.z], o);
    attrs[o + 11] = atlas[0]; attrs[o + 12] = atlas[1];
    attrs[o + 13] = out.x; attrs[o + 14] = out.y; attrs[o + 15] = out.z; attrs[o + 16] = L[3];
    // white to blush
    col.setRGB(1, lerp(1, 0.86, blush), lerp(1, 0.9, blush));
    col.toArray(color, i * 3);
  }
  return {
    bark, sig: skeletonSig(t, cfg), n, matrix: matrix.slice(0, n * 16), color: color.slice(0, n * 3), attrs: attrs.slice(0, n * FLOWER_ATTRS),
    spawn: new Float64Array(spawn), trunkBend: trunkBend(t, cfg), perches: new Float32Array(perches),
  };
}

// The wind's bend along the Blender model's branches (the centrelines it was built round), for trunkBendAttributes:
// per point its position and its bend for a push along x and along z (TRUNK_BEND floats), each branch's points in a
// run; runs: [start, count] per branch. The model's part bobs with no limb system.
const TRUNK_BEND = 9;
function trunkBend(t, cfg) {
  const pts = [], runs = [];
  for (const br of fusedOf(t, cfg)) {
    const path = branchPath(br), n = path.pts.length - 1; // without the closing tip, as in trunkSkeleton
    runs.push(pts.length / TRUNK_BEND, n);
    for (let i = 0; i < n; i++) {
      const p = path.pts[i], b = bendAt(br, path.seg[i], p);
      pts.push(p.x, p.y, p.z, b.x.x, b.x.y, b.x.z, b.z.x, b.z.y, b.z.z);
    }
  }
  return { pts: new Float32Array(pts), runs: new Int32Array(runs) };
}

// aBendX, aBendZ and aBob for the Blender model's vertices (positions: its position array, in the tree's frame): each
// takes the bend of the nearest point on the centrelines (interpolated along the segment it is nearest), so the model
// bends as the branches grown onto it do.
export function trunkBendAttributes(positions, { pts, runs }) {
  const nv = positions.length / 3, BX = new Float32Array(nv * 4), BZ = new Float32Array(nv * 4), BB = new Float32Array(nv * 3);
  const segs = [];
  for (let r = 0; r < runs.length; r += 2) for (let i = runs[r]; i < runs[r] + runs[r + 1] - 1; i++) segs.push(i);
  // a grid of the segments by their bounds (cells CELL m), so each vertex only tests the segments near it
  const CELL = 0.75, grid = new Map(), key = (x, y, z) => `${x},${y},${z}`;
  const P = (i, c) => pts[i * TRUNK_BEND + c];
  for (const s of segs) {
    const lo = [0, 1, 2].map((c) => Math.floor(Math.min(P(s, c), P(s + 1, c)) / CELL)), hi = [0, 1, 2].map((c) => Math.floor(Math.max(P(s, c), P(s + 1, c)) / CELL));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = key(x, y, z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(s);
    }
  }
  for (let v = 0; v < nv; v++) {
    const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
    const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL), cz = Math.floor(pz / CELL);
    let best = Infinity, bs = -1, bu = 0;
    // the 3x3x3 cells round it, then wider rings until a segment turns up (the roots' far ends, the trunk's flare)
    for (let ring = 1; bs < 0 && ring < 8; ring++) for (let x = cx - ring; x <= cx + ring; x++) for (let y = cy - ring; y <= cy + ring; y++) for (let z = cz - ring; z <= cz + ring; z++) {
      const list = grid.get(key(x, y, z));
      if (!list) continue;
      for (const s of list) {
        const ax = P(s, 0), ay = P(s, 1), az = P(s, 2), dx = P(s + 1, 0) - ax, dy = P(s + 1, 1) - ay, dz = P(s + 1, 2) - az;
        const u = clamp(((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / Math.max(1e-9, dx * dx + dy * dy + dz * dz), 0, 1);
        const d = (ax + dx * u - px) ** 2 + (ay + dy * u - py) ** 2 + (az + dz * u - pz) ** 2;
        if (d < best) { best = d; bs = s; bu = u; }
      }
    }
    if (bs < 0) continue;
    for (let c = 0; c < 3; c++) {
      BX[v * 4 + c] = lerp(P(bs, 3 + c), P(bs + 1, 3 + c), bu);
      BZ[v * 4 + c] = lerp(P(bs, 6 + c), P(bs + 1, 6 + c), bu);
    }
  }
  return { BX, BZ, BB };
}

// ---------- the Blender model's part ----------
// The trunk, the roots and the branches to depth cfg.fused are modelled in Blender (tools/cherry.py, one fused and
// gnarled surface, in src/models/cherry.glb) from this: the same branches the rest of the tree grows from, as rendered
// (smoothed), the canopy the bark's shading darkens towards, and the ground round the tree. The model is only right for the skeleton it was built from: skeletonSig tells if it went stale.
const fusedOf = (t, cfg) => t.branches.filter((br) => br.depth <= cfg.fused);
export function skeletonSig(t, cfg) {
  let h = 0;
  for (const br of fusedOf(t, cfg)) for (const p of br.pts) h = (h * 31 + Math.round(p.x * 997 + p.y * 1999 + p.z * 2999)) | 0;
  return h;
}
export function trunkSkeleton(world, seed, cfg, pos) {
  const groundAt = (x, z) => world.height(x + pos.x, z + pos.z);
  const t = growTree(seed, cfg, groundAt);
  const r3 = (v) => [v.x, v.y, v.z].map((a) => +a.toFixed(4));
  const branches = fusedOf(t, cfg).map((br) => {
    const { pts, rad } = branchPath(br);
    const n = pts.length - 1; // without the closing tip: the model rounds its own ends
    return { depth: br.depth, pts: pts.slice(0, n).map(r3), rad: rad.slice(0, n).map((r) => +r.toFixed(4)) };
  });
  // ground heights round the tree, 0.5 m apart
  const G = 24, ground = [];
  for (let j = -G; j <= G; j++) for (let i = -G; i <= G; i++) ground.push(+groundAt(i * 0.5, j * 0.5).toFixed(3));
  return { sig: skeletonSig(t, cfg), branches, canopy: { center: r3(t.canopy.center), ext: r3(t.canopy.ext) }, ground: { n: G, step: 0.5, h: ground } };
}
