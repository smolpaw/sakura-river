// Node materials for the custom-shaded effects: petals (flying + fallen), pollen motes, lanterns
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uniform, attribute, instancedBufferAttribute, mix, max, min, pow, dot, normalize, clamp, length, sin, cos, mod, atan, abs, sign, floor, texture,
  positionGeometry, normalGeometry, positionWorld, positionView, cameraPosition, cameraViewMatrix, uv, screenDPR, select,
  diffuseColor, transformNormalToView, normalView,
} from 'three/tsl';
import { U, sstep, applyFog, LitMaterial, lanternLight } from './tsl.js';
import { mulberry32 } from './noise.js';
import { INK } from './lanterns.js';

// rotY(a) * rotX(b) * rotZ(c) * v, as the GLSL column-major mat3 products of the old petal shader
const rotYXZ = (r, v) => {
  const cz = cos(r.z), sz = sin(r.z), cx = cos(r.y), sx = sin(r.y), cy = cos(r.x), sy = sin(r.x);
  const z = vec3(cz.mul(v.x).sub(sz.mul(v.y)), sz.mul(v.x).add(cz.mul(v.y)), v.z);
  const x = vec3(z.x, cx.mul(z.y).sub(sx.mul(z.z)), sx.mul(z.y).add(cx.mul(z.z)));
  return vec3(cy.mul(x.x).add(sy.mul(x.z)), x.y, sy.mul(x.x).negate().add(cy.mul(x.z)));
};

// instanced petal: attributes iPos (vec3), iRot (yaw, pitch, roll, scale), iTint
export function petalMaterial() {
  const iPos = attribute('iPos', 'vec3'), iRot = attribute('iRot', 'vec4');
  const camD = length(iPos.sub(cameraPosition));
  const position = rotYXZ(iRot, positionGeometry.mul(iRot.w).mul(sstep(0.9, 2.2, camD))).add(iPos);
  const vN = rotYXZ(iRot, normalGeometry).toVarying('vPetalN');
  const vP = positionGeometry.xy.div(0.1).toVarying('vPetalP');
  const color = Fn(() => {
    const vTint = attribute('iTint', 'float');
    const N = normalize(vN).toVar();
    const V = normalize(cameraPosition.sub(positionWorld));
    N.assign(select(dot(N, V).lessThan(0.0), N.negate(), N));
    const t = clamp(vP.y.add(0.5), 0.0, 1.0);
    const tip = mix(vec3(0.98, 0.72, 0.8), vec3(1.0, 0.84, 0.89), vTint);
    const base = mix(vec3(0.88, 0.38, 0.54), vec3(0.95, 0.55, 0.68), vTint);
    const alb = mix(base, tip, sstep(0.0, 0.7, t));
    const ndl = dot(N, U.uSunDir);
    const diff = max(ndl, 0.0).mul(0.7).add(ndl.mul(0.5).add(0.5).mul(0.3));
    const trans = pow(max(dot(V.negate(), U.uSunDir), 0.0), 3.0).mul(1.3).add(0.12);
    // the canopy's own glow (blossomMaterial's floor) so a falling petal matches the flowers it left: without it
    // petals away from the lanterns turn into dark blue flecks at night
    const col = alb.mul(U.uSkyAmb.mul(0.9).add(U.uSunColor.mul(U.uSunVis).mul(diff.add(trans)).mul(0.9)).add(lanternLight(positionWorld).mul(1.4)).add(vec3(0.16).add(U.uSkyAmb.mul(0.1))));
    return vec4(applyFog(col, positionWorld), 1.0);
  });
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
  m.positionNode = position;
  m.colorNode = color();
  return m;
}

