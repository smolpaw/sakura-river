// People at work in the landscape: an old man fishing from the west bank between the cherry tree and the bridge, and a
// woman planting rice (ta-ue) in a flooded paddy beyond the egrets', by the valley lane. Model: tools/figures.py
// (Blender, `node tools/blender.mjs figures`), public/models/figures.glb, fetched after start-up (not inlined: the
// page stays small; opened as a file, without a server, the figures are missing as the traveller is). Each figure is
// one skinned mesh (a lighter one beyond FAR m) lit like the traveller (walker.js clothColor: the planter's kasuri),
// casting into the sun's sharp map and the valley's (FAR_LAYER), with two clips whose times are set here each frame.
// The fisherman sits on a stone on the bank's top, facing across the river, his float on the water below (the model's
// float is moved to the river's surface); he plays `sit` and every 30-90 s `lift`. His paper lantern lights after
// dusk: its light is in the light map (figureLamps, before the map is built) and a glow sprite marks it. His float
// leaves a little wake in the current and sends out rings when it dips, is lifted out and lands again (touches.js).
// The planter plants three seedlings across her row and steps back a row each 12 s loop (`plant`): she works strips
// across the paddy from its north end, turning at its end to the next strip, the seedlings she has planted standing in rows in front of
// her (one instanced draw, as many as she has planted: how far she has got follows the clock, from none at 08:00 to
// the whole paddy by 17:30, and the time she has been watched); every few rows, and at each strip's end, she
// straightens up (`stretch`). She is there from 08:00 to 17:30 only, and not in rain over 0.5; he sits out drizzle
// under his sedge hat and goes home in rain over 0.5 (his lantern's light leaves the light map: onLamp, main.js).
import * as THREE from 'three/webgpu';
import { Fn, float, max, pow, dot, normalize, uniform, attribute, positionWorld, normalWorld, cameraPosition, diffuseColor, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { U, LitMaterial, lanternLight, sstep } from './tsl.js';
import { groundBounce } from './materials.js';
import { clothColor } from './walker.js';
import { loadModel } from './lods.js';
import { FAR_LAYER } from './sunshadow.js';
import { makeGlows } from './fx.js';
import { lamp } from './lights.js';
import { mulberry32 } from './noise.js';

const FAR = 40; // m: the lighter models beyond
// tools/figures.py: the fisherman's lantern's middle and his float's water (Blender's axes there: x, y, z -> x, z, -y
// here), the planter's feet under the water, her row spacing, the seedlings' spots across the row (x, forward) and
// when each goes in
const LAMP = new THREE.Vector3(0.5, 0.47, -0.2);
const WATER = -1.37;
const NIBBLE = 6.2, OUT = 0.5, BACK = 5.0; // s into `sit`: the float dips; into `lift`: it leaves the water, lands again
const SINK = 0.13, STEP = 0.27, ROW = 0.366, PLANT_X = [0.19, 0, -0.19], PLANT_AT = [1.95, 4.55, 7.15];
const FISHER = { z: -31.6, inland: 1.75 }; // on the west bank: where along it, how far up from the water's edge
const PADDY = [-61.5, -112]; // the planter's paddy (a point in it), by the valley lane, south of the egrets'
const HOURS = [8, 17.5]; // when she is out
const STRIP = 0.6; // her strips' width (three seedlings)
const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// the fisherman's place: his feet on the bank's top FISHER.inland m from the water's edge, facing square across the
// river; and his lantern there
function fisherPlace(world) {
  const { z, inland } = FISHER;
  const rx = world.riverX(z), hw = world.riverHW(z);
  let d = hw * 0.5;
  while (d < hw * 2 && world.height(rx - d, z) < 0) d += 0.02;
  const tx = world.riverX(z + 1) - world.riverX(z - 1), tl = Math.hypot(tx, 2);
  let fx = 2 / tl, fz = -tx / tl;
  if (fx < 0) { fx = -fx; fz = -fz; }
  const x = rx - d - fx * inland, zz = z - fz * inland;
  const o = new THREE.Object3D();
  o.position.set(x, world.height(x, zz), zz);
  o.rotation.y = Math.atan2(fx, fz);
  o.updateMatrixWorld(true);
  return { obj: o, lamp: LAMP.clone().applyMatrix4(o.matrixWorld) };
}

// the lamps the light map takes (main.js lightMap): the fisherman's lantern
export function figureLamps(world) {
  const p = fisherPlace(world).lamp;
  return [lamp(p.x, p.y, p.z, 0.16, 2.2)];
}

// wet paddy, well inside it, at (x, z): its water level, or null (heron.js paddyWater)
function paddyWater(world, x, z, margin = 0.7) {
  const F = world.heightField(x, z).F;
  return F && F.wet && F.inside && !F.village && F.q > margin ? F.y : null;
}

// the paddy's strips: across it (along x, STRIP wide), from its north end (nearest the lane) south, each worked from
// one side to the other facing the way she came from, alternate strips the other way; every row's middle and the
// way she faces
function paddyRows(world) {
  const [hx, hz] = PADDY;
  const y = paddyWater(world, hx, hz);
  if (y === null) return null;
  const edge = (dx, dz) => { let t = 0; while (t < 40 && paddyWater(world, hx + dx * (t + 0.1), hz + dz * (t + 0.1)) !== null) t += 0.1; return t; };
  const x0 = hx - edge(-1, 0), x1 = hx + edge(1, 0), z0 = hz - edge(0, -1), z1 = hz + edge(0, 1);
  const strips = [];
  const n = Math.floor((x1 - x0 - ROW - 0.5) / STEP);
  for (let k = 0; (k + 1) * STRIP <= z1 - z0; k++) {
    const z = z1 - (k + 0.5) * STRIP;
    const dir = k % 2 ? -1 : 1; // facing +x: the first row at the +x side, working back towards -x
    const start = dir > 0 ? x1 - ROW - 0.25 : x0 + ROW + 0.25;
    const rows = [];
    for (let j = 0; j < n; j++) rows.push({ x: start - dir * j * STEP, z, yaw: dir * Math.PI / 2 });
    strips.push(rows);
  }
  return { y, strips, perStrip: n, total: strips.length * n };
}

// the planted seedlings: a few blades each, in planting order, in one instanced draw (count: how many are in)
function makeSeedlings(paddy, rng) {
  const blades = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4, lean = 0.25 + 0.15 * (i % 2), h = 0.15 + 0.03 * (i % 3);
    const g = new THREE.PlaneGeometry(0.012, h, 1, 2).translate(0, h / 2 - 0.03, 0);
    const p = g.attributes.position;
    for (let v = 0; v < p.count; v++) { const t = (p.getY(v) + 0.03) / h; p.setZ(v, p.getZ(v) + lean * t * t * h); }
    g.rotateY(a);
    const c = new Float32Array(p.count * 3);
    for (let v = 0; v < p.count; v++) { const t = (p.getY(v) + 0.03) / h; c.set([0.12 + 0.1 * t, 0.26 + 0.18 * t, 0.06 + 0.03 * t], v * 3); }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    blades.push(g);
  }
  const geo = mergeGeometries(blades);
  const mat = new LitMaterial({ roughness: 0.8, metalness: 0, side: THREE.DoubleSide, colorNode: attribute('color', 'vec3') }, (out) => Fn(() => out.add(diffuseColor.rgb.mul(lanternLight(positionWorld).add(groundBounce()))))());
  const mesh = new THREE.InstancedMesh(geo, mat, paddy.total * 3);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  let i = 0;
  for (const rows of paddy.strips) for (const r of rows) {
    const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
    for (const x of PLANT_X) {
      // (her left, +x in her frame, is -x... in the world when she faces +z: three's yaw turns +x to (cos, -sin))
      p.set(r.x + Math.cos(r.yaw) * x + fx * ROW + (rng() - 0.5) * 0.03, paddy.y, r.z - Math.sin(r.yaw) * x + fz * ROW + (rng() - 0.5) * 0.03);
      q.setFromAxisAngle(up, rng() * Math.PI * 2);
      s.setScalar(0.85 + rng() * 0.3);
      mesh.setMatrixAt(i++, m.compose(p, q, s));
    }
  }
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.name = 'seedlings';
  return mesh;
}

