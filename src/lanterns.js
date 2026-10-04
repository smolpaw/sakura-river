// The riverside's lamps after dusk. Round the cherries, from the bridge down past the cherry tree, yozakura lanterns:
// rows of paper chōchin, red and white, hung from a sagging rope between weathered posts along both banks. Along the
// rest of both banks, from the gorge and the waterwheel's mill above the bridge down to where the river bends away,
// bonbori: paper lamps on wooden posts, every few strides. And by the cherry tree, two fire baskets (kagaribi).
// The posts, bonbori and fire baskets are Blender models (tools/lamps.py; drawn by lods.js); the ropes are built here.
// Generation only (runs in a worker); fx.js draws the lanterns and the flames, and the light map (lights.js) and
// tsl.js lanternLight light what is near them.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';

const V = THREE.Vector3;

export const LAMP_KINDS = ['post', 'bonbori', 'kagaribi'];

// the lantern lines follow the banks just past the boulders: x = riverX(z) +- (riverHW(z) * K + PAD), each from one of
// the bridge's downstream corner posts (side -1 west, 1 east) to z `to`
export const LINE = { K: 1.38, PAD: 0.4, lines: [{ side: -1, to: 38 }, { side: 1, to: 38 }] };
export const bankX = (world, z, side) => world.riverX(z) + side * (world.riverHW(z) * LINE.K + LINE.PAD);
// the bonbori: `out` metres further from the water than the lines, about `every` metres apart along the bank, over
// stretches of z on each side
const BONBORI = {
  every: 10, out: 0.6, lightY: 1.76,
  runs: [{ side: -1, from: 46, to: 150 }, { side: 1, from: 46, to: 150 }, { side: -1, from: -67, to: -100 }, { side: 1, from: -67, to: -114 }],
};
// the fire baskets, from the cherry tree's trunk: on the meadow side, out from under its crown (which hangs to 1-3 m
// above the ground for ~7 m round the trunk), and the flames' foot above the ground (tools/lamps.py)
const FIRES = { at: [[-10, -8], [-12.5, -3]], flameY: 1.55 };

const SPAN = 6.4; // post spacing (m)
const ROPE = 2.55; // the rope's height on the post above ground (tools/lamps.py)
const SAG = 0.32;
const PER_SPAN = 3; // lanterns between two posts
const ROPE_C = [0.42, 0.35, 0.22];

