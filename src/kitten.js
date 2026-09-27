// Kitten model: the skinned body (kitten-body.js), its fur and eyes, and the coats. The coat is painted in the
// shader from the rest-pose position (positionGeometry), so it follows the body however it bends. Fur is shell
// texturing: the body drawn again a few times, each layer pushed out along the normal and cut down to strands
// (one instanced draw); only near the camera, where it can be seen.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, mix, max, pow, dot, abs, sin, fract, floor, length, normalize, clamp, uniform, attribute,
  positionGeometry, positionLocal, normalLocal, positionWorld, cameraPosition, normalView, cameraViewMatrix, instanceIndex, mx_noise_float, diffuseColor,
} from 'three/tsl';
import { U, sstep, LitMaterial, lanternLight } from './tsl.js';
import { BONES, EYE } from './kitten-body.js';

const FUR_LEN = 0.0055;

const hash3 = (p) => fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
const hash3b = (p) => fract(sin(dot(p, vec3(269.5, 183.3, 246.1))).mul(43758.5453));

// ---------- coats (linear colours) ----------
const WHITE = vec3(0.8, 0.77, 0.72), CREAM = vec3(0.78, 0.56, 0.34);
const ORANGE = vec3(0.66, 0.29, 0.085), DARK_ORANGE = vec3(0.34, 0.11, 0.03), BLACK = vec3(0.028, 0.024, 0.022);
const PINK = vec3(0.72, 0.36, 0.36), EAR_PINK = vec3(0.7, 0.42, 0.4);

// regions of the rest pose
const regions = (p) => {
  const head = sstep(0.1, 0.12, p.z).mul(sstep(0.155, 0.17, p.y));
  const tail = sstep(-0.1, -0.115, p.z).mul(sstep(0.1, 0.11, p.y));
  const legs = sstep(0.078, 0.055, p.y).mul(float(1).sub(tail));
  const belly = sstep(0.097, 0.078, p.y).mul(sstep(0.1, 0.08, p.z));
  // chest bib and throat, muzzle and chin
  const bib = sstep(0.05, 0.08, p.z).mul(sstep(0.175, 0.155, p.y)).mul(sstep(0.028, 0.012, abs(p.x)).mul(0.6).add(sstep(0.145, 0.12, p.y)).clamp(0, 1));
  const muzzle = head.mul(sstep(0.16, 0.17, p.z)).mul(sstep(0.198, 0.19, p.y));
  return { head, tail, legs, belly, bib, muzzle };
};

export const COATS = {
  // mi-ke: white with patches of orange and black
  calico: (p, seed) => {
    const r = regions(p);
    const n = mx_noise_float(p.mul(21).add(seed)).add(mx_noise_float(p.mul(55).add(seed.add(3))).mul(0.3));
    const m = mx_noise_float(p.mul(14).add(seed.add(7)));
    const patch = sstep(-0.1, 0.05, n);
    const col = mix(ORANGE.mul(vec3(1.0, 1.05, 1.1)), BLACK, sstep(-0.05, 0.08, m));
    const white = max(max(r.belly, r.bib), max(r.muzzle, sstep(0.05, 0.035, p.y))).max(sstep(0.0045, 0.0025, abs(p.x.add(mx_noise_float(p.mul(60).add(seed)).mul(0.003)))).mul(r.head).mul(sstep(0.19, 0.21, p.y)).mul(sstep(0.16, 0.17, p.z)));
    return mix(WHITE, col, patch.mul(float(1).sub(white)));
  },
  // cha-tora: ginger tabby with a cream belly, white bib and socks
  ginger: (p, seed) => {
    const r = regions(p);
    const n = mx_noise_float(p.mul(40).add(seed));
    const body = float(1).sub(r.head).mul(float(1).sub(r.tail)).mul(float(1).sub(r.legs));
    // bands around the body (strongest on the back), rings on the legs and tail, lines on the face
    const bands = sin(p.z.mul(125).add(n.mul(2.4)).add(abs(p.x).mul(20))).mul(sstep(0.09, 0.15, p.y)).mul(body);
    const rings = sin(p.y.mul(150).add(n)).mul(r.legs).mul(0.8).add(sin(p.z.mul(105).add(n)).mul(r.tail));
    const forehead = sin(abs(p.x).mul(330).add(n)).mul(r.head).mul(sstep(0.212, 0.226, p.y)).mul(sstep(0.024, 0.01, abs(p.x)));
    const cheeks = sin(p.y.mul(300).add(abs(p.x).mul(80)).add(n)).mul(r.head).mul(sstep(0.026, 0.036, abs(p.x))).mul(sstep(0.2, 0.186, p.y));
    const stripe = sstep(0.3, 0.75, bands.add(rings).add(forehead).add(cheeks));
    let col = mix(ORANGE, DARK_ORANGE, stripe.mul(0.85));
    col = mix(col, CREAM, max(r.belly, r.muzzle.mul(0.7)).mul(0.85));
    const white = max(max(r.bib, sstep(0.035, 0.022, p.y)), r.muzzle.mul(sstep(0.19, 0.184, p.y)));
    return mix(col, WHITE, white);
  },
};

