// Shared TSL building blocks: scene uniforms, value noise, wind, height fog, and a lit material with a
// post-lighting hook. One source compiles to WGSL (WebGPU) and GLSL (WebGL2 fallback).
import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, uniform, mix, sin, fract, floor, dot, exp, max, abs, clamp, normalize, length, pow,
  cameraPosition, positionWorld, positionLocal, modelWorldMatrix, modelWorldMatrixInverse, modelNormalMatrix, normalLocal, fog, varyingProperty,
  reference, renderGroup, texture, normalView, BRDF_GGX, BRDF_Lambert, specularColorBlended, specularF90, roughness, diffuseContribution,
} from 'three/tsl';
import { LIGHTMAP } from './lights.js';
import { sunShadow } from './sunshadow.js';

export const U = {
  uTime: uniform(0),
  uWind: uniform(0.5),
  uWindRun: uniform(0), // wind integrated over time: drift that stays smooth while the wind changes
  uWindDir: uniform(new THREE.Vector2(0.62, 0.78).normalize()),
  uFogColor: uniform(new THREE.Color(0.7, 0.6, 0.6)),
  uFogSunColor: uniform(new THREE.Color(1.4, 0.9, 0.6)),
  uFogDensity: uniform(0.0032),
  uFogBase: uniform(0.0),
  uFogFalloff: uniform(0.03),
  uAerial: uniform(1 / 3000), // the air's haze per metre at the valley floor (aerial perspective, fogAmount)
  uSunDir: uniform(new THREE.Vector3(-0.5, 0.2, -0.8).normalize()),
  uSunColor: uniform(new THREE.Color(1, 0.7, 0.5)),
  uSunVis: uniform(1),
  uSkyAmb: uniform(new THREE.Color(0.4, 0.45, 0.6)),
  uFlow: uniform(0),
  uLights: uniform(0), // the lamps: 0 off .. 1 fully on (dusk)
  uLightColor: uniform(new THREE.Color(1.0, 0.6, 0.3)), // warm light through the paper
  uFireA: uniform(new THREE.Vector3(0, -1e4, 0)), // the fire baskets' flames (lanterns.js): their light flickers
  uFireB: uniform(new THREE.Vector3(0, -1e4, 0)),
  uRain: uniform(0), // rain intensity 0..1 (streaks, ripples on the river)
  uFlash: uniform(0), // lightning flash level
  uMist: uniform(0), // river mist at dawn (kawagiri) 0..1
};
// the scene's uniforms are the same for every object: one shared buffer per render instead of one per object
for (const u of Object.values(U)) u.setGroup(renderGroup);

// Warm light from the lamps (lights.js) on whatever is near them: ground, grass, rocks, the cherries' bark and
// blossoms, the deer, falling petals. The light map holds each spot's light and its lamps' height; it falls off up
// and down from there as from a lamp. Filled in once the lamps are known (setLightMap); read at level 0, so it is
// safe in any branch. The two fire baskets' light is added as it is: orange, flickering.
const LM = LIGHTMAP;
const lightTex = new THREE.DataTexture(new Uint16Array(LM.nx * LM.nz * 2), LM.nx, LM.nz, THREE.RGFormat, THREE.HalfFloatType);
lightTex.magFilter = lightTex.minFilter = THREE.LinearFilter;
lightTex.generateMipmaps = false;
lightTex.matrixAutoUpdate = false; // no uv transform to recompute per object and frame
export function setLightMap(data) {
  lightTex.image.data.set(data);
  lightTex.needsUpdate = true;
}
export const lanternLight = Fn(([wp]) => {
  const o = vec3(0.0).toVar();
  If(U.uLights.greaterThan(0.0), () => {
    const t = texture(lightTex, wp.xz.sub(vec2(LM.x0, LM.z0)).div(vec2(LM.nx * LM.cell, LM.nz * LM.cell))).level(0);
    const dy = wp.y.sub(t.g.div(max(t.r, 1e-4)));
    o.assign(U.uLightColor.mul(t.r).mul(exp(dy.mul(dy).mul(-1.0 / 9.0))));
    const fire = (f) => {
      const v = wp.sub(f);
      const flicker = sin(U.uTime.mul(13.0).add(f.x)).mul(0.1).add(sin(U.uTime.mul(7.7).add(f.z.mul(3.0))).mul(0.08)).add(0.82);
      return exp(dot(v, v).mul(-1.0 / 10.0)).mul(flicker);
    };
    o.assign(o.add(vec3(1.0, 0.42, 0.13).mul(fire(U.uFireA).add(fire(U.uFireB))).mul(0.75)).mul(U.uLights));
  });
  return o;
});

