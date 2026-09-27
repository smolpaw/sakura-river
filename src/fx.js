// Node materials for the custom-shaded effects: petals (flying + fallen), pollen motes, bench rain
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uniform, attribute, instancedBufferAttribute, mix, max, min, pow, dot, normalize, clamp, length, sin, cos, mod,
  positionGeometry, normalGeometry, positionWorld, positionView, cameraPosition, cameraViewMatrix, uv, screenDPR, select, cross,
} from 'three/tsl';
import { U, sstep, applyFog, windOffset } from './tsl.js';
import { mulberry32 } from './noise.js';

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
    const col = alb.mul(U.uSkyAmb.mul(0.9).add(U.uSunColor.mul(U.uSunVis).mul(diff.add(trans)).mul(0.9)));
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

// string lights: one round glow sprite per bulb (a bright core and a soft halo), swaying with its branch.
// Drawn as sprites rather than tiny meshes: bloom turns sub-pixel points into blocky squares.
export function makeStringLights(pos, flex, origin) {
  const n = flex.length;
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { p[i * 3] = pos[i * 3] + origin.x; p[i * 3 + 1] = pos[i * 3 + 1] + origin.y; p[i * 3 + 2] = pos[i * 3 + 2] + origin.z; }
  const uFocal = uniform(500); // drawing-buffer pixels per unit at unit distance
  const base = instancedBufferAttribute(new THREE.InstancedBufferAttribute(p, 3), 'vec3');
  const fl = instancedBufferAttribute(new THREE.InstancedBufferAttribute(flex, 1), 'float');
  const swayed = base.add(windOffset(base, fl, U.uTime));
  // nudged towards the camera so the halo is not cut by the bark it sits on
  const at = swayed.add(normalize(cameraPosition.sub(swayed)).mul(0.08));
  const mvz = cameraViewMatrix.mul(vec4(at, 1.0)).z.negate();
  const mat = new THREE.PointsNodeMaterial({
    transparent: true, depthWrite: false, sizeAttenuation: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, // keep the sky's alpha for the light-shaft mask
  });
  mat.positionNode = at;
  mat.sizeNode = clamp(uFocal.mul(0.3).div(mvz), 5.0, 140.0).div(screenDPR);
  mat.colorNode = Fn(() => {
    const c = uv().sub(0.5);
    const r2 = dot(c, c);
    const glow = r2.mul(-500.0).exp().mul(10.0).add(r2.mul(-30.0).exp().mul(0.9)); // core + halo
    return vec4(U.uLightColor.mul(glow), U.uLights);
  })();
  const sprite = new THREE.Sprite(mat);
  sprite.count = n;
  sprite.frustumCulled = false;
  return { mesh: sprite, uFocal };
}

// bench-only rain placeholder: instanced streaks animated in the vertex stage, in a box around the camera
export function rainMaterial() {
  const seed = attribute('aSeed', 'vec4');
  const BOX = vec3(60.0, 30.0, 60.0);
  const pos = Fn(() => {
    const p = seed.xyz.mul(BOX).toVar();
    p.y.subAssign(U.uTime.mul(seed.w.mul(3.0).add(9.0)));
    const w = U.uWindDir.mul(U.uWind).mul(U.uTime).mul(2.0);
    p.assign(vec3(p.x.add(w.x), p.y, p.z.add(w.y)));
    const c = cameraPosition.sub(BOX.mul(0.5));
    p.assign(c.add(mod(p.sub(c), BOX)));
    const fall = normalize(vec3(U.uWindDir.x.mul(U.uWind).mul(0.2), -1.0, U.uWindDir.y.mul(U.uWind).mul(0.2)));
    const side = normalize(cross(fall, normalize(cameraPosition.sub(p))));
    return p.add(side.mul(positionGeometry.x).mul(0.012)).add(fall.mul(positionGeometry.y).mul(0.55));
  })();
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  m.positionNode = pos;
  m.colorNode = vec4(applyFog(U.uSkyAmb.mul(1.2).add(U.uSunColor.mul(0.15)), positionWorld), seed.w.mul(0.12).add(0.18));
  return m;
}