// nose leather and inner ears over any coat
function coatWithDetails(coat, seed) {
  return Fn(() => {
    const p = positionGeometry, mark = attribute('aMark', 'vec2');
    const col = coat(p, seed).toVar();
    const front = sstep(0.168, 0.174, p.z);
    const nose = sstep(0.0056, 0.0044, length(p.sub(vec3(0, 0.1962, 0.182)).mul(vec3(1.0, 1.35, 0.9))).add(p.y.sub(0.1962).mul(-0.35)));
    // mouth: a line down from the nose that splits into two curves
    const ax = abs(p.x);
    const mouthY = float(0.1898).sub(sin(ax.div(0.0075).clamp(0, 1).mul(Math.PI)).mul(0.0014));
    const mouth = sstep(0.0008, 0.0003, abs(p.y.sub(mouthY))).mul(sstep(0.0085, 0.0065, ax))
      .max(sstep(0.0007, 0.0003, ax).mul(sstep(0.1888, 0.1894, p.y)).mul(sstep(0.1945, 0.1935, p.y))).mul(front);
    col.assign(mix(col, PINK, nose));
    col.assign(mix(col, vec3(0.05, 0.03, 0.03), mouth.mul(0.85)));
    col.assign(mix(col, EAR_PINK, mark.x));
    return col;
  })();
}

// sheen of fur against the light, soft lift in the shade, the lanterns' glow
const furLight = (out, rimK) => Fn(() => {
  const vdir = normalize(positionWorld.sub(cameraPosition));
  const nv = abs(dot(normalView, normalize(cameraViewMatrix.mul(vec4(vdir.negate(), 0)).xyz)));
  const rim = pow(float(1).sub(nv), 2.5);
  const back = pow(max(dot(vdir, U.uSunDir), 0), 2.0);
  const c = diffuseColor.rgb;
  return out
    .add(c.mul(U.uSunColor).mul(U.uSunVis).mul(rim).mul(back.mul(1.6).add(0.12)).mul(rimK))
    .add(c.mul(U.uSkyAmb).mul(rim.mul(0.35).add(0.12)))
    .add(c.mul(lanternLight(positionWorld)));
})();

