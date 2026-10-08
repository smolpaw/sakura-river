// Adaptive quality driven by GPU time. The main knob is the render scale (the scene pass's resolution, upscaled to
// the screen); second-order settings step in only at the scale floor and step out first.
//
// Frame rate: in mode 'auto' with `autoHalf` (GPU timings available), the frame rate goes before the detail (owner,
// 2026-10-08): over budget at the full rate (60 fps), the controller halves it (30 fps, `half`: the budget per frame
// doubles) at the scale that fits the doubled budget, and only then goes on down to minScale and the second-order
// settings. `halfAt` below 1 would first lower the scale that far at 60 fps. Back to the full rate only from
// half rate at maxScale with every setting restored: at once when a frame fits the full rate's budget with the dead
// band to spare, else on trial. A GPU with time to spare at 30 fps lowers its clocks (the RTX 2060 here: 1935 -> ~1080
// MHz, a frame's GPU time 1.4-1.75x), so a frame that would fit at 60 can read as not fitting at 30; with clear
// headroom, every `retryFrames` frames (doubling after each failed trial) it goes back to the full rate at the same
// scale, measures after a longer cooldown (the clocks take ~1 s to rise), and returns to half rate at once if over
// budget. Mode 60 or 30 holds that rate (the visitor's choice).
//
// Model: gpuMs ~= fixed + perPixel * scale^2. Each decision solves for the scale that meets the target from
// smoothed measurements, moves at most one step, and waits for fresh samples before the next decision, so the
// loop settles in a few seconds and a dead band keeps it from oscillating.
export class QualityController {
  constructor({
    targetMs = 14, minScale = 0.5, maxScale = 1, step = 0.05, window = 12, deadband = 0.1,
    panicFactor = 1.6, panicFrames = 6, levels = [], onChange = () => {},
    mode = 'auto', autoHalf = false, halfAt = 1, retryFrames = 720,
  } = {}) {
    Object.assign(this, { targetMs, minScale, maxScale, step, window, deadband, panicFactor, panicFrames, levels, onChange, mode, autoHalf, halfAt, retryFrames });
    this.trial = false; // back at the full rate on trial (from half rate)
    this.retryIn = retryFrames; this.nextTrial = 0; // frames to the next trial, and the frame id it is due at
    this.scale = maxScale;
    this.level = 0; // number of second-order reductions applied
    this.half = mode === 30; // at half the frame rate (the budget per frame doubled)
    this.samples = [];
    this.over = 0;
    this.cooldown = 0;
    this.lastMs = 0;
    this.frame = 0; // id of the last rendered frame (set by the caller)
    this.changedFrame = -1;
  }

  quantize(s) { return +Math.min(this.maxScale, Math.max(this.minScale, Math.round(s / this.step) * this.step)).toFixed(3); }

  // GPU time a frame may take at the current frame rate
  budget() { return this.half ? 2 * this.targetMs : this.targetMs; }
  // whether the controller may halve the frame rate itself
  rung() { return this.mode === 'auto' && this.autoHalf; }
  // the lowest scale at the current frame rate
  floorScale() { return this.rung() && !this.half ? Math.max(this.halfAt, this.minScale) : this.minScale; }
  canLower() { return this.scale > this.floorScale() || (this.rung() && !this.half) || this.level < this.levels.length; }

  // one step down: the scale (to `want`, not below the floor), else the frame rate, else a second-order setting
  lower(want, est, panic = false) {
    if (this.trial && !this.half) { // a failed trial: half rate again at the same scale, the next trial twice as far off
      this.trial = false; this.retryIn = Math.min(this.retryIn * 2, this.retryFrames * 16); this.nextTrial = this.frame + this.retryIn;
      return this.setHalf(true, panic);
    }
    const floor = this.floorScale();
    if (this.scale > floor) return this.setScale(Math.max(floor, this.quantize(want)), panic);
    if (this.rung() && !this.half) { this.nextTrial = this.frame + this.retryIn; return this.setHalf(true, panic, this.halfScale(est)); }
    if (this.level < this.levels.length) return this.setLevel(this.level + 1, panic);
    return false;
  }

