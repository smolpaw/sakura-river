// Procedural cherry tree: recursive branch growth -> merged tube geometry + blossom anchors
import * as THREE from 'three';
import { mulberry32, makeNoise, clamp, lerp, smoothstep } from './noise.js';
import { tessellate } from './stress.js';

const V = THREE.Vector3;

export const MAIN_TREE = {
  maxDepth: 4,
  trunk: { length: 3.3, radius: 0.6, lean: 0.12 },
  levels: [
    { segLen: 0.22, up: 0.0, outward: 0.0, wobble: 0.22, taper: 0.66, children: [4, 4], tMin: 0.8, tMax: 1.0, angle: [0.5, 0.82], lenRatio: [2.0, 2.5], radRatio: 0.6, lenFall: 0 },
    { segLen: 0.3, up: 0.02, outward: 0.075, wobble: 0.34, taper: 0.4, children: [6, 8], tMin: 0.16, tMax: 0.98, angle: [0.5, 0.95], lenRatio: [0.44, 0.6], radRatio: 0.56, lenFall: 0.45 },
    { segLen: 0.26, up: -0.01, outward: 0.05, wobble: 0.55, taper: 0.38, children: [5, 7], tMin: 0.14, tMax: 0.98, angle: [0.45, 0.95], lenRatio: [0.45, 0.62], radRatio: 0.56, lenFall: 0.35 },
    { segLen: 0.22, up: -0.05, outward: 0.03, wobble: 0.75, taper: 0.35, children: [4, 6], tMin: 0.18, tMax: 1.0, angle: [0.4, 0.9], lenRatio: [0.42, 0.58], radRatio: 0.62, lenFall: 0.2 },
    { segLen: 0.18, up: -0.07, outward: 0.0, wobble: 0.9, taper: 0.3, children: [0, 0] },
  ],
  blossomDensity: [0, 0, 0.55, 2.3, 4.2],
  minY: 2.4,
  roots: 6,
};

export const SMALL_TREE = {
  maxDepth: 4,
  trunk: { length: 2.6, radius: 0.36, lean: 0.1 },
  levels: [
    { segLen: 0.3, up: 0.0, outward: 0.0, wobble: 0.25, taper: 0.65, children: [3, 4], tMin: 0.78, tMax: 1.0, angle: [0.45, 0.8], lenRatio: [1.8, 2.3], radRatio: 0.62, lenFall: 0 },
    { segLen: 0.4, up: 0.03, outward: 0.07, wobble: 0.35, taper: 0.4, children: [5, 6], tMin: 0.2, tMax: 0.98, angle: [0.5, 0.95], lenRatio: [0.45, 0.6], radRatio: 0.56, lenFall: 0.45 },
    { segLen: 0.35, up: -0.01, outward: 0.05, wobble: 0.55, taper: 0.38, children: [4, 5], tMin: 0.2, tMax: 0.98, angle: [0.45, 0.95], lenRatio: [0.45, 0.62], radRatio: 0.56, lenFall: 0.35 },
    { segLen: 0.3, up: -0.05, outward: 0.03, wobble: 0.75, taper: 0.35, children: [3, 4], tMin: 0.25, tMax: 1.0, angle: [0.4, 0.9], lenRatio: [0.45, 0.6], radRatio: 0.62, lenFall: 0.2 },
    { segLen: 0.3, up: -0.07, outward: 0.0, wobble: 0.9, taper: 0.3, children: [0, 0] },
  ],
  blossomDensity: [0, 0, 0.6, 1.9, 3.2],
  minY: 2.0,
  roots: 0,
};

function anyPerp(d) {
  const a = Math.abs(d.y) < 0.9 ? new V(0, 1, 0) : new V(1, 0, 0);
  return new V().crossVectors(d, a).normalize();
}

