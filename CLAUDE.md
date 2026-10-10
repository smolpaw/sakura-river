# Sakura River

Procedural Three.js scene. README.md has the commands, the file layout and the engine API.

## Working here

- The owner cares about results, not about the code. Work is not tracked in GitHub issues. Any language or stack is fine when measurements show it helps.
- It's a demo, not a product: WebGPU-only features are fine and Firefox may fail. Keep the WebGL2 fallback, because the headless captures need it. It skips the WebGPU-only paths, so check those in a real browser.
- Read `docs/performance.md` before adding anything that costs GPU time, and record new findings there.

## Conventions

- Everything visual is generated in code: no image assets, no hand-made models. Models are built by Blender scripts in `tools/` (`node tools/blender.mjs [name]`) into `src/models/` and `public/models/`. Modelling in Blender is Claude's job (the owner has Blender installed but doesn't use it). Judge models under the scene's lighting (look captures), not only in Blender renders.
- The only exceptions are the sounds (`tools/audio.mjs`) and the deer (`tools/models.mjs`). A new sound or model source needs a licence that allows this and a credit in README.md.
- The cherries' trunk model is built from `src/tree.js`'s skeletons. After changing how the trees grow, where they stand or the ground under them, run `node tools/blender.mjs cherry`; the console warns when the model no longer fits. Keep the farmland and building pads in `src/world.js` clear of the small cherries (its `CLEAR` list) for the same reason.
- `three` is pinned. The materials subclass three internals (`PhysicalLightingModel`), `main.js` wraps `renderer._getFallback` and `lods.js` patches `WGSLNodeBuilder.getUniformFromNode`. After any upgrade, check the look and `createMs`.
- The time of day doesn't tick (owner decision): only the time-lapse to a newly picked time moves it. Don't propose a running clock.
- `src/ui.js` is page wiring only; scene logic goes in the engine modules behind `create()`.

## TSL traps

- Assign three's lighting properties (`diffuseContribution`, `roughness`, …) unconditionally, never inside an `If`: on frames that skip the branch, the lighting comes out black. Compute a factor instead.
- An `Fn` without `setLayout` is inlined, so nested `Loop`s inside it share the variable `i` and break silently. Give the loops names: `Loop({ start: 0, end: n, type: 'int', name: 'puff' }, ({ puff }) => …)`.
- Inlining copies the `Fn` into every call site, and a JS `for` unrolls. Bloated shaders compile slowly enough to trip GPU watchdogs. Give reused helpers a `setLayout` and use `Loop`. `bench/shaders.mjs` lists the shaders by size.

## Verifying changes

There are no automated tests: look at the scene with `pnpm dev`, or capture it headless:

    node bench/build.mjs look && LOOK_BACKEND=webgl BENCH_HEADLESS=1 node bench/look.mjs look out/look <time,...> [hero|x,y,z:tx,ty,tz ...]

- PNGs go to `bench/out/`; set `QUALITY=medium|low` to capture the other tiers. Headless runs use WebGL because headless WebGPU canvases read back blank.
- About 14 `OperationError: Instance dropped in popErrorScope` errors at browser close are normal on every build. Ignore them and look for other errors.
- Within one `look.mjs` run, the river can reflect the previous capture (a night after day times, or a pale or green sheet). Re-capture that view in its own run before calling it a regression.
- Feature-specific capture scripts (each documents its usage at its top): `bench/walk-look.mjs`, `bench/figures-look.mjs`, `bench/perched-look.mjs`, `bench/birds-look.mjs`. The engine handle's debug hooks (`setView`, `tick`, `simulate`, `*Info()`, `walkTo`, …) are commented where `src/main.js` returns it. `create(canvas, { manual: true })` disables the RAF loop.
- Skinned meshes (the traveller, the people, the deer) update their bones once per browser frame. Headless, render one frame per `requestAnimationFrame` before capturing them; otherwise the frames of one `tick(n)` pose them where the first frame had them.
- Start-up on weaker devices: `pnpm build && BENCH_HEADLESS=1 node bench/device-probe.mjs <webgl|webgl-soft|gpu|compat|soft> [quality] [--cpu 4]`. Headless WebGPU loses its device within seconds, so run `gpu` and `compat` headed, without `BENCH_HEADLESS`, under `bench/gpu.sh`.

## Publishing

- Pushing to `main` publishes to https://smolpaw.github.io/sakura-river/ (`.github/workflows/pages.yml`).
- Don't publish anything to claude.ai (owner decision).
