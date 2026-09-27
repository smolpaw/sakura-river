// Sakura River — cinematic procedural scene engine
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createWorld, depthTexture } from './world.js';
import { U, sceneFog, pcfSoftShadowFilter } from './tsl.js';
import { buildBlossomCardGeometry, atlasTexture, barkTextures, MAIN_TREE } from './tree.js';
import { makeGrass, makeFlowers, makeRocks, makeForest } from './vegetation.js';
import { makeSky, skyState } from './sky.js';
import { makeWater } from './water.js';
import { PetalSystem, makeFallenPetals } from './petals.js';
import { petalMaterial, makeMotes, rainMaterial } from './fx.js';
import { buildPipeline } from './post.js';
import { clamp, lerp, smoothstep } from './noise.js';
import { makeLantern, makeBridge, makePagoda, makeFuji } from './props.js';
import * as M from './materials.js';
import { createGPUProbe } from './bench-probe-gpu.js';
import { QualityController } from './quality.js';
import { hashScene } from './bench-hash.js';
import { tessellate, makeStressObjects, makeRain } from './stress.js';
import { runJobs } from './gen/pool.js';
import { layout } from './gen/layout.js';

const TIERS = {
  high: { pr: 2.0, terrain: [420, 440], grass: 40000, flowers: 2600, petals: 3600, fallen: 3800, motes: 500, shadow: 4096, refl: 0.5, msaa: 4, rays: 48, forest: 2200, bloomRes: 1 },
  medium: { pr: 1.5, terrain: [300, 320], grass: 22000, flowers: 1500, petals: 2200, fallen: 2400, motes: 300, shadow: 2048, refl: 0.4, msaa: 2, rays: 36, forest: 1500, bloomRes: 0.75 },
  low: { pr: 1.25, terrain: [210, 230], grass: 9000, flowers: 700, petals: 1100, fallen: 1300, motes: 150, shadow: 1024, refl: 0, msaa: 0, rays: 24, forest: 900, bloomRes: 0.5 },
};

