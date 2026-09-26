// Shared uniforms + GLSL snippets + material patching (wind, height fog, translucency)
import * as THREE from 'three';

export const U = {
  uTime: { value: 0 },
  uWind: { value: 0.5 },
  uWindDir: { value: new THREE.Vector2(0.62, 0.78).normalize() },
  uFogColor: { value: new THREE.Color(0.7, 0.6, 0.6) },
  uFogSunColor: { value: new THREE.Color(1.4, 0.9, 0.6) },
  uFogDensity: { value: 0.0032 },
  uFogBase: { value: 0.0 },
  uFogFalloff: { value: 0.03 },
  uSunDir: { value: new THREE.Vector3(-0.5, 0.2, -0.8).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.7, 0.5) },
  uSunVis: { value: 1 },
  uSkyAmb: { value: new THREE.Color(0.4, 0.45, 0.6) },
  uFlow: { value: 0 },
};

export const GLSL_NOISE = /* glsl */`
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbmv(vec2 p){ float s = 0.0, a = 0.5; for(int i=0;i<4;i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s; }
`;

export const GLSL_WIND = /* glsl */`
uniform float uTime; uniform float uWind; uniform vec2 uWindDir;
vec3 windOffset(vec3 wp, float flex){
  float t = uTime;
  vec3 dir = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec3 side = vec3(-uWindDir.y, 0.0, uWindDir.x);
  float gust = 0.55 + 0.45 * sin(t * 0.31 + wp.x * 0.015) * sin(t * 0.19 + 1.3 + wp.z * 0.01);
  float phase = dot(wp.xz, uWindDir) * 0.09;
  float main = sin(t * 1.25 - phase + wp.y * 0.05) * 0.6 + sin(t * 2.07 - phase * 1.7 + wp.x * 0.13) * 0.3;
  float flutter = sin(t * 6.1 + wp.x * 1.7 + wp.y * 2.3 + wp.z * 1.1) * 0.5 + sin(t * 9.3 + wp.z * 2.9 - wp.y * 1.3) * 0.3;
  float s = uWind * flex;
  vec3 off = dir * s * (0.42 * gust + 0.28 * main * (0.4 + gust)) ;
  off += side * s * 0.16 * sin(t * 1.55 + wp.z * 0.21 + wp.x * 0.1);
  off += vec3(0.6, 1.0, 0.8) * flutter * s * s * 0.06;
  off.y -= s * s * 0.12 * (0.5 + 0.5 * main);
  return off;
}
`;

export const GLSL_FOG_PARS = /* glsl */`
uniform vec3 uFogColor; uniform vec3 uFogSunColor; uniform float uFogDensity; uniform float uFogBase; uniform float uFogFalloff; uniform vec3 uSunDir;
vec3 applyFog(vec3 col, vec3 wp){
  vec3 v = wp - cameraPosition;
  float d = length(v);
  vec3 dir = v / max(d, 1e-3);
  float b = uFogFalloff;
  float camH = max(cameraPosition.y - uFogBase, 0.0);
  float k = dir.y * b * d;
  float hi = exp(-b * camH) * (abs(k) > 1e-4 ? (1.0 - exp(-k)) / (dir.y * b) : d);
  float amt = 1.0 - exp(-uFogDensity * (0.085 * d + 0.55 * hi));
  float sunAmt = pow(max(dot(dir, uSunDir), 0.0), 14.0);
  vec3 fc = mix(uFogColor, uFogSunColor, sunAmt);
  return mix(col, fc, clamp(amt, 0.0, 1.0));
}
`;

// patch a built-in lit material: custom height fog, optional wind, optional fragment hooks
export function patch(mat, opts = {}) {
  const key = opts.key || 'std';
  const extraUniforms = opts.uniforms || {};
  mat.onBeforeCompile = (sh) => {
    for (const k in U) sh.uniforms[k] = U[k];
    for (const k in extraUniforms) sh.uniforms[k] = extraUniforms[k];
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', '#include <common>\n' + GLSL_WIND + (opts.vertPars || ''));
    if (opts.wind) {
      vs = vs.replace('#include <project_vertex>', /* glsl */`
        vec4 wPos = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wPos = instanceMatrix * wPos;
        #endif
        wPos = modelMatrix * wPos;
        wPos.xyz += windOffset(wPos.xyz, ${opts.wind});
        ${opts.windExtra || ''}
        vec4 mvPosition = viewMatrix * wPos;
        gl_Position = projectionMatrix * mvPosition;`);
    }
    if (opts.vertMain) vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + opts.vertMain);
    if (opts.vertNormal) vs = vs.replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\n' + opts.vertNormal);
    if (opts.vertUv) vs = vs.replace('#include <uv_vertex>', '#include <uv_vertex>\n' + opts.vertUv);
    vs = vs.replace('#include <fog_pars_vertex>', 'varying vec3 vFogWorld;\n' + (opts.varyings || ''));
    vs = vs.replace('#include <fog_vertex>', 'vFogWorld = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);\n' + (opts.vertEnd || ''));

    fs = fs.replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec3 uSunColor; uniform float uSunVis; uniform vec3 uSkyAmb;\n' + GLSL_NOISE + (opts.fragPars || ''));
    fs = fs.replace('#include <fog_pars_fragment>', 'varying vec3 vFogWorld;\n' + GLSL_FOG_PARS + (opts.varyings || ''));
    fs = fs.replace('#include <fog_fragment>', 'gl_FragColor.rgb = applyFog(gl_FragColor.rgb, vFogWorld);');
    if (opts.fragColor) fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n' + opts.fragColor);
    if (opts.noFlip) fs = fs.replace('normal *= faceDirection;', '');
    if (opts.fragNormal) fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + opts.fragNormal);
    if (opts.fragLight) fs = fs.replace('#include <opaque_fragment>', opts.fragLight + '\n#include <opaque_fragment>');
    sh.vertexShader = vs; sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

// shadow depth material that follows the same wind displacement
export function windDepthMaterial(flexExpr, key, params = {}) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, ...params });
  m.onBeforeCompile = (sh) => {
    for (const k in U) sh.uniforms[k] = U[k];
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + GLSL_WIND + 'attribute float aFlex;\n')
      .replace('#include <project_vertex>', `
        vec4 wPos = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wPos = instanceMatrix * wPos;
        #endif
        wPos = modelMatrix * wPos;
        wPos.xyz += windOffset(wPos.xyz, ${flexExpr});
        vec4 mvPosition = viewMatrix * wPos;
        gl_Position = projectionMatrix * mvPosition;`);
  };
  m.customProgramCacheKey = () => 'depth-' + key;
  return m;
}
