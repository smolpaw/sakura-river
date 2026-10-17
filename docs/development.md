# Development

The commands, the page's behaviour in detail, the file layout and the engine API. The asset credits are in [CREDITS.md](../CREDITS.md).

## Commands

    pnpm install
    pnpm dev       # dev server at http://localhost:5173
    pnpm build     # dist/index.html, one self-contained file
    pnpm preview   # serve the build

The page must be served over HTTP to load the sounds (`dist/audio/`), the walker's and the people's models (`dist/models/`) and the photographed textures (`dist/textures/`). Opened as a file, it runs without them.

Rebuild generated assets with `node tools/blender.mjs [name]` (the Blender models; needs `blender` on the PATH or `BLENDER=`), `node tools/audio.mjs` (the sounds; needs ffmpeg with libmp3lame and rubberband) and `node tools/textures.mjs` (the photographed textures and three's Basis transcoder; encoding needs Linux x86-64, since it fetches KTX-Software's Linux build of `ktx`; `--transcoder` only copies the transcoder, anywhere).

Every push to `main` deploys to https://smolpaw.github.io/sakura-river/ (`.github/workflows/pages.yml`), once a headless check finds the scene starting (`bench/check-dist.mjs`).

## Repeat visits

The built site registers a service worker (`src/sw.js`, written into `dist/sw.js` by the build) once the scene shows. GitHub Pages gives every file a new ETag on each deploy, so without it a returning visitor fetched everything again after any push.

