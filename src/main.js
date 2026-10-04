// Sakura River — cinematic procedural scene engine
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { createWorld, depthTexture } from './world.js';
import { U, sceneFog, pcfSoftShadowFilter, setLightMap } from './tsl.js';
import { makeFarShadow, FAR_LAYER, CLOUDS } from './sunshadow.js';
import { lightMap, lamp } from './lights.js';
import { buildFlowerGeometry, atlasTexture, barkTextures, MAIN_TREE } from './tree.js';
import { makeTurf, makeFlowers, SHRUB_KINDS, ROCK_KINDS, FOREST_KINDS, CLIFF_KINDS, BAMBOO_KINDS } from './vegetation.js';
import { makeLods, makeMerged, makeView, loadModel, ultraUrl } from './lods.js';
import { makeGrass } from './grass.js';
import { bakeImpostors, makeImpostors } from './impostors.js';
import { nearBlossoms } from './blossoms.js';
import forestUrl from './models/forest.glb?url&inline';
import cliffsUrl from './models/cliffs.glb?url&inline';
import bambooUrl from './models/bamboo.glb?url&inline';
import rocksUrl from './models/rocks.glb?url&inline';
import cherryUrl from './models/cherry.glb?url&inline';
import villageUrl from './models/village.glb?url&inline';
import shrubsUrl from './models/shrubs.glb?url&inline';
import lampsUrl from './models/lamps.glb?url&inline';
import boatUrl from './models/boat.glb?url&inline';
import { makeBoats } from './boat.js';
import { LAMP_KINDS } from './lanterns.js';
import { VILLAGE_KINDS } from './village.js';
import { makeSky, skyState, moonState, uStarPx } from './sky.js';
import { makeWater, makeMist } from './water.js';
import { PetalSystem, makeFallenPetals } from './petals.js';
import { makeGpuPetals } from './petalsgpu.js';
import { petalMaterial, makeMotes, makeLanterns, makeGlows, makeFires, makeSmoke, makeSparks } from './fx.js';
import { fireflyData, makeFireflies } from './fireflies.js';
import { WEATHERS, WEATHER_KEYS, hourToT, tToHour, overcast, makeRain, makeLightning } from './weather.js';
import { buildPipeline } from './post.js';
import { clamp, lerp, smoothstep } from './noise.js';
import { makeBridge, makeFuji } from './props.js';
import { makeTemple } from './temple.js';
import { makeKoi, koiClearing } from './koi.js';
import { makeBirds } from './birds.js';
import { makeButterflies } from './butterflies.js';
import { makeDeer } from './deer.js';
import { makeHerons } from './heron.js';
import * as M from './materials.js';
import { createGPUProbe } from './bench-probe-gpu.js';
import { QualityController } from './quality.js';
import { hashScene } from './bench-hash.js';
import { tessellate, makeStressObjects } from './stress.js';
import { runJobs } from './gen/pool.js';
import { layout, treeSpecs } from './gen/layout.js';
import { createSound } from './audio.js';
import { makeWalk, WALK } from './walk.js';
import waysideUrl from './models/wayside.glb?url&inline';
import { WAYSIDE_KINDS } from './wayside.js';

// pr: cap on the device pixel ratio; ss: the scene's render scale over the drawing buffer (supersampling, resolved by
// the post chain's downsample, post.js); lodScale: the model LODs' and the impostors' switch distances multiplied
// (lods.js); nearModels: extra near-detail models (lods.js). Ultra is only ever picked by hand (detectTier never
// returns it): it ignores the frame budget and is sized for ~4 GB of GPU memory at 1080p.
const TIERS = {
  ultra: { pr: 3, ss: 1.5, terrain: [600, 630], turf: 4500, flowers: 4000, petals: 5400, fallen: 5600, motes: 800, fireflies: 900, shadow: 8192, far: 8192, impostorCell: 192, refl: 1, msaa: 4, rays: 64, forest: 2600, bloomRes: 1, koi: 16, rain: 36000, near: 9, atlas: 2048, lodScale: 1.7, nearModels: true },
  high: { pr: 2.0, ss: 1, terrain: [420, 440], turf: 2900, flowers: 2600, petals: 3600, fallen: 3800, motes: 500, fireflies: 650, shadow: 4096, far: 4096, impostorCell: 128, refl: 0.5, msaa: 4, rays: 48, forest: 2600, bloomRes: 1, koi: 12, rain: 24000, near: 5, atlas: 1024, lodScale: 1, nearModels: false },
  medium: { pr: 1.5, ss: 1, terrain: [300, 320], turf: 2000, flowers: 1500, petals: 2200, fallen: 2400, motes: 300, fireflies: 400, shadow: 2048, far: 2048, impostorCell: 96, refl: 0.4, msaa: 2, rays: 36, forest: 1850, bloomRes: 0.75, koi: 10, rain: 14000, near: 4, atlas: 512, lodScale: 1, nearModels: false },
  low: { pr: 1.25, ss: 1, terrain: [210, 230], turf: 800, flowers: 700, petals: 1100, fallen: 1300, motes: 150, fireflies: 200, shadow: 1024, far: 1024, impostorCell: 64, refl: 0, msaa: 0, rays: 24, forest: 1100, bloomRes: 0.5, koi: 6, rain: 7000, near: 0, atlas: 512, lodScale: 1, nearModels: false },
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
  const integrated = /intel(?!.*(arc|xe\d?-hpg))|iris|uhd graphics|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|apple|arm|qualcomm|adreno|mali/i.test(gpu);
  if (compat || integrated || cores <= 4) return 'medium';
  return 'high';
}

