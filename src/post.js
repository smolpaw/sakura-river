// Post: screen-space volumetric light shafts (sky-masked radial scattering), bloom, output transform and the
// final grade, as one RenderPipeline graph. Per-pixel steps are fused; only neighbourhood reads get a pass.
import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uniform, uv, rtt, mix, max, min, dot, sqrt, clamp, length, exp, fract, select, Loop, renderOutput, toneMappingExposure,
  pass, floor, abs, sin,
} from 'three/tsl';
import FSR1Node from 'three/addons/tsl/display/FSR1Node.js';
import { hashSin, sstep } from './tsl.js';

const luma = (c) => dot(c, vec3(0.2126, 0.7152, 0.0722));

// r170's ACESFilmicToneMapping. r186's TSL RRTAndODTFit computes v * ((v + 0.432951) * 0.983729) where the GLSL
// had v * (0.983729 * v + 0.432951), which brightens everything slightly. GLSL column-major matrices written out.
const aces170 = Fn(([color, exposure]) => {
  const v = color.mul(exposure).div(0.6);
  const i = vec3(0.59719, 0.07600, 0.02840).mul(v.x).add(vec3(0.35458, 0.90834, 0.13383).mul(v.y)).add(vec3(0.04823, 0.01566, 0.83777).mul(v.z)).toVar();
  const r = i.mul(i.add(0.0245786)).sub(0.000090537).div(i.mul(i.mul(0.983729).add(0.4329510)).add(0.238081)).toVar();
  const o = vec3(1.60475, -0.10208, -0.00327).mul(r.x).add(vec3(-0.53108, 1.10813, -0.07276).mul(r.y)).add(vec3(-0.07367, -0.00605, 1.07602).mul(r.z));
  return clamp(o, 0.0, 1.0);
});

// r170's UnrealBloomPass, reproduced exactly: luminosity high pass at half size, 5 mips of separable Gaussian
// blur (kernel radius 3..11, sigma = radius), composite. Its final copy was blended additively with SRC_ALPHA
// while the composite alpha was strength * sum(mip factors), so the added light is rgb * that alpha.
export function unrealBloom(input, { threshold = 2.2, radius = 0.55, strength = 0.4 } = {}) {
  const u = { strength: uniform(strength), radius: uniform(radius), threshold: uniform(threshold) };
  const size = (w, h) => { const out = []; let x = Math.round(w / 2), y = Math.round(h / 2); for (let i = 0; i < 6; i++) { out.push([Math.max(1, x), Math.max(1, y)]); x = Math.round(x / 2); y = Math.round(y / 2); } return out; };
  const highPass = Fn(() => {
    const t = input; // an expression over the scene texture, evaluated at this pass's uv
    const a = sstep(u.threshold, u.threshold.add(0.01), luma(t.rgb));
    return mix(vec4(0.0), t, a);
  })();
  const bright = rtt(highPass, 1, 1);
  bright.name = 'Bloom';
  const kernels = [3, 5, 7, 9, 11];
  const inv = kernels.map(() => uniform(new THREE.Vector2(1, 1)));
  const blur = (src, k, invSize, dir) => Fn(() => {
    const coef = [];
    for (let i = 0; i < k; i++) coef.push(0.39894 * Math.exp((-0.5 * i * i) / (k * k)) / k);
    const sum = src.sample(uv()).rgb.mul(coef[0]).toVar();
    let wsum = coef[0];
    for (let i = 1; i < k; i++) {
      const off = invSize.mul(vec2(dir[0], dir[1])).mul(i);
      sum.addAssign(src.sample(uv().add(off)).rgb.add(src.sample(uv().sub(off)).rgb).mul(coef[i]));
      wsum += 2 * coef[i];
    }
    return vec4(sum.div(wsum), 1.0);
  })();
  const targets = [];
  const mips = [];
  let src = bright;
  kernels.forEach((k, i) => {
    const h = rtt(blur(src, k, inv[i], [1, 0]), 1, 1);
    const v = rtt(blur(h, k, inv[i], [0, 1]), 1, 1);
    h.name = v.name = 'Bloom';
    targets.push(h, v); mips.push(v); src = v;
  });
  const factors = [1.0, 0.8, 0.6, 0.4, 0.2];
  const lerpF = (f) => mix(float(f), float(1.2 - f), u.radius);
  const node = Fn(() => {
    const sum = vec4(0.0).toVar();
    mips.forEach((m, i) => sum.addAssign(m.sample(uv()).mul(lerpF(factors[i]))));
    const c = sum.mul(u.strength);
    return c.rgb.mul(c.a);
  })();
  return {
    node, uniforms: u,
    setSize(w, h) {
      const s = size(w, h);
      const fix = (n, [w, h]) => { n.width = w; n.height = h; n.setSize(w, h); };
      fix(bright, s[0]);
      kernels.forEach((k, i) => { fix(targets[2 * i], s[i]); fix(targets[2 * i + 1], s[i]); inv[i].value.set(1 / s[i][0], 1 / s[i][1]); });
    },
  };
}

