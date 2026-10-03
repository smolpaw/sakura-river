// First-person walking (main.js walk mode): the paths the walker is kept on, and the body's movement along them.
// The network: the lanes (world.js LANES), each a corridor CORRIDOR metres either side of its middle; the bridge's
// deck between its railings; the temple's stone steps (the approach's lane ends at their foot) and the front of its
// terrace. The walker moves where the keys (or walkInput) push it, slides along a corridor's edge and round what
// stands on the path (lamp posts, stone lanterns, trunks, the torii's pillars, the bridge's corner posts and
// railings), and stands on the ground there: the deck's arch on the bridge, a slope through the treads' middles on
// the steps.
import * as THREE from 'three/webgpu';
import { clamp, lerp, smoothstep } from './noise.js';
import { bridgeFrame, BRIDGE_Z, CORNER, cornerOff, RAIL_OFF } from './props.js';
import { STAIR, SITES } from './temple.js';

export const WALK = {
  speed: 1.4, hurry: 2.6, // m/s
  accel: 5, // 1/s: how fast the pace follows the keys (~0.5 s from standing to walking)
  eye: 1.55, // the eye above the feet, when the walker's model doesn't give it
  fov: 60, // degrees (the orbit camera's is 42)
  look: 0.0022, // radians per pixel of mouse movement
  pitch: THREE.MathUtils.degToRad(85), // looking down far enough to see the geta step out (main.js EYE_AHEAD)
};
const BODY = 0.3; // how close the walker's middle comes to what stands by the path
const CORRIDOR = 1.2; // half-width of a lane the walker keeps to
const START = { x: -22, z: -4.6, yaw: Math.atan2(0.5, -6) }; // the footpath's end beside the cherry tree, facing down it to the bridge

// smooth maximum (polynomial, k wide)
const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };

// ---------- the network ----------
// a corridor hw either side of a polyline [[x, z], ...]; clamp() moves p onto it, returns how far p was outside
function corridor(name, pts, hw) {
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
    if (l2 > 1e-6) segs.push({ ax, az, vx, vz, l2 });
  }
  return {
    name, pts, hw,
    // nearest point of the middle line to (x, z) and the distance to it
    near(x, z, out) {
      let bd = Infinity;
      for (const s of segs) {
        const t = clamp(((x - s.ax) * s.vx + (z - s.az) * s.vz) / s.l2, 0, 1), cx = s.ax + s.vx * t, cz = s.az + s.vz * t;
        const d = Math.hypot(x - cx, z - cz);
        if (d < bd) { bd = d; out.x = cx; out.z = cz; }
      }
      return bd;
    },
    clamp(p, out) {
      const d = this.near(p.x, p.z, out);
      if (d <= hw) { out.x = p.x; out.z = p.z; return 0; }
      const k = hw / d;
      out.x += (p.x - out.x) * k; out.z += (p.z - out.z) * k;
      return d - hw;
    },
  };
}

// an oriented rectangle: frame { x, z, c, s } (world -> local as world.templeDist), local x0..x1, z0..z1
function area(name, f, x0, x1, z0, z1) {
  return {
    name,
    clamp(p, out) {
      const dx = p.x - f.x, dz = p.z - f.z, lx = dx * f.c - dz * f.s, lz = dx * f.s + dz * f.c;
      const cx = clamp(lx, x0, x1), cz = clamp(lz, z0, z1);
      out.x = f.x + cx * f.c + cz * f.s; out.z = f.z - cx * f.s + cz * f.c;
      return Math.hypot(lx - cx, lz - cz);
    },
  };
}