export function growTree(seed, cfg, groundAt = () => 0) {
  const rng = mulberry32(seed);
  const nz = makeNoise(seed + 99);
  const branches = [];
  const blossoms = [];

  function grow(start, dir, length, radius, depth, pathLen) {
    const L = cfg.levels[depth];
    const segs = Math.max(3, Math.ceil(length / L.segLen));
    const step = length / segs;
    const pts = [start.clone()], rad = [radius], flex = [pathLen], dirs = [dir.clone()];
    let p = start.clone();
    const d = dir.clone();
    for (let i = 1; i <= segs; i++) {
      const out = new V(p.x, 0, p.z);
      if (out.lengthSq() < 1e-4) out.set(d.x, 0, d.z);
      if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
      out.normalize();
      d.addScaledVector(out, L.outward * step);
      d.y += L.up * step;
      d.x += (rng() - 0.5) * L.wobble * step;
      d.z += (rng() - 0.5) * L.wobble * step;
      d.y += (rng() - 0.5) * L.wobble * step * 0.5;
      if (p.y < cfg.minY && depth > 0 && d.y < 0.25) d.y += 0.35 * step;
      if (depth >= 1 && d.y > 0.85) d.y -= 0.1 * step; // keep the crown spreading
      d.normalize();
      p = p.clone().addScaledVector(d, step);
      const t = i / segs;
      pts.push(p); dirs.push(d.clone());
      rad.push(radius * (1 - (1 - L.taper) * Math.pow(t, 0.9)));
      flex.push(pathLen + step * i);
    }
    branches.push({ pts, rad, flex, depth });

    const at = (t) => {
      const f = t * segs, i = Math.min(segs - 1, Math.floor(f)), u = f - i;
      return {
        p: pts[i].clone().lerp(pts[i + 1], u),
        d: dirs[i].clone().lerp(dirs[i + 1], u).normalize(),
        r: lerp(rad[i], rad[i + 1], u),
        f: lerp(flex[i], flex[i + 1], u),
      };
    };

    if (depth < cfg.maxDepth) {
      const n = L.children[0] + Math.floor(rng() * (L.children[1] - L.children[0] + 1));
      let roll = rng() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const t = L.tMin + (L.tMax - L.tMin) * ((k + 0.2 + rng() * 0.6) / n);
        const s = at(t);
        roll += 2.39996 + (rng() - 0.5) * 0.7;
        const perp = anyPerp(s.d).applyAxisAngle(s.d, roll);
        const ang = lerp(L.angle[0], L.angle[1], rng());
        const cd = s.d.clone().applyAxisAngle(perp, ang);
        // cherry: favour horizontal outward spread
        if (depth >= 1) { cd.y *= 0.75; cd.normalize(); }
        const clen = length * lerp(L.lenRatio[0], L.lenRatio[1], rng()) * (1 - L.lenFall * t);
        const crad = Math.max(0.01, s.r * L.radRatio * (0.85 + rng() * 0.25));
        const start = s.p.clone().addScaledVector(cd, -s.r * 0.25);
        grow(start, cd, clen, crad, depth + 1, s.f);
      }
    }

    const dens = cfg.blossomDensity[depth] || 0;
    if (dens > 0) {
      const count = Math.max(1, Math.round(length * dens * (0.7 + rng() * 0.6)));
      const t0 = depth >= 4 ? 0.1 : depth === 3 ? 0.35 : 0.55;
      for (let k = 0; k < count; k++) {
        const t = t0 + (1 - t0) * rng();
        const s = at(t);
        const off = new V(rng() - 0.5, rng() - 0.3, rng() - 0.5).multiplyScalar(0.35 + depth * 0.02);
        blossoms.push({ p: s.p.add(off), f: s.f, depth });
      }
      // always one at the tip
      if (depth >= 3) { const s = at(1); blossoms.push({ p: s.p, f: s.f, depth }); }
    }
  }

  // trunk
  const T = cfg.trunk;
  const g0 = groundAt(0, 0);
  const tdir = new V((rng() - 0.5) * T.lean, 1, (rng() - 0.5) * T.lean).normalize();
  grow(new V(0, g0 - 0.5, 0), tdir, T.length + 0.5, T.radius, 0, 0);

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
  for (const b of blossoms) c.add(b.p);
  c.multiplyScalar(1 / Math.max(1, blossoms.length));
  let ext = new V(1e-3, 1e-3, 1e-3);
  for (const b of blossoms) { ext.x = Math.max(ext.x, Math.abs(b.p.x - c.x)); ext.y = Math.max(ext.y, Math.abs(b.p.y - c.y)); ext.z = Math.max(ext.z, Math.abs(b.p.z - c.z)); }
  c.y -= ext.y * 0.25;
  return { branches, blossoms, canopy: { center: c, ext }, nz };
}

