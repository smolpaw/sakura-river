// The river boats: small flat-bottomed cedar kawabune (tools/boat.py). One lies moored along the west bank below the
// cherry tree, where the lantern line ends (in the cinematic flight's opening view, behind the hero view's camera), its
// bow upstream, half a metre off the reeds, rocking a little on the current at the end of a slack rope tied to a stake
// on the bank; another is pulled up on the west bank above the bridge, downstream of the mill, bow first up the bank
// onto the grass, heeled a little, its stern at the water's edge. Each boat is one Object3D (its full model near, the
// far one beyond FAR metres); the moored one's rocking is a few sines of the time on the CPU, and the rope's end
// follows its bow in the vertex stage. Lit as the lamps (materials.js lampMaterial). The moored hull leaves a wake
// in the current from its bow and its stern, and sends out faint rings round itself as it rocks (touches.js).
import * as THREE from 'three/webgpu';
import { attribute, positionLocal, uniform } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadModel } from './lods.js';
import { FAR_LAYER } from './sunshadow.js';
import { lampMaterial } from './materials.js';

const WATERLINE = 0.07; // tools/boat.py: the waterline's height above the hull's bottom, afloat
const ROPE_Z = 0.62; // tools/boat.py: the rope's turns on the stake, above the ground
const BOW_PEG = new THREE.Vector3(2.2, 0.647, 0); // the peg through the stem the bow line is tied to (boat's frame)
const STAKE_TAIL = new THREE.Vector3(0.18, ROPE_Z - 0.01, 0); // where the line leaves the stake's turns (its frame)
const HALF = { len: 2.3, beam: 0.56 }; // the hull's half length and half beam
const FAR = 45; // the full model to here (m)
const ROPE_C = [0.26, 0.21, 0.13];
const STEM = 1.95, TRANSOM = 2.2; // the bow's and the stern's ends at the waterline, from the middle (boat's frame)

// where the boats lie. moored: its middle's z on the west bank (side -1), clear of the boulders there, and how far its
// side keeps off the reeds; beached: the stretch of the west bank searched for a place, the angle its bow makes with
// the bank (towards the land), its heel, and how far its middle lies up the bank from the water's edge
const PLACE = { moored: { z: 34.3, side: -1, offReeds: 0.5 }, beached: { z: [-92, -82], side: -1, angle: 1.1, heel: 0.07, up: 2.2 } };

// the boat's frame (x: bow, y: up, z: starboard... as three's yaw turns +x) at (x, y, z) with the bow along (dx, dz)
const yawOf = (dx, dz) => Math.atan2(-dz, dx);

// the moored boat's pose on the water: alongside the bank, the bow upstream (the river flows to +z), its bank-side
// edge `offReeds` off where the reeds start (the bed 0.3 m under the water); floating at its waterline
function moored(world) {
  const { z, side, offReeds } = PLACE.moored;
  const rx = world.riverX(z), hw = world.riverHW(z);
  const t = new THREE.Vector2(world.riverX(z + 1) - world.riverX(z - 1), 2).normalize(); // downstream along the bank
  // the reeds' edge, the nearest of it along the hull
  let reed = Infinity;
  for (let u = -HALF.len; u <= HALF.len; u += 0.5) {
    const zz = z + t.y * u, r = world.riverX(zz);
    let d = hw * 0.5;
    while (d < hw * 1.5 && world.height(r + side * d, zz) < -0.3) d += 0.05;
    reed = Math.min(reed, d);
  }
  const d = reed - offReeds - HALF.beam;
  return { x: rx + side * d, y: -WATERLINE, z, yaw: yawOf(-t.x, -t.y), pitch: 0, roll: 0 };
}