// pollen / dust motes glowing in the light shafts: one instanced sprite per mote
export function makeMotes(center, count) {
  const rng = mulberry32(5);
  const p = new Float32Array(count * 3), s = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    p[i * 3] = center.x + (rng() - 0.5) * 34; p[i * 3 + 1] = 0.5 + rng() * 11; p[i * 3 + 2] = center.z + (rng() - 0.5) * 30;
    s[i] = rng();
  }
  const uPx = uniform(1);
  const base = instancedBufferAttribute(new THREE.InstancedBufferAttribute(p, 3), 'vec3');
  const seed = instancedBufferAttribute(new THREE.InstancedBufferAttribute(s, 1), 'float');
  const t = U.uTime.mul(seed.mul(0.2).add(0.15));
  const drift = mod(U.uTime.mul(U.uWind).mul(0.6).add(seed.mul(30.0)), 30.0);
  const pos = vec3(
    base.x.add(sin(t.add(seed.mul(40.0))).mul(1.2)).add(U.uWindDir.x.mul(drift)).sub(U.uWindDir.x.mul(15.0)),
    base.y.add(sin(t.mul(1.3).add(seed.mul(9.0))).mul(0.6)),
    base.z.add(cos(t.mul(0.8).add(seed.mul(17.0))).mul(1.2)).add(U.uWindDir.y.mul(drift)).sub(U.uWindDir.y.mul(15.0)),
  );
  const mvz = cameraViewMatrix.mul(vec4(pos, 1.0)).z;
  const V = normalize(pos.sub(cameraPosition));
  const toward = pow(max(dot(V, U.uSunDir), 0.0), 3.0);
  const vA = toward.mul(1.2).add(0.15).mul(sin(U.uTime.mul(2.0).add(seed.mul(50.0))).mul(0.5).add(0.5)).mul(sstep(2.0, 5.0, mvz.negate())).toVarying('vMoteA');
  // additive colour, but leave destination alpha alone: the sky's alpha 0 marks it for the light-shaft mask, and
  // the old depth-based mask counted sky behind a mote (motes never wrote depth) as sky
  const mat = new THREE.PointsNodeMaterial({
    transparent: true, depthWrite: false, sizeAttenuation: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  mat.positionNode = pos;
  // gl_PointSize was in framebuffer pixels; sprite size is in CSS pixels times the DPR
  mat.sizeNode = min(uPx.mul(seed.mul(1.6).add(1.2)).mul(30.0).div(mvz.negate()), uPx.mul(18.0)).div(screenDPR);
  mat.colorNode = Fn(() => {
    const c = uv().sub(0.5);
    const a = float(dot(c, c)).mul(-18.0).exp().mul(vA).mul(U.uSunVis);
    return vec4(U.uSunColor.mul(a).mul(1.4), a);
  })();
  const sprite = new THREE.Sprite(mat);
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.layers.set(1);
  return { mesh: sprite, uPx };
}

// Paper lanterns (see lanterns.js): the rope and bamboo frame, the lanterns swinging in the wind, and at dusk a
// small round halo per lantern. The halo keeps distant lanterns round (bloom turns sub-pixel bright points into
// blocky squares, so the paper's own glow also dims with distance to stay under the bloom threshold); up close the
// paper itself is the light, so the halo fades out there.
export function makeLanterns(d, lanternGeo) {
  const group = new THREE.Group();
  const frame = new THREE.Mesh(d.frame, new LitMaterial({ vertexColors: true, roughness: 0.75, metalness: 0 }));
  frame.castShadow = true; frame.receiveShadow = true;
  group.add(frame);

  const geo = new THREE.InstancedBufferGeometry().copy(lanternGeo);
  geo.instanceCount = d.n;
  geo.setAttribute('aHang', new THREE.InstancedBufferAttribute(d.hang, 3));
  geo.setAttribute('aLook', new THREE.InstancedBufferAttribute(d.look, 4));
  const hang = attribute('aHang', 'vec3'), look = attribute('aLook', 'vec4');
  const part = attribute('aPart', 'float'), vv = attribute('aV', 'float');
  // swing about the hanging point, downwind, plus a slow idle sway; yaw per lantern
  const wd = vec3(U.uWindDir.x, 0.0, U.uWindDir.y);
  const swing = U.uWind.mul(sin(U.uTime.mul(1.4).add(look.x)).mul(0.07).add(0.1)).add(sin(U.uTime.mul(0.8).add(look.x.mul(1.7))).mul(0.03));
  const cs = cos(swing), sn = sin(swing), cy = cos(look.w), sy = sin(look.w);
  const pose = (v) => {
    const r = vec3(v.x.mul(cy).add(v.z.mul(sy)), v.y, v.z.mul(cy).sub(v.x.mul(sy)));
    const a = dot(r.xz, U.uWindDir);
    const a2 = a.mul(cs).sub(r.y.mul(sn)), y2 = a.mul(sn).add(r.y.mul(cs));
    return vec3(r.x.add(U.uWindDir.x.mul(a2.sub(a))), y2, r.z.add(U.uWindDir.y.mul(a2.sub(a))));
  };
  const mat = new LitMaterial({ roughness: 0.65, metalness: 0, side: THREE.DoubleSide }, (out) => Fn(() => {
    // lit from inside: warm yellow through the paper, brightest across the bulge, fainter towards the rims, along the
    // ribs and towards the silhouette
    const dist = length(cameraPosition.sub(positionWorld));
    const facing = normalView.z.abs();
    const bulge = sin(vv.clamp(0.0, 1.0).mul(Math.PI)).mul(0.35).add(0.65);
    const glow = U.uLights.mul(look.z).mul(mix(1.0, 0.5, sstep(14.0, 50.0, dist))).mul(facing.mul(0.35).add(0.65)).mul(bulge).mul(2.4);
    // by day the thin paper lets light through: sun from behind, and sky light scattered inside
    const back = pow(max(dot(normalize(positionWorld.sub(cameraPosition)), U.uSunDir), 0.0), 2.0);
    const through = U.uSunColor.mul(U.uSunVis).mul(back.mul(0.9).add(0.25)).add(U.uSkyAmb.mul(0.35));
    return out.add(diffuseColor.rgb.mul(vec3(1.0, 0.88, 0.5).mul(glow).add(through)).mul(sstep(0.5, 0.4, part)));
  })());
  mat.positionNode = pose(positionGeometry).add(hang);
  mat.normalNode = transformNormalToView(pose(normalGeometry)).normalize();
  // the ink atlas (lanterns.js paintLanternInk): black ink in R, red in G, one cell per text
  const ink = new THREE.DataTexture(d.ink.data, d.ink.w, d.ink.h, THREE.RGBAFormat);
  ink.generateMipmaps = true; ink.minFilter = THREE.LinearMipmapLinearFilter; ink.magFilter = THREE.LinearFilter; ink.anisotropy = 4;
  ink.needsUpdate = true;
  mat.colorNode = Fn(() => {
    // white washi on thin bamboo ribs, a narrow red band at the top and bottom, and on the front and back what the
    // lantern says (look.y: its cell in the ink atlas), read the right way round from either side
    const paper = vec3(0.95, 0.92, 0.8), red = vec3(0.62, 0.04, 0.03), black = vec3(0.03, 0.025, 0.025);
    const band = sstep(0.1, 0.08, vv).add(sstep(0.9, 0.92, vv)).min(1.0);
    const rib = sstep(0.75, 1.0, sin(vv.mul(Math.PI * 26)).abs());
    // across the paper (metres) from the middle of the nearer of front and back, left to right as seen from outside
    const th = atan(positionGeometry.x, positionGeometry.z);
    const s = select(th.abs().lessThan(Math.PI / 2), th, sign(th).mul(th.abs().sub(Math.PI))).mul(length(positionGeometry.xz));
    const cu = s.div(INK.span).add(0.5), cv = vv.sub(INK.v0).div(INK.v1 - INK.v0);
    const inside = sstep(0.0, 0.01, cu).mul(sstep(1.0, 0.99, cu)).mul(sstep(0.0, 0.01, cv)).mul(sstep(1.0, 0.99, cv));
    const cell = look.y;
    const t = texture(ink, vec2(mod(cell, INK.cols).add(clamp(cu, 0.005, 0.995)).div(INK.cols), floor(cell.div(INK.cols)).add(clamp(cv, 0.005, 0.995)).div(INK.rows)));
    const col = mix(mix(paper, red, max(band, t.g.mul(inside))), black, t.r.mul(inside)).mul(float(1.0).sub(rib.mul(0.3)));
    return vec4(select(part.lessThan(0.5), col, vec3(0.02, 0.018, 0.016)), 1.0);
  })();
  const lamps = new THREE.Mesh(geo, mat);
  lamps.frustumCulled = false;
  group.add(lamps);

  // halos at the lantern centres (layer 1: not in the reflection)
  const uFocal = uniform(500); // drawing-buffer pixels per unit at unit distance
  const centre = instancedBufferAttribute(new THREE.InstancedBufferAttribute(d.hang, 3), 'vec3');
  const seed = instancedBufferAttribute(new THREE.InstancedBufferAttribute(d.look, 4), 'vec4');
  const cSwing = U.uWind.mul(sin(U.uTime.mul(1.4).add(seed.x)).mul(0.07).add(0.1)).add(sin(U.uTime.mul(0.8).add(seed.x.mul(1.7))).mul(0.03));
  const at = centre.add(wd.mul(sin(cSwing).mul(0.36))).add(vec3(0.0, cos(cSwing).mul(-0.36), 0.0));
  const mvz = cameraViewMatrix.mul(vec4(at, 1.0)).z.negate();
  const hm = new THREE.PointsNodeMaterial({
    transparent: true, depthWrite: false, sizeAttenuation: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, // keep the sky's alpha for the light-shaft mask
  });
  hm.positionNode = at;
  hm.sizeNode = clamp(uFocal.mul(0.9).div(mvz), 7.0, 400.0).div(screenDPR);
  hm.colorNode = Fn(() => {
    const c = uv().sub(0.5);
    const far = mix(0.05, 0.35, sstep(8.0, 40.0, mvz)); // barely there up close, where the paper shows its own light
    return vec4(vec3(1.0, 0.82, 0.42).mul(dot(c, c).mul(-22.0).exp().mul(far).mul(seed.z)), U.uLights);
  })();
  const halos = new THREE.Sprite(hm);
  halos.count = d.n;
  halos.frustumCulled = false;
  halos.layers.set(1);
  group.add(halos);
  return { group, halos, uFocal };
}

// soft round glows on fixed lamps (the temple's lanterns), the lantern halos' look for lights that do not swing;
// uFocal is the lanterns' (drawing-buffer pixels per unit at unit distance)
export function makeGlows(pos, uFocal) {
  const centre = instancedBufferAttribute(new THREE.InstancedBufferAttribute(pos, 3), 'vec3');
  const mvz = cameraViewMatrix.mul(vec4(centre, 1.0)).z.negate();
  const m = new THREE.PointsNodeMaterial({
    transparent: true, depthWrite: false, sizeAttenuation: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, // keep the sky's alpha for the light-shaft mask
  });
  m.positionNode = centre;
  m.sizeNode = clamp(uFocal.mul(2.2).div(mvz), 6.0, 400.0).div(screenDPR);
  m.colorNode = Fn(() => {
    const c = uv().sub(0.5);
    const flicker = sin(U.uTime.mul(9.0).add(centre.x.mul(3.7))).mul(0.08).add(0.92);
    return vec4(vec3(1.0, 0.6, 0.28).mul(dot(c, c).mul(-20.0).exp().mul(0.5).mul(flicker)), U.uLights);
  })();
  const glows = new THREE.Sprite(m);
  glows.count = pos.length / 3;
  glows.frustumCulled = false;
  glows.layers.set(1);
  return glows;
}