// what stands in the way: push(p) moves p out of it (true if it did)
const post = (x, z, r) => ({
  x, z, r,
  dist: (px, pz) => Math.hypot(px - x, pz - z) - r,
  push(p) {
    const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz);
    if (d >= r) return false;
    if (d < 1e-6) { p.x = x + r; return true; }
    p.x = x + (dx * r) / d; p.z = z + (dz * r) / d;
    return true;
  },
});
const bar = (ax, az, bx, bz, r) => {
  const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
  const foot = (px, pz) => { const t = clamp(((px - ax) * vx + (pz - az) * vz) / l2, 0, 1); return [ax + vx * t, az + vz * t]; };
  return {
    x: (ax + bx) / 2, z: (az + bz) / 2,
    dist: (px, pz) => { const [cx, cz] = foot(px, pz); return Math.hypot(px - cx, pz - cz) - r; },
    push(p) {
      const [cx, cz] = foot(p.x, p.z), dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
      if (d >= r) return false;
      if (d < 1e-6) return false;
      p.x = cx + (dx * r) / d; p.z = cz + (dz * r) / d;
      return true;
    },
  };
};
// an oriented box (frame as area(), local half-sizes round lx, lz), grown by BODY
const block = (f, lx, lz, hw, hd) => {
  const X = f.x + lx * f.c + lz * f.s, Z = f.z - lx * f.s + lz * f.c, w = hw + BODY, d = hd + BODY;
  const local = (px, pz) => { const dx = px - X, dz = pz - Z; return [dx * f.c - dz * f.s, dx * f.s + dz * f.c]; };
  return {
    x: X, z: Z,
    dist: (px, pz) => { const [a, b] = local(px, pz); return Math.hypot(Math.max(0, Math.abs(a) - w), Math.max(0, Math.abs(b) - d)) - 1e-3; },
    push(p) {
      const [a, b] = local(p.x, p.z);
      if (Math.abs(a) >= w || Math.abs(b) >= d) return false;
      let na = a, nb = b;
      if (w - Math.abs(a) < d - Math.abs(b)) na = Math.sign(a || 1) * w; else nb = Math.sign(b || 1) * d;
      p.x = X + na * f.c + nb * f.s; p.z = Z - na * f.s + nb * f.c;
      return true;
    },
  };
};

