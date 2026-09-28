# Performance

What the renderer does for speed, what was tried and rejected, and what is still open. Distilled from the 2026-09-27/28 performance work: the engine was moved from WebGLRenderer to WebGPURenderer + TSL (three 0.186.1) and then tuned for GPUs from integrated to discrete. Research notes with sources are in `docs/research/`.

## Targets

- Devices from the last 3–4 years (owner, 2026-09-28): discrete desktop GPUs, modern integrated GPUs (Intel Iris Xe/Arc, AMD 680M-class, Apple M-series) and current mobile GPUs, on WebGPU or the WebGL2 fallback. Older hardware is out of scope.
- On integrated GPUs, memory bandwidth decides performance. The main costs are render-target formats, MSAA, fullscreen passes, shadow-map size and overdraw.
- The owner's desktop (RTX 2060) is a personal machine, not a bench rig. Check changes with a few stills (see CLAUDE.md), and run long GPU timing only when the owner says it's a good time.

## In place

Each item passed the visual gate or is pixel-identical to what it replaced.

- **Blossom depth prepass:** an alpha-only depth pass, then the lit pass with depthWrite off, with a constant 4-unit depth offset. It was the largest single saving (scene pass 10.4 → 9.1 ms at 4K). A slope-scaled offset let near-coplanar cards through and failed the gate.
- **30 Hz updates:** the wind-animated shadow map and the water reflection render every other frame, on every tier.
- **Effect buffers per CSS pixel above DPR 1.4:** light shafts at 0.5/DPR, reflection at 0.35 at DPR 2 (0.25 fails near the water). No change at DPR 1.
- **Uniform branches** keep features that are off from costing anything: terrain underwater terms above the water line, lantern/temple/bridge lamp light before dusk, raindrop rings when dry, lightning. Rain streaks draw a count that scales with intensity, and none when dry.
- **Few render items:** WebGPURenderer pays per render item (three #30560: CPU per frame went ~1.3 → ~3 ms in the port; still GPU-bound). New content goes in instanced or merged draws: birds are three instanced draws, lanterns one, the temple one.
- **Adaptive quality** (`src/quality.js`): canvas pixel ratio (floor 0.6), then reflection resolution, grass density and reflection off. It is driven by GPU timer queries where they exist, otherwise by frame time with a vsync-safe target. GPU timings arrive 10–30 frames late, so samples of frames rendered before a change are ignored; acting on them made the loop oscillate. A median picked the upper mode of the alternating 30 Hz frames, so the estimate is a trimmed mean. It steps up only when its model predicts staying 5% under target, and ignores the first 1.5 s (pipeline compilation).
- **Starting tier from adapter/renderer strings** (`detectTier` in `src/main.js`): software and old mobile GPUs start on low; Intel integrated, AMD APUs, Apple, ARM/Qualcomm, WebGPU compatibility-mode devices and ≤4-core machines on medium; the rest on high.
- **Start-up:** 24 hidden warm-up frames behind the loading veil build every pipeline (`compileAsync` only knows the canvas target) and absorb a one-off stall three shows around frame 16. Every feature that is off at start is forced on during warm-up so its pipeline exists. Worst visible frame on WebGPU went 580 → 23 ms. Procedural generation runs in a pool of inline workers (critical path ~0.35–0.5 s), so WASM isn't worth it.

## Cross-GPU correctness

- `pow` of a slightly negative base gives NaN on Apple/Mali/Adreno, and bloom spreads it. Clamp the base.
- WebGPU has only 1× or 4× MSAA. Compatibility mode has none (so no alpha-to-coverage), a 4096 texture limit, and on Android no shadow comparison sampler (shadows off there).
- Stay within WebGPU default limits (e.g. 8 vertex buffers: the blossom attributes are one interleaved buffer for that reason) and gate optional features.
- Hash value-noise corners from exact `floor()` inputs; the `i + (1,0)` form tore the water on WebGPU.
- Procedural canvas textures use `willReadFrequently` (CPU raster). GPU-rasterized 2D canvases differ per GPU and per context type.
- Chrome on Windows ignores WebGPU `powerPreference`; three r186's WebGL2 backend never passes it, so the engine creates the WebGL2 context itself with `'high-performance'`. See `docs/research/gpu-selection-and-compat.md`.

## Tried and rejected

- **Temporal AA (`traa`, `taau`):** `traa` blurs swaying foliage and loses alpha-to-coverage; `taau` blurs even at scale 1. At full resolution it costs more than the MSAA it replaces, so it only pays below scale 1, which fails the gate.
- **Cached static shadow map:** pixel-identical but a net loss, because restoring the depth copy costs more than drawing the static casters.
- **Cheaper shadow filter:** 1 tap vs 9 saves only 0.1 ms.
- **MSAA 2× at DPR 2** and **8-bit target after tone mapping:** fail the visual gate (banding, edges).
- **Start-up GPU micro-benchmark for the tier:** GPU clocks ramp over ~1 s of load, so a short benchmark measures clock state rather than GPU class.

## Open risks

- The blossom prepass relies on a 4-unit depth margin between two vertex shaders. A compiler that rounds them more differently would punch holes in the canopy.
- `sin`-based hashes with large arguments may band on mobile GPUs.
- `uTime`/`uFlow` grow without bound, so precision drops after hours.

## Cost of later content

Checked by eye only; no timing runs.

- Tree (single flowers): 38k bark triangles, 28k flowers × 8 triangles (23k before the inner branches got their own umbels).
- Riverside and bridge lanterns: ~100 instances × 400 triangles in one draw; their light is analytic (distance to the bank lines), not scene lights.
- Temple: 84k triangles, one draw, no shadows. Its material sums 14 lamp terms only after dusk and only on temple pixels.
- Rocks: five boulder shapes of 500 triangles (93 instances, cast shadows) and one 80-triangle stone for the 900 pebbles, which cast no shadow. The pebbles had used the boulder shapes (~450k triangles in the scene, shadow and reflection passes); they sit at the waterline, under water or in the grass, and look the same.
- Petal rafts (hanaikada) on the water: one instanced draw of the fallen-petal mesh, ~4k petals × 16 triangles on high, fewer drawn when fewer petals fall; not in the reflection.
- Birds: three instanced draws of 50–60 triangles per bird, no shadows.
- Deer: three skinned meshes of ~4.2k triangles (the models' per-material parts joined into one, coat in vertex colours, subdivided and simplified to twice the source's triangles), one draw each plus one for the antlers (1.6k); they cast shadows. The models add ~200 KB (base64) to the page.
- Turf on the deer's grazing ground: one instanced draw, 9% of the grass count in clumps of 6 thin two-segment blades (~70k triangles on high; 9 three-segment blades, ~155k, looked the same); the tall grass is thinned out there.
- Stars and shooting stars: in the sky shader, behind uniform branches (nothing by day). At night each sky pixel does one cube-map cell lookup (five `hash12`, one `fwidth`); a shooting star adds a few dot products while one is in flight.

## Bench tools

`bench/` holds the harness from this work: `pnpm bench` (GPU/CPU timing, `bench/perf.mjs`), `pnpm bench:visual` (NVIDIA ꟻLIP against goldens, `bench/visual.mjs` + `flip_eval.py`), `bench/build.mjs` (builds any commit from a worktree), `bench/passes.mjs` (per-pass GPU times), `bench/hashcheck.mjs` (worker output vs main thread). The goldens were rendered from the pre-port baseline, before the new tree, lanterns, temple and weather, so the golden gate no longer describes the current scene. Timing gotchas:

- WebGPU blocks in `writeBuffer`/`getCurrentTexture` when the GPU is behind, so wall-clock "CPU" time is really GPU wait. Time CPU in a GPU-drained batch.
- WebGPU pass timestamps miss work between passes (texture copies). Measure a frame as the span from the first pass's begin to the last pass's end.
- The RTX 2060 here drifts 1680–1905 MHz under thermal limits, so A/B runs need interleaving or a locked clock.
