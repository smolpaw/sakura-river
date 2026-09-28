// Bench-only instrumentation for WebGPURenderer (both backends): per-pass GPU time, per-frame counters,
// render-target memory and a bandwidth estimate. Enabled with create(canvas, { bench: true }).
//
// WebGPU: native timestamp queries per render pass (renderer.trackTimestamp), read back per frame.
// WebGL2 fallback: three only times the outermost render, so this probe cuts the frame into sequential
// EXT_disjoint_timer_query segments at every render begin/finish instead (nested passes get their own time).
import { InspectorBase, TimestampQuery } from 'three/webgpu';

const bytesPerTexel = (t) => {
  if (!t) return 4;
  const comp = t.format === 1028 /* Red */ ? 1 : t.format === 1030 /* RG */ ? 2 : 4;
  const size = t.type === 1016 /* HalfFloat */ ? 2 : t.type === 1015 /* Float */ ? 4 : 1;
  return comp * size;
};
function rtInfo(rt, canvas) {
  if (!rt) return { key: 'canvas', px: canvas.width * canvas.height, bytes: canvas.width * canvas.height * 4, samples: 1, color: 4, depth: 0 };
  const s = Math.max(1, rt.samples || 0);
  const texs = rt.textures || [rt.texture];
  const color = texs.reduce((a, t) => a + bytesPerTexel(t), 0);
  const depth = rt.depthBuffer ? 4 : 0;
  const px = rt.width * rt.height;
  return { key: rt, px, bytes: px * (color + depth) * s + (s > 1 ? px * color : 0), samples: s, color, depth };
}

function label(scene, camera) {
  const n = scene.name || '';
  if (n.startsWith('Shadow Map')) return 'shadow';
  if (n.endsWith('[ Reflector ]')) return 'reflection';
  if (n.startsWith('Bloom')) return 'bloom';
  const rtt = n.match(/^(\w+) \[ RTT \]$/); // named post passes
  if (rtt) return rtt[1].toLowerCase();
  if (n === 'Render Pipeline') return 'grade';
  if (n) return n;
  return scene.isQuadMesh ? 'quad' : 'scene';
}

