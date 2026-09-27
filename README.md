# Sakura River

A full-screen, interactive 3D scene built with Three.js. It shows a cherry tree beside a river that flows from a snow-capped, Fuji-style mountain, with a vermilion bridge, a pagoda, paper lanterns strung along both banks and koi in the river. Weather presets (clear, haze, petal storm, overcast, drizzle, downpour, thunderstorm) combine with any time of day; the clock runs a minute per second, and from dusk into the night the lanterns glow. Everything is generated in code: terrain, tree, grass, rocks, water, sky and petals. No image assets are used.

Live: https://smolpaw.github.io/sakura-river/ (deployed by GitHub Actions on every push to `main`).

## Develop

    pnpm install
    pnpm dev       # Vite dev server with live reload at http://localhost:5173
    pnpm build     # dist/index.html: one self-contained file (all JS and CSS inlined)
    pnpm preview   # serve the production build

`dist/index.html` opens directly in a browser; it is the deliverable.

## Layout

- `index.html`: page markup (title, weather and time panel, camera buttons, quality menu, loading veil).
- `src/ui.js`: wires the page controls to the engine.
- `src/style.css`: page styles.
- `src/main.js`: engine entry point: renderer, scene assembly, camera and controls, post-processing chain, adaptive quality, and the public API.
- `src/world.js`: height field, river path, terrain mesh, river ribbon, water-depth map and the finer map of rocks in the water (with the white water where the current breaks on them).
- `src/tree.js`: procedural cherry tree (Somei Yoshino form), single-flower blossoms, bark and flower textures.
- `src/vegetation.js`: instanced grass (split into tiles for frustum culling), wildflowers, rocks and distant forest.
- `src/props.js`: Fuji-style volcano, arched bridge and pagoda.
- `src/lanterns.js`: riverside paper lanterns on ropes between bamboo poles (generation).
- `src/water.js`: river shader and planar reflections.
- `src/koi.js`: koi swimming under the river surface.
- `src/sky.js`: sky dome, clouds and time-of-day palette.
- `src/weather.js`: weather presets and times of day, the sky under cloud cover, rain streaks and lightning.
- `src/petals.js`: simulated falling petals and the fallen-petal carpet.
- `src/fx.js`: petal, pollen-mote and lantern materials.
- `src/post.js`: light shafts pass and final grade (sharpening, local contrast, vignette).
- `src/tsl.js`: shared uniforms, noise, wind, height fog, the lanterns' light on their surroundings and the lit material (TSL: compiles to WGSL and GLSL).
- `src/materials.js`: the scene's lit materials.
- `src/quality.js`: adaptive quality controller.
- `src/gen/`: worker pool that runs the procedural generation jobs during loading.
- `src/noise.js`: seeded RNG, simplex noise and fbm.

## Engine API

    import { create } from './src/main.js';   // also exposed as window.SakuraRiver.create
    const scene = create(canvas, { quality, fixedQuality, hour, onStats, onCinematicChange });
    scene.setWeather(id, seconds);        // a preset from WEATHERS in src/weather.js, blended in
    scene.setTimeOfDay(hour, animate);    // 0..24; moves forward as an eased time-lapse
    scene.setClockRunning(true | false);  // a minute per second
    scene.timeOfDay();                    // current clock hour
    scene.set('wind' | 'petals' | 'river' | 'time' | 'fog' | 'bloom' | 'clouds' | 'rain' | 'lightning', value0to1);
    scene.setCinematic(true | false);
    scene.setAutoOrbit(true | false);
    scene.resetCamera();
    scene.dispose();

`quality` is optional ('high', 'medium' or 'low'). When it's left out, the quality level is picked from the device. With `fixedQuality` the adaptive resolution controller is off (the page does this when a quality is chosen by hand). `hour` is the starting clock hour. `set('time', t)` takes the old 0..1 scale (05:00..19:00; -0.08..1.08 reaches into the night).
