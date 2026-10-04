// The nobori's generation (src/banners.js draws them): where the banners stand, their bamboo poles as one merged
// geometry, and the brush characters down their cloth painted into an ink atlas. Runs in the lanterns' job.
// They stand in pairs: flanking the torii at the foot of the temple's approach, beside three of the stone-lantern pairs
// up it (just outside the lanterns), and either side of each of the bridge's landings. Each pair's spots are rough;
// the place is searched round each spot: off the lanes and the walker's corridor and landings (walk.js), off the
// farmland, the pads and the bridge, out of the river's banks where the lamps stand, clear of the stone lanterns, the
// torii's pillars, the lantern lines' posts and ropes, the bonbori, the wayside's stones and the small cherries, with
// the cloth's whole width clear too. The cross-arm points away from the path, so the cloth hangs outside its pole and
// faces along the way, its front (the side that reads) towards those arriving: from the bridge, up the approach.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../noise.js';
import { bridgeFrame, bridgeRopeAnchors, BRIDGE_Z } from '../props.js';
import { TORII, toroSites } from '../village.js';
import { waysideSites } from '../wayside.js';
import { FONT, hasJapaneseFont } from '../lanterns.js';

// the cloth: W wide, H tall, its top edge DROP below the arm, its tied edge GAP out from the pole's axis; the arm
// ARM up the pole (from the ground), the pole POLE tall, sunk 0.15 m
export const BANNER = { W: 0.6, H: 3.2, ARM: 4.3, POLE: 4.5, GAP: 0.045, DROP: 0.03 };
// what they say, written down the cloth in one column (奉納 "dedicated", 桜まつり "cherry festival", 千本桜 "a
// thousand cherries", 春季大祭 "the great spring festival")
export const BANNER_TEXTS = ['奉納', '桜まつり', '千本桜', '春季大祭'];
// the atlas: one cell per text, `cols` across; the writing fills the cloth's u0..u1 and v0..v1 (below the band)
export const BANNER_INK = { w: 128, h: 640, u0: 0.1, u1: 0.9, v0: 0.15, v1: 0.97 };

const CLEAR_LANE = 1.65; // the pole and the cloth's far edge from a lane's middle (walk.js: the corridor's 1.2 m and a body)
const SEARCH = 2.5; // m round each spot
const ARM_OUT = BANNER.GAP + BANNER.W + 0.05;

const BAMBOO = [0.37, 0.31, 0.16], NODE = [0.24, 0.2, 0.1], STONE = [0.3, 0.29, 0.26];
const BRASS = [0.6, 0.42, 0.16], WHITE = [0.8, 0.78, 0.7], RED = [0.5, 0.06, 0.03];

