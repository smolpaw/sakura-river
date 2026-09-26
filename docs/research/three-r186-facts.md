# three.js r186 (0.186.1): API facts for porting WebGLRenderer + EffectComposer + onBeforeCompile to WebGPURenderer + TSL

Source root: `scratchpad/three186/package`. All paths below are relative to it.
Package exports (package.json): `three/webgpu` -> `build/three.webgpu.js` (source `src/Three.WebGPU.js`); `three/tsl` -> `build/three.tsl.js` (`src/Three.TSL.js`); `three/addons/*` -> `examples/jsm/*`.

Facts come from reading the code. When something is my own reading of code paths and not stated in a comment, it is marked **(inferred)**.

---

## 0. Cross-cutting facts that affect almost everything

1. **Internal RAF loop always runs.** `Renderer.init()` calls `this._animation.start()` (src/renderers/common/Renderer.js ~836). `Animation.start()` (src/renderers/common/Animation.js:69-97) calls `requestAnimationFrame` every frame even without `setAnimationLoop`. On each tick it runs `info.reset()` (if `autoReset`), then `nodeFrame.update()` (which does `frameId++` and updates `time`/`deltaTime`, src/nodes/core/NodeFrame.js:306-318), then `info.frame = nodeFrame.frameId`. It also calls `inspector.begin()/finish()`.
   - Consequence (inferred): **`frameId` advances only once per RAF tick** (and once per `compileAsync`, Renderer.js:949). Every node with `updateBeforeType = NodeUpdateType.FRAME` runs at most once per frameId (NodeFrame.js:160-176). That covers PassNode, RTTNode, BloomNode, TRAANode, TAAUNode, FSR1Node, SharpenNode, and ReflectorNode with `bounces:false`. So a headless `tick(n)` that calls `renderPipeline.render()` n times inside one JS task re-renders **nothing** in the pipeline after the first call. ShadowNode also updates at most once per (camera, frameId) (ShadowNode.js:800-810). Driving several frames synchronously would need a manual `renderer._nodes.nodeFrame.update()` (a private API) or yielding to RAF.
2. **The UID for each render call** is `'r:' + info.render.frameCalls + ':' + renderContext.id + ':f' + info.frame` (src/renderers/common/Backend.js:475-500). For compute it is `'c:' + info.compute.frameCalls + ...`. `frameCalls` is reset in `info.reset()` (src/renderers/common/Info.js:187-198) and incremented once per `_renderScene` (Renderer.js:1741-1743).
3. **Tone mapping and color space** are *not* applied inline in materials by default. When `toneMapping !== NoToneMapping` or `outputColorSpace !== working`, `renderer.render()` draws into an internal HalfFloat MSAA framebuffer target. It then runs a separate fullscreen "Output Color Transform" quad pass (Renderer.js:1561-1643 `_getFrameBufferTarget`, 1920-1926, 1959-1990 `_renderOutput`; `needsFrameBufferTarget` at 2609-2616). `DirectRenderPipeline` (src/renderers/common/DirectRenderPipeline.js:6-21) is the alternative that applies output processing inline in the material shaders. Its doc comment: "changes blending and is not compatible with materials that sample the framebuffer, such as transmissive materials".

---

## 1. GPU timestamps

### Enabling
- Constructor option `trackTimestamp` (default `false`): `this.trackTimestamp = ( parameters.trackTimestamp === true )` (src/renderers/common/Backend.js:76).
- WebGPU: after device creation, `this.trackTimestamp = this.trackTimestamp && this.hasFeature( GPUFeatureName.TimestampQuery )` (src/renderers/webgpu/WebGPUBackend.js:298). The device requests **all** adapter features (WebGPUBackend.js:229-245), so `timestamp-query` is enabled whenever the adapter exposes it.
- `backend.hasTimestamp`: WebGPU always returns `true` (WebGPUBackend.js:394-398), even when the feature is missing. WebGL returns `this.disjoint !== null` (src/renderers/webgl-fallback/WebGLBackend.js:318-320), where `this.disjoint = this.extensions.get('EXT_disjoint_timer_query_webgl2')` (WebGLBackend.js:272).
- `TimestampQuery` constant: `{ COMPUTE: 'compute', RENDER: 'render' }` (src/constants.js:1672-1675). It is exported from `three/webgpu`, and RendererInspector imports it from there.

### API
- `await renderer.resolveTimestampsAsync( type = 'render' )` (Renderer.js:3018-3022). This forwards to `Backend.resolveTimestampsAsync` (Backend.js:606-630). If `!trackTimestamp` it warns once and returns undefined. Otherwise it returns `await queryPool.resolveQueriesAsync()` and stores the result in `renderer.info[type].timestamp`. The **return value is the summed duration (ms) of the latest frame present in the resolved batch**, not the per-pass times.
- `backend.getTimestampFrames( type )` returns `queryPool.frames`, an array of frame ids covered by the last resolve (Backend.js:523-529; TimestampQueryPool.js:95-99).
- `backend.getTimestamp( uid )` returns ms for that uid. The pool is chosen by uid prefix (`'c:'` means compute) (Backend.js:537-558). If the uid is missing it **warns** `No timestamp available for uid` and returns 0 (TimestampQueryPool.js:107-121). Guard with `backend.hasTimestampQuery( uid )` first (Backend.js:578-585).
- `backend.getTimestampUID( renderContext )` (Backend.js:511-515). There is no public per-render uid on the renderer. The inspector hook `renderer.inspector.beginRender( uid, scene, camera, renderTarget )` / `finishRender( uid )` is the supported way to observe uids (Renderer.js:1751, 1934; compute at 2907/2977).
- `backend.getTimestampFrames` and `getTimestamp` return data only from the **most recent resolve**. `timestamps.clear()` runs on every resolve (WebGPUTimestampQueryPool.js:205; WebGLTimestampQueryPool.js:228).

### Which calls get their own uid
Every `Renderer._renderScene()` call gets a fresh uid, because `frameCalls` increments each time. That includes:
- Each **PassNode** scene render (`renderer.render(scene, camera)` in `PassNode.updateBefore`, src/nodes/display/PassNode.js:909).
- Each **QuadMesh.render** (`renderer.render(quad, camera)`, src/renderers/common/QuadMesh.js:112-118). So bloom has **12 uids** per frame: 1 high-pass, 5 H-blur, 5 V-blur, 1 composite (examples/jsm/tsl/display/BloomNode.js:361-395). TRAA resolve is 1 (TRAANode.js:405-408). FSR1 is 2 (EASU and RCAS). Sharpen is 1. RTT/convertToTexture is 1 each. The final RenderPipeline quad is 1 (RenderPipeline.js:149).
- Each **shadow-map render**: `renderer.render(scene, shadow.camera)` in `ShadowNode.renderShadow` (src/nodes/lighting/ShadowNode.js:654). The scene is temporarily named `Shadow Map [ <light name or ID> ]`. VSM adds 2 more quad renders (ShadowNode.js:726-732).
- Each **reflector render**: `renderer.render(scene, virtualCamera)` (src/nodes/utils/ReflectorNode.js:571), with the scene named `<name> [ Reflector ]`.
- The **Output Color Transform** pass (`_renderOutput` -> `_renderOutputLayers` -> `_renderScene(quad, camera, false)`, Renderer.js:1520-1528). It only exists when rendering to screen with tone mapping or sRGB conversion, i.e. not under RenderPipeline, which sets `NoToneMapping` and the working color space for its final quad (RenderPipeline.js:138-156).
- Not timed: `renderer.clear()` standalone passes (WebGPUBackend.js ~1836: `beginRenderPass` without timestampWrites), `copyTextureToTexture` (TRAA/TAAU history and depth copies), mipmap generation.