// light shafts: returns { rays: texture node (half res), uniforms, setEnabled, setScale (the buffers' scale over the
// drawing buffer) }
export function lightShafts(color, samples, scale = 0.5) {
  const u = { sun: uniform(new THREE.Vector2(0.5, 0.5)), aspect: uniform(1), intensity: uniform(1), tint: uniform(new THREE.Color(1, 0.8, 0.6)) };
  const mask = Fn(() => {
    const c = color.sample(uv());
    const sky = select(c.a.lessThan(0.5), float(1.0), float(0.0)); // the sky writes alpha 0
    const dv = uv().sub(u.sun).mul(vec2(u.aspect, 1.0));
    const fall = exp(length(dv).mul(-9.0));
    return vec4(min(max(min(c.rgb, vec3(6.0)).sub(0.9), 0.0), vec3(1.2)).mul(sky).mul(fall), 1.0);
  })();
  const blur = (input, len, decay) => Fn(() => {
    const delta = uv().sub(u.sun).mul(len).div(samples).toVar();
    // dither hashed with the old bottom-up v, like the grain, so the pattern matches the baseline
    const p = uv().sub(delta.mul(hashSin(vec2(uv().x, float(1.0).sub(uv().y)).mul(1000.0)))).toVar();
    const acc = vec3(0.0).toVar(), w = float(1.0).toVar(), tw = float(0.0).toVar();
    Loop(samples, () => {
      acc.addAssign(input.sample(p).rgb.mul(w)); tw.addAssign(w); w.mulAssign(decay); p.subAssign(delta);
    });
    return vec4(acc.div(tw), 1.0);
  })();
  const opt = { resolutionScale: scale };
  const m = rtt(mask, null, null, opt);
  const b1 = rtt(blur(m, 0.85, 0.975), null, null, opt);
  const b2 = rtt(blur(b1, 0.35, 0.99), null, null, opt);
  const passes = [m, b1, b2];
  for (const p of passes) p.name = 'Shafts';
  return {
    rays: b2, uniforms: u,
    setEnabled(on) { for (const p of passes) p.autoUpdate = on; },
    setScale(sc) { for (const p of passes) p.setResolutionScale(sc); },
  };
}

