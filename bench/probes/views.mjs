// Stills: views at times of day (set('time') units, 0..1 from 05:00 to 19:00), saved to bench/out/qa/<PFX>-<id>-t<time>.png.
//   [GPU=1] node bench/qa-eval.mjs <build> bench/probes/views.mjs <time,...> <id>=x,y,z:tx,ty,tz | <id>=hero | <id>=cine:0.25 ...
// SET='{"rain":1}' adds settings; PFX names the files (default v).
export default async (page, { args, shoot }) => {
  const [times, ...vs] = args;
  const set = JSON.parse(process.env.SET || '{}');
  for (const t of times.split(',')) for (const v of vs) {
    const [id, spec] = v.split('=');
    let view;
    if (spec === 'hero') view = { hero: true };
    else if (spec.startsWith('cine:')) view = { cine: +spec.slice(5) };
    else { const [p, q] = spec.split(':').map((s) => s.split(',').map(Number)); view = { pos: p, target: q }; }
    await page.evaluate((view, t, set) => { H.view({ ...view, settings: { time: +t, ...set } }, 90); H.call('tick', 32); }, view, t, set);
    await shoot(`out/qa/${process.env.PFX || 'v'}-${id}-t${t}.png`);
  }
};
