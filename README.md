# Sakura River

[![A cherry tree in bloom by a river, a red drum bridge, a pagoda and a snow-capped mountain](docs/screenshot.jpg)](https://smolpaw.github.io/sakura-river/)

A full-screen, interactive Three.js scene of a Japanese river valley in spring: a cherry tree in bloom by a river flowing from a Fuji-style mountain, a drum bridge, a farming village and rice terraces, a temple on a knoll. Sika deer keep their day's round on the far bank and watch whoever comes near, a heron fishes the shallows, ducks, turtles, a kingfisher and wagtails live along the river, white-eyes work the blossom, a fisherman and a rice planter work, skylarks sing high over the fields, and birds, butterflies, bats, frogs, a tanuki, koi and fireflies come and go with the hour. Seven weather presets combine with any time of day, and the lanes can be walked in first person.

Most of what you see is generated in code, and the models are built by Blender scripts in `tools/`. The exceptions are the boulders (scanned rocks, simplified in Blender), the photographed textures over the surfaces close up (bark, stone, thatch, timber, plaster, tiles, turf, earth, gravel), and the sound (recordings); all are credited below.

Live: https://smolpaw.github.io/sakura-river/ (every push to `main` deploys).

## Develop

    pnpm install
    pnpm dev       # dev server at http://localhost:5173
    pnpm build     # dist/index.html, one self-contained file
    pnpm preview   # serve the build

The page must be served over HTTP to load the sounds (`dist/audio/`) and the walker's and the people's models (`dist/models/`). Opened as a file, it runs without them.

Rebuild generated assets with `node tools/blender.mjs [name]` (the Blender models; needs `blender` on the PATH or `BLENDER=`) and `node tools/audio.mjs` (the sounds; needs ffmpeg).

## Controls

Drag to look round, scroll or pinch to zoom, right-drag to pan. Buttons: Cinematic (a flight round the valley), Orbit, Walk and Reset view. In walk mode, W A S D or the arrow keys walk, the mouse looks (click to lock the pointer, Esc to release it), and Shift hurries. On touch screens, the left thumb walks and the right one looks.

Quality: Auto picks a tier and lowers the resolution under load; a tier picked by hand stays fixed. Frame rate: Auto runs at 60 fps and drops to 30 on slow devices; 60 and 30 hold that rate.

## Layout

- `index.html`, `src/style.css`, `src/ui.js`: the page and its controls.
- `src/main.js`: engine entry: renderer, scene assembly, camera modes, post chain, public API.
- `src/world.js`: terrain height field, river path, the village's paddies, lanes and building pads.
- `src/quality.js`: adaptive quality. `src/gen/`: worker pool for the generation done during loading.
- `src/tsl.js`, `src/materials.js`: shared shader nodes and the lit materials (TSL, compiled to WGSL and GLSL).
- `src/photos.js`, `src/photo-worker.js`, `src/kinds.js`: the photographed textures' loading, and the surface kinds that choose them. `src/groundao.js`: the ground's occlusion by the buildings.
- `src/lods.js`, `src/impostors.js`: the instanced Blender models with their distance levels, culling and the woods' impostors.
- `src/lights.js`, `src/sunshadow.js`, `src/post.js`: the lamps' light map, the valley and cloud shadows, light shafts and the final grade.
- Scenery: `tree.js`, `blossoms.js`, `grass.js`, `vegetation.js`, `props.js`, `temple.js`, `village.js`, `wayside.js`, `lanterns.js`, `banners.js`, `boat.js`.
- Sky and water: `sky.js`, `weather.js`, `water.js`, `touches.js`, `petals.js`, `petalsgpu.js`, `fx.js`, `fireflies.js`.
- Animals and people: `koi.js`, `deer.js`, `heron.js`, `ducks.js`, `turtles.js`, `frogs.js`, `tanuki.js`, `birds.js`, `perched.js`, `butterflies.js`, `figures.js`.
- Walk mode: `walk.js` (the path network and the input), `walker.js` (the traveller's body).
- `src/audio.js`: music and ambience.
- `src/models/`: models inlined in the page. `public/models/`: models fetched later (the traveller, the people at work, the Ultra tier's near models). `public/audio/`: sounds. `public/textures/`: photographed textures.
- `tools/`: model, audio and texture build scripts. `bench/`: headless capture and timing scripts. `docs/performance.md`: renderer performance notes.

## Engine API

    import { create } from './src/main.js';   // also window.SakuraRiver.create
    const scene = await create(canvas, { quality, fixedQuality, frameRate, backend, hour, onProgress, onReady, onStats, onLost, onCinematicChange, onWalkChange });
    scene.setWeather(id, seconds);              // a preset from WEATHERS in src/weather.js
    scene.setTimeOfDay(hour, animate, forward); // 0..24, optionally as a time-lapse
    scene.timeOfDay();
    scene.set('wind' | 'petals' | 'river' | 'time' | 'fog' | 'bloom' | 'clouds' | 'rain' | 'lightning', value0to1);
    scene.setCinematic(on); scene.setAutoOrbit(on); scene.setWalk(on); scene.walking();
    scene.setSound(on); scene.setVolume('music' | 'nature', v); scene.soundWaiting();
    scene.setRenderScale(s);                    // 0.6..1
    scene.setFrameRate('auto' | 60 | 30);
    scene.resetCamera();
    scene.dispose();

- `quality` is `'ultra' | 'high' | 'medium' | 'low'`. When it is omitted, the engine picks a tier for the device, never Ultra. `fixedQuality` turns off the adaptive resolution. `backend: 'webgl'` forces WebGL2.
- `create` rejects with `code` `'unsupported'` (no WebGPU or WebGL2), `'stalled'` (shader preparation hung) or `'lost'` (device lost during start-up).
- The callbacks: `onProgress({ stage, f, quality, backend })` during loading, `onStats({ fps, quality, level, scale, floor })` about once a second, `onLost({ api, message, reason })` on a lost device.
- The handle also carries debug hooks for headless checks, commented where `src/main.js` returns it.

## Sound

The recordings come from the sources below, used under their licences. `tools/audio.mjs` lists the exact files and cuts. The files in `public/audio/` are edited from them: trimmed, looped, filtered and levelled. Files made from a share-alike (SA) source stay under that source's licence.

Music, by PeriTune (https://peritune.com), CC BY 4.0, unchanged apart from their tags:
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
- Waterwheel: "Watermill" by Pierre Sibanarco, BigSoundBank, CC0. https://bigsoundbank.com/mill-wheel-bladed-s2768.html
- Frogs: "1586 Dōbaru, Kokuraminami Ward, Kitakyushu, Fukuoka 803-0266, Japan - Frogs" by thomasmartinnutt, radio aporee, Public Domain Mark 1.0. https://archive.org/details/aporee_65287_75404
- The fisherman's tune (`fisher-*`; the humming lowered by three semitones): "Auld Lang Syne unmastered, whistles and hums" by fallbackcrush, Freesound, CC BY 4.0. https://freesound.org/people/fallbackcrush/sounds/413563/
- Bamboo: "Bamboo grove in Tsuji, Rittō City, Shiga Prefecture, Japan - Wind in Bamboo" by Greg Peterson, radio aporee, CC BY-SA 3.0. https://archive.org/details/aporee_43162_49194

Animals (xeno-canto recordings are CC BY-NC-SA 4.0):
- Sika deer's alarm whistles: XC961992 and XC961990, Sika Deer (*Cervus nippon*), Japan, by Joshua Chong, xeno-canto. https://xeno-canto.org/961992 https://xeno-canto.org/961990
- Grey heron's croaks: XC998335 and XC1102109, Grey Heron (*Ardea cinerea*), Ireland, by Paul Kelly, xeno-canto. https://xeno-canto.org/998335 https://xeno-canto.org/1102109
- Kingfisher's calls: XC785257, Common Kingfisher (*Alcedo atthis*), Sweden, by Teet Sirotkin, xeno-canto. https://xeno-canto.org/785257
- Japanese wagtail's flight calls: XC527476, Japanese Wagtail (*Motacilla grandis*), Japan, by Markus Jacobs, xeno-canto. https://xeno-canto.org/527476
- Skylark's song: XC283467, Eurasian Skylark (*Alauda arvensis japonica*), Erimo, Hokkaidō, by Antony Schubert, xeno-canto. https://xeno-canto.org/283467
- Spot-billed duck's quacks: XC858061, Eastern Spot-billed Duck (*Anas zonorhyncha*), Japan, by Joshua Chong, xeno-canto. https://xeno-canto.org/858061
- White-eye's song: XC993083, Warbling White-eye (*Zosterops japonicus*), Japan, by Xavier Riera, xeno-canto. https://xeno-canto.org/993083
- The plop into water: "Fishing Lure Plop Water - Game SFX (2 or 2)" by el_boss, Freesound, CC0. https://freesound.org/people/el_boss/sounds/853279/

Footsteps (every `step-*` file carries the geta recording's knock, so all of them are CC BY-SA 3.0):
- Geta: "Kamigyo Ward, Kyoto - wooden clogs" by OR poiesis, radio aporee, CC BY-SA 3.0. https://archive.org/details/aporee_25634_29691
- Boards: "Walk on Pontoon" by Joseph Sardin, BigSoundBank, CC0. https://bigsoundbank.com/walk-on-pontoon-s1845.html
- Earth: "Footsteps on Gravels #4" by Joseph Sardin and Axeline T., BigSoundBank, CC0. https://bigsoundbank.com/footsteps-on-gravels-4-s3216.html
- Grass: "Steps in the short grass" by Joseph Sardin, BigSoundBank, CC0. https://bigsoundbank.com/steps-in-the-short-grass-s0854.html

## Models

Every model is built by a Blender script in `tools/`, which describes what it builds at its top.

The boulders are photogrammetry scans from Poly Haven (https://polyhaven.com), CC0, which `tools/rocks.py` downloads, simplifies and shades: "Namaqualand Boulder 04" by Jenelle van Heerden, "Namaqualand Boulder 06" by Greg Zaal and Jenelle van Heerden, "Namaqualand Boulder 05" by Jenelle van Heerden and Dario Barresi, "Boulder 01" by Rico Cilliers, and one stone of "Namaqualand Boulders 01" by Greg Zaal and Jenelle van Heerden.

## Textures

Close up, these surfaces are photographed texture sets from Poly Haven (https://polyhaven.com), CC0, laid over the scene's own colours as detail. `tools/textures.mjs` downloads them into `public/textures/` as WebP.

- The cherries' bark: "Sakura Bark" by Charlotte Baglioni.
- The boulders, pebbles, the gorge's walls and the village's dry-stone walls: "Lichen Rock" by Rico Cilliers.
- The lanes' earth: "Stony Dirt Path" by eye-candy.xyz.
- The farmhouses' thatch: "Thatch Roof Angled" by Rob Tuytel and Dimitrios Savva.
- Timber (the houses, the temple, the bridge, the lamp posts, the boats; under the vermilion lacquer too): "Weathered Planks" by Dario Barresi and Dimitrios Savva.
- The storehouse's and the temple's plaster: "Grey Plaster 02" by Rob Tuytel.
- Roof tiles: "Grey Roof Tiles" by Rob Tuytel.
- Built stone (foundations, the temple's base, the bridge's abutments): "Japanese Stone Wall" by Rico Cilliers, Charlotte Baglioni and Dario Barresi.
- Carved stone (the Jizō, the stone lanterns, the lamps' feet): "Rock Surface" by Amal Kumar.
- The woods' bark: "Japanese Cedar Bark" by Charlotte Baglioni.
- The temple's gravel courtyard: "Gravel Ground 01" by Rob Tuytel.
- The ground under the grass and the green yards: "Forest Ground 01" by Rob Tuytel.
- Bare earth off the lanes (the yards, levees, dry paddies and banks): "Brown Mud 02" by Rob Tuytel.
