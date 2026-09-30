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
  fill: [0, 0, 2, 4, 4, 0], // more umbels along the inner branches (full bloom), from their own rng: same tree
  flowerSize: 1,
  minY: 2.2,
  roots: 6,
};

export const SMALL_TREE = {
  scale: 1.25,
  trunk: { length: 2.1, radius: 0.36, lean: 0.12 },
  limbs: [4, 5],
  maxDepth: 4,
  umbels: [0, 0, 2, 5, 9],
  flowerSize: 1.7, // seen from afar: fewer, larger flowers
  minY: 1.8,
  roots: 0,
};

const TAU = Math.PI * 2;

function anyPerp(d) {
  const a = Math.abs(d.y) < 0.9 ? new V(0, 1, 0) : new V(1, 0, 0);
  return new V().crossVectors(d, a).normalize();
}

export function growTree(seed, cfg, groundAt = () => 0) {
  const rng = mulberry32(seed), rngFill = mulberry32(seed + 3);
  const rr = (a, b) => a + (b - a) * rng();
  const nz = makeNoise(seed + 99);
  const k = cfg.scale, D = cfg.maxDepth;
  const branches = [];
  const anchors = []; // umbel sites: { p, d, f, depth }

  function grow(start, dir, length, radius, depth, pathLen) {
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
    branches.push({ pts, rad, flex, depth });

    const at = (t) => {
      const f = t * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
      return {
        p: pts[i].clone().lerp(pts[i + 1], u),
        d: dirs[i].clone().lerp(dirs[i + 1], u).normalize(),
        r: lerp(rad[i], rad[i + 1], u),
        f: lerp(flex[i], flex[i + 1], u),
      };
    };

    const nU = cfg.umbels[depth] || 0;
    for (let u = 0; u < nU; u++) {
      const s = at(depth === D ? 1 - rng() * rng() * 0.75 : rr(0.3, 1)); // terminal twigs flower towards the tip
      anchors.push({ p: s.p, d: s.d, f: s.f, depth });
    }
    for (let u = 0; u < ((cfg.fill && cfg.fill[depth]) || 0); u++) {
      const s = at(0.25 + 0.75 * rngFill());
      anchors.push({ p: s.p, d: s.d, f: s.f, depth });
    }
    if (depth === D) return;

    const kids = depth === 0 ? cfg.limbs[0] + Math.floor(rng() * (cfg.limbs[1] - cfg.limbs[0] + 1)) : depth === D - 1 ? 2 : 3;
    const az0 = rng() * TAU;
    for (let c = 0; c < kids; c++) {
      let s, cd, clen, crad;
      if (depth === 0) {
        // limbs: evenly around the trunk, 53-70 degrees from vertical
        s = at(rr(0.8, 1));
        const az = az0 + (c / kids) * TAU + rr(-0.3, 0.3), pol = rr(0.92, 1.22);
        cd = new V(Math.sin(pol) * Math.cos(az), Math.cos(pol), Math.sin(pol) * Math.sin(az));
        clen = (length - 0.5) * rr(1.1, 1.35);
        crad = s.r * rr(0.66, 0.78);
      } else {
        const lead = c === 0;
        s = at(lead ? 1 : rr(0.4, 0.88));
        const axis = anyPerp(s.d).applyAxisAngle(s.d, rng() * TAU);
        cd = s.d.clone().applyAxisAngle(axis, lead ? rr(0.12, 0.32) : rr(0.5, 0.95));
        const out = new V(s.p.x, 0, s.p.z);
        if (out.lengthSq() > 1e-4) cd.addScaledVector(out.normalize(), 0.22); // open crown
        cd.normalize();
        clen = length * (lead ? rr(0.72, 0.84) : rr(0.55, 0.74));
        crad = s.r * (lead ? 0.8 : rr(0.52, 0.68));
      }
      grow(s.p.clone().addScaledVector(cd, -crad * 0.5), cd, clen, crad, depth + 1, s.f);
    }
  }

  // trunk (starts half a unit below the ground so the flare sits in it)
  const T = cfg.trunk;
  const g0 = groundAt(0, 0);
  const tdir = new V((rng() - 0.5) * T.lean, 1, (rng() - 0.5) * T.lean).normalize();
  grow(new V(0, g0 - 0.5, 0), tdir, T.length * k + 0.5, T.radius * k, 0, 0);

  // surface roots
  const roots = [];
  for (let i = 0; i < cfg.roots; i++) {
    const a = (i / cfg.roots) * Math.PI * 2 + rng() * 0.6;
    const len = 1.6 + rng() * 1.6;
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
    roots.push({ pts, rad, flex, depth: -1 });
  }
  branches.push(...roots);

  // canopy centre + extents for blossom normals / AO
  const c = new V();
  for (const b of anchors) c.add(b.p);
  c.multiplyScalar(1 / Math.max(1, anchors.length));
  let ext = new V(1e-3, 1e-3, 1e-3);
  for (const b of anchors) { ext.x = Math.max(ext.x, Math.abs(b.p.x - c.x)); ext.y = Math.max(ext.y, Math.abs(b.p.y - c.y)); ext.z = Math.max(ext.z, Math.abs(b.p.z - c.z)); }
  c.y -= ext.y * 0.25;
  return { branches, anchors, canopy: { center: c, ext }, nz };
}