// Starting tier from what the browser reveals about the GPU (WebGPU adapter info or the WebGL renderer string);
// the runtime controller corrects from measured frame cost, so this only has to be roughly right. Integrated and
// mobile GPUs start below 'high' (see docs/research/gpu-selection-and-compat.md for what browsers expose).
function detectTier(renderer) {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820);
  const cores = navigator.hardwareConcurrency || 4;
  let gpu = '';
  try {
    const b = renderer.backend;
    if (b.isWebGPUBackend) { const i = b.device.adapterInfo || {}; gpu = `${i.vendor || ''} ${i.architecture || ''} ${i.description || ''}`; }
    else { const gl = b.gl; const ext = gl.getExtension('WEBGL_debug_renderer_info'); gpu = (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || ''; }
  } catch (e) { /* ignore */ }
  if (/SwiftShader|llvmpipe|Software|Basic Render|Mali-[4T]|Adreno \(TM\) [3-5]\d\d|PowerVR/i.test(gpu)) return 'low';
  if (mobile) return cores >= 8 ? 'medium' : 'low';
  const compat = renderer.backend.isWebGPUBackend && renderer.backend.compatibilityMode; // older GPUs / APIs
  const integrated = /intel(?!.*(arc|xe-hpg))|iris|uhd graphics|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|apple/i.test(gpu);
  if (compat || integrated || cores <= 4) return 'medium';
  return 'high';
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export async function create(canvas, opts = {}) {
  const mark = (n) => performance.mark('sr:' + n);
  // let the page breathe between assembly stages so no main-thread task runs long
  const yieldTask = () => new Promise((r) => setTimeout(r, 0));
  mark('create');
  // three's WebGL2 backend creates its context without powerPreference (it matters on dual-GPU Macs), so the
  // context is made here: directly when WebGL is forced, and through the fallback hook when WebGPU is missing
  const glContext = () => canvas.getContext('webgl2', { antialias: false, alpha: true, depth: true, stencil: false, powerPreference: 'high-performance' });
  const params = {
    canvas, antialias: false, powerPreference: 'high-performance', forceWebGL: opts.backend === 'webgl',
    trackTimestamp: !(opts.bench && opts.backend === 'webgl'), // GPU time drives the quality controller
  };
  if (params.forceWebGL) params.context = glContext();
  const renderer = new THREE.WebGPURenderer(params);
  const fallback = renderer._getFallback; // private in r186; its WebGLBackend is built from `params`
  if (fallback) renderer._getFallback = (e) => { params.context = glContext(); return fallback(e); };
  await renderer.init();
  const backendName = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl';
  // on the WebGL2 fallback the bench probe runs its own timer queries (three's cannot time nested passes)
  if (backendName === 'webgl' && opts.bench) renderer.backend.trackTimestamp = false;
  const tierName = opts.quality || detectTier(renderer);
  const Q = { ...TIERS[tierName] };
  const ST = opts.stress || null; // bench-only future-content scenario
  const dpr = Math.min(window.devicePixelRatio || 1, Q.pr);
  renderer.setPixelRatio(dpr);
  renderer.toneMappingExposure = 1.0; // read by renderOutput() in the post pipeline
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // filter replaced below by the r170 PCFSoft equivalent
  const probe = opts.bench ? createGPUProbe(renderer) : null;
  // MSAA only on devices with full WebGPU features (three disables it in compatibility mode) and the tier's count
  const msaa = renderer.backend.isWebGPUBackend && renderer.backend.compatibilityMode ? 0 : (opts.msaa ?? Q.msaa);

  const scene = new THREE.Scene();
  scene.name = 'scene';
  scene.fogNode = sceneFog();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 9000);
  camera.layers.enable(1);

  // ---------- procedural generation (worker pool) ----------
  const world = createWorld(7);
  const Lay = layout(world);
  const { TX, TZ, LX, LZ } = Lay;
  const treePos = new THREE.Vector3(...Lay.tree);
  const focus = new THREE.Vector3(...Lay.focus);
  const triMul = ST ? ST.triMul : 1;
  const treeSpecs = [{ seed: 11, pos: Lay.tree, blossomScale: 1.0 }, ...Lay.small.map((sp) => ({ seed: 100 + sp.k * 13, small: true, pos: [sp.x, 0, sp.z], blossomScale: 1.05 }))];
  const { results: G, stats: genStats } = await runJobs({
    terrain: { name: 'terrain', args: { seg: Q.terrain } },
    heightCache: { name: 'heightCache' },
    depth: { name: 'depth', args: { tier: tierName } },
    river: { name: 'river' },
    treeMain: { name: 'trees', args: { list: treeSpecs.slice(0, 1), triMul } },
    treesA: { name: 'trees', args: { list: treeSpecs.slice(1, 4), triMul } },
    treesB: { name: 'trees', args: { list: treeSpecs.slice(4), triMul } },
    atlas: { name: 'atlas', args: { size: tierName === 'high' ? 2048 : 1024 } },
    bark: { name: 'bark' },
    fuji: { name: 'fuji' },
    props: { name: 'props', args: { triMul } },
    rocks: { name: 'rocks', args: { tier: tierName, triMul } },
    grass: { name: 'grass', args: { count: Q.grass * (ST ? ST.grass : 1), tier: tierName } },
    flowers: { name: 'flowers', args: { count: Q.flowers, tier: tierName } },
    forest: { name: 'forest', args: { count: Q.forest } },
    fallen: { name: 'fallen', args: { count: Q.fallen } },
  }, { mainThread: opts.workers === false });
  world.setHeightCache(G.heightCache);
  mark('generated');

  // ---------- terrain ----------
  const terrainGeo = G.terrain;
  const terrainMat = M.terrainMaterial();
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.receiveShadow = true;
  terrain.name = 'terrain';
  scene.add(terrain);

  // ---------- sky + lights ----------
  const sky = makeSky();
  sky.mesh.name = 'sky';
  scene.add(sky.mesh);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q.shadow, Q.shadow);
  const sc = sun.shadow.camera;
  sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 320;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0; // applied per receiver (SHADOW_NORMAL_BIAS in tsl.js)
  sun.shadow.filterNode = pcfSoftShadowFilter;
  sun.shadow.autoUpdate = false; // re-rendered on the frames the quality level asks for (see step)
  sun.shadow.camera.layers.set(0); sun.shadow.camera.layers.enable(2); // layer 2: shadow-only proxies
  scene.add(sun); scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xbcd0ff, 0x3a3a20, 0.9);
  scene.add(hemi);

  await yieldTask();
  // ---------- trees ----------
  const bark = barkTextures(G.bark);
  const atlas = atlasTexture(G.atlas);
  if (opts.debug) window.__sakuraDebug = { bark, atlas };
  const maxAniso = renderer.getMaxAnisotropy();
  atlas.anisotropy = Math.min(16, maxAniso); bark.map.anisotropy = Math.min(16, maxAniso); bark.bump.anisotropy = Math.min(8, maxAniso);
  const barkMat = M.barkMaterial(bark.map, bark.bump);
  const a2c = msaa > 0;
  const blossomMat = M.blossomMaterial(atlas, a2c);
  const blossomPrepass = opts.blossomPrepass !== false;
  const blossomDepthMat = blossomPrepass ? M.blossomDepthMaterial(atlas, a2c) : null;
  if (blossomPrepass) blossomMat.depthWrite = false;
  const blossomShadowMat = M.blossomShadowMaterial(atlas);
  const cardGeo = ST ? tessellate(buildBlossomCardGeometry(), ST.triMul) : buildBlossomCardGeometry();

  function buildTreeObject(d, pos, castShadow = true) {
    const group = new THREE.Group();
    group.position.copy(pos);
    const barkMesh = new THREE.Mesh(d.bark, barkMat);
    barkMesh.name = 'bark';
    barkMesh.castShadow = castShadow; barkMesh.receiveShadow = true;
    group.add(barkMesh);
    const geo = cardGeo.clone();
    const mesh = new THREE.InstancedMesh(geo, blossomMat, d.n);
    mesh.name = 'blossoms';
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(d.matrix, 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(d.color, 3);
    // one interleaved buffer for the per-card attributes (fewer vertex buffers; WebGPU guarantees only 8)
    const per = new Float32Array(d.n * 6);
    for (let i = 0; i < d.n; i++) {
      per[i * 6] = d.aFlex[i]; per[i * 6 + 1] = d.aAtlas[i * 2]; per[i * 6 + 2] = d.aAtlas[i * 2 + 1];
      per[i * 6 + 3] = d.aCanopyN[i * 3]; per[i * 6 + 4] = d.aCanopyN[i * 3 + 1]; per[i * 6 + 5] = d.aCanopyN[i * 3 + 2];
    }
    const ib = new THREE.InstancedInterleavedBuffer(per, 6);
    geo.setAttribute('aFlex', new THREE.InterleavedBufferAttribute(ib, 1, 0));
    geo.setAttribute('aAtlas', new THREE.InterleavedBufferAttribute(ib, 2, 1));
    geo.setAttribute('aCanopyN', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    mesh.receiveShadow = castShadow;
    mesh.computeBoundingSphere(); mesh.boundingSphere.radius += 2.5;
    group.add(mesh);
    if (blossomPrepass) {
      const pre = new THREE.InstancedMesh(geo, blossomDepthMat, d.n);
      pre.name = 'blossomDepth';
      pre.instanceMatrix = mesh.instanceMatrix;
      pre.boundingSphere = mesh.boundingSphere;
      pre.renderOrder = -1; // before every opaque draw
      group.add(pre);
    }
    if (castShadow) {
      // cast through a shadow-only proxy on layer 2 (see blossomShadowMaterial)
      const proxy = new THREE.InstancedMesh(geo, blossomShadowMat, d.n);
      proxy.instanceMatrix = mesh.instanceMatrix;
      proxy.boundingSphere = mesh.boundingSphere;
      proxy.castShadow = true;
      proxy.layers.set(2);
      group.add(proxy);
    }
    return { group, data: d, blossoms: mesh };
  }

  const main = buildTreeObject(G.treeMain[0], treePos, true);
  main.group.name = 'tree';
  scene.add(main.group);
  const smallTrees = [];
  const smallData = [...G.treesA, ...G.treesB];
  Lay.small.forEach((sp, k) => {
    const o = buildTreeObject(smallData[k], new THREE.Vector3(sp.x, 0, sp.z), Math.abs(sp.z) < 45);
    o.group.scale.setScalar(sp.s);
    o.group.name = 'smallTree';
    o.group.position.y += (1 - sp.s) * 0.2;
    scene.add(o.group);
    smallTrees.push(o);
  });

  await yieldTask();
  // ---------- Japanese set pieces ----------
  const fuji = makeFuji(G.fuji, M.fujiMaterial());
  fuji.name = 'fuji';
  scene.add(fuji);
  const lantern = makeLantern(world, G.props.lantern, LX, LZ, 0.3, { stone: M.propMaterial('stone'), core: M.lanternCoreMaterial() });
  lantern.group.name = 'lantern';
  scene.add(lantern.group);
  const bridge = makeBridge(G.props.bridge, M.propMaterial('wood', { roughness: 0.55 }));
  bridge.mesh.name = 'bridge';
  scene.add(bridge.mesh);
  const pagoda = makePagoda(world, G.props.pagoda, world.pagoda.x, world.pagoda.z, 1.0, M.propMaterial('pagoda', { roughness: 0.7 }));
  pagoda.name = 'pagoda';
  scene.add(pagoda);

  await yieldTask();
  // ---------- ground cover ----------
  const rocks = makeRocks(G.rocks, M.rockMaterial());
  rocks.group.name = 'rocks';
  scene.add(rocks.group);
  const grass = makeGrass(G.grass, M.grassMaterial());
  grass.name = 'grass';
  scene.add(grass);
  const flowers = makeFlowers(G.flowers, M.flowerMaterial());
  flowers.name = 'flowers';
  scene.add(flowers);
  const forest = makeForest(G.forest, M.forestMaterial());
  forest.name = 'forest';
  scene.add(forest);

  await yieldTask();
  // ---------- river ----------
  const depthMap = depthTexture(G.depth);
  // reflection buffer per CSS pixel above DPR 1.4 (0.35 at DPR 2 passes against sub-pixel A/A, 0.25 does not;
  // bench/dpr_parity.py); the light shafts are per CSS pixel at every DPR (see buildPipeline below)
  const water = makeWater(G.river, depthMap, sky, { reflectionScale: opts.reflScale ?? Q.refl * Math.min(1, 1.4 / dpr) });
  water.mesh.name = 'water';
  scene.add(water.mesh);
  const reflector = water.reflector ? water.reflector.reflector : null;
  if (reflector) {
    // the old planar reflection rendered layer 0 only (no grass, flowers, petals, motes)
    reflector.getVirtualCamera(camera).layers.set(0);
    // quality ladder can skip reflection frames
    const upd = reflector.updateBefore.bind(reflector);
    reflector.updateBefore = (frame) => (reflSkip ? false : upd(frame));
  }
  let reflSkip = false;

  // ---------- petals ----------
  const sp3 = main.data.spawn, spawnPts = [];
  for (let i = 0; i < sp3.length; i += 3) spawnPts.push(new THREE.Vector3(sp3[i], sp3[i + 1], sp3[i + 2]).add(treePos));
  const petalMat = petalMaterial();
  const petals = new PetalSystem(world, spawnPts, Q.petals, camera, petalMat, U.uWindDir.value);
  petals.mesh.name = 'petals';
  scene.add(petals.mesh);
  const fallen = makeFallenPetals(G.fallen, petalMat);
  fallen.name = 'fallenPetals';
  scene.add(fallen);
  const motes = makeMotes(new THREE.Vector3(...Lay.motes), Q.motes);
  motes.mesh.name = 'motes';
  scene.add(motes.mesh);
  if (ST) {
    scene.add(makeStressObjects(world, ST.objects, focus, M.stressObjectMaterial));
    scene.add(makeRain(ST.particles, rainMaterial()));
  }

  for (const n of opts.hide || []) scene.getObjectsByProperty('name', n).forEach((o) => { o.visible = false; }); // bench: isolate objects
  mark('assembled');
  await yieldTask();
  // ---------- post ----------
  // light shafts per CSS pixel: 0.25 of the drawing buffer at DPR 2 is ~7x below sub-pixel A/A noise (dpr_parity)
  const post = buildPipeline(renderer, scene, camera, { raySamples: Q.rays, msaa, shaftScale: opts.shaftScale ?? 0.5 / dpr });
  const rays = post.shafts.uniforms;

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
    rays.tint.value.copy(st.sun).lerp(new THREE.Color(1, 0.9, 0.8), 0.3);
    renderer.toneMappingExposure = lerp(1.35, 0.98, st.vis) * (st.elev > 30 ? 0.92 : 1);
    lastTime = t;
    return st;
  }
  let skyNow = applyTimeOfDay(S.time);

  // ---------- sizing / adaptive quality ----------
  let W = 1, H = 1;
  let pixelScale = 1; // adaptive render scale without temporal upscaling: the canvas resolution itself
  function resize() {
    const w = Math.max(1, canvas.clientWidth | 0), h = Math.max(1, canvas.clientHeight | 0);
    W = w; H = h;
    const pr = dpr * pixelScale;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const g = post.grade.uniforms;
    renderer.getDrawingBufferSize(g.res.value);
    post.bloom.setSize(g.res.value.x, g.res.value.y);
    g.sharp.value = pr >= 1.75 ? 0.3 : pr >= 1.2 ? 0.45 : 0.6;
    rays.aspect.value = w / h;
    motes.uPx.value = pr * (h / 900) * 1.3;
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvas);
  resize();

  // ---------- adaptive quality: GPU time -> render resolution, then second-order settings ----------
  let frames = 0, acc = 0, statT = 0, fpsShown = 60;
  // wind-animated shadows and the reflection update at 30 Hz (the visual gate's wind and camera sequences pass)
  const shadowEvery0 = opts.shadowEvery ?? 2, reflEvery0 = opts.reflEvery ?? 2;
  let shadowEvery = shadowEvery0, reflEvery = reflEvery0;
  // the canvas resolution scales (the browser upscales it) and every effect buffer follows the drawing buffer
  const reflBase = reflector ? reflector.resolutionScale : 0;
  // GPU timer queries where available (three leaves trackTimestamp on for WebGL without the timer extension);
  // otherwise frame time, which vsync caps at the refresh interval: over budget then means clearly slower than a
  // 60 Hz frame (like the old ladder's 21 ms), and it never reads a capped 16.7 ms frame as overload
  const gpuTimed = renderer.backend.isWebGLBackend ? !!renderer.backend.disjoint : !!renderer.backend.trackTimestamp;
  const qc = new QualityController({
    targetMs: opts.targetMs ?? (gpuTimed ? 14 : 19), // ~85% of a 60 Hz frame of GPU time
    minScale: opts.minScale ?? 0.6, maxScale: 1,
    levels: [
      { apply() { if (reflector) reflector.resolutionScale = reflBase * 0.7; }, revert() { if (reflector) reflector.resolutionScale = reflBase; } },
      { apply() { grass.userData.setFraction(0.7); }, revert() { grass.userData.setFraction(1); } },
      { apply() { reflEvery = 1e9; grass.userData.setFraction(0.5); }, revert() { reflEvery = reflEvery0; grass.userData.setFraction(0.7); } },
    ],
    onChange: ({ scale }) => { pixelScale = scale; resize(); },
  });
  let resolving = false;
  function feedGpuTime(frameMs) {
    if (probe) {
      for (const f of probe.poll()) {
        if (!opts.fixedQuality) qc.update(f.total, f.frame);
      }
    } else if (gpuTimed) {
      // one resolve in flight at a time: it reports the last complete frame, and a pending call would repeat it
      if (resolving) return;
      resolving = true;
      renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER).then((ms) => {
        resolving = false;
        const pool = renderer.backend.timestampQueryPool[THREE.TimestampQuery.RENDER]; // frame ids of that resolve
        const fr = pool && pool.frames && pool.frames.length ? pool.frames[pool.frames.length - 1] : Infinity;
        if (!opts.fixedQuality && ms > 0) qc.update(ms, fr);
      });
    } else if (!opts.fixedQuality) qc.update(frameMs); // no timer queries: frame time (capped by vsync) is the best we have
  }
  let adaptFrom = 0;
  function adapt(dt) {
    // stay out of the first 1.5 s: pipeline compilation hitches would read as an overloaded GPU
    if (!adaptFrom) adaptFrom = performance.now() + 1500;
    if (performance.now() < adaptFrom) return;
    feedGpuTime(dt * 1000);
    frames++; acc += dt; statT += dt;
    if (statT >= 1) {
      fpsShown = Math.round(1000 / ((acc / frames) * 1000));
      opts.onStats && opts.onStats({ fps: fpsShown, quality: tierName, level: qc.level, scale: qc.scale });
      frames = 0; acc = 0; statT = 0;
    }
  }

  // ---------- loop ----------
  const timer = new THREE.Timer();
  const tmpV = new THREE.Vector3();
  let running = true;
  let frameNo = 0;
  const sunScreen = new THREE.Vector3();
  const tmpSize = new THREE.Vector2();

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
    post.bloom.uniforms.strength.value = S.bloom * 1.6;
    post.grade.uniforms.time.value = U.uTime.value;

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
    // uv of the sun in the post passes: three's fullscreen quad runs uv.y top-down on both backends
    rays.sun.value.set(sunScreen.x * 0.5 + 0.5, 0.5 - sunScreen.y * 0.5);
    rays.intensity.value = facing * onScreen * U.uSunVis.value * (0.55 + S.fog * 0.9) * (opts.rays ?? 1);
    post.shafts.setEnabled(rays.intensity.value > 0.001);

    // reflections
    if (!doRender) return;
    frameNo++;
    if (probe) probe.beginFrame();
    sun.shadow.needsUpdate = frameNo % shadowEvery === 0 || frameNo < 3;
    // the reflector skips when the camera is below the water plane; fall back to the analytic sky then
    reflSkip = !(frameNo % reflEvery === 0 || frameNo < 3);
    water.uniforms.uHasRefl.value = reflector && reflEvery < 1e9 && camera.position.y > 0.02 ? 1 : 0;
    // bench-only: sub-pixel view offset, the A/A calibration for sample-placement differences between backends
    if (opts.jitter) { const b = renderer.getDrawingBufferSize(tmpSize); camera.setViewOffset(b.x, b.y, opts.jitter[0], opts.jitter[1], b.x, b.y); }
    post.pipeline.render();
    qc.frame = probe ? probe.frame : renderer.info.frame; // frame ids as the GPU timings report them
    if (opts.jitter) camera.clearViewOffset();
    if (probe) probe.endFrame();
  }

  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    timer.update();
    const dt = timer.getDelta();
    step(dt);
    adapt(dt);
  }
  // build pipelines behind the veil (asynchronously on WebGPU)
  mark('ready');
  if (opts.precompile !== false) await renderer.compileAsync(scene, camera);
  mark('precompiled');
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
    hashScene: () => hashScene(scene, { heightCache: world.heightCacheData() }),
    // bench: triangles per drawable (instances included), largest first
    meshStats() {
      const out = [];
      scene.traverse((o) => {
        if (!o.isMesh && !o.isPoints && !o.isSprite) return;
        const g = o.geometry; if (!g) return;
        const tri = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
        const n = o.isInstancedMesh ? o.count : g.isInstancedBufferGeometry ? g.instanceCount : 1;
        let a = o; while (a && !a.name) a = a.parent;
        out.push({ name: a && a !== scene ? a.name : o.material.type, layers: o.layers.mask, shadow: o.castShadow, tri, n, total: tri * n });
      });
      return out.sort((a, b) => b.total - a.total);
    },
    qualityState() { return { tier: tierName, level: qc.level, scale: qc.scale, fps: fpsShown, gpuMs: qc.lastMs }; },
    setAdaptive(on) { opts.fixedQuality = !on; },
    step(dt) { step(dt); },
    tick(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt); },
    simulate(sec, dt = 1 / 30) { for (let t = 0; t < sec; t += dt) step(dt, false); },
    backend: backendName,
    info() { return { tier: tierName, backend: backendName, tree: [TX, TZ], blossoms: main.data.n, gen: genStats, grass: grass.userData.total, verts: terrainGeo.attributes.position.count, calls: renderer.info.render.calls, tris: renderer.info.render.triangles }; },
    dispose() { running = false; ro.disconnect(); controls.dispose(); renderer.dispose(); },
  };
}

if (typeof window !== 'undefined') window.SakuraRiver = { create };
