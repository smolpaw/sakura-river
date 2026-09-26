// Flowing river: planar reflections, flow-aligned ripples, depth-based colour, shore foam, sun glints
import * as THREE from 'three';
import { U, GLSL_NOISE, GLSL_FOG_PARS } from './shaders.js';

export function makeWater(geometry, depthMap, sky) {
  const uniforms = {
    uTime: U.uTime, uFlow: U.uFlow, uSunDir: U.uSunDir, uSunColor: U.uSunColor, uSunVis: U.uSunVis, uSkyAmb: U.uSkyAmb,
    uFogColor: U.uFogColor, uFogSunColor: U.uFogSunColor, uFogDensity: U.uFogDensity, uFogBase: U.uFogBase, uFogFalloff: U.uFogFalloff,
    uWind: U.uWind,
    uZenith: sky.uniforms.uZenith, uHorizon: sky.uniforms.uHorizon,
    uRefl: { value: null }, uHasRefl: { value: 0 }, uTexMat: { value: new THREE.Matrix4() },
    uDepth: { value: depthMap.tex }, uHB: { value: depthMap.bounds },
    uSpeed: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: true,
    vertexShader: /* glsl */`
      attribute vec4 aRiver;
      uniform mat4 uTexMat;
      varying vec3 vW; varying vec4 vRiver; varying vec4 vReflUv;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vRiver = aRiver;
        vReflUv = uTexMat * w;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFlow, uSunVis, uHasRefl, uWind, uSpeed;
      uniform vec3 uSunColor, uSkyAmb, uZenith, uHorizon;
      uniform sampler2D uRefl, uDepth; uniform vec4 uHB;
      varying vec3 vW; varying vec4 vRiver; varying vec4 vReflUv;
      ${GLSL_NOISE}
      ${GLSL_FOG_PARS}
      float waterDepth(vec2 xz){
        vec2 uv = (xz - uHB.xy) * uHB.zw;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 2.5;
        return texture2D(uDepth, uv).r * 4.0;
      }
      float hfield(vec2 p){
        // p.x across (m), p.y along (m, increases upstream)
        float f = uFlow;
        float h = 0.0;
        h += vnoise(vec2(p.x * 0.45, (p.y + f * 0.9) * 0.3)) * 0.55;
        h += vnoise(vec2(p.x * 1.1 + 4.0, (p.y + f) * 0.8) + vec2(0.0, sin(uTime * 0.3) * 0.2)) * 0.28;
        h += vnoise(vec2(p.x * 2.7, (p.y + f * 1.15) * 2.2) + uTime * vec2(0.13, 0.0)) * 0.13;
        h += vnoise(vec2(p.x * 6.0 + uTime * 0.4, (p.y + f * 1.2) * 5.0)) * 0.05 * (0.4 + uWind);
        // standing ripple streaks
        h += vnoise(vec2(p.x * 3.5, (p.y + f * 1.05) * 0.35)) * 0.12;
        return h;
      }
      vec3 skyCol(vec3 r){
        float hz = pow(1.0 - clamp(r.y, 0.0, 1.0), 4.0);
        vec3 c = mix(uZenith, uHorizon, hz);
        c += uSunColor * pow(max(dot(r, uSunDir), 0.0), 60.0) * 0.8 * uSunVis;
        return c;
      }
      void main(){
        vec2 p = vec2(vRiver.x, vRiver.y);
        float e = 0.08;
        float h0 = hfield(p), hx = hfield(p + vec2(e, 0.0)), hy = hfield(p + vec2(0.0, e));
        float amp = 0.14 + 0.1 * uSpeed;
        vec2 g = vec2(hx - h0, hy - h0) / e * amp;
        // across/along -> world xz
        vec2 fl = normalize(vRiver.zw);            // downstream dir (x,z)
        vec2 ac = vec2(fl.y, -fl.x);               // across dir
        vec2 gw = ac * g.x + (-fl) * g.y;          // along increases upstream
        vec3 N = normalize(vec3(-gw.x, 1.0, -gw.y));
        vec3 V = normalize(cameraPosition - vW);
        float dist = length(cameraPosition - vW);
        // calm distant water to avoid aliasing
        N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(40.0, 260.0, dist)));

        float depth = waterDepth(vW.xz);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        vec3 refl;
        if (uHasRefl > 0.5) {
          vec4 ruv = vReflUv; ruv.xy += N.xz * 0.9 * ruv.w * 0.06;
          refl = texture2DProj(uRefl, ruv).rgb;
        } else {
          refl = skyCol(R);
        }
        // water body colour by depth
        float light = 0.35 + 0.65 * uSunVis;
        vec3 shallow = vec3(0.10, 0.20, 0.14) * light + uSkyAmb * 0.05;
        vec3 deep = vec3(0.012, 0.045, 0.05) * light + uSkyAmb * 0.02;
        vec3 body = mix(shallow, deep, smoothstep(0.1, 2.0, depth));
        // subsurface glow when looking toward the sun
        body += uSunColor * uSunVis * pow(max(dot(-V, uSunDir), 0.0), 4.0) * 0.08 * (1.0 - smoothstep(0.0, 1.5, depth));
        vec3 col = mix(body, refl, clamp(fres * 1.1, 0.0, 1.0));
        // sun glints
        float sd = max(dot(R, uSunDir), 0.0);
        col += uSunColor * uSunVis * (pow(sd, 900.0) * 7.0 + pow(sd, 90.0) * 0.35);
        // shore & rock foam
        float foamN = vnoise(vec2(p.x * 2.2, (p.y + uFlow * 1.1) * 1.6)) * 0.6 + vnoise(vec2(p.x * 7.0, (p.y + uFlow * 1.2) * 5.0)) * 0.4;
        float foam = smoothstep(0.32, 0.02, depth) * smoothstep(0.35, 0.7, foamN + 0.25 * (1.0 - smoothstep(0.0, 0.2, depth)));
        col = mix(col, vec3(0.85, 0.85, 0.82) * (0.4 + 0.6 * uSunVis) + uSunColor * 0.12, foam * 0.55);
        float alpha = mix(0.35, 0.96, smoothstep(0.0, 1.1, depth));
        alpha = max(alpha, fres);
        alpha *= smoothstep(0.0, 0.06, depth);
        alpha = max(alpha, foam * 0.6 * smoothstep(0.0, 0.03, depth));
        col = applyFog(col, vW);
        gl_FragColor = vec4(col, alpha);
      }`,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

// planar reflection helper (oblique clip plane at y = 0)
export class PlanarReflection {
  constructor(renderer, w, h) {
    this.renderer = renderer;
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
    this.cam = new THREE.PerspectiveCamera();
    this.texMat = new THREE.Matrix4();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  }
  setSize(w, h) { this.rt.setSize(Math.max(8, w), Math.max(8, h)); }
  render(scene, camera, hide = []) {
    const cam = this.cam;
    const normal = new THREE.Vector3(0, 1, 0);
    const mirrorPos = new THREE.Vector3(0, 0, 0);
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    if (camPos.y <= 0.02) return false;
    const view = camPos.clone(); view.y = -view.y;
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const lookAt = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
    lookAt.y = -lookAt.y;
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(rot); up.y = -up.y;
    cam.position.copy(view); cam.up.copy(up); cam.lookAt(lookAt);
    cam.far = camera.far; cam.near = camera.near; cam.fov = camera.fov; cam.aspect = camera.aspect;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);
    cam.layers.set(0);
    // texture matrix
    this.texMat.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.texMat.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    // oblique near plane
    const plane = new THREE.Plane(normal, 0).applyMatrix4(cam.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant - 0.05);
    const pm = cam.projectionMatrix;
    const q = new THREE.Vector4(
      (Math.sign(clip.x) + pm.elements[8]) / pm.elements[0],
      (Math.sign(clip.y) + pm.elements[9]) / pm.elements[5],
      -1.0,
      (1.0 + pm.elements[10]) / pm.elements[14]
    );
    clip.multiplyScalar(2.0 / clip.dot(q));
    pm.elements[2] = clip.x; pm.elements[6] = clip.y; pm.elements[10] = clip.z + 1.0; pm.elements[14] = clip.w;
    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const prevShadowAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, cam);
    r.setRenderTarget(prevRT);
    r.shadowMap.autoUpdate = prevShadowAuto;
    hide.forEach((o, i) => (o.visible = vis[i]));
    return true;
  }
}
