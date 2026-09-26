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

// render n frames; returns per-frame { cpu, t, pf } plus GPU samples keyed by probe frame
H.frames = async (n, dt = 1 / 60) => {
  const cpu = new Float64Array(n), t = new Float64Array(n), pf = new Int32Array(n);
  const gpu = [];
  for (let i = 0; i < n; i++) {
    await raf();
    const t0 = performance.now();
    eng.tick(1, dt);
    cpu[i] = performance.now() - t0;
    t[i] = now();
    pf[i] = eng.bench ? eng.bench.frame : i;
    if (eng.bench) gpu.push(...eng.bench.poll());
  }
  return { cpu: [...cpu], t: [...t], pf: [...pf], gpu };
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
H.quality = () => (eng.qualityState ? eng.qualityState() : null);
H.setAdaptive = (on) => eng.setAdaptive(on);
H.setBallast = (ms) => eng.setBallast && eng.setBallast(ms);

// render one frame and upload the canvas as PNG to bench/<path>
H.capture = async (path, dt = 0) => {
  await raf();
  eng.tick(1, dt);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png')); // snapshot is taken synchronously
  if (!blob) throw new Error('toBlob returned null (context lost?)');
  const body = await blob.arrayBuffer();
  for (let i = 0; ; i++) {
    try {
      const res = await fetch('/save?path=' + encodeURIComponent(path), { method: 'POST', body });
      if (!res.ok) throw new Error('save failed: ' + (await res.text()));
      return blob.size;
    } catch (e) {
      if (i >= 4) throw new Error(`upload of ${path} (${body.byteLength} B) failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
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