// lamps: lanternData's result (the lines' posts in lists[0], the bonbori)
export function bannerData(world, lamps) {
  const rng = mulberry32(88);
  const B = bridgeFrame(world, BRIDGE_Z);
  const across = { x: B.across.x, z: B.across.z }, along = { x: B.along.x, z: B.along.z };
  // what stands in the way, as circles { x, z, r }
  const block = [];
  for (const t of toroSites(world)) block.push({ x: t.x, z: t.z, r: 0.75 });
  for (const t of TORII) for (const s of [-1, 1]) block.push({ x: t.x + s * 1.6 * Math.cos(t.yaw), z: t.z - s * 1.6 * Math.sin(t.yaw), r: 0.7 });
  for (const [x, z] of world.CLEAR) block.push({ x, z, r: 2.5 });
  const posts = lamps.lists[0];
  for (let i = 0; i < posts.n; i++) block.push({ x: posts.matrix[i * 16 + 12], z: posts.matrix[i * 16 + 14], r: 0.6 });
  for (let i = 0; i < lamps.bonbori.length; i += 3) block.push({ x: lamps.bonbori[i], z: lamps.bonbori[i + 2], r: 0.7 });
  // the lantern lines' ropes: from each bridge corner along the posts on its bank (sampled every 0.5 m)
  const anchors = bridgeRopeAnchors(world);
  for (const side of [-1, 1]) {
    const line = [anchors[side]];
    const mine = [];
    for (let i = 0; i < posts.n; i++) {
      const x = posts.matrix[i * 16 + 12], z = posts.matrix[i * 16 + 14];
      if (Math.sign(x - world.riverX(z)) === side) mine.push({ x, z });
    }
    mine.sort((a, b) => a.z - b.z);
    line.push(...mine);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5);
      for (let k = 0; k <= n; k++) block.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n, r: 0.7 });
    }
  }
  // the wayside's stones: their footprints as rectangles, kept 1 m clear
  const stones = waysideSites(world);
  const inStone = (x, z) => stones.some((s) => {
    const dx = x - s.x, dz = z - s.z, c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    return Math.abs(dx * c - dz * sn) < s.hw + 1.0 && Math.abs(dx * sn + dz * c) < s.hd + 1.0;
  });
  // the bridge's deck and its landings (walk.js: 3 m past each end, 3 m either side of the deck's middle)
  const onBridge = (x, z) => {
    const dx = x - B.center.x, dz = z - B.center.z;
    const u = dx * across.x + dz * across.z, s = dx * along.x + dz * along.z;
    return Math.abs(u) < B.half + 3.6 && Math.abs(s) < 3.6;
  };
  // (bank: in the river's half-widths from its middle; the lamps' lines and bonbori stand within 1.75 of it)
  const ground = (x, z, bank) => world.laneDist(x, z) >= CLEAR_LANE && !world.zoneAt(x, z) && !world.padAt(x, z) && !onBridge(x, z) &&
    world.riverInfo(x, z).t > bank && !inStone(x, z) && block.every((b) => Math.hypot(x - b.x, z - b.z) > b.r);
  const out = [];
  // a banner near (x0, z0), its arm towards (ax, az), its front towards (fx, fz)
  const place = (x0, z0, ax, az, fx, fz, text, red, bank = 1.75) => {
    const al = Math.hypot(ax, az);
    ax /= al; az /= al;
    let best = null;
    for (let gx = -SEARCH; gx <= SEARCH + 1e-6; gx += 0.25) for (let gz = -SEARCH; gz <= SEARCH + 1e-6; gz += 0.25) {
      const x = x0 + gx, z = z0 + gz, d = Math.hypot(gx, gz);
      if (d > SEARCH || (best && d >= best.d)) continue;
      // the pole, the cloth's middle and its free edge on clear ground, and clear of the banners placed before
      let ok = true;
      for (const t of [0, 0.5, 1]) if (!ground(x + ax * ARM_OUT * t, z + az * ARM_OUT * t, bank)) { ok = false; break; }
      if (!ok || out.some((o) => Math.hypot(o.x - x, o.z - z) < 3)) continue;
      const h = [0, 1].map((t) => world.height(x + ax * ARM_OUT * t, z + az * ARM_OUT * t));
      if (Math.abs(h[1] - h[0]) > 0.6) continue;
      best = { x, z, d };
    }
    if (!best) { console.warn('banners: no room near', x0.toFixed(1), z0.toFixed(1)); return; }
    // the cloth's normal (its front side): perpendicular to the arm, turned towards (fx, fz)
    const flip = Math.sign(az * fx - ax * fz) || 1;
    out.push({ x: best.x, z: best.z, y: world.height(best.x, best.z), yaw: Math.atan2(ax, az), flip, text, red });
  };

  // the torii: either side of its pillars, a little behind them, the arms out along its beams, facing the bridge
  for (const t of TORII) {
    const c = Math.cos(t.yaw), s = Math.sin(t.yaw);
    const fx = s, fz = c; // its front, +z in its own frame
    for (const sd of [-1, 1]) {
      const lx = sd * 2.9, lz = -3.2; // (behind it, on the approach: the bridge's landing's pair is in front)
      place(t.x + lx * c + lz * s, t.z - lx * s + lz * c, sd * c, -sd * s, fx, fz, sd < 0 ? 0 : 3, true);
    }
  }
  // the approach: beside the stone lanterns at three of their pairs, outside them; facing down the lane
  const path = world.LANES[1];
  let len = 0;
  const segs = [];
  for (let i = 1; i < path.length; i++) {
    const [ax, az] = path[i - 1], [bx, bz] = path[i], l = Math.hypot(bx - ax, bz - az);
    segs.push({ ax, az, dx: (bx - ax) / l, dz: (bz - az) / l, s0: len, l });
    len += l;
  }
  [24.5, 45.5, 66.5].forEach((sAt, k) => {
    const g = segs.find((q) => sAt <= q.s0 + q.l), t = sAt - g.s0;
    const x = g.ax + g.dx * t, z = g.az + g.dz * t;
    for (const side of [-1, 1]) {
      const nx = -g.dz * side, nz = g.dx * side; // out from the lane
      place(x + nx * 3.0, z + nz * 3.0, nx, nz, -g.dx, -g.dz, (k * 2 + (side > 0) + 1) % 4, false);
    }
  });
  // the bridge's landings: either side of each, the arms away from the deck's line, facing the bridge (out on the bank
  // between the lamps, which stop short of the landings; on the west bank upstream, beyond the valley lane's mouth, the
  // signpost and the Jizō's shelter standing where the landing's flank would be)
  for (const end of [-1, 1]) {
    for (const side of [-1, 1]) {
      const [du, s] = end < 0 && side < 0 ? [0.8, -7.2] : [2.2, side * 4.6], u = end * (B.half + du);
      place(B.center.x + across.x * u + along.x * s, B.center.z + across.z * u + along.z * s, along.x * side, along.z * side,
        -across.x * end, -across.z * end, side < 0 ? 2 : 1, end > 0, 1.5);
    }
  }
  // per banner: aBase (x, arm's y, z, arm's yaw), aLook (vermilion, text, seed, which side is the front)
  const base = new Float32Array(out.length * 4), look = new Float32Array(out.length * 4);
  out.forEach((b, i) => {
    base.set([b.x, b.y + BANNER.ARM, b.z, b.yaw], i * 4);
    look.set([b.red ? 1 : 0, b.text, rng() * 100, b.flip], i * 4);
  });
  return { base, look, n: out.length, poles: poleGeometry(out, rng), sites: out.map((b) => ({ x: b.x, z: b.z })) };
}