// ---------- geometry ----------
export function buildBarkGeometry(tree, groundAt = () => 0) {
  const P = [], Nn = [], UV = [], F = [], C = [], I = [];
  const nz = tree.nz;
  const { center, ext } = tree.canopy;
  let vbase = 0;
  const tmpN = new V(), tmpB = new V();
  for (const br of tree.branches) {
    let pts = br.pts, rad = br.rad, flex = br.flex;
    // smooth heavy limbs
    if (br.depth <= 1 && pts.length > 3) {
      const curve = new THREE.CatmullRomCurve3(pts);
      const n = pts.length * 2;
      const np = curve.getPoints(n);
      const r2 = [], f2 = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * (pts.length - 1), k = Math.min(pts.length - 2, Math.floor(t)), u = t - k;
        r2.push(lerp(rad[k], rad[k + 1], u)); f2.push(lerp(flex[k], flex[k + 1], u));
      }
      pts = np; rad = r2; flex = f2;
    }
    // closing tip
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const tipDir = last.clone().sub(prev).normalize();
    pts = pts.concat([last.clone().addScaledVector(tipDir, rad[rad.length - 1] * 0.8)]);
    rad = rad.concat([0.0005]);
    flex = flex.concat([flex[flex.length - 1]]);

    const r0 = rad[0];
    const radial = br.depth <= 0 ? 18 : r0 > 0.2 ? 14 : r0 > 0.09 ? 10 : r0 > 0.04 ? 7 : r0 > 0.02 ? 5 : 4;
    const n = pts.length;
    // parallel transport frames
    const Ts = [], Ns = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      Ts.push(b.clone().sub(a).normalize());
    }
    Ns.push(anyPerp(Ts[0]));
    for (let i = 1; i < n; i++) {
      const axis = new V().crossVectors(Ts[i - 1], Ts[i]);
      const nn = Ns[i - 1].clone();
      const l = axis.length();
      if (l > 1e-5) { axis.multiplyScalar(1 / l); nn.applyAxisAngle(axis, Math.acos(clamp(Ts[i - 1].dot(Ts[i]), -1, 1))); }
      Ns.push(nn);
    }
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
        if (br.depth === 0) {
          const fl = Math.exp(-Math.max(0, hg + 0.3) * 1.9);
          r *= 1 + 0.85 * fl * (0.7 + 0.3 * Math.pow(0.5 + 0.5 * Math.sin(a * 5 + 1.3), 2));
        }
        P.push(p.x + tmpN.x * r, p.y + tmpN.y * r, p.z + tmpN.z * r);
        Nn.push(tmpN.x, tmpN.y, tmpN.z);
        UV.push((j / radial) * circ, s * 0.9);
        // flex: 0 at trunk, grows with path length
        const fx = Math.pow(clamp((flex[i] - 2.2) / 14, 0, 1.4), 1.55);
        F.push(br.depth < 0 ? 0 : fx);
        // bark AO + moss near ground
        const q = new V((p.x - center.x) / ext.x, (p.y - center.y) / ext.y, (p.z - center.z) / ext.z).length();
        let ao = lerp(0.55, 1.0, smoothstep(0.2, 1.05, q));
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

// three crossed, cupped cards
export function buildBlossomCardGeometry() {
  const P = [], Nn = [], UV = [], I = [];
  let base = 0;
  const seg = 3;
  for (let q = 0; q < 3; q++) {
    const rotY = (q / 3) * Math.PI, tilt = q === 0 ? 0 : q === 1 ? 0.45 : -0.4;
    const m = new THREE.Matrix4().makeRotationY(rotY).multiply(new THREE.Matrix4().makeRotationX(tilt));
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) {
      const u = i / seg, v = j / seg;
      const x = u - 0.5, y = v - 0.5;
      const z = -0.28 * (x * x + y * y);
      const p = new V(x, y, z).applyMatrix4(m);
      const n = new V(x * 0.55, y * 0.55, 1).normalize().applyMatrix3(nm).normalize();
      P.push(p.x, p.y, p.z); Nn.push(n.x, n.y, n.z); UV.push(u, v);
    }
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
      const a = base + j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      I.push(a, b, c, b, d, c);
    }
    base += (seg + 1) * (seg + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(I);
  return g;
}

