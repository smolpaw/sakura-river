// Lit materials for the scene, as TSL node materials. Each reproduces the math of the GLSL
// onBeforeCompile patch it replaces (see git history of src/shaders.js).
import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, mix, max, pow, dot, normalize, clamp, reflect, texture, uv, attribute, varyingProperty,
  cameraPosition, cameraViewMatrix, positionWorld, normalView, normalLocal, diffuseColor, vertexColor, modelWorldMatrix, mat3,
  transformNormalToView, faceDirection,
} from 'three/tsl';
import { U, vnoise, sstep, LitMaterial, windPosition, windShadowPosition } from './tsl.js';

const wp = positionWorld;
const viewDir = () => normalize(cameraPosition.sub(wp));

export function terrainMaterial() {
  const dn = vnoise(wp.xz.mul(0.9)).mul(0.5).add(vnoise(wp.xz.mul(3.7)).mul(0.3)).add(vnoise(wp.xz.mul(0.12)).mul(0.45));
  return new LitMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, colorNode: vec3(dn.mul(0.42).add(0.7)) }, (out) => Fn(() => {
    // river-bed caustics and darkening under water: both are exactly zero / one above y = 0.03, so skip them there
    const y = wp.y;
    const o = out.toVar();
    If(y.lessThan(0.03), () => {
      const cp = wp.xz.mul(0.8), ct = U.uTime.mul(0.55);
      const c1 = vnoise(cp.add(vec2(ct, ct.mul(0.7))));
      const c2 = vnoise(cp.mul(1.37).sub(vec2(ct.mul(0.8), ct.mul(-0.5))).add(5.0));
      const cc = pow(float(1.0).sub(c1.sub(c2).abs()), 10.0);
      const cw = sstep(0.03, -0.3, y).mul(sstep(-2.6, -0.6, y));
      o.addAssign(diffuseColor.rgb.mul(U.uSunColor).mul(U.uSunVis).mul(cc).mul(cw).mul(2.2));
      o.mulAssign(mix(1.0, 0.75, sstep(0.0, -1.5, y)));
    });
    return o;
  })());
}

export function barkMaterial(map, bumpMap) {
  return new LitMaterial({
    map, bumpMap, bumpScale: 0.5, vertexColors: true, roughness: 0.78, metalness: 0, color: new THREE.Color(1.9, 1.75, 1.75),
    positionNode: windPosition(attribute('aFlex', 'float')), receivedShadowPositionNode: windShadowPosition(),
  }, (out) => Fn(() => {
    const vvB = viewDir();
    const rimB = pow(float(1.0).sub(max(dot(normalView, normalize(cameraViewMatrix.mul(vec4(vvB, 0.0)).xyz)), 0.0)), 3.0);
    const o = out.add(U.uSunColor.mul(U.uSunVis).mul(rimB).mul(pow(max(dot(vvB.negate(), U.uSunDir), 0.0), 2.0)).mul(0.35).mul(diffuseColor.rgb).mul(4.0));
    return o.add(diffuseColor.rgb.mul(U.uSkyAmb).mul(0.15));
  })());
}

export function blossomMaterial(atlas, alphaToCoverage) {
  const canopyNormal = normalize(mix(normalize(normalLocal), attribute('aCanopyN', 'vec3'), 0.72));
  return new LitMaterial({
    colorNode: texture(atlas, uv().mul(0.5).add(attribute('aAtlas', 'vec2'))),
    alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.72, metalness: 0, alphaToCoverage,
    positionNode: windPosition(attribute('aFlex', 'float'), null, canopyNormal), receivedShadowPositionNode: windShadowPosition(),
    // back faces flip like any double-sided normal (the old 'noFlip' patch never matched the unexpanded chunk)
    normalNode: transformNormalToView(canopyNormal).toVarying('vCanopyNormal').normalize().mul(faceDirection),
  }, (out) => Fn(() => {
    const vdirB = normalize(wp.sub(cameraPosition));
    const backB = pow(max(dot(vdirB, U.uSunDir), 0.0), 2.5);
    const sunB = mix(U.uSunColor, vec3(dot(U.uSunColor, vec3(0.33))), 0.45);
    const o = out.add(diffuseColor.rgb.mul(sunB).mul(U.uSunVis).mul(backB.mul(1.2).add(0.1)));
    return o.add(diffuseColor.rgb.mul(vec3(0.16).add(U.uSkyAmb.mul(0.1))));
  })());
}

// depth prepass for the blossom cards: the canopy has heavy overdraw, so its depth goes down first with only the
// atlas alpha, and the lit pass (depthWrite off) then shades just the visible fragment. Pushed back by a few depth
// units (constant, not slope-scaled: the cards cluster nearly coplanar) so the lit pass's own depth never fails
// against it if the two vertex shaders round differently; with no offset the result is pixel-identical here.
export function blossomDepthMaterial(atlas, alphaToCoverage) {
  return new THREE.MeshBasicNodeMaterial({
    colorNode: texture(atlas, uv().mul(0.5).add(attribute('aAtlas', 'vec2'))),
    alphaTest: 0.4, side: THREE.DoubleSide, alphaToCoverage, fog: false, colorWrite: false,
    polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: 4,
    positionNode: windPosition(attribute('aFlex', 'float')),
  });
}

