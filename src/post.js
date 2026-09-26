// Post: screen-space volumetric light shafts (depth-masked radial scattering) + final grade
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const QUAD_VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class GodRaysPass extends Pass {
  constructor(w, h, samples = 48) {
    super();
    this.needsSwap = true;
    const opt = { type: THREE.HalfFloatType, depthBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(w, h, opt);
    this.rtB = new THREE.WebGLRenderTarget(w, h, opt);
    this.sun = new THREE.Vector2(0.5, 0.5);
    this.intensity = 1;
    this.tint = new THREE.Color(1, 0.8, 0.6);
    this.scale = 0.5;
    this.mask = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tDepth: { value: null }, uSun: { value: this.sun }, uAspect: { value: 1 } },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tColor, tDepth; uniform vec2 uSun; uniform float uAspect; varying vec2 vUv;
        void main(){
          float d = texture2D(tDepth, vUv).r;
          float sky = step(0.99999, d);
          vec3 c = min(texture2D(tColor, vUv).rgb, vec3(6.0));
          vec2 dv = (vUv - uSun) * vec2(uAspect, 1.0);
          float fall = exp(-length(dv) * 9.0);
          gl_FragColor = vec4(min(max(c - 0.9, 0.0), vec3(1.2)) * sky * fall, 1.0);
        }`,
    });
    this.blur = new THREE.ShaderMaterial({
      defines: { SAMPLES: samples },
      uniforms: { tIn: { value: null }, uSun: { value: this.sun }, uLen: { value: 1 }, uDecay: { value: 0.965 } },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tIn; uniform vec2 uSun; uniform float uLen, uDecay; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){
          vec2 delta = (vUv - uSun) * uLen / float(SAMPLES);
          vec2 uv = vUv - delta * h(vUv * 1000.0);
          vec3 acc = vec3(0.0); float w = 1.0, tw = 0.0;
          for (int i = 0; i < SAMPLES; i++) { acc += texture2D(tIn, uv).rgb * w; tw += w; w *= uDecay; uv -= delta; }
          gl_FragColor = vec4(acc / tw, 1.0);
        }`,
    });
    this.comp = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tRays: { value: null }, uI: { value: 1 }, uTint: { value: this.tint } },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */`
        uniform sampler2D tColor, tRays; uniform float uI; uniform vec3 uTint; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tColor, vUv); vec3 r = texture2D(tRays, vUv).rgb; vec3 o = c.rgb + r * uTint * uI * 0.4; if (isnan(o.r) || isnan(o.g) || isnan(o.b)) o = vec3(0.0); gl_FragColor = vec4(min(o, vec3(24.0)), c.a); }`,
    });
    this.quad = new FullScreenQuad(this.mask);
  }
  setSize(w, h) {
    const s = this.scale;
    this.rtA.setSize(Math.max(8, Math.floor(w * s)), Math.max(8, Math.floor(h * s)));
    this.rtB.setSize(Math.max(8, Math.floor(w * s)), Math.max(8, Math.floor(h * s)));
    this.mask.uniforms.uAspect.value = w / h;
  }
  render(renderer, writeBuffer, readBuffer) {
    if (this.intensity > 0.001) {
      this.mask.uniforms.tColor.value = readBuffer.texture;
      this.mask.uniforms.tDepth.value = readBuffer.depthTexture;
      this.quad.material = this.mask;
      renderer.setRenderTarget(this.rtA); this.quad.render(renderer);
      this.quad.material = this.blur;
      this.blur.uniforms.tIn.value = this.rtA.texture; this.blur.uniforms.uLen.value = 0.85; this.blur.uniforms.uDecay.value = 0.975;
      renderer.setRenderTarget(this.rtB); this.quad.render(renderer);
      this.blur.uniforms.tIn.value = this.rtB.texture; this.blur.uniforms.uLen.value = 0.35; this.blur.uniforms.uDecay.value = 0.99;
      renderer.setRenderTarget(this.rtA); this.quad.render(renderer);
    }
    this.comp.uniforms.tColor.value = readBuffer.texture;
    this.comp.uniforms.tRays.value = this.rtA.texture;
    this.comp.uniforms.uI.value = this.intensity;
    this.quad.material = this.comp;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
}

export const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVig: { value: 0.36 }, uRes: { value: new THREE.Vector2(1, 1) }, uClarity: { value: 0.32 }, uSharp: { value: 0.35 } },
  vertexShader: QUAD_VS,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime, uVig, uClarity, uSharp; uniform vec2 uRes; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
    void main(){
      vec2 px = 1.0 / uRes;
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // contrast-adaptive sharpening (keeps texture detail crisp after MSAA / scaling)
      vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb, so = texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb;
      vec3 e = texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb, w = texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb;
      vec3 mnR = min(c, min(min(n, so), min(e, w))), mxR = max(c, max(max(n, so), max(e, w)));
      vec3 amp = sqrt(clamp(min(mnR, 1.0 - mxR) / max(mxR, 1e-4), 0.0, 1.0));
      vec3 wgt = -amp * uSharp * 0.2;
      c = clamp((c + (n + so + e + w) * wgt) / (1.0 + 4.0 * wgt), 0.0, 1.0);
      // HDR-style local contrast (two radii)
      float s = uRes.y / 900.0;
      float b1 = 0.0, b2 = 0.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398 + 0.39;
        vec2 d = vec2(cos(a), sin(a));
        b1 += luma(texture2D(tDiffuse, vUv + d * px * 7.0 * s).rgb);
        b2 += luma(texture2D(tDiffuse, vUv + d * px * 26.0 * s).rgb);
      }
      b1 /= 8.0; b2 /= 8.0;
      float l = luma(c);
      float detail = clamp((l - b1) * 1.0 + (l - b2) * 0.35, -0.12, 0.12);
      c *= 1.0 + uClarity * detail / (l + 0.22);
      // gentle S-curve
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.28);
      l = luma(c);
      // vibrance: lift muted colours more than saturated ones
      float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
      c = mix(vec3(l), c, 1.0 + 0.32 * (1.0 - (mx - mn)));
      // split tone: indigo shadows, warm apricot highlights
      c = mix(c, c * vec3(0.9, 0.95, 1.12) + vec3(0.005, 0.008, 0.028), 1.0 - smoothstep(0.0, 0.5, l));
      c = mix(c, c * vec3(1.05, 0.99, 0.93), smoothstep(0.55, 1.0, l));
      // vignette
      vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y * 0.75;
      c *= 1.0 - uVig * smoothstep(0.28, 0.95, length(q));
      // washi-like grain
      c += (h(vUv * uRes + fract(uTime) * 100.0) - 0.5) * 0.016;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};