// a branch's centreline as rendered: Catmull-Rom smoothed (rings per depth), plus a closing tip
const RINGS = [24, 14, 10, 7, 5, 4];
function branchPath(br) {
  let { pts, rad, flex } = br;
  if (br.depth >= 0) {
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const n = RINGS[Math.min(br.depth, RINGS.length - 1)];
    const np = curve.getPoints(n);
    const r2 = [], f2 = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * (pts.length - 1), k = Math.min(pts.length - 2, Math.floor(t)), u = t - k;
      r2.push(lerp(rad[k], rad[k + 1], u)); f2.push(lerp(flex[k], flex[k + 1], u));
    }
    pts = np; rad = r2; flex = f2;
  }
  const last = pts[pts.length - 1], prev = pts[pts.length - 2];
  const tipDir = last.clone().sub(prev).normalize();
  return {
    pts: pts.concat([last.clone().addScaledVector(tipDir, rad[rad.length - 1] * 0.8)]),
    rad: rad.concat([0.0005]),
    flex: flex.concat([flex[flex.length - 1]]),
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

// wind flexibility from path length along the tree (0 at the trunk)
const flexOf = (f) => Math.pow(clamp((f - 2.2) / 14, 0, 1.4), 1.55);

// ---------- geometry ----------
export function buildBarkGeometry(tree, groundAt = () => 0) {
  const P = [], Nn = [], UV = [], F = [], C = [], I = [];
  const nz = tree.nz;
  const { center, ext } = tree.canopy;
  let vbase = 0;
  const tmpN = new V(), tmpB = new V();
  for (const br of tree.branches) {
    const { pts, rad, flex } = branchPath(br);
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
        // flex: 0 at trunk, grows with path length
        F.push(br.depth < 0 ? 0 : flexOf(flex[i]));
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
  g.setAttribute('aFlex', new THREE.Float32BufferAttribute(F, 1));
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

// single-flower atlas (2x2 variants) painted procedurally
export function paintFlowerAtlas(seed = 5, size = 1024) {
  const rng = mulberry32(seed);
  const cv = new OffscreenCanvas(size, size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cell = size / 2;
  const petalPath = (ctx, len, wid) => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(wid * 0.9, len * 0.25, wid * 1.05, len * 0.8, wid * 0.32, len);
    ctx.quadraticCurveTo(0, len * 0.86, -wid * 0.32, len);
    ctx.bezierCurveTo(-wid * 1.05, len * 0.8, -wid * 0.9, len * 0.25, 0, 0);
    ctx.closePath();
  };
  const flower = (x, y, r, rot, tone, open) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    const pal = [
      ['#ffe6ee', '#f8bfd1', '#e0708f'],
      ['#ffd9e5', '#f2a3bd', '#d45a80'],
      ['#fff0f4', '#fbd0dd', '#e98aa6'],
      ['#ffd2e0', '#ee94b2', '#c84874'],
    ][tone];
    for (let k = 0; k < 5; k++) {
      ctx.save();
      ctx.rotate((k / 5) * Math.PI * 2 + (rng() - 0.5) * 0.25);
      const len = r * (0.9 + rng() * 0.2) * open, wid = r * 0.55 * (0.9 + rng() * 0.2);
      const gr = ctx.createLinearGradient(0, 0, 0, len);
      gr.addColorStop(0, pal[2]); gr.addColorStop(0.35, pal[1]); gr.addColorStop(1, pal[0]);
      ctx.fillStyle = gr;
      petalPath(ctx, len, wid);
      ctx.fill();
      ctx.strokeStyle = 'rgba(200,90,120,0.18)'; ctx.lineWidth = Math.max(0.5, r * 0.02); ctx.stroke();
      ctx.restore();
    }
    // stamens
    ctx.fillStyle = '#b8325c';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2); ctx.fill();
    for (let k = 0; k < 14; k++) {
      const a = rng() * Math.PI * 2, l = r * (0.25 + rng() * 0.2);
      ctx.strokeStyle = 'rgba(250,235,240,0.9)'; ctx.lineWidth = Math.max(0.5, r * 0.025);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l); ctx.stroke();
      ctx.fillStyle = '#f2c14e';
      ctx.beginPath(); ctx.arc(Math.cos(a) * l, Math.sin(a) * l, Math.max(0.8, r * 0.04), 0, Math.PI * 2); ctx.fill();
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
const UMBEL = { high: [4, 7], medium: [3, 6], low: [2, 4] };

// one tree: bark geometry and flower instance data
export function treeData(world, seed, cfg, pos, tier = 'high', triMul = 1) {
  const groundAt = (x, z) => world.height(x + pos.x, z + pos.z);
  const t = growTree(seed, cfg, groundAt);
  const bark = triMul > 1 ? tessellate(buildBarkGeometry(t, groundAt), triMul) : buildBarkGeometry(t, groundAt);
  const k = cfg.scale;

  const rng = mulberry32(seed + 1);
  const rr = (a, b) => a + (b - a) * rng();
  let per = UMBEL[tier] || UMBEL.high;
  if (cfg.flowerSize > 1) per = [1, Math.max(2, per[1] - 3)];
  const max = t.anchors.length * per[1];
  const matrix = new Float32Array(max * 16), color = new Float32Array(max * 3);
  const attrs = new Float32Array(max * 6); // aFlex, aAtlas.xy, aCanopyN.xyz
  const spawn = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), sv = new V(), col = new THREE.Color();
  const Z = new V(0, 0, 1), UP = new V(0, 1, 0);
  const { center, ext } = t.canopy;
  let n = 0;
  for (const an of t.anchors) {
    const perp = anyPerp(an.d).applyAxisAngle(an.d, rng() * TAU);
    const mid = an.p.clone().addScaledVector(perp, rr(0.03, 0.12) * k).addScaledVector(UP, 0.03 * k);
    const nF = per[0] + Math.floor(rng() * (per[1] - per[0] + 1));
    const flex = flexOf(an.f);
    for (let f = 0; f < nF; f++) {
      const p = mid.clone().add(new V(rr(-1, 1), rr(-1, 1), rr(-1, 1)).multiplyScalar(0.12 * k * Math.sqrt(cfg.flowerSize)));
      const nrm = p.clone().sub(an.p).normalize().add(new V(rr(-0.6, 0.6), rr(-0.3, 0.7), rr(-0.6, 0.6))).normalize();
      q.setFromUnitVectors(Z, nrm).multiply(q2.setFromAxisAngle(Z, rng() * TAU));
      const sz = rr(0.14, 0.21) * k * cfg.flowerSize;
      m.compose(p, q, sv.set(sz, sz, sz));
      m.toArray(matrix, n * 16);
      const cn = new V((p.x - center.x) / ext.x, (p.y - center.y) / ext.y * 0.8, (p.z - center.z) / ext.z);
      const r = cn.length();
      cn.normalize();
      const o = n * 6;
      attrs[o] = flex;
      attrs[o + 1] = rng() < 0.5 ? 0 : 0.5; attrs[o + 2] = rng() < 0.5 ? 0 : 0.5;
      attrs[o + 3] = cn.x; attrs[o + 4] = cn.y; attrs[o + 5] = cn.z;
      // inner flowers darker (canopy AO), white to blush
      const ao = lerp(0.45, 1.0, smoothstep(0.3, 1.05, r)) * (0.8 + 0.2 * clamp(cn.y + 0.5, 0, 1));
      const blush = Math.pow(rng(), 1.5);
      col.setRGB(ao, ao * lerp(1, 0.86, blush), ao * lerp(1, 0.9, blush));
      col.toArray(color, n * 3);
      if (rng() < 0.3) spawn.push(p.x, p.y, p.z);
      n++;
    }
  }
  return {
    bark, n, matrix: matrix.slice(0, n * 16), color: color.slice(0, n * 3), attrs: attrs.slice(0, n * 6),
    spawn: new Float64Array(spawn),
  };
}
