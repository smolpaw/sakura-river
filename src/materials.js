// Lit materials for the scene, as TSL node materials. Each reproduces the math of the GLSL
// onBeforeCompile patch it replaces (see git history of src/shaders.js).
import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, mix, max, min, pow, dot, normalize, clamp, reflect, texture, uv, attribute, varyingProperty, floor, fract, select,
  cameraPosition, cameraViewMatrix, positionWorld, normalView, normalWorld, normalLocal, diffuseColor, sin,
  transformNormalToView, faceDirection, exp, sign,
} from 'three/tsl';
import { U, vnoise, hash12, sstep, LitMaterial, windPosition, windShadowPosition, lanternLight } from './tsl.js';
import { grassColor, grassWave, patchFrom } from './grass.js';
import { sunShadow } from './sunshadow.js';

const wp = positionWorld;
const viewDir = () => normalize(cameraPosition.sub(wp));

// ---------- the lanes underfoot ----------
// Close by (within LANE_NEAR m of the camera) the lanes' bare earth gains grit, small stones and two faint ruts worn
// along them, with a touch of relief the sun grazes. The lanes (world.js LANES) reach the shader as a texture: per
// 1 m texel the signed distance across the nearest lane's middle line (as world.js laneDist measures it, the sign
// by its side) and that lane's direction. Beyond LANE_NEAR the ground is drawn exactly as without it.
const LANE_NEAR = 20;
const laneMaps = new WeakMap();
function laneMap(lanes) {
  if (laneMaps.has(lanes)) return laneMaps.get(lanes);
  const segs = [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const L of lanes) for (let i = 0; i < L.length; i++) {
    const [x, z] = L[i];
    x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z);
    if (!i) continue;
    const [ax, az] = L[i - 1], vx = x - ax, vz = z - az, l = Math.hypot(vx, vz);
    if (l > 1e-6) segs.push({ ax, az, vx, vz, l2: l * l, dx: vx / l, dz: vz / l });
  }
  const M = 6; // m of margin: the texture's edge texels lie well off every lane
  x0 = Math.floor(x0 - M); z0 = Math.floor(z0 - M);
  const nx = Math.ceil(x1 + M - x0) + 1, nz = Math.ceil(z1 + M - z0) + 1, data = new Uint16Array(nx * nz * 4), h = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const px = x0 + i, pz = z0 + j;
    let bd = Infinity, bs = 0, best = segs[0];
    for (const g of segs) {
      const t = Math.max(0, Math.min(1, ((px - g.ax) * g.vx + (pz - g.az) * g.vz) / g.l2));
      const d = Math.hypot(px - g.ax - g.vx * t, pz - g.az - g.vz * t);
      if (d < bd) { bd = d; best = g; bs = g.dx * (pz - g.az) - g.dz * (px - g.ax) < 0 ? -1 : 1; }
    }
    const k = (j * nx + i) * 4;
    data[k] = h(bs * Math.min(bd, 8)); data[k + 1] = h(best.dx); data[k + 2] = h(best.dz); data[k + 3] = h(1);
  }
  const tex = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  const map = { tex, x0, z0, nx, nz };
  laneMaps.set(lanes, map);
  return map;
}
// the lane at the fragment: x the distance across its middle line (signed, wavering a little along it), yz its
// direction, w how much of the close-up detail applies (on the lane's bare earth, `earth`, faded out towards
// LANE_NEAR)
const laneFrame = (map, dist, earth) => Fn(() => {
  const L = texture(map.tex, wp.xz.sub(vec2(map.x0, map.z0)).add(0.5).div(vec2(map.nx, map.nz)));
  const dir = normalize(L.yz);
  const along = dot(wp.xz, dir);
  const s = L.x.add(vnoise(vec2(along.mul(0.18), 3.0)).sub(0.5).mul(0.22));
  return vec4(s, dir, sstep(1.7, 1.0, L.x.abs()).mul(earth).mul(sstep(LANE_NEAR, LANE_NEAR * 0.6, dist)));
})();
// small stones: a jittered grid of cells (`scale` m), the share over `share` holding a stone; x: inside it (0 at its
// edge), y: its tone, zw: the way out from its middle (the dome's slope)
const laneStones = (p, scale, seed, share) => {
  const q = p.div(scale).toVar(), id = floor(q).toVar(), f = fract(q).toVar();
  const d1 = float(8.0).toVar(), tone = float(0).toVar(), off = vec2(0).toVar();
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const c = id.add(vec2(i, j));
    const o = vec2(hash12(c.add(seed)), hash12(c.add(seed + 37.1))).mul(0.7).add(0.15);
    const v = vec2(i, j).add(o).sub(f), d = dot(v, v);
    If(d.lessThan(d1), () => { d1.assign(d); tone.assign(hash12(c.add(seed + 71.3))); off.assign(v.negate()); });
  }
  const r = tone.mul(0.3).add(0.12), d = d1.sqrt();
  const has = sstep(share, float(share).add(0.05), tone.mul(7.31).fract());
  return vec4(sstep(r, r.mul(0.55), d).mul(has), tone, off.div(r).mul(has).mul(sstep(r, r.mul(0.8), d)));
};
// the ruts: two shallow hollows 0.6 m either side of the middle (a height in m, and its slope across the lane)
const rutDepth = 0.05, rutAt = 0.6, rutW = 0.2;
const rut = (s) => exp(s.abs().sub(rutAt).div(rutW).pow(2.0).negate());
const rutSlope = (s) => { const u = s.abs().sub(rutAt).div(rutW); return u.mul(rut(s)).mul(2.0 * rutDepth / rutW).mul(sign(s)); };
// the lane's pebbles, a few centimetres across, their outlines warped so they aren't round: a third of the cells hold
// one, kicked to the verges and the crown between the ruts, few in the ruts and down the middle where the feet go
const lanePebbles = (s) => {
  const p = wp.xz.add(vec2(vnoise(wp.xz.mul(31.0)), vnoise(wp.xz.mul(31.0).add(7.0))).sub(0.5).mul(0.035));
  return laneStones(p, 0.09, 17.0, mix(0.66, 0.9, rut(s).max(sstep(0.35, 0.0, s.abs()).mul(0.7))));
};
// the colour of the lane's earth close by, over `c` (the vertex colour's dirt)
const laneColor = (map, dist, earth, c) => Fn(() => {
  const o = c.toVar();
  const F = laneFrame(map, dist, earth);
  If(F.w.greaterThan(0.0), () => {
    const s = F.x, k = F.w, along = dot(wp.xz, F.yz);
    // grit: specks a few centimetres across, lighter and darker, gone before they would shimmer
    const grit = laneStones(wp.xz, 0.03, 5.0, vnoise(wp.xz.mul(2.3)).mul(0.5).add(0.3));
    const speck = grit.x.mul(grit.y.sub(0.5)).mul(0.35).mul(sstep(12.0, 6.0, dist));
    // the earth trodden in streaks along the lane, the ruts' packed earth a shade darker
    const streak = vnoise(vec2(along.mul(0.6), s.mul(2.5))).sub(0.5).mul(0.2);
    const ground = o.mul(speck.add(streak).add(1.0)).mul(float(1.0).sub(rut(s).mul(0.16)));
    // the pebbles: the earth's own browns, some greyed, each its own shade: most a little darker than the earth, about
    // one in eight lighter (the sun on their domes, laneNormal, does the rest)
    const st = lanePebbles(s);
    const shade = mix(0.5, 0.85, st.y).add(sstep(0.84, 0.9, st.y).mul(0.25));
    const stone = mix(o, vec3(dot(o, vec3(0.3, 0.6, 0.1))), st.y.mul(13.7).fract().mul(0.35)).mul(shade);
    o.assign(mix(o, mix(ground, stone, st.x.mul(0.8)), k));
  });
  return o;
})();
// the ground's normal in view space, tilted on the lanes close by by the ruts' sides and the pebbles' domes
const laneNormal = (map, dist, earth) => Fn(() => {
  const n = normalView.toVar();
  If(dist.lessThan(LANE_NEAR), () => {
    const F = laneFrame(map, dist, earth);
    If(F.w.greaterThan(0.0), () => {
      const s = F.x, across = vec2(F.z.negate(), F.y); // (the gradient of s)
      const t = across.mul(rutSlope(s).negate()).add(lanePebbles(s).zw.mul(1.1)).mul(F.w);
      n.assign(normalize(n.add(cameraViewMatrix.mul(vec4(t.x, 0.0, t.y, 0.0)).xyz)));
    });
  });
  return n;
})();

