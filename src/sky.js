// Sky dome with sun, a crescent moon, stars, shooting stars, glow and drifting procedural clouds + time-of-day palette
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, mix, max, pow, dot, normalize, clamp, cross, sqrt, length, exp, atan, asin, floor, fract, fwidth, abs, sin, sign, step, select, positionWorld, cameraPosition, If, screenCoordinate } from 'three/tsl';
import { U, vnoise, hashSin, hash12, sstep } from './tsl.js';
import { marchClouds } from './clouds.js';
import { clamp as clampJS, lerp, smoothstep, mulberry32 } from './noise.js';

const cfbm = Fn(([p0]) => {
  const p = vec2(p0).toVar(), s = float(0).toVar(), a = float(0.5).toVar();
  // GLSL mat2(1.6, 1.2, -1.2, 1.6) * p (column-major), written out
  for (let i = 0; i < 5; i++) { s.addAssign(a.mul(vnoise(p))); p.assign(vec2(p.x.mul(1.6).sub(p.y.mul(1.2)), p.x.mul(1.2).add(p.y.mul(1.6))).add(3.1)); a.mulAssign(0.5); }
  return s;
});

const MOON_R = Math.tan(THREE.MathUtils.degToRad(1.15)); // drawn about 4x its real size
const CUT_R = 1.35, CUT_K = 0.9; // the circle that cuts the crescent, in moon radii
const MOON_COS = [Math.cos(THREE.MathUtils.degToRad(1.4)), Math.cos(THREE.MathUtils.degToRad(1.1))]; // stars hidden behind it

// Stars: a cube map of cells around the sky, STAR_N cells per unit of face coordinate, one star in STAR_P of them,
// kept off the cell edges so a star is never cut. The sky turns about the celestial pole (north is +z, Japan's
// latitude) with the clock.
const STAR_N = 70, STAR_P = 0.45;
const POLE = new THREE.Vector3(0, Math.sin(THREE.MathUtils.degToRad(35)), Math.cos(THREE.MathUtils.degToRad(35)));
// the galactic plane in the stars' frame: in April it stands low in the west after dusk (the winter Milky Way)
const MILKY_N = new THREE.Vector3(0.62, 0.55, -0.56).normalize();
const MILKY_U = new THREE.Vector3(0, 1, 0).cross(MILKY_N).normalize(), MILKY_V = MILKY_N.clone().cross(MILKY_U);
const starField = Fn(([s]) => {
  const a = abs(s).toVar();
  const m = max(a.x, max(a.y, a.z)).toVar();
  const ax = step(vec3(m), a); // the major axis
  const q = select(ax.x.greaterThan(0.5), s.yz, select(ax.y.greaterThan(0.5), s.xz, s.xy)).div(m).mul(STAR_N).toVar();
  const c = floor(q).add(dot(ax.mul(sign(s)), vec3(1000.0, 2000.0, 3000.0))).toVar(); // cell id, per face
  const o = vec2(hash12(c.add(17.3)), hash12(c.add(41.7))).mul(0.5).add(0.25);
  // distance in pixels: the pixel's angle from fwidth of the direction (continuous across the cube's seams)
  const px = length(fwidth(s)).div(m).mul(STAR_N * 0.6);
  const r = length(fract(q).sub(o)).div(px);
  const k = hash12(c.add(5.1)).toVar();
  const b = pow(hash12(c.add(9.7)), 14.0).mul(3.2).add(0.004); // many faint stars, a few bright ones
  const twinkle = sin(U.uTime.mul(k.mul(5.0).add(2.0)).add(k.mul(60.0))).mul(0.22).add(0.85);
  const tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.68), hash12(c.add(3.3)));
  return tint.mul(b.mul(twinkle).mul(exp(r.mul(r).mul(-1.0))).mul(step(k, STAR_P)));
});

