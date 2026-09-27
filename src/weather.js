// Weather: presets, the time-of-day clock, the sky under cloud cover, rain streaks and lightning
import * as THREE from 'three/webgpu';
import { Fn, float, vec3, vec4, uniform, attribute, normalize, cross, mod, length, positionGeometry, positionWorld, cameraPosition } from 'three/tsl';
import { U, sstep, applyFog, fogAmount, lanternLight } from './tsl.js';
import { mulberry32, lerp, smoothstep } from './noise.js';

// Weather presets, independent of the time of day. Values are the engine's 0..1 settings (see set() in main.js);
// 'clear' is the scene's original look.
export const WEATHERS = [
  { id: 'clear', kanji: '晴', name: 'Clear', wind: 0.38, petals: 0.6, river: 0.45, fog: 0.25, bloom: 0.4, clouds: 0.35, rain: 0, lightning: 0 },
  { id: 'haze', kanji: '霞', name: 'Spring haze', wind: 0.15, petals: 0.45, river: 0.35, fog: 0.72, bloom: 0.45, clouds: 0.45, rain: 0, lightning: 0 },
  { id: 'fubuki', kanji: '花吹雪', name: 'Petal storm', wind: 1, petals: 1, river: 0.6, fog: 0.2, bloom: 0.4, clouds: 0.5, rain: 0, lightning: 0 },
  { id: 'overcast', kanji: '曇', name: 'Overcast', wind: 0.45, petals: 0.55, river: 0.5, fog: 0.4, bloom: 0.35, clouds: 0.85, rain: 0, lightning: 0 },
  { id: 'drizzle', kanji: '小雨', name: 'Drizzle', wind: 0.25, petals: 0.45, river: 0.55, fog: 0.45, bloom: 0.4, clouds: 0.8, rain: 0.3, lightning: 0 },
  { id: 'downpour', kanji: '大雨', name: 'Downpour', wind: 0.6, petals: 0.35, river: 1, fog: 0.6, bloom: 0.4, clouds: 1, rain: 1, lightning: 0 },
  { id: 'storm', kanji: '雷雨', name: 'Thunderstorm', wind: 0.85, petals: 0.5, river: 0.9, fog: 0.5, bloom: 0.45, clouds: 1, rain: 0.8, lightning: 1 },
];
export const WEATHER_KEYS = ['wind', 'petals', 'river', 'fog', 'bloom', 'clouds', 'rain', 'lightning'];

// Times of day as clock hours. The scene's time t runs 0..1 from 05:00 to 19:00; outside that it is night.
export const TIMES = [
  { id: 'dawn', kanji: '暁', name: 'Dawn', hour: 5.5 },
  { id: 'afternoon', kanji: '昼', name: 'Afternoon', hour: 14.5 },
  { id: 'dusk', kanji: '夕', name: 'Dusk', hour: 17.85 },
  { id: 'night', kanji: '夜', name: 'Night', hour: 20.75 },
];
export const hourToT = (h) => (h - 5) / 14;
export const tToHour = (t) => (((5 + 14 * t) % 24) + 24) % 24;

// Sky state (sky.js skyState) under cloud cover: greyer sky and fog, weaker sun. No change at cover <= 0.4.
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const grey = (c, k) => { const l = lum(c) * k; return new THREE.Color(l * 0.94, l * 0.98, l * 1.08); };
export function overcast(st, cover) {
  const o = smoothstep(0.4, 1.0, cover);
  if (o <= 0) return st;
  const sky = grey(st.horizon.clone().lerp(st.zenith, 0.4), 0.42);
  st.zenith.lerp(sky, o * 0.85); st.horizon.lerp(sky, o * 0.85);
  st.cloudLit.lerp(grey(st.cloudLit, 0.3), o); st.cloudShade.lerp(grey(st.cloudShade, 0.4), o);
  st.fog.lerp(grey(st.fog, 0.7), o * 0.8); st.fogSun.lerp(st.fog, o * 0.8);
  st.sun.lerp(grey(st.sun, 1), o * 0.5);
  st.sunI *= 1 - 0.8 * o; st.vis *= 1 - 0.75 * o;
  st.gloom = o;
  return st;
}

// Rain: instanced streaks animated in the vertex stage, wrapped in a box around the camera. The number drawn
// (geometry.instanceCount) sets the intensity.
export function makeRain(count) {
  const rng = mulberry32(99);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) seed[i] = rng();
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
  geo.instanceCount = count;
  const mesh = new THREE.Mesh(geo, rainMaterial());
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.layers.set(1);
  return mesh;
}

function rainMaterial() {
  const seed = attribute('aSeed', 'vec4');
  const BOX = vec3(60.0, 30.0, 60.0);
  const pos = Fn(() => {
    const p = seed.xyz.mul(BOX).toVar();
    p.y.subAssign(U.uTime.mul(seed.w.mul(3.0).add(9.0)));
    const w = U.uWindDir.mul(U.uWind).mul(U.uTime).mul(2.0);
    p.assign(vec3(p.x.add(w.x), p.y, p.z.add(w.y)));
    const c = cameraPosition.sub(BOX.mul(0.5));
    p.assign(c.add(mod(p.sub(c), BOX)));
    const fall = normalize(vec3(U.uWindDir.x.mul(U.uWind).mul(0.2), -1.0, U.uWindDir.y.mul(U.uWind).mul(0.2)));
    const side = normalize(cross(fall, normalize(cameraPosition.sub(p))));
    return p.add(side.mul(positionGeometry.x).mul(0.012)).add(fall.mul(positionGeometry.y).mul(0.55));
  })();
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  m.positionNode = pos;
  // lit by the sky, the sun and the lanterns; streaks right at the lens fade out (they would fill the screen)
  const lit = U.uSkyAmb.mul(1.2).add(U.uSunColor.mul(0.15)).add(lanternLight(positionWorld).mul(2.0));
  const near = sstep(1.5, 5.0, length(positionWorld.sub(cameraPosition)));
  m.colorNode = vec4(applyFog(lit, positionWorld), seed.w.mul(0.12).add(0.18).mul(near));
  return m;
}

