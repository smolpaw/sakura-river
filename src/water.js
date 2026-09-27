// Flowing river: planar reflection (reflector()), flow-aligned ripples, depth-based colour, shore foam, sun glints
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uniform, texture, attribute, mix, max, min, pow, dot, normalize, clamp, length, reflect, sin, cos, abs, floor, fract,
  positionWorld, cameraPosition, reflector, If, select,
} from 'three/tsl';
import { U, vnoise, hash12, sstep, applyFog } from './tsl.js';

export function makeWater(geometry, depthMap, sky, { reflectionScale = 0, clearing = null } = {}) {
  const uniforms = { uHasRefl: uniform(0), uSpeed: uniform(1) };
  const { uZenith, uHorizon } = sky.uniforms;
  const uHB = uniform(depthMap.bounds), uRB = uniform(depthMap.rockBounds);
  const depthTex = texture(depthMap.tex), rockTex = texture(depthMap.rockTex);
  const within = (uv) => uv.x.greaterThanEqual(0.0).and(uv.y.greaterThanEqual(0.0)).and(uv.x.lessThanEqual(1.0)).and(uv.y.lessThanEqual(1.0));

  const bedDepth = Fn(([xz]) => {
    const duv = xz.sub(uHB.xy).mul(uHB.zw).toVar();
    return select(within(duv), depthTex.sample(duv).r.mul(4.0), float(2.5));
  });
  // rocks sitting in the river: x = water left above them (4 = no rock), y = where the current breaks on them
  const rockAt = Fn(([xz]) => {
    const ruv = xz.sub(uRB.xy).mul(uRB.zw).toVar();
    const t = rockTex.sample(ruv);
    return select(within(ruv), vec2(t.r.mul(4.0), t.g), vec2(4.0, 0.0));
  });
  const hfield = Fn(([p]) => {
    // p.x across (m), p.y along (m, increases downstream: the patterns scroll with the current)
    const f = U.uFlow, t = U.uTime;
    const h = float(0).toVar();
    h.addAssign(vnoise(vec2(p.x.mul(0.45), p.y.sub(f.mul(0.9)).mul(0.3))).mul(0.55));
    h.addAssign(vnoise(vec2(p.x.mul(1.1).add(4.0), p.y.sub(f).mul(0.8)).add(vec2(0.0, sin(t.mul(0.3)).mul(0.2)))).mul(0.28));
    h.addAssign(vnoise(vec2(p.x.mul(2.7), p.y.sub(f.mul(1.15)).mul(2.2)).add(t.mul(vec2(0.13, 0.0)))).mul(0.13));
    h.addAssign(vnoise(vec2(p.x.mul(6.0).add(t.mul(0.4)), p.y.sub(f.mul(1.2)).mul(5.0))).mul(0.05).mul(U.uWind.add(0.4)));
    // standing ripple streaks
    h.addAssign(vnoise(vec2(p.x.mul(3.5), p.y.sub(f.mul(1.05)).mul(0.35))).mul(0.12));
    return h;
  });
  // raindrops: rings spreading from random points of two jittered grids (world metres); returns a slope.
  // Each cell's drop lands at a random moment of its cycle, in a fraction of cycles that grows with the rain.
  const ripples = Fn(([xz]) => {
    const g = vec2(0.0).toVar();
    for (const [cell, off, rate] of [[0.55, 0.0, 1.1], [0.37, 0.43, 1.37]]) {
      const q = xz.div(cell).add(off);
      const id = floor(q), f = fract(q).sub(0.5);
      const h = hash12(id);
      const c = vec2(h, hash12(id.add(19.7))).sub(0.5).mul(0.3);
      const cyc = U.uTime.mul(rate).add(h.mul(13.0));
      const ph = fract(cyc);
      const on = hash12(id.add(floor(cyc).mul(7.13))).lessThan(U.uRain).select(1.0, 0.0);
      const v = f.sub(c), d = length(v);
      const x = d.sub(ph.mul(0.33));
      const env = float(1.0).sub(ph).mul(float(1.0).sub(ph)).mul(sstep(0.1, 0.0, abs(x)));
      g.addAssign(v.div(max(d, 1e-3)).mul(cos(x.mul(45.0))).mul(env).mul(on));
    }
    return g;
  });
  const skyCol = Fn(([r]) => {
    const hz = pow(float(1.0).sub(clamp(r.y, 0.0, 1.0)), 4.0);
    return mix(uZenith, uHorizon, hz).add(U.uSunColor.mul(pow(max(dot(r, U.uSunDir), 0.0), 60.0)).mul(0.8).mul(U.uSunVis));
  });

  let refl = null;
  if (reflectionScale > 0) {
    refl = reflector({ resolutionScale: reflectionScale });
    refl.target.rotateX(-Math.PI / 2);
  }

  const waterColor = Fn(() => {
    const vW = positionWorld;
    const riv = attribute('aRiver', 'vec4');
    const p = vec2(riv.x, riv.y).toVar();
    const rk = rockAt(vW.xz).toVar();
    const rock = rk.x, wake = rk.y.mul(clamp(uniforms.uSpeed.mul(0.5).add(0.45), 0.0, 1.3)).toVar(); // calmer when the river slows
    const e = 0.08;
    const h0 = hfield(p), hx = hfield(p.add(vec2(e, 0.0))), hy = hfield(p.add(vec2(0.0, e)));
    const amp = float(0.14).add(uniforms.uSpeed.mul(0.1)).mul(wake.mul(2.0).add(1.0)).mul(U.uRain.mul(0.6).add(1.0)); // choppy where it breaks, and in rain
    const g = vec2(hx.sub(h0), hy.sub(h0)).div(e).mul(amp).toVar();
    // across/along -> world xz
    const fl = normalize(riv.zw).toVar(); // downstream dir (x,z)
    const ac = vec2(fl.y, fl.x.negate());   // across dir
    const gw = ac.mul(g.x).add(fl.mul(g.y)).toVar();
    const dist = length(cameraPosition.sub(vW)).toVar();
    If(U.uRain.greaterThan(0.0), () => {
      gw.addAssign(ripples(vW.xz).mul(U.uRain.mul(0.15).add(0.2)).mul(sstep(30.0, 6.0, dist)));
    });
    const N = normalize(vec3(gw.x.negate(), 1.0, gw.y.negate())).toVar();
    const V = normalize(cameraPosition.sub(vW)).toVar();
    // calm distant water to avoid aliasing
    N.assign(normalize(mix(N, vec3(0.0, 1.0, 0.0), sstep(40.0, 260.0, dist))));
    const bed = bedDepth(vW.xz).toVar();
    const depth = min(bed, rock).toVar();
    // base clamped: a dot of unit vectors can exceed 1 by rounding, and pow of a negative is NaN on many GPUs
    const fres = float(0.02).add(pow(max(float(1.0).sub(max(dot(N, V), 0.0)), 0.0), 5.0).mul(0.98)).toVar();
    const R = reflect(V.negate(), N).toVar();
    const reflCol = skyCol(R).toVar();
    if (refl) {
      If(uniforms.uHasRefl.greaterThan(0.5), () => {
        // the old projective lookup displaced uv by N.xz * 0.9 * 0.06; reflector()'s screen uv runs the other way in z
        reflCol.assign(refl.sample(refl.uvNode.add(vec2(N.x, N.z.negate()).mul(0.054))).rgb);
      });
    }
    // water body colour by depth
    const light = uniformMix(U.uSunVis);
    const shallow = vec3(0.10, 0.20, 0.14).mul(light).add(U.uSkyAmb.mul(0.05));
    const deep = vec3(0.012, 0.045, 0.05).mul(light).add(U.uSkyAmb.mul(0.02));
    const body = mix(shallow, deep, sstep(0.1, 2.0, depth)).toVar();
    // subsurface glow when looking toward the sun
    body.addAssign(U.uSunColor.mul(U.uSunVis).mul(pow(max(dot(V.negate(), U.uSunDir), 0.0), 4.0)).mul(0.08).mul(float(1.0).sub(sstep(0.0, 1.5, depth))));
    const col = mix(body, reflCol, clamp(fres.mul(1.1), 0.0, 1.0)).toVar();
    // sun glints
    const sd = max(dot(R, U.uSunDir), 0.0);
    col.addAssign(U.uSunColor.mul(U.uSunVis).mul(pow(sd, 900.0).mul(7.0).add(pow(sd, 90.0).mul(0.35))));
    // shore & rock foam
    const foamN = vnoise(vec2(p.x.mul(2.2), p.y.sub(U.uFlow.mul(1.1)).mul(1.6))).mul(0.6).add(vnoise(vec2(p.x.mul(7.0), p.y.sub(U.uFlow.mul(1.2)).mul(5.0))).mul(0.4));
    // a band along the shore; at rocks, white water streaked along the current (none on the rock itself)
    const shore = sstep(0.32, 0.02, bed).mul(sstep(0.35, 0.7, foamN.add(float(1.0).sub(sstep(0.0, 0.2, bed)).mul(0.25))));
    const streak = vnoise(vec2(p.x.mul(6.0), p.y.sub(U.uFlow.mul(1.3)).mul(0.9))).mul(0.6).add(foamN.mul(0.4));
    const broken = sstep(0.2, 0.65, wake.mul(streak.mul(0.9).add(0.45)));
    const foam = max(shore, broken).mul(sstep(0.0, 0.05, rock)).toVar();
    col.assign(mix(col, vec3(0.85, 0.85, 0.82).mul(U.uSunVis.mul(0.6).add(0.4)).add(U.uSunColor.mul(0.12)), foam.mul(0.55)));
    const alpha = mix(0.35, 0.96, sstep(0.0, 1.1, depth)).toVar();
    alpha.assign(max(alpha, fres));
    alpha.mulAssign(sstep(0.0, 0.06, bed)); // shoreline fade; over rocks a thin film stays
    if (clearing) alpha.mulAssign(float(1.0).sub(clearing(vW.xz).mul(0.75))); // koi just under the surface
    alpha.assign(max(alpha, foam.mul(0.6).mul(sstep(0.0, 0.03, depth))));
    return vec4(applyFog(col, vW), alpha);
  });

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: true, fog: false });
  mat.colorNode = waterColor();
  const mesh = new THREE.Mesh(geometry, mat);
  if (refl) mesh.add(refl.target);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return { mesh, uniforms, reflector: refl };
}

const uniformMix = (vis) => vis.mul(0.65).add(0.35);