// one crater per cell at most: a darker floor inside a bright rim
const crater = Fn(([q]) => {
  const c = floor(q), f = fract(q);
  const k = hashSin(c), o = vec2(hashSin(c.add(17.3)), hashSin(c.add(41.7))).mul(0.4).add(0.3);
  const d = length(f.sub(o)).div(hashSin(c.add(5.1)).mul(0.14).add(0.12)).toVar();
  const shape = float(1.0).sub(sstep(0.95, 0.55, d).mul(0.3)).add(sstep(0.75, 1.0, d).mul(sstep(1.35, 1.0, d)).mul(0.22));
  return mix(float(1.0), shape, sstep(0.45, 0.5, k));
});
// albedo over longitude/latitude: dark smooth seas over bright cratered highlands
const moonAlbedo = Fn(([uv]) => {
  const m = vnoise(uv.mul(1.5).add(3.7)).mul(0.6).add(vnoise(uv.mul(3.3).sub(1.9)).mul(0.3)).add(vnoise(uv.mul(7.0).add(8.2)).mul(0.1));
  const sea = sstep(0.48, 0.62, m);
  const a = mix(float(0.95), float(0.5), sea).toVar();
  a.mulAssign(vnoise(uv.mul(24.0)).mul(0.2).add(0.9));
  a.mulAssign(crater(uv.mul(5.0)).mul(crater(uv.mul(11.0).add(3.0))).mul(mix(crater(uv.mul(23.0).sub(7.0)), float(1.0), sea.mul(0.6))));
  return a;
});

