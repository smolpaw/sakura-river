// Real mouse input on the live engine (run with LIVE=1): looks down hard, zooms all the way in and out, pans to the
// valley's edge and past it, spins, dives at the tree; records the camera every frame and prints per gesture the
// largest frame-to-frame jump of the camera and its target and how often the camera's height turned back (yFlips:
// jitter, e.g. a pan held against a limit). PNGs: bench/out/mouse-*.png.
//   LIVE=1 GPU=1 bench/gpu.sh node bench/look.mjs <build> --probe bench/probes/mouse.mjs     (CAMLOG=<file>: the frames as JSON)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default async (page, { shoot }) => {
  await page.evaluate(() => { H.set('time', 0.5); H.call('resetCamera'); });
  await sleep(2500);
  await page.evaluate(() => { window.__cam = []; const f = () => { const v = H.call('view'); window.__cam.push([performance.now(), ...v.pos, ...v.target]); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const box = await page.evaluate(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const mark = async (name) => { const n = await page.evaluate(() => window.__cam.length); console.log('mark', name, n); return n; };
  const drag = async (dx, dy, steps = 30, button = 'left', hold = 0) => {
    await page.mouse.move(cx, cy); await page.mouse.down({ button });
    for (let i = 1; i <= steps; i++) { await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps); await sleep(16); }
    if (hold) await sleep(hold);
    await page.mouse.up({ button });
  };
  const marks = [];
  // 1. look down hard (camera to the ground), hold
  marks.push(['down', await mark('down')]);
  await drag(0, -400, 30, 'left', 1500); await sleep(800); await shoot('out/mouse-1down.png');
  // 2. zoom fully in, then out
  marks.push(['zoomin', await mark('zoomin')]);
  for (let i = 0; i < 40; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel({ deltaY: -200 }); await sleep(30); }
  await sleep(1500); await shoot('out/mouse-2zoomin.png');
  marks.push(['zoomout', await mark('zoomout')]);
  for (let i = 0; i < 60; i++) { await page.mouse.wheel({ deltaY: 300 }); await sleep(30); }
  await sleep(1500); await shoot('out/mouse-3zoomout.png');
  // 3. pan far (right drag) several times in one direction
  marks.push(['pan', await mark('pan')]);
  for (let k = 0; k < 6; k++) await drag(-500, 0, 20, 'right');
  await sleep(1500); await shoot('out/mouse-4pan.png');
  for (let k = 0; k < 6; k++) await drag(0, 400, 20, 'right');
  await sleep(1500); await shoot('out/mouse-5pan2.png');
  // 4. look round fast
  marks.push(['spin', await mark('spin')]);
  await drag(1200, 0, 40); await drag(-2000, 150, 40); await sleep(1500); await shoot('out/mouse-6spin.png');
  // 5. reset, then dive at the tree: pan down + zoom in at the trunk
  await page.evaluate(() => H.call('resetCamera')); await sleep(2500);
  marks.push(['tree', await mark('tree')]);
  for (let i = 0; i < 30; i++) { await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.55); await page.mouse.wheel({ deltaY: -250 }); await sleep(30); }
  await drag(0, -300, 30, 'left', 500); await sleep(1500); await shoot('out/mouse-7tree.png');
  await drag(800, 0, 40); await sleep(1500); await shoot('out/mouse-8tree2.png');
  marks.push(['end', await mark('end')]);
  const cam = await page.evaluate(() => window.__cam);
  if (process.env.CAMLOG) (await import('node:fs')).writeFileSync(process.env.CAMLOG, JSON.stringify({ cam, marks }));
  // analysis: per segment, the largest frame-to-frame camera jump, and jitter = sign changes of camera y velocity while held
  for (let s = 0; s < marks.length - 1; s++) {
    const a = marks[s][1], b = marks[s + 1][1];
    let maxJ = 0, maxT = 0, flips = 0, lastV = 0, minY = Infinity;
    for (let i = a + 1; i < b; i++) {
      const p = cam[i], q = cam[i - 1];
      const j = Math.hypot(p[1] - q[1], p[2] - q[2], p[3] - q[3]), jt = Math.hypot(p[4] - q[4], p[5] - q[5], p[6] - q[6]);
      maxJ = Math.max(maxJ, j); maxT = Math.max(maxT, jt);
      const v = p[2] - q[2]; if (Math.abs(v) > 1e-3 && Math.abs(lastV) > 1e-3 && Math.sign(v) !== Math.sign(lastV)) flips++; if (Math.abs(v) > 1e-3) lastV = v;
      minY = Math.min(minY, p[2]);
    }
    console.log(marks[s][0], 'frames', b - a, 'maxCamJump', maxJ.toFixed(2), 'maxTgtJump', maxT.toFixed(2), 'yFlips', flips, 'end', cam[b - 1].slice(1).map((v) => v.toFixed(1)).join(','));
  }
  console.log('fps', (cam.length / ((cam[cam.length - 1][0] - cam[0][0]) / 1000)).toFixed(1));
};
