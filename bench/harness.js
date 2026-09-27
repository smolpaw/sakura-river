// In-page bench driver. The Node runners (perf.mjs, visual.mjs) call these through page.evaluate.
// One rendered frame per requestAnimationFrame: WebGPURenderer's post nodes update once per frame id.
const H = (window.H = {});
let eng = null, canvas = null;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const now = () => performance.timeOrigin + performance.now();

H.env = async () => {
  const out = { dpr: window.devicePixelRatio, ua: navigator.userAgent, crossOriginIsolated: window.crossOriginIsolated };
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const e = gl.getExtension('WEBGL_debug_renderer_info');
    out.webgl = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    out.webglTimer = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch (e) { out.webgl = 'error: ' + e.message; }
  try {
    const a = navigator.gpu && (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }));
    out.webgpu = a ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description, device: a.info.device, features: [...a.features] } : null;
  } catch (e) { out.webgpu = 'error: ' + e.message; }
  return out;
};

H.setup = async ({ engine, cssW, cssH, quality = 'high', backend, stress, settings = {}, adaptive = false, extra = {} }) => {
  const mod = await import(engine);
  canvas = document.createElement('canvas');
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  document.body.appendChild(canvas);
  const t0 = performance.now();
  eng = await mod.create(canvas, { manual: !adaptive, fixedQuality: !adaptive, quality, bench: true, backend, stress, introDuration: 0, ...extra });
  const createMs = performance.now() - t0;
  for (const k in settings) eng.setImmediate(k, settings[k]);
  await raf(); await raf();
  return { createMs, canvas: [canvas.width, canvas.height], info: eng.info(), timer: eng.bench ? eng.bench.hasTimer : false, backend: eng.backend || 'webgl' };
};

H.view = (v, settle = 120, dt = 1 / 60) => {
  if (v.hero) eng.heroView();
  else if (v.cine !== undefined) eng.cineView(v.cine);
  else eng.setView(v.pos, v.target);
  for (const k in v.settings || {}) eng.setImmediate(k, v.settings[k]);
  if (settle) eng.advance(settle, dt);
};

H.set = (k, v) => eng.setImmediate(k, v);
H.cinematic = (on) => eng.setCinematic(on);

// wait until the GPU has drained all submitted work (WebGPU queue, or a WebGL fence)
async function gpuIdle() {
  if (eng.bench && eng.bench.waitIdle) { const p = eng.bench.waitIdle(); if (p) return p; }
  const gl = canvas.getContext('webgl2');
  if (!gl) return;
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 0));
  gl.deleteSync(sync);
}

// render n frames; returns per-frame { cpu, t, pf } plus GPU samples keyed by probe frame.
// sync: drain the GPU before each frame, so the measured CPU time is JS work without GPU backpressure
// (WebGPU blocks in writeBuffer/getCurrentTexture when the GPU is behind).
H.frames = async (n, dt = 1 / 60, sync = false) => {
  const cpu = new Float64Array(n), cpuTotal = new Float64Array(n), t = new Float64Array(n), pf = new Int32Array(n);
  const gpu = [];
  for (let i = 0; i < n; i++) {
    if (sync) await gpuIdle();
    await raf();
    const t0 = performance.now();
    eng.tick(1, dt);
    cpuTotal[i] = performance.now() - t0;
    cpu[i] = cpuTotal[i] - (eng.bench && eng.bench.blockedMs ? eng.bench.blockedMs : 0); // minus swapchain waits
    t[i] = now();
    pf[i] = eng.bench ? eng.bench.frame : i;
    if (eng.bench) gpu.push(...eng.bench.poll());
  }
  return { cpu: [...cpu], cpuTotal: [...cpuTotal], t: [...t], pf: [...pf], gpu };
};

// wait for outstanding GPU timer results without rendering (the CPU can run ~20 frames ahead of the GPU)
H.drain = async (maxMs = 5000) => {
  const gpu = [];
  const t0 = performance.now();
  while (performance.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 16));
    gpu.push(...eng.bench.poll());
    if (eng.bench.pending === 0) break;
  }
  return gpu;
};