// The ground, with puddles on the bare earth in the rain (mirroring `sky`, its uniforms). With `paddies` it draws the
// farmland's and the village's mesh (world.js buildFields), where flooded paddies (aWater) are still water too. With
// `lanes` (world.js LANES) the lanes close by gain their grit, stones and ruts.
export function terrainMaterial({ sky, paddies = false, lanes = null }) {
  const n09 = vnoise(wp.xz.mul(0.9)), n012 = vnoise(wp.xz.mul(0.12));
  const dn = n09.mul(0.5).add(vnoise(wp.xz.mul(3.7)).mul(0.3)).add(n012.mul(0.45));
  // where grass grows (aGround: density, length, tint, as grass.js reads them) the ground takes the grass's colour:
  // the shade at the blades' roots close by, the sward's average further out, where the blades thin to nothing
  const gr = attribute('aGround', 'vec3');
  const dist = wp.sub(cameraPosition).length();
  const far = sstep(12.0, 40.0, dist);
  // (not under the reeds by the water, grass.js: their ground keeps its mud and sand)
  const cover = clamp(gr.x.mul(1.4), 0.0, 1.0).mul(sstep(0.02, 0.12, gr.y)).mul(sstep(-0.1, 0.0, gr.z));
  const lane = lanes && laneMap(lanes);
  // (the lanes' detail only where the ground shows bare earth: the vertex colour's dirt, redder than green)
  const vcol = attribute('color', 'vec3'), earth = sstep(0.0, 0.035, vcol.r.sub(vcol.g)).mul(float(1.0).sub(cover));
  const colorNode = Fn(() => {
    // the blades' own patches; blade-scale streaks close by, faded out before they would shimmer
    const patch = patchFrom(n012, n09);
    const streak = float(0).toVar();
    If(dist.lessThan(40.0), () => { streak.assign(vnoise(wp.xz.mul(vec2(9.0, 6.0))).sub(0.5).mul(sstep(40.0, 12.0, dist)).mul(0.45)); });
    const carpet = grassColor(clamp(gr.z.add(patch.mul(0.12)), 0.0, 1.0), mix(0.5, 0.74, far).mul(patch.mul(0.12).add(1.0)).mul(streak.add(1.0)));
    const c = mix(attribute('color', 'vec3').mul(dn.mul(0.42).add(0.7)), carpet, cover).toVar();
    // the river's bed: rounded stones and gravel, each stone its own grey-brown, sand between, close by only
    If(wp.y.lessThan(0.08).and(dist.lessThan(60.0)), () => { c.assign(mix(c, riverBed(wp.xz, c), sstep(0.08, -0.06, wp.y).mul(sstep(60.0, 35.0, dist)))); });
    // the lanes underfoot
    if (lane) If(dist.lessThan(LANE_NEAR), () => { c.assign(laneColor(lane, dist, earth, c)); });
    return c;
  })();
  const params = { roughness: 0.96, metalness: 0, colorNode };
  if (lane) params.normalNode = laneNormal(lane, dist, earth);
  return new LitMaterial(params, (out) => Fn(() => {
    // river-bed caustics and darkening under water: both are exactly zero / one above y = 0.03, so skip them there
    const y = wp.y;
    const o = out.toVar();
    If(y.lessThan(0.03), () => {
      const cp = wp.xz.mul(0.8), ct = U.uTime.mul(0.55);
      const c1 = vnoise(cp.add(vec2(ct, ct.mul(0.7))));
      const c2 = vnoise(cp.mul(1.37).sub(vec2(ct.mul(0.8), ct.mul(-0.5))).add(5.0));
      const cc = pow(float(1.0).sub(c1.sub(c2).abs()), 10.0);
      const cw = sstep(0.03, -0.3, y).mul(sstep(-2.6, -0.6, y));
      o.addAssign(diffuseColor.rgb.mul(U.uSunColor).mul(U.uSunVis).mul(cc).mul(cw).mul(2.2));
      o.mulAssign(mix(1.0, 0.75, sstep(0.0, -1.5, y)));
    });
    // the ground the water wets: a dark band a hand or two up from the waterline
    o.mulAssign(mix(1.0, 0.6, sstep(0.32, 0.06, y).mul(sstep(-0.12, 0.02, y))));
    // far grass as the blades are lit: the sun through their tips, and the wind's waves running over it
    const grassy = cover.mul(far);
    const back = pow(max(dot(normalize(wp.sub(cameraPosition)), U.uSunDir), 0.0), 3.0);
    o.addAssign(diffuseColor.rgb.mul(U.uSunColor).mul(U.uSunVis).mul(sunShadow).mul(back.mul(1.6).add(0.15)).mul(grassy).mul(0.5));
    o.mulAssign(float(1.0).add(grassWave(wp.xz).mul(U.uWind).mul(grassy).mul(0.3)));
    o.addAssign(diffuseColor.rgb.mul(lanternLight(wp)));
    // puddles on the lanes and yards once the rain has soaked the ground: in the hollows first, wider as it goes on
    If(U.uWet.greaterThan(0.3), () => {
      const n = vnoise(wp.xz.mul(0.55)).mul(0.6).add(vnoise(wp.xz.mul(1.9).add(4.0)).mul(0.4));
      const cut = mix(0.78, 0.63, sstep(0.3, 1.0, U.uWet));
      const puddle = sstep(cut, cut.add(0.03), n).mul(float(1.0).sub(cover)).mul(sstep(0.96, 0.99, normalWorld.y)).mul(sstep(0.2, 0.4, wp.y)).toVar();
      If(puddle.greaterThan(0.0), () => { o.assign(mix(o, paddyWater(sky), puddle)); });
    });
    if (paddies) {
      // (only where there is water: the levees, banks and dry paddies skip it)
      const wet = sstep(0.35, 0.65, attribute('aWater', 'float'));
      If(wet.greaterThan(0.0), () => { o.assign(mix(o, paddyWater(sky), wet)); });
    }
    return o;
  })());
}