export function grade(input) {
  const u = { res: uniform(new THREE.Vector2(1, 1)), time: uniform(0), vig: uniform(0.36), clarity: uniform(0.2), sharp: uniform(0.35) };
  const node = Fn(() => {
    const vUv = uv();
    const px = vec2(1.0).div(u.res);
    const c = input.sample(vUv).rgb.toVar();
    // contrast-adaptive sharpening (keeps texture detail crisp after MSAA / scaling)
    const n = input.sample(vUv.add(vec2(0.0, px.y))).rgb, so = input.sample(vUv.sub(vec2(0.0, px.y))).rgb;
    const e = input.sample(vUv.add(vec2(px.x, 0.0))).rgb, w = input.sample(vUv.sub(vec2(px.x, 0.0))).rgb;
    const mnR = min(c, min(min(n, so), min(e, w))), mxR = max(c, max(max(n, so), max(e, w)));
    const amp = sqrt(clamp(min(mnR, vec3(1.0).sub(mxR)).div(max(mxR, vec3(1e-4))), 0.0, 1.0));
    const wgt = amp.negate().mul(u.sharp).mul(0.2).toVar();
    c.assign(clamp(c.add(n.add(so).add(e).add(w).mul(wgt)).div(wgt.mul(4.0).add(1.0)), 0.0, 1.0));
    // HDR-style local contrast (two radii)
    const s = u.res.y.div(900.0);
    const b1 = float(0).toVar(), b2 = float(0).toVar();
    for (let i = 0; i < 8; i++) {
      const a = i * 0.785398 + 0.39;
      const d = vec2(Math.cos(a), Math.sin(a));
      b1.addAssign(luma(input.sample(vUv.add(d.mul(px).mul(7.0).mul(s))).rgb));
      b2.addAssign(luma(input.sample(vUv.add(d.mul(px).mul(26.0).mul(s))).rgb));
    }
    b1.divAssign(8.0); b2.divAssign(8.0);
    const l = luma(c).toVar();
    const detail = clamp(l.sub(b1).mul(1.0).add(l.sub(b2).mul(0.35)), -0.12, 0.12);
    c.mulAssign(float(1.0).add(u.clarity.mul(detail).div(l.add(0.22))));
    // gentle S-curve
    c.assign(mix(c, c.mul(c).mul(vec3(3.0).sub(c.mul(2.0))), 0.28));
    l.assign(luma(c));
    // vibrance: lift muted colours more than saturated ones
    const mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
    c.assign(mix(vec3(l), c, float(1.0).add(float(1.0).sub(mx.sub(mn)).mul(0.12))));
    // split tone: indigo shadows, warm apricot highlights
    c.assign(mix(c, c.mul(vec3(0.9, 0.95, 1.12)).add(vec3(0.005, 0.008, 0.028)), float(1.0).sub(sstep(0.0, 0.5, l))));
    c.assign(mix(c, c.mul(vec3(1.05, 0.99, 0.93)), sstep(0.55, 1.0, l)));
    // vignette
    const q = vUv.sub(0.5).toVar();
    q.x.mulAssign(u.res.x.div(u.res.y).mul(0.75));
    c.mulAssign(float(1.0).sub(u.vig.mul(sstep(0.28, 0.95, length(q)))));
    // washi-like grain
    // hashed with the old bottom-up v so the grain pattern matches the baseline's
    c.addAssign(hashSin(vec2(vUv.x, float(1.0).sub(vUv.y)).mul(u.res).add(fract(u.time).mul(100.0))).sub(0.5).mul(0.016));
    return vec4(clamp(c, 0.0, 1.0), 1.0);
  })();
  return { node, uniforms: u };
}

// Supersampling's resolve: `input` (the tone-mapped image, up to `maxRatio` times the drawing buffer each way) filtered
// down to the drawing buffer by a Lanczos-2 kernel over every input texel it reaches (36 taps at 1.5x). Compared on
// crops with a single bilinear tap (as the browser would scale a larger canvas), an area-weighted box and a tent:
// bilinear aliases (it reads 4 of the ~2.25 x 2.25 texels under a pixel), box and tent are softer. After tone mapping,
// so a bright highlight's edge does not spread into its neighbours.
export function downsample(input, maxRatio) {
  const u = { inRes: uniform(new THREE.Vector2(1, 1)), outRes: uniform(new THREE.Vector2(1, 1)) };
  const A = 2; // lobes
  const lanczos = (d) => {
    const x = max(abs(d), 1e-4), px = x.mul(Math.PI);
    return select(x.lessThan(A), sin(px).mul(sin(px.div(A))).mul(A).div(px.mul(px)), float(0.0));
  };
  const node = Fn(() => {
    const ratio = u.inRes.div(u.outRes);
    const p = uv().mul(u.inRes).sub(0.5).toVar(); // the output pixel's middle, in input texels
    const base = floor(p).toVar();
    const sum = vec3(0.0).toVar(), wsum = float(0.0).toVar();
    const R = Math.ceil(A * maxRatio); // the kernel's reach in input texels
    for (let j = 1 - R; j <= R; j++) {
      for (let i = 1 - R; i <= R; i++) {
        const t = base.add(vec2(i, j));
        const d = t.sub(p).div(ratio); // in output pixels
        const w = lanczos(d.x).mul(lanczos(d.y));
        sum.addAssign(input.sample(t.add(0.5).div(u.inRes)).rgb.mul(w));
        wsum.addAssign(w);
      }
    }
    return vec4(clamp(sum.div(wsum), 0.0, 1.0), 1.0);
  })();
  return { node, uniforms: u };
}

// The adaptive render scale's resolve: the tone-mapped image, rendered at the scale, upscaled to the drawing buffer by
// FSR 1 (three's FSR1Node: EASU, an edge-adaptive 12-tap Lanczos, then RCAS sharpening) in place of the browser
// stretching a smaller canvas bilinearly (docs/performance.md, Adaptive quality). Spatial, so swaying foliage keeps its
// edges and MSAA stays (temporal upscalers blurred them: Tried and rejected). Off at scale 1: its passes are skipped
// and its output texture is the tone-mapped image itself, so the grade reads that.
class Upscaler extends FSR1Node {
  constructor(input, sharpness) { super(input, sharpness); this.on = true; }
  setEnabled(on) {
    this.on = on;
    this._textureNode.value = on ? this._rcasRT.texture : this.textureNode.value;
  }
  updateBefore(frame) { if (this.on) super.updateBefore(frame); }
}

