// Sakura River — cinematic procedural scene engine
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import { createWorld } from './world.js';
import { U, patch, windDepthMaterial } from './shaders.js';
import { growTree, buildBarkGeometry, buildBlossomCardGeometry, paintBlossomAtlas, paintBark, MAIN_TREE, SMALL_TREE } from './tree.js';
import { makeGrass, makeFlowers, makeRocks, makeForest } from './vegetation.js';
import { makeSky, skyState } from './sky.js';
import { makeWater, PlanarReflection } from './water.js';
import { PetalSystem, makeFallenPetals, makeMotes } from './petals.js';
import { GodRaysPass, GradeShader } from './post.js';
import { mulberry32, clamp, lerp, smoothstep } from './noise.js';
import { makeLantern, makeBridge, makePagoda, makeFuji } from './props.js';
import { createBenchProbe } from './bench-probe.js';
import { tessellate, tessellateTree, makeStressObjects, makeRain } from './stress.js';

const TIERS = {
  high: { pr: 2.0, terrain: [420, 440], grass: 40000, flowers: 2600, petals: 3600, fallen: 3800, motes: 500, shadow: 4096, refl: 0.5, msaa: 4, rays: 48, forest: 2200, bloomRes: 1 },
  medium: { pr: 1.5, terrain: [300, 320], grass: 22000, flowers: 1500, petals: 2200, fallen: 2400, motes: 300, shadow: 2048, refl: 0.4, msaa: 2, rays: 36, forest: 1500, bloomRes: 0.75 },
  low: { pr: 1.25, terrain: [210, 230], grass: 9000, flowers: 700, petals: 1100, fallen: 1300, motes: 150, shadow: 1024, refl: 0, msaa: 0, rays: 24, forest: 900, bloomRes: 0.5 },
};