// River stones: a jittered grid of cells, each a rounded stone of its own size and tone (nearest-two distances, so
// stones meet in crevices of sand), with finer gravel cells between; `under`: the ground's colour, tinting the sand.
const stones = (p, scale, seed) => {
  const q = p.div(scale).toVar(), id = floor(q).toVar(), f = fract(q).toVar();
  const d1 = float(8.0).toVar(), d2 = float(8.0).toVar(), tone = float(0).toVar();
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const c = id.add(vec2(i, j));
    const o = vec2(hash12(c.add(seed)), hash12(c.add(seed + 37.1))).mul(0.8).add(0.1);
    const v = vec2(i, j).add(o).sub(f), d = dot(v, v);
    If(d.lessThan(d1), () => { d2.assign(d1); d1.assign(d); tone.assign(hash12(c.add(seed + 71.3))); }).ElseIf(d.lessThan(d2), () => { d2.assign(d); });
  }
  // x: inside the stone (0 at its edge), y: its tone
  return vec2(sstep(0.0, 0.35, d2.sqrt().sub(d1.sqrt())), tone);
};
const riverBed = (xz, under) => {
  // the cells' grid warped by a broad noise so stones don't line up in rows
  const w = xz.add(vec2(vnoise(xz.mul(1.3)), vnoise(xz.mul(1.3).add(9.0))).mul(0.18));
  const big = stones(w, 0.24, 3.0), small = stones(w, 0.07, 11.0);
  const sand = mix(under, vec3(0.26, 0.23, 0.17), 0.6);
  const tone = (t) => mix(mix(vec3(0.17, 0.165, 0.155), vec3(0.3, 0.26, 0.2), t), vec3(0.12, 0.15, 0.1), sstep(0.7, 0.95, t));
  const gravel = mix(sand, tone(small.y), small.x.mul(0.55));
  // only some cells hold a stone; the rest is gravel and sand
  const has = sstep(0.45, 0.6, big.y.fract().mul(7.31).fract());
  return mix(gravel, tone(big.y).mul(big.x.mul(0.35).add(0.75)), sstep(0.0, 0.2, big.x).mul(has));
};

