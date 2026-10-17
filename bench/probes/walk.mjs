// Walk mode's ground (walk.js, walkgrid.js): prints FAIL lines for what a walker would hit.
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/look.mjs <build> --probe bench/probes/walk.mjs [shots]
// - reach: a flood fill of where the walker's body fits, from the footpath by the cherry tree (the bridge joining its
//   banks): the landings, the temple's steps, the hamlet, the village's end and each farmhouse's yard (those on pads
//   walled all round are reported, not failed: their walls are seen);
// - bridge: across the deck both ways at seven offsets from its middle, onto the far bank;
// - stops: straight walks from eight places in twelve directions; each stop is reported with what blocks there
//   (solid, bridge, temple, water/steep/edge) ahead within the body's width, and FAIL where nothing in the grid does. `shots`: that many of the
//   stops at a solid captured, looking ahead (bench/out/walk-stop-<n>.png), to see that something stands there.
import { createWorld } from '../../src/world.js';
const w = createWorld(7);
export default async (page, { args, shoot }) => {
  const places = { tree: [-22, -4.6], bridgeW: [-36, -57], bridgeE: [-10, -65], stairFoot: [2.4, -175], hamlet: [44.5, -131], villageEnd: [-90, -240] };
  const yards = {};
  for (const [i, b] of w.BUILDINGS.entries()) { const r = b.hd + b.yard * 0.6; yards[`${b.kind}#${i}`] = [b.x + Math.sin(b.yaw) * r, b.z + Math.cos(b.yaw) * r]; }
  const r = await page.evaluate(async (places, yards) => {
    await H.call('setWalk', true);
    const g = H.call('walkGrid'), C = g.cell, [bx, bz] = g.bounds, nx = g.nx, nz = g.nz;
    const ok = (i, j) => g.open(bx + (i + 0.5) * C, bz + (j + 0.5) * C) >= 0.3;
    const seen = new Uint8Array(nx * nz), q = [];
    const push = (x, z) => { const i = Math.floor((x - bx) / C), j = Math.floor((z - bz) / C); if (ok(i, j) && !seen[j * nx + i]) { seen[j * nx + i] = 1; q.push(j * nx + i); } };
    const flood = () => { while (q.length) { const k = q.pop(), i = k % nx, j = (k / nx) | 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const kk = b * nx + a; if (!seen[kk] && ok(a, b)) { seen[kk] = 1; q.push(kk); } } } };
    push(...places.tree); flood();
    const near = (p) => { for (let d = 0; d <= 2.5; d += 0.25) for (let a = 0; a < 12; a++) { const x = p[0] + Math.cos(a / 12 * 6.283) * d, z = p[1] + Math.sin(a / 12 * 6.283) * d, i = Math.floor((x - bx) / C), j = Math.floor((z - bz) / C); if (seen[j * nx + i]) return true; } return false; };
    if (near(places.bridgeW) || near(places.bridgeE)) { push(...places.bridgeW); push(...places.bridgeE); flood(); }
    const reach = Object.fromEntries(Object.entries(places).map(([k, p]) => [k, near(p)]));
    const yard = Object.fromEntries(Object.entries(yards).map(([k, p]) => [k, near(p)]));
    // across the bridge
    const info = H.call('walkInfo', true), [e0, e1] = info.bridgeEnds;
    const ax = e1[0] - e0[0], az = e1[2] - e0[2], L = Math.hypot(ax, az), ux = ax / L, uz = az / L;
    const bridge = [];
    for (const dir of [1, -1]) for (const lat of [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9]) {
      const s = dir > 0 ? e0 : e1, yaw = Math.atan2(dir * ux, dir * uz);
      H.call('walkTo', s[0] - dir * ux * 3 - uz * lat, s[2] - dir * uz * 3 + ux * lat, yaw);
      H.call('walkInput', { forward: 1, yaw });
      H.call('advance', 600, 1 / 30);
      const p = H.call('walkInfo').pos, along = (p[0] - e0[0]) * ux + (p[2] - e0[2]) * uz;
      bridge.push({ dir, lat, along: +along.toFixed(2), ok: dir > 0 ? along > L + 1 : along < -1 });
    }
    // straight walks
    const flagAt = (x, z) => g.flags[Math.floor((z - bz) / C) * nx + Math.floor((x - bx) / C)];
    const stops = [];
    for (const [sx, sz] of [[-22, -4.6], [-36, -58], [-60, -78], [-90, -150], [0, -100], [30, -115], [-5, 20], [10, -40]]) for (let k = 0; k < 12; k++) {
      const yaw = (k / 12) * Math.PI * 2;
      H.call('walkTo', sx, sz, yaw); H.call('walkInput', { forward: 1, yaw });
      let slow = 0;
      for (let t = 0; t < 600 && slow <= 10; t++) { H.call('advance', 1, 1 / 30); slow = t > 15 && H.call('walkInfo').speed < 0.15 ? slow + 1 : 0; }
      if (slow <= 10) continue;
      const p = H.call('walkInfo').pos;
      // (ahead, the body's width either side)
      let f = 0;
      for (let d = 0; d <= 0.8; d += 0.1) for (let l = -0.4; l <= 0.4; l += 0.1) f |= flagAt(p[0] + Math.sin(yaw) * d + Math.cos(yaw) * l, p[2] + Math.cos(yaw) * d - Math.sin(yaw) * l);
      stops.push({ at: [+p[0].toFixed(1), +p[2].toFixed(1)], yaw: +yaw.toFixed(2), f });
    }
    H.call('walkInput', { forward: 0 });
    return { reach, yard, bridge, stops };
  }, places, yards);
  const names = (f) => [f & 1 && 'solid', f & 2 && 'bridge', f & 4 && 'temple', f & 8 && 'water/steep/edge'].filter(Boolean).join('+');
  for (const [k, v] of Object.entries(r.reach)) console.log(v ? 'ok  ' : 'FAIL', 'reach', k);
  console.log('yards walled off:', Object.entries(r.yard).filter(([, v]) => !v).map(([k]) => k).join(' ') || 'none');
  for (const b of r.bridge) if (!b.ok) console.log('FAIL bridge', JSON.stringify(b));
  console.log(`bridge: ${r.bridge.filter((b) => b.ok).length}/${r.bridge.length} crossings`);
  for (const s of r.stops) console.log(s.f ? 'stop' : 'FAIL stop at nothing', s.at.join(','), 'facing', s.yaw, names(s.f));
  let n = 0;
  for (const s of r.stops.filter((s) => s.f & 1).slice(0, +(args[0] || 0))) {
    await page.evaluate(async (s) => { H.call('walkTo', s.at[0], s.at[1], s.yaw); H.call('walkInput', { pitch: -0.35 }); H.call('advance', 30); await H.frames(10, 1 / 60); }, s);
    await shoot(`out/walk-stop-${n++}.png`);
  }
};