// The network over the world. `obstacles`: [{ x, z, r }] standing near the lanes (radii without the walker's body).
export function makeNetwork(world, obstacles = []) {
  const T = world.temple, tf = { x: T.x, z: T.z, c: Math.cos(T.yaw), s: Math.sin(T.yaw) };
  const toW = (lx, lz) => [tf.x + lx * tf.c + lz * tf.s, tf.z - lx * tf.s + lz * tf.c];
  const toL = (x, z) => { const dx = x - tf.x, dz = z - tf.z; return [dx * tf.c - dz * tf.s, dx * tf.s + dz * tf.c]; };
  const ways = [];

  // the lanes
  for (const [k, L] of world.LANES.entries()) ways.push(corridor(`lane${k}`, L, CORRIDOR));

  // the bridge's deck, between its railings, on past its ends onto the banks (where the lanes pass)
  const B = bridgeFrame(world, BRIDGE_Z), bc = B.center, ba = B.across, bl = B.along;
  const PAST = 1.4; // m past the deck's ends
  const uPast = PAST / (2 * B.half);
  const deckW = RAIL_OFF - 0.12 - BODY; // the railings' end posts are 0.12 thick
  ways.push(corridor('bridge', [[B.pt(-uPast).x, B.pt(-uPast).z], [B.pt(1 + uPast).x, B.pt(1 + uPast).z]], deckW));
  // and a landing past each end: the west bank's footpath runs across the deck's mouth, between the railings' end
  // posts and the corner lamp posts, so the walker goes round those on the landward side
  const bf = { x: bc.x, z: bc.z, c: ba.x, s: -ba.z }; // local x across the river (as u), z along the flow
  ways.push(area('landingW', bf, -B.half - 3, -B.half, -3, 3), area('landingE', bf, B.half, B.half + 3, -3, 3));
  const deckAt = (x, z) => {
    const dx = x - bc.x, dz = z - bc.z;
    return { u: ((dx * ba.x + dz * ba.z) / B.half + 1) / 2, side: dx * bl.x + dz * bl.z };
  };
  const arch = (u) => B.endY + B.rise * (1 - Math.pow(Math.min(1, Math.abs(u * 2 - 1)), 2.1));

  // the temple's steps: from the terrace's edge down to where the ground meets them (as temple.js builds them)
  const D = T.hd, gRel = (lx, lz) => { const [x, z] = toW(lx, lz); return world.height(x, z) - T.y; };
  let steps = 1;
  while (steps < 60 && gRel(STAIR.x, D + STAIR.first + STAIR.run * (steps - 0.5) + STAIR.run) < -STAIR.rise * steps - STAIR.rise) steps++;
  const footZ = D + STAIR.first + STAIR.run * steps; // local z of the foot of the last tread
  const stairLine = (lz) => -STAIR.rise * ((lz - D - STAIR.first) / STAIR.run + 0.5); // through the treads' middles
  ways.push(corridor('steps', [toW(STAIR.x, D - 0.9), toW(STAIR.x, footZ + 0.4)], STAIR.hw - BODY));
  // the front of the terrace, from the steps' head to past the pagoda, short of the bell tower and the hall's steps
  ways.push(area('terrace', tf, SITES.belfry[0] + 2.8 + BODY + 0.1, T.hw - 0.9, SITES.hall[2] + 8.9, D - 0.7));

  // what stands in the way: the given obstacles, the bridge's corner posts and railings, the terrace's buildings
  const obs = obstacles.map((o) => post(o.x, o.z, o.r + BODY));
  for (const u of [-CORNER, 1 + CORNER]) for (const sd of [-1, 1]) { const p = B.pt(u, sd * cornerOff(B.width)); obs.push(post(p.x, p.z, 0.21 + BODY)); }
  for (const sd of [-1, 1]) { const a = B.pt(0, sd * RAIL_OFF), b = B.pt(1, sd * RAIL_OFF); obs.push(bar(a.x, a.z, b.x, b.z, 0.12 + BODY)); }
  // (temple.js: the pagoda's podium 11.6 m square and its front steps, the bell tower's 5.6 m)
  obs.push(block(tf, SITES.pagoda[0], SITES.pagoda[2], 5.8, 5.8), block(tf, SITES.pagoda[0], SITES.pagoda[2] + 6.4, 1.4, 0.6));
  obs.push(block(tf, SITES.belfry[0], SITES.belfry[2], 2.8, 2.8));
  // keep only what stands near a path
  const tmp = { x: 0, z: 0 };
  const near = obs.filter((o) => ways.some((w) => { const d = w.clamp({ x: o.x, z: o.z }, tmp); return d < 4 && o.dist(tmp.x, tmp.z) < 0.5; }));

  const p = { x: 0, z: 0 }, out = { x: 0, z: 0 };
  // where the walker may stand nearest to (x, z): in the network, out of what stands in it
  function constrain(x, z, res = { x: 0, z: 0 }) {
    p.x = x; p.z = z;
    for (let it = 0; it < 6; it++) {
      let bd = Infinity, bx = p.x, bz = p.z;
      for (const w of ways) {
        const d = w.clamp(p, out);
        if (d < bd) { bd = d; bx = out.x; bz = out.z; if (d === 0) break; }
      }
      p.x = bx; p.z = bz;
      let pushed = false;
      for (const o of near) if (o.push(p)) pushed = true;
      if (!pushed) break;
    }
    res.x = p.x; res.z = p.z;
    return res;
  }
  // how far (x, z) lies outside the network (0 on it)
  function outside(x, z) {
    p.x = x; p.z = z;
    let bd = Infinity;
    for (const w of ways) bd = Math.min(bd, w.clamp(p, out));
    return bd;
  }

  // the ground under the feet and what it is
  function ground(x, z) {
    const g = world.heightFast(x, z);
    const lane = world.laneDist(x, z) < CORRIDOR + 0.4 ? 'earth' : 'grass';
    // the bridge: the deck's arch, easing down to the ground over PAST metres past its ends
    const { u, side } = deckAt(x, z);
    if (Math.abs(side) < RAIL_OFF + 0.2 && u > -uPast && u < 1 + uPast) {
      if (u >= 0 && u <= 1) return { y: arch(u), surface: 'wood' };
      const past = (u < 0 ? -u : u - 1) * 2 * B.half;
      return { y: lerp(B.endY, g, smoothstep(0, PAST, past)), surface: past < 0.3 ? 'wood' : lane };
    }
    // the temple's steps and terrace
    if (Math.abs(x - T.x) < 40 && Math.abs(z - T.z) < 40) {
      const [lx, lz] = toL(x, z);
      if (Math.abs(lx - STAIR.x) < STAIR.wall + 0.25 && lz > D - 0.05 && lz < footZ + 0.6) {
        return { y: T.y + smax(Math.min(0, stairLine(lz)), g - T.y, 0.25), surface: 'stone' };
      }
      if (world.templeDist(x, z) <= 0) return { y: T.y, surface: 'stone' };
    }
    return { y: g, surface: lane };
  }

  return { ways, obstacles: near, constrain, outside, ground, start: START, steps, stairFoot: toW(STAIR.x, footZ), bridgeEnds: [B.pt(0), B.pt(1)] };
}