// The multisampled colour of a pass that resolves is discarded after the resolve instead of stored (WebGPU): nothing
// reads it after the resolve, and on tile GPUs (Apple, Adreno, Mali) storing it writes four samples a pixel to memory
// where the resolve alone keeps them on the tile (the desktop GPU here shows no difference; unmeasured on a tiler).
// The depth is still stored. Patches a three internal (WebGPUBackend._getRenderPassDescriptor); should an upgrade
// change it, the buffer is stored again. Not for a target that is drawn again with its contents kept (none here).
export function discardMultisampleStores(renderer) {
  const B = renderer.backend, get = B._getRenderPassDescriptor;
  if (!B.isWebGPUBackend || !get) return;
  B._getRenderPassDescriptor = function (context, config) {
    const d = get.call(this, context, config);
    for (const a of d.colorAttachments) if (a.resolveTarget) a.storeOp = 'discard';
    return d;
  };
}

// scene pass -> shafts -> bloom -> tone map / sRGB -> (supersampling: downsample | render scale: upscale) -> grade
// shaftScale: light-shaft buffer size relative to the drawing buffer; ss: the scene's render scale over the drawing
// buffer (above 1 it is supersampled: the scene and the tone-mapped image at ss times the drawing buffer each way,
// filtered down before the grade; setScale lowers it where the device's texture limit requires); upscale: setScale
// may lower the scene's scale below 1 (the adaptive render scale), the image upscaled by FSR 1 with RCAS sharpening
// upscaleSharpness (0 the most, 2 none)
export function buildPipeline(renderer, scene, camera, { raySamples, bloomStrength = 0.4, msaa = 4, shaftScale = 0.5, ss = 1, upscale = false, upscaleSharpness = 0.5 }) {
  const scenePass = pass(scene, camera, { samples: msaa });
  scenePass.setResolutionScale(ss);
  const color = scenePass.getTextureNode('output');
  const shafts = lightShafts(color, raySamples, shaftScale);
  const hdr = Fn(() => {
    const c = color.sample(uv());
    const r = shafts.rays.sample(uv()).rgb;
    return vec4(min(c.rgb.add(r.mul(shafts.uniforms.tint).mul(shafts.uniforms.intensity).mul(0.4)), vec3(24.0)), 1.0);
  })();
  const bl = unrealBloom(hdr, { strength: bloomStrength, radius: 0.55, threshold: 2.2 });
  const ldr = rtt(renderOutput(vec4(aces170(hdr.rgb.add(bl.node), toneMappingExposure), 1.0), THREE.NoToneMapping, THREE.SRGBColorSpace), null, null, { resolutionScale: ss });
  ldr.name = 'Output';
  let down = null, up = null, resolved = ldr;
  if (ss > 1) {
    down = downsample(ldr, ss);
    resolved = rtt(down.node);
    resolved.name = 'Downsample';
  } else if (upscale) {
    up = new Upscaler(ldr, upscaleSharpness);
    resolved = up.getTextureNode();
    up.setEnabled(false);
  }
  const g = grade(resolved);
  const pipeline = new THREE.RenderPipeline(renderer, g.node);
  pipeline.outputColorTransform = false;
  return {
    pipeline, scenePass, shafts, bloom: bl, grade: g, upscaler: up,
    // the scene pass's scale over the drawing buffer of w x h: above 1 the supersampling (no more than the ss it was
    // built with), below 1 the adaptive render scale (built with `upscale`); the effect buffers (shafts, bloom) follow
    // the scene pass down, not up
    setScale(s, w, h) {
      const d = Math.min(1, s);
      if (down || up) { scenePass.setResolutionScale(s); ldr.setResolutionScale(s); }
      shafts.setScale(shaftScale * d);
      bl.setSize(Math.max(1, Math.floor(w * d)), Math.max(1, Math.floor(h * d)));
      if (down) { down.uniforms.inRes.value.set(Math.floor(w * s), Math.floor(h * s)); down.uniforms.outRes.value.set(w, h); }
      if (up) up.setEnabled(s < 0.999);
    },
  };
}
