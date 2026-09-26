// Sky dome with sun, glow and drifting procedural clouds + time-of-day palette
import * as THREE from 'three';
import { U, GLSL_NOISE } from './shaders.js';
import { clamp, lerp, smoothstep } from './noise.js';

export function makeSky() {
  const uniforms = {
    uSunDir: U.uSunDir,
    uSunColor: U.uSunColor,
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uFogColor: U.uFogColor,
    uFogSunColor: U.uFogSunColor,
    uCloud: { value: new THREE.Vector2() },
    uCloudLit: { value: new THREE.Color() },
    uCloudShade: { value: new THREE.Color() },
    uSunVis: U.uSunVis,
    uTime: U.uTime,
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uFogColor, uFogSunColor, uCloudLit, uCloudShade;
      uniform vec2 uCloud; uniform float uSunVis; uniform float uTime;
      varying vec3 vW;
      ${GLSL_NOISE}
      float cfbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<5;i++){ s+=a*vnoise(p); p = mat2(1.6,1.2,-1.2,1.6)*p + 3.1; a*=0.5; } return s; }
      void main(){
        vec3 d = normalize(vW - cameraPosition);
        float h = d.y;
        float mu = dot(d, uSunDir);
        float hz = pow(1.0 - clamp(h, 0.0, 1.0), 4.0);
        vec3 col = mix(uZenith, uHorizon, hz);
        // warm band hugging the horizon near the sun
        float sunSide = pow(max(mu, 0.0) * 0.5 + 0.5, 3.0);
        col = mix(col, uFogSunColor, hz * hz * pow(max(mu, 0.0), 4.0) * 0.45);
        // below horizon blend into haze
        col = mix(col, mix(uFogColor, uFogSunColor, pow(max(mu,0.0), 6.0)), smoothstep(0.02, -0.08, h));
        // mie glow + disk
        float g = max(mu, 0.0);
        col += uSunColor * (pow(g, 40.0) * 0.1 + pow(g, 400.0) * 0.45 + pow(g, 3000.0) * 1.2) * uSunVis;
        col += uSunColor * smoothstep(0.99962, 0.99978, mu) * 5.0 * uSunVis;
        // clouds on a virtual plane
        if (h > -0.02) {
          vec2 uv = d.xz / (h + 0.12) * 1.3 + uCloud;
          vec2 w = vec2(cfbm(uv * 0.35 + 7.0), cfbm(uv * 0.35 - 4.0));
          float n = cfbm(uv * 0.55 + w * 1.4);
          float streak = cfbm(vec2(uv.x * 0.25, uv.y * 1.1) + w);
          float dens = smoothstep(0.56, 0.8, n * 0.75 + streak * 0.35);
          dens *= smoothstep(-0.02, 0.18, h) * (1.0 - smoothstep(0.55, 0.95, h) * 0.6);
          float thick = smoothstep(0.55, 0.95, n);
          vec3 cl = mix(uCloudLit, uCloudShade, smoothstep(0.3, 1.0, thick) * 0.85 + (1.0 - sunSide) * 0.25);
          // silver lining toward the sun
          cl += uSunColor * pow(g, 14.0) * (1.0 - thick) * 1.2 * uSunVis;
          col = mix(col, cl, dens * 0.9);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(7000, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, uniforms };
}

// keyframes by sun elevation (degrees). Linear HDR colours.
const KF = [
  { e: -5, zen: [0.02, 0.03, 0.09], hor: [0.5, 0.2, 0.26], sun: [1.0, 0.28, 0.14], si: 0.0, fog: [0.14, 0.11, 0.18], fogS: [0.6, 0.24, 0.2], cl: [0.5, 0.22, 0.3], cs: [0.08, 0.07, 0.14] },
  { e: 1.5, zen: [0.04, 0.07, 0.24], hor: [1.25, 0.46, 0.34], sun: [1.0, 0.4, 0.18], si: 1.7, fog: [0.28, 0.2, 0.3], fogS: [0.75, 0.36, 0.24], cl: [1.5, 0.62, 0.42], cs: [0.2, 0.14, 0.26] },
  { e: 9, zen: [0.05, 0.12, 0.38], hor: [1.1, 0.6, 0.46], sun: [1.0, 0.62, 0.36], si: 3.2, fog: [0.34, 0.31, 0.43], fogS: [0.72, 0.44, 0.36], cl: [1.6, 0.95, 0.68], cs: [0.26, 0.22, 0.38] },
  { e: 25, zen: [0.05, 0.19, 0.58], hor: [0.8, 0.82, 0.86], sun: [1.0, 0.86, 0.7], si: 3.8, fog: [0.42, 0.5, 0.62], fogS: [0.95, 0.85, 0.72], cl: [1.45, 1.4, 1.35], cs: [0.42, 0.46, 0.6] },
  { e: 60, zen: [0.04, 0.2, 0.66], hor: [0.62, 0.78, 0.96], sun: [1.0, 0.97, 0.93], si: 4.2, fog: [0.42, 0.54, 0.7], fogS: [0.8, 0.8, 0.8], cl: [1.5, 1.5, 1.52], cs: [0.5, 0.56, 0.7] },
];

export function skyState(t) {
  const el = -4 + 62 * Math.sin(Math.PI * clamp(t, 0, 1));
  const az = THREE.MathUtils.degToRad(lerp(60, -40, t));
  const er = THREE.MathUtils.degToRad(el);
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(er), Math.sin(er), -Math.cos(az) * Math.cos(er)).normalize();
  let i = 0;
  while (i < KF.length - 2 && el > KF[i + 1].e) i++;
  const a = KF[i], b = KF[i + 1];
  const f = smoothstep(a.e, b.e, el);
  const mix3 = (k) => new THREE.Color(lerp(a[k][0], b[k][0], f), lerp(a[k][1], b[k][1], f), lerp(a[k][2], b[k][2], f));
  return {
    elev: el, dir,
    zenith: mix3('zen'), horizon: mix3('hor'), sun: mix3('sun'), sunI: lerp(a.si, b.si, f),
    fog: mix3('fog'), fogSun: mix3('fogS'), cloudLit: mix3('cl'), cloudShade: mix3('cs'),
    vis: smoothstep(-3.5, 2.5, el),
  };
}
