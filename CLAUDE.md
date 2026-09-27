# Sakura River

Procedural Three.js scene (cherry tree, river, Fuji-style mountain). See README.md for commands, file layout and the engine API.

## Working here

- The owner cares about results, not about knowing the code. The GitHub issue workflow from the global instructions does not apply to this project. Any language or stack is fine when measurements show it helps.
- Active work: `docs/performance-plan.md`. Its Status section is the progress log.

## Conventions

- Everything visual is generated in code — no image, model or texture assets. Keep it that way unless asked. Sound is the exception (owner, 2026-09-27): recordings in `public/audio/`, built by `tools/audio.mjs` and credited in README.md (Sound). A new sound source needs a licence that allows this and a README credit.
- `three` is pinned to an exact version. The materials are TSL node materials (`src/tsl.js`, `src/materials.js`) that reproduce r170's lighting by subclassing three internals (`PhysicalLightingModel`), and `main.js` wraps the private `renderer._getFallback`, so a three upgrade can silently break the look. Check visually after any bump.
- `src/ui.js` is page wiring only; scene logic belongs in the engine modules behind `create()`.

## Verifying changes

- Run `pnpm dev` and look at the scene in a browser. There are no automated tests.
- Quick look without a window on the owner's desktop: `node bench/build.mjs look && LOOK_BACKEND=webgl BENCH_HEADLESS=1 node bench/look.mjs look out/look <time,...> [hero|x,y,z:tx,ty,tz ...]` writes PNGs to `bench/out/` (headless WebGPU canvases read back blank, hence WebGL).
- The engine handle (`window.SakuraRiver.create`'s return value) has debug hooks for headless checks: `setView(pos, target)`, `cineView(u)`, `tick(n, dt)`, `simulate(sec)`, `info()`, `soundInfo()`, `kittenInfo()`, `kittenAct(i, name)`, `birdInfo()`, `kittenView(i, dist, angle, height)`; `create(canvas, { manual: true })` disables the RAF loop.
- Kittens: `node bench/kittens-look.mjs look out/k '<json shots>'` simulates and captures them in the scene (frame strips with `seq`); `node bench/kview-build.mjs && node bench/kview-shots.mjs out/kv '<json shots>'` renders the kitten model alone on a lawn, one posture per kitten (quick iteration on shape and coats). Shot formats are at the top of each script.
- Birds: `node bench/birds-look.mjs look out/b '<json shots>'` sets time and weather, simulates and captures the scene or a view following one bird (shot format at the top of the script).

## Publishing

- Hosted on GitHub Pages at https://smolpaw.github.io/sakura-river/ (repo `smolpaw/sakura-river`, public). `.github/workflows/pages.yml` runs `pnpm build` and deploys `dist/` on every push to `main`, so pushing is publishing.
- Don't publish anything to claude.ai (owner decision, 2026-09-27).
