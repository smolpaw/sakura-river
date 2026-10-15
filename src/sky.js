// Sky dome with sun, a crescent moon, stars, shooting stars, glow and drifting procedural clouds + time-of-day palette
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, mix, max, min, pow, dot, normalize, clamp, cross, sqrt, length, exp, atan, asin, floor, fract, fwidth, abs, sin, sign, step, select, positionWorld, cameraPosition, If } from 'three/tsl';
import { U, vnoise, vnoise3, hashSin, hash12, sstep, loopW } from './tsl.js';
import { clamp as clampJS, lerp, smoothstep, mulberry32 } from './noise.js';

const cfbm = Fn(([p0]) => {
  const p = vec2(p0).toVar(), s = float(0).toVar(), a = float(0.5).toVar();
  // GLSL mat2(1.6, 1.2, -1.2, 1.6) * p (column-major), written out
  for (let i = 0; i < 5; i++) { s.addAssign(a.mul(vnoise(p))); p.assign(vec2(p.x.mul(1.6).sub(p.y.mul(1.2)), p.x.mul(1.2).add(p.y.mul(1.6))).add(3.1)); a.mulAssign(0.5); }
  return s;
});

// the clouds at cloud-plane coordinates cuv, thresholded by the cover's shift sh: (density, thickness)
const cloudShape = Fn(([cuv, sh]) => {
  const w = vec2(cfbm(cuv.mul(0.35).add(7.0)), cfbm(cuv.mul(0.35).sub(4.0))).toVar();
  const n = cfbm(cuv.mul(0.55).add(w.mul(1.4))).toVar();
  const streak = cfbm(vec2(cuv.x.mul(0.25), cuv.y.mul(1.1)).add(w));
  return vec2(sstep(float(0.56).sub(sh), float(0.8).sub(sh), n.mul(0.75).add(streak.mul(0.35))), sstep(float(0.55).sub(sh), float(0.95).sub(sh), n));
}).setLayout({ name: 'cloudShape', type: 'vec2', inputs: [{ name: 'cuv', type: 'vec2' }, { name: 'sh', type: 'float' }] });

const MOON_R = Math.tan(THREE.MathUtils.degToRad(1.15)); // drawn about 4x its real size
const CUT_R = 1.35, CUT_K = 0.9; // the circle that cuts the crescent, in moon radii
const MOON_COS = [Math.cos(THREE.MathUtils.degToRad(1.4)), Math.cos(THREE.MathUtils.degToRad(1.1))]; // stars hidden behind it