function figureMaterial(at) {
  return new LitMaterial({ roughness: 0.85, metalness: 0, colorNode: clothColor(at) }, (out) => Fn(() => {
    const v = normalize(cameraPosition.sub(positionWorld));
    const edge = pow(float(1.0).sub(max(dot(normalWorld, v), 0.0)), 3.0);
    const against = pow(max(dot(v.negate(), U.uSunDir), 0.0), 2.0);
    const rim = U.uSunColor.mul(U.uSunVis).mul(edge).mul(against.mul(0.7).add(0.1));
    // the lantern's paper (alpha 0.2) glows after dusk
    const a = attribute('color', 'vec4');
    const paper = sstep(0.12, 0.17, a.a).mul(sstep(0.28, 0.23, a.a));
    const glow = a.rgb.mul(vec3(1.0, 0.72, 0.42)).mul(paper).mul(U.uLights).mul(2.2);
    return out.add(diffuseColor.rgb.mul(lanternLight(positionWorld).add(groundBounce()).add(rim))).add(glow);
  })());
}

// uFocal: the lanterns' (fx.js makeGlows); onLamp(on): the fisherman's lantern lit or put out (he has gone home).
// Returns { group, update, info }; the model arrives a moment after.
export function makeFigures(world, { uFocal, onLamp } = {}) {
  const rng = mulberry32(71);
  const group = new THREE.Group();
  group.name = 'figures';
  const fp = fisherPlace(world);
  const glows = makeGlows(new Float32Array(fp.lamp.toArray()), uFocal, 1.5, 0.32);
  glows.name = 'figureGlows';
  glows.visible = false;
  group.add(glows);
  const paddy = paddyRows(world);
  const seedlings = paddy ? makeSeedlings(paddy, rng) : null;
  if (seedlings) group.add(seedlings);
  const figs = {};
  // the float on the water: its wake and its rings (touches.js)
  const wakes = [{ x: 0, z: 0, r: 0.012, len: 0.5, amp: 0, lambda: 0.045 }], splashes = [];
  const fpos = new THREE.Vector3();
  let fisherOut = true; // (his lantern starts in the light map: main.js)

  loadModel(new URL('models/figures.glb', document.baseURI).href).then((gltf) => {
    const src = gltf.scene;
    const mats = {};
    const clip = (n) => gltf.animations.find((a) => a.name === n);
    for (const name of ['fisherman', 'planter']) {
      const rig = src.getObjectByName(`${name}_rig`);
      if (!rig) continue;
      const root = new THREE.Group();
      root.add(rig);
      let near = null, far = null;
      rig.traverse((o) => {
        if (!o.isSkinnedMesh) return;
        o.skeleton.update();
        // the positions are quantized (meshopt): back to metres in the bind pose for the kasuri
        const q = o.geometry.boundingBox || (o.geometry.computeBoundingBox(), o.geometry.boundingBox);
        const w = new THREE.Box3().setFromObject(o, true);
        const scale = (w.max.y - w.min.y) / (q.max.y - q.min.y);
        o.material = mats[o.name] = figureMaterial({ scale: uniform(scale), offset: uniform(w.min.clone().sub(q.min.clone().multiplyScalar(scale))) });
        o.castShadow = o.receiveShadow = true;
        o.layers.enable(FAR_LAYER);
        o.computeBoundingSphere();
        o.boundingSphere.radius += name === 'fisherman' ? 1.2 : 0.5; // (the rod raised, the step back)
        if (o.name.endsWith('_far')) far = o; else near = o;
      });
      far.visible = false;
      const mixer = new THREE.AnimationMixer(root);
      const names = name === 'fisherman' ? ['sit', 'lift'] : ['plant', 'stretch'];
      const A = names.map((n) => { const a = mixer.clipAction(clip(n)); a.timeScale = 0; a.play(); return a; });
      figs[name] = { root, near, far, mixer, A, t: [rng() * clip(names[0]).duration, 0], act: 0, next: 30 + rng() * 60, float: rig.getObjectByName('float') };
      group.add(root);
    }
    if (figs.fisherman) {
      const f = figs.fisherman;
      f.root.position.copy(fp.obj.position);
      f.root.rotation.copy(fp.obj.rotation);
    }
    if (figs.planter && paddy) {
      const p = figs.planter;
      p.row = -1; p.loops = 0; p.hour = null; p.since = 3 + Math.floor(rng() * 3);
    } else if (figs.planter) figs.planter.root.visible = false;
  }).catch((e) => console.warn('figures not loaded', e));

  // the planter at row r (planting order over the whole paddy), moving to row r + k (0..1) on her way back
  const placeAt = (p, r, k) => {
    const n = paddy.perStrip, a = paddy.strips[Math.floor(r / n) % paddy.strips.length][r % n];
    const s = Math.floor(r / n) % paddy.strips.length;
    const b = r % n < n - 1 ? paddy.strips[s][r % n + 1] : a;
    p.root.position.set(a.x, paddy.y - SINK, a.z);
    p.root.rotation.y = a.yaw;
    return b;
  };

  const level = (f, camera) => {
    const nearOn = !camera || camera.position.distanceTo(f.root.position) < FAR;
    f.near.visible = nearOn; f.far.visible = !nearOn;
  };

  return {
    group, wakes, splashes,
    lamps: figureLamps(world),
    info: () => Object.fromEntries(Object.entries(figs).map(([k, f]) => [k, { pos: f.root.position.toArray().map((v) => +v.toFixed(2)), yaw: +f.root.rotation.y.toFixed(2), visible: f.root.visible, clip: f.A[f.act].getClip().name, t: +f.t[f.act].toFixed(2), row: f.row, planted: seedlings ? seedlings.count : 0 }])),
    // debug: start the second clip now
    act(name) { const f = figs[name]; if (f) f.next = 0; },
    update(dt, { hour = 12, rain = 0, lights = 0, camera = null, warming = false } = {}) {
      dt = Math.min(dt, 0.1);
      // the fisherman: out in all but heavy rain; his clips wait while he is home
      const fout = rain <= 0.5;
      if (fout !== fisherOut) { fisherOut = fout; if (onLamp) onLamp(fout); }
      glows.visible = fout && (warming || lights > 0.001);
      const fi = figs.fisherman;
      if (fi) fi.root.visible = fout;
      if (fi && !fout) wakes[0].amp = 0;
      if (fi && fout) {
        level(fi, camera);
        const [sit, lift] = fi.A;
        const t0 = fi.t[0], t1 = fi.t[1], act = fi.act;
        fi.t[0] = (fi.t[0] + dt) % sit.getClip().duration;
        if (fi.act === 0 && (fi.next -= dt) <= 0) { fi.act = 1; fi.t[1] = 0; }
        let wl = 0;
        if (fi.act === 1) {
          fi.t[1] += dt;
          const d = lift.getClip().duration;
          wl = smooth(fi.t[1] / 0.5) * smooth((d - fi.t[1]) / 0.5);
          if (fi.t[1] >= d) { fi.act = 0; fi.next = 30 + rng() * 60; wl = 0; }
        }
        sit.time = fi.t[0]; lift.time = Math.min(fi.t[1], lift.getClip().duration);
        sit.setEffectiveWeight(1 - wl); lift.setEffectiveWeight(wl);
        fi.mixer.update(0);
        // the float on the river's surface where the bank is not where the model was built for
        if (fi.float) {
          fi.float.position.y += (-fi.root.position.y - WATER) * (1 - wl);
          fi.float.getWorldPosition(fpos);
          const w = wakes[0], lifted = fi.act === 1 && fi.t[1] > OUT && fi.t[1] < BACK;
          w.x = fpos.x; w.z = fpos.z; w.amp = lifted ? 0 : 0.7;
          const crossed = (a, b, at) => a < at && b >= at;
          if (act === 0 && fi.act === 0 && crossed(t0, fi.t[0], NIBBLE)) splashes.push({ x: w.x, z: w.z, amp: 0.7, r: 0.012 });
          if (fi.act === 1 && crossed(act === 1 ? t1 : 0, fi.t[1], OUT)) splashes.push({ x: w.x, z: w.z, amp: 0.5, r: 0.012 });
          if (fi.act === 1 && crossed(act === 1 ? t1 : 0, fi.t[1], BACK)) splashes.push({ x: w.x, z: w.z, amp: 1, r: 0.012 });
        }
      }
      const p = figs.planter;
      if (p && paddy) {
        const out = hour >= HOURS[0] && hour <= HOURS[1] && rain <= 0.5;
        p.root.visible = out;
        // how far she has got: the clock's share of the day's work, and a row for each loop watched
        if (p.hour === null || Math.abs(hour - p.hour) > 0.25) {
          p.hour = hour; p.loops = 0;
          p.base = Math.floor(smooth((hour - HOURS[0]) / (HOURS[1] - HOURS[0]) * 1.0) * paddy.total * 0.999);
        }
        let r = (p.base + p.loops) % paddy.total;
        if (out) {
          level(p, camera);
          const [plant, stretch] = p.A;
          let ws = 0;
          if (p.act === 0) {
            p.t[0] += dt;
            if (p.t[0] >= plant.getClip().duration) {
              // a row done: back a step (the clip ends a step back), now and then a stretch, at a strip's end always
              p.t[0] = 0; p.loops++;
              r = (p.base + p.loops) % paddy.total;
              if (--p.since <= 0 || r % paddy.perStrip === 0) { p.act = 1; p.t[1] = 0; p.since = 3 + Math.floor(rng() * 4); }
            }
          } else {
            p.t[1] += dt;
            const d = stretch.getClip().duration;
            ws = smooth(p.t[1] / 0.5) * smooth((d - p.t[1]) / 0.5);
            if (p.t[1] >= d) { p.act = 0; ws = 0; }
          }
          plant.time = p.t[0]; stretch.time = Math.min(p.t[1], stretch.getClip().duration);
          plant.setEffectiveWeight(1 - ws); stretch.setEffectiveWeight(ws);
          p.mixer.update(0);
          if (p.row !== r || p.act === 1) {
            placeAt(p, r, 0);
            // turning into a new strip while she stands up: from the last strip's last row
            if (p.act === 1 && r % paddy.perStrip === 0 && r > 0) {
              const prev = paddy.strips[Math.floor((r - 1) / paddy.perStrip) % paddy.strips.length][paddy.perStrip - 1];
              const k = smooth((p.t[1] - 1.0) / 2.5);
              p.root.position.x = THREE.MathUtils.lerp(prev.x - Math.sin(prev.yaw) * STEP, p.root.position.x, k);
              p.root.position.z = THREE.MathUtils.lerp(prev.z - Math.cos(prev.yaw) * STEP, p.root.position.z, k);
              p.root.rotation.y = prev.yaw + (p.root.rotation.y - prev.yaw) * k;
            }
            p.row = r;
          }
        }
        // the seedlings in: every row before hers, and this row's as each goes in
        if (seedlings) {
          let inRow = 0;
          if (out && p.act === 0) for (const t of PLANT_AT) if (p.t[0] >= t) inRow++;
          seedlings.count = Math.min(paddy.total * 3, r * 3 + inRow);
          seedlings.visible = seedlings.count > 0;
        }
      }
    },
  };
}