### Nesting
Shadow, PassNode, reflector, bloom and similar renders are triggered from `nodes.updateBefore(renderObject)` *while the outer render is in progress*. The outer render has already called `backend.beginRender` (Renderer.js:1887) before `_renderObjects` (1900) -> `renderObject` -> `_renderObjectDirect` -> `updateBefore` (Renderer.js:3875). Under RenderPipeline, all effect passes are therefore nested inside the final pipeline-quad render.
- **WebGPU**: each render context gets its own command encoder and `GPURenderPassEncoder` (WebGPUBackend.js:1080-1113). Each is submitted at its own `finishRender` (WebGPUBackend.js:1565). The pass's `timestampWrites` get begin and end indices (WebGPUBackend.js:2585-2606, 943). So nested passes are separate GPU passes, submitted *before* the outer one, and each gets its own non-overlapping time (inferred). The outer pass time excludes nested work.
- **WebGL2 fallback**: `beginQuery` returns immediately if another query is active: `// Don't start a new query if there's an active one` (src/renderers/webgl-fallback/utils/WebGLTimestampQueryPool.js:103-108). So a **nested render gets no timestamp**: its state never becomes `'ended'`, so it is not in `timestamps` and `hasTimestampQuery` is false. **Its GPU time is included in the enclosing outer query** (inferred from TIME_ELAPSED semantics). Under RenderPipeline on WebGL, only the outermost render has a time, and that time covers everything nested inside it.

### WebGL2 implementation details (WebGLTimestampQueryPool.js)
- Extension: `gl.getExtension('EXT_disjoint_timer_query_webgl2') || gl.getExtension('EXT_disjoint_timer_query')` (27-28). If missing, it warns and `trackTimestamp=false` (30-35). The pool is also only created when `backend.disjoint` is truthy (WebGLBackend.js:414).
- Pool: `new WebGLTimestampQueryPool( gl, type, 2048 )` (WebGLBackend.js:419), which pre-creates 2048 `WebGLQuery` objects (38-44). It uses 2 slots per uid (60-80) but only the base one is used, with TIME_ELAPSED_EXT (122, 167).
- `beginQuery` / `endQuery` are called from `WebGLBackend.beginRender` (502) and `finishRender` (614). Compute uses the same path (905, 1017).
- Resolve (`resolveQueriesAsync`, 188-277): it is guarded by `pendingResolve` and returns `lastValue` while one is in flight. For each `'ended'` query it polls `QUERY_RESULT_AVAILABLE` via `setTimeout(checkQuery, 1)` (343-347), then reads `QUERY_RESULT` ns / 1e6 -> ms (351-352).
- **Disjoint handling**: `if ( gl.getParameter( ext.GPU_DISJOINT_EXT ) ) finalizeResolution( this.lastValue )` (335-340). A disjoint event makes that uid's value equal to `lastValue`, which is the *previous total frame duration*, not a per-pass value. There is no flag telling you it happened.
- After awaiting, it resets `currentQueryIndex=0` and clears `queryOffsets`, `queryStates` and `activeQuery` (258-262). **Inferred risk**: queries allocated by frames rendered *during* the await (the polling spans multiple ms and possibly RAF ticks) are dropped. If one was active at that moment, its `endQuery` finds no offset and returns without calling `gl.endQuery`. The next `beginQuery` would then hit a GL error, which is caught and logged (128-134).
- Overflow: if `currentQueryIndex + 2 > maxQueries`, it calls `resolveQueriesAsync()` without awaiting and resets (61-70).

### WebGPU implementation details (src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js)
- A `GPUQuerySet` of type `'timestamp'` with `count = 2048` per type (render and compute) (27-37). Resolve buffer and MAP_READ result buffer are 2048*8 bytes (41-57). That gives **1024 passes between resolves**. On overflow it auto-resolves and resets (71-78).
- `_resolveQueries` (132-252): if `resultBuffer.mapState !== 'unmapped'` it returns `lastValue`. Otherwise it snapshots the offsets, resets the index, encodes `resolveQuerySet` and `copyBufferToBuffer`, submits, and does `await resultBuffer.mapAsync(READ)`. It then reads a `BigUint64Array` and computes `duration = (end - begin) / 1e6` ms per uid.
- Concurrent calls share `pendingResolve` (104-108).

### Latency (inferred)
There is no fixed frame latency in code. Data becomes available when `mapAsync` resolves (WebGPU) or when all `QUERY_RESULT_AVAILABLE` are true (WebGL). A resolve covers **every frame since the previous resolve**; the pool grouping is by the `:f<frame>` suffix. RendererInspector triggers a resolve inside the next `requestAnimationFrame` after each finished frame (RendererInspector.js:264-450), so results typically arrive 1–3 frames late.

### How examples/jsm/inspector/RendererInspector.js reads per-pass times
- It extends `InspectorBase`. The renderer calls `beginRender(uid, scene, camera, renderTarget)` and `finishRender(uid)` for each `_renderScene`. The inspector builds `RenderStats { uid, cid, name: scene.name || 'Scene'/'QuadMesh', cpu, gpu, children, parent }` in a tree using the current context as parent (RendererInspector.js:5-50, 535-570). So nested renders appear as children.
- Pass names come from `scene.name` and `QuadMesh.name`. Examples: `'Bloom [ Blur Horizontal - 2 ]'` (BloomNode.js:377), `'TRAA'`, `'FSR1 [ EASU Pass ]'`, `PassNode.name`, `'Shadow Map [ … ]'`, `'… [ Reflector ]'`, `'Render Pipeline'`, `'Output Color Transform'`.
- `resolveTimestamp()` (264-450) works as follows. Inside `requestAnimationFrame` it runs `await renderer.resolveTimestampsAsync(COMPUTE)`, then `RENDER`, then `frames = backend.getTimestampFrames(...)`. For each frame id in those lists it sets `stats.gpu = backend.getTimestamp(stats.uid)` when `backend.hasTimestampQuery(stats.uid)`, else `gpu = 0; gpuNotAvailable = true`.
- CPU time is `performance.now()` between begin and finish. It **includes nested renders' CPU time**.
- To use: `renderer.inspector = new Inspector()` (examples/jsm/inspector/Inspector.js), or subclass `RendererInspector` / `InspectorBase` for headless collection. `inspect()` warns if used outside the frame scope (`Use "renderer.setAnimationLoop()"`, 494-500).

---

## 2. RenderPipeline (post-processing)

Import: `import { RenderPipeline, DirectRenderPipeline } from 'three/webgpu'` (src/Three.WebGPU.js:14-16). `PostProcessing` still exists as a deprecated alias that warns (r183; src/renderers/common/PostProcessing.js:9-24).

- `new RenderPipeline( renderer, outputNode = vec4(0,0,1,1) )` (src/renderers/common/RenderPipeline.js:30).
  - Properties: `outputNode`, `outputColorTransform = true` (75), `needsUpdate`.
  - Methods: `render()`, `dispose()`. `renderAsync()` is deprecated since r181 (251-259).
- `render()` (130-160) runs these steps:
  1. `_update()`, which rebuilds when `renderer.toneMapping` or `outputColorSpace` changed.
  2. The `onBeforePipelineCallbacks` (this is how TRAA and TAAU apply jitter).
  3. Temporarily sets `renderer.toneMapping = NoToneMapping` and `outputColorSpace = ColorManagement.workingColorSpace`, and disables XR.
  4. `this._quadMesh.render( renderer )`.
  5. Restores the renderer settings and runs `onAfterPipelineCallbacks`.
- Tone mapping and color space: with `outputColorTransform === true`, the final fragment is `renderOutput( outputNode, toneMapping, outputColorSpace )` (192-194). With `false`, the values are put in the context (`contextData.toneMapping/outputColorSpace`, 196-201), so you can place `renderOutput()` (no args) yourself mid-chain.
  - `RenderOutputNode.setup` order (src/nodes/display/RenderOutputNode.js ~101-140): clamp alpha -> `unpremultiplyAlpha` -> `toneMapping(...)` -> `workingToColorSpace(outputColorSpace)` -> `premultiplyAlpha`.
  - `renderOutput( color, toneMapping = null, outputColorSpace = null )` (RenderOutputNode.js:157). Exposure comes from `renderer.toneMappingExposure` (`toneMappingExposure` rendererReference, src/nodes/display/ToneMappingNode.js:145).
  - Because the final quad is drawn with NoToneMapping and working space, `needsFrameBufferTarget` is false, so **no extra output pass** runs under RenderPipeline (inferred from Renderer.js:2609-2616, 1668). The final quad is a `fullscreenPass`, so `currentSamples = 0` (Renderer.js:2639-2655, 1862): the canvas pass has no MSAA.