function paint(g, fn) {
  g.deleteAttribute('uv');
  const p = g.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) c.set(fn(p.getX(i), p.getY(i), p.getZ(i)), i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

// blockers: [{x, z, r}] what stands clear of (boulders, tree trunks); anchors: {-1, 1} where each line starts, tied to
// the bridge's downstream corner post (props.js bridgeRopeAnchors); tree: the cherry tree's trunk {x, z}
export function lanternData(world, blockers, anchors, tree) {
  const rng = mulberry32(31);
  const ropes = [], hang = [], look = [];
  const lists = LAMP_KINDS.map(() => ({ m: [], c: [] }));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new V(1, 1, 1), up = new V(0, 1, 0);
  const put = (k, p, quat) => {
    lists[k].m.push(...m4.compose(p, quat, one).elements);
    const t = 0.88 + rng() * 0.22;
    lists[k].c.push(t, t * (0.97 + rng() * 0.05), t * (0.95 + rng() * 0.06));
  };
  // stands clear of rocks and trees, off the farmland and the buildings' pads
  const ok = (x, z) => blockers.every((b) => Math.hypot(x - b.x, z - b.z) > b.r + 0.3) && !world.zoneAt(x, z) && !world.padAt(x, z);
  for (const { side, to } of LINE.lines) {
    // from the bridge, posts about SPAN apart along the bank, nudged along it off what is in the way; the line ends
    // where nothing clears
    const a = anchors[side];
    const posts = [new V(a.x, a.y, a.z)];
    const next = (x0, z0) => { let z = z0 + 1; while (Math.hypot(bankX(world, z, side) - x0, z - z0) < SPAN) z += 0.1; return z; };
    let z = next(a.x, a.z);
    while (z <= to) {
      let zz = z, t = 0;
      for (; t < 12 && !ok(bankX(world, zz, side), zz); t++) zz += 0.3;
      if (t === 12) break;
      const x = bankX(world, zz, side), base = new V(x, world.height(x, zz) - 0.05, zz);
      const lean = new V((rng() - 0.5) * 0.05, 1, (rng() - 0.5) * 0.05).normalize();
      q.setFromUnitVectors(up, lean).multiply(new THREE.Quaternion().setFromAxisAngle(up, rng() * Math.PI * 2));
      put(0, base, q);
      posts.push(base.clone().addScaledVector(lean, ROPE));
      z = next(x, zz) + (rng() - 0.5) * 0.8;
    }
    // rope spans with lanterns, red and white by turns
    for (let i = 0; i + 1 < posts.length; i++) {
      const a = posts[i], b = posts[i + 1];
      const at = (u) => a.clone().lerp(b, u).add(new V(0, -SAG * 4 * u * (1 - u), 0));
      const pts = [];
      for (let k = 0; k <= 10; k++) pts.push(at(k / 10));
      ropes.push(paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.018, 5, false), () => ROPE_C));
      const face = Math.atan2(a.z - b.z, b.x - a.x); // writing across the rope, to both banks
      for (let k = 0; k < PER_SPAN; k++) {
        const p = at((k + 1) / (PER_SPAN + 1));
        hang.push(p.x, p.y, p.z);
        // phase, what it says (LANTERN_TEXTS; + 8 on red paper), brightness, yaw
        const red = (i + k) % 2 === 0;
        look.push(rng() * 6.28, Math.floor(rng() * LANTERN_TEXTS.length) + (red ? 8 : 0), 0.85 + rng() * 0.3, face + (rng() - 0.5) * 0.5);
      }
    }
  }
  // the bonbori, set back a little from the water, nudged off what is in the way (none where nothing clears)
  const lamps = [];
  for (const { side, from, to } of BONBORI.runs) {
    const dir = Math.sign(to - from), x0 = (z) => bankX(world, z, side) + side * BONBORI.out;
    for (let z = from; (to - z) * dir >= 0;) {
      let zz = z, t = 0;
      for (; t < 10 && !ok(x0(zz), zz); t++) zz += 0.4 * dir;
      if (t < 10) {
        const x = x0(zz), g = world.height(x, zz);
        put(1, new V(x, g - 0.05, zz), q.setFromAxisAngle(up, rng() * Math.PI));
        lamps.push(x, g - 0.05 + BONBORI.lightY, zz);
      }
      // about `every` metres along the bank
      let z2 = zz + dir;
      while (Math.hypot(x0(z2) - x0(zz), z2 - zz) < BONBORI.every) z2 += 0.1 * dir;
      z = z2;
    }
  }
  const fires = [];
  for (const [dx, dz] of FIRES.at) {
    const x = tree.x + dx, z = tree.z + dz, g = world.height(x, z);
    put(2, new V(x, g - 0.05, z), q.setFromAxisAngle(up, rng() * Math.PI));
    fires.push(x, g - 0.05 + FIRES.flameY, z);
  }
  return {
    ropes: mergeGeometries(ropes), hang: new Float32Array(hang), look: new Float32Array(look), n: hang.length / 3,
    lists: lists.map((l) => ({ matrix: new Float32Array(l.m), color: new Float32Array(l.c), n: l.c.length / 3 })),
    bonbori: new Float32Array(lamps), fires: new Float32Array(fires),
  };
}

// What the lanterns say, written down the paper on the front and back as on votive lanterns: a small red line on top
// (奉納 "dedicated", 献燈 "lantern offered", a neighbourhood association) over the donor's name or the words in black
// brush; or just the red sakura crest (null). The writing is painted into an ink atlas at start-up (paintLanternInk)
// with the system's Japanese fonts, Mincho first; with none, every lantern carries the crest.
export const LANTERN_TEXTS = [null, ['奉納', '御神燈'], ['献燈', '桜井酒造'], ['', '夜桜'], ['奉納', '山本商店'], ['', 'さくら祭'], ['奉納', '千本桜'], ['町内会', '祭']];
export const INK = { cols: 4, rows: 2, w: 128, h: 256, span: 0.26, v0: 0.1, v1: 0.9 }; // a cell: `span` m across, paper v0..v1
export const FONT = '"Yu Mincho", YuMincho, "Hiragino Mincho ProN", "Noto Serif CJK JP", "Noto Serif JP", "MS Mincho", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif';

// whether the system has a font with the kanji: two different ones drawn the same means none has them (missing-glyph
// boxes)
export function hasJapaneseFont() {
  const probe = new OffscreenCanvas(40, 40).getContext('2d', { willReadFrequently: true });
  const px = (ch) => { probe.clearRect(0, 0, 40, 40); probe.font = `32px ${FONT}`; probe.fillText(ch, 2, 34); return probe.getImageData(0, 0, 40, 40).data.join(); };
  return px('桜') !== px('祭');
}

