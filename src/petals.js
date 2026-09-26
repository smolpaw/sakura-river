// Drifting petals (CPU-simulated, GPU instanced), fallen petal carpet, glowing pollen motes
import * as THREE from 'three';
import { U, GLSL_FOG_PARS } from './shaders.js';
import { mulberry32, clamp, lerp } from './noise.js';

function petalGeometry() {
  // cherry petal: rounded with a notch, gently cupped
  const s = new THREE.Shape();
  const L = 1, W = 0.62;
  s.moveTo(0, 0);
  s.bezierCurveTo(W * 0.9, L * 0.2, W * 1.0, L * 0.78, W * 0.3, L);
  s.quadraticCurveTo(0, L * 0.84, -W * 0.3, L);
  s.bezierCurveTo(-W * 1.0, L * 0.78, -W * 0.9, L * 0.2, 0, 0);
  const g = new THREE.ShapeGeometry(s, 6);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setXYZ(i, x, y - 0.5, 0.35 * x * x - 0.12 * (y - 0.5) * (y - 0.5));
  }
  g.computeVertexNormals();
  g.scale(0.1, 0.1, 0.1);
  return g;
}

const PETAL_VS = /* glsl */`
  attribute vec3 iPos; attribute vec4 iRot; // yaw, pitch, roll, scale
  attribute float iTint;
  varying vec3 vW; varying vec3 vN; varying vec2 vP; varying float vTint;
  mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
  mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
  mat3 rotZ(float a){ float c=cos(a), s=sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }
  void main(){
    mat3 R = rotY(iRot.x) * rotX(iRot.y) * rotZ(iRot.z);
    float camD = length(iPos - cameraPosition);
    vec3 p = R * (position * iRot.w * smoothstep(0.9, 2.2, camD)) + iPos;
    vN = R * normal;
    vP = position.xy / 0.1;
    vTint = iTint;
    vW = p;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;

const PETAL_FS = /* glsl */`
  uniform vec3 uSunColor, uSkyAmb; uniform float uSunVis;
  varying vec3 vW; varying vec3 vN; varying vec2 vP; varying float vTint;
  ${GLSL_FOG_PARS}
  void main(){
    vec3 N = normalize(vN);
    vec3 V = normalize(cameraPosition - vW);
    if (dot(N, V) < 0.0) N = -N;
    float t = clamp(vP.y + 0.5, 0.0, 1.0);
    vec3 tip = mix(vec3(0.98, 0.72, 0.8), vec3(1.0, 0.84, 0.89), vTint);
    vec3 base = mix(vec3(0.88, 0.38, 0.54), vec3(0.95, 0.55, 0.68), vTint);
    vec3 alb = mix(base, tip, smoothstep(0.0, 0.7, t));
    float ndl = dot(N, uSunDir);
    float diff = max(ndl, 0.0) * 0.7 + 0.3 * (ndl * 0.5 + 0.5);
    float trans = pow(max(dot(-V, uSunDir), 0.0), 3.0) * 1.3 + 0.12;
    vec3 col = alb * (uSkyAmb * 0.9 + uSunColor * uSunVis * (diff + trans) * 0.9);
    col = applyFog(col, vW);
    gl_FragColor = vec4(col, 1.0);
  }`;

function petalMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunColor: U.uSunColor, uSkyAmb: U.uSkyAmb, uSunVis: U.uSunVis, uSunDir: U.uSunDir,
      uFogColor: U.uFogColor, uFogSunColor: U.uFogSunColor, uFogDensity: U.uFogDensity, uFogBase: U.uFogBase, uFogFalloff: U.uFogFalloff,
    },
    vertexShader: PETAL_VS, fragmentShader: PETAL_FS, side: THREE.DoubleSide,
  });
}

export class PetalSystem {
  constructor(world, spawnPoints, max, camera) {
    this.world = world; this.spawn = spawnPoints; this.max = max; this.camera = camera;
    this.rng = mulberry32(2024);
    const g = petalGeometry();
    const ig = new THREE.InstancedBufferGeometry();
    ig.index = g.index; ig.attributes.position = g.attributes.position; ig.attributes.normal = g.attributes.normal;
    this.pos = new Float32Array(max * 3); this.rot = new Float32Array(max * 4); this.tint = new Float32Array(max);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.InstancedBufferAttribute(this.rot, 4).setUsage(THREE.DynamicDrawUsage);
    ig.setAttribute('iPos', this.aPos); ig.setAttribute('iRot', this.aRot);
    ig.setAttribute('iTint', new THREE.InstancedBufferAttribute(this.tint, 1));
    ig.instanceCount = 0;
    this.geo = ig;
    this.mesh = new THREE.Mesh(ig, petalMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.layers.set(1);
    // state
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.mode = new Uint8Array(max); // 0 air, 1 water, 2 ground
    this.spin = new Float32Array(max * 3);
    this.scale = new Float32Array(max);
    this.active = 0;
    this.target = Math.floor(max * 0.5);
    for (let i = 0; i < max; i++) { this.tint[i] = this.rng(); this.respawn(i, true); }
  }
  setAmount(f) { this.target = Math.floor(clamp(f, 0, 1) * this.max); }
  respawn(i, initial = false) {
    const r = this.rng;
    const nearCam = r() < 0.28;
    let x, y, z;
    if (nearCam) {
      const c = this.camera.position;
      const w = U.uWindDir.value;
      // upwind of the camera so they drift through frame
      const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
      const d0 = 3 + r() * 9;
      x = c.x + fwd.x * d0 - w.x * (3 + r() * 5) + (r() - 0.5) * 10;
      z = c.z + fwd.z * d0 - w.y * (3 + r() * 5) + (r() - 0.5) * 10;
      y = c.y + 1.5 + r() * 4;
    } else {
      const s = this.spawn[Math.floor(r() * this.spawn.length)];
      x = s.x + (r() - 0.5) * 0.6; y = s.y + (r() - 0.5) * 0.6; z = s.z + (r() - 0.5) * 0.6;
    }
    if (initial) {
      // pre-warm: scatter along a plausible fall path
      const t = r();
      x += U.uWindDir.value.x * t * 12; z += U.uWindDir.value.y * t * 12; y -= t * (y - 0.5) * 0.9;
    }
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = 0; this.vel[i * 3 + 1] = -0.2; this.vel[i * 3 + 2] = 0;
    this.age[i] = 0; this.life[i] = 14 + r() * 16; this.mode[i] = 0;
    this.rot[i * 4] = r() * 6.28; this.rot[i * 4 + 1] = r() * 6.28; this.rot[i * 4 + 2] = r() * 6.28;
    this.spin[i * 3] = (r() - 0.5) * 3; this.spin[i * 3 + 1] = (r() - 0.5) * 6; this.spin[i * 3 + 2] = (r() - 0.5) * 5;
    this.scale[i] = (0.75 + r() * 0.5) * (nearCam ? 0.85 : 1);
    this.rot[i * 4 + 3] = 0;
  }
  update(dt, time, wind, riverSpeed) {
    // ramp active count toward target smoothly
    if (this.active < this.target) this.active = Math.min(this.target, this.active + Math.ceil(this.max * dt * 0.4));
    else if (this.active > this.target) this.active = this.target;
    const W = U.uWindDir.value;
    const world = this.world;
    const k = 1 - Math.exp(-dt * 2.2);
    const gust = 0.55 + 0.45 * Math.sin(time * 0.31) * Math.sin(time * 0.19 + 1.3);
    const ws = (0.25 + wind * 3.2) * (0.6 + gust * 0.8);
    for (let i = 0; i < this.active; i++) {
      const i3 = i * 3, i4 = i * 4;
      let x = this.pos[i3], y = this.pos[i3 + 1], z = this.pos[i3 + 2];
      this.age[i] += dt;
      const mode = this.mode[i];
      let sc = this.scale[i];
      const a = this.age[i], life = this.life[i];
      if (mode === 0) {
        const tx = W.x * ws + Math.sin(time * 1.3 + i * 0.37 + y * 0.8) * 0.5 * (0.3 + wind) + Math.sin(time * 0.7 + z * 0.3) * 0.25;
        const tz = W.y * ws + Math.cos(time * 1.1 + i * 0.53 + x * 0.6) * 0.5 * (0.3 + wind);
        const ty = -0.55 - 0.25 * Math.sin(i * 1.7) + Math.sin(time * 2.3 + i) * 0.35 * (0.2 + wind);
        this.vel[i3] += (tx - this.vel[i3]) * k;
        this.vel[i3 + 1] += (ty - this.vel[i3 + 1]) * k;
        this.vel[i3 + 2] += (tz - this.vel[i3 + 2]) * k;
        x += this.vel[i3] * dt; y += this.vel[i3 + 1] * dt; z += this.vel[i3 + 2] * dt;
        const spinK = 0.6 + wind;
        this.rot[i4] += this.spin[i3] * dt * spinK;
        this.rot[i4 + 1] += this.spin[i3 + 1] * dt * spinK;
        this.rot[i4 + 2] += this.spin[i3 + 2] * dt * spinK;
        const g = world.heightFast(x, z);
        if (y <= Math.max(g, 0) + 0.02) {
          if (g < 0) { this.mode[i] = 1; y = 0.012; this.age[i] = 0; this.life[i] = 25 + this.rng() * 15; }
          else { this.mode[i] = 2; y = g + 0.03; this.age[i] = 0; this.life[i] = 4 + this.rng() * 6; }
        }
      } else if (mode === 1) {
        // floating downstream
        const ri = world.riverInfo(x, z);
        const [fx, fz] = world.flowDir(z);
        const sp = riverSpeed * 1.5 * clamp(1 - ri.t * ri.t, 0.08, 1);
        x += (fx * sp + Math.sin(time * 0.8 + i) * 0.05) * dt;
        z += fz * sp * dt;
        // drift back toward centre if stranded
        if (ri.t > 0.8) x -= Math.sign(ri.d) * 0.3 * dt;
        y = 0.012 + Math.sin(time * 2 + x * 1.3 + z) * 0.008;
        this.rot[i4 + 1] *= 1 - k; this.rot[i4 + 2] *= 1 - k;
        this.rot[i4] += Math.sin(time * 0.5 + i) * dt * 0.3;
        if (z > 70 || z < -760) this.age[i] = life;
      } else {
        this.rot[i4 + 1] *= 1 - k; this.rot[i4 + 2] *= 1 - k;
      }
      // scale in/out
      const fadeIn = clamp(this.age[i] / 0.6, 0, 1);
      const fadeOut = clamp((this.life[i] - this.age[i]) / 1.5, 0, 1);
      this.rot[i4 + 3] = sc * (mode === 0 ? fadeIn : 1) * fadeOut;
      this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
      if (this.age[i] >= this.life[i] || y < -5 || Math.abs(x) > 400) this.respawn(i);
    }
    this.geo.instanceCount = this.active;
    this.aPos.needsUpdate = true; this.aRot.needsUpdate = true;
    this.aPos.clearUpdateRanges(); this.aPos.addUpdateRange(0, this.active * 3);
    this.aRot.clearUpdateRanges(); this.aRot.addUpdateRange(0, this.active * 4);
  }
}

// static carpet of fallen petals under the tree
export function makeFallenPetals(world, center, count, avoid) {
  const rng = mulberry32(88);
  const g = petalGeometry();
  const ig = new THREE.InstancedBufferGeometry();
  ig.index = g.index; ig.attributes.position = g.attributes.position; ig.attributes.normal = g.attributes.normal;
  const pos = new Float32Array(count * 3), rot = new Float32Array(count * 4), tint = new Float32Array(count);
  let n = 0, tries = 0;
  while (n < count && tries < count * 10) {
    tries++;
    const r = Math.pow(rng(), 0.65) * 13, a = rng() * 6.28;
    const x = center.x + Math.cos(a) * r * 1.1 + 2, z = center.z + Math.sin(a) * r;
    const y = world.height(x, z);
    if (y < 0.05) continue;
    if (avoid && avoid(x, z)) continue;
    pos[n * 3] = x; pos[n * 3 + 1] = y + 0.04 + rng() * 0.12; pos[n * 3 + 2] = z;
    rot[n * 4] = rng() * 6.28; rot[n * 4 + 1] = (rng() - 0.5) * 0.8; rot[n * 4 + 2] = (rng() - 0.5) * 0.8; rot[n * 4 + 3] = 0.8 + rng() * 0.5;
    tint[n] = rng();
    n++;
  }
  ig.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
  ig.setAttribute('iRot', new THREE.InstancedBufferAttribute(rot, 4));
  ig.setAttribute('iTint', new THREE.InstancedBufferAttribute(tint, 1));
  ig.instanceCount = n;
  const mesh = new THREE.Mesh(ig, petalMaterial());
  mesh.frustumCulled = false;
  mesh.layers.set(1);
  return mesh;
}

// pollen / dust motes glowing in the light shafts
export function makeMotes(center, count) {
  const rng = mulberry32(5);
  const geo = new THREE.BufferGeometry();
  const p = new Float32Array(count * 3), s = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    p[i * 3] = center.x + (rng() - 0.5) * 34; p[i * 3 + 1] = 0.5 + rng() * 11; p[i * 3 + 2] = center.z + (rng() - 0.5) * 30;
    s[i] = rng();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(s, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uSunDir: U.uSunDir, uSunColor: U.uSunColor, uSunVis: U.uSunVis, uWind: U.uWind, uWindDir: U.uWindDir, uPx: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aSeed; uniform float uTime, uWind, uPx; uniform vec2 uWindDir; uniform vec3 uSunDir;
      varying float vA;
      void main(){
        vec3 p = position;
        float t = uTime * (0.15 + aSeed * 0.2);
        p.x += sin(t + aSeed * 40.0) * 1.2 + uWindDir.x * mod(uTime * uWind * 0.6 + aSeed * 30.0, 30.0) - uWindDir.x * 15.0;
        p.z += cos(t * 0.8 + aSeed * 17.0) * 1.2 + uWindDir.y * mod(uTime * uWind * 0.6 + aSeed * 30.0, 30.0) - uWindDir.y * 15.0;
        p.y += sin(t * 1.3 + aSeed * 9.0) * 0.6;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        vec3 V = normalize(p - cameraPosition);
        float toward = pow(max(dot(V, uSunDir), 0.0), 3.0);
        vA = (0.15 + toward * 1.2) * (0.5 + 0.5 * sin(uTime * 2.0 + aSeed * 50.0));
        vA *= smoothstep(2.0, 5.0, -mv.z);
        gl_PointSize = min(uPx * (1.2 + aSeed * 1.6) * 30.0 / -mv.z, 18.0 * uPx);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunColor; uniform float uSunVis; varying float vA;
      void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c,c); float a = exp(-d * 18.0) * vA * uSunVis; gl_FragColor = vec4(uSunColor * a * 1.4, a); }`,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.layers.set(1);
  return pts;
}
