# Sakura River

Procedural Three.js scene (cherry tree, river, Fuji-style mountain). See README.md for commands, file layout and the engine API.

## Working here

- The owner cares about results, not about knowing the code. The GitHub issue workflow from the global instructions does not apply to this project. Any language or stack is fine when measurements show it helps.
- `docs/performance.md`: what the renderer does for speed, what was rejected and why, open cross-GPU risks. Check it before adding anything that costs GPU time, and add new findings there.

## Conventions

- Everything visual is generated in code — no image or texture assets, no hand-made models. Code includes Blender Python scripts in `tools/` that build models into `src/models/` (owner, 2026-09-30, who has Blender installed and doesn't use it themselves: modelling there is Claude's job); the woods' trees, the gorge's rock walls, the bamboo, the river's boulders, the cherries' trunks, the village's buildings, the shrubs and the riverside's lamps are built this way (`tools/forest.py`, `tools/cliffs.py`, `tools/bamboo.py`, `tools/rocks.py`, `tools/cherry.py`, `tools/village.py`, `tools/shrubs.py`, `tools/lamps.py`, run by `node tools/blender.mjs`). The cherries' trunks are built from the skeletons `src/tree.js` grows: any change to how the trees grow, where they stand or the ground under them needs `node tools/blender.mjs cherry` (the page warns in the console when the model no longer fits). Check such models under the scene's own lighting (look captures), not only in Blender renders. The village's layout (farmland zones, lanes, building pads) lives in `src/world.js` because the ground's height depends on it; keep the farmland and pads clear of the small cherries (the `CLEAR` list there) or their trunk models stop fitting. Exceptions: sound (owner, 2026-09-27): recordings in `public/audio/`, built by `tools/audio.mjs` and credited in README.md (Sound); and the deer (owner, 2026-09-28, after a code-built kitten was dropped for looking bad): Quaternius models in `src/models/`, built by `tools/models.mjs` and credited in README.md (Models). A new sound or model source needs a licence that allows this and a README credit.
- `three` is pinned to an exact version. The materials are TSL node materials (`src/tsl.js`, `src/materials.js`) that reproduce r170's lighting by subclassing three internals (`PhysicalLightingModel`), and `main.js` wraps the private `renderer._getFallback`, so a three upgrade can silently break the look. Check visually after any bump.
- TSL: don't assign three's lighting properties (`diffuseContribution`, `roughness`, …) inside an `If` in a material's setup: on frames the branch is skipped the lighting comes out black. Compute a factor and assign unconditionally.
- `src/ui.js` is page wiring only; scene logic belongs in the engine modules behind `create()`.

## Verifying changes

- Run `pnpm dev` and look at the scene in a browser. There are no automated tests.
- Quick look without a window on the owner's desktop: `node bench/build.mjs look && LOOK_BACKEND=webgl BENCH_HEADLESS=1 node bench/look.mjs look out/look <time,...> [hero|x,y,z:tx,ty,tz ...]` writes PNGs to `bench/out/` (headless WebGPU canvases read back blank, hence WebGL; `QUALITY=medium|low` for the other tiers). Headless WebGPU runs always log `OperationError: Instance dropped in popErrorScope` (about 14 times) as the browser closes, on every build including known-good ones: ignore it, don't bisect it; look for other errors.
- In one `look.mjs` run, a night time captured after day times can show the day's reflection on the river (the reflection renders every other frame and the settle steps don't render). Capture night in its own run before calling a bright river a regression.
- The engine handle (`window.SakuraRiver.create`'s return value) has debug hooks for headless checks: `setView(pos, target)`, `cineView(u)`, `tick(n, dt)`, `simulate(sec)`, `info()`, `soundInfo()`, `birdInfo()`, `koiInfo()`, `shootingStar()` (launches one ahead of the camera); `create(canvas, { manual: true })` disables the RAF loop.
- Birds: `node bench/birds-look.mjs look out/b '<json shots>'` sets time and weather, simulates and captures the scene or a view following one bird (shot format at the top of the script).

## Publishing

- Hosted on GitHub Pages at https://smolpaw.github.io/sakura-river/ (repo `smolpaw/sakura-river`, public). `.github/workflows/pages.yml` runs `pnpm build` and deploys `dist/` on every push to `main`, so pushing is publishing.
- Don't publish anything to claude.ai (owner decision, 2026-09-27).