- The page itself always comes from the network (revalidated, so an unchanged page costs a 304); the kept copy is used only offline. A deploy is therefore seen on the next load.
- The files from `public/` (textures, transcoder, models, the sounds fetched whole) are asked for as `<file>?v=<content hash>` (`src/assets.js`; the build puts the hashes into the page and the worker) and served from the worker's cache once fetched. The textures, the transcoder and the people's model are kept as soon as the worker installs; the rest as the page first asks for them.
- A deploy that changes a file changes its URL, so a new page never gets an old copy, even while the previous worker still runs it. Each deploy's `sw.js` differs, so the browser installs the new worker on the next visit; it takes over at once and drops the files its build no longer lists. Unchanged files keep their URLs and stay cached across deploys.
- The music streams through media elements with byte-range requests, which the worker leaves to the network (and the browser's cache).
- Opened as a file, or under `pnpm dev`, the page registers no worker. `pnpm build && BENCH_HEADLESS=1 node bench/sw-check.mjs` checks a first visit, a reload, a new deploy and a reload of it.

## Controls

Drag to look round, scroll or pinch to zoom, right-drag to pan. Buttons: Cinematic (a flight round the valley), Orbit, Walk and Reset view. In walk mode, W A S D or the arrow keys walk, the mouse looks (click to lock the pointer, Esc to release it; a second Esc leaves walk mode), and Shift hurries. On touch screens, the left thumb walks and the right one looks.

The panel picks the weather and the time: a preset, the time slider (the scene moves as it is dragged; its arrow keys step by half hours, Page Up and Page Down by two hours), or the dice beside each (another weather at random, or a random time at least two hours away). It also sets the music's and the nature sounds' volumes. The sound starts with the first click, tap or key press, since browsers hold it back until then. The buttons in the top corner copy a link to the view, hide the controls, mute the sound and go full screen. With the system's reduced-motion setting on, the page opens without its flight in, a new time is cut to rather than run as a time-lapse and the weather changes within a second; the cinematic flight still runs when started.

The address keeps the time, the weather and the view (or the walker's place): `#t=<hour>&w=<weather>&v=<x,y,z,tx,ty,tz>`, or `&walk=<x,z,yaw,pitch>` (metres, degrees), with no hash at the opening view at night in clear weather. A page opened from it starts there, flying in briefly. The link button copies it. The photo button or H hides every control and the title; H, Esc (outside walk mode) or the button that shows in the corner after a touch or a mouse movement brings them back.

Quality: Auto picks a tier and lowers the resolution under load; a tier picked by hand stays fixed. Frame rate: Auto runs at 60 fps; at Auto quality, where the browser reports GPU timings (WebGPU's timestamp queries, WebGL's timer-query extension), it drops to 30 before it lowers any detail. 60 and 30 hold that rate.

## Layout

- `index.html`, `src/style.css`, `src/ui.js`: the page and its controls.
- `src/main.js`: engine entry: renderer, scene assembly, camera modes, post chain, public API.
- `src/world.js`: terrain height field, river path, the village's paddies, lanes and building pads.
- `src/quality.js`: adaptive quality. `src/gen/`: worker pool for the generation done during loading. `src/noise.js`: the seeded random numbers and simplex noise.
- `src/tsl.js`, `src/materials.js`: shared shader nodes and the lit materials (TSL, compiled to WGSL and GLSL).
- `src/photos.js`, `src/kinds.js`: the photographed textures' loading, and the surface kinds that choose them. `src/textures.json`: each set's size in metres and average colour (written by `tools/textures.mjs`). `src/groundao.js`: the ground's occlusion by the buildings. `src/camerahull.js`: the height the orbit camera keeps over the buildings.
- `src/lods.js`, `src/impostors.js`: the instanced Blender models with their distance levels, culling and the woods' impostors.
- `src/lights.js`, `src/sunshadow.js`, `src/post.js`: the lamps' light map, the valley and cloud shadows, light shafts and the final grade.
- Scenery: `tree.js`, `blossoms.js`, `dropped.js` (whole flowers under the cherry), `grass.js`, `vegetation.js`, `props.js`, `temple.js`, `village.js`, `yard.js`, `wayside.js`, `lanterns.js`, `banners.js`, `boat.js`.
- Sky and water: `sky.js`, `weather.js`, `water.js`, `touches.js`, `petals.js`, `petalsgpu.js`, `fx.js`, `fireflies.js`.
- Animals and people: `koi.js`, `deer.js`, `heron.js`, `ducks.js`, `turtles.js`, `frogs.js`, `tanuki.js`, `birds.js`, `perched.js`, `butterflies.js`, `figures.js`.
- Walk mode: `walk.js` (where the walker can go, and the input), `walkgrid.js` (what blocks it, from the scene's own geometry), `walker.js` (the traveller's body).
- `src/audio.js`: music and ambience.
- `src/assets.js`, `src/sw.js`: the versioned URLs of the files from `public/` and the service worker that keeps them (Repeat visits). `vite.config.js`, `vite.plugins.mjs`: the build (one inlined page) and its plugins (the files' hashes, `dist/sw.js`, three's transcoder kept out of the page).
- `src/models/`: models inlined in the page. `public/models/`: models fetched later (the traveller, the people at work, the Ultra tier's near models). `public/audio/`: sounds. `public/textures/`: photographed textures. `public/basis/`: three's Basis transcoder for them.
- Bench only: `src/stress.js` (a heavier future-content scenario), `src/bench-hash.js` (hashes of every generated buffer, to prove the workers' output identical), `src/bench-probe-gpu.js` (per-pass GPU time and counters).
- `tools/`: model, audio and texture build scripts. `bench/`: headless capture and timing scripts. `docs/performance.md`: renderer performance notes. `docs/research/`: sourced notes on browser GPU facts and three r186's API.

## Engine API

    import { create } from './src/main.js';   // also window.SakuraRiver.create
    const scene = await create(canvas, { quality, fixedQuality, frameRate, backend, hour, view, introDuration, onProgress, onReady, onStats, onLost, onCinematicChange, onWalkChange });
    scene.setWeather(id, seconds);              // a preset from WEATHERS in src/weather.js
    scene.setTimeOfDay(hour, animate, forward); // 0..24, optionally as a time-lapse
    scene.followTime(hour);                     // eased there within a fraction of a second (a slider being dragged)
    scene.timeOfDay();
    scene.view();                               // { pos, target, flying, home } or, walking, { walk: [x, z, yaw, pitch], flying }
    scene.set('wind' | 'petals' | 'river' | 'time' | 'fog' | 'bloom' | 'clouds' | 'rain' | 'lightning', value0to1); // 'time': 0..1 is 05:00..19:00
    scene.setCinematic(on); scene.setAutoOrbit(on); scene.setWalk(on); scene.walking();
    scene.setSound(on); scene.setVolume('music' | 'nature', v); scene.soundWaiting();
    scene.setRenderScale(s);                    // 0.6..1
    scene.setFrameRate('auto' | 60 | 30);
    scene.resetCamera();
    scene.dispose();

- `view` opens on a view, flown into briefly: `{ pos: [x, y, z], target: [x, y, z] }`, or `{ walk: [x, z, yaw, pitch] }` (radians) to open walking there; anything else is ignored. `introDuration`: the opening flight's seconds (6.5 to the default view, 1.6 into `view`; 0 for none).
- `quality` is `'ultra' | 'high' | 'medium' | 'low'`. When it is omitted, the engine picks a tier for the device, never Ultra. `fixedQuality` turns off the adaptive resolution. `backend: 'webgl'` forces WebGL2.
- `create` rejects with `code` `'unsupported'` (no WebGPU or WebGL2), `'stalled'` (shader preparation hung) or `'lost'` (device lost during start-up).
- The callbacks: `onProgress({ stage, f, quality, backend })` during loading (`stage`: `'generate'`, `'build'`, `'shaders'`, `'warm'`), `onReady({ quality })` with the tier in use as the scene first shows, `onStats({ fps, rate, quality, level, scale, floor })` about once a second (`rate`: the frame rate it runs at, 60 or 30), `onLost({ api, message, reason })` on a lost device.
- The handle also carries debug hooks for headless checks, commented where `src/main.js` returns it.