### `pass( scene, camera, options = {} )`
TSL, `three/tsl` (src/nodes/display/PassNode.js:1085). There is also `depthPass(...)` (1108).
- The constructor (198-488) creates `new RenderTarget(1, 1, { type: HalfFloatType, ...options })`. Any RenderTarget option is accepted (`samples`, `depthBuffer`, `type`, `format`, `stencilBuffer`, ...), plus `depthTexture` (custom DepthTexture), `autoClear`, `autoClearColor`, `autoClearDepth`, `autoClearStencil`.
  - A depth texture is created unless `options.depthBuffer === false` (251-260).
- **`setup()` overrides two options** (798-812):
  - `renderTarget.samples = options.samples === undefined ? renderer.samples : options.samples`. So with `antialias:true` the scene pass is **4× MSAA by default**.
  - `renderTarget.texture.type = renderer.getOutputBufferType()`. So **`options.type` is overwritten by the renderer's `outputBufferType`** (default HalfFloatType).
  - With `reversedDepthBuffer`, the depth texture type is FloatType.
- `updateBefore` (814-927) does the following:
  - Sizes the target to the drawing buffer × `_resolutionScale` (`setSize`, 935-966).
  - Toggles any `getPreviousTexture` history buffers.
  - Applies `overrideMaterial`, `setMRT(this._mrt)`, the autoClear flags, `transparent/opaque/lighting/contextNode` and camera layers (`setLayers`).
  - Renders with `renderer.render(scene, camera)`, then restores state.
  - Its `updateBeforeType` is FRAME (478), so it renders once per frameId.
- Public API:
  - `setResolutionScale(s)` / `getResolutionScale()` (497-514). The old `setResolution` is deprecated since r181.
  - `setLayers(layers)`, `setMRT(mrt)`, `getMRT()`, `setViewport(...)`, `setScissor(...)`.
  - Properties: `overrideMaterial`, `transparent`, `opaque`, `lighting`, `contextNode`, `name`.
  - `getTexture(name)` (602-627): `'depth'` throws if there is no depth buffer. Other names clone the output texture and push it into `renderTarget.textures`. So **MRT attachments inherit the output texture's type and format**, and you can change them afterwards, e.g. `getTexture('velocity').type = ...`.
  - `getTextureNode(name = 'output')` (683-697), `getPreviousTextureNode(name)` (705-721, ping-pong history).
  - `getViewZNode(name = 'depth')`: `perspectiveDepthToViewZ(depthTex, near, far)` (729-744). It is always the perspective formula.
  - `getLinearDepthNode(name = 'depth')`: `viewZToOrthographicDepth(viewZ, near, far)`, i.e. 0..1 linear (752-770). There is a `// TODO: just if ( builder.camera.isPerspectiveCamera )` (762).
  - Near and far are uniforms copied from the camera each updateBefore (854-855).
  - `compileAsync(renderer)` (783-796).
- In the node graph, `pass()` itself evaluates to `getTextureNode()` for COLOR and `getLinearDepthNode()` for DEPTH scope (810).

### MRT
- `mrt( { output, normal: normalView, velocity, ... } )` (src/nodes/core/MRTNode.js:243). Methods: `setBlendMode(name, blend)`, `getBlendMode`, `setClearColor(name, color, alpha)`, `has`, `get`, `merge` (MRTNode.js:107-203).
- Use it as `scenePass.setMRT( mrt({ output, velocity }) )`, then `scenePass.getTextureNode('velocity')`.
- Material-level override: `material.mrtNode` is merged into the renderer MRT (NodeMaterial.js:561-584).
- MRT per-target blending is not supported in WebGPU compatibility mode, which warns (src/renderers/webgpu/utils/WebGPUPipelineUtils.js:144-160).
- `velocity` is `nodeImmutable( VelocityNode )` (src/nodes/accessors/VelocityNode.js:224). See section 5.

### `rtt( node, width = null, height = null, options = {} )` / `convertToTexture( node, ...params )`
src/nodes/utils/RTTNode.js
- Options are `autoUpdate = true` and `resolutionScale = 1`. Any others go to the RenderTarget, default `type: HalfFloatType` (44-51).
- `autoResize` is `width === null`. It sizes to the drawing buffer × scale (264-279). It renders `node` into its target with a QuadMesh in `updateBefore` (FRAME, 144).
- API: `setResolutionScale`, `getResolutionScale`, `setSize`, `renderTarget`, `autoUpdate`, `textureNeedsUpdate`.
- `convertToTexture(node)` returns `node` if it is already a sample or texture node, `node.getTextureNode()` if it is a PassNode, and otherwise `rtt(node, ...)` (363-370). Every addon effect (`bloom` input excluded) wraps its input with it, so a non-texture input costs an extra fullscreen pass.

---

## 3. BloomNode `bloom()` vs UnrealBloomPass

Import: `import { bloom } from 'three/addons/tsl/display/BloomNode.js'`. Signature: `bloom( node, strength, radius, threshold )`, i.e. `new BloomNode( nodeObject(node), strength = 1, radius = 0, threshold = 0 )` (examples/jsm/tsl/display/BloomNode.js:70, 597).

Properties:
- `strength`, `radius`, `threshold` are uniforms. You can also pass nodes.
- `smoothWidth = uniform(0.01)` (107).
- `bloomTintColors` is an array of 5 `Vector3(1,1,1)` (116).
- `_resolutionScale = 0.5` (125). Change it with `setResolutionScale()` (297).
- `highPassFn` is replaceable (132).

It returns **only the bloom contribution**. You add it yourself, e.g. `scenePassColor.add( bloomPass )`.

| Aspect | BloomNode (r186) | UnrealBloomPass (r186) |
|---|---|---|
| Mips | `_nMips = 5` (156) | `nMips = 5` (101) |
| Base size | `floor(drawingBuffer × 0.5)` then `floor(/2)` per mip (322-339) | `Math.round(resolution/2)` then `round(/2)` (102-125, 250-264). `resolution` comes from the constructor or `setSize` (EffectComposer passes pixel-ratio-scaled size) |
| RT type | HalfFloat, no depth | HalfFloat, no depth |
| High-pass | `luminance(rgb)`, `alpha = smoothstep(threshold, threshold+smoothWidth, v)`, `mix(vec4(0), input, alpha)` (12-19) | LuminosityHighPassShader: same formula, `smoothWidth = 0.01` (136-137) |
| Blur kernel radii | `[6, 10, 14, 18, 22]` (425) | `[6, 10, 14, 18, 22]` (150) |
| Blur weights | `sigma = kernelRadius/3`, coeff `0.39894·exp(-0.5 i²/σ²)/σ`, adjacent taps merged into bilinear fetches (505-575) | identical coefficients and bilinear merge (381-420) |
| Blur output alpha | `vec4(diffuseSum, 1.0)` | n/a |
| Composite | `Σ lerpBloomFactor(f_i, radius) · vec4(tint_i,1) · blur_i`, **× strength** (435-449) | `3.0 * bloomStrength * Σ lerpBloomFactor(f_i) · tint_i · blur_i.rgb`, alpha = max(rgb) (517-527) |
| bloomFactors | `[1.0, 0.8, 0.6, 0.4, 0.2]` | same |
| lerpBloomFactor | `mix(f, 1.2 - f, radius)` (579-584) | same (510-514) |
| Blend with scene | the user adds it | additive `CopyShader` blend onto the readBuffer (184-191, 350-366) |

**Behavioral differences:**
- UnrealBloomPass multiplies by **3.0** ("for backwards compatibility with previous alpha-based intensity"). BloomNode does not, so **BloomNode strength must be 3× the UnrealBloomPass strength for the same result** (inferred from the formulas).
- Sizes use floor vs round (off-by-one at odd sizes).
- BloomNode's composite alpha is `strength·Σ factor·blurAlpha`, not `max(rgb)`. Adding a vec4 bloom to the scene also adds alpha.
- BloomNode sizes automatically from `renderer.getDrawingBufferSize()`, which includes pixel ratio. It runs as FRAME updateBefore: 12 quad passes.