// a flooded paddy: muddy water a hand deep, mirroring the sky (the far hills a dark band along the horizon), wind
// ripples, the sun's glint
const paddyWater = (sky) => Fn(() => {
  const { uZenith, uHorizon } = sky.uniforms;
  const t = U.uTime, p = wp.xz;
  const drift = U.uWindDir.mul(t.mul(0.35));
  const amp = U.uWind.mul(0.1).add(0.015).add(U.uRain.mul(0.08));
  const nx = vnoise(p.mul(2.1).sub(drift)).add(vnoise(p.mul(5.3).add(drift.mul(1.7))).mul(0.5)).sub(0.75);
  const nz = vnoise(p.mul(2.1).add(13.0).sub(drift)).add(vnoise(p.mul(5.3).add(7.0).add(drift.mul(1.7))).mul(0.5)).sub(0.75);
  const dist = wp.sub(cameraPosition).length();
  const N = normalize(vec3(nx.mul(amp).mul(sstep(120.0, 20.0, dist)), 1.0, nz.mul(amp).mul(sstep(120.0, 20.0, dist))));
  const V = normalize(cameraPosition.sub(wp));
  const R = reflect(V.negate(), N);
  // (a hand of muddy water scatters the sky too: no darker than this from above)
  const fres = float(0.07).add(pow(max(float(1.0).sub(max(dot(N, V), 0.0)), 0.0), 5.0).mul(0.93));
  const skyC = mix(uZenith, uHorizon, pow(float(1.0).sub(clamp(R.y, 0.0, 1.0)), 4.0)).toVar();
  skyC.assign(mix(skyC, mix(U.uSkyAmb.mul(0.35), U.uFogColor, 0.35), sstep(0.16, 0.03, R.y)));
  // (the light floor follows the sky's: dark at night, not a pale slab)
  const light = U.uSunVis.mul(0.65).add(dot(U.uSkyAmb, vec3(0.3, 0.6, 0.1)).mul(0.8));
  const body = vec3(0.12, 0.11, 0.075).mul(light).add(U.uSkyAmb.mul(0.05));
  const col = mix(body, skyC, clamp(fres.mul(1.1), 0.0, 1.0)).toVar();
  const sd = max(dot(R, U.uSunDir), 0.0);
  col.addAssign(U.uSunColor.mul(U.uSunVis).mul(pow(sd, 600.0).mul(6.0).add(pow(sd, 60.0).mul(0.3))));
  return col.add(lanternLight(wp).mul(0.3));
})();

// light thrown back by the sunlit ground onto faces turned sideways or down, at full strength once the sun is a little
// above the horizon: a wall in shade stays warm grey rather than going the blue of the sky light alone
export const groundBounce = () => U.uSunColor.mul(U.uSunVis).mul(sstep(0.0, 0.35, U.uSunDir.y)).mul(float(0.5).sub(normalWorld.y.mul(0.5))).mul(vec3(0.34, 0.36, 0.24));
// By day the hemisphere's sky light is the zenith's deep blue (main.js: uSkyAmb × 1.25 at about 0.77 strength by
// day, so about uSkyAmb). A wall in shade mixes it with the ground's light and groundBounce; stone in shade facing up
// sees nothing else and comes out navy. Added times the albedo, this pulls the sky's light on faces turned up most of
// the way to its own grey, keeping its brightness and a hint of its blue.
const skyToGrey = () => vec3(dot(U.uSkyAmb, vec3(0.3, 0.6, 0.1))).sub(U.uSkyAmb)
  .mul(max(normalWorld.y, 0.0).mul(sstep(0.0, 0.35, U.uSunDir.y)).mul(0.8 / Math.PI));

export function barkMaterial(map, bumpMap) {
  return new LitMaterial({
    map, bumpMap, bumpScale: 0.5, vertexColors: true, roughness: 0.78, metalness: 0, color: new THREE.Color(1.9, 1.75, 1.75),
    positionNode: windPosition(attribute('aFlex', 'float')), receivedShadowPositionNode: windShadowPosition(),
  }, (out) => Fn(() => {
    const vvB = viewDir();
    const rimB = pow(max(float(1.0).sub(max(dot(normalView, normalize(cameraViewMatrix.mul(vec4(vvB, 0.0)).xyz)), 0.0)), 0.0), 3.0);
    const o = out.add(U.uSunColor.mul(U.uSunVis).mul(rimB).mul(pow(max(dot(vvB.negate(), U.uSunDir), 0.0), 2.0)).mul(0.35).mul(diffuseColor.rgb).mul(4.0));
    return o.add(diffuseColor.rgb.mul(U.uSkyAmb.mul(0.15).add(groundBounce()))).add(diffuseColor.rgb.mul(lanternLight(wp)));
  })());
}