function detectTier(renderer) {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);
  const cores = navigator.hardwareConcurrency || 4;
  let gpu = '';
  try { const gl = renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || ''; } catch (e) { /* ignore */ }
  const weak = /SwiftShader|llvmpipe|Software|Mali-[4T]|Adreno \(TM\) [3-5]\d\d|PowerVR/i.test(gpu);
  if (mobile) return !weak && cores >= 8 ? 'medium' : 'low';
  if (weak) return 'low';
  if (cores <= 4) return 'medium';
  return 'high';
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function create(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  const tierName = opts.quality || detectTier(renderer);
  const Q = { ...TIERS[tierName] };
  const ST = opts.stress || null; // bench-only future-content scenario
  const dpr = Math.min(window.devicePixelRatio || 1, Q.pr);
  let resScale = 1;
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const probe = opts.bench ? createBenchProbe(renderer) : null;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 9000);
  camera.layers.enable(1);

  // ---------- world ----------
  const world = createWorld(7);
  const TZ = 2;
  const TX = world.riverX(TZ) - world.riverHW(TZ) - 7.2;
  const treePos = new THREE.Vector3(TX, 0, TZ);

  const terrainGeo = world.buildTerrain(Q.terrain[0], Q.terrain[1]);
  const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 });
  patch(terrainMat, {
    key: 'terrain',
    fragColor: `
      float dn = vnoise(vFogWorld.xz * 0.9) * 0.5 + vnoise(vFogWorld.xz * 3.7) * 0.3 + vnoise(vFogWorld.xz * 0.12) * 0.45;
      diffuseColor.rgb *= 0.7 + 0.42 * dn;`,
    fragLight: `
      if (vFogWorld.y < 0.03) {
        vec2 cp = vFogWorld.xz * 0.8; float ct = uTime * 0.55;
        float c1 = vnoise(cp + vec2(ct, ct * 0.7)); float c2 = vnoise(cp * 1.37 - vec2(ct * 0.8, -ct * 0.5) + 5.0);
        float cc = pow(1.0 - abs(c1 - c2), 10.0);
        float cw = smoothstep(0.03, -0.3, vFogWorld.y) * smoothstep(-2.6, -0.6, vFogWorld.y);
        outgoingLight += diffuseColor.rgb * uSunColor * uSunVis * cc * cw * 2.2;
        outgoingLight *= mix(1.0, 0.75, smoothstep(0.0, -1.5, vFogWorld.y));
      }`,
  });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.receiveShadow = true;
  scene.add(terrain);

  // ---------- sky + lights ----------
  const sky = makeSky();
  scene.add(sky.mesh);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  const sc = sun.shadow.camera;
  sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 320;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  scene.add(sun); scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xbcd0ff, 0x3a3a20, 0.9);
  scene.add(hemi);

  // ---------- trees ----------
  const bark = paintBark(3);
  const atlas = paintBlossomAtlas(5, tierName === 'high' ? 2048 : 1024);
  if (opts.debug) window.__sakuraDebug = { bark, atlas };
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  atlas.anisotropy = Math.min(16, maxAniso); bark.map.anisotropy = Math.min(16, maxAniso); bark.bump.anisotropy = Math.min(8, maxAniso);
  const barkMat = new THREE.MeshStandardMaterial({ map: bark.map, bumpMap: bark.bump, bumpScale: 0.5, vertexColors: true, roughness: 0.78, metalness: 0, color: new THREE.Color(1.9, 1.75, 1.75) });
  patch(barkMat, {
    key: 'bark', wind: 'aFlex', vertPars: 'attribute float aFlex;',
    fragLight: `
      vec3 vvB = normalize(cameraPosition - vFogWorld);
      float rimB = pow(1.0 - max(dot(normal, normalize((viewMatrix * vec4(vvB, 0.0)).xyz)), 0.0), 3.0);
      outgoingLight += uSunColor * uSunVis * rimB * pow(max(dot(-vvB, uSunDir), 0.0), 2.0) * 0.35 * diffuseColor.rgb * 4.0;
      outgoingLight += diffuseColor.rgb * uSkyAmb * 0.15;`,
  });
  const barkDepth = windDepthMaterial('aFlex', 'bark');
  const blossomMat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.72, metalness: 0, alphaToCoverage: Q.msaa > 0 });
  patch(blossomMat, {
    key: 'blossom', wind: 'aFlex',
    vertPars: 'attribute float aFlex; attribute vec2 aAtlas; attribute vec3 aCanopyN;',
    vertUv: 'vMapUv = vMapUv * 0.5 + aAtlas;',
    vertNormal: 'transformedNormal = normalMatrix * normalize(mix(normalize(mat3(instanceMatrix) * objectNormal), aCanopyN, 0.72));',
    noFlip: true,
    fragLight: `
      vec3 vdirB = normalize(vFogWorld - cameraPosition);
      float backB = pow(max(dot(vdirB, uSunDir), 0.0), 2.5);
      vec3 sunB = mix(uSunColor, vec3(dot(uSunColor, vec3(0.33))), 0.45);
      outgoingLight += diffuseColor.rgb * sunB * uSunVis * (backB * 1.2 + 0.1);
      outgoingLight += diffuseColor.rgb * (vec3(0.16) + uSkyAmb * 0.1);`,
  });
  const blossomDepth = windDepthMaterial('aFlex', 'blossom', { map: atlas, alphaTest: 0.4 });
  const cardGeo = ST ? tessellate(buildBlossomCardGeometry(), ST.triMul) : buildBlossomCardGeometry();

  function buildTreeObject(seed, cfg, pos, blossomScale = 1, castShadow = true) {
    const groundAt = (x, z) => world.height(x + pos.x, z + pos.z);
    const t = growTree(seed, cfg, groundAt);
    const bg = ST ? tessellate(buildBarkGeometry(t, groundAt), ST.triMul) : buildBarkGeometry(t, groundAt);
    const group = new THREE.Group();
    group.position.copy(pos);
    const barkMesh = new THREE.Mesh(bg, barkMat);
    barkMesh.customDepthMaterial = barkDepth;
    barkMesh.castShadow = castShadow; barkMesh.receiveShadow = true;
    group.add(barkMesh);
    // blossoms
    const rng = mulberry32(seed + 1);
    const n = t.blossoms.length;
    const geo = cardGeo.clone();
    const aFlex = new Float32Array(n), aAtlas = new Float32Array(n * 2), aCan = new Float32Array(n * 3);
    const mesh = new THREE.InstancedMesh(geo, blossomMat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), e = new THREE.Euler(), col = new THREE.Color();
    const { center, ext } = t.canopy;
    t.blossoms.forEach((b, i) => {
      e.set(rng() * 6.28, rng() * 6.28, rng() * 6.28);
      q.setFromEuler(e);
      const sz = (0.85 + rng() * 0.55) * blossomScale * (b.depth <= 2 ? 1.15 : 1);
      s.set(sz, sz, sz);
      m.compose(b.p, q, s);
      mesh.setMatrixAt(i, m);
      aFlex[i] = Math.pow(clamp((b.f - 2.2) / 14, 0, 1.4), 1.55);
      aAtlas[i * 2] = rng() < 0.5 ? 0 : 0.5; aAtlas[i * 2 + 1] = rng() < 0.5 ? 0 : 0.5;
      const cn = new THREE.Vector3((b.p.x - center.x) / ext.x, (b.p.y - center.y) / ext.y * 0.8, (b.p.z - center.z) / ext.z);
      const r = cn.length();
      cn.normalize();
      aCan[i * 3] = cn.x; aCan[i * 3 + 1] = cn.y; aCan[i * 3 + 2] = cn.z;
      const ao = lerp(0.3, 1.0, smoothstep(0.3, 1.05, r)) * (0.75 + 0.25 * clamp(cn.y + 0.5, 0, 1));
      const hue = rng();
      col.setRGB(ao * (0.98 + hue * 0.04), ao * (0.8 + hue * 0.14) * lerp(0.85, 1, ao), ao * (0.88 + hue * 0.08));
      mesh.setColorAt(i, col);
    });
    geo.setAttribute('aFlex', new THREE.InstancedBufferAttribute(aFlex, 1));
    geo.setAttribute('aAtlas', new THREE.InstancedBufferAttribute(aAtlas, 2));
    geo.setAttribute('aCanopyN', new THREE.InstancedBufferAttribute(aCan, 3));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.customDepthMaterial = blossomDepth;
    mesh.castShadow = castShadow; mesh.receiveShadow = castShadow;
    mesh.computeBoundingSphere(); mesh.boundingSphere.radius += 2.5;
    group.add(mesh);
    return { group, tree: t, blossoms: mesh };
  }

  const main = buildTreeObject(11, MAIN_TREE, treePos, 1.0, true);
  scene.add(main.group);
  const smallTrees = [];
  const smallSpots = [
    { z: -40, side: 1, off: 9, s: 0.95 }, { z: -92, side: -1, off: 12, s: 1.0 }, { z: -150, side: 1, off: 15, s: 1.05 },
    { z: -12, side: 1, off: 24, s: 0.9 }, { z: -225, side: -1, off: 18, s: 1.1 }, { z: -300, side: 1, off: 26, s: 1.1 },
  ];
  smallSpots.forEach((sp, k) => {
    const x = world.riverX(sp.z) + sp.side * (world.riverHW(sp.z) + sp.off);
    const o = buildTreeObject(100 + k * 13, SMALL_TREE, new THREE.Vector3(x, 0, sp.z), 1.05, Math.abs(sp.z) < 45);
    o.group.scale.setScalar(sp.s);
    o.group.position.y += (1 - sp.s) * 0.2;
    scene.add(o.group);
    smallTrees.push(o);
  });

  // ---------- Japanese set pieces ----------
  const fuji = makeFuji(world, world.peak.x, world.peak.z, world.peak.R, 820, 30);
  scene.add(fuji);
  const LX = TX + 5.2, LZ = TZ + 12;
  const lantern = makeLantern(world, LX, LZ, 0.3);
  scene.add(lantern.group);
  const bridge = makeBridge(world, -60);
  scene.add(bridge.mesh);
  const pagoda = makePagoda(world, world.pagoda.x, world.pagoda.z, 1.0);
  scene.add(pagoda);
  if (ST) [lantern.group, bridge.mesh, pagoda].forEach((o) => tessellateTree(o, ST.triMul));

  // ---------- ground cover ----------
  const trunkAvoid = (x, z) => Math.hypot(x - TX, z - TZ) < 0.95 || Math.hypot(x - LX, z - LZ) < 0.75;
  const rocks = makeRocks(world, tierName, treePos);
  scene.add(rocks.group);
  if (ST) tessellateTree(rocks.group, ST.triMul);
  const rockAvoid = (x, z) => {
    if (trunkAvoid(x, z)) return true;
    for (const r of rocks.blockers) { if (r.sc > 0.3 && Math.abs(x - r.x) < r.sc && Math.abs(z - r.z) < r.sc && Math.hypot(x - r.x, z - r.z) < r.sc * 0.9) return true; }
    return false;
  };
  const focus = new THREE.Vector3(TX + 8, 0, TZ + 8);
  const grass = makeGrass(world, Q.grass * (ST ? ST.grass : 1), { focus, radius: 62, avoid: rockAvoid });
  world.buildHeightCache();
  scene.add(grass);
  const flowers = makeFlowers(world, Q.flowers, { focus, radius: 48, avoid: rockAvoid });
  scene.add(flowers);
  const forest = makeForest(world, Q.forest);
  scene.add(forest);

  // ---------- river ----------
  const depthMap = world.buildDepthMap(rocks.rocksInWater);
  const water = makeWater(world.buildRiver(), depthMap, sky);
  scene.add(water.mesh);
  let reflection = null;
  if (Q.refl > 0) reflection = new PlanarReflection(renderer, 256, 256);

  // ---------- petals ----------
  const spawnPts = main.blossoms ? main.tree.blossoms.map((b) => b.p.clone().add(treePos)) : [];
  const petals = new PetalSystem(world, spawnPts, Q.petals, camera);
  scene.add(petals.mesh);
  const fallen = makeFallenPetals(world, treePos, Q.fallen, (x, z) => trunkAvoid(x, z));
  scene.add(fallen);
  const motes = makeMotes(new THREE.Vector3(TX + 3, 0, TZ + 2), Q.motes);
  scene.add(motes);
  if (ST) {
    scene.add(makeStressObjects(world, ST.objects, focus));
    scene.add(makeRain(ST.particles));
  }

  // ---------- post ----------
  const rtSize = new THREE.Vector2(2, 2);
  const depthTex = new THREE.DepthTexture(2, 2);
  depthTex.type = THREE.UnsignedIntType;
  const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: Q.msaa, depthTexture: depthTex });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(dpr);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const rays = new GodRaysPass(2, 2, Q.rays);
  composer.addPass(rays);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.55, 2.2);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  if (probe) {
    probe.wrapPass(renderPass, 'scene'); probe.wrapPass(rays, 'godrays'); probe.wrapPass(bloom, 'bloom');
    probe.wrapPass(composer.passes[3], 'output'); probe.wrapPass(grade, 'grade');
  }

  // ---------- camera / controls ----------
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.5; controls.zoomSpeed = 0.8; controls.panSpeed = 0.6;
  controls.minDistance = 4; controls.maxDistance = 170;
  controls.maxPolarAngle = Math.PI * 0.53;
  controls.autoRotateSpeed = 0.35;
  const DEFAULT = {
    pos: new THREE.Vector3(TX + 13, 2.6, TZ + 24),
    target: new THREE.Vector3(TX + 7.5, 6.2, TZ + 1),
  };
  camera.position.copy(DEFAULT.pos).add(new THREE.Vector3(14, 7, 22));
  controls.target.copy(DEFAULT.target).add(new THREE.Vector3(2, 2, 0));
  controls.update();

  const trunkTop = MAIN_TREE.trunk.length + 1.5;
  function clampCamera() {
    const p = camera.position;
    const g = Math.max(world.heightFast(p.x, p.z), 0);
    if (p.y < g + 0.8) p.y = g + 0.8;
    const dx = p.x - TX, dz = p.z - TZ, d = Math.hypot(dx, dz);
    if (p.y < trunkTop && d < 1.8) { const k = 1.8 / Math.max(d, 1e-3); p.x = TX + dx * k; p.z = TZ + dz * k; }
    const lx = p.x - LX, lz = p.z - LZ, ld = Math.hypot(lx, lz);
    if (p.y < 3.2 && ld < 1.3) { const k = 1.3 / Math.max(ld, 1e-3); p.x = LX + lx * k; p.z = LZ + lz * k; }
    const t = controls.target;
    t.x = clamp(t.x, -160, 160); t.z = clamp(t.z, -220, 90);
    t.y = clamp(t.y, Math.max(world.heightFast(t.x, t.z), 0) + 0.3, 40);
    const r = Math.hypot(p.x - TX, p.z - TZ);
    if (r > 260) { p.x = TX + (p.x - TX) * 260 / r; p.z = TZ + (p.z - TZ) * 260 / r; }
  }

  // cinematic flight path
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const rx = (z) => world.riverX(z);
  const camKeys = [
    { p: V3(rx(46) + 3, 1.5, 46), t: V3(rx(-30), 4, -40) },
    { p: V3(TX + 22, 2.4, TZ + 20), t: V3(TX + 2, 6, TZ - 4) },
    { p: V3(TX + 9, 2.2, TZ + 9), t: V3(TX - 1, 7.5, TZ - 4) },
    { p: V3(TX - 3, 3.2, TZ + 11), t: V3(TX + 3, 8.5, TZ - 3) },
    { p: V3(TX - 13, 5.5, TZ + 6), t: V3(TX + 6, 5, TZ - 12) },
    { p: V3(TX - 8, 12, TZ + 30), t: V3(TX + 10, 4, TZ - 30) },
    { p: V3(TX + 20, 7, TZ + 40), t: V3(rx(-80), 6, -90) },
  ];
  const posCurve = new THREE.CatmullRomCurve3(camKeys.map((k) => k.p), true, 'centripetal');
  const tgtCurve = new THREE.CatmullRomCurve3(camKeys.map((k) => k.t), true, 'centripetal');
  let cinematic = false, cineT = 0, autoOrbit = false;
  let tween = null; // {from:{pos,target}, to:{pos,target}, t, dur}
  function startTween(toPos, toTarget, dur) {
    tween = { fp: camera.position.clone(), ft: controls.target.clone(), tp: toPos.clone(), tt: toTarget.clone(), t: 0, dur };
  }
  startTween(DEFAULT.pos, DEFAULT.target, opts.introDuration ?? 6.5);

  canvas.addEventListener('pointerdown', () => {
    if (tween) tween = null;
    if (cinematic) { cinematic = false; controls.enabled = true; opts.onCinematicChange && opts.onCinematicChange(false); }
  });
  canvas.addEventListener('wheel', () => { if (tween) tween = null; }, { passive: true });

  // ---------- params ----------
  const P = { wind: 0.6, petals: 0.6, river: 1.0, time: 0.92, fog: 0.25, bloom: 0.4 };
  const S = { ...P }; // smoothed
  petals.setAmount(P.petals);

  let lastTime = -1;
  function applyTimeOfDay(t) {
    const st = skyState(t);
    U.uSunDir.value.copy(st.dir);
    U.uSunColor.value.copy(st.sun);
    U.uSunVis.value = st.vis;
    sky.uniforms.uZenith.value.copy(st.zenith);
    sky.uniforms.uHorizon.value.copy(st.horizon);
    sky.uniforms.uCloudLit.value.copy(st.cloudLit);
    sky.uniforms.uCloudShade.value.copy(st.cloudShade);
    U.uFogColor.value.copy(st.fog);
    U.uFogSunColor.value.copy(st.fogSun);
    sun.color.copy(st.sun);
    sun.intensity = st.sunI * st.vis;
    const amb = st.zenith.clone().lerp(st.horizon, 0.45);
    U.uSkyAmb.value.copy(amb);
    hemi.color.copy(amb).multiplyScalar(1.25);
    hemi.groundColor.setRGB(0.16, 0.15, 0.08).lerp(st.fog, 0.25);
    hemi.intensity = lerp(0.62, 1.0, 1 - st.vis * 0.6);
    rays.tint.copy(st.sun).lerp(new THREE.Color(1, 0.9, 0.8), 0.3);
    renderer.toneMappingExposure = lerp(1.35, 0.98, st.vis) * (st.elev > 30 ? 0.92 : 1);
    lastTime = t;
    return st;
  }
  let skyNow = applyTimeOfDay(S.time);

  // ---------- sizing / adaptive quality ----------
  let W = 1, H = 1;
  function resize() {
    const w = Math.max(1, canvas.clientWidth | 0), h = Math.max(1, canvas.clientHeight | 0);
    W = w; H = h;
    const pr = dpr * resScale;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (reflection) reflection.setSize(Math.floor(w * pr * Q.refl), Math.floor(h * pr * Q.refl));
    grade.uniforms.uRes.value.set(w * pr, h * pr);
    grade.uniforms.uSharp.value = pr >= 1.75 ? 0.3 : pr >= 1.2 ? 0.45 : 0.6;
    motes.material.uniforms.uPx.value = pr * (h / 900) * 1.3;
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  resize();

  // adaptive quality ladder: cheapest visual losses first, resolution last
  let frames = 0, acc = 0, statT = 0, fpsShown = 60;
  let level = 0; // 0 = full
  let shadowEvery = tierName === 'high' ? 1 : 2, reflEvery = tierName === 'high' ? 1 : 2;
  const ladder = [
    { up() { reflEvery = 2; }, down() { reflEvery = tierName === 'high' ? 1 : 2; } },
    { up() { shadowEvery = 2; }, down() { shadowEvery = tierName === 'high' ? 1 : 2; } },
    { up() { grass.userData.setFraction(0.7); }, down() { grass.userData.setFraction(1); } },
    { up() { resScale = 0.85; resize(); }, down() { resScale = 1; resize(); } },
    { up() { reflEvery = 1e9; water.uniforms.uHasRefl.value = 0; grass.userData.setFraction(0.5); }, down() { reflEvery = 2; grass.userData.setFraction(0.7); } },
    { up() { resScale = 0.72; resize(); }, down() { resScale = 0.85; resize(); } },
  ];
  let slowWin = 0, fastWin = 0;
  function adapt(dt) {
    if (frameNo < 20) return;
    frames++; acc += dt; statT += dt;
    if (statT >= 1) {
      const avg = (acc / frames) * 1000;
      fpsShown = Math.round(1000 / avg);
      if (!opts.fixedQuality) {
        if (avg > 21) { slowWin++; fastWin = 0; } else if (avg < 13) { fastWin++; slowWin = 0; } else { slowWin = 0; fastWin = 0; }
        if (slowWin >= 2 && level < ladder.length) { ladder[level].up(); level++; slowWin = 0; }
        if (fastWin >= 5 && level > 0) { level--; ladder[level].down(); fastWin = 0; }
      }
      opts.onStats && opts.onStats({ fps: fpsShown, quality: tierName, level, scale: resScale });
      frames = 0; acc = 0; statT = 0;
    }
  }

  // ---------- loop ----------
  const clock = new THREE.Clock();
  const tmpV = new THREE.Vector3();
  let running = true;
  let frameNo = 0;
  const sunScreen = new THREE.Vector3();

  function step(dtIn, doRender = true) {
    const dt = Math.min(dtIn, 0.05);
    const k = 1 - Math.exp(-dt * 2.5);
    for (const key in P) S[key] += (P[key] - S[key]) * k;
    if (Math.abs(S.time - lastTime) > 0.0004) skyNow = applyTimeOfDay(S.time);
    U.uTime.value += dt;
    U.uWind.value = S.wind;
    U.uFlow.value += dt * S.river * 1.3;
    water.uniforms.uSpeed.value = S.river;
    sky.uniforms.uCloud.value.x += dt * (0.006 + S.wind * 0.012);
    sky.uniforms.uCloud.value.y -= dt * (0.003 + S.wind * 0.005);
    U.uFogDensity.value = 0.0006 + Math.pow(S.fog, 1.5) * 0.013;
    U.uFogFalloff.value = 0.028;
    bloom.strength = S.bloom * 1.6;
    grade.uniforms.uTime.value = U.uTime.value;

    petals.update(dt, U.uTime.value, S.wind, S.river);
    lantern.update(U.uSunVis.value * smoothstep(-2, 14, skyNow.elev));

    // camera
    if (cinematic) {
      cineT += dt / 95;
      const u = cineT % 1;
      const p = posCurve.getPointAt(u), t = tgtCurve.getPointAt(u);
      camera.position.lerp(p, 1 - Math.exp(-dt * 1.5));
      controls.target.lerp(t, 1 - Math.exp(-dt * 1.5));
      clampCamera();
      camera.lookAt(controls.target);
    } else if (tween) {
      tween.t += dt / tween.dur;
      const e = easeInOut(Math.min(1, tween.t));
      camera.position.lerpVectors(tween.fp, tween.tp, e);
      controls.target.lerpVectors(tween.ft, tween.tt, e);
      camera.lookAt(controls.target);
      if (tween.t >= 1) { tween = null; controls.update(); }
    } else {
      controls.autoRotate = autoOrbit;
      controls.update();
      clampCamera();
      camera.lookAt(controls.target);
    }
    camera.updateMatrixWorld();
    sky.mesh.position.copy(camera.position);

    // sun light / shadow frustum anchored on the tree
    const sd = U.uSunDir.value;
    const anchor = tmpV.set(TX + 4, 3, TZ + 2);
    sun.target.position.copy(anchor);
    const sdl = sd.clone(); if (sdl.y < 0.08) sdl.y = 0.08; sdl.normalize();
    sun.position.copy(anchor).addScaledVector(sdl, 150);
    sun.target.updateMatrixWorld();

    // god-ray sun position
    sunScreen.copy(camera.position).addScaledVector(sd, 2000).project(camera);
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    const facing = smoothstep(0.05, 0.55, camDir.dot(sd));
    const onScreen = smoothstep(1.9, 1.0, Math.max(Math.abs(sunScreen.x), Math.abs(sunScreen.y)));
    rays.sun.set(sunScreen.x * 0.5 + 0.5, sunScreen.y * 0.5 + 0.5);
    rays.intensity = facing * onScreen * U.uSunVis.value * (0.55 + S.fog * 0.9) * (opts.rays ?? 1);

    // reflections
    if (!doRender) return;
    frameNo++;
    if (probe) probe.beginFrame();
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = frameNo % shadowEvery === 0 || frameNo < 3;
    if (reflection && (frameNo % reflEvery === 0 || frameNo < 3)) {
      if (probe) probe.push('reflection');
      const ok = reflection.render(scene, camera, [water.mesh]);
      if (probe) probe.pop();
      water.uniforms.uHasRefl.value = ok ? 1 : 0;
      water.uniforms.uRefl.value = reflection.rt.texture;
      water.uniforms.uTexMat.value.copy(reflection.texMat);
    }
    composer.render(dt);
    if (probe) probe.endFrame();
  }

  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    const dt = clock.getDelta();
    step(dt);
    adapt(dt);
  }
  if (!opts.manual) requestAnimationFrame(loop);
  opts.onReady && opts.onReady({ quality: tierName });

  return {
    set(name, v) {
      v = clamp(+v, 0, 1);
      if (name === 'wind') P.wind = v * 1.6;
      else if (name === 'petals') { P.petals = v; petals.setAmount(v); }
      else if (name === 'river') P.river = v * 2.2;
      else if (name === 'time') P.time = v;
      else if (name === 'fog') P.fog = v;
      else if (name === 'bloom') P.bloom = v;
    },
    setImmediate(name, v) { this.set(name, v); for (const k in P) S[k] = P[k]; },
    resetCamera() {
      cinematic = false; controls.enabled = true;
      startTween(DEFAULT.pos, DEFAULT.target, 1.8);
    },
    setCinematic(on) {
      cinematic = !!on; controls.enabled = !cinematic;
      if (cinematic) {
        tween = null;
        // start from the nearest point on the path
        let best = 0, bd = Infinity;
        for (let i = 0; i < 200; i++) { const d = posCurve.getPointAt(i / 200).distanceToSquared(camera.position); if (d < bd) { bd = d; best = i / 200; } }
        cineT = best;
      } else controls.update();
    },
    setAutoOrbit(on) { autoOrbit = !!on; },
    cineView(u) { const p = posCurve.getPointAt(u), t = tgtCurve.getPointAt(u); tween = null; camera.position.copy(p); controls.target.copy(t); clampCamera(); controls.update(); },
    setView(pos, target) { tween = null; camera.position.set(...pos); controls.target.set(...target); controls.update(); },
    heroView() { cinematic = false; controls.enabled = true; tween = null; camera.position.copy(DEFAULT.pos); controls.target.copy(DEFAULT.target); controls.update(); },
    advance(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt, false); },
    bench: probe,
    qualityState() { return { tier: tierName, level, scale: resScale, fps: fpsShown }; },
    setAdaptive(on) { opts.fixedQuality = !on; },
    step(dt) { step(dt); },
    tick(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt); },
    simulate(sec, dt = 1 / 30) { for (let t = 0; t < sec; t += dt) step(dt, false); },
    info() { return { tier: tierName, tree: [TX, TZ], blossoms: main.tree.blossoms.length, grass: grass.userData.total, verts: terrainGeo.attributes.position.count, calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; },
    dispose() { running = false; ro.disconnect(); controls.dispose(); renderer.dispose(); },
  };
}

if (typeof window !== 'undefined') window.SakuraRiver = { create };