---

## 4. TRAA, TAAU, FSR1, Sharpen

### TRAA
`import { traa } from 'three/addons/tsl/display/TRAANode.js'`. Signature: `traa( beautyNode, depthNode, velocityNode, camera )`, i.e. `new TRAANode( convertToTexture(beautyNode), depthNode, velocityNode, camera )` (examples/jsm/tsl/display/TRAANode.js:641).
- Doc comment: **"Note: MSAA must be disabled when TRAA is in use."** (19). So create the pass with `samples: 0` or leave the renderer's `antialias` off (inferred). In WebGPU, an MSAA render target's depth texture is itself multisampled (`primarySamples = samples` for non-array depth, src/renderers/webgpu/utils/WebGPUUtils.js:138-140). TRAA `copyTextureToTexture`s that depth into a single-sample history depth (TRAANode.js:426-428).
- Inputs: the beauty texture node (PassNode texture or RTT); `depthNode` is a depth *texture node* (`scenePass.getTextureNode('depth')`, since `.value` is used as a texture at 426); the velocity texture node; the camera.
- Tunables:
  - `depthThreshold = 0.0005`
  - `edgeDepthDiff = 0.001`
  - `maxVelocityLength = 128` (px)
  - `useSubpixelCorrection = true` (96-121)
- Jitter:
  - 32-entry **Halton(2,3)** sequence (`computeHaltonOffsets(32)`, 628; examples/jsm/tsl/utils/TAAUtils.js:161-163).
  - It is applied through `camera.setViewOffset(w, h, jx - 0.5, jy - 0.5, w, h)` in an `OnBeforeRenderPipeline` callback and cleared via `camera.clearViewOffset()` in `OnAfterRenderPipeline` (290-340, 446-465).
  - `_jitterIndex` increments on every clear and wraps mod 32 (337-338). **Jitter never stops**, including on static scenes.
  - Before jittering, it calls `camera.updateProjectionMatrix()` and gives the unjittered matrix to the velocity node (`_velocityNode.setProjectionMatrix(original)`, 294-297). Velocity therefore excludes jitter.
  - The velocity node is taken from `builder.context.velocity` when present, else the global `velocity` (473-481).
  - Only the first TRAA/TAAU in a pipeline owns jitter (`renderPipelineState.viewOffsetOwner`, 446-448).
  - Caveat: it overwrites any user `setViewOffset` on that camera and clears it afterwards.
  - It only works inside a RenderPipeline (`builder.renderPipeline` check, 446).
- History and blend:
  - `currentWeight = 0.05` minimum, `+ subpixelCorrection·0.25` (576-583).
  - `+ motionFactor` (px motion / maxVelocityLength), saturated. Invalid history gives weight 1 (585).
  - The final blend is `flickerReduction`: luminance-weighted (TAAUtils.js:52-86).
- Neighborhood handling:
  - **Variance clipping** over a 3×3 neighborhood (8 neighbors plus center) with `gamma = mix(0.5, 1, (1-motion)²)`.
  - Then `clipAABB` toward the clamped mean (485-518; TAAUtils.js:17-50).
  - Depth: 3×3 closest-depth dilation for the velocity fetch (`sampleCurrentDepth`, TAAUtils.js:88-138).
  - Disocclusion test against reprojected previous depth (`samplePreviousDepth`, 140-159), with an edge exception (563-566).
- Per frame (347-436):
  - resolve quad -> `_resolveRenderTarget`
  - `copyTextureToTexture(resolve -> history)`
  - depth copy to history depth (only if sizes match the drawing buffer)
  - On resize, the history is seeded by copying the beauty buffer (384-401).
  - Internal targets are HalfFloat. The output node is `passTexture(this, resolveRT.texture)`.
- Static scenes (inferred): jitter continues and the history converges toward a jitter-averaged image. The weight never drops below 0.05 (plus subpixel term), i.e. an EMA of about 20 frames.

### TAAU
`import { taau } from 'three/addons/tsl/display/TAAUNode.js'`. Same signature: `taau( beautyNode, depthNode, velocityNode, camera )` (TAAUNode.js:732).
- Doc: the inputs are expected to be lower resolution via `PassNode#setResolutionScale`. It does a 9-tap Blackman-Harris (Gaussian approximation) reconstruction to output resolution (drawing buffer). It is "an alternative to FSR2/3". **"MSAA must be disabled when TAAU is in use."**
- Tunables:
  - `currentFrameWeight = 0.025` (133)
  - `depthThreshold`, `edgeDepthDiff`, `maxVelocityLength` as in TRAA
- History RT has `count: 2`: color plus "lock" (161-163).
- Jitter: `setViewOffset(inW, inH, jx, jy, inW, inH)` with `jx, jy = halton - 0.5` in **input-pixel** units (328-357).
  - The comment says the range "must span one output pixel", but the code does not scale it.
  - Unlike TRAA, TAAU uses the **global `velocity`** directly (`velocity.setProjectionMatrix`, 335/366), not `builder.context.velocity`.
- Thin-feature "lock" logic with a two-sided depth gate (646-660). Same variance clip and flicker reduction as TRAA (629-665).
- Resize seeds the history with a bilinear upscale (`_seedMaterial`, 422-439).

### FSR1
`import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js'`. The JSDoc `@three_import` says `.../display/fsr1/FSR1Node.js`, but the file is at `examples/jsm/tsl/display/FSR1Node.js`.
- Signature: `fsr1( node, sharpness = 0.2, denoise = false )` (481). Sharpness `0` = max, `2` = none.
- Two passes, both into HalfFloat RTs sized to the **drawing buffer**:
  - EASU: a 12-tap edge-adaptive approximate Lanczos2 using `textureLoad`, no `textureGather` (a comment says gather is WebGPU-only).
  - RCAS (140-171).
- Upscale by rendering the input pass at `setResolutionScale(<1)`. EASU reads the input via `textureSize(textureNode)`.
- Doc (FSR1Node.js header): "Only use FSR 1 if your application is fragment-shader bound… should always be used with an anti-aliased source image."

### Sharpen (RCAS only)
`import { sharpen } from 'three/addons/tsl/display/SharpenNode.js'`. Signature: `sharpen( node, sharpness = 0.2, denoise = false )` (284). One pass into a HalfFloat RT at drawing-buffer size.
- RCAS limiter uses `hitMax = (1 - max(mx4, e)) / (4·mn4 - 4)` (SharpenNode.js:211-212), which assumes **0..1 input** (inferred). Apply it after `renderOutput`/tone mapping, not on HDR values.

---

## 5. VelocityNode / positionPrevious

- `velocity` (src/nodes/accessors/VelocityNode.js). Its `setup` (164-180) computes:
  - `clipCur = P · modelViewMatrix · positionLocal`, where `P` is `cameraProjectionMatrix` or `uniform(this.projectionMatrix)` if set via `setProjectionMatrix`.
  - `clipPrev = prevProj · prevView · prevModelWorld · positionPrevious`
  - It returns `ndcCur.xy - ndcPrev.xy` (a vec2 in **NDC units**; TRAA converts it with `* vec2(0.5, -0.5)` to UV).
- Previous matrices:
  - Object: `previousModelWorldMatrix` holds `object.matrixWorld` from the last `updateAfter` (per object, WeakMap; 105-110, 152-156).
  - Camera: previous projection and view matrices are tracked **per camera per frameId** (113-143). The first frame uses the current matrices.
- `positionPrevious = positionGeometry.toVarying('positionPrevious')` (src/nodes/accessors/Position.js:54).
- Who writes `positionPrevious`, only when `builder.needsPreviousData()`:
  - **InstancedMesh**: `positionPrevious.assign( previousInstanceMatrixNode.mul( positionPrevious ).xyz )`, with the previous instance matrices copied after each object update (src/nodes/accessors/Instance.js:209-231).
  - **BatchedMesh** (src/nodes/accessors/Batch.js:150-162).
  - **Skinning** (src/nodes/accessors/Skinning.js:268-272, 341-345).
  - **Line2NodeMaterial**, see below.
  - Morph targets: nothing found.
  - **`material.positionNode` does NOT update `positionPrevious`.** `NodeMaterial.setupPosition` assigns `positionLocal` from positionNode after instancing (src/materials/nodes/NodeMaterial.js:792-808). Vertex animation such as wind sway produces zero per-vertex motion vectors unless you also assign `positionPrevious` (inferred).
