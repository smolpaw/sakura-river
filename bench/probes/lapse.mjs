// A time-lapse from the hero view: from time `from` (set('time') units) to clock hour `to`, one rendered frame per
// browser frame, a capture every `every` frames (bench/out/lapse-<frame>.png) with the hour printed; look through
// them in order for a pop in the light or a jump in the shadows.
//   BENCH_HEADLESS=1 LOOK_BACKEND=webgl node bench/look.mjs <build> --probe bench/probes/lapse.mjs [from] [to] [frames] [every]
export default async (page, { args, shoot }) => {
  const [from, to, frames, every] = [+(args[0] ?? 0.75), +(args[1] ?? 20.5), +(args[2] ?? 720), +(args[3] ?? 12)];
  await page.evaluate((f) => { H.view({ hero: true, settings: { time: f } }, 120); H.call('tick', 32); }, from);
  await page.evaluate((h) => H.call('setTimeOfDay', h, true, true), to);
  for (let f = 0; f < frames; f += every) {
    await page.evaluate((n) => H.frames(n, 1 / 60), every - 1);
    const name = `out/lapse-${String(f).padStart(4, '0')}.png`;
    await shoot(name);
    const hour = await page.evaluate(() => H.call('timeOfDay'));
    console.log(name, 'hour', hour.toFixed(2));
  }
};
