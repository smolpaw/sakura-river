# GPU selection, adapter info, compat mode and GPU tiering: browser facts (2026-09)

Research note. It records facts with sources and makes no recommendations. Researched on 2026-09-27 against Chromium `main`, Dawn `main`, Firefox `main` (GitHub mirror), WebKit `main` and three.js 0.186.1 (`node_modules/three`).
Source-code claims cite the file, as [S#] in the Sources list. **(inferred)** marks my own reading of a code path that no comment or doc states. **Unknown** marks something I could not settle.

---

## 1. WebGPU `requestAdapter({ powerPreference })`

### Chrome: common path (all OSes)
- Blink passes `powerPreference` to Dawn only when the page sets it [S1 `gpu.cc` `AsDawnType`].
- In the GPU process, `WebGPUDecoderImpl::CreatePreferredAdapter` [S2] rewrites the preference based on the command-line switch `--use-webgpu-power-preference`:
  - Default (`kNone`), with no preference given: **low-power on battery (or when the power monitor isn't initialised), high-performance on AC power**. MDN documents the same for dual-GPU macOS [S10].
  - `default-low-power` / `default-high-performance` change only the "not given" case.
  - `force-low-power` / `force-high-performance` override the page. They also make the adapter filter reject any adapter whose type isn't integrated or discrete, respectively [S2 `CanUseAdapter`]. The switch values are parsed in `service_utils.cc` [S3]. There is no `chrome://flags` entry for this switch; it is command-line only (inferred: it is absent from `about_flags.cc` [S4]).
- Dawn then orders the adapters. `SortAdapters` ranks discrete first for high-performance and integrated first for low-power. With no preference it keeps the OS order. **For D3D11/D3D12 it skips sorting and keeps DXGI order**, because "DXGI returns the correct order based on system settings" [S5 `Instance.cpp`, `Adapter.cpp`].

### Chrome on Windows (D3D12): effectively ignored; fixed per GPU process
- Before enumerating, Chrome queries the ANGLE D3D11 device that the rest of Chrome uses. It chains that adapter's **LUID** into the Dawn request, so WebGPU only gets the adapter Chrome already runs on [S2, `#if BUILDFLAG(IS_WIN)` block].
- Blink prints this console warning whenever `powerPreference` is passed on Windows: *"The powerPreference option is currently ignored when calling requestAdapter() on Windows. See https://crbug.com/369219127"* [S1]. Chrome 132 added it [S12].
- Chrome's docs say Chrome "always uses the same GPU adapter that's been allocated for other Chrome workloads", which on laptops "is generally the integrated graphics card". They also say "Chrome does not support using multiple GPU adapters simultaneously" [S11].
- Tracking bugs:
  - crbug 369219127 *"Wrong high performance device selected on Windows"* has status Assigned. Assignees include Microsoft accounts, and it was last modified in Sept 2026 [S13].
  - crbug 329211593 *"Support multiple GPU adapters on Windows"* has status New. Its description: WebGPU "is pinned to the GPU adapter that the rest of Chrome [uses]". Proper support needs cross-adapter shared heaps / CompoundSharedImage [S13].
- **How the GPU process picks its adapter on Windows:**
  - `gpu_info.gpu` is DXGI `EnumAdapters` index 0 [S6 `gpu_info_collector_win.cc`]. `SetupGLDisplayManagerEGL` makes that the default EGL/ANGLE display [S7 `gpu_init.cc`].
  - Windows' per-app "Graphics performance preference" (stored in `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`) and vendor control panels reorder which adapter is DXGI index 0 [S30, S31].
  - So (inferred) setting chrome.exe to "High performance" there moves the whole Chrome GPU process, and with it WebGPU and WebGL, onto the dGPU.
- **`--force-high-performance-gpu` / `chrome://flags/#force-high-performance-gpu`:**
  - The flag is listed for `kOsWin` only. Its description: "Forces use of high performance GPU if available" [S4].
  - The browser turns it into the `FORCE_HIGH_PERFORMANCE_GPU` driver workaround [S8 `gpu_process_host.cc`]. `SetupGLDisplayManagerEGL` then makes the high-performance LUID the default display for all of Chrome [S7].
  - The choice is made once, when the GPU process starts, so a browser restart is needed. It is per browser process, not per page.
- `--use-webgpu-power-preference=force-high-performance` on an iGPU-pinned Windows Chrome: the only adapter left after LUID filtering is integrated, so the discrete-only filter would reject it and `requestAdapter` would resolve `null` (inferred).
- Enterprise policy: I found no Chrome policy that selects the GPU. **Unknown** whether one exists.

### Chrome on macOS (Metal): honoured per request
- The macOS path has no LUID/device pinning. The backend list is `{Metal}`, and Dawn sorts the Metal devices by preference [S2, S5]. The selection therefore happens on each `requestAdapter()` call (inferred).
- Only Intel MacBook Pros with AMD dGPUs (2016–2020 15"/16") have two GPUs. Apple-silicon Macs have one GPU.
- Old bug crbug 40268366 *"WebGPU powerPreference option ignored"* (Chrome 115, 2023): on a dual-GPU MBP, `high-performance` returned the Intel iGPU; the discrete AMD GPU appeared only with `--enable-unsafe-webgpu`. Its tracker status code is 7, which I read as "Won't fix (Intended behavior)", last modified 2024-06. **Unknown**: why it was closed, and whether today's stable build behaves as the current source suggests. No test on dual-GPU Mac hardware was available.

### Chrome on Linux (Vulkan)
- WebGPU is on by default only for some GPUs:
  - Intel Gen12+ from Chrome 144. It uses an architecture where "WebGPU uses Vulkan and the rest of Chromium stays on OpenGL" [S14].
  - Expanded to "modern NVIDIA drivers (2024-05) on Wayland" in Chrome 147/148 [S15].
- Backend choice: `{Vulkan}` only if the compositor runs on Vulkan/Graphite-Vulkan or Vulkan-GL interop is enabled. Otherwise the backend is `Null`, i.e. no WebGPU. The code comment reads "Deliberately disable compat on linux" [S2].
- No LUID/UUID pinning appears in `webgpu_decoder_impl.cc` [S2]. Dawn's `SortAdapters` applies to Vulkan [S5]. So, by reading the code, a PRIME laptop that exposes both Vulkan devices would get the discrete GPU for `high-performance`, and also for an unspecified preference on AC power.
- **Unknown**: whether a dGPU adapter passes the external-image / GL-interop checks when Chrome's GL runs on the iGPU. I found no device-matching code, and no test on hardware.

### Chrome on ChromeOS
- The backend list is `{Vulkan, OpenGLES}`, sorted by Dawn [S2, S5].
- The adapter must support `SharedTextureMemoryDmaBuf` and `SharedFenceSyncFD` [S2].
- Nearly all ChromeOS devices have a single GPU. I found nothing ChromeOS-specific about `powerPreference`.

### Firefox (wgpu)
- `powerPreference` is mapped to wgpu's `PowerPreference`; if the page omits it, `None` is sent [S16 `dom/webgpu/Instance.cpp`].
- **Windows:** the parent process enumerates D3D12 adapters and **uses only the one whose LUID matches the WebRender compositor device**. Code comment: "If wgpu uses a different adapter than WebRender, textures created by webgpu::SharedTexture do not work" [S17 `gfx/wgpu_bindings/src/server.rs`]. So, as in Chrome, `powerPreference` does not choose the GPU on Windows (inferred).
- **Other OSes:** the call falls through to wgpu's `request_adapter(desc)`, which carries the preference [S17].
- Shipping status: Windows since Firefox 141, Apple-silicon macOS since 145/147. Linux and Intel macOS are Nightly-only [S18, S19].

### Safari (WebKit)
- `GPUImpl::requestAdapter` **hard-codes `WGPUPowerPreference_HighPerformance` on x86_64**, i.e. Intel Macs, whatever the page asks. On other CPUs it passes the page's value or `Undefined` [S20 `WebGPUImpl.cpp`].
- `sortedDevices()` orders `MTLCopyAllDevices()` by `MTLDevice.lowPower` on macOS [S21 `Instance.mm`].
- Safari ships WebGPU from Safari 26 (macOS 26) [S19].

### Spec
- `"high-performance"`: "user agents are more likely to force device loss, in order to save power by switching to a lower-power adapter" [S9].
- No browser has to honour the hint.

---

## 2. WebGL2 `powerPreference` in Chrome

- Blink maps `"high-performance"` to `kHighPerformance`. Everything else, including `"default"`, maps to `kLowPower` [S22 `webgl_context_attribute_helpers.cc`].
- In the GPU process (`GLES2CommandBufferStub::Initialize`, [S23]), low-power and none become `kDefault`, meaning "whatever the default GPU used by Chrome is". It also sets `force_default_display = true` **unless** the GL implementation is ANGLE-on-Metal and `SupportsEGLDualGPURendering()` is true.
- `kEGLDualGPURendering` is **enabled by default only on macOS**, disabled on Windows. `SupportsEGLDualGPURendering()` always returns false on Linux/ChromeOS [S24 `gl_switches.cc`]. Result by OS:

| OS | Does `high-performance` WebGL pick another GPU? | Evidence |
|---|---|---|
| macOS dual-GPU (ANGLE Metal) | Yes, per context. A separate EGL display is created on the high-performance GPU; Chrome internals stay on the default GPU ("Chrome uses the default GPU for internal rendering and the high performance GPU for WebGL/WebGPU contexts that prefer high performance") | [S7, S23, S24] |
| Windows (ANGLE D3D11) | No. The context is forced to the default display, the GPU of the whole GPU process (DXGI index 0, or the dGPU with `--force-high-performance-gpu`) | [S23, S24, S7] |
| Linux / ChromeOS | No. Single default display; the choice happens at OS level (e.g. PRIME offload env vars) | [S24, S32] |

- **WebGL vs WebGPU in Chrome:**
  - Windows: both are pinned to Chrome's GPU-process adapter.
  - macOS: both can pick the dGPU per page. Their defaults differ: WebGL `"default"` means low-power [S22], while WebGPU with no preference means high-performance on AC [S2].
- **Firefox WebGL:** only `high-performance` sets `CreateContextFlags::HIGH_POWER`. The pref `webgl.power-preference-override` can force either way. Low-power is forced when hardware compositing is off [S25 `WebGLContext.cpp`]. **Unknown**: the per-OS effect of `HIGH_POWER` (not traced).
- **Safari WebGL:** the preference becomes `EGL_POWER_PREFERENCE_ANGLE` on the ANGLE-Metal display. With `default`, WebKit uses the GPU that drives the window [S26 `GraphicsContextGLCocoa.mm`].
- **three.js r186:**
  - `WebGPUBackend` forwards `powerPreference` to `requestAdapter` (`WebGPUBackend.js:215-221`).
  - The **WebGL2 fallback does not**: `WebGLBackend.init` builds `contextAttributes` from only `antialias`, `alpha`, `depth` and `stencil` (`WebGLBackend.js:223-230`). So under WebGPURenderer's fallback, Chrome sees WebGL `"default"`, i.e. low-power (see above).
  - The classic `WebGLRenderer` does accept `powerPreference` (`WebGLRenderer.js:81`).

---

## 3. GPUAdapterInfo and WEBGL_debug_renderer_info

### Spec
- `GPUAdapterInfo` has `vendor`, `architecture`, `device`, `description`, `subgroupMinSize`, `subgroupMaxSize` and `isFallbackAdapter`.
- The string fields are "if available. Empty string otherwise" [S9].
- The spec has **no** integrated/discrete field. gpuweb#550 (asking to expose dedicated vs integrated) was closed with a pointer to `powerPreference` [S27]. gpuweb#2195 discusses the fingerprinting tradeoff [S28].

### Chrome stable, without flags
`GPUAdapter::CreateAdapterInfoForAdapter` [S29] passes only these fields in the non-developer branch:
- `vendor`
- `architecture`
- `subgroupMinSize`, `subgroupMaxSize`
- `isFallbackAdapter`, which is `adapterType == CPU`

`device` and `description` stay empty. The same object is available as `GPUDevice.adapterInfo` (Chrome 132) [S12].

With `chrome://flags/#enable-webgpu-developer-features`, Chrome adds `device`, `description`, `driver`, `backend`, **`type`** ("discrete GPU" / "integrated GPU" / "CPU" / "unknown"), `d3dShaderModel`, `vkDriverVersion`, `powerPreference` (Chrome 137) and `memoryHeaps` [S29, S33]. **Chrome exposes no integrated/discrete hint to ordinary pages.**

`isFallbackAdapter` is practically always `false` in default stable. Chrome returns the SwiftShader fallback adapter only under `--enable-unsafe-webgpu`; otherwise `requestAdapter` resolves `null` [S2 `allow_fallback_adapter`].

### Where the `vendor`/`architecture` strings come from
- Dawn's `gpu_info.json` maps PCI vendor/device IDs to names [S34]. The generator's `js_enum_case` lower-cases the name, inserting `-` only after a non-digit chunk [S35]. Examples: `Gen 12 LP` → `gen-12lp`, `RDNA 2` → `rdna-2`, `Xe 2 LPG` → `xe-2lpg`, `Adreno 7xx` → `adreno-7xx` (inferred from generator code; `gen-9`/`rdna-1` are confirmed in the crbug 40268366 report).
- Apple GPUs report no device ID, so their architecture is a Metal family name, e.g. `common-3` [S34].
- **How well these strings separate integrated from discrete, per `gpu_info.json`:**
  - Intel:
    - `gen-9`/`gen-11`/`xe-lpg`/`xe-2lpg`/`xe-3lpg` are integrated.
    - `gen-12hp` (Arc Alchemist, 0x56xx) and `xe-2hpg` (Battlemage) are discrete.
    - **`gen-12lp` also covers DG1 (0x49xx, Iris Xe MAX, discrete).**
  - AMD: **`rdna-2` and `rdna-3` mix discrete (0x73xx/0x74xx) and APU IDs (0x1640/0x15E0/0x1680 for RDNA2; 0x15B0/0x15C0/0x1900 for RDNA3)**, so vendor+architecture alone cannot tell them apart.
  - NVIDIA: desktop/laptop parts are discrete; Tegra IDs are separate.
  - Unknown device IDs give an empty `architecture`.
- Dawn also reports limits in fixed tiers (`tiered_adapter_limits`, on by default [S2]; tier tables in [S36]), so limits carry little hardware detail.

### WEBGL_debug_renderer_info
- **Chrome:** the full unmasked string, e.g. `ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002487) Direct3D11 vs_5_0 ps_5_0, D3D11)`. The plain `RENDERER` is `WebKit WebGL` [S37]. Blink counts usage with a UseCounter [S38].
- **Firefox:**
  - Buckets the renderer string into broad families (since Firefox 91), e.g. "... or similar" [S37, S39].
  - The extension is disabled under `privacy.resistFingerprinting` [S40].
  - Pref: `webgl.sanitize-unmasked-renderer` [S39].
- **Safari:** returns `Apple Inc.` / `Apple GPU` since 2020 [S28].
- The ANGLE string contains the PCI device ID on Windows, so Chrome's WebGL string is more specific than its WebGPU adapter info.

---

## 4. WebGPU compatibility mode

- **Shipped in Chrome 146 stable**, on desktop, Android and WebView. The origin trial ran from 139 to 145 [S41]. The Intent to Ship says it "Will immediately be available on Android, Android WebView, ChromeOS, Mac, and Windows"; Linux depends on WebGPU landing there [S41].
- **Targets:** older APIs, "OpenGL and Direct3D11". The motivation data: "31% of Chrome users do not have Direct3D FL 11.1 or higher"; 23% of Android lacks Vulkan 1.1 [S41].
  - The Chrome 146 post describes the GL path as "Support WebGPU compatibility mode on OpenGL ES 3.1 … starting with Android, the team is exploring support for other devices, such as ChromeOS with OpenGL ES 3.1 and Windows with Direct3D 11" [S42].
  - In source, the default Windows backend list is only `{D3D12}`; D3D11 appears only with `--use-webgpu-adapter=d3d11` [S2]. So (inferred) default Chrome on Windows does **not** yet serve D3D11-only GPUs through compat mode.
- **Gate in source:** a `compatibility` request is honoured if `kWebGPUCompatibilityMode` is enabled, which is on by default [S43], or unsafe/experimental is on [S2]. `--force-webgpu-compat` forces compat for all content [S3].
- **Semantics:**
  - On core-capable hardware Chrome returns a core-capable adapter that exposes the `core-features-and-limits` feature.
  - Unless the page requires that feature (or requires all features), the device keeps the compat restrictions.
  - `device.features.has('core-features-and-limits')` tells core from compat [S10, S42, S44].
- **Main restrictions** [S44]:
  - Storage buffers/textures in vertex shaders (limit 0 by default).
  - One `textureBindingViewDimension` per texture; no layer-subset views in bind groups.
  - No `cube-array`.
  - Blending must match across color targets.
  - No `sample_mask`/`sample_index`, no linear/sample interpolation, `flat` only as `flat, either`.
  - No format reinterpretation; no `bgra8unorm-srgb`.
  - `rgba16float`/`r32float`/integer formats cannot be multisampled.
  - No `textureLoad` on depth; depth textures need comparison samplers.
  - No fine derivatives.
  - Lower defaults: `maxColorAttachments` 4, `maxTextureDimension2D` 4096, `maxUniformBufferBindingSize` 16384, `maxComputeInvocationsPerWorkgroup` 128, `maxInterStageShaderVariables` 15.
- **three.js r186 does request it:**
  - `WebGPUBackend.init` always calls `requestAdapter({ powerPreference, featureLevel: 'compatibility', xrCompatible })`. It then requests **every** feature the adapter lists, which includes `core-features-and-limits` on core hardware.
  - It sets `backend.compatibilityMode = !device.features.has('core-features-and-limits')` (`WebGPUBackend.js:215-258`). In compat mode it forces `renderer._samples = 0` (no MSAA).
  - Compat branches exist in `WebGPUBindingUtils.js:523`, `WGSLNodeBuilder.js:799,2185` and `WebGPUPipelineUtils.js:144`, where MRT blending falls back to material blending with a warning.
  - History: PR #30854 (2025-04) introduced `compatibilityMode`. PR #32762 (merged 2026-01-23) made it "Always request compatibility mode and upgrade to core". PR #32902 (2026-01-30) turned off MSAA in compat because compat can't multisample `rgba16float` [S45]. Tracking issue #30725 "Support for WebGPU Compatibility Mode" is still **open** (updated 2026-09-08) [S45].
- **Other browsers with three's request:**
  - Firefox logs *"featureLevel: "compatibility" … is not yet supported; returning a "core"-defaulting adapter"* (bug 1905951), and its adapters have `core-features-and-limits` enabled automatically [S16, S46].
  - WebKit accepts `"compatibility"` and always adds `CoreFeaturesAndLimits` [S47].
  - So three stays in core mode on both.

---

## 5. GPU tiering by renderer string or micro-benchmark

### Published practice
- **pmndrs `detect-gpu` (`@pmndrs/detect-gpu`):**
  - Reads `UNMASKED_RENDERER_WEBGL`; on Firefox it uses `gl.RENDERER`, skipping the extension. It cleans and fuzzy-matches the string (Levenshtein) against a benchmark DB.
  - The DB is GFXBench 5.0 **Manhattan** median fps per resolution; the closest resolution to screen × DPR is chosen.
  - Tiers: 0 below 15 fps (or blocklisted / no WebGL), 1 at 15+, 2 at 30+, 3 at 60+ fps.
  - Apple: on iOS it renders a tiny WebGL test to tell chip families apart. Apple-silicon Macs on Safari ("Apple GPU") get a fixed "apple m-series", 60 fps.
  - The README notes GFXBench "stopped updating in December 2025" [S48].
- **PlayCanvas docs** list two approaches: "some form of benchmark on the start of the application and observing the frame rate", or querying the renderer string against a tier list. Caveat: "given the sheer number of GPU cards available, this can be extremely difficult". They also advise a user-facing quality switch [S49].
- **Babylon.js `SceneOptimizer`:** runtime, not an up-front benchmark. It checks FPS every `trackerDuration` (default 2000 ms) against `targetFrameRate` (default 60) and applies prioritised degradations such as hardware scaling [S50].
- **Unity WebGL:** I found no published up-front GPU micro-benchmark. **Unknown.**

### Pitfalls, with evidence
- **GPU clocks idle low and ramp up under load.**
  - One measurement: an idle NVIDIA GPU at 300 MHz core / 100 MHz VRAM against 1650–1815 / 1937 MHz under load. Frame times jumped between 2, 4 and 6 ms even with uncapped present modes [S51].
  - D3D12 `SetStablePowerState` exists to avoid "artifacts from dynamic frequency scaling" in profiling. It pins clocks *below* real-use levels and works only in developer mode [S52]. A browser page cannot control clocks.
- **First-run compile cost.**
  - `createRenderPipeline` can block; `createRenderPipelineAsync` resolves "once the pipeline can be used without any stalling" [S53].
  - Chrome has a persistent WebGPU blob cache (`kWebGPUBlobCache`, enabled with WebGPU [S43]), so first-ever runs and later runs can differ (inferred).
  - three.js offers `compileAsync`.
- **Timer precision.**
  - Chrome quantizes WebGPU `timestamp-query` to **100 µs**. The developer-features flag disables the quantization [S33, S54].
  - three requests all adapter features, so `timestamp-query` is on whenever the adapter has it.
  - WebGL `EXT_disjoint_timer_query_webgl2`: Chrome disabled it in Chrome 65 after GLitch, and planned to re-enable it with Site Isolation "with sufficiently reduced precision" [S55]. The driver bug list entry 256, "Expose WebGL's disjoint_timer_query extensions on platforms with site isolation", enables it on every OS except Android [S56]. **Unknown**: what precision reduction, if any, applies today (not found in source).
- **vsync / rAF.**
  - rAF callbacks generally run at the display refresh rate [S57], so rAF frame times on fast GPUs measure the refresh interval.
  - Timing GPU work needs GPU-side timestamps or `queue.onSubmittedWorkDone()` [S9].
  - three's `WebGPUBackend.hasTimestamp` always returns `true`, even without the feature (see `three-r186-facts.md` §1).

---

## Sources

- [S1] Blink `gpu.cc`: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgpu/gpu.cc
- [S2] `webgpu_decoder_impl.cc`: https://chromium.googlesource.com/chromium/src/+/main/gpu/command_buffer/service/webgpu_decoder_impl.cc
- [S3] `gpu_switches.cc`, `service_utils.cc`: https://chromium.googlesource.com/chromium/src/+/main/gpu/config/gpu_switches.cc , https://chromium.googlesource.com/chromium/src/+/main/gpu/command_buffer/service/service_utils.cc
- [S4] `about_flags.cc` / `flag_descriptions.h`: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/about_flags.cc , https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/flag_descriptions.h
- [S5] Dawn `Instance.cpp`, `Adapter.cpp`: https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/Instance.cpp , https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/Adapter.cpp
- [S6] `gpu_info_collector_win.cc`: https://chromium.googlesource.com/chromium/src/+/main/gpu/config/gpu_info_collector_win.cc
- [S7] `gpu_init.cc`, `gpu_switching.cc`: https://chromium.googlesource.com/chromium/src/+/main/gpu/ipc/service/gpu_init.cc , https://chromium.googlesource.com/chromium/src/+/main/gpu/config/gpu_switching.cc
- [S8] `gpu_process_host.cc`: https://chromium.googlesource.com/chromium/src/+/main/content/browser/gpu/gpu_process_host.cc
- [S9] WebGPU spec (GPUAdapterInfo, GPURequestAdapterOptions): https://gpuweb.github.io/gpuweb/#gpuadapterinfo
- [S10] MDN `GPU.requestAdapter()`: https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter
- [S11] Chrome WebGPU troubleshooting: https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips
- [S12] What's New in WebGPU (Chrome 132): https://developer.chrome.com/blog/new-in-webgpu-132
- [S13] crbug 369219127 / 329211593 / 40268366 (read via `issues.chromium.org/action/issues/<id>`): https://issues.chromium.org/issues/369219127 , https://issues.chromium.org/issues/329211593 , https://issues.chromium.org/issues/40268366
- [S14] What's New in WebGPU (Chrome 144): https://developer.chrome.com/blog/new-in-webgpu-144
- [S15] What's New in WebGPU (Chrome 147–148): https://developer.chrome.com/blog/new-in-webgpu-147-148
- [S16] Firefox `dom/webgpu/Instance.cpp`: https://github.com/mozilla-firefox/firefox/blob/main/dom/webgpu/Instance.cpp
- [S17] Firefox `gfx/wgpu_bindings/src/server.rs`: https://github.com/mozilla-firefox/firefox/blob/main/gfx/wgpu_bindings/src/server.rs
- [S18] Mozilla Gfx blog, WebGPU on Windows in Firefox 141: https://mozillagfx.wordpress.com/2025/07/15/shipping-webgpu-on-windows-in-firefox-141/
- [S19] gpuweb Implementation Status: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status ; web.dev: https://web.dev/blog/webgpu-supported-major-browsers
- [S20] WebKit `WebGPUImpl.cpp`: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/WebGPU/Implementation/WebGPUImpl.cpp
- [S21] WebKit `Source/WebGPU/WebGPU/Instance.mm`: https://github.com/WebKit/WebKit/blob/main/Source/WebGPU/WebGPU/Instance.mm
- [S22] `webgl_context_attribute_helpers.cc`: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgl/webgl_context_attribute_helpers.cc
- [S23] `gles2_command_buffer_stub.cc`: https://chromium.googlesource.com/chromium/src/+/main/gpu/ipc/service/gles2_command_buffer_stub.cc
- [S24] `ui/gl/gl_switches.cc`: https://chromium.googlesource.com/chromium/src/+/main/ui/gl/gl_switches.cc
- [S25] Firefox `dom/canvas/WebGLContext.cpp`: https://github.com/mozilla-firefox/firefox/blob/main/dom/canvas/WebGLContext.cpp
- [S26] WebKit `GraphicsContextGLCocoa.mm`: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/cocoa/GraphicsContextGLCocoa.mm
- [S27] gpuweb#550: https://github.com/gpuweb/gpuweb/issues/550
- [S28] gpuweb#2195: https://github.com/gpuweb/gpuweb/issues/2195
- [S29] Blink `gpu_adapter.cc`: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgpu/gpu_adapter.cc
- [S30] Microsoft, `EnumAdapterByGpuPreference`: https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_6/nf-dxgi1_6-idxgifactory6-enumadapterbygpupreference
- [S31] A. Sawicki, "Switchable graphics versus D3D11 adapters": https://dev.to/reg__/switchable-graphics-versus-d3d11-adapters-45fa
- [S32] Arch Wiki, PRIME: https://wiki.archlinux.org/title/PRIME
- [S33] Chrome WebGPU developer features: https://developer.chrome.com/docs/web-platform/webgpu/developer-features
- [S34] Dawn `gpu_info.json`: https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/gpu_info.json
- [S35] Dawn `generator/dawn_gpu_info_generator.py`, `templates/dawn/common/GPUInfo.cpp`: https://github.com/google/dawn/blob/main/generator/dawn_gpu_info_generator.py
- [S36] Dawn `Limits.cpp`: https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/Limits.cpp
- [S37] Bugzilla 1916271: https://bugzilla.mozilla.org/show_bug.cgi?id=1916271
- [S38] Blink `webgl_rendering_context_base.cc`: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc
- [S39] Bugzilla 1722113 (sanitized renderer): https://bugzilla.mozilla.org/show_bug.cgi?id=1722113
- [S40] MDN `WEBGL_debug_renderer_info`: https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_debug_renderer_info
- [S41] Intent to Ship: WebGPU Compatibility mode: https://groups.google.com/a/chromium.org/g/blink-dev/c/N3RlLGCOTJ4
- [S42] What's New in WebGPU (Chrome 146): https://developer.chrome.com/blog/new-in-webgpu-146
- [S43] `gpu_finch_features.cc`: https://chromium.googlesource.com/chromium/src/+/main/gpu/config/gpu_finch_features.cc
- [S44] WebGPU Fundamentals, Compatibility Mode: https://webgpufundamentals.org/webgpu/lessons/webgpu-compatibility-mode.html
- [S45] three.js #30725, #30854, #32762, #32902: https://github.com/mrdoob/three.js/issues/30725 , https://github.com/mrdoob/three.js/pull/32762 , https://github.com/mrdoob/three.js/pull/32902
- [S46] Firefox `dom/webgpu/Adapter.cpp` (core-features-and-limits auto-enabled): https://github.com/mozilla-firefox/firefox/blob/main/dom/webgpu/Adapter.cpp
- [S47] WebKit `WebGPUAdapterImpl.cpp`, `GPU.cpp`: https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/WebGPU/Implementation/WebGPUAdapterImpl.cpp
- [S48] pmndrs/detect-gpu (README, `src/index.ts`, `scripts/update_benchmarks.ts`): https://github.com/pmndrs/detect-gpu
- [S49] PlayCanvas, Device Pixel Ratio: https://developer.playcanvas.com/user-manual/optimization/runtime-devicepixelratio/
- [S50] Babylon.js Scene Optimizer doc: https://github.com/BabylonJS/Documentation/blob/master/content/features/featuresDeepDive/scene/sceneOptimizer.md
- [S51] M. Ropert, "Benchmarking with Vulkan, or the curse of variable GPU clock rates" (2026-01-29): https://mropert.github.io/2026/01/29/benchmarking_vulkan/
- [S52] Microsoft, `ID3D12Device::SetStablePowerState`: https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device-setstablepowerstate
- [S53] MDN `createRenderPipelineAsync()`: https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createRenderPipelineAsync
- [S54] What's New in WebGPU (Chrome 120): https://developer.chrome.com/blog/new-in-webgpu-120 ; WebGPU Fundamentals timing: https://webgpufundamentals.org/webgpu/lessons/webgpu-timing.html
- [S55] Chromium, Mitigating Side-Channel Attacks: https://www.chromium.org/Home/chromium-security/ssca/
- [S56] `gpu_driver_bug_list.json` (entry 256): https://chromium.googlesource.com/chromium/src/+/main/gpu/config/gpu_driver_bug_list.json
- [S57] MDN `requestAnimationFrame()`: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