// a hull resting on the ground (or afloat where the ground is under water) at (x, z), bow along yaw: a plane fitted
// to what is under its flat bottom, raised until nothing is above it, sunk a little into the grass
function beached(world, x, z, yaw, heel) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pts = [];
  for (let u = -2.0; u <= 0.6; u += 0.4) for (const v of [-0.38, 0, 0.38]) {
    // boat frame: u along the bow (+x), v across (+z: starboard)
    const wx = x + c * u + s * v, wz = z - s * u + c * v;
    pts.push([u, v, Math.max(world.height(wx, wz), -WATERLINE)]);
  }
  // least squares h = a + b u + e v
  let n = 0, su = 0, sv = 0, sh = 0, suu = 0, svv = 0, suh = 0, svh = 0;
  for (const [u, v, h] of pts) { n++; su += u; sv += v; sh += h; suu += u * u; svv += v * v; suh += u * h; svh += v * h; }
  const mu = su / n, mv = sv / n, mh = sh / n;
  const b = (suh - n * mu * mh) / (suu - n * mu * mu), e = (svh - n * mv * mh) / (svv - n * mv * mv);
  const a = mh - b * mu - e * mv;
  let lift = -Infinity;
  for (const [u, v, h] of pts) lift = Math.max(lift, h - (a + b * u + e * v));
  return { x, y: a + lift - 0.03, z, yaw, pitch: Math.atan(b), roll: -Math.atan(e) + heel };
}

// the beached boat: along the bank's stretch `z`, its bow `angle` from the bank towards the land, the stern at the
// water's edge; where it clears the boulders, the bonbori, the buildings' pads and the farmland, and its bottom lies
// flattest
function beachedPose(world, blockers) {
  const { z: [z0, z1], side, angle, heel, up: upBank } = PLACE.beached;
  let best = null;
  for (let z = z0; z <= z1; z += 0.5) {
    const rx = world.riverX(z), hw = world.riverHW(z);
    const t = new THREE.Vector2(world.riverX(z + 1) - world.riverX(z - 1), 2).normalize();
    // the bow pointing upstream and up the bank: the bank's line turned `angle` towards the land
    const upstream = new THREE.Vector2(-t.x, -t.y), land = new THREE.Vector2(side * t.y, -side * t.x);
    if (land.x * side < 0) land.negate();
    const dir = upstream.clone().multiplyScalar(Math.cos(angle)).addScaledVector(land, Math.sin(angle));
    // its middle `up` metres along the bow from the water's edge, so the stern's foot is at it
    let d = hw * 0.8;
    while (d < hw * 1.5 && world.height(rx + side * d, z) < 0) d += 0.05;
    const mx = rx + side * d + dir.x * upBank, mz = z + dir.y * upBank;
    const clear = blockers.every((o) => Math.hypot(mx - o.x, mz - o.z) > o.r + 3.0) && !world.padAt(mx, mz) && !world.zoneAt(mx + dir.x * 2.3, mz + dir.y * 2.3);
    if (!clear) continue;
    const p = beached(world, mx, mz, yawOf(dir.x, dir.y), side * heel);
    const fit = Math.abs(p.pitch) + Math.abs(p.roll - side * heel) * 0.5;
    if (!best || fit < best.fit) best = { ...p, fit };
  }
  return best;
}

const euler = new THREE.Euler(0, 0, 0, 'YZX');
function pose(o, p) {
  o.position.set(p.x, p.y, p.z);
  o.quaternion.setFromEuler(euler.set(p.roll, p.yaw, p.pitch));
  o.updateMatrix();
}

// a mesh's geometry as plain floats in world space (the glTF's meshopt-quantized one, with its node's matrix)
function plain(src, m) {
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'color']) {
    const a = src.geometry.attributes[k], out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) out[i * a.itemSize + j] = a.getComponent(i, j);
    g.setAttribute(k, new THREE.BufferAttribute(out, a.itemSize));
  }
  g.setIndex(Array.from(src.geometry.index.array));
  return g.applyMatrix4(src.matrixWorld).applyMatrix4(m);
}