- `builder.needsPreviousData()` (src/nodes/core/NodeBuilder.js:3466-3472):
  ```js
  needsPreviousData() {
  	const mrt = this.renderer.getMRT();
  	return ( mrt && mrt.has( 'velocity' ) ) || ( this.object !== null && getDataFromObject( this.object ).useVelocity === true );
  }
  ```
  Shadow passes set `useVelocity` on casters when the current MRT has velocity (src/nodes/lighting/ShadowBaseNode.js:90-96, 204-211).
- Line2NodeMaterial pattern (src/materials/nodes/Line2NodeMaterial.js:526-540):
  ```js
  setupPosition( builder ) {
  	const localPosition = modelWorldMatrixInverse.mul( cameraWorldMatrix ).mul( cameraProjectionMatrixInverse ).mul( mvpLine );
  	positionLocal.assign( localPosition.xyz.div( localPosition.w ) );
  	if ( builder.needsPreviousData() ) {
  		positionPrevious.assign( positionLocal );
  	}
  	return super.setupPosition( builder );
  }
  ```
  To follow the same pattern for animated vertices, subclass the material and override `setupPosition(builder)`. Alternatively, inside a `positionNode` `Fn((…, builder) => …)`, check `builder.needsPreviousData()` and assign `positionPrevious` from a previous-time displacement. Note the ordering: `Instance.js` has already applied the previous instance matrix to `positionPrevious` before positionNode runs.
- `positionPrevious` is exported from `three/tsl` (src/Three.TSL.js:475).

---

## 6. Shadows in WebGPURenderer

- `renderer.shadowMap = { enabled: false, transmitted: false, type: PCFShadowMap }` (Renderer.js:713-717). There is **no renderer-level `shadowMap.autoUpdate`**; use the per-light `shadow.autoUpdate` / `shadow.needsUpdate`.
- Types (`_shadowFilterLib = [BasicShadowFilter, PCFShadowFilter, null /* PCFSoftShadowMap, removed */, VSMShadowFilter]`, src/nodes/lighting/ShadowNode.js:117):
  - `BasicShadowMap`: a single `texture(depth).compare(z)` (src/nodes/lighting/ShadowFilterNode.js:20-32).
  - `PCFShadowMap` (default), described below.
  - `PCFSoftShadowMap`: **removed**. `_renderScene` warns "PCFSoftShadowMap has been removed. Using PCFShadowMap instead." and rewrites the type (Renderer.js:1658-1664, also 902). The constant is `@deprecated since r186` (src/constants.js:73-75). WebGLRenderer r186 does the same (src/renderers/webgl/WebGLShadowMap.js:99-102).
  - `VSMShadowMap`: 2 blur passes with `shadow.blurSamples` (default 8) and `shadow.radius`, then a Chebyshev test with a light-bleed remap `(p - 0.3) / 0.65` (ShadowNode.js:37-115, 383-447, 718-734; ShadowFilterNode.js:93-128).
- **PCF implementation** (ShadowFilterNode.js:48-82):
  - **5 taps** on a **Vogel disk**, rotated per pixel by **interleaved gradient noise** of `screenCoordinate` (`phi = IGN·2π`).
  - `radiusScaled = shadow.radius · (1/mapSize.x)`, so radius is in shadow-map texels. `LightShadow.radius` defaults to 1 (src/lights/LightShadow.js:87).
  - Each tap is a hardware compare. The depth texture uses `LinearFilter` when `PCFShadowMap && hasCompatibility(TEXTURE_COMPARE)`, which gives 2×2 bilinear PCF per tap (ShadowNode.js:363-376).
  - The result is a per-pixel noisy 5-tap pattern that expects TAA or accepts dithering (inferred). WebGLRenderer r186 uses the identical 5-tap Vogel/IGN scheme (src/renderers/shaders/ShaderChunk/shadowmap_pars_fragment.glsl.js:148-175).
- Custom filter: `light.shadow.filterNode = Fn(({ depthTexture, shadowCoord, shadow, depthLayer }) => float)` overrides the type filter (ShadowNode.js:479). It is wrapped in a frustum test (259-271).
- Bias semantics (ShadowNode.js:280-319, 451-475):
  - `shadowCoord.z = coordZ + bias`, or `- bias` with reversedDepth. `bias` is `shadow.biasNode || reference('bias')`, default `bias = 0` (LightShadow.js:53).
  - The normal bias is applied in **world space before projection**: `shadowPosition = shadowMatrix · (shadowPositionWorld + normalWorld·normalBias)`.
  - Migration Guide r182→r183: "WebGPURenderer shadows: It might be necessary to remove or decrease shadow bias values".
  - Shadow `intensity` mixes the result: `mix(1, shadow, intensity)`.
  - With `renderer.highPrecision` it uses a per-object `shadowMatrix·matrixWorld` uniform (459-473).
- Update policy (ShadowNode.js:792-826):
  - The shadow map re-renders when `shadow.needsUpdate || shadow.autoUpdate`, but only once per **(camera, frameId)**. `_cameraFrameId` is a WeakMap keyed by `frame.camera`.
  - Caveat (inferred): a render with **another camera in the same frame, e.g. the reflector's virtual camera, re-renders the shadow map**, because the key is per camera. Setting `autoUpdate=false` plus `needsUpdate=true` when needed avoids this.
  - It is skipped during `compileAsync` (`_isPreCompiling`, 796).
  - `needsUpdate` resets to false after a render (818-822).
  - The shadow camera inherits the view camera's layers if its own mask has only layer 0 (675-681).
- Shadow pass material handling (Renderer.js:3706-3812; `_getShadowNodes` 3498-3597):
  - `scene.overrideMaterial` is a per-light `NodeMaterial` with `colorNode = vec4(0,0,0,1)`, `isShadowPassMaterial`, `NoBlending`, `fog = false` (ShadowBaseNode.js:28-47).
  - For each object, the override copies:
    - `alphaTest`
    - `alphaMap`
    - `displacementMap/Scale/Bias`
    - `transparent`
    - `positionNode`: `castShadowPositionNode` wins, then `positionNode` (3574-3582, also 3742-3746)
    - `depthNode`
    - `side`: `material.shadowSide` if set, else **Front↔Back swapped** (`_shadowSide = {Front: Back, Back: Front, Double: Double}`, Renderer.js:50, 3761-3769). VSM keeps `material.side`.
  - Shadow `colorNode` alpha = `castShadowNode.a (or 1) × map.a (if map) × material.colorNode.a (if colorNode)`. Then, if `maskShadowNode || maskNode` exists, `maskNode.not().discard()` is prepended (3515-3564). Since `alphaTest` is copied, NodeMaterial's `diffuseColor.a <= alphaTest -> discard` applies (NodeMaterial.js:870-887).
  - **So for alpha-tested instanced cards**, one of these is required: `alphaTest` with the alpha in `colorNode.a` or `map`; or `maskShadowNode` / `maskNode`. Instancing is applied automatically in the shadow pass (setupPosition).
  - `castShadowNode` requires `renderer.shadowMap.transmitted = true` (3525-3529).
  - Shadows are cast when `object.castShadow === true`, or `receiveShadow` under VSM (ShadowBaseNode.js:90).
- Other material hooks: `receivedShadowPositionNode` (NodeMaterial.js:289) and `receivedShadowNode` (315).

---

## 7. Fog

