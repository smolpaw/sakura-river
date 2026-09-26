// Bench-only instrumentation for WebGLRenderer: sequential GPU timer segments, per-frame counters,
// render-target memory and a rough bandwidth estimate. Enabled with create(canvas, { bench: true }).
//
// GPU time: EXT_disjoint_timer_query_webgl2 queries cannot nest, so the frame is cut into consecutive
// labelled segments (push/pop switch the running query). Every GL command belongs to exactly one segment,
// and the segments of a frame sum to its total GPU time.

function rtBytes(rt) {
  const t = rt.texture || (rt.textures && rt.textures[0]);
  const w = rt.width, h = rt.height, s = Math.max(1, rt.samples || 0);
  const bpp = t ? (t.type === 1016 ? 8 : t.type === 1015 ? 16 : 4) : 4;
  let color = w * h * bpp * s + (s > 1 ? w * h * bpp : 0); // MSAA renderbuffer + resolve texture
  let depth = rt.depthBuffer ? w * h * 4 * s + (rt.depthTexture && s > 1 ? w * h * 4 : 0) : 0;
  return { color, depth, total: color + depth, px: w * h, bpp, samples: s };
}

export function createBenchProbe(renderer) {
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const info = renderer.info;
  info.autoReset = false;

  let frame = 0;
  let current = null; // { label, q }
  const stack = [];
  const pending = []; // { frame, label, q }
  const byFrame = new Map(); // frame -> { frame, gpu, total, open, closed }
  let disjointFrames = 0;

  function begin(label) {
    if (!ext) { current = { label }; return; }
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    current = { label, q };
    pending.push({ frame, label, q });
    let f = byFrame.get(frame);
    if (!f) { f = { frame, gpu: {}, total: 0, open: 0, closed: false }; byFrame.set(frame, f); }
    f.open++;
  }
  function end() {
    if (current && current.q) gl.endQuery(ext.TIME_ELAPSED_EXT);
    current = null;
  }
  function push(label) { stack.push(current ? current.label : 'other'); end(); begin(label); }
  function pop() { end(); begin(stack.pop() || 'other'); }

  // per-frame render-target / pass accounting
  const rts = new Set();
  let passes = [];
  let lastCalls = 0, curPass = null;
  function closePass() {
    if (curPass) { curPass.calls = info.render.calls - lastCalls; if (curPass.calls > 0) passes.push(curPass); }
  }
  const origSetRT = renderer.setRenderTarget.bind(renderer);
  renderer.setRenderTarget = function (rt, ...rest) {
    closePass();
    lastCalls = info.render.calls;
    curPass = { rt };
    if (rt) rts.add(rt);
    return origSetRT(rt, ...rest);
  };
  const origShadow = renderer.shadowMap.render.bind(renderer.shadowMap);
  renderer.shadowMap.render = function (...a) {
    push('shadow');
    const r = origShadow(...a);
    pop();
    return r;
  };

  function wrapPass(pass, label) {
    const orig = pass.render.bind(pass);
    pass.render = function (...a) { push(label); const r = orig(...a); pop(); return r; };
  }

  function canvasBytes() {
    const c = gl.canvas;
    return c.width * c.height * 4;
  }

  return {
    hasTimer: !!ext,
    wrapPass,
    push, pop,
    beginFrame() {
      frame++;
      info.reset();
      passes = []; curPass = { rt: renderer.getRenderTarget() }; lastCalls = 0;
      begin('other');
    },
    endFrame() {
      end();
      const f = byFrame.get(frame); if (f) f.closed = true;
      closePass(); curPass = null;
    },
    // collect finished GPU samples; returns [{ frame, gpu: {label: ms}, total }]
    poll() {
      if (!ext) return [];
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (disjoint) {
        // every query in flight is unreliable
        for (const p of pending) gl.deleteQuery(p.q);
        for (const f of new Set(pending.map((p) => p.frame))) byFrame.delete(f);
        pending.length = 0;
        disjointFrames++;
        return [];
      }
      const out = [];
      while (pending.length) {
        const p = pending[0];
        if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
        const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
        gl.deleteQuery(p.q);
        pending.shift();
        const f = byFrame.get(p.frame);
        if (!f) continue;
        f.gpu[p.label] = (f.gpu[p.label] || 0) + ns / 1e6;
        f.total += ns / 1e6;
        if (--f.open === 0 && f.closed) { byFrame.delete(p.frame); out.push({ frame: f.frame, gpu: f.gpu, total: f.total }); }
      }
      return out;
    },
    get disjointFrames() { return disjointFrames; },
    get frame() { return frame; },
    get pending() { return pending.length; },
    // deterministic counters for the frame just rendered
    counters() {
      let rtMem = 0, bw = 0;
      const list = [];
      for (const rt of rts) { const b = rtBytes(rt); rtMem += b.total; list.push({ w: rt.width, h: rt.height, samples: b.samples, bpp: b.bpp, bytes: b.total }); }
      for (const p of passes) {
        if (p.rt) { const b = rtBytes(p.rt); bw += b.px * (b.bpp + (p.rt.depthBuffer ? 4 : 0)) * b.samples; }
        else bw += canvasBytes();
      }
      return {
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        points: info.render.points,
        passes: passes.length,
        programs: info.programs ? info.programs.length : 0,
        rtMemMB: (rtMem + canvasBytes()) / 1048576,
        bandwidthMB: bw / 1048576,
        renderTargets: list,
      };
    },
  };
}
