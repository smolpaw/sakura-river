// Nobori: tall, narrow cloth banners on bamboo poles, in pairs by the torii, up the temple's approach and at the
// bridge's landings (src/gen/banners.js says where, builds the poles and paints the writing). Each cloth hangs from
// the cross-arm at the top of its pole and is tied down the pole by its loops; the free edge and the lower half move in
// the wind, the bottom corner most: in a light air a slow sway, in a breeze ripples running across and down it, in a
// gale it bellies out downwind and lifts. All of it in the vertex stage from the scene's running time, the normal from
// the displaced surface. White cotton under a vermilion band with black brush characters down it, or all vermilion
// with white ones; lit as a thin double-sided cloth (the sun shows through it from behind), darker when wet, lit by the
// lamps after dusk. One instanced draw for the cloths, one merged mesh for the poles; both cast shadows.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, sin, cos, max, clamp, mix, select, pow, normalize, dot, attribute, uv, texture, positionWorld, cameraPosition, transformNormalToView, diffuseColor } from 'three/tsl';
import { LitMaterial, U, sstep, lanternLight } from './tsl.js';
import { sunShadow } from './sunshadow.js';
import { groundBounce } from './materials.js';
import { BANNER, BANNER_INK, BANNER_TEXTS } from './gen/banners.js';

const NU = 8, NV = 24; // the cloth's grid

function clothGeometry(d) {
  const pos = [], tex = [], idx = [];
  for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) { pos.push(i / NU, j / NV, 0); tex.push(i / NU, j / NV); }
  for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
    const a = j * (NU + 1) + i, b = a + 1, c = a + NU + 1, e = c + 1;
    idx.push(a, c, b, b, c, e);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(tex, 2));
  g.setIndex(idx);
  g.setAttribute('aBase', new THREE.InstancedBufferAttribute(d.base, 4));
  g.setAttribute('aLook', new THREE.InstancedBufferAttribute(d.look, 4));
  g.instanceCount = d.n;
  return g;
}