// Lightning: a jagged bolt with branches (rebuilt per strike, facing the camera), a few flickering pulses per
// strike, and some strikes only light the clouds. update() returns the flash level, which lights the sky and scene.
// onStrike(x, z, distance, bolt) hears each strike (its thunder).
export function makeLightning(onStrike) {
  const MAX = 2400;
  const pos = new Float32Array(MAX * 3), glow = new Float32Array(MAX);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aGlow = new THREE.BufferAttribute(glow, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aGlow', aGlow);
  geo.setDrawRange(0, 6); // degenerate until the first strike (drawn once during the warm-up)
  const uBolt = uniform(0);
  // additive, keeping destination alpha (the sky's alpha 0 marks it for the light-shaft mask)
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  mat.colorNode = vec4(vec3(0.8, 0.85, 1.0).mul(attribute('aGlow', 'float')).mul(uBolt).mul(float(1.0).sub(fogAmount(positionWorld).mul(0.8))), 1.0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 5;

  const rng = mulberry32(7);
  const dir = new THREE.Vector3(0, 0.3, -1).normalize(); // where the flash is, for the sky
  const fwd = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), s = new THREE.Vector3(), v = new THREE.Vector3();
  let n = 0, wait = 2.5, t = 1e9, pulses = [];

  // midpoint displacement: each level splits every segment and pushes the midpoint sideways
  function jag(p0, p1, levels, rough) {
    let pts = [p0, p1];
    for (let l = 0; l < levels; l++) {
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i], len = p.distanceTo(q);
        out.push(p.clone().lerp(q, 0.4 + rng() * 0.2).add(v.set((rng() - 0.5) * len * rough, (rng() - 0.5) * len * rough * 0.3, (rng() - 0.5) * len * rough)), q);
      }
      pts = out;
    }
    return pts;
  }
  function ribbon(pts, width, g, cam) {
    for (let i = 1; i < pts.length && n + 6 <= MAX; i++) {
      const k = 1 - (i / pts.length) * 0.6; // thinner towards the tip
      a.copy(pts[i - 1]); b.copy(pts[i]);
      s.subVectors(b, a).cross(v.subVectors(cam, a)).normalize().multiplyScalar(width * k * 0.5);
      const quad = [[a, -1], [a, 1], [b, 1], [a, -1], [b, 1], [b, -1]];
      for (const [p, sg] of quad) {
        pos[n * 3] = p.x + s.x * sg; pos[n * 3 + 1] = p.y + s.y * sg; pos[n * 3 + 2] = p.z + s.z * sg;
        glow[n] = g * k; n++;
      }
    }
  }
  function strike(camera) {
    camera.getWorldDirection(fwd);
    const az = Math.atan2(fwd.x, fwd.z) + (rng() - 0.5) * 1.6; // mostly in view
    const dist = 380 + rng() * 520;
    const cx = camera.position.x + Math.sin(az) * dist, cz = camera.position.z + Math.cos(az) * dist;
    dir.set(Math.sin(az), 0.3, Math.cos(az)).normalize();
    pulses = [{ at: 0, amp: 1, decay: 0.07 }, { at: 0.08 + rng() * 0.06, amp: 0.6 + rng() * 0.3, decay: 0.05 }];
    if (rng() < 0.7) pulses.push({ at: 0.2 + rng() * 0.15, amp: 0.5 + rng() * 0.6, decay: 0.12 });
    n = 0;
    const bolt = rng() < 0.65;
    if (bolt) { // a visible bolt; otherwise only the clouds flash
      const top = new THREE.Vector3(cx + (rng() - 0.5) * 80, 260 + rng() * 80, cz + (rng() - 0.5) * 80);
      const main = jag(top, new THREE.Vector3(cx, -2, cz), 7, 0.45);
      ribbon(main, 2.4, 1, camera.position);
      const branches = 3 + Math.floor(rng() * 4);
      for (let i = 0; i < branches; i++) {
        const p = main[10 + Math.floor(rng() * (main.length * 0.6))];
        const end = p.clone().add(v.set((rng() - 0.5) * 160, -60 - rng() * 110, (rng() - 0.5) * 160));
        ribbon(jag(p, end, 5, 0.5), 1.1, 0.45, camera.position);
      }
      aPos.needsUpdate = true; aGlow.needsUpdate = true;
    }
    geo.setDrawRange(0, n);
    if (onStrike) onStrike(cx, cz, dist, bolt);
  }

  return {
    mesh, dir,
    update(dt, level, camera) {
      t += dt;
      if (level > 0.02) {
        wait -= dt;
        if (wait <= 0) { strike(camera); t = 0; wait = lerp(16, 4, level) * (0.4 + rng() * 1.2); }
      } else wait = 2.5; // the first strike comes a moment after the storm arrives
      let f = 0;
      if (t < 2) for (const p of pulses) if (t >= p.at) f += p.amp * Math.exp(-(t - p.at) / p.decay);
      uBolt.value = f * 7;
      mesh.visible = n > 0 && f > 0.005;
      return f;
    },
  };
}