// shadow-only stand-in for the blossom cards: r170's blossom depth material sampled the atlas with the card's
// raw 0..1 uv (the whole 2x2 atlas, not the card's cell), which shaped the baseline's canopy shadows
export function blossomShadowMaterial(atlas) {
  return new THREE.MeshBasicNodeMaterial({
    colorNode: texture(atlas, uv()), alphaTest: 0.4, side: THREE.DoubleSide, fog: false,
    positionNode: windPosition(attribute('aFlex', 'float')),
  });
}

export function grassMaterial() {
  const aFlex = attribute('aFlex', 'float');
  const vWave = varyingProperty('float', 'vWave');
  const position = windPosition(aFlex, (p) => {
    const wave = sin01(U.uTime.mul(1.9).sub(dot(p.xz, U.uWindDir).mul(0.22)).add(p.x.mul(0.05).sin().mul(1.5))).toVar();
    wave.assign(wave.mul(wave));
    p.addAssign(vec3(U.uWindDir.x, -0.35, U.uWindDir.y).mul(aFlex).mul(U.uWind).mul(wave).mul(0.55));
    vWave.assign(wave.mul(U.uWind));
  });
  return new LitMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, positionNode: position, receivedShadowPositionNode: windShadowPosition() }, (out) => Fn(() => {
    const vdir = normalize(wp.sub(cameraPosition));
    const back = pow(max(dot(vdir, U.uSunDir), 0.0), 3.0);
    const tip = aFlex; // fragment-stage attribute becomes a varying
    const o = out.add(diffuseColor.rgb.mul(U.uSunColor).mul(U.uSunVis).mul(back.mul(1.6).add(0.15)).mul(clamp(tip.mul(2.2), 0.0, 1.0)));
    return o.mul(float(1.0).add(vWave.mul(clamp(tip.mul(2.0), 0.0, 1.0)).mul(0.35)));
  })());
}
const sin01 = (x) => x.sin().mul(0.5).add(0.5);

export function flowerMaterial() {
  return new LitMaterial({ roughness: 0.7, side: THREE.DoubleSide, positionNode: windPosition(attribute('aFlex', 'float')), receivedShadowPositionNode: windShadowPosition() });
}

export function rockMaterial() {
  const wet = sstep(0.28, -0.05, wp.y);
  return new LitMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0,
    colorNode: vec3(mix(1.0, 0.5, wet).mul(vnoise(wp.xz.mul(3.0).add(wp.y.mul(2.0))).mul(0.3).add(0.85))),
  }, (out) => Fn(() => {
    // (as in the original: view-space normal against world-space vectors)
    const vv = viewDir();
    return out.add(U.uSunColor.mul(U.uSunVis).mul(pow(max(dot(reflect(U.uSunDir.negate(), normalView), vv), 0.0), 24.0)).mul(wet).mul(0.25));
  })());
}

export function forestMaterial() {
  return new LitMaterial({ color: 0xffffff, roughness: 1, side: THREE.DoubleSide, colorNode: vec3(vnoise(wp.xz.mul(0.5).add(wp.y)).mul(0.4).add(0.8)) });
}

export function propMaterial(key, extra = {}) {
  if (key === 'stone') {
    const normalW = mat3(modelWorldMatrix).mul(normalLocal).toVarying('vPropNormalW').normalize();
    const mossP = sstep(0.45, 0.9, normalW.y.add(vnoise(wp.xz.mul(6.0).add(wp.y.mul(3.0))).mul(0.35)));
    const base = vertexColor().rgb.mul(vnoise(wp.xz.mul(11.0).add(wp.y.mul(9.0))).mul(0.4).add(0.8));
    return new LitMaterial({ roughness: 0.8, metalness: 0, side: THREE.DoubleSide, ...extra, colorNode: mix(base, vec3(0.1, 0.19, 0.04), mossP.mul(0.85)) });
  }
  return new LitMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, ...extra, colorNode: vec3(vnoise(wp.xz.mul(4.0).add(wp.y.mul(6.0))).mul(0.24).add(0.88)) });
}

export function fujiMaterial() {
  return new LitMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, colorNode: vec3(vnoise(wp.xz.mul(0.05)).mul(0.2).add(0.9)) }, (out) => Fn(() => {
    // snow picks up sky light (cool) and alpenglow
    const snowAmt = sstep(0.6, 0.85, diffuseColor.b);
    const o = out.add(diffuseColor.rgb.mul(U.uSkyAmb).mul(snowAmt).mul(0.35));
    const sunV = normalize(cameraViewMatrix.mul(vec4(U.uSunDir, 0.0)).xyz);
    return o.add(diffuseColor.rgb.mul(U.uSunColor).mul(U.uSunVis).mul(snowAmt).mul(0.18).mul(pow(max(dot(normalView, sunV), 0.0), 0.6)));
  })());
}

// bench-only stress objects: default lighting with the scene fog
export function stressObjectMaterial(color, roughness, metalness) {
  return new LitMaterial({ color, roughness, metalness });
}

export function lanternCoreMaterial() {
  return new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.62, 0.3), fog: false });
}