// ---------- noise (same math as the GLSL it replaces) ----------
export const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

export const vnoise = Fn(([p]) => {
  const i = floor(p).toVar(), f = fract(p).toVar();
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0)).toVar();
  // corners as exact floor() results: written as i + (1, 0) a compiler may reassociate (i + 1) * 0.1031 per call
  // site, giving one lattice point different hash values from neighbouring cells (visible tears on the water)
  const i10 = floor(p.add(vec2(1, 0))), i01 = floor(p.add(vec2(0, 1))), i11 = floor(p.add(vec2(1, 1)));
  return mix(mix(hash12(i), hash12(i10), u.x), mix(hash12(i01), hash12(i11), u.x), u.y);
});

// sin-based hash used by the post passes (GLSL: fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453))
export const hashSin = Fn(([p]) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)));

// ---------- wind ----------
// world-space offset for a vertex at world position wp with flexibility flex, at time t
export const windOffset = Fn(([wp, flex, t]) => {
  const wd = U.uWindDir;
  const dir = vec3(wd.x, 0.0, wd.y), side = vec3(wd.y.negate(), 0.0, wd.x);
  const gust = sin(t.mul(0.31).add(wp.x.mul(0.015))).mul(sin(t.mul(0.19).add(1.3).add(wp.z.mul(0.01)))).mul(0.45).add(0.55).toVar();
  const phase = dot(wp.xz, wd).mul(0.09).toVar();
  const main = sin(t.mul(1.25).sub(phase).add(wp.y.mul(0.05))).mul(0.6).add(sin(t.mul(2.07).sub(phase.mul(1.7)).add(wp.x.mul(0.13))).mul(0.3)).toVar();
  const flutter = sin(t.mul(6.1).add(wp.x.mul(1.7)).add(wp.y.mul(2.3)).add(wp.z.mul(1.1))).mul(0.5)
    .add(sin(t.mul(9.3).add(wp.z.mul(2.9)).sub(wp.y.mul(1.3))).mul(0.3)).toVar();
  const s = U.uWind.mul(flex).toVar();
  const off = dir.mul(s).mul(gust.mul(0.42).add(main.mul(0.28).mul(gust.add(0.4)))).toVar();
  off.addAssign(side.mul(s).mul(0.16).mul(sin(t.mul(1.55).add(wp.z.mul(0.21)).add(wp.x.mul(0.1)))));
  off.addAssign(vec3(0.6, 1.0, 0.8).mul(flutter).mul(s).mul(s).mul(0.06));
  off.y.subAssign(s.mul(s).mul(0.12).mul(main.mul(0.5).add(0.5)));
  return off;
});

// Shadow lookup position for receivers, as r170 computed it in the vertex shader: the rest (unswayed) world
// position pushed along the unflipped vertex normal by the light's normal bias (the light's own normalBias is 0).
export const SHADOW_NORMAL_BIAS = 0.04;
const restShadowPos = varyingProperty('vec3', 'vRestShadowPos');
const shadowPos = (restWorld, n) => restWorld.add(normalize(modelNormalMatrix.mul(n)).mul(SHADOW_NORMAL_BIAS));
export const receiverShadowPosition = (n = normalLocal) => shadowPos(modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz, n).toVarying('vShadowPos');

// positionNode for wind-swayed geometry: displace in world space, return to local space.
// `extra(wp)` may add further world-space displacement (grass wave). Shadow passes reuse positionNode.
// Pair it with `windShadowPosition` as receivedShadowPositionNode (see above).
export function windPosition(flexNode, extra = null, shadowNormal = normalLocal) {
  return Fn(() => {
    const wp = modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xyz.toVar();
    restShadowPos.assign(shadowPos(wp, shadowNormal));
    wp.addAssign(windOffset(wp, flexNode, U.uTime));
    if (extra) extra(wp);
    return modelWorldMatrixInverse.mul(vec4(wp, 1.0)).xyz;
  })();
}