// ---------- the body and its controls ----------
// makeWalk(world, { canvas, obstacles, onEscape }): the walker's state and the page's keys, mouse and touch.
// update(dt, active) moves it (input only when active); while it is on (setActive) the canvas's events steer it.
export function makeWalk(world, { canvas, obstacles = [], onEscape = null } = {}) {
  const net = makeNetwork(world, obstacles);
  const s = {
    x: net.start.x, z: net.start.z, y: 0, yaw: net.start.yaw, pitch: 0,
    vx: 0, vz: 0, speed: 0, surface: 'earth', hurry: false,
  };
  const c0 = net.constrain(s.x, s.z);
  s.x = c0.x; s.z = c0.z; s.y = net.ground(s.x, s.z).y;
  // input: held keys, the debug hooks' injected input, the touch sticks
  const keys = new Set(), inj = { forward: 0, strafe: 0, hurry: false }, stick = { forward: 0, strafe: 0, hurry: false };
  let on = false, locked = false, unlockedAt = -1e9;
  const look = (dx, dy) => {
    s.yaw -= dx * WALK.look;
    s.pitch = clamp(s.pitch - dy * WALK.look, -WALK.pitch, WALK.pitch);
  };
  const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
  const typing = (e) => { const t = e.target; return t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)); };
  const onKey = (e) => {
    if (!on || typing(e)) return;
    if (MOVE.has(e.code)) {
      if (e.type === 'keydown') keys.add(e.code); else keys.delete(e.code);
      if (e.code.startsWith('Arrow')) e.preventDefault();
    } else if (e.type === 'keydown' && e.code === 'Escape' && !locked && performance.now() - unlockedAt > 300 && onEscape) {
      // the first Esc releases the pointer (the browser's), a second leaves walk mode
      onEscape();
    }
  };
  const clearKeys = () => keys.clear();
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', clearKeys);
  const lock = () => {
    if (!canvas || !canvas.requestPointerLock || document.pointerLockElement === canvas) return;
    try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => {}); } catch (e) { /* drag to look instead */ }
  };
  const onLock = () => {
    locked = document.pointerLockElement === canvas;
    if (!locked) unlockedAt = performance.now();
  };
  document.addEventListener('pointerlockchange', onLock);
  const onMouse = (e) => { if (on && locked) look(e.movementX || 0, e.movementY || 0); };
  document.addEventListener('mousemove', onMouse);
  // the mouse: a click locks the pointer (dragging looks round where the browser refuses it); touch: two thumbs,
  // the left half of the screen walks (drag from where the thumb went down), the right half looks
  const touches = new Map();
  let drag = null;
  const onDown = (e) => {
    if (!on || !canvas) return;
    if (e.pointerType === 'touch') {
      const left = e.clientX < canvas.getBoundingClientRect().left + canvas.clientWidth / 2;
      touches.set(e.pointerId, { left, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
    } else if (e.button === 0) {
      lock();
      drag = { x: e.clientX, y: e.clientY };
    }
  };
  const onMove = (e) => {
    if (!on) return;
    const t = touches.get(e.pointerId);
    if (t) {
      if (!t.left) look((e.clientX - t.x) * 1.8, (e.clientY - t.y) * 1.8);
      t.x = e.clientX; t.y = e.clientY;
      stickFromTouches();
    } else if (drag && !locked && e.pointerType !== 'touch') {
      look(e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX; drag.y = e.clientY;
    }
  };
  const onUp = (e) => { if (touches.delete(e.pointerId)) stickFromTouches(); if (e.pointerType !== 'touch') drag = null; };
  function stickFromTouches() {
    stick.forward = stick.strafe = 0; stick.hurry = false;
    for (const t of touches.values()) {
      if (!t.left) continue;
      const dx = (t.x - t.x0) / 50, dy = (t.y - t.y0) / 50;
      stick.forward = clamp(-dy, -1, 1); stick.strafe = clamp(dx, -1, 1); stick.hurry = Math.hypot(dx, dy) > 1.8;
    }
  }
  if (canvas) {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }

  const k = (a, b) => (keys.has(a) || keys.has(b) ? 1 : 0);
  return {
    state: s,
    net,
    setActive(v) {
      on = !!v;
      if (!on) { keys.clear(); touches.clear(); drag = null; Object.assign(inj, { forward: 0, strafe: 0, hurry: false }); stickFromTouches(); if (document.pointerLockElement === canvas) document.exitPointerLock(); }
    },
    lock,
    // the debug hooks' input (held until changed); yaw, pitch: set the view (radians)
    input(o = {}) {
      if (o.forward !== undefined) inj.forward = clamp(+o.forward, -1, 1);
      if (o.strafe !== undefined) inj.strafe = clamp(+o.strafe, -1, 1);
      if (o.hurry !== undefined) inj.hurry = !!o.hurry;
      if (o.yaw !== undefined) s.yaw = +o.yaw;
      if (o.pitch !== undefined) s.pitch = clamp(+o.pitch, -WALK.pitch, WALK.pitch);
    },
    // stand at (x, z) (or the nearest place on the network), facing yaw
    moveTo(x, z, yaw) {
      const c = net.constrain(x, z);
      s.x = c.x; s.z = c.z; s.y = net.ground(s.x, s.z).y; s.vx = s.vz = s.speed = 0;
      if (yaw !== undefined) s.yaw = yaw;
    },
    update(dt, active) {
      let f = 0, st = 0;
      if (active) {
        f = clamp(k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown') + inj.forward + stick.forward, -1, 1);
        st = clamp(k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft') + inj.strafe + stick.strafe, -1, 1);
        const m = Math.hypot(f, st);
        if (m > 1) { f /= m; st /= m; }
      }
      s.hurry = active && (keys.has('ShiftLeft') || keys.has('ShiftRight') || inj.hurry || stick.hurry);
      const pace = s.hurry ? WALK.hurry : WALK.speed, sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
      // forward along the facing (sin yaw, cos yaw), right is (-cos yaw, sin yaw)
      const tx = (sy * f - cy * st) * pace, tz = (cy * f + sy * st) * pace;
      const a = 1 - Math.exp(-dt * WALK.accel);
      s.vx += (tx - s.vx) * a; s.vz += (tz - s.vz) * a;
      if (dt > 0 && (Math.abs(s.vx) + Math.abs(s.vz) > 1e-4)) {
        const c = net.constrain(s.x + s.vx * dt, s.z + s.vz * dt);
        // the pace is what the path let through: pressing into its edge doesn't build up speed
        let vx = (c.x - s.x) / dt, vz = (c.z - s.z) / dt;
        const v = Math.hypot(vx, vz), cap = WALK.hurry * 1.2;
        if (v > cap) { vx *= cap / v; vz *= cap / v; }
        s.vx = vx; s.vz = vz; s.x = c.x; s.z = c.z;
      } else { s.vx = s.vz = 0; }
      s.speed = Math.hypot(s.vx, s.vz);
      // the feet follow the ground, eased (the stairs' treads and the deck's ends don't jolt the view)
      const g = net.ground(s.x, s.z);
      s.surface = g.surface;
      s.y = Math.abs(g.y - s.y) > 1.5 ? g.y : s.y + (g.y - s.y) * (1 - Math.exp(-dt * 14));
    },
    // the eye in the world before the model has loaded (main.js eyeAt takes the model's): eyeLocal, an offset above
    // the feet in the figure's frame (+z forward), or WALK.eye straight up
    eye(eyeLocal, out = new THREE.Vector3()) {
      const ex = eyeLocal ? eyeLocal.x : 0, ey = eyeLocal ? eyeLocal.y : WALK.eye, ez = eyeLocal ? eyeLocal.z : 0;
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
      return out.set(s.x + c * ex + sn * ez, s.y + ey, s.z - sn * ex + c * ez);
    },
    // the way the eye looks
    dir(out = new THREE.Vector3()) {
      const cp = Math.cos(s.pitch);
      return out.set(Math.sin(s.yaw) * cp, Math.sin(s.pitch), Math.cos(s.yaw) * cp);
    },
    dispose() {
      window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); window.removeEventListener('blur', clearKeys);
      document.removeEventListener('pointerlockchange', onLock); document.removeEventListener('mousemove', onMouse);
      if (canvas) { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp); }
    },
  };
}