// Stars: a cube map of cells around the sky, STAR_N cells per unit of face coordinate, a star in about STAR_P of them,
// kept off the cell edges (a bright one further, for its halo) so that none is cut. The sky turns about the celestial pole (north is +z,
// Japan's latitude) with the clock hour: the stars' frame is the world's at midnight.
const STAR_N = 70, STAR_P = 0.5;
const LAT = THREE.MathUtils.degToRad(35);
const POLE = new THREE.Vector3(0, Math.sin(LAT), Math.cos(LAT));
// a direction in the stars' frame from right ascension (hours) and declination (degrees): at midnight in mid-April the
// sidereal time is about 13.3 h, so a star's hour angle then is 13.3 h less its right ascension
const equatorial = (ra, dec) => {
  const h = THREE.MathUtils.degToRad((13.3 - ra) * 15), d = THREE.MathUtils.degToRad(dec);
  const south = new THREE.Vector3(0, Math.cos(LAT), -Math.sin(LAT)), west = new THREE.Vector3(-1, 0, 0);
  return south.multiplyScalar(Math.cos(d) * Math.cos(h)).addScaledVector(POLE, Math.sin(d)).addScaledVector(west, Math.cos(d) * Math.sin(h));
};
// the galaxy: its north pole, its centre (in Sagittarius) and longitude 90° (in Cygnus). In April the winter Milky Way
// stands in the west after dusk, and the centre rises in the south-east after midnight and stands low in the south
// before dawn.
const GAL_N = equatorial(12.857, 27.13), GAL_C = equatorial(17.761, -28.94), GAL_L90 = equatorial(21.2, 48.33);
// the scene pass's pixels per output pixel each way (above 1 when supersampled, main.js): a star keeps its size on
// screen instead of shrinking into the downsample
export const uStarPx = uniform(1);
// the cube map's cell round direction s at n cells per unit of face coordinate: its id (unique over the faces) in xy,
// where s falls in it (0..1) in zw
const cubeCell = Fn(([s, n]) => {
  const a = abs(s).toVar();
  const m = max(a.x, max(a.y, a.z));
  const ax = step(vec3(m), a); // the major axis
  const q = select(ax.x.greaterThan(0.5), s.yz, select(ax.y.greaterThan(0.5), s.xz, s.xy)).div(m).mul(n).toVar();
  return vec4(floor(q).add(dot(ax.mul(sign(s)), vec3(1000.0, 2000.0, 3000.0))), fract(q));
}).setLayout({ name: 'cubeCell', type: 'vec4', inputs: [{ name: 's', type: 'vec3' }, { name: 'n', type: 'float' }] });
// The stars at direction s (the stars' frame); px: STAR_N's cells per output pixel; h: the sine of the altitude;
// time: U.uTime.
// Their light follows a power law, as star counts do (about 2.5 times as many stars per magnitude fainter): a star's
// light is STAR_L0 × u^-0.77 for a uniform u, so of the few thousand stars in a view's sky a few are bright, a few
// dozen moderate and most at or below what can be seen. They gather in loose clumps and towards the galactic plane
// rather than on a grid. Each is nearly a point: its core grows only slightly with its light, which is held under the
// bloom's threshold (2.2, post.js) at its twinkle's peak so none blooms; the brightest get a small, soft halo of their
// own instead. Colour by temperature, from blue-white to orange, fading to white in the faint ones (the eye sees no
// colour there). Twinkle mostly in the faint stars and low in the sky.
const STAR_L0 = 0.0047;
const starField = Fn(([s, px, h, time]) => {
  const cell = cubeCell(s, STAR_N).toVar();
  const c = cell.xy;
  const L = pow(max(hash12(c.add(9.7)), 1e-4), -0.77).mul(STAR_L0).toVar();
  // a faint star anywhere in its cell but near the edges, a bright one far enough from them for its halo
  const edge = mix(float(0.25), float(0.1), sstep(0.3, 0.05, L));
  const o = vec2(hash12(c.add(17.3)), hash12(c.add(41.7))).mul(float(1.0).sub(edge.mul(2.0))).add(edge);
  const dc = length(cell.zw.sub(o)).toVar(); // from the star, in cells
  const r = dc.div(px).toVar(); // in output pixels
  const k = hash12(c.add(5.1)).toVar();
  const gz = dot(s, GAL_N);
  const clump = vnoise3(s.mul(6.0)).mul(0.9).add(0.55).mul(exp(gz.mul(gz).mul(-16.0)).mul(0.6).add(0.75));
  // the core: sigma 0.6 px for the faint, 0.85 for the brightest
  const sg = sstep(0.03, 2.0, L).mul(0.25).add(0.6);
  const core = exp(r.mul(r).div(sg.mul(sg).mul(-2.0))).mul(min(L, 1.5));
  const halo = exp(r.div(-1.4)).mul(sstep(0.2, 2.5, L)).mul(min(L, 3.0)).mul(0.05);
  // twinkle: two sines at the star's own rates (whole turns over the clock's loop)
  const a = mix(float(0.08), float(0.45), sstep(0.15, 0.012, L)).add(sstep(0.45, 0.05, h).mul(0.35)).min(0.75);
  const w = sin(time.mul(loopW(k.mul(12.0).add(3.0))).add(k.mul(60.0))).mul(0.6).add(sin(time.mul(loopW(k.mul(17.0).add(9.0))).add(k.mul(97.0))).mul(0.4));
  const lum = core.add(halo).mul(w.mul(a).add(1.0)).mul(sstep(0.25, 0.17, dc)).min(2.0);
  const t = hash12(c.add(3.3));
  const warm = mix(mix(vec3(0.74, 0.83, 1.0), vec3(1.0, 0.97, 0.93), sstep(0.0, 0.3, t)), vec3(1.0, 0.88, 0.72), sstep(0.5, 0.78, t));
  const tint = mix(vec3(0.93, 0.95, 1.0), mix(warm, vec3(1.0, 0.75, 0.52), sstep(0.86, 0.97, t)), sstep(0.02, 0.25, L));
  return tint.mul(lum).mul(step(k, clump.mul(STAR_P)));
}).setLayout({ name: 'starField', type: 'vec3', inputs: [{ name: 's', type: 'vec3' }, { name: 'px', type: 'float' }, { name: 'h', type: 'float' }, { name: 'time', type: 'float' }] });