H.counters = () => (eng.bench ? eng.bench.counters() : null);
H.disjoint = () => (eng.bench ? eng.bench.disjointFrames : 0);
H.info = () => eng.info();
H.meshStats = () => eng.meshStats();
H.quality = () => (eng.qualityState ? eng.qualityState() : null);
H.setAdaptive = (on) => eng.setAdaptive && eng.setAdaptive(on); // the baseline engine has no setter: its ladder keeps running
H.setBallast = (ms) => eng.setBallast && eng.setBallast(ms);

// Canvas contents right after a render. WebGL canvases are read back with readPixels and sent as raw RGBA (the
// server encodes the PNG): with Chromium's Vulkan features on, toBlob and 2D canvases return transparent black.
// WebGPU canvases use toBlob (its snapshot is synchronous).
async function snapshot(c) {
  const gl = c.getContext('webgl2');
  if (!gl) return { body: await new Promise((r) => c.toBlob(r, 'image/png')), query: '' };
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4), out = new Uint8Array(w * h * 4), row = w * 4;
  // restore the bindings afterwards: the renderer caches them and may be mid-loop
  const rb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING), db = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, db);
  for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return { body: out, query: `&w=${w}&h=${h}` };
}

// render one frame and upload the canvas as PNG to bench/<path>
H.capture = async (path, dt = 0) => {
  await raf();
  eng.tick(1, dt);
  const snap = await snapshot(canvas);
  if (!snap.body) throw new Error('canvas snapshot failed (context lost?)');
  const body = snap.body instanceof Blob ? await snap.body.arrayBuffer() : snap.body;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch('/save?path=' + encodeURIComponent(path) + snap.query, { method: 'POST', body });
      if (!res.ok) throw new Error('save failed: ' + (await res.text()));
      return body.byteLength;
    } catch (e) {
      if (i >= 4) throw new Error(`upload of ${path} (${body.byteLength} B) failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
};

// capture the frame the engine's own loop just rendered (its rAF callback runs before ours)
H.captureLive = async (path) => {
  await raf();
  const snap = await snapshot(canvas);
  const body = snap.body instanceof Blob ? await snap.body.arrayBuffer() : snap.body;
  const res = await fetch('/save?path=' + encodeURIComponent(path) + snap.query, { method: 'POST', body });
  if (!res.ok) throw new Error('save failed');
};

// free-running mode (engine's own RAF loop + adaptive controller): sample fps/quality for `sec` seconds
H.observe = async (sec) => {
  const samples = [];
  const t0 = performance.now();
  let last = t0, frames = 0;
  while (performance.now() - t0 < sec * 1000) {
    await raf();
    frames++;
    const tt = performance.now();
    samples.push({ t: now(), dt: tt - last, q: eng.qualityState ? eng.qualityState() : null });
    last = tt;
  }
  return samples;
};

H.dispose = () => { eng && eng.dispose(); canvas && canvas.remove(); eng = null; };
window.harnessReady = true;
H.hashScene = () => eng.hashScene();

// load profile: create the engine while a rAF loop records frame gaps, then render the first frame.
// Returns time to first frame (from navigation start), long tasks, and the largest rAF gap during loading.
H.loadProfile = async ({ engine, cssW, cssH, quality = 'high', extra = {} }) => {
  const mod = await import(engine);
  canvas = document.createElement('canvas');
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  document.body.appendChild(canvas);
  const gaps = [];
  let loading = true, last = performance.now();
  (function tickGap() { if (!loading) return; const t = performance.now(); gaps.push(t - last); last = t; requestAnimationFrame(tickGap); })();
  const tImport = performance.now();
  eng = await mod.create(canvas, { manual: true, fixedQuality: true, quality, bench: true, introDuration: 0, ...extra });
  const tCreated = performance.now();
  eng.heroView();
  const t0 = performance.now();
  eng.tick(1, 1 / 60);
  const firstFrameMs = performance.now() - t0;
  await raf();
  loading = false;
  const ttff = performance.now();
  await new Promise((r) => setTimeout(r, 100));
  window.__ltFlush();
  const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith('sr:')).map((m) => [m.name.slice(3), m.startTime]));
  return { tImport, tCreated, t0, firstFrameMs, ttff, marks, longtasks: window.__longtasks.slice(), maxGap: Math.max(...gaps.slice(1)), gaps: gaps.length, gen: eng.info().gen };
};
H.tickRaw = (dt = 1 / 60) => eng.tick(1, dt);
H.programs = () => eng.bench.programs();