Everything below is from src/nodes/fog/Fog.js, TSL (`three/tsl`):
- `rangeFogFactor( near, far )` = `smoothstep(near, far, viewZ)` (40-46).
- `densityFogFactor( density )` = `1 - exp(-(density² · viewZ²))` (57-63).
- `exponentialHeightFogFactor( density, height )`: `distance = max(height - positionWorld.y, 0)`, `m = distance · viewZ`, returns `1 - exp(-(density²·m²))` (73-82).
- `fog( color, factor )` = `vec4( mix(output.rgb, color, factor), output.a )` (93-97). It reads the `output` property.
- `viewZ` is `-(builder.context.getViewZ?.() || positionView.z)` (16-30).
- The scene fog node is `scene.fogNode || nodeFor(scene.fog)` (src/renderers/common/nodes/NodeManager.js:619-624). `THREE.Fog` maps to `fog(color, rangeFogFactor(near, far))` and `FogExp2` maps to `fog(color, densityFogFactor(density))`, both with renderGroup references (818-864).
- In the material (NodeMaterial.js:1134-1148, 1190-1210): `if (material.fog) { output.assign(outputNode); outputNode = vec4(fogNode) }`. This happens **after** lighting and emissive and before premultiplied alpha. `material.outputNode` replaces the result after that (547-549).
- Custom fog: set `scene.fogNode = fog( myColorNode, myFactorNode )`, or any `vec4` node reading `output`. For example, a distance-based factor from `positionWorld.sub(cameraPosition).length()`, with `positionWorld` / `cameraPosition` from `three/tsl`, or height fog with `positionWorld.y`. The fog node's cache key is part of the render cache key (NodeManager.js:663-664).
- Migration r171→r172: `rangeFog()` / `densityFog()` are deprecated in favor of `fog(color, rangeFogFactor(...))`.

---

## 8. `reflector()` (ReflectorNode)

TSL, `three/tsl`: `reflector( parameters )` (src/nodes/utils/ReflectorNode.js:632).

Parameters (220-231):
- `target = new Object3D()`: add it to the mirror mesh. The plane normal is the target's local +Z (462-463).
- `resolutionScale = 1`: the RT is `Math.round(drawingBuffer × scale)` (347-355). The old `resolution` parameter is deprecated since r180.
- `generateMipmaps = false`: sets `LinearMipMapLinearFilter` when true.
- `bounces = true`: `updateBeforeType = bounces ? RENDER : FRAME` (303). With false, reflectors inside a reflection are skipped (`_inReflector`).
- `depth = false`: adds a DepthTexture. Get it via `getDepthNode()` (126-145), which throws if `depth` was false.
- `samples = 0`: MSAA of the reflection RT.
- `defaultTexture`, `reflector` (share a base node).

Behavior:
- RT: `new RenderTarget(1, 1, { type: HalfFloatType, samples })`, one per virtual camera (410-437).
- `getVirtualCamera( camera )` returns `camera.clone()`, **cloned once per source camera and cached** (387-401). **Layers and other camera properties are copied only at clone time** (inferred). Each frame it sets:
  - position and lookAt: reflected (486-511)
  - `up`
  - `near`/`far`
  - `projectionMatrix = camera.projectionMatrix` (512). This includes any TRAA jitter present at the time (inferred).
- **Oblique near-plane clipping** (Lengyel; 514-537): the third row of the projection matrix is replaced. `clipBias = 0`. The WebGPU vs WebGL depth range is handled via `coordinateSystem`. There is no user clip-plane option.
- Facing away: skipped, or the RT is cleared if it had output (467-484). Use `forceUpdate` to force a render.
- During the reflection render (549-583):
  - the reflecting `material.visible = false`
  - `setMRT(null)`
  - `autoClear = true`
  - `renderer.render(scene, virtualCamera)`, with the scene named `… [ Reflector ]`
- It is ignored when used on a QuadMesh / in post-processing (150).
- Sampling and distortion: the default UV is `screenUV.flipX()` (32). It is a TextureNode, so `reflection.uvNode = reflection.uvNode.add( distortionVec2 )` or `.sample( uvExpr )` works. `reflection.target` is the Object3D. `.reflector` is the base node with `resolutionScale`, `forceUpdate`, `hasOutput`, `renderTargets`, `getVirtualCamera`.

---

## 9. Node materials (MeshStandardNodeMaterial and friends)

Import: `import { MeshStandardNodeMaterial, … } from 'three/webgpu'`.

Build order in `NodeMaterial.setup` (src/materials/nodes/NodeMaterial.js:470-608):
- Vertex: `setupPosition` does morph -> skinning -> displacementMap -> **batch** -> **instancedMesh** -> `positionLocal.assign(positionNode)` (766-812). Then MVP. `vertexNode` overrides everything.
- Fragment:
  - clipping
  - depth (`depthNode`)
  - `setupDiffuseColor` (819-905):
    - `maskNode` -> `bool(maskNode).not().discard()`
    - `colorNode` (else `materialColor`)
    - × `vertexColor()` if `vertexColors && geometry.hasAttribute('color')`
    - `instanceColor.mul(colorNode)` if `object.instanceColor`
    - `batchColor`
    - `diffuseColor.a *= opacityNode || materialOpacity`
    - alpha test
    - alpha hash
    - `builder.isOpaque()` -> `a = 1`
  - AO -> `setupVariants` (Standard: metalness, roughness, specular)
  - `setupLighting`: the lighting model over `lightsNode || builder.lightsNode`, **then `outgoingLight += emissive`** where `emissive = emissiveNode || materialEmissive` (1086-1125)
  - `vec4(outgoingLight, diffuseColor.a).max(0)`
  - `setupOutput`: **fog**, then premultipliedAlpha (1190-1210)
  - `outputNode`, if set, replaces the result (547-549)
  - MRT merge
  - `fragmentNode` replaces the whole fragment logic (586-598).

Hooks:
- `colorNode` (153), `normalNode` (166), `opacityNode`, `alphaTestNode` (221), `maskNode` (230), `maskShadowNode` (238), `positionNode` (255), `geometryNode`, `depthNode`, `receivedShadowPositionNode`, `castShadowPositionNode`, `receivedShadowNode`, `castShadowNode`, `outputNode` (351), `mrtNode`, `fragmentNode`, `vertexNode`, `contextNode`, `envNode`, `aoNode`, `lightsNode` (103), `backdropNode`, `backdropAlphaNode`.
- Standard material adds `emissiveNode`, `metalnessNode`, `roughnessNode` (src/materials/nodes/MeshStandardNodeMaterial.js:64-90).
- **Custom light contribution after lighting and before fog**: `emissiveNode` is exactly "added to outgoingLight before fog" (NodeMaterial.js:1113-1121). Other options:
  - subclass and override `setupLighting(builder)` to return `super.setupLighting(builder).add(extra)`
  - `outputNode`, which runs after fog; there the `output` property holds the post-fog color
  - `material.lightsNode = lights([...])` restricts lights (src/nodes/lighting/LightsNode.js:501)
- `alphaTest` with `alphaToCoverage`: when `alphaToCoverage === true`, `a = smoothstep(t, t + fwidth(a), a)`; discard if `a <= 0`. Otherwise it discards if `a <= t` (NodeMaterial.js:872-887).
  - WebGPU pipeline: `multisample.alphaToCoverageEnabled = material.alphaToCoverage && sampleCount > 1` (src/renderers/webgpu/utils/WebGPUPipelineUtils.js:211-212).
  - WebGL fallback: enabled only when `renderer.currentSamples > 0` (src/renderers/webgl-fallback/utils/WebGLState.js:958).
  - So **A2C is a no-op without MSAA**, e.g. under TRAA with samples 0. It degrades to an alpha test at `t` (inferred).