const flowerUV = () => uv().mul(0.5).add(attribute('aAtlas', 'vec2'));

// a flower's light: the sun through the petals, and the lanterns below lighting them from underneath (and through)
const blossomLight = (out) => Fn(() => {
  const vdirB = normalize(wp.sub(cameraPosition));
  const backB = pow(max(dot(vdirB, U.uSunDir), 0.0), 2.5);
  const sunB = mix(U.uSunColor, vec3(dot(U.uSunColor, vec3(0.33))), 0.45);
  // petals are thin: the sun on their far side shines through them, warm and a little more saturated
  const sunV = normalize(cameraViewMatrix.mul(vec4(U.uSunDir, 0.0)).xyz);
  const through = max(dot(normalView, sunV).negate(), 0.0).mul(1.0);
  const o = out.add(diffuseColor.rgb.mul(sunB).mul(U.uSunVis).mul(sunShadow).mul(backB.mul(1.2).add(0.1).add(through))).toVar();
  // light scattered inside the crown keeps the shade pink: the blue sky light alone turns it lilac grey
  const lum = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));
  o.assign(mix(o, diffuseColor.rgb.mul(lum(o).div(max(lum(diffuseColor.rgb), 1e-3))), 0.7));
  return o.add(diffuseColor.rgb.mul(vec3(0.16).add(U.uSkyAmb.mul(0.1)))).add(diffuseColor.rgb.mul(lanternLight(wp)).mul(1.6));
})();

// lit as the crown: the flower's own normal bent towards the crown's outward one (aCanopyN) by `bend`
const blossomLit = (bend, params) => {
  const canopyNormal = normalize(mix(normalize(normalLocal), attribute('aCanopyN', 'vec3'), bend));
  return new LitMaterial({
    side: THREE.DoubleSide, roughness: 0.72, metalness: 0, ...params,
    positionNode: windPosition(attribute('aFlex', 'float'), null, canopyNormal), receivedShadowPositionNode: windShadowPosition(),
    // back faces flip like any double-sided normal (the old 'noFlip' patch never matched the unexpanded chunk)
    normalNode: transformNormalToView(canopyNormal).toVarying('vCanopyNormal').normalize().mul(faceDirection),
  }, blossomLight);
};

export function blossomMaterial(atlas, alphaToCoverage) {
  return blossomLit(0.6, { colorNode: texture(atlas, flowerUV()), alphaTest: 0.4, alphaToCoverage });
}

// the modelled flower drawn near the camera (src/blossoms.js): its own vertex colours, its shape in the light
export function blossomModelMaterial() {
  return blossomLit(0.4, { vertexColors: true });
}

// depth prepass for the flowers: the canopy has heavy overdraw, so its depth goes down first with only the
// atlas alpha, and the lit pass (depthWrite off) then shades just the visible fragment. Pushed back by a few depth
// units (constant, not slope-scaled: the cards cluster nearly coplanar) so the lit pass's own depth never fails
// against it if the two vertex shaders round differently; with no offset the result is pixel-identical here.
export function blossomDepthMaterial(atlas, alphaToCoverage) {
  return new THREE.MeshBasicNodeMaterial({
    colorNode: texture(atlas, flowerUV()),
    alphaTest: 0.4, side: THREE.DoubleSide, alphaToCoverage, fog: false, colorWrite: false,
    polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: 4,
    positionNode: windPosition(attribute('aFlex', 'float')),
  });
}

// shadow-only stand-in for the flowers (layer 2, see main.js)
export function blossomShadowMaterial(atlas) {
  return new THREE.MeshBasicNodeMaterial({
    colorNode: texture(atlas, flowerUV()), alphaTest: 0.4, side: THREE.DoubleSide, fog: false,
    positionNode: windPosition(attribute('aFlex', 'float')),
  });
}

export function grassMaterial() {
  const aFlex = attribute('aFlex', 'float');
  const vWave = varyingProperty('float', 'vWave');
  const position = windPosition(aFlex, (p) => {
    const wave = sin01(U.uTime.mul(1.9).sub(dot(p.xz, U.uWindDir).mul(0.22)).add(p.x.mul(0.05).sin().mul(1.5))).toVar();
    wave.assign(wave.mul(wave));
    p.addAssign(vec3(U.uWindDir.x, -0.35, U.uWindDir.y).mul(aFlex).mul(U.uWind).mul(wave).mul(0.55));
    vWave.assign(wave.mul(U.uWind));
  });
  return new LitMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, positionNode: position, receivedShadowPositionNode: windShadowPosition() }, (out) => Fn(() => {
    const vdir = normalize(wp.sub(cameraPosition));
    const back = pow(max(dot(vdir, U.uSunDir), 0.0), 3.0);
    const tip = aFlex; // fragment-stage attribute becomes a varying
    const o = out.add(diffuseColor.rgb.mul(U.uSunColor).mul(U.uSunVis).mul(sunShadow).mul(back.mul(1.6).add(0.15)).mul(clamp(tip.mul(2.2), 0.0, 1.0)));
    // lantern light at half strength: at full, the lawn under the lines read as floodlit
    return o.mul(float(1.0).add(vWave.mul(clamp(tip.mul(2.0), 0.0, 1.0)).mul(0.35))).add(diffuseColor.rgb.mul(lanternLight(wp)).mul(0.5));
  })());
}
const sin01 = (x) => x.sin().mul(0.5).add(0.5);