export function makeSky({ cloudSteps = 24 } = {}) {
  const uniforms = {
    uZenith: uniform(new THREE.Color()),
    uHorizon: uniform(new THREE.Color()),
    uCloud: uniform(new THREE.Vector2()),
    uCloudLit: uniform(new THREE.Color()),
    uCloudShade: uniform(new THREE.Color()),
    uCover: uniform(0.35), // cloud cover 0..1 (0.35: the original sky)
    uBoltDir: uniform(new THREE.Vector3(0, 0.3, -1).normalize()), // where lightning flashes
    uMoonDir: uniform(new THREE.Vector3(0, 0.4, -1).normalize()),
    uMoonVis: uniform(0),
    uStarVis: uniform(0),
    uStarRot: uniform(new THREE.Matrix3()), // world direction -> the stars' frame
    uMeteor: uniform(0), // shooting star brightness (0: none)
    uMeteorHead: uniform(new THREE.Vector3(0, 1, 0)),
    uMeteorAxis: uniform(new THREE.Vector3(1, 0, 0)), // it moves along the great circle about this axis
    uMeteorLen: uniform(0), // trail length, radians
  };
  const { uZenith, uHorizon, uCloud, uCloudLit, uCloudShade, uCover, uBoltDir, uMoonDir, uMoonVis, uStarVis, uStarRot, uMeteor, uMeteorHead, uMeteorAxis, uMeteorLen } = uniforms;
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
    // mie glow + disk (hidden by heavy cloud)
    const g = max(mu, 0.0).toVar();
    const hidden = float(1.0).sub(sstep(0.5, 0.9, uCover));
    col.addAssign(U.uSunColor.mul(pow(g, 40.0).mul(0.1).add(pow(g, 400.0).mul(0.45)).add(pow(g, 3000.0).mul(1.2).mul(hidden))).mul(U.uSunVis));
    col.addAssign(U.uSunColor.mul(sstep(0.99962, 0.99978, mu)).mul(5.0).mul(U.uSunVis).mul(hidden));
    // stars, dimmed towards the horizon and hidden behind the moon's disc (its dark side included)
    If(uStarVis.greaterThan(0.0), () => {
      const behindMoon = sstep(MOON_COS[0], MOON_COS[1], dot(d, uMoonDir));
      const sd = uStarRot.mul(d).toVar();
      col.addAssign(starField(sd).mul(uStarVis).mul(sstep(-0.01, 0.3, h)).mul(float(1.0).sub(behindMoon)));
      // the Milky Way: a faint, mottled band along its great circle, split by its dark lane, washed out low down
      const x = dot(sd, MILKY_N);
      const band = exp(x.mul(x).mul(-1.0 / (0.16 * 0.16))).toVar();
      If(band.greaterThan(0.01), () => {
        const q = vec2(dot(sd, MILKY_U), dot(sd, MILKY_V)).mul(3.0);
        const cloud = cfbm(q.add(vec2(x.mul(9.0), 0.0))).toVar();
        const lane = float(1.0).sub(sstep(0.05, 0.0, x.add(cloud.sub(0.5).mul(0.08)).abs()).mul(0.6));
        col.addAssign(vec3(0.62, 0.66, 0.8).mul(band.mul(sstep(0.3, 0.75, cloud)).mul(lane).mul(0.05)).mul(uStarVis).mul(sstep(0.02, 0.35, h)));
      });
    });
    // a shooting star: a streak along a great circle, brightest at its head, its trail fading behind
    If(uMeteor.greaterThan(0.0), () => {
      const off = dot(d, uMeteorAxis);
      const x = dot(d, cross(uMeteorAxis, uMeteorHead)).negate(); // angle behind the head
      const px = length(fwidth(d)).mul(0.6);
      const r = length(vec2(off, max(x.negate(), 0.0))).div(px);
      const along = clamp(x.div(uMeteorLen), 0.0, 1.0);
      const trail = float(1.0).sub(along).mul(float(1.0).sub(along)).mul(step(0.0, dot(d, uMeteorHead)));
      col.addAssign(vec3(0.85, 0.9, 1.0).mul(exp(r.mul(r).mul(-0.8)).mul(trail).mul(uMeteor).mul(sstep(0.0, 0.08, h))));
    });
    // moon: a crescent cut from the disc by a larger circle (a gentle inner arc), shaded as a sphere with seas and
    // craters and a slightly ragged inner edge; the dark part is left to the sky; a glow off the lit limb
    If(uMoonVis.greaterThan(0.0), () => {
      const right = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0))).toVar();
      const up = cross(right, uMoonDir).toVar();
      const p = vec2(dot(d, right), dot(d, up)).div(MOON_R).toVar(); // disc coordinates, radius 1
      const r = length(p).toVar();
      const mv = uMoonVis.mul(hidden).mul(sstep(-0.01, 0.03, h)).mul(sstep(0.0, 0.2, dot(d, uMoonDir))).toVar();
      // lit towards the side the sun set on, tilted down
      const sx = dot(U.uSunDir, right);
      const s2 = vec2(mix(float(-0.82), float(0.82), sstep(-0.001, 0.001, sx)), -0.57).toVar();
      If(r.lessThan(1.0), () => {
        const n = vec3(p, sqrt(float(1.0).sub(r.mul(r)))).toVar();
        const uv = vec2(atan(n.x, n.z), asin(n.y)).toVar();
        // outside the cutting circle (radius CUT_R, centre CUT_K back from the lit side): 0.55 thick at the middle
        const rc = length(p.add(s2.mul(CUT_K))).add(vnoise(uv.mul(9.0)).sub(0.5).mul(0.035)).toVar();
        const inner = sstep(CUT_R, CUT_R + 0.07, rc).mul(sstep(CUT_R - 0.02, CUT_R + 0.03, rc).mul(0.7).add(0.3));
        const edge = sstep(1.0, float(1.0).sub(fwidth(r).mul(1.5)), r);
        // brighter towards the lit limb, dimmer into the inner edge
        const shade = mix(float(0.72), float(1.08), sstep(-0.3, 0.95, dot(p, s2)));
        const lit = vec3(1.0, 0.96, 0.9).mul(moonAlbedo(uv)).mul(shade).mul(1.25);
        col.addAssign(lit.mul(inner).mul(edge).mul(mv));
      });
      // the glow is air in front of the moon, strongest off the lit limb (no edge anywhere, so no disc shows)
      const x = length(p.sub(s2.mul(0.7))).sub(0.35).max(0.0);
      col.addAssign(vec3(0.6, 0.68, 0.86).mul(exp(x.mul(-3.0)).mul(0.035).add(exp(x.mul(-0.45)).mul(0.01))).mul(mv));
    });
    // high, thin cirrus streaks on a virtual plane far above the cloud layer (the old painted clouds, faint now)
    const sh = uCover.sub(0.35).mul(0.5);
    If(h.greaterThan(0.02), () => {
      const cuv = d.xz.div(h.add(0.12)).mul(1.3).add(uCloud.mul(0.6)).toVar();
      const w = vec2(cfbm(cuv.mul(0.35).add(7.0)), cfbm(cuv.mul(0.35).sub(4.0))).toVar();
      const streak = cfbm(vec2(cuv.x.mul(0.2), cuv.y.mul(1.4)).add(w.mul(1.2)));
      const ci = sstep(float(0.5).sub(sh), float(0.85).sub(sh), streak).mul(sstep(0.02, 0.25, h)).mul(0.35);
      const cl = mix(uCloudLit, uCloudShade, 0.25).add(U.uSunColor.mul(pow(g, 10.0)).mul(U.uSunVis).mul(0.6));
      col.assign(mix(col, cl, ci));
    });
    // the cloud layer itself, raymarched (clouds.js), over everything behind it (sun, moon, stars)
    const cv = marchClouds(d, cameraPosition.y, U.uSunDir, uCloudLit, uCloudShade, cloudSteps, hash12(screenCoordinate.xy.mul(0.913)));
    col.assign(col.mul(cv.w).add(cv.xyz));
    const dens = float(1.0).sub(cv.w);
    // lightning: the clouds light up, most around the strike
    If(U.uFlash.greaterThan(0.0), () => {
      const glow = float(0.15).add(pow(max(dot(d, uBoltDir), 0.0), 6.0).mul(1.6));
      col.addAssign(vec3(0.5, 0.55, 0.75).mul(U.uFlash).mul(glow).mul(dens.mul(1.2).add(0.35)));
    });
    // alpha 0 marks sky pixels for the light-shaft mask (replaces the old depth == far test)
    return vec4(col, 0.0);
  });
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, transparent: true, blending: THREE.NoBlending });
  mat.colorNode = skyColor();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(7000, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  // Night sky per frame: the stars turn with the clock; now and then a shooting star, somewhere ahead of the
  // camera (vis: how clear and dark the sky is, 0..1; view: the camera's forward direction).
  const rng = mulberry32(2718);
  const rot = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(), east = new THREE.Vector3();
  let meteor = null, wait = 6;
  function launch(view) {
    // in the upper part of the view (42 degrees tall), at least 14 degrees up
    const az = Math.atan2(view.x, -view.z) + (rng() - 0.5) * 1.0;
    const el = Math.max(THREE.MathUtils.degToRad(14), Math.asin(view.y) + THREE.MathUtils.degToRad(4 + rng() * 14));
    const p = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    // heading: downwards, up to 70 degrees either side
    up.set(0, 1, 0).addScaledVector(p, -p.y).normalize();
    east.crossVectors(up, p).normalize();
    const phi = (rng() - 0.5) * 2.4;
    const dir = up.clone().multiplyScalar(-Math.cos(phi)).addScaledVector(east, Math.sin(phi));
    meteor = {
      p, axis: new THREE.Vector3().crossVectors(p, dir).normalize(),
      speed: THREE.MathUtils.degToRad(18 + rng() * 16), dur: 0.4 + rng() * 0.6, len: THREE.MathUtils.degToRad(5 + rng() * 7),
      bright: 1.5 + rng() * 2.5, t: 0,
    };
  }
  function night(dt, hour, vis, view) {
    uniforms.uStarVis.value = vis;
    rot.makeRotationAxis(POLE, -(hour / 24) * Math.PI * 2);
    uniforms.uStarRot.value.setFromMatrix4(rot);
    if (!meteor && vis > 0.3 && (wait -= dt) <= 0) { launch(view); wait = 3 - Math.log(1 - rng()) * 10; }
    uniforms.uMeteor.value = 0;
    if (!meteor) return;
    const m = meteor;
    m.t += dt;
    if (m.t >= m.dur) { meteor = null; return; }
    const a = m.speed * m.t;
    uniforms.uMeteorHead.value.copy(m.p).applyQuaternion(q.setFromAxisAngle(m.axis, a));
    uniforms.uMeteorAxis.value.copy(m.axis);
    uniforms.uMeteorLen.value = Math.min(a, m.len);
    uniforms.uMeteor.value = m.bright * vis * Math.min(1, m.t / (0.15 * m.dur)) * Math.min(1, (m.dur - m.t) / (0.4 * m.dur));
  }
  return { mesh, uniforms, night, shootingStar: launch };
}

