// Yozakura lanterns: rows of paper chōchin hung from a sagging rope between bamboo poles along both river banks.
// Generation only (runs in a worker); fx.js draws them and tsl.js lights the ground around the lines.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, lerp } from './noise.js';

const V = THREE.Vector3;

// the lines follow each bank just past the boulders: x = riverX(z) +- (riverHW(z) * K + PAD), from the bridge to z1
// (z0: where their light on the ground starts, near the bridge's corner posts)
export const LINE = { z0: -59, z1: 38, K: 1.38, PAD: 0.4, lampY: 3.2 };
export const bankX = (world, z, side) => world.riverX(z) + side * (world.riverHW(z) * LINE.K + LINE.PAD);

const SPAN = 6.4; // pole spacing (m)
const ROPE = 2.55; // rope height on the pole above ground
const SAG = 0.32;
const PER_SPAN = 3; // lanterns between two poles

const BAMBOO = [0.5, 0.42, 0.2], NODE = [0.3, 0.24, 0.1], ROPE_C = [0.28, 0.2, 0.11];

function paint(g, fn) {
  g.deleteAttribute('uv');
  const p = g.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) c.set(fn(p.getX(i), p.getY(i), p.getZ(i)), i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

// a bamboo pole of height h: slight bulges at the nodes, the top cut on a slant
function bamboo(h, r, rng) {
  const prof = [];
  let y = 0;
  prof.push(new THREE.Vector2(r * 1.05, 0));
  while (y < h - 0.3) {
    y += lerp(0.3, 0.42, rng());
    prof.push(new THREE.Vector2(r, y - 0.03), new THREE.Vector2(r * 1.14, y), new THREE.Vector2(r, y + 0.03));
  }
  prof.push(new THREE.Vector2(r, h), new THREE.Vector2(r * 0.7, h), new THREE.Vector2(0, h - 0.02));
  const g = new THREE.LatheGeometry(prof, 7);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > h - 0.05) p.setY(i, p.getY(i) + p.getX(i) * 0.9); // slant cut
  g.computeVertexNormals();
  return paint(g, (x, yy, z) => (Math.hypot(x, z) > r * 1.08 ? NODE : BAMBOO));
}

// blockers: [{x, z, r}] the poles keep clear of (boulders, tree trunks); anchors: {-1, 1} where each bank's line
// starts, tied to the bridge's corner post (props.js bridgeRopeAnchors)
export function lanternData(world, blockers, anchors) {
  const rng = mulberry32(31);
  const parts = [], hang = [], look = [];
  const clear = (x, z) => blockers.every((b) => Math.hypot(x - b.x, z - b.z) > b.r + 0.3);
  for (const side of [-1, 1]) {
    // from the bridge, poles about SPAN apart along the bank, nudged along it off rocks and trees
    const a = anchors[side];
    const poles = [new V(a.x, a.y, a.z)];
    let z = a.z + 1;
    while (Math.hypot(bankX(world, z, side) - a.x, z - a.z) < SPAN) z += 0.1;
    while (z <= LINE.z1) {
      let zz = z;
      for (let t = 0; t < 12 && !clear(bankX(world, zz, side), zz); t++) zz += 0.3;
      const x = bankX(world, zz, side), g = world.height(x, zz);
      const lean = new V((rng() - 0.5) * 0.06, 1, (rng() - 0.5) * 0.06).normalize();
      const h = ROPE + 0.35 + rng() * 0.3;
      const pole = bamboo(h + 0.3, 0.045, rng);
      pole.applyMatrix4(new THREE.Matrix4().makeRotationY(rng() * Math.PI * 2));
      pole.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new V(0, 1, 0), lean)));
      pole.translate(x, g - 0.3, zz);
      parts.push(pole);
      poles.push(new V(x, g - 0.3, zz).addScaledVector(lean, ROPE + 0.3));
      let z2 = zz + 1;
      while (Math.hypot(bankX(world, z2, side) - x, z2 - zz) < SPAN) z2 += 0.1;
      z = z2 + (rng() - 0.5) * 0.8;
    }
    // rope spans with lanterns
    for (let i = 0; i + 1 < poles.length; i++) {
      const a = poles[i], b = poles[i + 1];
      const at = (u) => a.clone().lerp(b, u).add(new V(0, -SAG * 4 * u * (1 - u), 0));
      const pts = [];
      for (let k = 0; k <= 10; k++) pts.push(at(k / 10));
      parts.push(paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.013, 5, false), () => ROPE_C));
      const n = PER_SPAN, face = Math.atan2(a.z - b.z, b.x - a.x); // writing across the rope, to both banks
      for (let k = 0; k < n; k++) {
        const p = at((k + 1) / (n + 1));
        hang.push(p.x, p.y, p.z);
        // phase, what it says (LANTERN_TEXTS), brightness, yaw
        look.push(rng() * 6.28, Math.floor(rng() * LANTERN_TEXTS.length), 0.85 + rng() * 0.3, face + (rng() - 0.5) * 0.5);
      }
    }
  }
  return { frame: mergeGeometries(parts), hang: new Float32Array(hang), look: new Float32Array(look), n: hang.length / 3 };
}

// What the lanterns say, written down the paper on the front and back as on votive lanterns: a small red line on top
// (奉納 "dedicated", 献燈 "lantern offered", a neighbourhood association) over the donor's name or the words in black
// brush; or just the red sakura crest (null). The writing is painted into an ink atlas at start-up (paintLanternInk)
// with the system's Japanese fonts, Mincho first; with none, every lantern carries the crest.
export const LANTERN_TEXTS = [null, ['奉納', '御神燈'], ['献燈', '桜井酒造'], ['', '夜桜'], ['奉納', '山本商店'], ['', 'さくら祭'], ['奉納', '千本桜'], ['町内会', '祭']];
export const INK = { cols: 4, rows: 2, w: 128, h: 256, span: 0.26, v0: 0.1, v1: 0.9 }; // a cell: `span` m across, paper v0..v1
const FONT = '"Yu Mincho", YuMincho, "Hiragino Mincho ProN", "Noto Serif CJK JP", "Noto Serif JP", "MS Mincho", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif';

// the ink atlas: black ink in R, red in G, one cell per LANTERN_TEXTS entry (rows top-down, as the shader reads them)
export function paintLanternInk() {
  const W = INK.cols * INK.w, H = INK.rows * INK.h;
  const ctx = (c) => c.getContext('2d', { willReadFrequently: true });
  const black = ctx(new OffscreenCanvas(W, H)), red = ctx(new OffscreenCanvas(W, H));
  // two different kanji drawn the same means no font has them (missing-glyph boxes)
  const probe = ctx(new OffscreenCanvas(40, 40));
  const px = (ch) => { probe.clearRect(0, 0, 40, 40); probe.font = `32px ${FONT}`; probe.fillText(ch, 2, 34); return probe.getImageData(0, 0, 40, 40).data.join(); };
  const jp = px('桜') !== px('祭');
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