export function createGPUProbe(renderer) {
  const backend = renderer.backend;
  const webgpu = backend.isWebGPUBackend === true;
  const canvas = renderer.domElement;
  let frame = 0, inFrame = false;
  const byUid = new Map(); // uid -> { frame, label }
  const frames = new Map(); // frame -> { gpu: {label: ms}, total, open }
  const rts = new Map();
  let passes = [], drawStart = 0, triStart = 0, lastCounters = null;

  // ---- WebGL2 fallback: sequential segments ----
  const gl = webgpu ? null : backend.gl;
  const ext = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  let current = null;
  const stack = [], pending = [];
  let disjointFrames = 0;
  const beginSeg = (lbl) => {
    if (!ext) return;
    const q = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    current = { lbl, q };
    pending.push({ frame, lbl, q });
    const f = frames.get(frame) || { gpu: {}, total: 0, open: 0, closed: false };
    f.open++; frames.set(frame, f);
  };
  const endSeg = () => { if (current) gl.endQuery(ext.TIME_ELAPSED_EXT); current = null; };

  class Probe extends InspectorBase {
    beginRender(uid, scene, camera, renderTarget) {
      if (!inFrame) return;
      const lbl = label(scene, camera);
      const info = rtInfo(renderTarget, canvas);
      if (info.key !== 'canvas') rts.set(info.key, info);
      passes.push(info);
      if (webgpu) byUid.set(uid, { frame, lbl });
      else if (ext) { stack.push(current ? current.lbl : 'other'); endSeg(); beginSeg(lbl); }
    }
    finishRender() {
      if (!inFrame || webgpu || !ext) return;
      endSeg(); beginSeg(stack.pop() || 'other');
    }
    beginCompute(uid) {
      if (!inFrame) return;
      if (webgpu) byUid.set(uid, { frame, lbl: 'compute' });
      else if (ext) { stack.push(current ? current.lbl : 'other'); endSeg(); beginSeg('compute'); }
    }
    finishCompute() {
      if (!inFrame || webgpu || !ext) return;
      endSeg(); beginSeg(stack.pop() || 'other');
    }
  }
  renderer.inspector = new Probe();

  // WebGPU: getCurrentTexture() blocks while the swapchain is full (GPU backpressure). That wait is not
  // main-thread work, so it is timed separately and the harness subtracts it from the frame's CPU time.
  let blocked = 0, lastBlocked = 0;
  const ctx = webgpu ? backend.context : null;
  if (ctx) {
    const orig = ctx.getCurrentTexture.bind(ctx);
    ctx.getCurrentTexture = () => { const t0 = performance.now(); const t = orig(); blocked += performance.now() - t0; return t; };
  }

  // Pass timestamps miss work between passes (texture copies), which the WebGL probe's
  // contiguous segments include. So a frame's GPU time is its span, from its first pass's begin to its last pass's
  // end: with the GPU the bottleneck (queue always full, bench unthrottled) nothing idles inside it. Like the WebGL
  // segments it leaves out the browser compositor's work between frames; the period (first begin to the next
  // frame's) includes that and is reported too. three's pool keeps only durations, so its resolve is replaced by a
  // copy (r186) that keeps begin and end.
  const spans = new Map(); // uid -> [begin, end] (BigInt ns)
  function patchPool(pool) {
    if (!pool || pool.probePatched) return;
    pool.probePatched = true;
    pool._resolveQueries = async function () {
      if (this.isDisposed || this.resultBuffer.mapState !== 'unmapped') return this.lastValue;
      const offsets = new Map(this.queryOffsets), count = this.currentQueryIndex, bytes = count * 8;
      this.currentQueryIndex = 0; this.queryOffsets.clear();
      const enc = this.device.createCommandEncoder();
      enc.resolveQuerySet(this.querySet, 0, count, this.resolveBuffer, 0);
      enc.copyBufferToBuffer(this.resolveBuffer, 0, this.resultBuffer, 0, bytes);
      this.device.queue.submit([enc.finish()]);
      await this.resultBuffer.mapAsync(GPUMapMode.READ, 0, bytes);
      if (this.isDisposed) { if (this.resultBuffer.mapState === 'mapped') this.resultBuffer.unmap(); return this.lastValue; }
      const t = new BigUint64Array(this.resultBuffer.getMappedRange(0, bytes));
      this.timestamps.clear();
      for (const [uid, o] of offsets) { this.timestamps.set(uid, Number(t[o + 1] - t[o]) / 1e6); spans.set(uid, [t[o], t[o + 1]]); }
      this.resultBuffer.unmap();
      return this.lastValue;
    };
  }
  let resolving = false, prev = null;
  const done = [];
  async function resolveWebGPU() {
    if (resolving || !backend.trackTimestamp) return;
    resolving = true;
    const upTo = frame; // every query of frames rendered so far is in this resolve (it runs between frames)
    try {
      for (const type of [TimestampQuery.RENDER, TimestampQuery.COMPUTE]) {
        patchPool(backend.timestampQueryPool[type]);
        await renderer.resolveTimestampsAsync(type);
        for (const [uid, r] of byUid) {
          if (!backend.hasTimestampQuery(uid)) continue;
          const ms = backend.getTimestamp(uid);
          const f = frames.get(r.frame) || { gpu: {}, total: 0 };
          f.gpu[r.lbl] = (f.gpu[r.lbl] || 0) + ms;
          f.total += ms;
          const sp = spans.get(uid);
          if (sp) { if (f.begin === undefined || sp[0] < f.begin) f.begin = sp[0]; if (f.end === undefined || sp[1] > f.end) f.end = sp[1]; spans.delete(uid); }
          f.seen = true;
          frames.set(r.frame, f);
          byUid.delete(uid);
        }
      }
      // uids of those frames still without a timestamp never had a query (e.g. passes three does not time): drop
      // them now rather than holding their frame back
      for (const [uid, r] of byUid) if (r.frame <= upTo) byUid.delete(uid);
      // a frame is complete once none of its uids are outstanding: total = span, passes = sum of pass times, and
      // period = begin minus the previous frame's begin when that frame was measured too; without begins
      // (unpatched pool) total = passes
      const open = new Set([...byUid.values()].map((r) => r.frame));
      for (const fr of [...frames.keys()].sort((a, b) => a - b)) {
        const f = frames.get(fr);
        if (!(fr < frame && !open.has(fr) && f.seen)) continue;
        const rec = { frame: fr, gpu: f.gpu, total: f.begin !== undefined ? Number(f.end - f.begin) / 1e6 : f.total, passes: f.total };
        if (prev && prev.frame === fr - 1 && prev.begin !== undefined && f.begin !== undefined) rec.period = Number(f.begin - prev.begin) / 1e6;
        done.push(rec);
        prev = { frame: fr, begin: f.begin };
        frames.delete(fr);
      }
    } finally { resolving = false; }
  }

  return {
    hasTimer: webgpu ? backend.trackTimestamp === true : !!ext,
    backend: webgpu ? 'webgpu' : 'webgl',
    beginFrame() {
      frame++; inFrame = true; passes = []; blocked = 0;
      drawStart = renderer.info.render.drawCalls; triStart = renderer.info.render.triangles;
      if (!webgpu && ext) { stack.length = 0; beginSeg('other'); }
    },
    endFrame() {
      if (!webgpu && ext) { endSeg(); const f = frames.get(frame); if (f) f.closed = true; }
      inFrame = false; lastBlocked = blocked;
      lastCounters = { drawCalls: renderer.info.render.drawCalls - drawStart, triangles: renderer.info.render.triangles - triStart, passes: passes.slice() };
    },
    poll() {
      if (webgpu) { resolveWebGPU(); return done.splice(0); }
      if (!ext) return [];
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        for (const p of pending) gl.deleteQuery(p.q);
        for (const fr of new Set(pending.map((p) => p.frame))) frames.delete(fr);
        pending.length = 0; disjointFrames++;
        return [];
      }
      const out = [];
      while (pending.length) {
        const p = pending[0];
        if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) break;
        const ns = gl.getQueryParameter(p.q, gl.QUERY_RESULT);
        gl.deleteQuery(p.q); pending.shift();
        const f = frames.get(p.frame);
        if (!f) continue;
        f.gpu[p.lbl] = (f.gpu[p.lbl] || 0) + ns / 1e6; f.total += ns / 1e6;
        if (--f.open === 0 && f.closed) { frames.delete(p.frame); out.push({ frame: p.frame, gpu: f.gpu, total: f.total }); }
      }
      return out;
    },
    get pending() { return webgpu ? byUid.size : pending.length; },
    get disjointFrames() { return disjointFrames; },
    get frame() { return frame; },
    get blockedMs() { return lastBlocked; },
    // resolves when the GPU has finished all submitted work (bench CPU timing without backpressure)
    waitIdle() { return webgpu ? backend.device.queue.onSubmittedWorkDone() : null; },
    counters() {
      const c = lastCounters || { drawCalls: 0, triangles: 0, passes: [] };
      let rtMem = canvas.width * canvas.height * 4;
      for (const r of rts.values()) rtMem += r.bytes;
      const bw = c.passes.reduce((a, p) => a + p.px * (p.color + p.depth) * p.samples, 0);
      return {
        drawCalls: c.drawCalls, triangles: c.triangles, passes: c.passes.length,
        programs: renderer._pipelines ? renderer._pipelines.caches.size : null,
        rtMemMB: rtMem / 1048576, bandwidthMB: bw / 1048576,
        renderTargets: [...rts.values()].map((r) => ({ px: r.px, samples: r.samples, bpp: r.color, bytes: r.bytes })),
      };
    },
  };
}