// keyframes by sun elevation (degrees). Linear HDR colours.
const KF = [
  { e: -14, zen: [0.007, 0.01, 0.026], hor: [0.032, 0.038, 0.068], sun: [0.5, 0.55, 0.8], si: 0.0, fog: [0.035, 0.045, 0.08], fogS: [0.05, 0.055, 0.1], cl: [0.06, 0.07, 0.12], cs: [0.02, 0.025, 0.05] },
  { e: -5, zen: [0.02, 0.03, 0.09], hor: [0.5, 0.2, 0.26], sun: [1.0, 0.28, 0.14], si: 0.0, fog: [0.14, 0.11, 0.18], fogS: [0.6, 0.24, 0.2], cl: [0.5, 0.22, 0.3], cs: [0.08, 0.07, 0.14] },
  { e: 1.5, zen: [0.04, 0.07, 0.24], hor: [1.25, 0.46, 0.34], sun: [1.0, 0.4, 0.18], si: 1.7, fog: [0.28, 0.2, 0.3], fogS: [0.75, 0.36, 0.24], cl: [1.5, 0.62, 0.42], cs: [0.2, 0.14, 0.26] },
  { e: 9, zen: [0.05, 0.12, 0.38], hor: [1.1, 0.6, 0.46], sun: [1.0, 0.62, 0.36], si: 3.2, fog: [0.34, 0.31, 0.43], fogS: [0.72, 0.44, 0.36], cl: [1.6, 0.95, 0.68], cs: [0.26, 0.22, 0.38] },
  { e: 25, zen: [0.05, 0.19, 0.58], hor: [0.8, 0.82, 0.86], sun: [1.0, 0.86, 0.7], si: 3.8, fog: [0.42, 0.5, 0.62], fogS: [0.95, 0.85, 0.72], cl: [1.45, 1.4, 1.35], cs: [0.42, 0.46, 0.6] },
  { e: 60, zen: [0.04, 0.2, 0.66], hor: [0.62, 0.78, 0.96], sun: [1.0, 0.97, 0.93], si: 4.2, fog: [0.42, 0.54, 0.7], fogS: [0.8, 0.8, 0.8], cl: [1.5, 1.5, 1.52], cs: [0.5, 0.56, 0.7] },
];

export function skyState(t) {
  const el = -4 + 62 * Math.sin(Math.PI * clampJS(t, -0.08, 1.08)); // past 0 / 1: into the night
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

// The moon by clock hour: high in the south-west at dusk, sinking west to set around 02:00; drawn only while the
// sky is darkening (sunElev in degrees).
// Writes its direction into `dir` and returns its visibility.
export function moonState(hour, sunElev, dir) {
  const u = (((hour - 17) % 24) + 24) % 24 / 9; // 17:00 -> 0, 02:00 -> 1
  const el = THREE.MathUtils.degToRad(lerp(34, -6, Math.pow(clampJS(u, 0, 1), 1.2)));
  const az = THREE.MathUtils.degToRad(lerp(-8, -62, clampJS(u, 0, 1)));
  dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  return u <= 1 ? smoothstep(22, 2, sunElev) : 0;
}
