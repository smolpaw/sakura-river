# Performance Plan: Scalable Rendering for Sakura River

Execution plan for an autonomous agent. Read all of it before starting, along with `README.md` and `CLAUDE.md`. Keep the **Status** section at the end up to date; it's how work resumes after a context reset.

It has three layers:
- **Hard constraints and gates:** non-negotiable.
- **A starting direction per phase,** based on research done on 2026-09-27, with sources.
- **Open decisions:** settle each one with your own research and measurements, and record the decision and its evidence in Status.

The sources listed are starting points, not limits. Research further whenever a decision needs it, and prefer primary sources (three.js source at the installed version, specs, Chromium/Dawn source) over blogs.

## Goal

Make the engine fast now and structurally ready for future content without frame drops: dynamic weather, background music, more objects, and higher-polygon models. The visual result must stay the same or get better, never worse.

Context: the owner's desktop (RTX 2060) runs the scene at 90–120 fps. A laptop, probably with integrated graphics, runs it at 18–25 fps. The fix must be structural, not a one-time tune.

## How to work

- **The owner cares only about results.** They don't need to know the code.
  - The GitHub issue workflow from their global instructions does not apply here: no issues, no hand-off comments, no PRs.
  - Any language, tool or restructuring is fine if measurements show it helps: Rust or another language compiled to WASM, raw WGSL through TSL (`wgslFn`), rewriting modules from scratch.
  - Don't keep the existing structure for its own sake.
- **Commit in small logical units**, so any step can be benchmarked against its parent and reverted cleanly. Commit bench result JSON with the step it measures.
- **Work autonomously.** Stop and ask the owner only where this plan says so.

## Hard constraints