export function flowerMaterial() {
  return new LitMaterial({ roughness: 0.7, side: THREE.DoubleSide, positionNode: windPosition(attribute('aFlex', 'float')), receivedShadowPositionNode: windShadowPosition() });
}

export function rockMaterial() {
  const wet = sstep(0.28, -0.05, wp.y);
  return new LitMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0,
    colorNode: vec3(mix(1.0, 0.5, wet).mul(vnoise(wp.xz.mul(3.0).add(wp.y.mul(2.0))).mul(0.3).add(0.85))),
  }, (out) => Fn(() => {
    // (as in the original: view-space normal against world-space vectors)
    const vv = viewDir();
    return out.add(U.uSunColor.mul(U.uSunVis).mul(pow(max(dot(reflect(U.uSunDir.negate(), normalView), vv), 0.0), 24.0)).mul(wet).mul(0.25)).add(diffuseColor.rgb.mul(lanternLight(wp).add(groundBounce())));
  })());
}

// the woods' trees (tools/forest.py, the bamboo too). With `leaves` (the leaf atlas, vegetation.js paintLeafAtlas) it
// draws the near trees' leaf cards: cut out of the atlas, lit by the crown's normal on both faces (the cards are
// tilted every way; their own would light them in patches), worn away over the 20 m before `impostorFrom`, where the
// trees turn to impostors (main.js IMPOSTOR_FROM, times the tier's lodScale)
export function forestMaterial({ leaves = null, alphaToCoverage = false, impostorFrom = 140 } = {}) {
  const tone = vec3(vnoise(wp.xz.mul(0.5).add(wp.y)).mul(0.4).add(0.8));
  const params = !leaves ? { colorNode: tone } : {
    colorNode: texture(leaves, uv()).mul(vec4(tone, 1.0)), side: THREE.DoubleSide, alphaToCoverage,
    alphaTestNode: sstep(impostorFrom - 20, impostorFrom, wp.sub(cameraPosition).length()).mul(0.55).add(0.45),
    normalNode: transformNormalToView(normalLocal).normalize(),
  };
  return new LitMaterial({ vertexColors: true, roughness: 1, ...params }, forestLight());
}
// wild cherries in flower (the only crowns this red) glow like the main tree's blossoms, so their shaded side stays
// pink instead of turning lilac under the blue sky light (`shadow`: the sun's shadow as the material looks it up)
export const forestLight = (shadow = sunShadow) => (out) => Fn(() => {
  const bloom = sstep(0.45, 0.7, diffuseColor.r);
  const backB = pow(max(dot(normalize(wp.sub(cameraPosition)), U.uSunDir), 0.0), 2.5);
  const sunB = mix(U.uSunColor, vec3(dot(U.uSunColor, vec3(0.33))), 0.45);
  return out.add(diffuseColor.rgb.mul(sunB.mul(U.uSunVis).mul(shadow).mul(backB.mul(1.2).add(0.1)).add(skyGlow())).mul(bloom));
})();

// the blossoms' own glow on the woods' wild cherries and the shrubs: as bright as the sky's light (0.16 by day), so at
// night, away from the lamps, they go dark with the rest of the woods
const skyGlow = () => vec3(dot(U.uSkyAmb, vec3(0.3, 0.6, 0.1)).mul(0.36)).add(U.uSkyAmb.mul(0.1));

// the shrubs (tools/shrubs.py): leaves in the vertex colours, and how much is in flower and which flower in their
// alpha ((kind + share) / 4: 1 azalea magenta, 2 white, 3 kerria yellow). Close by the flowers are small spots (two
// octaves of noise over the shrub), further off the leaves' and flowers' average, before the spots would shimmer;
// lit through like the blossom (forestMaterial).
export function shrubMaterial() {
  const col = attribute('color', 'vec4');
  const colorNode = Fn(() => {
    const code = col.a.mul(4.0), kind = floor(code.add(0.03)), share = clamp(code.sub(kind), 0.0, 1.0);
    const leaf = col.rgb.toVar();
    If(kind.greaterThan(0.5), () => {
      const fc = select(kind.lessThan(1.5), vec3(0.62, 0.07, 0.26), select(kind.lessThan(2.5), vec3(0.74, 0.73, 0.67), vec3(0.75, 0.5, 0.03)));
      const flower = fc.mul(clamp(dot(col.rgb, vec3(0.3, 0.6, 0.1)).mul(10.0), 0.3, 1.0));
      const q = vec2(wp.x.add(wp.y.mul(0.7)), wp.z.sub(wp.y.mul(0.6)));
      const n = vnoise(q.mul(9.0)).mul(0.6).add(vnoise(q.mul(23.0).add(7.0)).mul(0.4));
      // the noise sits round 0.5: the cut moves down as the share rises
      const cut = mix(0.7, 0.3, share);
      const spot = sstep(cut.sub(0.07), cut.add(0.07), n);
      const f = mix(spot, share.mul(0.8), sstep(10.0, 30.0, wp.sub(cameraPosition).length()));
      leaf.assign(mix(leaf, flower, f));
    });
    return leaf;
  })();
  return new LitMaterial({ roughness: 1, colorNode }, (out) => Fn(() => {
    const bloom = sstep(0.45, 0.7, diffuseColor.r);
    const backB = pow(max(dot(normalize(wp.sub(cameraPosition)), U.uSunDir), 0.0), 2.5);
    const sunB = mix(U.uSunColor, vec3(dot(U.uSunColor, vec3(0.33))), 0.45);
    return out.add(diffuseColor.rgb.mul(sunB.mul(U.uSunVis).mul(sunShadow).mul(backB.mul(1.2).add(0.1)).add(skyGlow())).mul(bloom).mul(0.6));
  })());
}