// the ink atlas: black ink in R, red in G, one cell per LANTERN_TEXTS entry (rows top-down, as the shader reads them)
export function paintLanternInk() {
  const W = INK.cols * INK.w, H = INK.rows * INK.h;
  const ctx = (c) => c.getContext('2d', { willReadFrequently: true });
  const black = ctx(new OffscreenCanvas(W, H)), red = ctx(new OffscreenCanvas(W, H));
  const jp = hasJapaneseFont();
  for (const c of [black, red]) { c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff'; }
  LANTERN_TEXTS.forEach((t, i) => {
    const x = (i % INK.cols + 0.5) * INK.w, y0 = Math.floor(i / INK.cols) * INK.h;
    if (!t || !jp) {
      // the crest: five notched petals round a pale centre
      red.beginPath();
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 - Math.PI / 2, r = INK.w * 0.3, c = Math.cos(a), sn = Math.sin(a), q = (d, s) => [x + (c * d - sn * s) * r, y0 + INK.h / 2 + (sn * d + c * s) * r];
        red.moveTo(...q(0.12, 0));
        red.bezierCurveTo(...q(0.3, -0.45), ...q(0.95, -0.5), ...q(1, -0.14));
        red.lineTo(...q(0.84, 0)); red.lineTo(...q(1, 0.14));
        red.bezierCurveTo(...q(0.95, 0.5), ...q(0.3, 0.45), ...q(0.12, 0));
      }
      red.fill();
      red.globalCompositeOperation = 'destination-out';
      red.beginPath(); red.arc(x, y0 + INK.h / 2, INK.w * 0.06, 0, Math.PI * 2); red.fill();
      red.globalCompositeOperation = 'source-over';
      return;
    }
    const [top, main] = t, chars = [...main];
    let y = y0 + 16;
    if (top) {
      const s = Math.min(28, (INK.w - 30) / top.length);
      red.font = `900 ${s}px ${FONT}`;
      red.lineWidth = s * 0.08; red.strokeStyle = '#fff';
      red.fillText(top, x, y + s / 2); red.strokeText(top, x, y + s / 2);
      y += s + 14;
    }
    const s = Math.min(INK.w * 0.74, ((y0 + INK.h - 12 - y) / chars.length) * 0.96), step = s * 1.02;
    // heavy strokes, thickened a little more, as a broad brush writes them
    black.font = `900 ${s}px ${FONT}`;
    black.lineWidth = s * 0.07; black.strokeStyle = '#fff'; black.lineJoin = 'round';
    const yc = y + (y0 + INK.h - 12 - y - step * chars.length) / 2;
    chars.forEach((ch, k) => { black.fillText(ch, x, yc + step * (k + 0.5)); black.strokeText(ch, x, yc + step * (k + 0.5)); });
  });
  const b = black.getImageData(0, 0, W, H).data, r = red.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = b[i + 3]; out[i + 1] = r[i + 3]; out[i + 3] = 255; }
  return { data: out, w: W, h: H };
}

// one chōchin, hung from the origin: cord, black lacquered rims, a ribbed paper body 0.44 m tall.
// aPart: 0 paper, 1 rim, 2 cord; aV: 0 top .. 1 bottom of the paper
export function lanternGeometry() {
  const tag = (g, part, v = null) => {
    g.deleteAttribute('uv');
    const p = g.attributes.position, a = new Float32Array(p.count), b = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) { a[i] = part; b[i] = v ? v(p.getY(i)) : 0; }
    g.setAttribute('aPart', new THREE.BufferAttribute(a, 1));
    g.setAttribute('aV', new THREE.BufferAttribute(b, 1));
    return g.index ? g.toNonIndexed() : g;
  };
  const top = -0.14, H = 0.44;
  const prof = [];
  for (let k = 0; k <= 12; k++) {
    const u = k / 12;
    prof.push(new THREE.Vector2(0.07 + 0.1 * Math.pow(Math.sin(Math.PI * u), 0.7), top - u * H));
  }
  prof.reverse(); // lathe runs bottom to top for outward normals
  const paper = new THREE.LatheGeometry(prof, 12);
  const rim = (y) => new THREE.CylinderGeometry(0.078, 0.078, 0.04, 12, 1).translate(0, y, 0);
  const cord = new THREE.CylinderGeometry(0.006, 0.006, 0.12, 4, 1).translate(0, -0.06, 0);
  return mergeGeometries([
    tag(paper, 0, (y) => (top - y) / H),
    tag(rim(top + 0.005), 1), tag(rim(top - H - 0.005), 1), tag(cord, 2),
  ]);
}