function clothMaterial(ink) {
  const { W, H, GAP, DROP } = BANNER;
  const base = attribute('aBase', 'vec4'), look = attribute('aLook', 'vec4');
  const arm = vec3(sin(base.w), 0, cos(base.w)); // along the arm (yaw: 0 is +z)
  const n0 = vec3(arm.z, 0, arm.x.negate()); // the cloth's normal, unflipped (cross of its u and v tangents)
  const wd = vec3(U.uWindDir.x, 0, U.uWindDir.y);
  const wn = dot(wd, n0), wa = dot(wd, arm); // the wind across the cloth and along it
  const t = U.uTime.add(look.z);
  // the wind's strength here with its gusts (tsl.js windOffset), a wet cloth hanging heavier
  const gust = sin(U.uTime.mul(0.31).add(base.x.mul(0.015))).mul(sin(U.uTime.mul(0.19).add(1.3).add(base.z.mul(0.01)))).mul(0.45).add(0.55);
  const g = clamp(U.uWind.div(1.6), 0.0, 1.2).mul(gust.mul(0.6).add(0.55)).mul(float(1).sub(U.uWet.mul(0.3))).toVar();
  // the cloth at (u, v) (u from the tied edge, v down from the top) in the world
  const at = (u, v) => {
    const m = u.mul(pow(v, 1.2)); // held along the top and the tied edge: the bottom corner moves most
    const w1 = sin(u.mul(W * 7.0).add(v.mul(H * 1.7)).sub(t.mul(g.mul(6.0).add(3.2))));
    const w2 = sin(u.mul(W * 12.0).sub(v.mul(H * 2.4)).sub(t.mul(g.mul(8.5).add(4.7))).add(1.7));
    const idle = sin(t.mul(0.7)).mul(0.6).add(sin(t.mul(1.31).add(2.0)).mul(0.4));
    // out of its plane: bellied downwind, rippling, and a slow sway in still air
    const dn = m.mul(wn.mul(g).mul(1.1).add(w1.mul(g.mul(0.12).add(0.035))).add(w2.mul(g.mul(0.05).add(0.012))).add(idle.mul(0.03)));
    // drawn in towards the pole as it bellies (and pushed by a wind along it), never past it; and lifted, keeping its length
    const xu = u.mul(W).mul(clamp(float(1).sub(dn.mul(dn).mul(0.3 / (W * W))).add(wa.mul(g).mul(v).mul(0.12)), 0.6, 1.1)).add(GAP);
    const dy = dn.mul(dn).div(v.mul(2 * H).add(0.4)).min(v.mul(H * 0.7));
    return base.xyz.add(arm.mul(xu)).add(vec3(0, dy.sub(v.mul(H)).sub(DROP), 0)).add(n0.mul(dn));
  };
  const q = attribute('position', 'vec3'), e = 0.02;
  const p = at(q.x, q.y).toVar();
  const nw = normalize(at(q.x.add(e), q.y).sub(p).cross(at(q.x, q.y.add(e)).sub(p))).toVarying('vClothN');
  // the shadow lookup pushed off the cloth towards the sun (it casts too)
  const shadowPos = p.add(nw.mul(select(dot(nw, U.uSunDir).lessThan(0.0), -0.06, 0.06))).toVarying('vClothShadow');

  // ---------- the cloth's paint ----------
  const red = look.x.greaterThan(0.5);
  const paint = Fn(() => {
    const c = uv(), u = c.x, v = c.y;
    const white = vec3(0.86, 0.84, 0.77), verm = vec3(0.6, 0.07, 0.035), black = vec3(0.03, 0.025, 0.022);
    // the band at the top (on vermilion cloth a white line under it)
    const band = sstep(0.112, 0.104, v), line = sstep(0.104, 0.108, v).mul(sstep(0.124, 0.12, v));
    const cloth = select(red, mix(verm.mul(0.92), white, line), mix(white, verm, band)).toVar();
    // the writing down it, read the right way round on the front (the dye shows through, mirrored, on the back)
    const cu = u.sub(BANNER_INK.u0).div(BANNER_INK.u1 - BANNER_INK.u0), cv = v.sub(BANNER_INK.v0).div(BANNER_INK.v1 - BANNER_INK.v0);
    const inside = sstep(0.0, 0.01, cu).mul(sstep(1.0, 0.99, cu)).mul(sstep(0.0, 0.005, cv)).mul(sstep(1.0, 0.995, cv));
    const cuF = select(look.w.greaterThan(0.0), float(1).sub(cu), cu);
    const writing = texture(ink, vec2(look.y.add(clamp(cuF, 0.005, 0.995)).div(BANNER_TEXTS.length), clamp(cv, 0.002, 0.998))).r.mul(inside);
    cloth.assign(mix(cloth, select(red, white, black), writing));
    // the hems darker
    const hem = max(max(sstep(0.035, 0.0, u), sstep(0.965, 1.0, u)), max(sstep(0.008, 0.0, v), sstep(0.992, 1.0, v)));
    // wet cotton: darker and greyer
    const c2 = cloth.mul(float(1).sub(hem.mul(0.18)));
    return mix(c2, vec3(dot(c2, vec3(0.3, 0.6, 0.1))).mul(vec3(0.55, 0.56, 0.58)), U.uWet.mul(0.45));
  });
  const col = paint();
  // thin cotton: the sun through it from behind, the sky's light a little; the lamps' light after dusk
  const mat = new LitMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide }, (o) => Fn(() => {
    const N = normalize(nw).toVar();
    N.assign(select(dot(N, cameraPosition.sub(positionWorld)).lessThan(0.0), N.negate(), N));
    const back = max(dot(N, U.uSunDir).negate(), 0.0);
    const out = o.add(diffuseColor.rgb.mul(groundBounce())).add(diffuseColor.rgb.mul(U.uSunColor.mul(U.uSunVis).mul(sunShadow).mul(back).mul(0.55).add(U.uSkyAmb.mul(0.12))));
    return out.add(diffuseColor.rgb.mul(lanternLight(positionWorld)));
  })());
  mat.positionNode = p;
  mat.normalNode = Fn(() => {
    const N = normalize(nw).toVar();
    N.assign(select(dot(N, cameraPosition.sub(positionWorld)).lessThan(0.0), N.negate(), N));
    return transformNormalToView(N).normalize();
  })();
  mat.receivedShadowPositionNode = shadowPos;
  mat.colorNode = col;
  return mat;
}

// the poles: vertex colours, lit by the lamps after dusk
function poleMaterial() {
  return new LitMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 }, (o) => Fn(() => {
    return o.add(diffuseColor.rgb.mul(groundBounce())).add(diffuseColor.rgb.mul(lanternLight(positionWorld)));
  })());
}

// d: bannerData's result with its ink atlas (`ink`, paintBannerInk)
export function makeBanners(d) {
  const group = new THREE.Group();
  group.name = 'banners';
  const ink = new THREE.DataTexture(d.ink.data, d.ink.w, d.ink.h, THREE.RGBAFormat);
  ink.generateMipmaps = true; ink.minFilter = THREE.LinearMipmapLinearFilter; ink.magFilter = THREE.LinearFilter; ink.anisotropy = 4;
  ink.needsUpdate = true;
  const cloth = new THREE.Mesh(clothGeometry(d), clothMaterial(ink));
  cloth.name = 'bannerCloth';
  cloth.frustumCulled = false; // (placed in the vertex stage)
  cloth.castShadow = cloth.receiveShadow = true;
  const poles = new THREE.Mesh(d.poles, poleMaterial());
  poles.name = 'bannerPoles';
  poles.castShadow = poles.receiveShadow = true;
  group.add(cloth, poles);
  return { group, info: () => ({ n: d.n, sites: d.sites }) };
}
