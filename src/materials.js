// Lit materials for the scene, as TSL node materials. Each reproduces the math of the GLSL
// onBeforeCompile patch it replaces (see git history of src/shaders.js).
import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, mix, max, pow, dot, normalize, clamp, reflect, texture, uv, attribute, varyingProperty, floor, select,
  cameraPosition, cameraViewMatrix, positionWorld, normalView, normalWorld, normalLocal, diffuseColor, sin,
  transformNormalToView, faceDirection,
} from 'three/tsl';
import { U, vnoise, sstep, LitMaterial, windPosition, windShadowPosition, lanternLight } from './tsl.js';
import { grassColor, grassWave, patchFrom } from './grass.js';
import { sunShadow } from './sunshadow.js';

const wp = positionWorld;
const viewDir = () => normalize(cameraPosition.sub(wp));

// The ground, with puddles on the bare earth in the rain (mirroring `sky`, its uniforms). With `paddies` it draws the
// farmland's and the village's mesh (world.js buildFields), where flooded paddies (aWater) are still water too.
export function terrainMaterial({ sky, paddies = false }) {
  const n09 = vnoise(wp.xz.mul(0.9)), n012 = vnoise(wp.xz.mul(0.12));
  const dn = n09.mul(0.5).add(vnoise(wp.xz.mul(3.7)).mul(0.3)).add(n012.mul(0.45));
  // where grass grows (aGround: density, length, tint, as grass.js reads them) the ground takes the grass's colour:
  // the shade at the blades' roots close by, the sward's average further out, where the blades thin to nothing
  const gr = attribute('aGround', 'vec3');
  const dist = wp.sub(cameraPosition).length();
  const far = sstep(12.0, 40.0, dist);
  // (not under the reeds by the water, grass.js: their ground keeps its mud and sand)
  const cover = clamp(gr.x.mul(1.4), 0.0, 1.0).mul(sstep(0.02, 0.12, gr.y)).mul(sstep(-0.1, 0.0, gr.z));
  const colorNode = Fn(() => {
    // the blades' own patches; blade-scale streaks close by, faded out before they would shimmer
    const patch = patchFrom(n012, n09);
    const streak = float(0).toVar();
    If(dist.lessThan(40.0), () => { streak.assign(vnoise(wp.xz.mul(vec2(9.0, 6.0))).sub(0.5).mul(sstep(40.0, 12.0, dist)).mul(0.45)); });
    const carpet = grassColor(clamp(gr.z.add(patch.mul(0.12)), 0.0, 1.0), mix(0.5, 0.74, far).mul(patch.mul(0.12).add(1.0)).mul(streak.add(1.0)));
    return mix(attribute('color', 'vec3').mul(dn.mul(0.42).add(0.7)), carpet, cover);
  })();
  return new LitMaterial({ roughness: 0.96, metalness: 0, colorNode }, (out) => Fn(() => {
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
  const o = out.add(diffuseColor.rgb.mul(sunB).mul(U.uSunVis).mul(sunShadow).mul(backB.mul(1.2).add(0.1)));
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
// tilted every way; their own would light them in patches), worn away between 120 and 140 m, where the trees turn to
// impostors (main.js IMPOSTOR_FROM)
export function forestMaterial({ leaves = null, alphaToCoverage = false } = {}) {
  const tone = vec3(vnoise(wp.xz.mul(0.5).add(wp.y)).mul(0.4).add(0.8));
  const params = !leaves ? { colorNode: tone } : {
    colorNode: texture(leaves, uv()).mul(vec4(tone, 1.0)), side: THREE.DoubleSide, alphaToCoverage,
    alphaTestNode: sstep(120.0, 140.0, wp.sub(cameraPosition).length()).mul(0.55).add(0.45),
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
  return new LitMaterial({ roughness: 0.75, metalness: 0, side: THREE.DoubleSide, colorNode }, (out) => Fn(() => {
    // the sunlit gravel and meadow light the walls and the eaves' undersides from below (as on rock)
    const o = out.add(diffuseColor.rgb.mul(groundBounce())).toVar();
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
// their alpha (the bonbori's paper, the fire baskets' coals), glowing in their own colour; lit by the lamps near them
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