export function makeKittenModel(data, { coat = 'calico', seed = 1, eyeColor = [0.45, 0.42, 0.08], alphaToCoverage = false, shells = 10 } = {}) {
  // skeleton: bones outside the scene graph, their world matrices written by the rig
  const bones = BONES.map((b) => {
    const o = new THREE.Bone();
    o.matrixAutoUpdate = false; o.matrixWorldAutoUpdate = false;
    o.matrixWorld.makeTranslation(...b.p);
    return o;
  });
  const skeleton = new THREE.Skeleton(bones);
  const id = new THREE.Matrix4();
  const attr = {
    position: new THREE.BufferAttribute(data.body.position, 3), normal: new THREE.BufferAttribute(data.body.normal, 3),
    skinIndex: new THREE.Uint16BufferAttribute(data.body.skinIndex, 4), skinWeight: new THREE.BufferAttribute(data.body.skinWeight, 4),
    aMark: new THREE.BufferAttribute(data.body.mark, 2),
  };
  const index = new THREE.BufferAttribute(data.body.index, 1);
  const seedU = float(seed * 17.3);
  const coatNode = coatWithDetails(COATS[coat], seedU);

  // body: the coat under the fur, a little darker (the fur's own shade)
  const bodyGeo = new THREE.BufferGeometry();
  for (const k in attr) bodyGeo.setAttribute(k, attr[k]);
  bodyGeo.setIndex(index);
  const bodyMat = new LitMaterial({ roughness: 0.88, metalness: 0, colorNode: coatNode.mul(0.86) }, (out) => furLight(out, 1));
  const body = new THREE.SkinnedMesh(bodyGeo, bodyMat);
  body.bind(skeleton, id);
  body.castShadow = true; body.receiveShadow = true;
  body.frustumCulled = false;

  // fur shells: one instance per layer
  const furGeo = new THREE.InstancedBufferGeometry();
  for (const k in attr) furGeo.setAttribute(k, attr[k]);
  furGeo.setIndex(index);
  furGeo.instanceCount = shells;
  const uShells = uniform(shells);
  const h = float(instanceIndex).add(1).div(uShells); // 0 at the skin .. 1 at the tips
  const mark = attribute('aMark', 'vec2');
  const p0 = positionGeometry;
  const face = sstep(0.155, 0.175, p0.z).mul(sstep(0.16, 0.18, p0.y)); // short fur on the face, longer on the chest
  const aroundEyes = sstep(0.019, 0.013, length(vec3(abs(p0.x).sub(EYE.x), p0.y.sub(EYE.y), p0.z.sub(EYE.z))));
  const len = float(FUR_LEN).mul(mark.y).mul(float(1).sub(face.mul(0.55)).mul(float(1).sub(aroundEyes.mul(0.85)))).mul(float(1).add(sstep(0.06, 0.09, p0.z).mul(sstep(0.16, 0.11, p0.y)).mul(0.35)));
  const furMat = new LitMaterial({ roughness: 0.9, metalness: 0, alphaTest: 0.5, alphaToCoverage }, (out) => furLight(out, 1.3));
  furMat.positionNode = positionLocal.add(normalLocal.normalize().mul(h.mul(len))).sub(vec3(0, h.mul(h).mul(len).mul(0.35), 0));
  furMat.colorNode = Fn(() => {
    // strands: cells of ~1.1 mm on the rest surface (the same point on every layer), each with its own length
    const q = p0.mul(900);
    const cell = floor(q), rnd = hash3(cell), rnd2 = hash3b(cell);
    const f = fract(q).sub(0.5).sub(vec3(rnd, rnd2, rnd.mul(rnd2)).sub(0.5).mul(0.5));
    const strandLen = rnd.mul(0.45).add(0.55);
    const r = length(f);
    const width = float(0.62).mul(float(1).sub(h.div(strandLen))).add(0.04);
    const a = sstep(width.add(0.08), width.sub(0.08), r).mul(sstep(strandLen, strandLen.sub(0.05), h));
    const c = coatNode.mul(mix(0.66, 1.08, h)).mul(rnd2.mul(0.16).add(0.92));
    return vec4(c, a);
  })();
  const fur = new THREE.SkinnedMesh(furGeo, furMat);
  fur.bind(skeleton, id);
  fur.receiveShadow = true;
  fur.frustumCulled = false;
  fur.layers.set(1);

  // eyes: a big iris, a pupil from slit (bright) to round (dark or excited), glossy
  const uPupil = uniform(0.4);
  const eyeGeo = new THREE.BufferGeometry();
  eyeGeo.setAttribute('position', new THREE.BufferAttribute(data.eyes.position, 3));
  eyeGeo.setAttribute('normal', new THREE.BufferAttribute(data.eyes.normal, 3));
  eyeGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(data.eyes.skinIndex, 4));
  eyeGeo.setAttribute('skinWeight', new THREE.BufferAttribute(data.eyes.skinWeight, 4));
  eyeGeo.setAttribute('aEye', new THREE.BufferAttribute(data.eyes.eye, 3));
  eyeGeo.setIndex(new THREE.BufferAttribute(data.eyes.index, 1));
  const iris = vec3(...eyeColor);
  const eyeMat = new LitMaterial({ roughness: 0.08, metalness: 0 }, (out) => Fn(() => {
    const vdir = normalize(positionWorld.sub(cameraPosition));
    const nv = abs(dot(normalView, normalize(cameraViewMatrix.mul(vec4(vdir.negate(), 0)).xyz)));
    return out.add(U.uSkyAmb.mul(pow(float(1).sub(nv), 3)).mul(0.3)).add(diffuseColor.rgb.mul(lanternLight(positionWorld)));
  })());
  eyeMat.colorNode = Fn(() => {
    const e = attribute('aEye', 'vec3');
    const rr = length(e.xy);
    const pw = mix(0.1, 0.62, uPupil), ph = mix(0.66, 0.62, uPupil);
    const pupil = sstep(1.08, 0.92, length(e.xy.div(vec2(pw, ph))));
    const streak = mx_noise_float(vec3(e.x.div(rr.add(0.01)).mul(6), e.y.div(rr.add(0.01)).mul(6), rr.mul(9))).mul(0.18).add(1);
    const irisCol = mix(iris.mul(1.25), iris.mul(0.55), sstep(0.25, 0.88, rr)).mul(streak);
    const ring = sstep(0.8, 0.9, rr); // dark limbal ring, then the lid's rim
    const col = mix(irisCol, vec3(0.02, 0.018, 0.015), max(pupil, ring)).mul(sstep(-0.2, 0.1, e.z).mul(0.9).add(0.1));
    return col;
  })();
  const eyes = new THREE.SkinnedMesh(eyeGeo, eyeMat);
  eyes.bind(skeleton, id);
  eyes.frustumCulled = false;
  eyes.layers.set(1);

  // whiskers
  const wGeo = new THREE.BufferGeometry();
  for (const k of ['position', 'normal']) wGeo.setAttribute(k, new THREE.BufferAttribute(data.whiskers[k], 3));
  wGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(data.whiskers.skinIndex, 4));
  wGeo.setAttribute('skinWeight', new THREE.BufferAttribute(data.whiskers.skinWeight, 4));
  wGeo.setIndex(new THREE.BufferAttribute(data.whiskers.index, 1));
  const whiskers = new THREE.SkinnedMesh(wGeo, new LitMaterial({ color: new THREE.Color(0.9, 0.88, 0.84), roughness: 0.45, side: THREE.DoubleSide }));
  whiskers.bind(skeleton, id);
  whiskers.frustumCulled = false;
  whiskers.layers.set(1);

  const group = new THREE.Group();
  group.add(body, fur, eyes, whiskers);
  const maxShells = shells;
  return {
    group, bones, body, fur, eyes, uPupil,
    // fur layers by distance to the camera (none beyond ~9 m, where a kitten is a few dozen pixels)
    setDistance(d) {
      const n = Math.round(maxShells * Math.min(1, Math.max(0, (9 - d) / 5)));
      fur.visible = n > 0;
      whiskers.visible = d < 6;
      furGeo.instanceCount = Math.max(1, n);
      uShells.value = Math.max(1, n);
    },
  };
}