1. **No visual degradation.** Every change that affects rendering must pass the visual gate (see Measurement). A change that fails is reworked or reverted, never merged with a note.
2. **Changes that alter the look.** Some changes improve the image but move it away from the goldens (for example softer shadows or different reflections). These may ship only if they pass the gate. Otherwise, put them in the "better but different" gallery for the owner and don't ship them in this goal.
3. **The single-file deliverable stays.** `pnpm build` must still produce one self-contained `dist/index.html` that runs as a claude.ai artifact, with workers and WASM inlined.
4. **The WebGL2 fallback stays.** Browsers without WebGPU must still render the scene at visual parity.
5. **Never update the live artifact** (https://claude.ai/artifact/UmQeKrrzEj1KMDrSshWq6z). Sandbox checks go to *new private* artifacts only.
6. **Don't fake numbers.** If a target is unreachable, stop pushing on it. Record the evidence, what you tried and the best result achieved, then continue with the rest of the plan.
7. **Dependencies:** add them through the pnpm CLI. Pin `three` exactly (`pnpm add -E`).

## Stack direction (decided; revisit only on the triggers below)

**Stay on Three.js and move from `WebGLRenderer` to `WebGPURenderer` + TSL.**

- **Why not a Rust engine (Bevy/wgpu) or another engine:** the bottleneck is GPU work: shaded pixels, passes, bandwidth. The GPU runs the same shaders whichever language submits them, and a Rust engine on the web compiles down to the same WebGPU/WebGL APIs. Switching means a full rewrite with no GPU-side gain, and it gives up Three's temporal AA, upscaling and post-processing nodes.
- **What WebGPURenderer gives us (verified in three r186):**
  - one TSL source compiles to WGSL (WebGPU) and GLSL (WebGL2 fallback);
  - `RenderPipeline` post-processing;
  - `traa()` (temporal anti-aliasing) and `taau()` (temporal anti-aliasing with upscaling);
  - compute shaders, indirect draws, `BatchedMesh`;
  - per-pass GPU timestamps on both backends.
- **WASM** is for CPU-heavy procedural generation only, and only if Phase 1 data justifies it (see decision D8).
- **Triggers to revisit** (stop and report to the owner with data; don't switch stacks on your own):
  - after Phase 3, the WebGPU path is still slower than the WebGL baseline, and profiling blames the renderer itself;
  - in the stress scenario, Three's per-frame main-thread CPU stays above 4 ms despite instancing and batching.

### Verified facts about three r186 that shape the work

Check these against the version you install.

- **Unsupported on WebGPURenderer:**
  - `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile`, `EffectComposer` (`manual/pages/webgpurenderer.html`, "Migration" section).
  - Everything in `src/shaders.js` (`patch`, `windDepthMaterial`), the ShaderMaterials in `water.js`, `sky.js` and `petals.js`, and every pass in `post.js` must move to TSL.
  - The docs also warn that WebGPURenderer can be *slower* than WebGLRenderer for some scenes.
- **Post-processing entry point** is `RenderPipeline`. `PostProcessing` is a deprecated alias.
- **Pass fusion is partial.** Pure per-pixel nodes are inlined into one shader. Nodes that read neighbouring pixels need their input in a texture (`convertToTexture` → an extra render target). Bloom, TRAA, TAAU, SMAA, SSR, Godrays, Sharpen and FSR1 each render their own internal passes. Check the real pass count with the counters.
- **Replacements for the current GLSL patching:**
  - Vertex displacement: `material.positionNode`. It runs *after* `instanceMatrix`; use `positionGeometry` for the raw vertex.
  - Shadow passes reuse `positionNode` automatically, so wind-moved shadows no longer need a custom depth material; `castShadowPositionNode` overrides it.
  - Fog: `scene.fogNode = fog(color, factor)`, where the factor can use `positionWorld` (examples `webgpu_custom_fog*`, `webgpu_fog_height`).
  - Custom lighting: `outputNode`, `lightsNode`, or a custom `LightingModel` (example `webgpu_lights_custom`).
- **Motion vectors and wind:** `VelocityNode` compares the current position with `positionPrevious`. Only instancing, skinning and BatchedMesh update `positionPrevious`, so **time-varying wind in `positionNode` produces wrong motion vectors**. The in-tree fix pattern is `Line2NodeMaterial.setupPosition()`: when `builder.needsPreviousData()` is true, assign `positionPrevious` to the displaced position computed with the previous frame's time.
- **Anti-aliasing constraints:**
  - `alphaToCoverage` needs MSAA, but TRAA and TAAU require MSAA off. The blossoms currently rely on `alphaToCoverage`, so they need a new alpha scheme.
  - `material.alphaHash` exists (Wyman 2017), but its hash has no frame seed.
- **Shadows:**
  - `PCFSoftShadowMap` is removed (r186, PR #33987). What remains: `BasicShadowMap`, `PCFShadowMap` (5 Vogel-disk taps rotated by interleaved gradient noise) and `VSMShadowMap`.
  - A custom filter can be supplied through `light.shadow.filterNode`.
  - Caching works per light: `light.shadow.autoUpdate = false`, then set `needsUpdate = true` whenever it should re-render.
- **Reflections:** `reflector({ resolutionScale, … })` re-renders the scene with a cloned virtual camera. There is no layers option; that camera's layers can be set via `reflector.getVirtualCamera(camera).layers`, which is undocumented, so verify it.
- **Compute on the WebGL2 fallback:**
  - It is emulated with transform feedback, so each invocation can write only its own element.
  - No barriers, atomics or indirect dispatch.
  - Indirect *draws* are WebGPU-only.
- **Known WebGPURenderer performance problems:**
  - #30560: per-object uniform buffers are slow with many render items; the WebGL2 fallback makes about 80% more GL calls than WebGLRenderer.
  - #33821: material initialisation is slow.
  - #31805: identical geometry and material are rebuilt for every mesh.
  - #26673: umbrella issue.
  - **Implication:** keep the render-item count low (instancing, `BatchedMesh`, shared materials), and use `renderer.compileAsync()` behind the loading veil so pipeline creation doesn't stall the first frames.
- **Web Workers:** the WebGPURenderer code paths allow running with `OffscreenCanvas` in a worker, but there's no official example. The built-in Inspector needs the DOM, so it can't run in a worker.
- **Migration notes r170 → r186** are on the three.js wiki Migration Guide. Relevant items:
  - imports now come from `three/webgpu` and `three/tsl`;
  - `Clock` is replaced by `Timer`;
  - `Controls.connect(element)`;
  - `renderAsync` is deprecated in favour of `await renderer.init()`;
  - shadow-bias values need retuning.
- **Incremental option:** `examples/jsm/tsl/WebGLNodesHandler.js` runs TSL node materials inside WebGLRenderer, without MRT or the WebGPU post stack. It could port materials one at a time before swapping renderers (decision D1).

## Measurement

The owner's machine runs processes with spiky load, including another agent session that may use the GPU. Measurements must hold up against that. **Build the harness first (Phase 0); optimize nothing until baselines exist.**

### Environment facts (checked on this machine, 2026-09-27)

- Chromium 150 on Wayland (Hyprland); NVIDIA driver 610; RTX 2060; `nvidia-smi` is available.
- **The GPU is not idle at rest:** at idle it reported P8 / 405 MHz and `utilization.gpu` 35%, from the compositor and apps. An absolute-utilization threshold therefore can't detect contention.
- **WebGPU on NVIDIA Linux** has been on by default since Chrome 147, for Wayland with recent drivers (https://developer.chrome.com/blog/new-in-webgpu-147-148). Whether this Arch build enables it without flags is unverified. Check `chrome://gpu` and `navigator.gpu.requestAdapter()`. Fallback flags: `--enable-unsafe-webgpu --enable-features=Vulkan` (see https://github.com/gpuweb/gpuweb/wiki/Implementation-Status).

### Deterministic scene

- **Drive the engine through its hooks:** `create(canvas, { manual: true, fixedQuality: true, quality })`, then `setView`, `cineView(u)`, `tick(n, dt)` and `set(name, v)`. Add bench-only hooks as needed.
- **Keep it deterministic:** the source has no `Math.random`, so with a fixed timestep every frame is reproducible, petal simulation included. Keep it that way.
- **Views:** record the exact list in `bench/views.json`.
  - `resetCamera()` (the hero view) plus `cineView(u)` for u = 0, 0.125, …, 0.875.
  - Scene settings: the defaults, time = 0.5, time = 0.1, and fog = 0.9.
- **Sequences:**
  - (a) the cinematic camera path, 2 s at a fixed 60 Hz;
  - (b) static camera, wind = 1, 2 s (foliage motion, where TAA smears);
  - (c) static camera, frozen time (`dt = 0`), 64 frames (temporal stability).

### Performance metrics (least to most noise-prone)

1. **Deterministic counters (no noise; gate on these first):** draw calls, triangles, render passes, render-target memory, estimated bandwidth per frame (pixels × bytes × passes), pipeline/program count, bundle size.
2. **GPU time per pass from timestamp queries.** It isn't affected by CPU scheduling.
   - **Old renderer:** `EXT_disjoint_timer_query_webgl2`. Chrome exposes it on desktop Linux: `gpu_driver_bug_list.json` entry 256.
   - **WebGPURenderer:** `new WebGPURenderer({ trackTimestamp: true })`, then `await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)`, which returns the frame sum.
   - **Per pass:** `renderer.backend.getTimestamp(uid)` / `getTimestampFrames(type)`. This is backend-level API; see how `examples/jsm/inspector/RendererInspector.js` uses it.
   - **Chrome quantizes WebGPU timestamps** to about 65 µs. `--enable-webgpu-developer-features` turns quantization off (https://developer.chrome.com/docs/web-platform/webgpu/developer-features).
   - **The WebGL fallback skips nested queries.**
   - Discard disjoint samples.
3. **Main-thread CPU per frame** (`performance.now()` around the frame's JS work) and generation time.
   - For deterministic CPU work, min-of-N is robust to interference (Chen & Revels 2016, https://arxiv.org/abs/1608.04295).
   - It can mislead when the program has several performance modes (Tratt 2019, https://tratt.net/laurie/blog/2019/minimum_times_tend_to_mislead_when_benchmarking.html). So also report the median and check whether the distribution is multimodal.

### Isolation protocol (`pnpm bench`)

- **Browser:** a dedicated Chromium with its own profile, launched by script.
  - Prefer **Puppeteer-core with the system Chromium**, in a **headed** window.
  - Playwright always adds `--enable-unsafe-swiftshader` and defaults to the old headless shell.
  - Headless is allowed only if proven GPU-backed for both WebGL2 and WebGPU. The known headless-NVIDIA recipe uses `--disable-vulkan-surface`, which breaks canvas presentation (https://developer.chrome.com/blog/supercharge-web-ai-testing).
- **Flags:**
  - `--disable-frame-rate-limit` (implies `--disable-gpu-vsync`), `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`;
  - `--force-device-scale-factor=<n>`, a fixed window size;
  - `--enable-webgpu-developer-features`.
  - Record the full flag set with every result.
- **Assert real hardware:** the WebGL `UNMASKED_RENDERER` string and the WebGPU adapter info must name the NVIDIA GPU. Abort if either is SwiftShader, llvmpipe or another software renderer.
- **Contention detection, relative to idle:**
  - Before each run, take `nvidia-smi pmon -c 1 -s u` and the process list from plain `nvidia-smi`. `--query-compute-apps` misses graphics-only processes.
  - Treat any new GPU client that isn't in the recorded idle set (for example another browser) as contention: back off and retry.
  - During runs, log `clocks.gr`, `pstate`, `clocks_event_reasons.active` and `temperature.gpu`.
  - Warm up until the GPU reaches P0 with a steady clock. Reject samples whose clock deviates more than 5% from the run median, or that were throttled (thermal or power).
- **Warm-up and sample size:** at least 120 frames (also covers shader and pipeline creation), then at least 300 measured frames per view.
- **Randomized interleaving** of candidate and baseline runs, at least 5 each, to cancel drift (Google Benchmark `random_interleaving`, https://github.com/google/benchmark/blob/main/docs/random_interleaving.md).
- **Calibrate noise first** with an A/A run: baseline against itself.
- **What counts as an improvement:** report ratios with bootstrap confidence intervals (Kalibera & Jones 2013, https://dl.acm.org/doi/10.1145/2464157.2464160). Accept an improvement only if the 95% CI excludes zero *and* the gain exceeds the A/A noise floor.
- **Weak-GPU emulation:** a bench-only "ballast" pass that burns a configurable number of GPU milliseconds per frame. It tests the adaptive controller as if running on a slow laptop.
- **GPU clock lock (optional, done by the owner):**
  - The owner may lock the graphics clock with `sudo nvidia-smi -lgc 1500,1500`.
  - This machine reports a 2145 MHz maximum, but that's the top of the boost range. Under sustained load the 170 W power limit and temperature pull the clock down. 1500 MHz is below the RTX 2060's 1680 MHz rated boost clock, so it's a speed the card can hold.
  - The lock applies system-wide and lasts until `sudo nvidia-smi -rgc` or a reboot.
  - At the start of each bench session, check `nvidia-smi --query-gpu=clocks.gr,clocks_event_reasons.active --format=csv`:
    - `clocks.gr` reads 1500 under load: the lock is active. Record that in the results.
    - `clocks.gr` isn't 1500: the lock isn't active. Rely on the clock-deviation rejection above.
    - Any power or thermal throttle bit set under load while locked: tell the owner a lower lock value is needed.
  - Never run `sudo` yourself.
- **Workloads:**
  - **hero:** `high` tier at 1920×1080, device scale 2 (worst case, like a laptop with a high-density screen);
  - **1080p:** device scale 1;
  - **future-content stress:** see Phase 0.
  - Report both backends for every workload.

### Visual gate (`pnpm bench:visual`)

- **Golden images:**
  - Render baseline commit `58cd6e2` (still r170, still PCFSoft), supersampled at least 3× per axis on top of its MSAA, then box-downsample.
  - Generate them with a script from a `git worktree`, and gitignore the PNGs.
  - Choose sizes that fit in VRAM and record them.
- **Metric: NVIDIA ꟻLIP.** Install with `pip install flip-evaluator`; `flip.evaluate(ref, test, "LDR")` returns `(errorMap, mean, params)`. Source: https://github.com/NVlabs/flip.
  - Set the pixels-per-degree for the evaluation size and record it.
  - There is no official "acceptable" threshold, so thresholds are calibrated.
- **Evaluation size:** 1600×900 at device scale 1, so aliasing isn't hidden by downsampling.
- **Pass criteria, per view and per sequence frame, on both backends:**
  - `FLIP(candidate, golden) ≤ FLIP(baseline, golden) + ε`. Start with ε = 0.002, and change it only with a written justification in Status.
  - For parity steps (the port, pass merges), also require `p99 FLIP(candidate, baseline)` below a threshold calibrated from the A/A run. This catches localized breakage.
  - **Temporal stability:** in sequence (c), per-pixel standard deviation over time after convergence is no worse than baseline.
  - **Ghosting:** in sequences (a) and (b), per-frame FLIP against same-frame goldens is no worse than baseline, both on average and at the worst frame.
- Save heatmaps and a side-by-side HTML gallery to `bench/out/` (gitignored) for every gate run, and link them from Status.

## Phases

Each phase ends with its gate passing, results in `bench/results/<phase>-<step>.json`, and an entry in Status.

### Phase 0: Harness, baseline, sandbox spike

1. **Bench mode:** a `?bench` URL flag plus runner scripts for `pnpm bench` and `pnpm bench:visual`. Add GPU timers around every `EffectComposer` pass, the shadow pass and the reflection pass.
2. **Baseline on `58cd6e2`:** counters, per-pass GPU times and CPU times for every workload; A/A noise floors for performance and visuals; golden images.
3. **Future-content stress scenario** (bench-only, parameterized):
   - 4× grass instances;
   - props and trees with about 10× the triangles (subdivided);
   - 30 extra objects with distinct materials;
   - 50k weather particles as a rain placeholder.
   - Record how baseline cost scales with each parameter.
4. **Sandbox spike:** publish a tiny test page as a **new private** artifact and record, from inside the artifact:
   - WebGPU adapter and whether it has the `timestamp-query` feature;
   - `crossOriginIsolated`;
   - blob-URL module workers and `data:` workers;
   - `WebAssembly.instantiate` (a CSP would need `'wasm-unsafe-eval'`) and WASM SIMD;
   - transferring an `OffscreenCanvas` to a worker.
   - Expect `crossOriginIsolated` to be false. A host that can't set COOP/COEP headers can't use SharedArrayBuffer, so **plan for no WASM threads**; parallelism comes from multiple workers with transferables.
   - Later phases must respect whatever this spike finds.
5. Update the "Verifying changes" section of `CLAUDE.md` and the README with the bench commands.

**Gate:** the A/A noise floor of GPU median time is below 3%, or the achievable floor is documented with its cause. Goldens exist. Baseline numbers are committed.

### Phase 1: Procedural generation off the main thread

1. Move generation (terrain, tree, grass placement, rocks, forest, textures painted into canvases) into Web Workers.
   - Return typed arrays as transferables and build the Three.js objects on the main thread.
   - Run independent generators in parallel.
   - **Worker bundling:** import workers with Vite's `?worker&inline`, which inlines them as a blob URL with a `data:` fallback.
     - `new Worker(new URL(...))` can't be inlined (vitejs/vite#7352).
     - vite-plugin-singlefile may delete separate worker chunks.
     - Relative imports inside an inline worker break (#17825), so bundle each worker as one self-contained module.
   - **Canvas-painted textures** need `OffscreenCanvas` in the worker, or a port to typed-array painting.
2. **Gate:**
   - Every generated buffer is **bit-identical** to what the main-thread code produced, compared by hash. This is valid within one browser: V8's `Math.*` uses bundled LLVM-libc, so the main thread and workers run the same code.
   - No main-thread long task over 50 ms between page load and first frame, except GPU pipeline creation (measure and document that exception).
   - The loading veil animates smoothly.
   - Time to first frame is no worse than baseline.
3. **Decision D8 (WASM):** see Open decisions.

### Phase 2: Port to WebGPURenderer + TSL at visual parity

1. Upgrade `three` to the latest release (`pnpm add -E three@<version>`) and read the Migration Guide entries from 0.170 to that version.
2. **Port, keeping the look identical:**
   - wind displacement → a `positionNode` TSL function, with a correct `positionPrevious` (see Verified facts);
   - height fog → `scene.fogNode`;
   - water → `reflector()` plus a TSL water material;
   - sky and clouds;
   - petals, fallen petals and motes;
   - god rays;
   - grade/sharpen;
   - bloom → `bloom()`.
   - **Shadows:** PCFSoft no longer exists. Match the baseline's soft shadows with `PCFShadowMap` or a custom `shadow.filterNode`, as judged by the gate.
3. Remove the old renderer, `EffectComposer` and the GLSL patching once parity holds.
4. **Gate:**
   - The visual gate passes, including the p99-vs-baseline parity check, on WebGPU *and* on the WebGL2 fallback.
   - Performance is no worse than baseline beyond noise on each backend.
   - Given #30560, check the fallback's per-object overhead early. If the WebGL2 fallback is unavoidably slower, stop and report per-pass data to the owner; this is a stack-trigger decision.

### Phase 3: GPU cost in the new pipeline

Do these in order, measuring each separately.

1. **Pass reduction:** keep per-pixel work (grade, vignette, output transform) fused into a single fullscreen shader, and only use separate passes where neighbourhood sampling forces them. Verify with the counters.
2. **Temporal AA plus internal render scale, replacing MSAA** (decisions D2 and D3).
   - Wind must produce correct motion vectors.
   - The blossoms need an alpha scheme that stays stable under TAA.
   - Once the gate passes at render scale 1, where the image should *improve* as it moves closer to the supersampled golden, lower the internal scale for as long as the gate still passes.
3. **Reflection:** leave out objects that are invisible under the ripple distortion: grass, flowers, fallen petals. Lower `resolutionScale` only as far as the gate allows. See D5.
4. **Shadows:** static casters use a cached map (`autoUpdate = false`, re-rendered when the sun moves). Wind-animated casters are handled separately; see D6.
5. **Adaptive quality driven by GPU time.**
   - Replace the frame-time ladder with a controller that reads GPU timestamps and scales internal resolution continuously, adjusting second-order settings after that.
   - Include a "panic" drop and a TAA history reset after N consecutive over-budget frames (as in Unreal: https://dev.epicgames.com/documentation/en-us/unreal-engine/dynamic-resolution-in-unreal-engine).
   - Replace `detectTier` with a short GPU micro-benchmark that runs behind the veil, combined with the adapter info. Integrated GPUs must no longer land on `high`.
   - **Ballast test:** with 10, 20 and 30 ms of ballast, the controller holds the target frame time without oscillating. Record the visual metric at each steady state.

**Gate:** the visual gate passes after every step. After step 5, hero-workload GPU time on WebGPU is at most 50% of baseline, with visual metrics equal or better.

### Phase 4: Scalability architecture (WebGPU compute, with fallbacks)

1. **GPU particle system** (TSL compute plus `instancedArray` storage).
   - Petals and motes move onto it.
   - It is the base for future rain, snow and mist.
   - Per-particle independent updates fit the WebGL2 transform-feedback limits. Otherwise keep the CPU simulation as the fallback.
   - References: examples `webgpu_compute_particles`, `webgpu_compute_particles_rain`, `webgpu_compute_particles_snow`, `webgpu_particles`.
2. **GPU-driven vegetation** (decision D7).
   - Compute culling, then LOD, then an indirect draw (`geometry.setIndirect(IndirectStorageBufferAttribute)`, example `webgpu_struct_drawindirect`).
   - The WebGL2 fallback keeps tile-based culling.
3. **LOD and batching for high-poly content.**
   - Simplify meshes with meshoptimizer (`MeshoptSimplifier.simplify`; it embeds WASM, so it's subject to the Phase 0 CSP findings) and pick LODs by screen-space error.
   - Use `BatchedMesh` for props and rocks.
   - Use impostors for the distant forest if the gate allows.
   - Keep the number of render items low (#30560, #31805).
4. **Main-thread headroom:** measure main-thread CPU in the stress scenario. If it's over budget, evaluate rendering from a worker via `OffscreenCanvas` (decision D9). Web Audio renders on its own thread; only audio control logic touches the main thread.

**Gate, stress scenario on WebGPU:**
- GPU time is no higher than the baseline's GPU time for today's scene. In other words, 4× today's content fits in today's budget.
- Main-thread CPU is at most 4 ms per frame (both median and min-of-runs).
- The visual gate passes on the normal scene.
- WebGL2 fallback numbers are reported; they're gated only on "no worse than baseline".

### Phase 5: Delivery

1. The single-file build works, with workers inlined (and WASM, if adopted). Verify it in a **new private** test artifact against the Phase 0 spike checks.
2. A `?bench` page mode runs a short benchmark on any machine and shows copyable JSON: GPU, backend, per-pass times and controller steady state. The owner can send it to the laptop user.
3. Update `README.md` and `CLAUDE.md` (architecture, bench commands, performance budgets), and close out the Status log.

## Open decisions (research, measure, record)

Each decision has a starting hypothesis. Measurement and the gates decide; the hypothesis doesn't have to win. Record each decision and its evidence in Status.

- **D1: Port strategy.**
  - Option A: port materials incrementally to TSL while still on WebGLRenderer via `WebGLNodesHandler`, then swap renderers.
  - Option B: port everything at once onto WebGPURenderer.
  - Hypothesis: A reduces risk on parity, but it may fight the post stack (no MRT). Prototype one material with each before committing.
- **D2: AA and upscaling.**
  - Candidates:
    - `traa()` with the pass's `setResolutionScale` and an upscale;
    - `taau()` (TAA and upscale in one step);
    - `fsr1()` after TAA;
    - pmndrs/upscaler (an FSR2/3-style temporal upscaler, WebGPU-only, https://github.com/pmndrs/upscaler).
  - Hypothesis: `taau()`, because it is one pass and designed for this.
  - Background: Karis 2014, https://advances.realtimerendering.com/s2014/; Salvi 2016 variance clipping, https://developer.download.nvidia.com/gameworks/events/GDC2016/msalvi_temporal_supersampling.pdf.
- **D3: Blossom and foliage alpha under TAA.**
  - Candidates: `alphaHash` as built in; a custom hash seeded per frame so TAA resolves partial coverage (see the extended paper on TAA interaction, https://cwyman.org/papers/tvcg17_hashedAlphaExtended.pdf); screen-door dithering. The winner is whichever converges closest to the golden, with the least temporal noise in sequence (c).
- **D4: God rays.**
  - Candidates: port the custom radial-blur pass to TSL, or use the built-in `godrays()`. The built-in needs a directional light with shadows, which we have. The look must match.
  - Hypothesis: port the custom pass first for parity, then try `godrays()` as an optimization.
- **D5: Water reflection.**
  - Candidates: `reflector()` with layer culling and a reduced `resolutionScale`; SSR with fallback to a sky probe; pixel-projected reflections (Cichocki 2017, https://advances.realtimerendering.com/s2017/PixelProjectedReflectionsAC_v_1.92.pdf).
  - Hypothesis: `reflector()` with culling is enough.
- **D6: Shadows for wind-animated casters.**
  - Candidates:
    - a static cache plus a small dynamic map covering only the tree;
    - a lower update rate for dynamic casters, hidden by TAA;
    - VSM;
    - a PCSS-style filter (https://developer.download.nvidia.com/shaderlibrary/docs/shadow_PCSS.pdf) or tuned Vogel taps.
  - Precedent: Unreal and Unity split static and dynamic cached shadows, and animated vertex offsets force a redraw (https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine).
- **D7: Grass architecture.**
  - Candidates: today's instanced blades plus compute culling and indirect draw; or fully procedural per-blade generation on the GPU (Ghost of Tsushima, GDC 2021, https://gdcvault.com/play/1027033/; Jahrmann & Wimmer 2017, https://www.cg.tuwien.ac.at/research/publications/2017/JAHRMANN-2017-RRTG/).
  - A WebGPU/TSL case study reports about 80% of blades culled by the view frustum and LOD going from 15 segments to 2 (https://tympanus.net/codrops/2026/04/21/false-earth-from-webgl-limits-to-a-webgpu-driven-world/).
  - Pick based on stress-scenario scaling.
- **D8: WASM for generation.**
  - Port only if the Phase 1 worker critical path (the slowest worker) exceeds about 1 s on this machine, or dominates time to first frame.
  - The evidence is mixed: tuned JS roughly matched AssemblyScript, and idiomatic Rust was sometimes slower than JS (https://surma.dev/things/js-to-asc/). So measure a prototype of the hottest loop (noise/fbm) before porting more.
  - Language is open: Rust with wasm-bindgen, AssemblyScript, Zig or C. Use SIMD where it helps; assume no threads.
  - A WASM port can't be bit-identical to V8's `Math.*` (its libm differs), so accept it on the visual gate and the counters rather than hashes.
- **D9: Renderer in a worker via OffscreenCanvas.**
  - Only if Phase 4 main-thread measurements need it, and only if the Phase 0 spike shows it works in the artifact.
  - There's no official WebGPURenderer worker example, so budget time for issues.
- **Anything else** your research turns up with measured benefit is in scope, for example `compileAsync` preloading, texture compression, or `DirectRenderPipeline`.

## Definition of Done

All true, with evidence in `bench/results/` and the Status log:

1. `pnpm bench` and `pnpm bench:visual` are reproducible, documented and contention-aware, with the A/A noise floor recorded.
2. The engine runs on WebGPURenderer, on both the WebGPU and WebGL2 backends. The old renderer code is removed. The single-file build runs inside an artifact.
3. The visual gate passes for every view and sequence on both backends.
4. Hero-workload GPU time on WebGPU is at most 50% of baseline. The WebGL2 fallback is no worse than baseline.
5. The future-content stress scenario meets the Phase 4 gate.
6. No main-thread long task over 50 ms during generation. D1–D9 are recorded with their evidence.
7. The adaptive controller passes the ballast test.
8. Any target found unreachable is documented with evidence (constraint 6).

## For the owner (never blocks the work)

- Optionally lock the GPU clock for tighter benchmarks: `sudo nvidia-smi -lgc 1500,1500` before the run, and `sudo nvidia-smi -rgc` afterwards (a reboot also resets it).
- Run the `?bench` page on the laptop that gets 18–25 fps and share the JSON.
- Review the "better but different" gallery (constraint 2).
- Republish the live artifact when satisfied.

## Status

After every step, add: date, step, result with a link to its results file, decisions made, and the next step.

- 2026-09-27: Plan written, research-backed starting points added. Baseline commit `58cd6e2`. Nothing started.