const IMPOSTOR_FROM = 140; // the woods' full models (and leaf cards) to here, impostors beyond (times the tier's lodScale)
const NEAR_RANGE = 30; // the Ultra tier's near models (lods.js) to here (nearer for the pebbles and the bamboo: nearOf)
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
    // GPU time drives the quality controller (not needed at a fixed quality outside the bench)
    trackTimestamp: opts.bench ? opts.backend !== 'webgl' : !opts.fixedQuality,
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
  // MSAA: none on WebGPU compatibility-mode devices (three disables it there); WebGPU has only 1 or 4 samples, so
  // a tier's 2x becomes 4x there (with fewer, the blossoms' alpha-to-coverage would have no coverage to work with)
  const compat = renderer.backend.isWebGPUBackend && renderer.backend.compatibilityMode;
  const msaaWanted = opts.msaa ?? Q.msaa;
  const msaa = compat ? 0 : renderer.backend.isWebGPUBackend && msaaWanted > 0 ? 4 : msaaWanted;
  // Android WebGPU in compatibility mode cannot sample the shadow map as three binds it there (no comparison
  // sampling on Android): render without shadows rather than a broken frame
  if (compat && /Android/i.test(navigator.userAgent || '')) renderer.shadowMap.enabled = false;
  // largest drawing buffer the device allows (4096 on compatibility-mode devices, 8192 core, varies on WebGL)
  const maxTex = renderer.backend.isWebGPUBackend ? renderer.backend.device.limits.maxTextureDimension2D
    : Math.min(renderer.backend.gl.getParameter(renderer.backend.gl.MAX_TEXTURE_SIZE), renderer.backend.gl.getParameter(renderer.backend.gl.MAX_RENDERBUFFER_SIZE));

  const scene = new THREE.Scene();
  scene.name = 'scene';
  scene.fogNode = sceneFog();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 9000);
  camera.layers.enable(1);

  // ---------- procedural generation (worker pool) ----------
  const world = createWorld(7);
  const Lay = layout(world);
  const { TX, TZ } = Lay;
  const treePos = new THREE.Vector3(...Lay.tree);
  const focus = new THREE.Vector3(...Lay.focus);
  const triMul = ST ? ST.triMul : 1;
  const trees = treeSpecs(Lay);
  const fieldJobs = [[], [], []], area = [0, 0, 0];
  world.ZONES.map((Z, i) => ({ i, a: (Z.box[2] - Z.box[0]) * (Z.box[3] - Z.box[1]) })).sort((p, q) => q.a - p.a).forEach(({ i, a }) => {
    const k = area.indexOf(Math.min(...area));
    fieldJobs[k].push(i); area[k] += a;
  });
  const { results: G, stats: genStats } = await runJobs({
    terrain: { name: 'terrain', args: { seg: Q.terrain } },
    // the farmland and village mesh in three jobs that run at once, its zones shared out by area
    ...Object.fromEntries(fieldJobs.map((zones, k) => [`fields${k}`, { name: 'fields', args: { zones } }])),
    village: { name: 'village' },
    shrubs: { name: 'shrubs' },
    heightCache: { name: 'heightCache' },
    depth: { name: 'depth', args: { tier: tierName } },
    river: { name: 'river' },
    treeMain: { name: 'trees', args: { list: trees.slice(0, 1), tier: tierName, triMul } },
    treesA: { name: 'trees', args: { list: trees.slice(1, 4), tier: tierName, triMul } },
    treesB: { name: 'trees', args: { list: trees.slice(4), tier: tierName, triMul } },
    atlas: { name: 'atlas', args: { size: Q.atlas } },
    leafAtlas: { name: 'leafAtlas', args: { size: Q.atlas } },
    bark: { name: 'bark' },
    fuji: { name: 'fuji' },
    props: { name: 'props', args: { triMul } },
    lanterns: { name: 'lanterns', args: { tier: tierName } },
    rocks: { name: 'rocks', args: { tier: tierName } },
    grassMask: { name: 'grassMask', args: { tier: tierName } },
    turf: { name: 'turf', args: { count: Q.turf * (ST ? ST.grass : 1) } },
    flowers: { name: 'flowers', args: { count: Q.flowers, tier: tierName } },
    forest: { name: 'forest', args: { count: Q.forest } },
    cliffs: { name: 'cliffs' },
    bamboo: { name: 'bamboo' },
    fallen: { name: 'fallen', args: { count: Q.fallen } },
    rafts: { name: 'rafts', args: { count: Math.round(Q.fallen * 1.2), tier: tierName } },
  }, { mainThread: opts.workers === false });
  world.setHeightCache(G.heightCache);
  mark('generated');

  // ---------- sky + terrain ----------
  const sky = makeSky();
  sky.mesh.name = 'sky';
  scene.add(sky.mesh);
  const terrainGeo = G.terrain.geo;
  const terrain = new THREE.Mesh(terrainGeo, M.terrainMaterial({ sky, lanes: world.LANES }));
  terrain.receiveShadow = true;
  terrain.name = 'terrain';
  scene.add(terrain);

  // ---------- lights ----------
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  const shadowSize = Math.min(Q.shadow, maxTex);
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  const sc = sun.shadow.camera;
  sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 320;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0; // applied per receiver (SHADOW_NORMAL_BIAS in tsl.js)
  sun.shadow.filterNode = pcfSoftShadowFilter;
  sun.shadow.autoUpdate = false; // re-rendered on the frames the quality level asks for (see step)
  sun.shadow.camera.layers.set(0); sun.shadow.camera.layers.enable(2); // layer 2: shadow-only proxies
  scene.add(sun); scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xbcd0ff, 0x3a3a20, 0.9);
  scene.add(hemi);
  // the village's farmland: rice paddies, flooded or dry, terraced up the slopes (world.js buildFields)
  const fieldParts = fieldJobs.map((_, k) => G[`fields${k}`]);
  const fields = new THREE.Mesh(mergeGeometries(fieldParts.map((f) => f.geo)), M.terrainMaterial({ sky, paddies: true, lanes: world.LANES }));
  fields.receiveShadow = true;
  fields.name = 'fields';
  scene.add(fields);

  await yieldTask();
  // ---------- trees ----------
  const bark = barkTextures(G.bark);
  const atlas = atlasTexture(G.atlas);
  if (opts.debug) window.__sakuraDebug = { bark, atlas };
  const maxAniso = renderer.getMaxAnisotropy();
  const aniso = (n) => Math.min(tierName === 'ultra' ? 16 : n, maxAniso); // ultra: the most the device filters
  atlas.anisotropy = aniso(16); bark.map.anisotropy = aniso(16); bark.bump.anisotropy = aniso(8);
  const barkMat = M.barkMaterial(bark.map, bark.bump);
  const a2c = msaa > 0;
  const blossomMat = M.blossomMaterial(atlas, a2c);
  const blossomPrepass = opts.blossomPrepass !== false;
  const blossomDepthMat = blossomPrepass ? M.blossomDepthMaterial(atlas, a2c) : null;
  if (blossomPrepass) blossomMat.depthWrite = false;
  const blossomShadowMat = M.blossomShadowMaterial(atlas);
  const flowerGeo = ST ? tessellate(buildFlowerGeometry(), ST.triMul) : buildFlowerGeometry();

  // the trunks and main branches and the flower drawn near the camera, modelled in Blender (tools/cherry.py),
  // unpacked from the quantized glTF to plain floats in the tree's frame
  const cherry = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(cherryUrl);
  cherry.scene.updateMatrixWorld(true);
  function unpacked(src) {
    const g = src.geometry, n = g.attributes.position.count, t = new THREE.BufferGeometry();
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3), C = new Float32Array(n * 3);
    const v = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(src.matrixWorld);
    const { position, normal, color } = g.attributes;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(src.matrixWorld).toArray(P, i * 3);
      v.fromBufferAttribute(normal, i).applyMatrix3(nm).normalize().toArray(N, i * 3);
      C[i * 3] = color.getX(i); C[i * 3 + 1] = color.getY(i); C[i * 3 + 2] = color.getZ(i);
    }
    t.setAttribute('position', new THREE.BufferAttribute(P, 3));
    t.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    t.setAttribute('color', new THREE.BufferAttribute(C, 3));
    t.setIndex(Array.from(g.index.array));
    return t;
  }
  // a trunk merged with its tree's twigs, in their layout: texture coordinates times cherry.py's UV_SCALE, the
  // wind's flexibility from the colours' alpha
  function withTrunk(d, k) {
    const src = cherry.scene.getObjectByName(`trunk${k}`), t = unpacked(src), { uv, color } = src.geometry.attributes, n = uv.count;
    if (src.userData.sig !== d.sig) console.warn(`src/models/cherry.glb was built for other branches (tree ${k}): run node tools/blender.mjs cherry`);
    const UV = new Float32Array(n * 2), F = new Float32Array(n);
    for (let i = 0; i < n; i++) { UV[i * 2] = uv.getX(i) * 16; UV[i * 2 + 1] = uv.getY(i) * 16; F[i] = color.getW(i) * 2; }
    t.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    t.setAttribute('aFlex', new THREE.BufferAttribute(F, 1));
    const merged = mergeGeometries([t, d.bark]);
    merged.computeBoundingSphere();
    return merged;
  }

  function buildTreeObject(d, pos, castShadow = true) {
    const group = new THREE.Group();
    group.position.copy(pos);
    const barkMesh = new THREE.Mesh(d.bark, barkMat);
    barkMesh.name = 'bark';
    barkMesh.castShadow = castShadow; barkMesh.receiveShadow = true;
    group.add(barkMesh);
    const geo = flowerGeo.clone();
    const mesh = new THREE.InstancedMesh(geo, blossomMat, d.n);
    mesh.name = 'blossoms';
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(d.matrix, 16);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(d.color, 3);
    // one interleaved buffer for the per-flower attributes (fewer vertex buffers; WebGPU guarantees only 8)
    const ib = new THREE.InstancedInterleavedBuffer(d.attrs, 6);
    geo.setAttribute('aFlex', new THREE.InterleavedBufferAttribute(ib, 1, 0));
    geo.setAttribute('aAtlas', new THREE.InterleavedBufferAttribute(ib, 2, 1));
    geo.setAttribute('aCanopyN', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    mesh.receiveShadow = castShadow;
    mesh.computeBoundingSphere(); mesh.boundingSphere.radius += 2.5;
    group.add(mesh);
    let pre = null;
    if (blossomPrepass) {
      pre = new THREE.InstancedMesh(geo, blossomDepthMat, d.n);
      pre.name = 'blossomDepth';
      pre.instanceMatrix = mesh.instanceMatrix;
      pre.boundingSphere = mesh.boundingSphere;
      pre.renderOrder = -1; // before every opaque draw
      group.add(pre);
    }
    if (castShadow) {
      // cast through a shadow-only proxy on layer 2 (see blossomShadowMaterial), every flower: the cards' own
      // buffers give the near ones up to the modelled flower (src/blossoms.js)
      const pg = flowerGeo.clone(), pb = new THREE.InstancedInterleavedBuffer(d.attrs.slice(), 6);
      pg.setAttribute('aFlex', new THREE.InterleavedBufferAttribute(pb, 1, 0));
      pg.setAttribute('aAtlas', new THREE.InterleavedBufferAttribute(pb, 2, 1));
      const proxy = new THREE.InstancedMesh(pg, blossomShadowMat, d.n);
      proxy.instanceMatrix = new THREE.InstancedBufferAttribute(d.matrix.slice(), 16);
      proxy.boundingSphere = mesh.boundingSphere;
      proxy.castShadow = true;
      proxy.layers.set(2);
      group.add(proxy);
    }
    return { group, data: d, blossoms: mesh, pre };
  }

  G.treeMain[0].bark = withTrunk(G.treeMain[0], 0);
  const main = buildTreeObject(G.treeMain[0], treePos, true);
  main.group.name = 'tree';
  scene.add(main.group);
  const nearFlowers = Q.near ? nearBlossoms(main, unpacked(cherry.scene.getObjectByName('flower')), M.blossomModelMaterial(), Q.near) : null;
  const smallTrees = [];
  const smallData = [...G.treesA, ...G.treesB];
  Lay.small.forEach((sp, k) => {
    smallData[k].bark = withTrunk(smallData[k], k + 1);
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
  // the bridge's lanterns and the farmhouses' door lanterns join the riverside ones (one instanced draw)
  const lampSets = [G.lanterns, G.props.bridge.lamps, G.village.lamps];
  const cat = (k) => { const out = new Float32Array(lampSets.reduce((n, d) => n + d[k].length, 0)); let o = 0; for (const d of lampSets) { out.set(d[k], o); o += d[k].length; } return out; };
  const lanterns = makeLanterns({ ...G.lanterns, hang: cat('hang'), look: cat('look'), n: lampSets.reduce((n, d) => n + d.n, 0) }, G.lanterns.lantern);
  lanterns.group.name = 'lanterns';
  scene.add(lanterns.group);
  const bridge = makeBridge(G.props.bridge, M.bridgeMaterial(G.props.bridge.lamps.hang));
  bridge.mesh.name = 'bridge';
  scene.add(bridge.mesh);
  const temple = makeTemple(G.props.temple, M.templeMaterial(G.props.temple));
  temple.name = 'temple';
  scene.add(temple);
  // the stone lanterns up the temple's approach; their glows with the temple's
  const toro = new THREE.Mesh(G.village.toro.geo, M.stoneLanternMaterial());
  toro.name = 'toro';
  scene.add(toro);
  const fixed = new Float32Array([...G.props.temple.lamps, ...G.village.toro.lamps]);
  const templeGlows = makeGlows(new Float32Array([...fixed, ...G.lanterns.bonbori]), lanterns.uFocal);
  templeGlows.name = 'templeGlows';
  scene.add(templeGlows);
  // the Blender models' levels of detail (lods.js): on the Ultra tier they reach further (lodScale) and, near the
  // camera, far more detailed models take over (tools/<name>.py's `_near` meshes, fetched from public/models/)
  const lodScale = opts.lodScale ?? Q.lodScale; // (opts: the bench's, to try them on any tier)
  // (the pebbles are 5 cm stones, and a grove has dozens of stands within 30 m: their near models only close by)
  const nearOf = (name, range = NEAR_RANGE) => ((opts.nearModels ?? Q.nearModels) ? { nearUrl: ultraUrl(name), nearRange: range } : {});
  // (all their files fetched at once, not one after another as the groups below are built)
  for (const n of ['lamps', 'rocks', 'forest', 'cliffs', 'bamboo', 'shrubs', 'village']) if (nearOf(n).nearUrl) loadModel(ultraUrl(n)).catch(() => {});
  // the lantern lines' posts, the bonbori along the banks, the fire baskets by the cherry tree; the flames, their
  // glows (from the flames' middle) and their flickering light (tsl.js lanternLight)
  const lamps = await makeLods(lampsUrl, LAMP_KINDS, G.lanterns.lists, M.lampMaterial(), [60], { lodScale, ...nearOf('lamps') });
  lamps.name = 'lamps';
  lamps.traverse((o) => { o.castShadow = o.isMesh; });
  scene.add(lamps);
  // the river boats (boat.js): one moored below the cherry tree, rocking at its rope, one pulled up above the bridge
  const boats = await makeBoats(boatUrl, world, { rocks: G.rocks.blockers, lamps: G.lanterns.bonbori, rafts: G.rafts });
  scene.add(boats.group);
  const fires = makeFires(G.lanterns.fires);
  fires.name = 'fires';
  scene.add(fires);
  const sparks = makeSparks(G.lanterns.fires);
  sparks.name = 'sparks';
  scene.add(sparks);
  const smoke = makeSmoke(G.village.smoke);
  smoke.mesh.name = 'smoke';
  scene.add(smoke.mesh);
  const fireAt = (i) => new THREE.Vector3(...G.lanterns.fires.subarray(i * 3, i * 3 + 3)).add(new THREE.Vector3(0, 0.5, 0));
  U.uFireA.value.copy(fireAt(0)); U.uFireB.value.copy(fireAt(1));
  const fireGlows = makeGlows(new Float32Array([...fireAt(0).toArray(), ...fireAt(1).toArray()]), lanterns.uFocal, 4.5, 0.22);
  fireGlows.name = 'fireGlows';
  scene.add(fireGlows);
  // all the lamps' light on what is near them (tsl.js lanternLight): paper lanterns (the hang point; the paper's
  // middle 0.36 below), the stone lanterns' and the temple's fireboxes, the bonbori, the shoji's light on the yards
  const pts = (a, f) => { const out = []; for (let i = 0; i < a.length; i += 3) out.push(f(a[i], a[i + 1], a[i + 2])); return out; };
  setLightMap(lightMap([
    ...pts(cat('hang'), (x, y, z) => lamp(x, y - 0.36, z, 0.2, 3)),
    ...pts(fixed, (x, y, z) => lamp(x, y, z, 0.3, 2.4)),
    ...pts(G.lanterns.bonbori, (x, y, z) => lamp(x, y, z, 0.32, 3.2)),
    ...pts(G.village.spill, (x, y, z) => lamp(x, y, z, 0.12, 3.5)),
  ]));

  await yieldTask();
  // ---------- ground cover ----------
  // boulders near and far, cast shadows; the stones at the water's edge in one level, no shadow
  const rockMat = M.rockMaterial();
  const rocks = await makeLods(rocksUrl, ROCK_KINDS, G.rocks.boulders, rockMat, [45], { lodScale, ...nearOf('rocks') });
  const pebbles = await makeLods(rocksUrl, ['pebble'], [G.rocks.pebbles], rockMat, [], { lodScale, ...nearOf('rocks', 8) });
  // the village's stone walls: merged, a group per few farmhouses (layer 1: far from the river, never in its reflection)
  const walls = await makeMerged(rocksUrl, 'pebble', G.rocks.walls, rockMat, 70, lodScale);
  walls.traverse((o) => { if (o.isMesh) o.layers.set(1); });
  walls.name = 'stoneWalls';
  scene.add(walls);
  rocks.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  pebbles.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  rocks.name = 'rocks'; pebbles.name = 'pebbles';
  scene.add(rocks, pebbles);
  const grass = makeGrass({ ...G.terrain, mask: G.grassMask, fields: fieldParts.flatMap((f) => f.grids) }, tierName);
  grass.name = 'grass';
  scene.add(grass);
  const turf = makeTurf(G.turf, M.grassMaterial());
  turf.name = 'turf';
  scene.add(turf);
  const flowers = makeFlowers(G.flowers, M.flowerMaterial());
  flowers.name = 'flowers';
  scene.add(flowers);
  const leafAtlas = atlasTexture(G.leafAtlas);
  leafAtlas.colorSpace = THREE.NoColorSpace; // painted near white as a shade, not a colour
  leafAtlas.anisotropy = aniso(8);
  // beyond IMPOSTOR_FROM metres the woods' trees are impostors (impostors.js), baked from their full models now
  const impostor = {
    from: 1,
    make: (gltf) => {
      const part = (name, leaf) => { const o = gltf.scene.getObjectByName(name); return { geometry: o.geometry, matrix: o.matrixWorld, leaf }; };
      const bake = bakeImpostors(renderer, FOREST_KINDS.map((k) => [part(k, false), part(k + '_leaves', true)]), leafAtlas, Q.impostorCell);
      return makeImpostors(bake, G.forest.reduce((n, l) => n + l.n, 0), { alphaToCoverage: a2c });
    },
  };
  const impostorFrom = opts.impostorFrom ?? IMPOSTOR_FROM; // (times lodScale, as every range: makeLods)
  const leavesMat = M.forestMaterial({ leaves: leafAtlas, alphaToCoverage: a2c, impostorFrom: impostorFrom * lodScale });
  const forest = await makeLods(forestUrl, FOREST_KINDS, G.forest, M.forestMaterial(), [impostorFrom, 260], { leavesMat, impostor, lodScale, ...nearOf('forest') });
  forest.name = 'forest';
  if (opts.debug) window.__sakuraDebug = { ...window.__sakuraDebug, renderer, impostors: forest.userData.impostors };
  scene.add(forest);
  const cliffs = await makeLods(cliffsUrl, CLIFF_KINDS, G.cliffs, M.rockMaterial(), [70], { lodScale, ...nearOf('cliffs') });
  cliffs.name = 'cliffs';
  scene.add(cliffs);
  const bamboo = await makeLods(bambooUrl, BAMBOO_KINDS, G.bamboo, M.forestMaterial(), [60, 160], { lodScale, ...nearOf('bamboo', 15) });
  bamboo.name = 'bamboo';
  scene.add(bamboo);
  const shrubs = await makeLods(shrubsUrl, SHRUB_KINDS, G.shrubs, M.shrubMaterial(), [35, 110], { lodScale, ...nearOf('shrubs') });
  shrubs.name = 'shrubs';
  scene.add(shrubs);
  const villageMat = M.villageMaterial();
  const village = await makeLods(villageUrl, VILLAGE_KINDS, G.village.lists, villageMat, [90], { lodScale, ...nearOf('village') });
  village.name = 'village';
  scene.add(village);
  // the waterwheel, turned by the river (a full and a far model, switched as the village's, and the near one)
  const wheel = new THREE.Group();
  if (G.village.wheel) {
    const gl = await loadModel(villageUrl);
    const near = nearOf('village').nearUrl && await loadModel(ultraUrl('village')).catch(() => null);
    for (const [g, n] of [[gl, 'suisha_wheel'], [gl, 'suisha_wheel_far'], ...(near ? [[near, 'suisha_wheel_near']] : [])]) {
      const src = g.scene.getObjectByName(n);
      if (!src) continue;
      const m = new THREE.Mesh(src.geometry, villageMat);
      m.applyMatrix4(src.matrixWorld);
      const spin = new THREE.Group();
      spin.add(m);
      spin.name = n;
      wheel.add(spin);
    }
    wheel.position.set(...G.village.wheel.pos);
    wheel.rotation.y = G.village.wheel.yaw;
    wheel.name = 'waterwheel';
    scene.add(wheel);
  }

  await yieldTask();
  // ---------- river ----------
  const depthMap = depthTexture(G.depth);
  const koi = makeKoi(world, Q.koi, focus, G.rocks.rocksInWater);
  koi.mesh.name = 'koi';
  scene.add(koi.mesh);
  // reflection buffer per CSS pixel above DPR 1.4 (0.35 at DPR 2 passes against sub-pixel A/A, 0.25 does not;
  // bench/dpr_parity.py); the light shafts are per CSS pixel at every DPR (see buildPipeline below)
  const water = makeWater(G.river, depthMap, sky, { reflectionScale: opts.reflScale ?? Q.refl * Math.min(1, 1.4 / dpr), clearing: koiClearing(koi.state, koi.count), wheel: G.village.wheel });
  water.mesh.name = 'water';
  scene.add(water.mesh);
  const mist = makeMist(G.river);
  mist.name = 'mist';
  scene.add(mist);
  const reflector = water.reflector ? water.reflector.reflector : null;
  if (reflector) {
    // the old planar reflection rendered layer 0 only (no grass, flowers, petals, motes)
    reflector.getVirtualCamera(camera).layers.set(0);
    // quality ladder can skip reflection frames
    const upd = reflector.updateBefore.bind(reflector);
    reflector.updateBefore = (frame) => (reflSkip ? false : upd(frame));
  }
  let reflSkip = false;
  // what the camera and the river's reflection see: the Blender models' instances out of it are not drawn there
  // (lods.js makeView; the shadow maps still draw them)
  const view = makeView(camera, reflector ? reflector.target : null);
  if (reflector) view.cameras.add(reflector.getVirtualCamera(camera));
  const lodGroups = [forest, cliffs, rocks, pebbles, bamboo, village, lamps, shrubs];
  // the wayside's stones by the lanes (wayside.js): Jizō, signposts, roadside shrines; casting shadows as the lamps do,
  // and the roku-jizō's roof into the valley's map too (layer 3 only), so it shades its statues where the sharp map
  // does not reach
  const wayside = await makeLods(waysideUrl, WAYSIDE_KINDS, G.village.wayside, M.waysideMaterial(), [40], { lodScale });
  wayside.name = 'wayside';
  wayside.traverse((o) => { o.castShadow = o.isMesh; });
  scene.add(wayside);
  lodGroups.push(wayside);
  const shelterRoofs = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(G.village.waysideRoofs, 3)), new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide }));
  shelterRoofs.name = 'waysideRoofs';
  shelterRoofs.layers.set(FAR_LAYER);
  scene.add(shelterRoofs);

  // ---------- petals ----------
  const sp3 = main.data.spawn, spawnPts = [];
  for (let i = 0; i < sp3.length; i += 3) spawnPts.push(new THREE.Vector3(sp3[i], sp3[i + 1], sp3[i + 2]).add(treePos));
  const petalMat = petalMaterial();
  // WebGPU: simulated in a compute pass (petalsgpu.js), shed by every cherry, 2.5 times as many; WebGL: on the CPU, from
  // the main tree
  const petals = renderer.backend.isWebGPUBackend && opts.gpuPetals !== false
    ? makeGpuPetals([main, ...smallTrees].map((t) => ({ spawn: t.data.spawn, pos: t.group.position, scale: t.group.scale.x, weight: 1 })),
      grass.userData.groundAt, Math.round(Q.petals * 2.5), petalMaterial)
    : new PetalSystem(world, spawnPts, Q.petals, petalMat, U.uWindDir.value);
  petals.mesh.name = 'petals';
  scene.add(petals.mesh);
  const fallen = makeFallenPetals(G.fallen, petalMat);
  fallen.name = 'fallenPetals';
  scene.add(fallen);
  const rafts = makeFallenPetals(G.rafts, petalMat); // hanaikada: petal mats on the slack water
  rafts.name = 'petalRafts';
  scene.add(rafts);
  const motes = makeMotes(new THREE.Vector3(...Lay.motes), Q.motes);
  motes.mesh.name = 'motes';
  scene.add(motes.mesh);
  // fireflies over the flooded paddies and among the reeds after dusk (fireflies.js)
  const fireflies = makeFireflies(fireflyData(world, Q.fireflies), lanterns.uFocal);
  fireflies.mesh.name = 'fireflies';
  scene.add(fireflies.mesh);
  const birds = makeBirds(world, { x: TX, z: TZ });
  scene.add(birds.group);
  const butterflies = makeButterflies(world, { tree: [TX, TZ], flowers: G.flowers, posts: G.lanterns.lists[0], small: Lay.small, tier: tierName });
  scene.add(butterflies.mesh);
  const deer = await makeDeer(world, Lay.graze);
  scene.add(deer.group);
  const herons = await makeHerons(world);
  scene.add(herons.group);
  const rain = makeRain(Q.rain);
  rain.name = 'rain';
  rain.visible = false;
  scene.add(rain);
  const sound = createSound(world, bridge.center);
  const lightning = makeLightning((x, z, dist, bolt) => sound.thunder(x, z, dist, bolt, camera));
  lightning.mesh.name = 'lightning';
  scene.add(lightning.mesh);
  if (ST) {
    scene.add(makeStressObjects(world, ST.objects, focus, M.stressObjectMaterial));
    scene.add(makeRain(ST.particles));
  }

  // the valley's shadow map (sunshadow.js): the ground, the woods and the buildings cast into it
  const farShadow = makeFarShadow(renderer, Math.min(Q.far, maxTex));
  // (the cherries by their trunks and their flowers' shadow proxies, layer 2: a low sun throws their shadows far
  // beyond the sharp map's square)
  const cherries = [main, ...smallTrees].flatMap((t) => t.group.children.filter((c) => c.name === 'bark' || c.layers.isEnabled(2)));
  for (const o of [terrain, fields, forest, bamboo, cliffs, village, wheel, temple, toro, bridge.mesh, rocks, walls, ...cherries]) {
    o.traverse((c) => { if (c.isMesh) c.layers.enable(FAR_LAYER); });
  }
  // (not the woods' impostors: cards turned to the camera; their trees' lighter models cast for them, lods.js)
  if (forest.userData.impostors) forest.userData.impostors.mesh.layers.disable(FAR_LAYER);

  for (const n of opts.hide || []) scene.getObjectsByProperty('name', n).forEach((o) => { o.visible = false; }); // bench: isolate objects
  mark('assembled');
  await yieldTask();
  // ---------- post ----------
  // light shafts per CSS pixel: 0.25 of the drawing buffer at DPR 2 is ~7x below sub-pixel A/A noise (dpr_parity)
  const post = buildPipeline(renderer, scene, camera, { raySamples: Q.rays, msaa, shaftScale: opts.shaftScale ?? 0.5 / dpr, ss: Q.ss });
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

  const trunkTop = MAIN_TREE.trunk.length * MAIN_TREE.scale + 1.5;
  function clampCamera() {
    const p = camera.position;
    const g = Math.max(world.heightFast(p.x, p.z), 0);
    if (p.y < g + 0.8) p.y = g + 0.8;
    const dx = p.x - TX, dz = p.z - TZ, d = Math.hypot(dx, dz);
    if (p.y < trunkTop && d < 1.8) { const k = 1.8 / Math.max(d, 1e-3); p.x = TX + dx * k; p.z = TZ + dz * k; }
    const t = controls.target;
    t.x = clamp(t.x, -160, 160); t.z = clamp(t.z, -250, 90); // (to the village's far end, where walk mode can leave the figure)
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
  const ORBIT_FOV = camera.fov;
  // a flight of the camera to a view: from fp/ft to tp/tt (position, target), the field of view from ff to tf;
  // walk: into the walker's eye (no orbit limits on the way, lifted over what lies between by `lift` metres)
  let tween = null; // { fp, ft, tp, tt, ff, tf, t, dur, walk, lift }
  function startTween(toPos, toTarget, dur, fov = ORBIT_FOV) {
    tween = { fp: camera.position.clone(), ft: controls.target.clone(), tp: toPos.clone(), tt: toTarget.clone(), ff: camera.fov, tf: fov, t: 0, dur, walk: false, lift: 0 };
  }
  // the lanterns' halos are sized in the scene pass's pixels: the canvas height times the pixel ratio and, on ultra,
  // the supersampling (ssNow: set by resize)
  let ssNow = 1;
  const focal = (f) => (H * renderer.getPixelRatio() * ssNow) / (2 * Math.tan(THREE.MathUtils.degToRad(f / 2)));
  function setFov(f) {
    if (Math.abs(camera.fov - f) < 1e-4) return;
    camera.fov = f;
    camera.updateProjectionMatrix();
    lanterns.uFocal.value = focal(f);
  }
  // settle the default view under the controls' limits (it looks up past maxPolarAngle), so the intro and reset
  // flights end exactly where the camera then rests instead of jumping on the first controls update
  const introPos = camera.position.clone(), introTarget = controls.target.clone();
  camera.position.copy(DEFAULT.pos); controls.target.copy(DEFAULT.target); controls.update(); clampCamera();
  DEFAULT.pos.copy(camera.position); DEFAULT.target.copy(controls.target);
  camera.position.copy(introPos); controls.target.copy(introTarget); controls.update();
  startTween(DEFAULT.pos, DEFAULT.target, opts.introDuration ?? 6.5);

  canvas.addEventListener('pointerdown', () => {
    if (walking) return; // (walk.js: a click locks the pointer)
    if (tween) tween = null;
    if (cinematic) { cinematic = false; controls.enabled = true; opts.onCinematicChange && opts.onCinematicChange(false); }
  });
  canvas.addEventListener('wheel', () => { if (tween && !walking) tween = null; }, { passive: true });

  // ---------- walking: first person along the lanes (walk.js); the walker's body (walker.js) loaded on first use ----------
  // what stands by the paths for the walker to go round: the riverside's lamps, the stone lanterns (not the temple's
  // hanging ones), the boulders, the trees' trunks (the woods' with room for their lowest boughs), the bamboo's
  // stands, the torii's pillars (walk.js keeps those near a path)
  const walkObstacles = [];
  const instances = (l, r) => { for (let i = 0, m = l.matrix; i < l.n; i++) walkObstacles.push({ x: m[i * 16 + 12], z: m[i * 16 + 14], r: r * Math.hypot(m[i * 16], m[i * 16 + 1], m[i * 16 + 2]) }); };
  G.lanterns.lists.forEach((l, k) => instances(l, [0.16, 0.3, 0.5][k])); // post, bonbori, kagaribi
  for (const l of G.forest) instances(l, 0.05);
  for (const l of G.bamboo) instances(l, 0.13); // (tools/bamboo.py: the culms' feet within 0.13 of the stand's height)
  for (const a of [G.village.toro.lamps, G.props.temple.lamps]) for (let i = 0; i < a.length; i += 3) {
    if (a[i + 1] - world.heightFast(a[i], a[i + 2]) < 2.5) walkObstacles.push({ x: a[i], z: a[i + 2], r: 0.55 });
  }
  for (const b of G.rocks.blockers) if (b.sc > 0.3) walkObstacles.push({ x: b.x, z: b.z, r: b.sc * 0.9 });
  walkObstacles.push({ x: TX, z: TZ, r: 0.8 }, ...Lay.small.map((sp) => ({ x: sp.x, z: sp.z, r: 0.6 * sp.s })));
  const toriiList = G.village.lists[VILLAGE_KINDS.indexOf('torii')], tm = new THREE.Matrix4();
  for (let i = 0; i < toriiList.n; i++) {
    tm.fromArray(toriiList.matrix, i * 16);
    for (const sd of [-1, 1]) { const p = new THREE.Vector3(sd * 1.6, 0, 0).applyMatrix4(tm); walkObstacles.push({ x: p.x, z: p.z, r: 0.21 }); } // (tools/village.py)
  }
  const walk = makeWalk(world, { canvas, obstacles: walkObstacles, onEscape: () => setWalk(false) });
  let walking = false, walker = null, walkerLoad = null, firstPerson = false;
  const eyeV = new THREE.Vector3(), lookV = new THREE.Vector3();
  // the eye in the world: the model's (walker.eye, after its update), a little ahead along the facing so a look
  // down shows the hem and the geta stepping out and not only the robe's front; before the model has loaded,
  // walk.js's eye height over the feet
  const EYE_AHEAD = 0.26;
  function eyeAt(out) {
    if (!walker) return walk.eye(null, out);
    const s = walk.state;
    return out.set(walker.eye.x + Math.sin(s.yaw) * EYE_AHEAD, walker.eye.y, walker.eye.z + Math.cos(s.yaw) * EYE_AHEAD);
  }
  function loadWalkerOnce() {
    walkerLoad ??= import('./walker.js')
      // (the hidden head keeps casting the sun's shadow and showing in the river: walker.js gives their cameras its layer)
      .then((m) => m.loadWalker({ sun, reflector, camera }))
      .then(async (w) => {
        const s = walk.state;
        w.setPose(s.x, s.y, s.z, s.yaw);
        try { await renderer.compileAsync(w.group, camera, scene); } catch (e) { /* built on its first frame instead */ }
        scene.add(w.group);
        w.onStep(({ foot }) => { if (walking && sound.footstep) sound.footstep({ surface: walk.state.surface, hurry: walk.state.hurry, foot }); });
        walker = w;
        return w;
      })
      // (a failed fetch is tried again on the next entry; walking goes on without the body meanwhile)
      .catch((e) => { console.warn('traveller not loaded', e); walkerLoad = null; return null; });
    return walkerLoad;
  }
  // Into walk mode: the camera flies into the walker's eye (cinematic and auto-orbit off), then the body is in
  // control. Out (fly false: at once, for the camera mode taking over): to an orbit view a few metres behind the
  // figure, which stays standing where it was left.
  function setWalk(on, fly = true) {
    on = !!on;
    if (on === walking) return on ? loadWalkerOnce() : Promise.resolve(walker);
    walking = on;
    walk.setActive(on);
    if (on) {
      if (cinematic) { cinematic = false; opts.onCinematicChange && opts.onCinematicChange(false); }
      autoOrbit = false; controls.autoRotate = false; controls.enabled = false;
      const eye = eyeAt(eyeV), to = lookV.copy(eye).addScaledVector(walk.dir(), 10);
      const d = camera.position.distanceTo(eye);
      startTween(eye, to, clamp(1.2 + d / 40, 1.4, 3.2), WALK.fov);
      tween.walk = true; tween.lift = Math.min(8, d * 0.15);
      walk.lock();
    } else {
      controls.enabled = true;
      tween = null;
      if (fly) {
        const s = walk.state, target = new THREE.Vector3(s.x, s.y + 1.1, s.z);
        startTween(target.clone().add(new THREE.Vector3(-Math.sin(s.yaw) * 6, 1.8, -Math.cos(s.yaw) * 6)), target, 1.8);
      }
    }
    opts.onWalkChange && opts.onWalkChange(on);
    return on ? loadWalkerOnce() : Promise.resolve(walker);
  }

  // ---------- params ----------
  const P = { wind: 0.6, petals: 0.6, river: 1.0, fog: 0.25, bloom: 0.4, clouds: 0.35, rain: 0, lightning: 0 };
  const S = { ...P }; // smoothed
  petals.setAmount(P.petals);
  let weatherTween = null; // { from, to, t, dur } in set() units
  // time of day: clock hours, fixed (no ticking clock, see CLAUDE.md); moves to a new time as a time-lapse
  let clockH = opts.hour ?? tToHour(0.92), timeTween = null; // { from, delta, lut, t, dur }
  const hemiBase = new THREE.Color(), ambBase = new THREE.Color(), flashCol = new THREE.Color(0.55, 0.6, 0.85), tmpC = new THREE.Color();
  let flashed = false;

  let lastTime = -1, lastCover = -1;
  const tmpAmb = new THREE.Color(), rayWarm = new THREE.Color(1, 0.9, 0.8);
  function applyTimeOfDay(t) {
    const st = overcast(skyState(t), S.clouds);
    sky.uniforms.uCover.value = S.clouds;
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
    const amb = tmpAmb.copy(st.zenith).lerp(st.horizon, 0.45);
    U.uSkyAmb.value.copy(amb);
    hemi.color.copy(amb).multiplyScalar(1.25);
    hemi.groundColor.setRGB(0.16, 0.15, 0.08).lerp(st.fog, 0.25);
    hemi.intensity = lerp(0.62, 1.0, 1 - st.vis * 0.6);
    hemiBase.copy(hemi.color); ambBase.copy(amb);
    rays.tint.value.copy(st.sun).lerp(rayWarm, 0.3);
    renderer.toneMappingExposure = lerp(1.35, 0.98, st.vis) * (st.elev > 30 ? 0.92 : 1);
    lastTime = t; lastCover = S.clouds;
    return st;
  }
  let skyNow = applyTimeOfDay(hourToT(clockH));

  // settings in set() units (0..1) <-> engine values
  function setParam(name, v) {
    v = clamp(+v, 0, 1);
    if (name === 'wind') P.wind = v * 1.6;
    else if (name === 'petals') { P.petals = v; petals.setAmount(v); }
    else if (name === 'river') P.river = v * 2.2;
    else if (name in P) P[name] = v;
  }
  const paramOf = (name) => (name === 'wind' ? P.wind / 1.6 : name === 'river' ? P.river / 2.2 : P[name]);

  // ---------- sizing / adaptive quality ----------
  let W = 1, H = 1;
  let pixelScale = 1; // adaptive render scale: the canvas resolution itself
  function resize() {
    const w = Math.max(1, canvas.clientWidth | 0), h = Math.max(1, canvas.clientHeight | 0);
    W = w; H = h;
    const pr = Math.min(dpr * pixelScale, maxTex / Math.max(w, h));
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const g = post.grade.uniforms;
    renderer.getDrawingBufferSize(g.res.value);
    post.bloom.setSize(g.res.value.x, g.res.value.y);
    // supersampling (ultra): the scene at ss times the drawing buffer, within the device's texture limit
    const ss = ssNow = Math.max(1, Math.min(Q.ss, maxTex / Math.max(g.res.value.x, g.res.value.y)));
    post.setScale(ss, g.res.value.x, g.res.value.y);
    // sharpening by the scene's pixel density: less where pixels are small (high DPR) or supersampled (the Lanczos
    // downsample sharpens a little itself)
    const spr = pr * ss;
    g.sharp.value = spr >= 1.75 ? 0.3 : spr >= 1.2 ? 0.45 : 0.6;
    uStarPx.value = ss;
    rays.aspect.value = w / h;
    // (sprite sizes in the scene pass's pixels)
    motes.uPx.value = pr * ss * (h / 900) * 1.3;
    lanterns.uFocal.value = focal(camera.fov);
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
      if (resolving || opts.fixedQuality) return;
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
  const tmpV = new THREE.Vector3(), sdl = new THREE.Vector3(), camDir = new THREE.Vector3();
  const lightR = new THREE.Vector3(), lightU = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  let figureAnchor = false; // the sun's sharp shadow round the walker's figure, out of walk mode (see step)
  let running = true;
  let frameNo = 0, warming = false;
  const sunScreen = new THREE.Vector3();
  const tmpSize = new THREE.Vector2();

  function step(dtIn, doRender = true) {
    const dt = Math.min(dtIn, 0.05);
    const k = 1 - Math.exp(-dt * 2.5);
    if (weatherTween) {
      const w = weatherTween, e = easeInOut(Math.min(1, (w.t += dt / w.dur)));
      for (const key of WEATHER_KEYS) setParam(key, lerp(w.from[key], w.to[key], e));
      if (w.t >= 1) weatherTween = null;
    }
    for (const key in P) S[key] += (P[key] - S[key]) * k;
    if (timeTween) {
      const tt = timeTween;
      tt.t += dt / tt.dur;
      // gently eased progress along the warped path -> clock hours
      const e = smoothstep(0, 1, tt.t) * tt.lut[tt.lut.length - 1], lut = tt.lut;
      let i = 0;
      while (i < lut.length - 2 && lut[i + 1] < e) i++;
      const f = (e - lut[i]) / Math.max(1e-9, lut[i + 1] - lut[i]);
      clockH = (tt.from + tt.delta * Math.min(1, (i + f) / (lut.length - 1))) % 24;
      if (tt.t >= 1) timeTween = null;
    }
    const tod = hourToT(clockH);
    // every frame a time-lapse or the cloud cover has moved: in steps the sun's direction and colours jump, most
    // visibly on faces lit edge-on
    if (tod !== lastTime || Math.abs(S.clouds - lastCover) > 1e-5) skyNow = applyTimeOfDay(tod);
    // the moon moves every frame: a sharp disc would step with the sky's palette updates
    sky.uniforms.uMoonVis.value = moonState(clockH, skyNow.elev, sky.uniforms.uMoonDir.value);
    // weather
    U.uRain.value = S.rain;
    // the ground soaks in a minute or so of rain and dries over several
    const wetTo = S.rain > 0.02 ? Math.min(1, 0.4 + S.rain) : 0;
    U.uWet.value += (wetTo - U.uWet.value) * (1 - Math.exp(-dt / (wetTo > U.uWet.value ? 40 : 240)));
    rain.geometry.instanceCount = warming ? 1 : Math.round(Q.rain * S.rain); // warm-up builds its pipeline
    rain.visible = rain.geometry.instanceCount > 0;
    const flash = lightning.update(dt, S.lightning, camera);
    if (warming) lightning.mesh.visible = true;
    U.uFlash.value = flash;
    sky.uniforms.uBoltDir.value.copy(lightning.dir);
    if (flash > 0.001 || flashed) {
      hemi.color.copy(hemiBase).add(tmpC.copy(flashCol).multiplyScalar(flash * 0.9));
      U.uSkyAmb.value.copy(ambBase).add(tmpC.copy(flashCol).multiplyScalar(flash * 0.6));
      flashed = flash > 0.001;
    }
    U.uTime.value += dt;
    U.uWind.value = S.wind;
    U.uWindRun.value += dt * S.wind;
    U.uFlow.value += dt * S.river * 1.3;
    water.uniforms.uSpeed.value = S.river;
    sky.uniforms.uCloud.value.x += dt * (0.006 + S.wind * 0.012);
    sky.uniforms.uCloud.value.y -= dt * (0.003 + S.wind * 0.005);
    // the clouds' shadows drift with the sky's clouds (sunshadow.js)
    CLOUDS.uPos.value.copy(sky.uniforms.uCloud.value); CLOUDS.uCover.value = S.clouds; CLOUDS.uSun.value.copy(U.uSunDir.value);
    U.uFogDensity.value = 0.0006 + Math.pow(S.fog, 1.5) * 0.013;
    U.uFogFalloff.value = 0.028;
    U.uAerial.value = (0.7 + 1.2 * S.fog) / 2400; // hazier air with the weather's haze
    // river mist (kawagiri) from before dawn to mid-morning, thinned by the wind
    U.uMist.value = smoothstep(4.2, 5.0, clockH) * smoothstep(8.3, 6.8, clockH) * lerp(1, 0.4, S.wind / 1.6);
    mist.visible = warming || U.uMist.value > 0.001; // warm-up builds its pipeline
    post.bloom.uniforms.strength.value = S.bloom * 1.6;
    post.grade.uniforms.time.value = U.uTime.value;

    if (petals.isPetalSystem) petals.update(dt, U.uTime.value, S.wind, S.river);
    else petals.update(renderer, warming ? 1 / 60 : dt, U.uTime.value, S.wind, S.river);
    koi.update(dt, U.uTime.value);
    boats.update(U.uTime.value, camera.position);
    rafts.geometry.instanceCount = Math.round(G.rafts.n * Math.min(1, S.petals / 0.6)); // fewer when fewer petals fall
    deer.update(dt);
    herons.update(dt, clockH, camera);
    // the lanterns come on at dusk
    U.uLights.value = smoothstep(7 + 9 * (skyNow.gloom || 0), -2.5, skyNow.elev); // earlier under heavy cloud
    lanterns.halos.visible = templeGlows.visible = fireGlows.visible = fires.visible = sparks.visible = warming || U.uLights.value > 0.001;
    fireflies.update({ lights: U.uLights.value, elev: skyNow.elev, rain: S.rain, wind: S.wind, warming });
    // the hearths' smoke: thickest when the rice is on, morning and evening; thinned by rain
    const cook = Math.exp(-(((clockH - 6.8) / 1.3) ** 2)) + Math.exp(-(((clockH - 17.8) / 1.4) ** 2));
    smoke.uAmount.value = (0.3 + 0.7 * Math.min(1, cook)) * (1 - 0.6 * S.rain);
    birds.update(dt, { t: U.uTime.value, hour: clockH, rain: S.rain, clouds: S.clouds, wind: S.wind / 1.6, windDir: U.uWindDir.value, flash, camera, focus: controls.target });
    butterflies.update({ hour: clockH, rain: S.rain, clouds: S.clouds, wind: S.wind / 1.6, warming });
    sound.update(dt, { wind: S.wind / 1.6, river: S.river / 2.2, rain: S.rain, lightning: S.lightning, hour: clockH, lights: U.uLights.value, camera });

    // camera
    walk.update(dt, walking && !tween); // (the body waits for the flight into its eye)
    // the walker's body: walking, or standing where it was left (posed before the camera takes its eye)
    if (walker) {
      const s = walk.state;
      walker.setPose(s.x, s.y, s.z, s.yaw);
      walker.setMotion(walking ? s.speed : 0);
      walker.update(dt);
    }
    if (walking && !tween) {
      const s = walk.state;
      eyeAt(camera.position);
      camera.rotation.set(s.pitch, s.yaw + Math.PI, 0, 'YXZ'); // level horizon: no roll
      controls.target.copy(camera.position).addScaledVector(walk.dir(lookV), 10);
    } else if (cinematic) {
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
      if (tween.walk) camera.position.y += Math.sin(Math.PI * e) * tween.lift;
      else {
        controls.update(); // the flight stays within the controls' limits (and spends any leftover drag momentum)
        clampCamera();
      }
      camera.lookAt(controls.target);
      setFov(lerp(tween.ff, tween.tf, e));
      if (tween.t >= 1) tween = null;
    } else {
      controls.autoRotate = autoOrbit;
      controls.update();
      clampCamera();
      camera.lookAt(controls.target);
    }
    // the mode's field of view (eased there when a flight was cut short)
    const fovTo = walking ? WALK.fov : ORBIT_FOV;
    if (!tween) setFov(Math.abs(camera.fov - fovTo) < 0.01 ? fovTo : lerp(camera.fov, fovTo, 1 - Math.exp(-dt * 4)));
    // the head hidden while the camera is in it (it keeps its shadow and reflection)
    if (walker) {
      const fp = walking && camera.position.distanceTo(eyeAt(eyeV)) < 0.6;
      if (fp !== firstPerson) { firstPerson = fp; walker.setFirstPerson(fp); }
    }
    if (sound.walking) sound.walking(walking ? walk.state.speed : 0, walk.state.surface);
    camera.updateMatrixWorld();
    sky.mesh.position.copy(camera.position);
    grass.userData.update(camera, warming); // warm-up draws every tile
    view.update(warming); // (warm-up draws every instance)
    for (const g of lodGroups) g.userData.lod(view);
    walls.userData.lod(camera.position);
    if (wheel.children.length) {
      // a turn every ~9 s at the river's usual speed; the far model beyond 90 m (times lodScale), the near one within
      // NEAR_RANGE when there is one
      const d = camera.position.distanceTo(wheel.position), far = d > 90 * lodScale, near = !!wheel.children[2] && d < NEAR_RANGE;
      wheel.children[0].visible = warming || (!far && !near); wheel.children[1].visible = warming || far;
      if (wheel.children[2]) wheel.children[2].visible = warming || near;
      for (const sp of wheel.children) sp.rotation.x -= dt * 0.7 * (0.3 + S.river / 2.2);
    }
    if (nearFlowers) nearFlowers.update(camera.position, warming);

    // sun light / shadow frustum: anchored on the tree; ahead of the walker while walking; on the figure where it
    // was left while the camera is nearer to it than to the tree or looks at it from close by (the orbit target
    // within ~20 m), so it keeps its sharp shadow (the valley's map has none of it). Always snapped to the map's
    // texels in the light's frame: its shadows hold still as the anchor moves, and a switch between anchors keeps
    // the same texel grid (only what leaves the map's square changes, far from the camera)
    const sd = U.uSunDir.value;
    sdl.copy(sd); if (sdl.y < 0.08) sdl.y = 0.08; sdl.normalize();
    const anchor = tmpV.set(TX + 4, 3, TZ + 2);
    // (the tree's square already holds a figure within 20 m of the tree's anchor)
    if (walker && !walking && Math.hypot(walk.state.x - anchor.x, walk.state.z - anchor.z) > 20) {
      const s = walk.state, cp = camera.position;
      const dF = Math.hypot(cp.x - s.x, cp.y - s.y, cp.z - s.z), dT = Math.hypot(cp.x - TX, cp.y - 3, cp.z - TZ);
      const tF = Math.hypot(controls.target.x - s.x, controls.target.z - s.z);
      // (a little hysteresis, so an orbit about the midway point doesn't flip it to and fro)
      figureAnchor = figureAnchor ? dF < dT * 1.05 || tF < 22 : dF < dT * 0.95 || tF < 20;
    } else figureAnchor = false;
    if (walking) {
      const s = walk.state;
      anchor.set(s.x + Math.sin(s.yaw) * 10, s.y + 1, s.z + Math.cos(s.yaw) * 10);
    } else if (figureAnchor) {
      const s = walk.state;
      anchor.set(s.x, s.y + 1, s.z);
    }
    // the shadow camera's axes as its lookAt builds them
    lightR.crossVectors(UP, sdl); if (lightR.lengthSq() < 1e-6) lightR.set(1, 0, 0); lightR.normalize();
    lightU.crossVectors(sdl, lightR);
    const tex = (sc.right - sc.left) / sun.shadow.mapSize.x, a = Math.round(anchor.dot(lightR) / tex) * tex, b = Math.round(anchor.dot(lightU) / tex) * tex;
    anchor.copy(lightR).multiplyScalar(a).addScaledVector(lightU, b).addScaledVector(sdl, anchor.dot(sdl));
    sun.target.position.copy(anchor);
    sun.position.copy(anchor).addScaledVector(sdl, 150);
    sun.target.updateMatrixWorld();

    // god-ray sun position
    sunScreen.copy(camera.position).addScaledVector(sd, 2000).project(camera);
    camera.getWorldDirection(camDir);
    const facing = smoothstep(0.05, 0.55, camDir.dot(sd));
    // stars once the sky is dark, fewer through haze, none under heavy cloud
    sky.night(dt, clockH, smoothstep(-4.5, -14, skyNow.elev) * (1 - smoothstep(0.45, 0.8, S.clouds)) * lerp(1, 0.3, smoothstep(0.3, 0.8, S.fog)), camDir);
    const onScreen = smoothstep(1.9, 1.0, Math.max(Math.abs(sunScreen.x), Math.abs(sunScreen.y)));
    // uv of the sun in the post passes: three's fullscreen quad runs uv.y top-down on both backends
    rays.sun.value.set(sunScreen.x * 0.5 + 0.5, 0.5 - sunScreen.y * 0.5);
    rays.intensity.value = facing * onScreen * U.uSunVis.value * (0.55 + S.fog * 0.9) * (opts.rays ?? 1);
    post.shafts.setEnabled(warming || rays.intensity.value > 0.001); // warm-up builds them even when off-screen

    // reflections
    if (!doRender) return;
    frameNo++;
    if (probe) probe.beginFrame();
    sun.shadow.needsUpdate = frameNo % shadowEvery === 0 || frameNo < 3;
    farShadow.update(scene, U.uSunDir.value, { every: timeTween ? 4 : 15, force: frameNo < 3 || opts.farEveryFrame });
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

  // capped at 60 fps: high-refresh displays skip callbacks until the next frame is due (the 2 ms tolerance keeps
  // a 60 Hz display's jittery timestamps from skipping frames)
  const frameMs = 1000 / 60;
  let due = 0;
  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);
    if (now < due - 2) return;
    due += frameMs;
    if (due < now) due = now + frameMs;
    timer.update(now);
    const dt = timer.getDelta();
    step(dt);
    adapt(dt);
  }
  // build pipelines behind the veil (asynchronously on WebGPU)
  mark('ready');
  if (opts.precompile !== false) await renderer.compileAsync(scene, camera);
  mark('precompiled');
  // Warm-up behind the loading screen, as games do: the real frame renders into targets compileAsync does not
  // know (the multisampled scene pass, shadow map, reflection, post passes), so their pipelines would otherwise be
  // built on the first visible frames and stutter. A few hidden frames build and upload everything (the 30 Hz
  // shadow and reflection passes run on the first ones; three also stalls once around the 16th frame, so 24
  // frames absorb that too, ~0.4 s here); the page reveals the scene after create() resolves.
  if (!opts.manual && opts.warmup !== false) {
    warming = true;
    for (let i = 0; i < (opts.warmupFrames ?? 24); i++) { step(1 / 60); await new Promise((r) => requestAnimationFrame(r)); }
    warming = false;
    mark('warm');
  }
  if (!opts.manual) requestAnimationFrame(loop);
  opts.onReady && opts.onReady({ quality: tierName });

  return {
    set(name, v) {
      if (name === 'time') { timeTween = null; clockH = tToHour(clamp(+v, -0.08, 1.08)); } // 04:50 .. 20:10
      else { weatherTween = null; setParam(name, v); }
    },
    setImmediate(name, v) { this.set(name, v); for (const k in P) S[k] = P[k]; U.uWet.value = S.rain > 0.02 ? Math.min(1, 0.4 + S.rain) : 0; },
    // weather preset by id, blended in over `seconds`
    setWeather(id, seconds = 6) {
      const w = WEATHERS.find((x) => x.id === id);
      if (!w) return;
      const from = {};
      for (const key of WEATHER_KEYS) from[key] = paramOf(key);
      weatherTween = { from, to: w, t: 0, dur: Math.max(1e-3, seconds) };
      if (seconds <= 0) { for (const key of WEATHER_KEYS) setParam(key, w[key]); weatherTween = null; for (const k in P) S[k] = P[k]; }
    },
    // move the clock to `hour` (0..24) as an eased time-lapse (a longer way takes longer), or at once; forward
    // through midnight if need be, or (`forward` false) straight there, back if `hour` is earlier
    setTimeOfDay(hour, animate = true, forward = true) {
      const delta = forward ? (((hour - clockH) % 24) + 24) % 24 : hour - clockH;
      timeTween = null;
      if (animate && Math.abs(delta) > 0.01) {
        // the time-lapse slows where the light changes fastest: cumulative hours plus the sun's movement near the
        // horizon (at dusk and dawn the elevation changes steeply in a few clock minutes)
        const N = 160, lut = [0];
        let el0 = skyState(hourToT(clockH)).elev;
        for (let i = 1; i <= N; i++) {
          const el = skyState(hourToT((clockH + (delta * i) / N) % 24)).elev;
          lut.push(lut[i - 1] + Math.abs(delta) / N + 0.5 * Math.abs(el - el0) * Math.exp(-(((el + 3) / 8) ** 2)));
          el0 = el;
        }
        timeTween = { from: clockH, delta, lut, t: 0, dur: clamp(1.5 + lut[N] * 0.11, 2.5, 4.5) };
      }
      if (!timeTween) clockH = ((hour % 24) + 24) % 24;
    },
    timeOfDay() { return clockH; },
    resetCamera() {
      if (walking) { setWalk(false); return; } // out of walk mode, behind the figure
      cinematic = false; controls.enabled = true;
      startTween(DEFAULT.pos, DEFAULT.target, 1.8);
    },
    setCinematic(on) {
      if (on && walking) setWalk(false, false);
      cinematic = !!on; controls.enabled = !cinematic;
      if (cinematic) {
        tween = null;
        // start from the nearest point on the path
        let best = 0, bd = Infinity;
        for (let i = 0; i < 200; i++) { const d = posCurve.getPointAt(i / 200).distanceToSquared(camera.position); if (d < bd) { bd = d; best = i / 200; } }
        cineT = best;
      } else controls.update();
    },
    setAutoOrbit(on) { if (on && walking) setWalk(false); autoOrbit = !!on; },
    // walk mode: first person along the lanes (walk.js); resolves once the walker's body is in the scene
    setWalk(on) { return setWalk(on); },
    walking() { return walking; },
    // debug: where the walker is (feet, ground under them, eye), how fast, on what; detail: the network too
    walkInfo(detail = false) {
      const s = walk.state, net = walk.net;
      const out = {
        walking, flying: !!(tween && tween.walk), walker: !!walker, firstPerson, pos: [s.x, s.y, s.z], ground: net.ground(s.x, s.z).y,
        eye: eyeAt(new THREE.Vector3()).toArray(), camera: camera.position.toArray(), yaw: s.yaw, pitch: s.pitch,
        speed: s.speed, hurry: s.hurry, surface: s.surface, off: net.outside(s.x, s.z), fov: camera.fov,
      };
      if (detail) Object.assign(out, { ways: net.ways.map((w) => ({ name: w.name, pts: w.pts, hw: w.hw })), stairFoot: net.stairFoot, steps: net.steps, bridgeEnds: net.bridgeEnds.map((p) => p.toArray()), obstacles: net.obstacles.map((o) => [o.x, o.z]) });
      return out;
    },
    walkTo(x, z, yaw) { walk.moveTo(x, z, yaw); if (walking && tween && tween.walk) tween = null; }, // debug: stand there (on the network)
    walkInput(o) { walk.input(o); }, // debug: { forward, strafe (-1..1), hurry, yaw, pitch (radians) }, held until changed
    // music and ambience; sound starts with the page's first click or key press if it has not had one yet
    setSound(on) { sound.setEnabled(on); },
    setVolume(which, v) { sound.setVolume(which, v); },
    soundWaiting() { return sound.waiting; }, // on, but held back by the browser until a click or key press
    soundInfo() { return sound.info(); },
    cineView(u) { if (walking) setWalk(false, false); const p = posCurve.getPointAt(u), t = tgtCurve.getPointAt(u); tween = null; camera.position.copy(p); controls.target.copy(t); clampCamera(); controls.update(); },
    setView(pos, target) { if (walking) setWalk(false, false); tween = null; camera.position.set(...pos); controls.target.set(...target); controls.update(); },
    heroView() { if (walking) setWalk(false, false); cinematic = false; controls.enabled = true; tween = null; camera.position.copy(DEFAULT.pos); controls.target.copy(DEFAULT.target); controls.update(); },
    advance(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt, false); },
    bench: probe,
    hashScene: () => hashScene(scene, { heightCache: world.heightCacheData() }),
    // bench: triangles per drawable (instances included; a model level's: those in the camera's view), largest first
    meshStats() {
      const out = [];
      scene.traverse((o) => {
        if (!o.isMesh && !o.isPoints && !o.isSprite) return;
        const g = o.geometry; if (!g) return;
        const tri = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
        const n = o.userData.level ? o.userData.level.vis : o.isInstancedMesh ? o.count : g.isInstancedBufferGeometry ? g.instanceCount : 1;
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
    birdInfo() { return birds.info(); }, // birds in the air per species, [x, y, z]
    koiInfo() { return koi.info(); }, // each koi's [x, y, z, heading]
    heronInfo() { return herons.info(); }, // the heron and the egrets: where each stands, its heading, its clip
    shootingStar() { sky.shootingStar(camera.getWorldDirection(new THREE.Vector3())); }, // one now, ahead of the camera
    // cull: the view culling (lods.js makeView): on, re-sorts so far and their mean main-thread ms, and per group the
    // instances (impostor cards, the walls' merged groups) the camera draws, of those it would unculled, and triangles
    info() {
      const groups = Object.fromEntries([...lodGroups.map((g) => [g.name, g.userData.counts()]), [walls.name, walls.userData.counts(camera)]]);
      const cull = { on: view.on, sorts: view.stats.sorts, sortMs: view.stats.ms / Math.max(1, view.stats.sorts), groups };
      return { tier: tierName, backend: backendName, tree: [TX, TZ], blossoms: main.data.n, gen: genStats, grass: grass.userData.levels.map((l) => l.range), verts: terrainGeo.attributes.position.count, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, cull };
    },
    // debug: per-instance view culling of the Blender models and impostors on or off (on by default)
    setCulling(on) { view.on = !!on; },
    dispose() { running = false; ro.disconnect(); controls.dispose(); walk.dispose(); if (walker) walker.dispose(); renderer.dispose(); sound.dispose(); },
  };
}

if (typeof window !== 'undefined') window.SakuraRiver = { create };