// url: boat.glb; rocks: the boulders ({ x, z, sc }: vegetation.js rocksData's blockers) and lamps: the bonbori's lights
// (x, y, z flat), which the beached boat keeps clear of; rafts: the petal rafts' data (petals.js raftData), its
// petals under the moored hull moved out against its side
export async function makeBoats(url, world, { rocks = [], lamps = [], rafts = null } = {}) {
  const blockers = rocks.map((b) => ({ x: b.x, z: b.z, r: b.sc }));
  for (let i = 0; i < lamps.length; i += 3) blockers.push({ x: lamps[i], z: lamps[i + 2], r: 0.3 });
  const gltf = await loadModel(url);
  const mat = lampMaterial();
  const group = new THREE.Group();
  group.name = 'boats';
  const boats = [];
  const add = (p) => {
    const o = new THREE.Group();
    for (const [name, far] of [['boat', false], ['boat_far', true]]) {
      const src = gltf.scene.getObjectByName(name);
      const m = new THREE.Mesh(src.geometry, mat);
      m.applyMatrix4(src.matrixWorld);
      m.castShadow = m.receiveShadow = true;
      m.layers.enable(FAR_LAYER);
      m.visible = !far;
      o.add(m);
    }
    pose(o, p);
    o.matrixAutoUpdate = false;
    group.add(o);
    const b = { o, far: false, centre: new THREE.Vector3(p.x, p.y, p.z) };
    boats.push(b);
    return b;
  };
  const rest = moored(world);
  const floating = add(rest);
  // the river's surface kept out of the floating hull: its inside above the waterline, in the depth buffer only, after
  // everything opaque (renderOrder) and before the water; on layer 1, which the camera draws but not the reflection
  // or the shadow maps
  const src = gltf.scene.getObjectByName('boat_mask');
  const mask = new THREE.Mesh(src.geometry, new THREE.MeshBasicNodeMaterial({ colorWrite: false }));
  mask.applyMatrix4(src.matrixWorld);
  mask.renderOrder = 1;
  mask.layers.set(1);
  floating.o.add(mask);
  const pulled = beachedPose(world, blockers);
  if (pulled) add(pulled);

  // the stake on the bank, upstream of the bow and in from it, where the bank is ~0.35 m above the water
  const bow = BOW_PEG.clone().applyMatrix4(floating.o.matrix);
  const fwd = new THREE.Vector3(Math.cos(rest.yaw), 0, -Math.sin(rest.yaw));
  const side = PLACE.moored.side, sz = rest.z + fwd.z * 3.2;
  let sd = world.riverHW(sz) * 0.8;
  while (sd < world.riverHW(sz) * 1.5 && world.height(world.riverX(sz) + side * sd, sz) < 0.35) sd += 0.05;
  const sx = world.riverX(sz) + side * sd;
  const stakePos = new THREE.Vector3(sx, world.height(sx, sz) - 0.03, sz);
  const stakeYaw = yawOf(bow.x - sx, bow.z - sz);
  const sm = new THREE.Matrix4().compose(stakePos, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.04, stakeYaw, -0.06, 'YXZ')), new THREE.Vector3(1, 1, 1));
  const stake = plain(gltf.scene.getObjectByName('stake'), sm);
  stake.setAttribute('aFollow', new THREE.BufferAttribute(new Float32Array(stake.attributes.position.count), 1));
  // the rope: slack, from the stake's turns down over the bank, dipping into the water, up to the bow's peg;
  // aFollow: how much of the bow's rocking it takes (none at the stake)
  const a = STAKE_TAIL.clone().applyMatrix4(sm);
  const pts = [];
  const N = 24;
  // a parabola sagging to just under the water, lying on the bank where it would go through it
  let sag = 0;
  const at = (u, s) => new THREE.Vector3().lerpVectors(a, bow, u).add(new THREE.Vector3(0, -s * 4 * u * (1 - u), 0));
  for (let s = 0; s < 2; s += 0.01) {
    let lo = Infinity;
    for (let i = 1; i < N; i++) lo = Math.min(lo, at(i / N, s).y);
    sag = s;
    if (lo < -0.03) break;
  }
  for (let i = 0; i <= N; i++) {
    const p = at(i / N, sag);
    p.y = Math.max(p.y, world.height(p.x, p.z) + 0.015);
    pts.push(p);
  }
  const rope = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.017, 5, false);
  rope.deleteAttribute('uv');
  const rp = rope.attributes.position, rc = new Float32Array(rp.count * 4), rf = new Float32Array(rp.count);
  for (let i = 0; i < rp.count; i++) {
    rc.set([...ROPE_C, 0], i * 4);
    // (TubeGeometry: rings of radialSegments + 1 vertices along the curve)
    const u = Math.floor(i / 6) / 40;
    rf[i] = u * u;
  }
  rope.setAttribute('color', new THREE.BufferAttribute(rc, 4));
  rope.setAttribute('aFollow', new THREE.BufferAttribute(rf, 1));
  const uBow = uniform(new THREE.Vector3());
  const lineMat = lampMaterial();
  lineMat.positionNode = positionLocal.add(uBow.mul(attribute('aFollow', 'float')));
  const line = new THREE.Mesh(mergeGeometries([stake, rope]), lineMat);
  line.name = 'mooring';
  line.castShadow = line.receiveShadow = true;
  group.add(line);

  // the petal rafts' petals under the moored hull, moved out to lie against its side
  if (rafts) {
    const c = Math.cos(rest.yaw), s = Math.sin(rest.yaw);
    for (let i = 0; i < rafts.n; i++) {
      const dx = rafts.pos[i * 3] - rest.x, dz = rafts.pos[i * 3 + 2] - rest.z;
      const u = c * dx - s * dz, v = s * dx + c * dz; // along the bow, across (starboard)
      if (Math.abs(u) > HALF.len + 0.15 || Math.abs(v) > HALF.beam + 0.08) continue;
      const nv = Math.sign(v || 1) * (HALF.beam + 0.08 + ((i * 0.618) % 1) * 0.12);
      rafts.pos[i * 3] = rest.x + c * u + s * nv;
      rafts.pos[i * 3 + 2] = rest.z - s * u + c * nv;
    }
  }

  const tmp = new THREE.Vector3();
  const swing = { ...rest };
  // the moored hull in the current: a V from its bow, broken water off its square stern; rings round it at the
  // bottom of each heave and the ends of each roll (touches.js)
  const wakes = [{ x: 0, z: 0, r: 0.05, len: 4.6, amp: 1, lambda: 0.12 }, { x: 0, z: 0, r: 0.42, len: 2.2, amp: 0.7, lambda: 0.1 }];
  const splashes = [];
  const along = new THREE.Vector3(), mid = new THREE.Vector3();
  let heave = 0, roll = 0;
  return {
    group, wakes, splashes,
    // once a frame: the moored boat rocks (heave of a couple of cm, ~1 degree of roll, less of pitch, a slow swing
    // on its rope); each boat its full or far model by the camera's distance
    update(t, cam) { // (cam: the camera's position)
      swing.y = rest.y + 0.012 * Math.sin(t * 0.9) + 0.005 * Math.sin(t * 1.73 + 1.1);
      swing.roll = 0.016 * Math.sin(t * 0.77 + 0.4) + 0.006 * Math.sin(t * 1.9);
      swing.pitch = 0.006 * Math.sin(t * 0.61 + 2.0) + 0.003 * Math.sin(t * 1.37);
      swing.yaw = rest.yaw + 0.01 * Math.sin(t * 0.13);
      const dh = Math.cos(t * 0.9) + 0.8 * Math.cos(t * 1.73 + 1.1), dr = Math.cos(t * 0.77 + 0.4); // (the heave's rate, the slow roll's)
      pose(floating.o, swing);
      mid.set(0, 0, 0).applyMatrix4(floating.o.matrix);
      along.set(1, 0, 0).transformDirection(floating.o.matrix);
      for (const [w, u] of [[wakes[0], STEM], [wakes[1], -TRANSOM]]) { w.x = mid.x + along.x * u; w.z = mid.z + along.z * u; }
      // (the heave's lowest point: its rate turning from falling to rising; the slow roll's ends: its rate changing
      // sign; a ring every 2-7 s)
      const ring = (amp) => splashes.push({ x: mid.x, z: mid.z, amp, r: HALF.beam - 0.06, hx: along.x * (HALF.len - HALF.beam - 0.3), hz: along.z * (HALF.len - HALF.beam - 0.3) });
      if (heave < 0 && dh >= 0) ring(0.8);
      if (Math.sign(roll) !== Math.sign(dr) && roll !== 0) ring(0.4);
      heave = dh; roll = dr;
      uBow.value.copy(tmp.copy(BOW_PEG).applyMatrix4(floating.o.matrix)).sub(bow);
      for (const b of boats) {
        const far = cam.distanceTo(b.centre) > FAR;
        if (far !== b.far) { b.far = far; b.o.children[0].visible = !far; b.o.children[1].visible = far; }
      }
    },
  };
}