  // the scale that fits the doubled budget, from a frame of `est` ms at the current scale (rounded down a step)
  halfScale(est) {
    const T = 2 * this.targetMs * (1 - this.deadband / 2);
    const want = this.scale * Math.sqrt(Math.max(0.01, (T - 0.3 * est) / Math.max(1e-3, 0.7 * est)));
    const s = Math.floor(want / this.step + 1e-6) * this.step;
    return +Math.min(this.maxScale, Math.max(this.minScale, s)).toFixed(3);
  }

  // 'auto', 60 or 30; a fixed rate takes effect at once, at the current scale
  setMode(mode) {
    this.mode = mode; this.trial = false;
    if (mode === 30) return this.setHalf(true);
    if (mode === 60 || !this.rung()) return this.setHalf(false); // (auto without the rung is 60 fps)
    return false;
  }

  // feed one frame's GPU time (ms) and the id of the frame it measured; returns true when a setting changed.
  // GPU timings arrive frames late, so samples of frames rendered before the last change are ignored (acting on
  // them makes the loop overshoot and oscillate). The caller sets `frame` to the id of the last frame rendered.
  update(ms, frame = Infinity) {
    if (!(ms > 0) || !Number.isFinite(ms) || frame <= this.changedFrame) return false;
    this.lastMs = ms;
    const T = this.budget();
    // panic: several frames far over budget -> drop immediately
    this.over = ms > T * this.panicFactor ? this.over + 1 : 0;
    if (this.over >= this.panicFrames && this.canLower()) {
      this.over = 0; this.samples = []; this.cooldown = this.window;
      this.lower(this.scale * 0.75, ms, true);
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
    const ratio = est / T;
    if (this.trial && ratio <= 1) { this.trial = false; this.retryIn = this.retryFrames; } // the full rate holds
    if (Math.abs(ratio - 1) < this.deadband) return false;
    if (ratio > 1) {
      // over budget: lower the scale first, then the frame rate (auto), then second-order settings
      return this.lower(this.solve(est), est);
    } else {
      // headroom: restore second-order settings first, then the scale, then the full frame rate (auto)
      if (this.level > 0 && ratio < 1 - 2 * this.deadband) return this.setLevel(this.level - 1);
      if (this.level === 0 && this.scale < this.maxScale) {
        // step up only if the model predicts the new scale stays clearly under target (no neighbour flip-flop)
        const s = this.quantize(this.solve(est));
        if (s > this.scale && this.predict(est, s) <= T * (1 - this.deadband / 2)) return this.setScale(s);
      }
      if (this.level === 0 && this.half && this.rung() && this.scale >= this.maxScale) {
        if (est <= this.targetMs * (1 - this.deadband)) return this.setHalf(false);
        if (ratio < 1 - 2 * this.deadband && this.frame >= this.nextTrial) {
          this.trial = true; this.setHalf(false); this.cooldown = 5 * this.window; // (measured once the clocks are up)
          return true;
        }
      }
    }
    return false;
  }

  // frame time at scale s from a measurement at the current scale, ~70% of it scaling with pixel count
  predict(est, s) { return 0.3 * est + 0.7 * est * (s / this.scale) ** 2; }

  // scale that meets the target, assuming ~70% of the frame scales with pixel count; at most one step per decision
  solve(est) {
    const s = this.scale, fixed = 0.3 * est, variable = 0.7 * est;
    const want = Math.sqrt(Math.max(0.01, (this.budget() - fixed) / Math.max(1e-3, variable))) * s;
    const lo = s - this.step * 2, hi = s + this.step;
    return Math.min(hi, Math.max(lo, want));
  }

  setScale(s, panic = false) {
    if (s === this.scale) return false;
    this.scale = s; this.cooldown = this.window; this.changedFrame = this.frame; this.samples = [];
    this.onChange({ scale: s, level: this.level, half: this.half, panic });
    return true;
  }

  setHalf(on, panic = false, scale = this.scale) {
    if (on === this.half) return false;
    this.half = on; this.scale = scale; this.cooldown = this.window; this.changedFrame = this.frame; this.samples = []; this.over = 0;
    this.onChange({ scale, level: this.level, half: on, panic });
    return true;
  }

  setLevel(l, panic = false) {
    l = Math.max(0, Math.min(this.levels.length, l));
    if (l === this.level) return false;
    if (l > this.level) this.levels[this.level].apply(); else this.levels[l].revert();
    this.level = l; this.cooldown = this.window; this.changedFrame = this.frame; this.samples = [];
    this.onChange({ scale: this.scale, level: l, half: this.half, panic });
    return true;
  }
}