// The Milky Way at direction s (the stars' frame); px as starField's. A soft band along the galactic plane, wider and
// brighter towards the centre and in its great star clouds (Scutum, Cygnus), mottled with star clouds and dust, split
// from Cygnus to Sagittarius by the dark lane of the Great Rift, and grained with the faint stars no eye resolves (a
// finer cube map of them, as many as the band is dense).
const MILKY = 0.022;
const milkyWay = Fn(([s, px]) => {
  const gx = dot(s, GAL_C), gy = dot(s, GAL_L90), gz = dot(s, GAL_N);
  // near the plane gx and gy are about the cosine and sine of the longitude: exp((cos(l - l0) - 1) k) peaks at l0
  const deg = Math.PI / 180;
  const near = (l0, k) => exp(gx.mul(Math.cos(l0 * deg)).add(gy.mul(Math.sin(l0 * deg))).sub(1.0).mul(k));
  const core = near(0, 4.0).toVar();
  const along = core.mul(1.8).add(0.28).add(near(28, 30.0).mul(0.35)).add(near(75, 14.0).mul(0.3)).add(near(-75, 12.0).mul(0.25));
  const p = vec3(gx, gy, gz.mul(1.5)).toVar(); // features a little drawn out along the plane
  const wob = vnoise3(p.mul(3.0).add(11.0)).sub(0.5).toVar();
  // the bulge round the centre stands out of the plane
  const wid = core.mul(0.09).add(0.08);
  const y = gz.sub(wob.mul(0.03)).div(wid);
  const band = exp(y.mul(y).mul(-0.5)).toVar();
  const col = vec3(0).toVar();
  If(band.greaterThan(0.004), () => {
    const cl = vnoise3(p.mul(5.0)).mul(0.5).add(vnoise3(p.mul(11.0).add(3.1)).mul(0.3)).add(vnoise3(p.mul(23.0).add(7.3)).mul(0.2)).toVar();
    const dens = band.mul(along).mul(sstep(0.32, 0.74, cl).mul(1.2).add(0.3)).toVar();
    // the Great Rift, wandering about the plane from longitude -20° to 90°, ragged with the star clouds; dark dust in
    // patches all along
    const rift = sstep(0.55, 0.85, gx.mul(Math.cos(35 * deg)).add(gy.mul(Math.sin(35 * deg))));
    const z = gz.sub(wob.mul(0.025).add(0.012)).div(core.mul(0.03).add(0.045));
    const lane = exp(z.mul(z).negate()).mul(rift).mul(sstep(0.3, 0.7, cl).mul(0.35).add(0.45));
    const dust = sstep(0.56, 0.8, vnoise3(p.mul(4.0).add(19.0))).mul(0.5);
    dens.mulAssign(float(1.0).sub(lane).mul(float(1.0).sub(dust)));
    col.assign(mix(vec3(0.8, 0.82, 0.86), vec3(0.95, 0.86, 0.72), core).mul(dens.mul(MILKY)));
    // the unresolved stars: one in up to 60% of the cells of a cube map three times as fine, by the band's density
    const f = cubeCell(s, STAR_N * 3).toVar();
    const o = vec2(hash12(f.xy.add(7.7)), hash12(f.xy.add(23.1))).mul(0.5).add(0.25);
    const r = length(f.zw.sub(o)).div(px.mul(3.0));
    const lit = hash12(f.xy.add(13.3)).mul(0.02).add(0.005).mul(step(hash12(f.xy.add(2.9)), dens.mul(0.5).min(0.6)));
    col.addAssign(vec3(0.9, 0.9, 0.95).mul(exp(r.mul(r).mul(-1.4))).mul(lit));
  });
  return col;
}).setLayout({ name: 'milkyWay', type: 'vec3', inputs: [{ name: 's', type: 'vec3' }, { name: 'px', type: 'float' }] });

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