// ---------- height fog ----------
const AERIAL_H = 600;
export const fogAmount = Fn(([wp]) => {
  const v = wp.sub(cameraPosition).toVar();
  const d = length(v).toVar();
  const dir = v.div(max(d, 1e-3)).toVar();
  const b = U.uFogFalloff;
  const camH = max(cameraPosition.y.sub(U.uFogBase), 0.0);
  const k = dir.y.mul(b).mul(d).toVar();
  const hi = exp(b.negate().mul(camH)).mul(abs(k).greaterThan(1e-4).select(float(1.0).sub(exp(k.negate())).div(dir.y.mul(b)), d));
  // aerial perspective: the air itself, thinning over hundreds of metres of height (AERIAL_H), so the far hills and
  // the mountain fade into the haze, its summit less than its foot
  const ka = dir.y.mul(d).div(AERIAL_H).toVar();
  const air = exp(cameraPosition.y.max(0.0).div(-AERIAL_H)).mul(abs(ka).greaterThan(1e-4).select(float(1.0).sub(exp(ka.negate())).div(ka), 1.0)).mul(d);
  const amt = float(1.0).sub(exp(U.uFogDensity.negate().mul(d.mul(0.085).add(hi.mul(0.55))).sub(air.mul(U.uAerial))));
  return clamp(amt, 0.0, 1.0);
});
export const fogTint = Fn(([wp]) => {
  const dir = normalize(wp.sub(cameraPosition));
  return mix(U.uFogColor, U.uFogSunColor, pow(max(dot(dir, U.uSunDir), 0.0), 14.0));
});
export const applyFog = Fn(([col, wp]) => mix(col, fogTint(wp), fogAmount(wp)));

// scene.fogNode for lit materials: fog(color, factor) mixes the lit output by the world position
export function sceneFog() {
  return fog(fogTint(positionWorld), fogAmount(positionWorld));
}

// ---------- lit material ----------
// MeshStandardNodeMaterial plus `light(outgoingLight) -> node`, applied after lighting and emissive, before fog
// (the equivalent of editing outgoingLight in the old onBeforeCompile patches).
export const windShadowPosition = () => restShadowPos;

// three r170's physical lighting (the baseline look). r181+ darkens direct diffuse by (1 - Fresnel), adds a
// multi-scatter factor to direct specular and scales hemisphere diffuse by (1 - scattering); r170 did none of that.
class R170LightingModel extends THREE.PhysicalLightingModel {
  direct({ lightDirection, lightColor, reflectedLight }) {
    // (the one direct light is the sun: the valley's shadow map, sunshadow.js, on top of its own)
    const irradiance = normalView.dot(lightDirection).clamp().mul(lightColor).mul(sunShadow);
    reflectedLight.directSpecular.addAssign(irradiance.mul(BRDF_GGX({ lightDirection, f0: specularColorBlended, f90: specularF90, roughness })));
    reflectedLight.directDiffuse.addAssign(irradiance.mul(BRDF_Lambert({ diffuseColor: diffuseContribution })));
  }
  indirectDiffuse(builder) {
    const { irradiance, reflectedLight } = builder.context;
    reflectedLight.indirectDiffuse.addAssign(irradiance.mul(BRDF_Lambert({ diffuseColor: diffuseContribution })));
  }
}

export class LitMaterial extends THREE.MeshStandardNodeMaterial {
  constructor(params = {}, light = null) {
    super(params);
    this.lightHook = light;
    if (!this.receivedShadowPositionNode) this.receivedShadowPositionNode = receiverShadowPosition();
  }
  setupLightingModel() {
    return new R170LightingModel();
  }
  setupLighting(builder) {
    const out = super.setupLighting(builder);
    return this.lightHook ? this.lightHook(out) : out;
  }
}

// Hermite smoothstep written out, so reversed edges (edge0 > edge1, common in the original GLSL) behave the
// same on every backend and vendor
export const sstep = Fn(([e0, e1, x]) => {
  const t = clamp(x.sub(e0).div(float(e1).sub(e0)), 0.0, 1.0);
  return t.mul(t).mul(float(3.0).sub(t.mul(2.0)));
});

// ---------- shadows ----------
// r170's PCFSoftShadowMap (removed in r186): its 16-texel weighted sum equals 9 bilinear depth-compare taps on a
// 3x3 texel grid (per-axis texel weights 1-f, 1, 1, f), so hardware bilinear compare reproduces it.
export const pcfSoftShadowFilter = Fn(({ depthTexture, shadowCoord, shadow }) => {
  const mapSize = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
  const texel = vec2(1).div(mapSize);
  let sum = float(0);
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    sum = sum.add(texture(depthTexture, shadowCoord.xy.add(texel.mul(vec2(i, j)))).compare(shadowCoord.z));
  }
  return sum.mul(1 / 9);
});