// blossom cluster atlas (2x2 variants) painted procedurally
export function paintBlossomAtlas(seed = 5, size = 1024) {
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
  const bud = (x, y, r, rot) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = '#e46f93';
    ctx.beginPath(); ctx.ellipse(0, 0, r * 0.45, r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6d3a2a'; ctx.fillRect(-r * 0.06, r * 0.6, r * 0.12, r * 0.7);
    ctx.restore();
  };
  const leaf = (x, y, r, rot) => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    const gr = ctx.createLinearGradient(0, 0, 0, r);
    gr.addColorStop(0, '#6b5a1e'); gr.addColorStop(1, '#8a9a36');
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(r * 0.45, r * 0.5, 0, r * 1.2); ctx.quadraticCurveTo(-r * 0.45, r * 0.5, 0, 0); ctx.fill();
    ctx.restore();
  };
  for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
    const ox = cx * cell + cell / 2, oy = cy * cell + cell / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(cx * cell + 2, cy * cell + 2, cell - 4, cell - 4); ctx.clip();
    // twig
    ctx.strokeStyle = 'rgba(92,52,44,0.55)'; ctx.lineWidth = cell * 0.008; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(ox - cell * 0.3, oy + cell * 0.22); ctx.quadraticCurveTo(ox, oy + cell * 0.05, ox + cell * 0.26, oy - cell * 0.2); ctx.stroke();
    const items = [];
    const nF = 32 + Math.floor(rng() * 10);
    for (let k = 0; k < nF; k++) {
      const a = rng() * Math.PI * 2, rr = Math.pow(rng(), 0.6) * cell * 0.37;
      items.push({ x: ox + Math.cos(a) * rr, y: oy + Math.sin(a) * rr * 0.92, r: cell * (0.075 + rng() * 0.05) * (1 - rr / (cell * 0.9)), type: rng() < 0.08 ? 'bud' : rng() < 0.03 ? 'leaf' : 'f' });
    }
    items.sort((a, b) => a.r - b.r);
    for (const it of items) {
      if (it.type === 'bud') bud(it.x, it.y, it.r * 0.8, rng() * 6.28);
      else if (it.type === 'leaf') leaf(it.x, it.y, it.r * 1.3, rng() * 6.28);
      else flower(it.x, it.y, it.r, rng() * 6.28, Math.floor(rng() * 4), 0.85 + rng() * 0.2);
    }
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
    let r = 58 + 18 * n1 + 10 * n2 + 10 * streak, g = 40 + 12 * n1 + 7 * n2 + 6 * streak, b = 38 + 12 * n1 + 6 * n2 + 8 * streak;
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

// one tree: bark geometry + blossom-card instance data (moved from main.js; same RNG order)
export function treeData(world, seed, cfg, pos, blossomScale = 1, triMul = 1) {
  const groundAt = (x, z) => world.height(x + pos.x, z + pos.z);
  const t = growTree(seed, cfg, groundAt);
  const bark = triMul > 1 ? tessellate(buildBarkGeometry(t, groundAt), triMul) : buildBarkGeometry(t, groundAt);
  const rng = mulberry32(seed + 1);
  const n = t.blossoms.length;
  const matrix = new Float32Array(n * 16), color = new Float32Array(n * 3);
  const aFlex = new Float32Array(n), aAtlas = new Float32Array(n * 2), aCan = new Float32Array(n * 3);
  const spawn = new Float64Array(n * 3);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new V(), e = new THREE.Euler(), col = new THREE.Color();
  const { center, ext } = t.canopy;
  t.blossoms.forEach((b, i) => {
    e.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
    q.setFromEuler(e);
    const sz = (0.85 + rng() * 0.55) * blossomScale * (b.depth <= 2 ? 1.15 : 1);
    s.set(sz, sz, sz);
    m.compose(b.p, q, s);
    m.toArray(matrix, i * 16);
    aFlex[i] = Math.pow(clamp((b.f - 2.2) / 14, 0, 1.4), 1.55);
    aAtlas[i * 2] = rng() < 0.5 ? 0 : 0.5; aAtlas[i * 2 + 1] = rng() < 0.5 ? 0 : 0.5;
    const cn = new V((b.p.x - center.x) / ext.x, (b.p.y - center.y) / ext.y * 0.8, (b.p.z - center.z) / ext.z);
    const r = cn.length();
    cn.normalize();
    aCan[i * 3] = cn.x; aCan[i * 3 + 1] = cn.y; aCan[i * 3 + 2] = cn.z;
    const ao = lerp(0.3, 1.0, smoothstep(0.3, 1.05, r)) * (0.75 + 0.25 * clamp(cn.y + 0.5, 0, 1));
    const hue = rng();
    col.setRGB(ao * (0.98 + hue * 0.04), ao * (0.8 + hue * 0.14) * lerp(0.85, 1, ao), ao * (0.88 + hue * 0.08));
    col.toArray(color, i * 3);
    spawn[i * 3] = b.p.x; spawn[i * 3 + 1] = b.p.y; spawn[i * 3 + 2] = b.p.z;
  });
  return { bark, n, matrix, color, aFlex, aAtlas, aCanopyN: aCan, spawn };
}
