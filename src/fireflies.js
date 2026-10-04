// Fireflies (Genji-botaru) after dusk: a few hundred drifting low over the flooded paddies and among the reeds along
// the river's banks, thickest by the cherry tree. Each wanders round its anchor on a slow path of summed sines and
// flashes about a second in every three to five, in step with its neighbours (each clump shares a rhythm, every one a
// little off it, now and then one skipping a flash). One instanced draw of camera-facing quads, a bright core in a
// soft halo, added onto the scene; everything moves in the vertex stage from the clock. On layer 0, so the river
// mirrors them. None by day, in rain or a strong wind (`update` hides the mesh).
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, attribute, sin, cos, floor, fract, exp, dot, max, length, normalize, mix, cameraPosition, positionGeometry } from 'three/tsl';
import { U, sstep, fogAmount } from './tsl.js';
import { mulberry32, smoothstep } from './noise.js';

// Anchors (on the main thread at create: a few milliseconds): per firefly aA = (x, y, z, wander radius), aB = (seed, blink offset s, blink
// period s, vertical wander). Clumps of 3-14 round centres picked from three sources: the banks by the cherry tree,
// the rest of the river's banks below the gorge, and the flooded paddies (inside a wet field, off its levees).
export function fireflyData(world, count) {
  const rng = mulberry32(4242);
  const a = new Float32Array(count * 4), b = new Float32Array(count * 4);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(6.2832 * rng());
  // a point on a bank: along the river at z, on a random side, from the shallows (t < 1: over the water, among the
  // reeds standing in it) up onto the bank
  const bank = (z) => {
    const t = 0.55 + rng() * 0.9, side = rng() < 0.5 ? -1 : 1;
    return [world.riverX(z) + side * world.riverHW(z) * t, z];
  };
  const wetAt = (x, z) => { const F = world.heightField(x, z).F; return !!(F && F.wet && F.inside && F.q > 0.6); };
  const fields = world.ZONES.filter((Z) => !Z.village);
  const area = fields.map((Z) => (Z.box[2] - Z.box[0]) * (Z.box[3] - Z.box[1])), total = area.reduce((s, v) => s + v, 0);
  const paddy = () => {
    for (let k = 0; k < 200; k++) {
      let r = rng() * total, i = 0;
      while (r > area[i]) r -= area[i++];
      const B = fields[i].box, x = B[0] + rng() * (B[2] - B[0]), z = B[1] + rng() * (B[3] - B[1]);
      // more of them nearer the river
      if (rng() < Math.exp(-Math.max(0, Math.abs(x - world.riverX(z)) - 20) / 70) && wetAt(x, z)) return [x, z, true];
    }
    return null;
  };
  // the ground (or the river's surface) under a wander's whole circle: its highest point
  const floorAt = (x, z, R) => {
    let y = Math.max(0, world.heightFast(x, z));
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * 6.2832;
      y = Math.max(y, world.heightFast(x + Math.cos(ang) * R, z + Math.sin(ang) * R));
    }
    return y;
  };
  let n = 0;
  while (n < count) {
    const pick = rng();
    let c;
    if (pick < 0.4) c = bank(Math.max(-95, 2 + gauss() * 32));
    else if (pick < 0.55) c = bank(-95 + rng() * 250);
    else c = paddy();
    if (!c) continue;
    const wet = c[2];
    const phase = rng() * 5, period = 3 + rng() * 1.8; // the clump's rhythm: about 1 s lit in every 3-5
    const size = 3 + Math.floor(rng() * 12);
    for (let j = 0; j < size && n < count; j++) {
      const sp = wet ? 4 : 2.6;
      let x = c[0] + gauss() * sp, z = c[1] + gauss() * sp;
      if (wet && !wetAt(x, z)) { x = c[0] + gauss() * 0.8; z = c[1] + gauss() * 0.8; }
      const R = 0.8 + rng() * 1.6, va = 0.12 + rng() * 0.25;
      const h = 0.2 + va + Math.pow(rng(), 1.1) * (1.6 - 2 * va); // 0.2 .. 2 m over the ground, more of them low
      a.set([x, floorAt(x, z, R) + h, z, R], n * 4);
      b.set([rng(), phase + (rng() - 0.5) * 0.5, period, va], n * 4);
      n++;
    }
  }
  return { a, b, n: count };
}