// the temple (temple.js). After dusk the hall's paper doors and the lanterns' fireboxes glow (aGlow: strength), the
// lanterns light what is near them, and floodlights in the gravel wash the pagoda from below (fading with height).
export function templeMaterial(d) {
  const pts = (a) => { const out = []; for (let i = 0; i < a.length; i += 3) out.push(vec3(a[i], a[i + 1], a[i + 2])); return out; };
  const lamps = pts(d.lamps), flood = pts(d.flood);
  const glow = attribute('aGlow', 'float');
  // age: grime streaks run down the walls from the eaves, damp at their feet, moss and lichen on what faces up
  const colorNode = Fn(() => {
    const c = attribute('color', 'vec3').mul(vnoise(wp.xz.mul(3.0).add(wp.y.mul(5.0))).mul(0.3).add(0.85)).toVar();
    const side = float(1.0).sub(normalWorld.y.abs());
    const streak = sstep(0.4, 0.95, vnoise(vec2(wp.x.add(wp.z).mul(2.3), wp.y.mul(0.22))));
    c.mulAssign(mix(1.0, 0.7, streak.mul(side)));
    c.mulAssign(mix(1.0, 0.8, sstep(1.2, 0.0, wp.y.sub(d.y)).mul(side)));
    const moss = sstep(0.45, 0.8, vnoise(wp.xz.mul(0.7)).mul(0.6).add(vnoise(wp.xz.mul(3.3)).mul(0.4))).mul(sstep(0.3, 0.8, normalWorld.y));
    c.assign(mix(c, vec3(0.16, 0.2, 0.09).mul(vnoise(wp.xz.mul(9.0)).mul(0.6).add(0.7)), moss.mul(0.6)));
    return c;
  })();
  // The temple's warm greys and whites (its stone, gravel, plaster, paper: warmer than blue and unsaturated; not the
  // roofs' cool grey tiles, the wood or the bronze), as the vertex colours have them
  const vc = attribute('color', 'vec3');
  const neutral = sstep(1.0, 1.06, vc.r.div(max(vc.b, 1e-3))).mul(sstep(0.4, 0.3, vc.r.sub(vc.b).div(max(vc.r, 1e-3))));
  return new LitMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide, colorNode }, (out) => Fn(() => {
    // the sunlit gravel and meadow light the walls and the eaves' undersides from below (as on rock)
    const o = out.add(diffuseColor.rgb.mul(groundBounce())).toVar();
    // the paving and the treads in shade grey, not navy
    o.addAssign(diffuseColor.rgb.mul(skyToGrey()).mul(neutral));
    If(U.uLights.greaterThan(0.0), () => {
      const near = float(0).toVar(), up = float(0).toVar();
      for (const c of lamps) { const v = wp.sub(c); near.addAssign(float(1.0).div(dot(v, v).mul(1.5).add(0.3))); }
      for (const c of flood) { const v = c.sub(wp); const q = dot(v, v); up.addAssign(max(dot(normalWorld, v.div(q.sqrt())), 0.0).div(q.mul(1 / 180).add(1.0))); }
      const flicker = sin(U.uTime.mul(9.0).add(wp.x.mul(3.7))).mul(0.08).add(0.92);
      o.addAssign(diffuseColor.rgb.mul(U.uLightColor.mul(near.mul(flicker).mul(0.6)).add(vec3(1.0, 0.82, 0.6).mul(up).mul(0.55))).mul(U.uLights));
      o.addAssign(vec3(1.0, 0.62, 0.3).mul(glow).mul(U.uLights).mul(mix(1.0, flicker, sstep(1.5, 2.0, glow))));
    });
    return o;
  })());
}

// the village's buildings (village.js): vertex colours with how much each part glows after dusk in their alpha (the
// shoji, lit from inside); not every room is lit, and the light flickers a little as a lamp's would. The door
// lanterns light the walls near them.
export function villageMaterial() {
  const col = attribute('color', 'vec4');
  return new LitMaterial({ roughness: 0.85, metalness: 0, colorNode: col.rgb }, (out) => Fn(() => {
    const o = out.add(diffuseColor.rgb.mul(groundBounce())).toVar();
    If(U.uLights.greaterThan(0.0), () => {
      const room = sstep(0.22, 0.36, vnoise(wp.xz.mul(0.45).add(wp.y.mul(0.3))));
      const flicker = sin(U.uTime.mul(7.0).add(wp.x.mul(1.3))).mul(0.05).add(0.95);
      o.addAssign(vec3(1.0, 0.64, 0.32).mul(col.a).mul(room.mul(0.8).add(0.2)).mul(flicker).mul(U.uLights).mul(0.85));
      o.addAssign(diffuseColor.rgb.mul(lanternLight(wp)));
    });
    return o;
  })());
}