- `alphaHash = true`: `diffuseColor.a < getAlphaHashThreshold(positionLocal)` -> discard (891-895). The noise is stable in object space, so it pairs with TAA (inferred).
- Vertex colors: `vertexColor(index = 0)` is a vec4 attribute (defaults to `vec4(1)` if missing) (src/nodes/accessors/VertexColorNode.js:24, 59-74, 109).
- `instanceColor`: `varyingProperty('vec3', 'vInstanceColor')`, filled from the InstancedMesh's `instanceColor` (src/nodes/accessors/Instance.js:112, 145-171, 244-248). It is applied automatically.
- Custom attributes:
  - `attribute( name, nodeType = null )` (src/nodes/core/AttributeNode.js:168). The type is inferred from the geometry attribute. In the fragment stage it becomes an automatic varying (102-129). A missing attribute warns and returns a constant.
  - `geometry.setAttribute('aFlex', new InstancedBufferAttribute(...))` works with `attribute('aFlex')`. The step mode comes from `isInstancedBufferAttribute`: WebGPU `GPUInputStepMode.Instance` (src/renderers/webgpu/utils/WebGPUAttributeUtils.js:300-310); WebGL `vertexAttribDivisor(i, meshPerAttribute)` (WebGLBackend.js:2634-2640).
  - Without a geometry attribute: `instancedBufferAttribute( array|BufferAttribute, type, stride = 0, offset = 0 )`, `instancedDynamicBufferAttribute(...)`, `bufferAttribute`, `dynamicBufferAttribute` (src/nodes/accessors/BufferAttributeNode.js:401-441).
- `varying( node, name? )` and `vertexStage( node )` (= `varying(node)`) (src/nodes/core/VaryingNode.js:207, 217). The method forms are `.toVarying()` / `.toVertexStage()` (renamed in r173).
- `onBeforeCompile` has no equivalent. Everything is node hooks, subclass overrides of `setup*` methods, or `material.contextNode`.

---

## 10. Instancing, batching, indirect, compute