// `uFocal`: the scene pass's pixels per metre at 1 m (the lanterns'), to keep a far firefly a few pixels wide
export function makeFireflies(d, uFocal) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aA', new THREE.InstancedBufferAttribute(d.a, 4));
  geo.setAttribute('aB', new THREE.InstancedBufferAttribute(d.b, 4));
  geo.instanceCount = d.n;
  const A = attribute('aA', 'vec4'), B = attribute('aB', 'vec4'), k = positionGeometry;
  const uAmount = uniform(0);
  const t = U.uTime, s = B.x;
  // wandering: two slow sines on each axis (a loop of a few metres every minute or so) and a quicker small weave
  const w = s.mul(0.1).add(0.12);
  const wander = vec3(
    sin(t.mul(w).add(s.mul(37.0))).mul(0.65).add(sin(t.mul(w.mul(2.3)).add(s.mul(91.0))).mul(0.35)).mul(A.w),
    sin(t.mul(w.mul(1.7)).add(s.mul(53.0))).mul(B.w),
    cos(t.mul(w.mul(0.9)).add(s.mul(17.0))).mul(0.65).add(sin(t.mul(w.mul(1.9)).add(s.mul(29.0))).mul(0.35)).mul(A.w),
  );
  const weave = vec3(sin(t.mul(1.3).add(s.mul(71.0))), sin(t.mul(1.7).add(s.mul(13.0))).mul(0.5), cos(t.mul(1.1).add(s.mul(43.0)))).mul(0.07);
  const centre = A.xyz.add(wander).add(weave);
  // the flash: a soft rise, about a second lit, a slower fade; one cycle in six or so skipped (a dim one)
  const tc = t.add(B.y), cyc = floor(tc.div(B.z));
  const f = tc.sub(cyc.mul(B.z));
  const flash = sstep(0.0, 0.3, f).mul(sstep(1.25, 0.55, f));
  const skip = fract(sin(cyc.mul(12.9898).add(s.mul(78.233))).mul(43758.5)).lessThan(0.17).select(0.15, 1.0);
  const glow = flash.mul(skip).add(0.015);
  // the light: a core of about a centimetre in a halo of about 6 cm, each at least a pixel or a few across far off,
  // the light spread over them (the core's less than in full, so a far firefly stays a faint point)
  const dist = length(centre.sub(cameraPosition));
  const px = dist.div(uFocal); // metres per pixel there
  const coreR = max(float(0.012), px), haloR = max(float(0.06), px.mul(3.0));
  const half = haloR.mul(2.6);
  const energy = vec2(float(0.012).div(coreR), float(0.06).div(haloR).pow(2.0));
  // faded out as the camera comes within half a metre, and into the haze
  const level = uAmount.mul(glow).mul(sstep(0.3, 0.9, dist)).mul(float(1.0).sub(fogAmount(centre)));
  const dir = normalize(centre.sub(cameraPosition));
  const right = normalize(vec3(dir.z, 0.0, dir.x.negate()));
  const up = normalize(right.cross(dir)).negate();
  const vLevel = vec4(level, energy, coreR.div(haloR)).toVarying('vFlyLevel'), vk = k.xy.mul(half.div(haloR)).toVarying('vFlyUV');
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, // keep the sky's alpha for the light-shaft mask
  });
  m.positionNode = centre.add(right.mul(k.x.mul(half))).add(up.mul(k.y.mul(half)));
  m.colorNode = Fn(() => {
    // vk: in halo radii (the quad reaches 2.6 of them); vLevel: level, the core's and the halo's light, the core's radius in halo radii
    const r2 = dot(vk, vk);
    const cr = vLevel.w;
    const core = exp(r2.div(cr.mul(cr)).mul(-1.0)), halo = exp(r2.mul(-1.0)).mul(sstep(6.76, 4.0, r2));
    // yellow-green (#c8ff50), the core paler (#e0ff80)
    const col = mix(vec3(0.58, 1.0, 0.08), vec3(0.8, 1.0, 0.3), core);
    return vec4(col.mul(core.mul(vLevel.y).mul(6.5).add(halo.mul(vLevel.z).mul(0.6))).mul(vLevel.x), 1.0);
  })();
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3; // over the water (2)
  mesh.visible = false;
  // per frame: how many are out (0..1; `wind` on the 0..1 scale of the weather presets). They come out as the lamps
  // come on, brightest once the sky is dark; none from a drizzle up, fewer in a wind past a breeze and none in a gale.
  // `warming`: the warm-up builds the pipeline.
  function update({ lights, elev, rain, wind, warming = false }) {
    uAmount.value = lights * (0.25 + 0.75 * smoothstep(-1, -12, elev)) * smoothstep(0.3, 0.08, rain) * smoothstep(0.85, 0.55, wind);
    mesh.visible = warming || uAmount.value > 0.002;
  }
  return { mesh, update, uAmount };
}