// the riverside's lamps (lanterns.js, Blender models): vertex colours with how much each part glows after dusk in
// their alpha (the bonbori's paper, the fire baskets' coals), glowing in their own colour; lit by the lamps near them.
// The river boats (boat.js) too, with nothing glowing
export function lampMaterial() {
  const col = attribute('color', 'vec4');
  return new LitMaterial({ roughness: 0.8, metalness: 0, colorNode: col.rgb }, (out) => Fn(() => {
    const o = out.add(diffuseColor.rgb.mul(groundBounce())).toVar();
    If(U.uLights.greaterThan(0.0), () => {
      const flicker = sin(U.uTime.mul(8.0).add(wp.x.mul(2.3))).mul(0.06).add(0.94);
      o.addAssign(diffuseColor.rgb.mul(lanternLight(wp)));
      o.addAssign(col.rgb.mul(vec3(1.0, 0.78, 0.5)).mul(col.a).mul(U.uLights).mul(flicker).mul(1.6));
    });
    return o;
  })());
}

// the wayside's stones (wayside.js, Blender models): vertex colours; their grey stone and wood in shade grey rather
// than the sky's navy (as the temple's stone), not the red cloth, the copper or the vermilion; lit by the lamps near
// them after dusk
export function waysideMaterial() {
  const col = attribute('color', 'vec3');
  const hi = max(max(col.r, col.g), col.b), lo = min(min(col.r, col.g), col.b);
  const neutral = sstep(0.45, 0.3, hi.sub(lo).div(max(hi, 1e-3)));
  return new LitMaterial({ roughness: 0.85, metalness: 0, colorNode: col }, (out) => Fn(() => {
    const o = out.add(diffuseColor.rgb.mul(groundBounce())).toVar();
    o.addAssign(diffuseColor.rgb.mul(skyToGrey()).mul(neutral));
    If(U.uLights.greaterThan(0.0), () => {
      o.addAssign(diffuseColor.rgb.mul(lanternLight(wp)));
    });
    return o;
  })());
}

// the stone lanterns up the temple's approach (village.js): the temple's weathered stone, its paper fireboxes
// glowing after dusk (aGlow) and lighting the stone round them
export function stoneLanternMaterial() {
  const glow = attribute('aGlow', 'float');
  const colorNode = Fn(() => {
    const c = attribute('color', 'vec3').mul(vnoise(wp.xz.mul(3.0).add(wp.y.mul(5.0))).mul(0.3).add(0.85)).toVar();
    const moss = sstep(0.45, 0.8, vnoise(wp.xz.mul(2.1).add(wp.y)).mul(0.7).add(normalWorld.y.mul(0.3)));
    c.assign(mix(c, vec3(0.16, 0.2, 0.09), moss.mul(0.5)));
    return c;
  })();
  return new LitMaterial({ roughness: 0.8, metalness: 0, colorNode }, (out) => Fn(() => {
    const o = out.add(diffuseColor.rgb.mul(groundBounce())).toVar();
    If(U.uLights.greaterThan(0.0), () => {
      const flicker = sin(U.uTime.mul(9.0).add(wp.x.mul(3.7))).mul(0.08).add(0.92);
      o.addAssign(diffuseColor.rgb.mul(lanternLight(wp)));
      o.addAssign(vec3(1.0, 0.62, 0.3).mul(glow).mul(U.uLights).mul(flicker));
    });
    return o;
  })());
}

// the bridge: prop material lit by its own lanterns after dusk (a sum over their centres, skipped by day)
export function bridgeMaterial(hang) {
  const lamps = [];
  for (let i = 0; i < hang.length; i += 3) lamps.push(vec3(hang[i], hang[i + 1] - 0.36, hang[i + 2]));
  // the piles darker and greener where the river wets them
  const wet = sstep(0.45, 0.0, wp.y);
  const colorNode = mix(vec3(vnoise(wp.xz.mul(4.0).add(wp.y.mul(6.0))).mul(0.24).add(0.88)), vec3(0.45, 0.55, 0.42), wet);
  return new LitMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, side: THREE.DoubleSide, colorNode }, (out) => Fn(() => {
    const glow = float(0).toVar();
    If(U.uLights.greaterThan(0.0), () => {
      for (const c of lamps) { const d = positionWorld.sub(c); glow.addAssign(float(1.0).div(dot(d, d).mul(3.0).add(0.25))); }
    });
    // the sunlit water and banks light the girders' sides and the arch's underside (groundBounce, as on rock)
    return out.add(diffuseColor.rgb.mul(U.uLightColor.mul(U.uLights).mul(glow).mul(0.45).add(groundBounce())));
  })());
}

export function fujiMaterial() {
  return new LitMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, colorNode: vec3(vnoise(wp.xz.mul(0.05)).mul(0.2).add(0.9)) }, (out) => Fn(() => {
    // snow picks up sky light (cool) and alpenglow
    const snowAmt = sstep(0.6, 0.85, diffuseColor.b);
    const o = out.add(diffuseColor.rgb.mul(U.uSkyAmb).mul(snowAmt).mul(0.35));
    const sunV = normalize(cameraViewMatrix.mul(vec4(U.uSunDir, 0.0)).xyz);
    return o.add(diffuseColor.rgb.mul(U.uSunColor).mul(U.uSunVis).mul(snowAmt).mul(0.18).mul(pow(max(dot(normalView, sunV), 0.0), 0.6)));
  })());
}

// bench-only stress objects: default lighting with the scene fog
export function stressObjectMaterial(color, roughness, metalness) {
  return new LitMaterial({ color, roughness, metalness });
}
