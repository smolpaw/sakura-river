# Sakura River

A full-screen, interactive 3D scene built with Three.js. It shows a cherry tree beside a river that flows from a snow-capped, Fuji-style mountain and bends away out of sight downstream under a crescent moon and a field of stars at night, with the odd shooting star, with a lantern-lit vermilion drum bridge, a farming village of thatched houses (kayabuki minka) with storehouses and sheds on stone-walled terraces among bamboo, and a hamlet on the slope across the river above its terraces, rice paddies on the valley floor and terraced up the slopes (tanada) above and below the cherry tree, most flooded for planting and mirroring the sky, some still dry or pink with renge, lanes between them, a waterwheel turning in the river by its mill, and a torii at the foot of the approach, stone lanterns in pairs up the approach to an old temple on a knoll (vermilion five-storey pagoda, main hall, bell tower, stone lanterns, lit up at night), red and white paper lanterns strung on ropes between wooden posts along both banks round the cherries, bonbori (paper lamps on wooden posts) along the rest of both banks from the gorge and the waterwheel above the bridge down to where the river bends away, two fire baskets (kagaribi) burning by the cherry tree at night, throwing sparks, paper lanterns hung by the farmhouses' doors, hearth smoke rising from their thatch (thickest at the morning and evening meals), koi in the river and fallen petals gathering into rafts along its banks, where reeds stand in clumps at the water's edge. On the far bank two sika hinds and a young stag in their spotted summer coats graze a patch of short turf, now and then walking on to a fresh spot. Birds fly over the valley by day: swallows hunt over the river (high in fair weather, skimming the water under heavy cloud and in drizzle, gone in heavy rain), black kites circle high on clear days, and crows fly home to the temple woods at dusk and out again at dawn; lightning scatters them. The hills, woods and buildings shadow the whole valley at any hour, cloud shadows drift over the land, and the far hills and the mountain fade into the air's haze. Weather presets (clear, haze, petal storm, overcast, drizzle, downpour, thunderstorm) combine with any time of day, and rain soaks the ground darker and leaves puddles on the lanes; the time of day stays where it is set (one of four presets, or any half hour on a slider) and moves to a new one as a time-lapse, mist lies on the river around dawn, and from dusk into the night the lanterns glow and the farmhouses' shoji light up. Koto and shakuhachi music plays over the sound of the scene: the river (louder and clearer near it), water lapping under the bridge, wind, rain, thunder after each lightning strike, birds and bush warblers by day, and the temple bell as the lanterns come on. Everything you see is generated in code: terrain, trees, grass, rocks, water, sky and petals. The grass covers the whole valley, placed by the GPU around the camera, with drifts of dandelions, clover, violets and renge in it. Shrubs grow along the woods' edges and the lanes (dwarf bamboo, kerria in yellow flower) and clipped azaleas in magenta and white bloom line the temple's approach and stand round the farmhouses. The village's buildings, the trees in the woods on the hills, the bamboo round the temple and the village, the rock walls of the gorge above the bridge, the boulders along the river and the cherries' trunks and main limbs are modelled by Blender scripts (see Models). No image assets are used. The exceptions are the deer, which are ready-made models (see Models), and the sounds, which are recordings (see Sound).

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
- `src/world.js`: height field, river path, the village's farmland (paddies stepped into the land along its contours, rectangular on the valley floor), lanes and building pads, terrain mesh (with the grass grown at each vertex) and the finer mesh over the farmland and the village, river ribbon, water-depth map and the finer map of rocks in the water (with the white water where the current breaks on them).
- `src/tree.js`: procedural cherry tree (Somei Yoshino form) in full bloom, single-flower blossoms, bark and flower textures; its trunk and main limbs are a Blender model grown from the same skeleton (`trunkSkeleton`).
- `src/blossoms.js`: the main tree's flowers near the camera drawn as a modelled flower instead of the painted card.
- `src/grass.js`: the meadow's grass, placed on the GPU around the camera out to 240 m (300 m on ultra): blades on world-fixed cells in levels of coarser cells and thinner density with distance, standing on the terrain mesh's own grid (heights and the grass grown there, from `world.js`), the ground under them coloured to match.
- `src/vegetation.js`: the deer's turf, wildflowers, rocks, the rock walls lining the gorge where the river cuts through the temple's knoll, the bamboo groves behind the temple, and where the woods on the hills grow: groves of cedar, cypress, oak and wild cherry, and black pines on the cliff rims.
- `src/impostors.js`: the woods' trees beyond 140 m as impostors: their full models baked at start-up into views from a hemisphere of directions (colour and normals), drawn as cards turned to the camera, blending the four nearest views.
- `src/lods.js`: the Blender-built models (the woods' trees, the gorge's walls, the bamboo, the river's boulders, the village's buildings), instanced, a full model and lighter ones for each kind switched by distance; and many copies of one small model merged (the village's stone walls).
- `src/village.js`: where the village's buildings and the torii stand (world.js lays out their pads); the farmhouses' door lanterns and the stone lanterns up the temple's approach (generation).
- `src/models/shrubs.glb`: the shrubs, built by `tools/shrubs.py` (azaleas, kerria, dwarf bamboo: mounds of leafy clumps fused as the woods' crowns, their flowers broken into spots by the page's shader); `vegetation.js` places them.
- `src/props.js`: Fuji-style volcano and arched bridge (with its lanterns' hanging points).
- `src/temple.js`: the old temple compound on its terrace (generation), with its lamp and floodlight positions.
- `src/lanterns.js`: the riverside's lamps: paper lanterns on ropes between posts round the cherries, bonbori along the rest of the banks, the fire baskets by the cherry tree (generation).
- `src/models/lamps.glb`: the lantern lines' posts, the bonbori and the fire baskets, built by `tools/lamps.py`.
- `src/lights.js`: the light map: every lamp's light on its surroundings summed into one texture at start-up.
- `src/sunshadow.js`: the sun's shadows beyond the sharp ones round the cherry tree: the valley's shadow map (the hills, woods and buildings shadowing the whole valley, redrawn when the sun has moved) and the clouds' shadows drifting over the land.
- `src/water.js`: river shader and planar reflections, and the mist on the river at dawn.
- `src/koi.js`: koi of eight varieties swimming under the river surface in two loose groups, steering round the rocks and each other.
- `src/deer.js`: the grazing deer: models loaded and lit like the scene, their grazing clip looped mostly head-down.
- `src/models/`: models inlined in the page: the deer, built by `tools/models.mjs` (`node tools/models.mjs`) from the sources in Models, and the woods' trees, the gorge's walls, the bamboo, the boulders and the cherries' trunks (`forest.glb`, `cliffs.glb`, `bamboo.glb`, `rocks.glb`, `cherry.glb`), built in Blender by `tools/forest.py`, `tools/cliffs.py`, `tools/bamboo.py`, `tools/rocks.py` and `tools/cherry.py` (`node tools/blender.mjs`; `tools/cherry.mjs` hands `cherry.py` the trees' skeletons).
- `src/birds.js`: birds in flight (swallows, kites, crows): their paths by weather and time of day, wings flapped in the vertex stage.
- `src/sky.js`: sky dome, moon, stars and shooting stars, clouds and time-of-day palette.
- `src/weather.js`: weather presets and times of day, the sky under cloud cover, rain streaks and lightning.
- `src/petalsgpu.js`: on WebGPU, the falling petals simulated in a compute pass, from every cherry.
- `src/petals.js`: simulated falling petals (on the CPU: the WebGL fallback), the fallen-petal carpet and the petal rafts on the water.
- `src/fx.js`: petal, pollen-mote and lantern materials, the temple's and the stone lanterns' glows.
- `src/post.js`: light shafts pass, final grade (sharpening, local contrast, vignette) and, on ultra, the supersampled image's downsample.
- `src/audio.js`: music and ambience (Web Audio): loops mixed from the weather, the clock and the camera, thunder, bird songs, the evening bell.
- `public/audio/`: the sound files, built by `tools/audio.mjs` (`node tools/audio.mjs`, needs ffmpeg) from the sources below.
- `src/tsl.js`: shared uniforms, noise, wind, height fog, the lamps' light on their surroundings (read from the light map) and the lit material (TSL: compiles to WGSL and GLSL).
- `src/materials.js`: the scene's lit materials.
- `src/quality.js`: adaptive quality controller.
- `src/gen/`: worker pool that runs the procedural generation jobs during loading.
- `src/noise.js`: seeded RNG, simplex noise and fbm.

## Engine API

    import { create } from './src/main.js';   // also exposed as window.SakuraRiver.create
    const scene = create(canvas, { quality, fixedQuality, hour, onStats, onCinematicChange });
    scene.setWeather(id, seconds);        // a preset from WEATHERS in src/weather.js, blended in
    scene.setTimeOfDay(hour, animate, forward); // 0..24; an eased time-lapse, forward through midnight or (forward false) straight there
    scene.timeOfDay();                    // current clock hour (fixed between time-lapses: the clock doesn't tick)
    scene.set('wind' | 'petals' | 'river' | 'time' | 'fog' | 'bloom' | 'clouds' | 'rain' | 'lightning', value0to1);
    scene.setCinematic(true | false);
    scene.setAutoOrbit(true | false);
    scene.setSound(true | false);         // starts with the page's first click or key press if it has had none
    scene.setVolume('music' | 'nature', value0to1);
    scene.soundWaiting();                 // true while the browser holds sound back until a click or key press
    scene.resetCamera();
    scene.dispose();

`quality` is optional ('ultra', 'high', 'medium' or 'low'). When it's left out, the quality level is picked from the device, never ultra: ultra supersamples the scene and raises the detail beyond high with no regard for frame rate, for strong GPUs (docs/performance.md, Ultra). With `fixedQuality` the adaptive resolution controller is off (the page does this when a quality is chosen by hand). `hour` is the starting clock hour. `set('time', t)` takes the old 0..1 scale (05:00..19:00; -0.08..1.08 reaches into the night).

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

## Models

The woods' trees (`src/models/forest.glb`), the gorge's rock walls (`src/models/cliffs.glb`), the bamboo (`src/models/bamboo.glb`), the river's boulders (`src/models/rocks.glb`) the cherries' trunks (`src/models/cherry.glb`), the village's buildings (`src/models/village.glb`), the shrubs (`src/models/shrubs.glb`) and the riverside's lamps (`src/models/lamps.glb`) are made by Blender scripts, `tools/forest.py`, `tools/cliffs.py`, `tools/bamboo.py`, `tools/rocks.py`, `tools/cherry.py`, `tools/village.py`, `tools/shrubs.py` and `tools/lamps.py`: `node tools/blender.mjs` runs them (it needs `blender` on the PATH, or `BLENDER=/path/to/blender`; `node tools/blender.mjs cliffs` builds one) and compresses the results. Each kind (sugi, hinoki, konara, kashi, wild cherry, black pine) is a crown of foliage clumps fused into one surface and decimated to a triangle budget, on tapered limbs, with its shading baked into the vertex colours (ambient occlusion by ray casting) and its normals bent out from the crown's middle; each also has lighter `_far` and `_dist` models, which beyond 140 m only cast the trees' shadows: there the page draws impostors, cards showing pictures of the full model baked at start-up from 64 directions (`src/impostors.js`), lit like the models. The near model also carries leaf cards (`<kind>_leaves`): a few hundred small quads scattered over the crown, facing out, cut from a leaf atlas the page paints at start-up (broadleaf sprays, sugi/hinoki fronds, pine needles, wild cherry blossom), so the crown's edge is leaves rather than a hull. The gorge's walls are bedded rock: layers of broken blocks split by vertical joints into ribs and fissures, fused into one surface, weathered and decimated, with moss on the ledges and over the rim baked into the vertex colours; three walls, each with a `_far` model, placed overlapping along both banks, where the ground behind them rises in a straight slope (`src/world.js`). The bamboo is two stands of moso culms, young green to old yellowed grey, arching over under drooping sprays of leaves (fused like the woods' crowns), each in three levels like the trees, set close together in groves behind and beside the temple. The boulders are granite rounded by the river, some with the broad faces they split along, lumpy and grained, with lichen, moss and occlusion in their vertex colours; five of them, each with a `_far` model, and one small stone for the pebbles at the water's edge and the village's dry-stone walls (with a `_far` model for those). The village's buildings: two farmhouses (minka) under thick thatch, a hip-and-gable (irimoya) one with its small smoke gable and a hipped (yosemune) one, their thatch a voxel-rounded solid with lumps, rain streaks, moss and pale cut ends at the eaves, a ridge with saddles; posts and beams, white plaster, board walls, shoji behind an open veranda (engawa), the earthen-floored entrance's door slid aside; a white storehouse (kura) with its tiled namako skirt under a tile roof; a board shed with firewood stacked along it; a vermilion torii; a waterwheel's mill hut and its wheel (a model of its own, which the page turns with the river's speed). Their shading (ambient occlusion by ray casting) is in the vertex colours, and how much the shoji glow after dusk in their alpha; each has a `_far` model. The riverside's lamps, made the same way: a weathered cedar post with a rain cap and the rope's turns and knot round it for the lantern lines; a bonbori, a hexagonal washi shade with a red band on a dark frame under a little hexagonal roof, on a cedar post and stone footing; a kagaribi, an iron fire basket on three crossed legs with split pine stacked over glowing coals (the page draws the flames). The cherries' trunks are grown from the trees' own skeletons (`src/tree.js` grows each tree; `tools/cherry.mjs` hands the roots, trunk and main limbs to `tools/cherry.py`): balls strung along each branch and fused as metaballs, so the forks blend into each other, with ridges twisting up the trunk, burls and buttressed roots diving into the ground, bark grain, and the page's bark texture mapped round and along the nearest branch; shading and the wind's flexibility are in the vertex colours. The page grows the finer branches and twigs itself onto them. The same file holds the flower drawn near the camera in place of the painted card: five broad petals notched at the tip, cupped, pink at the base and fading to white, round the red cup with its stamens. The model only fits the skeleton it was built from: after changing how the trees grow (or where they stand, or the ground under them), rebuild it (`node tools/blender.mjs cherry`); the page warns in the console when it no longer fits.

The deer are from the Ultimate Animated Animal Pack by Quaternius (https://quaternius.com/packs/ultimateanimatedanimals.html), CC0: "Deer" (the hinds) and "Stag", as served by Poly Pizza (https://poly.pizza/m/T6Cs7tmMHJ, https://poly.pizza/m/tQdzbZ1Cmw). `tools/models.mjs` keeps only their grazing and walking clips, bakes in the coat's base colours, subdivides their bodies to a rounder shape (twice the source's triangles) and compresses them; The models are generic deer: `src/deer.js` reshapes them to a sika's build (shorter legs and neck, a smaller head, smaller overall), paints the sika's spots, spine line, rump patch and tail over them and shortens the stag's antlers.
