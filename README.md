# Sakura River

A full-screen, interactive 3D scene built with Three.js. It shows a cherry tree beside a river that flows from a snow-capped, Fuji-style mountain under a crescent moon at night, with a lantern-lit vermilion drum bridge, an old temple on a knoll (five-storey pagoda, main hall, bell tower, stone lanterns, lit up at night), paper lanterns strung along both banks and koi in the river. Birds fly over the valley by day: swallows hunt over the river (high in fair weather, skimming the water under heavy cloud and in drizzle, gone in heavy rain), black kites circle high on clear days, and crows fly home to the temple woods at dusk and out again at dawn; lightning scatters them. Weather presets (clear, haze, petal storm, overcast, drizzle, downpour, thunderstorm) combine with any time of day; the clock runs a minute per second, and from dusk into the night the lanterns glow. Koto and shakuhachi music plays over the sound of the scene: the river (louder and clearer near it), water lapping under the bridge, wind, rain, thunder after each lightning strike, birds and bush warblers by day, and the temple bell as the lanterns come on. Everything you see is generated in code: terrain, tree, grass, rocks, water, sky and petals. No image assets are used; the sounds are recordings (see Sound).

Live: https://smolpaw.github.io/sakura-river/ (deployed by GitHub Actions on every push to `main`).

## Develop

    pnpm install
    pnpm dev       # Vite dev server with live reload at http://localhost:5173
    pnpm build     # dist/index.html: one self-contained file (all JS and CSS inlined)
    pnpm preview   # serve the production build

`dist/index.html` opens directly in a browser; it is the deliverable. The sound files sit next to it in `dist/audio/` and are fetched only when sound plays, so the page needs to be served over HTTP (`pnpm preview`, GitHub Pages) to have sound; opened as a file, it runs silent.

## Layout

- `index.html`: page markup (title, weather and time panel, camera buttons, quality menu, loading veil).
- `src/ui.js`: wires the page controls to the engine.
- `src/style.css`: page styles.
- `src/main.js`: engine entry point: renderer, scene assembly, camera and controls, post-processing chain, adaptive quality, and the public API.
- `src/world.js`: height field, river path, terrain mesh, river ribbon, water-depth map and the finer map of rocks in the water (with the white water where the current breaks on them).
- `src/tree.js`: procedural cherry tree (Somei Yoshino form), single-flower blossoms, bark and flower textures.
- `src/vegetation.js`: instanced grass (split into tiles for frustum culling), wildflowers, rocks, and the woods on the hills: groves of cedar, cypress, oak and wild cherry, and black pines on the cliff rims.
- `src/props.js`: Fuji-style volcano and arched bridge (with its lanterns' hanging points).
- `src/temple.js`: the old temple compound on its terrace (generation), with its lamp and floodlight positions.
- `src/lanterns.js`: riverside paper lanterns on ropes between bamboo poles (generation).
- `src/water.js`: river shader and planar reflections.
- `src/koi.js`: koi swimming under the river surface.
- `src/birds.js`: birds in flight (swallows, kites, crows): their paths by weather and time of day, wings flapped in the vertex stage.
- `src/sky.js`: sky dome, moon, clouds and time-of-day palette.
- `src/weather.js`: weather presets and times of day, the sky under cloud cover, rain streaks and lightning.
- `src/petals.js`: simulated falling petals and the fallen-petal carpet.
- `src/fx.js`: petal, pollen-mote and lantern materials, the temple lamps' glows.
- `src/post.js`: light shafts pass and final grade (sharpening, local contrast, vignette).
- `src/audio.js`: music and ambience (Web Audio): loops mixed from the weather, the clock and the camera, thunder, bird songs, the evening bell.
- `public/audio/`: the sound files, built by `tools/audio.mjs` (`node tools/audio.mjs`, needs ffmpeg) from the sources below.
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
    scene.setSound(true | false);         // starts with the page's first click or key press if it has had none
    scene.setVolume('music' | 'nature', value0to1);
    scene.soundWaiting();                 // true while the browser holds sound back until a click or key press
    scene.resetCamera();
    scene.dispose();

`quality` is optional ('high', 'medium' or 'low'). When it's left out, the quality level is picked from the device. With `fixedQuality` the adaptive resolution controller is off (the page does this when a quality is chosen by hand). `hour` is the starting clock hour. `set('time', t)` takes the old 0..1 scale (05:00..19:00; -0.08..1.08 reaches into the night).

## Sound

The recordings come from the sources below, used under their licences. `tools/audio.mjs` lists the exact files and cuts. The loops and one-shots in `public/audio/` are edited from them: trimmed, crossfaded into loops, filtered and levelled. Files made from a share-alike (SA) source stay under that source's licence.

Music, by PeriTune (https://peritune.com), CC BY 4.0. The files are unchanged apart from their tags.
- "Sakuya3": https://peritune.com/blog/2016/10/18/sakuya3/
- "Oboro": https://peritune.com/blog/2019/04/08/oboro/
- "Shizima4": https://peritune.com/blog/2021/06/06/shizima4/

Ambience:
- River: "Mountain stream #1" by Pierre Sibanarco, BigSoundBank, CC0. https://bigsoundbank.com/mountain-stream-1-s2754.html
- Breeze: "Wind in shrub" by Joseph Sardin, BigSoundBank, CC0. https://bigsoundbank.com/wind-in-shrub-s0907.html
- Gale: "Strong wind and trees #1" by Joseph Sardin, BigSoundBank, CC0. https://bigsoundbank.com/strong-wind-and-trees-1-s1450.html
- Thunder: "Thunder" recordings 2718, 3114, 3115, 3116, 3179, 3181 and 3182 by Joseph Sardin (3181 with Axeline T.), BigSoundBank, CC0. https://bigsoundbank.com (search "thunder")
- Heavy rain: "AMB Rain Loop 2" by Kresiek The Furry, OpenGameArt, CC0. https://opengameart.org/content/amb-rain-loop-2
- Drizzle: "Choishi Michi Trail Forest Rain and Birds Near Koyasan Japan" by Lawrence Dolton, radio aporee, CC BY-NC-SA 3.0. https://archive.org/details/aporee_69094_80175
- Birds: "Kamikosawa Canyon Forest Near Koyasan Japan - Forest Birds Quiet" by Lawrence Dolton, radio aporee, CC BY-NC-SA 3.0. https://archive.org/details/aporee_68851_79871
- Water under the bridge: "easy lapping of waves on the rocks-birds, White Sea, Russia" by Nikolaj Terent'ev, radio aporee, CC BY 3.0. https://archive.org/details/aporee_24924_28918
- Temple bell: "Mii-dera" (the evening bell of Mii-dera, Ōtsu), radio aporee, Public Domain Mark 1.0. https://archive.org/details/aporee_31518_36212
- Bush warbler: XC993079, Japanese Bush Warbler (*Horornis diphone*), Karuizawa, by Xavier Riera, xeno-canto, CC BY-NC-SA 4.0. https://xeno-canto.org/993079