// the poles, merged: a stone weight at the foot, a bamboo pole with its nodes, a brass finial, the cross-arm lashed on
// at the top, and the cloth's loops round the pole and the arm (their colour the cloth's)
function poleGeometry(sites, rng) {
  const parts = [];
  const add = (g, c) => {
    g.deleteAttribute('uv');
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  const { W, H, ARM, POLE, GAP, DROP } = BANNER;
  for (const b of sites) {
    const m = new THREE.Matrix4().makeRotationY(b.yaw).setPosition(b.x, b.y, b.z);
    const shade = 0.9 + rng() * 0.2, bam = BAMBOO.map((v) => v * shade);
    const put = (g, c) => add(g.applyMatrix4(m), c);
    // the weight: a rough granite block, sunk a little
    put(new THREE.BoxGeometry(0.3, 0.26, 0.3).rotateY(rng() * 0.6).translate(0, 0.03, 0), STONE.map((v) => v * (0.85 + rng() * 0.3)));
    // the pole, tapering, sunk 0.15 m; its nodes every ~0.4 m
    put(new THREE.CylinderGeometry(0.021, 0.03, POLE + 0.15, 7, 1).translate(0, (POLE - 0.15) / 2, 0), bam);
    for (let y = 0.35 + rng() * 0.1; y < POLE - 0.1; y += 0.36 + rng() * 0.08) {
      const r = 0.03 - 0.009 * (y / POLE) + 0.003;
      put(new THREE.CylinderGeometry(r, r, 0.022, 7, 1, true).translate(0, y, 0), NODE);
    }
    // the finial: a brass knob and point
    put(new THREE.SphereGeometry(0.032, 7, 4).translate(0, POLE + 0.02, 0), BRASS);
    put(new THREE.ConeGeometry(0.018, 0.11, 7).translate(0, POLE + 0.1, 0), BRASS);
    // the cross-arm (+z in the banner's frame), lashed to the pole
    put(new THREE.CylinderGeometry(0.011, 0.013, ARM_OUT + 0.04, 6, 1).rotateX(Math.PI / 2).translate(0, ARM, (ARM_OUT + 0.04) / 2 - 0.02), bam);
    put(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 7, 1, true).translate(0, ARM, 0), NODE);
    // the loops: round the pole down the tied edge, round the arm along the top
    const loop = b.red ? RED : WHITE; // (the top ones, and those along the arm, on the band)
    for (let k = 0; k < 7; k++) {
      const y = ARM - DROP - 0.08 - k * (H - 0.2) / 6;
      put(new THREE.CylinderGeometry(0.05, 0.05, 0.035, 6, 1, true).translate(0, y, 0.022), y > ARM - DROP - 0.4 ? RED : loop);
    }
    for (let k = 0; k < 4; k++) {
      const z = GAP + 0.06 + k * (W - 0.12) / 3;
      put(new THREE.CylinderGeometry(0.03, 0.03, 0.03, 6, 1, true).rotateX(Math.PI / 2).translate(0, ARM - DROP * 0.5, z), RED);
    }
  }
  return mergeGeometries(parts);
}

// the ink atlas: the writing (white on black, in R) one cell per BANNER_TEXTS entry, side by side; heavy brush
// strokes in the system's Japanese fonts as the lanterns' (lanterns.js), none where it has none (the cloth then shows
// its band alone)
export function paintBannerInk() {
  const n = BANNER_TEXTS.length, W = BANNER_INK.w * n, H = BANNER_INK.h;
  const c = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true });
  if (hasJapaneseFont()) {
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff'; c.strokeStyle = '#fff'; c.lineJoin = 'round';
    BANNER_TEXTS.forEach((t, i) => {
      const chars = [...t], x = (i + 0.5) * BANNER_INK.w;
      const s = Math.min(BANNER_INK.w * 0.8, (H / chars.length) * 0.94);
      // spread over the cloth's length: few characters stand further apart
      const step = Math.min(s * 1.5, H / chars.length), y0 = (H - step * chars.length) / 2;
      c.font = `900 ${s}px ${FONT}`;
      c.lineWidth = s * 0.06;
      chars.forEach((ch, k) => { c.fillText(ch, x, y0 + step * (k + 0.5)); c.strokeText(ch, x, y0 + step * (k + 0.5)); });
    });
  }
  const a = c.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = a[i + 3]; out[i + 3] = 255; }
  return { data: out, w: W, h: H };
}