export function makeSky() {
  const uniforms = {
    uZenith: uniform(new THREE.Color()),
    uHorizon: uniform(new THREE.Color()),
    uCloud: uniform(new THREE.Vector2()), // the clouds' drift
    uCloudOld: uniform(new THREE.Vector2()), // the drift before it started again (main.js), crossfaded out
    uCloudFade: uniform(0), // how much of uCloudOld's clouds the sky shows (0: none)
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
  const { uZenith, uHorizon, uCloud, uCloudOld, uCloudFade, uCloudLit, uCloudShade, uCover, uBoltDir, uMoonDir, uMoonVis, uStarVis, uStarRot, uMeteor, uMeteorHead, uMeteorAxis, uMeteorLen } = uniforms;
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
    // stars and the Milky Way, dimmed and reddened low down by the air they shine through (about 0.3 magnitudes per
    // air mass), hidden behind the moon's disc (its dark side included); the Milky Way washed out by the moon while it
    // is up
    If(uStarVis.greaterThan(0.0), () => {
      const behindMoon = sstep(MOON_COS[0], MOON_COS[1], dot(d, uMoonDir));
      const sd = uStarRot.mul(d).toVar();
      const a = abs(sd);
      // STAR_N's cells per output pixel, from fwidth of the direction (continuous across the cube's seams); taken here,
      // in uniform control flow, as WGSL wants derivatives
      const px = length(fwidth(sd)).div(max(a.x, max(a.y, a.z))).mul(STAR_N * 0.6).mul(uStarPx).toVar();
      const air = exp(float(1.0).div(max(h, 0.0).add(0.025)).sub(1.0).max(0.0).mul(-0.28)).toVar();
      const redden = mix(vec3(1.0), vec3(1.0, 0.8, 0.6), sstep(0.35, 0.04, h)).toVar();
      col.addAssign(starField(sd, px, h, U.uTime).mul(redden).mul(air.mul(sstep(-0.005, 0.02, h))).mul(uStarVis).mul(float(1.0).sub(behindMoon)));
      const moonUp = uMoonVis.mul(sstep(-0.03, 0.1, uMoonDir.y));
      col.addAssign(milkyWay(sd, px).mul(redden).mul(air.mul(sstep(0.02, 0.25, h))).mul(uStarVis).mul(float(1.0).sub(moonUp.mul(0.5))));
    });
    // a shooting star: a streak along a great circle, brightest at its head, its trail fading behind
    If(uMeteor.greaterThan(0.0), () => {
      const off = dot(d, uMeteorAxis);
      const x = dot(d, cross(uMeteorAxis, uMeteorHead)).negate(); // angle behind the head
      const px = length(fwidth(d)).mul(0.6);
      const r = length(vec2(off, max(x.negate(), 0.0))).div(px);
      const along = clamp(x.div(uMeteorLen), 0.0, 1.0);
      const trail = float(1.0).sub(along).mul(float(1.0).sub(along)).mul(step(0.0, dot(d, uMeteorHead)));
      // the streak held below the bloom's threshold (2.2, post.js), where a line a pixel wide blooms in lumps; a bright
      // meteor's light over that in a point a few pixels wide at its head, which blooms round
      const line = exp(r.mul(r).mul(-0.8)).mul(trail).mul(uMeteor).min(2.0);
      const rh = length(vec2(off, x)).div(px);
      const head = exp(rh.mul(rh).mul(-0.3)).mul(max(uMeteor.sub(2.0), 0.0));
      col.addAssign(vec3(0.85, 0.9, 1.0).mul(line.add(head)).mul(sstep(0.0, 0.08, h)));
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
    // clouds on a virtual plane; cover moves the density thresholds (no shift at 0.35)
    const sh = uCover.sub(0.35).mul(0.5);
    const dens = float(0).toVar();
    If(h.greaterThan(-0.02), () => {
      const plane = d.xz.div(h.add(0.12)).mul(1.3).toVar();
      const shape = cloudShape(plane.add(uCloud), sh).toVar();
      If(uCloudFade.greaterThan(0.0), () => { shape.assign(mix(shape, cloudShape(plane.add(uCloudOld), sh), uCloudFade)); });
      dens.assign(shape.x);
      dens.mulAssign(sstep(-0.02, 0.18, h).mul(float(1.0).sub(sstep(0.55, 0.95, h).mul(float(0.6).mul(float(1.0).sub(sstep(0.5, 1.0, uCover)))))));
      const thick = shape.y;
      const cl = mix(uCloudLit, uCloudShade, sstep(0.3, 1.0, thick).mul(0.85).add(float(1.0).sub(sunSide).mul(0.25))).toVar();
      // silver lining toward the sun
      cl.addAssign(U.uSunColor.mul(pow(g, 14.0)).mul(float(1.0).sub(thick)).mul(1.2).mul(U.uSunVis));
      col.assign(mix(col, cl, dens.mul(0.9)));
    });
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
  // Night sky per frame: the stars placed by the clock hour (they turn only during a time-lapse); now and then a shooting star, somewhere ahead of the
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
