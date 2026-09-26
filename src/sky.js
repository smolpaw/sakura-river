// Sky dome with sun, glow and drifting procedural clouds + time-of-day palette
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, mix, max, pow, dot, normalize, clamp, positionWorld, cameraPosition, If } from 'three/tsl';
import { U, vnoise, sstep } from './tsl.js';
import { clamp as clampJS, lerp, smoothstep } from './noise.js';

const cfbm = Fn(([p0]) => {
  const p = vec2(p0).toVar(), s = float(0).toVar(), a = float(0.5).toVar();
  // GLSL mat2(1.6, 1.2, -1.2, 1.6) * p (column-major), written out
  for (let i = 0; i < 5; i++) { s.addAssign(a.mul(vnoise(p))); p.assign(vec2(p.x.mul(1.6).sub(p.y.mul(1.2)), p.x.mul(1.2).add(p.y.mul(1.6))).add(3.1)); a.mulAssign(0.5); }
  return s;
});

export function makeSky() {
  const uniforms = {
    uZenith: uniform(new THREE.Color()),
    uHorizon: uniform(new THREE.Color()),
    uCloud: uniform(new THREE.Vector2()),
    uCloudLit: uniform(new THREE.Color()),
    uCloudShade: uniform(new THREE.Color()),
  };
  const { uZenith, uHorizon, uCloud, uCloudLit, uCloudShade } = uniforms;
  const skyColor = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition)).toVar();
    const h = d.y, mu = dot(d, U.uSunDir).toVar();
    const hz = pow(float(1.0).sub(clamp(h, 0.0, 1.0)), 4.0).toVar();
    const col = mix(uZenith, uHorizon, hz).toVar();
    // warm band hugging the horizon near the sun
    const sunSide = pow(max(mu, 0.0).mul(0.5).add(0.5), 3.0);
    col.assign(mix(col, U.uFogSunColor, hz.mul(hz).mul(pow(max(mu, 0.0), 4.0)).mul(0.45)));
    // below horizon blend into haze
    col.assign(mix(col, mix(U.uFogColor, U.uFogSunColor, pow(max(mu, 0.0), 6.0)), sstep(0.02, -0.08, h)));
    // mie glow + disk
    const g = max(mu, 0.0).toVar();
    col.addAssign(U.uSunColor.mul(pow(g, 40.0).mul(0.1).add(pow(g, 400.0).mul(0.45)).add(pow(g, 3000.0).mul(1.2))).mul(U.uSunVis));
    col.addAssign(U.uSunColor.mul(sstep(0.99962, 0.99978, mu)).mul(5.0).mul(U.uSunVis));
    // clouds on a virtual plane
    If(h.greaterThan(-0.02), () => {
      const cuv = d.xz.div(h.add(0.12)).mul(1.3).add(uCloud).toVar();
      const w = vec2(cfbm(cuv.mul(0.35).add(7.0)), cfbm(cuv.mul(0.35).sub(4.0))).toVar();
      const n = cfbm(cuv.mul(0.55).add(w.mul(1.4))).toVar();
      const streak = cfbm(vec2(cuv.x.mul(0.25), cuv.y.mul(1.1)).add(w));
      const dens = sstep(0.56, 0.8, n.mul(0.75).add(streak.mul(0.35))).toVar();
      dens.mulAssign(sstep(-0.02, 0.18, h).mul(float(1.0).sub(sstep(0.55, 0.95, h).mul(0.6))));
      const thick = sstep(0.55, 0.95, n);
      const cl = mix(uCloudLit, uCloudShade, sstep(0.3, 1.0, thick).mul(0.85).add(float(1.0).sub(sunSide).mul(0.25))).toVar();
      // silver lining toward the sun
      cl.addAssign(U.uSunColor.mul(pow(g, 14.0)).mul(float(1.0).sub(thick)).mul(1.2).mul(U.uSunVis));
      col.assign(mix(col, cl, dens.mul(0.9)));
    });
    // alpha 0 marks sky pixels for the light-shaft mask (replaces the old depth == far test)
    return vec4(col, 0.0);
  });
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, transparent: true, blending: THREE.NoBlending });
  mat.colorNode = skyColor();
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
  const el = -4 + 62 * Math.sin(Math.PI * clampJS(t, 0, 1));
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
