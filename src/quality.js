// Adaptive quality driven by GPU time. The main knob is the render scale (the canvas resolution; the browser
// stretches it to the screen); second-order settings step in only at the scale floor and step out first.
//
// Model: gpuMs ~= fixed + perPixel * scale^2. Each decision solves for the scale that meets the target from
// smoothed measurements, moves at most one step, and waits for fresh samples before the next decision, so the
// loop settles in a few seconds and a dead band keeps it from oscillating.
export class QualityController {
  constructor({
    targetMs = 14, minScale = 0.5, maxScale = 1, step = 0.05, window = 12, deadband = 0.1,
    panicFactor = 1.6, panicFrames = 6, levels = [], onChange = () => {},
  } = {}) {
    Object.assign(this, { targetMs, minScale, maxScale, step, window, deadband, panicFactor, panicFrames, levels, onChange });
    this.scale = maxScale;
    this.level = 0; // number of second-order reductions applied
    this.samples = [];
    this.over = 0;
    this.cooldown = 0;
    this.lastMs = 0;
    this.frame = 0; // id of the last rendered frame (set by the caller)
    this.changedFrame = -1;
  }

  quantize(s) { return +Math.min(this.maxScale, Math.max(this.minScale, Math.round(s / this.step) * this.step)).toFixed(3); }

  // feed one frame's GPU time (ms) and the id of the frame it measured; returns true when a setting changed.
  // GPU timings arrive frames late, so samples of frames rendered before the last change are ignored (acting on
  // them makes the loop overshoot and oscillate). The caller sets `frame` to the id of the last frame rendered.
  update(ms, frame = Infinity) {
    if (!(ms > 0) || !Number.isFinite(ms) || frame <= this.changedFrame) return false;
    this.lastMs = ms;
    // panic: several frames far over budget -> drop immediately
    this.over = ms > this.targetMs * this.panicFactor ? this.over + 1 : 0;
    if (this.over >= this.panicFrames && (this.scale > this.minScale || this.level < this.levels.length)) {
      this.over = 0; this.samples = []; this.cooldown = this.window;
      if (this.scale > this.minScale) this.setScale(this.quantize(this.scale * 0.75), true);
      else this.setLevel(this.level + 1, true);
      return true;
    }
    this.samples.push(ms);
    if (this.cooldown > 0) { this.cooldown--; return false; }
    if (this.samples.length < this.window) return false;
    // trimmed mean: robust to hitches, and unbiased when frames alternate (shadows and reflection update every
    // other frame; a median of alternating samples picks one of the two modes)
    const sorted = this.samples.slice().sort((a, b) => a - b);
    const kept = sorted.slice(2, sorted.length - 2);
    const est = kept.reduce((a, b) => a + b, 0) / kept.length;
    this.samples = [];
    const ratio = est / this.targetMs;
    if (Math.abs(ratio - 1) < this.deadband) return false;
    if (ratio > 1) {
      // over budget: lower the scale first, then second-order settings
      if (this.scale > this.minScale) return this.setScale(this.quantize(this.solve(est)));
      if (this.level < this.levels.length) return this.setLevel(this.level + 1);
    } else {
      // headroom: restore second-order settings first, then the scale
      if (this.level > 0 && ratio < 1 - 2 * this.deadband) return this.setLevel(this.level - 1);
      if (this.level === 0 && this.scale < this.maxScale) {
        // step up only if the model predicts the new scale stays clearly under target (no neighbour flip-flop)
        const s = this.quantize(this.solve(est));
        if (s > this.scale && this.predict(est, s) <= this.targetMs * (1 - this.deadband / 2)) return this.setScale(s);
      }
    }
    return false;
  }

  // frame time at scale s from a measurement at the current scale, ~70% of it scaling with pixel count
  predict(est, s) { return 0.3 * est + 0.7 * est * (s / this.scale) ** 2; }

  // scale that meets the target, assuming ~70% of the frame scales with pixel count; at most one step per decision
  solve(est) {
    const s = this.scale, fixed = 0.3 * est, variable = 0.7 * est;
    const want = Math.sqrt(Math.max(0.01, (this.targetMs - fixed) / Math.max(1e-3, variable))) * s;
    const lo = s - this.step * 2, hi = s + this.step;
    return Math.min(hi, Math.max(lo, want));
  }

  setScale(s, panic = false) {
    if (s === this.scale) return false;
    this.scale = s; this.cooldown = this.window; this.changedFrame = this.frame; this.samples = [];
    this.onChange({ scale: s, level: this.level, panic });
    return true;
  }

  setLevel(l, panic = false) {
    l = Math.max(0, Math.min(this.levels.length, l));
    if (l === this.level) return false;
    if (l > this.level) this.levels[this.level].apply(); else this.levels[l].revert();
    this.level = l; this.cooldown = this.window; this.changedFrame = this.frame; this.samples = [];
    this.onChange({ scale: this.scale, level: l, panic });
    return true;
  }
}