- **InstancedMesh** (Instance.js:28-75):
  - If `count × 64 B <= getUniformBufferLimit()`, matrices go in a **uniform buffer** of full `instanceMatrix.count` capacity.
    - WebGPU limit: `device.limits.maxUniformBufferBindingSize` (src/renderers/webgpu/utils/WebGPUCapabilities.js:40-44). The device is requested with `requiredLimits = {}` (WebGPUBackend.js:127), so the default 65536 B gives about 1024 instances (inferred from the WebGPU default limit).
    - WebGL limit: `MAX_UNIFORM_BLOCK_SIZE` (WebGLCapabilities.js:75-85).
  - Above the limit, it uses 4 instanced vec4 vertex attributes over an `InstancedInterleavedBuffer`. `DynamicDrawUsage` means the dynamic variant, synced per frame via `OnBeforeFrameUpdate` (130-202).
  - A `StorageInstancedBufferAttribute` matrix gives `storage(...).element(instanceIndex)`.
  - `mesh.count` changes only the draw `instanceCount` (`Math.max(0, object.count)`, src/renderers/common/RenderObject.js:617-631). There is no rebuild.
  - The geometry cache key includes **`object.uuid` for InstancedMesh or `count > 1`**, plus `receiveShadow` (RenderObject.js:846-856). So **each InstancedMesh gets its own pipeline/program cache entry** (a TODO in the code references PR #29066).
- **BatchedMesh**:
  - WebGPU loops `drawIndexed(count_i, 1, start_i, 0, i)`, **one draw call per batch item** with `firstInstance = i` (WebGPUBackend.js:2123-2143).
  - WebGL uses `WEBGL_multi_draw` if available, else a per-item loop with a `nodeUniformDrawId` uniform (WebGLBackend.js:1052-1076).
- **Indirect draw**: `geometry.setIndirect( indirectAttribute, indirectOffset = 0 )` (src/core/BufferGeometry.js:253-257). The offset may be an array.
  - WebGPU uses `drawIndexedIndirect` / `drawIndirect` per offset (WebGPUBackend.js:2149-2190). `info.update` still counts CPU-side `drawParams` counts.
  - **The WebGL backend ignores indirect** (no `getIndirect` in webgl-fallback). It draws with normal CPU draw params.
  - `IndirectStorageBufferAttribute` is exported from `three/webgpu` (Three.WebGPU.js:26).
  - Compute dispatch with an `IndirectStorageBufferAttribute` count warns and falls back to `computeNode.count` on WebGL (WebGLBackend.js:963-968).
- **Compute**:
  - `compute( node, count, workgroupSize = [64] )` (src/nodes/gpgpu/ComputeNode.js:294).
  - `renderer.compute( computeNodes, dispatchSize = null )` (Renderer.js:2877). `computeAsync` is deprecated.
  - `instancedArray( count|TypedArray, type = 'float' )` = `storage( new StorageInstancedBufferAttribute(...), type, count )`. `attributeArray(...)` uses `StorageBufferAttribute` (src/nodes/accessors/Arrays.js:15-60).
  - `storage( value, type = null, count = 0 )` (src/nodes/accessors/StorageBufferNode.js:405).
- **WebGL2 fallback compute = transform feedback** (WebGLBackend.js:918-1000):
  - `RASTERIZER_DISCARD`, `beginTransformFeedback(POINTS)`, `drawArrays(Instanced)(POINTS, …, count)`, then swap the dual buffers.
  - Without `storageBuffer` support, a storage node is a vertex **attribute plus a varying registered as a transform** (StorageBufferNode.js:371-389).
  - `.element(i)` **ignores the index** and reads the current vertex or instance's attribute, unless `.setPBO(true)`. With PBO it reads via texture fetch (`generatePBO`) for non-assign contexts (src/nodes/utils/StorageArrayElementNode.js:75-118).
  - So on WebGL, compute can only write element `instanceIndex` of each output buffer, and random reads need PBO (inferred).
  - `instancedArray` used in a render material reads as an **instanced vertex attribute** (per-instance), which works with `element(instanceIndex)` (inferred).

---

## 11. Points and sprites

src/materials/nodes/PointsNodeMaterial.js
- Doc: "WebGPU only supports point primitives with a pixel size of `1`". With `THREE.Points`, `sizeNode` has no effect on WebGPU. The GLSL fallback hard-codes `gl_PointSize = 1.0;` (src/renderers/webgl-fallback/nodes/GLSLNodeBuilder.js:1600), so it has no effect there either.
- For sized points, use **`new THREE.Sprite( pointsNodeMaterial )`** with `sprite.count = N` (src/objects/Sprite.js:119) and `positionNode` per instance (`instancedBufferAttribute(...)` or `storage.element(instanceIndex)`). The object is **not** `Points`, so `setupVertexSprite` expands each quad in clip space (90-162):
  - `pointSize = (sizeNode ?? material.size) · screenDPR`
  - with `sizeAttenuation` and a perspective camera: `× (0.5·canvasHeightCSS) / -viewZ`
  - `× scaleNode`
  - optional `rotationNode`
  - `offset / (viewportSize/2) · clip.w`
- The base is SpriteNodeMaterial, so **`transparent = true` by default** (src/materials/nodes/SpriteNodeMaterial.js ctor). Set `blending = AdditiveBlending`, `depthWrite = false` as with any material.
- `alphaToCoverage` is a getter/setter that triggers `needsUpdate` (185-200).
- Sprites do not cast shadows (Sprite.js:34).
- Instanced sprites use Sprite frustum culling by object position (Sprite.js:131). Set `frustumCulled = false` (inferred).
- `InstancedPointsNodeMaterial` was removed in r173.

---

## 12. Renderer init and options

- `new WebGPURenderer( params )` (src/renderers/webgpu/WebGPURenderer.js:53-103). `forceWebGL` gives `WebGLBackend`. Otherwise it creates `WebGPUBackend` with `getFallback = () => { warn('WebGPU is not available, running under WebGL2 backend.'); return new WebGLBackend(parameters) }`.
- Options from the Renderer, Backend and WebGPUBackend typedefs:

  | Option | Default | Source |
  |---|---|---|
  | `logarithmicDepthBuffer` | false | Renderer.js:60-106 |
  | `reversedDepthBuffer` | false | " |
  | `alpha` | true | " |
  | `depth` | true | " |
  | `stencil` | false | " |
  | `antialias` | false (true means 4 samples: `this._samples = samples \|\| (antialias ? 4 : 0)`, Renderer.js:216) | " |
  | `samples` | 0 | " |
  | `getFallback` | null | " |
  | **`outputBufferType`** | **HalfFloatType** | " |
  | `multiview` | false | " |
  | `trackTimestamp` | false | WebGPUBackend.js:55-73 |
  | `powerPreference` | undefined | " |
  | `requiredLimits` | {} | " |
  | `device` | — | " |
  | `outputType` | undefined (canvas format, preferred by default) | " |
  | `forceWebGL` | false | " |

  The old `colorBufferType` was renamed to `outputBufferType` in r182. `getColorBufferType()` is deprecated in favor of `getOutputBufferType()` (Renderer.js:1324-1334).
- `await renderer.init()` (Renderer.js:784-848): it runs `backend.init`, and **on any throw calls `_getFallback(error)`** and inits WebGL. Sync `render()` before init throws (1496-1504). `setAnimationLoop` auto-inits (2067-2073).
- Fallback trigger (WebGPUBackend.js:200-300): `navigator.gpu.requestAdapter({ powerPreference, featureLevel: 'compatibility', xrCompatible })`.
  - If `navigator.gpu` is undefined, `.requestAdapter` throws a TypeError, which leads to the fallback (inferred).
  - A null adapter throws `'Unable to create WebGPU adapter.'`, which also leads to the fallback.
  - Device-creation failure leads to the fallback too.
- Checks: `renderer.backend.isWebGPUBackend` (WebGPUBackend.js ~88) or `renderer.backend.isWebGLBackend` (WebGLBackend.js:59). `renderer.coordinateSystem`.
- `await renderer.compileAsync( scene, camera, targetScene = null, onProgress = null )` (Renderer.js:896). It builds node programs and pipelines sequentially, yielding. It uses the framebuffer target if `needsFrameBufferTarget`. It advances `nodeFrame` (949). Shadow maps are not rendered during precompile.
- `renderer.info` (src/renderers/common/Info.js):
  - `calls` (cumulative `_renderScene` count)
  - `frame`
  - `render: { calls, frameCalls, drawCalls, triangles, points, lines, timestamp }`
  - `compute: { calls, frameCalls, timestamp }`
  - `memory: { attributes, geometries, programs, programsSize, renderTargets, textures, texturesSize, uniformBuffers, …, total }`
  - `reset()` zeroes `drawCalls`, `frameCalls` and `triangles/points/lines` each RAF (187-198).
  - `render.calls` is cumulative (all render calls, including every quad and shadow pass).
  - `drawCalls` / `triangles` are per frame. They are incremented in `info.update()` per draw (156-182) and from WebGLBufferRenderer.js:29-88 on WebGL.
  - `memory.programs` counts **shader stage modules** (vertex, fragment and compute separately; src/renderers/common/Pipelines.js:110-211). The pipeline count is only available privately as `renderer._pipelines.caches.size` (Pipelines.js:62).
- Device lost (WebGPU): `device.lost.then(info => renderer.onDeviceLost({ api, message, reason, originalEvent }))` unless the reason is `'destroyed'` (WebGPUBackend.js:265-279).
  - The default `_onDeviceLost` logs and sets `_isDeviceLost = true` (Renderer.js:1348-1362). After that, `_renderScene`, compute and `compileAsync` silently return (1656, 2879, 898, 1117).
  - There is no automatic recovery.
  - Uncaptured errors go to `renderer.onError` (WebGPUBackend.js:281-294; Renderer.js:1370).

---

## 13. Migration notes (r170 → r186)

Source: the GitHub wiki Migration-Guide (fetched), plus deprecation strings in the source.
- **Clock → Timer**: Timer moved to core in r179 (`THREE.Timer`, src/core/Timer.js; exported at src/Three.Core.js:110). `Clock` is deprecated since r183 and warns on construction (src/core/Clock.js:6, 61).
  - Timer API: `update(timestamp?)` must be called once per frame (156-174). `getDelta()` and `getElapsed()` return **seconds** (80-100). Also `setTimescale`, `reset`, `dispose`.
  - `connect(document)` enables the Page Visibility API (r174 requirement for that behavior). Delta is 0 while hidden.
- **OrbitControls**: the constructor is `( object, domElement = null )`. It calls `connect(domElement)` only if the element is non-null (examples/jsm/controls/OrbitControls.js:96, 457-461). Otherwise call `controls.connect(canvas)` later. r175: "`Controls.connect()` requires a DOM element now". `Controls.connect(element)` disconnects the previous element first (src/extras/Controls.js:83-89).
- **renderAsync** and the other `*Async` methods (`clearAsync`, `hasFeatureAsync`, `initTextureAsync`, `QuadMesh.renderAsync`, `RenderPipeline.renderAsync`, PMREM `from*Async`) are deprecated since r181. Use `await renderer.init()` once, then the sync calls (Renderer.js:1201-1209 etc.). `waitForGPU()` was removed (Renderer.js:1219-1223).
- **PCFSoftShadowMap**: deprecated for WebGLRenderer in r182, removed for WebGPURenderer in r186 ("use `PCFShadowMap`, which is now soft as well"). Both renderers warn and switch to PCF at runtime.
- **Shadow bias**: r182→r183: "WebGPURenderer shadows: It might be necessary to remove or decrease shadow bias values". The source has no numeric retune guidance. The bias formula is in section 6.
- **ColorManagement**: defaults are `enabled: true`, `workingColorSpace: LinearSRGBColorSpace` (src/math/ColorManagement.js:21-23). Renderer defaults are `outputColorSpace = SRGBColorSpace`, `toneMapping = NoToneMapping`, `toneMappingExposure = 1` (Renderer.js:184-200). r177 renamed `fromWorkingColorSpace` to `workingToColorSpace` and `toWorkingColorSpace` to `colorSpaceToWorking`; the old names warn (ColorManagement.js:150-158).
- Other relevant renames and changes:
  - `PostProcessing` → `RenderPipeline` (r183)
  - `PassNode.setResolution` → `setResolutionScale` (r181)
  - `ReflectorNode` `resolution` → `resolutionScale` (r180)
  - `TRAAPassNode` → `TRAANode` with a new setup (r179)
  - `label()` → `setName()` (r179)
  - `PI2` → `TWO_PI` (r181)
  - `varying()` / `vertexStage()` method forms → `toVarying()` / `toVertexStage()` (r173)
  - `rangeFog` / `densityFog` → `fog(color, factor)` (r172)
  - `TextureNode.uv()` → `.sample()` (r172)
  - `shadowWorldPosition` → `shadowPositionWorld` (r172)
  - `PostProcessingUtils` → `RendererUtils` (r172)
  - `transformedNormalView/World` → `normalView/World` (r178)
  - `directionToColor` → `packNormalToRGB` (r185)
  - `Source` → `TextureSource` (r186)
  - r185: WebGPURenderer premultiplied-alpha output change; the wiki says to "configure an opaque background color via `Scene.background`"
  - r181: PBR energy conservation, indirect specular and PMREM changes alter appearance
  - r183: `WebGLCubeRenderTarget` can't be used with WebGPURenderer
  - r178: `MultiplyBlending` / `SubtractiveBlending` require `premultipliedAlpha = true`

---

## 14. Chrome WebGPU compatibility mode

- **Always requested**: `requestAdapter({ powerPreference, featureLevel: 'compatibility', xrCompatible })` (WebGPUBackend.js:215-219). The device requests every feature the adapter exposes (229-245). This includes `'core-features-and-limits'` when available, so a core-capable adapter yields a core device (inferred).
- `backend.compatibilityMode = ! device.features.has('core-features-and-limits')` (258). It is `null` before init (WebGPUBackend.js:107).
- **In compatibility mode, `renderer._samples = 0`** (260-264), so `antialias` / renderer MSAA are disabled. PassNodes default to `renderer.samples`, so they are also non-MSAA unless `samples` is passed explicitly (inferred).
- Other compat-mode branches:
  - A depth texture with `compareFunction === null` is bound as `texture_2d<f32>` / unfilterable-float instead of `texture_depth_2d` (src/renderers/webgpu/nodes/WGSLNodeBuilder.js:2185-2191; src/renderers/webgpu/utils/WebGPUBindingUtils.js:523-527).
  - `textureLoad` of a depth texture appends `.x` (WGSLNodeBuilder.js:799-803).
  - MRT per-attachment blending falls back to material blending, with a warning (WebGPUPipelineUtils.js:144-160).
- There is no user option to force or skip compatibility mode apart from passing your own `device` (`parameters.device`, WebGPUBackend.js:251-255).
