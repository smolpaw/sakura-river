// Kitten viewer for headless looks (bench/look.mjs drives it like the engine): kittens on a plain lawn.
import * as THREE from 'three/webgpu';
import { U, sceneFog, pcfSoftShadowFilter } from '../src/tsl.js';
import { kittenBodyData, kittenEyeData, kittenWhiskerData } from '../src/kitten-body.js';
import { KittenRig, POSTURES } from '../src/kitten-rig.js';
import { mulberry32 } from '../src/noise.js';
import { makeKittenModel } from '../src/kitten.js';
import { LitMaterial } from '../src/tsl.js';

export async function create(canvas, opts = {}) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: opts.backend === 'webgl' });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.55, 0.65, 0.8);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  camera.layers.enable(1);
  const sun = new THREE.DirectionalLight(0xfff0e0, 3);
  sun.position.set(2, 3, 2.5); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -1.5, right: 1.5, top: 1.5, bottom: -1.5, near: 0.1, far: 10 });
  sun.shadow.bias = -0.0005;
  scene.add(sun, new THREE.HemisphereLight(0xbcd0ff, 0x3a3a20, 0.9));
  U.uSunDir.value.copy(sun.position).normalize();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2), new LitMaterial({ color: new THREE.Color(0.12, 0.2, 0.06), roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);
  const data = { body: kittenBodyData(opts.cell || 0.0034), eyes: kittenEyeData(), whiskers: kittenWhiskerData() };
  const names = opts.postures || Object.keys(POSTURES);
  const kits = names.map((name, i) => {
    const m = makeKittenModel(data, { coat: i % 2 ? 'ginger' : 'calico', seed: i + 1, eyeColor: i % 2 ? [0.75, 0.45, 0.06] : [0.4, 0.45, 0.1] });
    scene.add(m.group);
    const rig = new KittenRig(() => 0, mulberry32(i + 1));
    rig.x = (i - (names.length - 1) / 2) * 0.4; rig.z = 0; rig.yaw = opts.yaw ?? 0.6;
    rig.setPosture(name, 100);
    return { m, rig };
  });
  let t = 0;
  function step(dt) {
    t += dt; U.uTime.value = t;
    for (const k of kits) { k.rig.update(dt, t); k.rig.write(k.m.bones); k.m.setDistance(camera.position.distanceTo(new THREE.Vector3(k.rig.x, 0.1, k.rig.z))); }
  }
  function resize() { const w = canvas.clientWidth, h = canvas.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  resize();
  const eng = {
    info: () => ({ verts: data.body.position.length / 3, tris: data.body.index.length / 3 }),
    // look settings: only=<i> shows one kitten at the origin, yaw=<rad> turns them all
    setImmediate(k, v) {
      if (k === 'only') kits.forEach((kk, i) => { kk.m.group.visible = i === v; if (i === v) kk.rig.x = 0; });
      if (k === 'yaw') kits.forEach((kk) => { kk.rig.yaw = v; });
    }, heroView() { eng.setView([0.2, 0.35, 1.6], [0, 0.1, 0]); },
    setView(p, tg) { camera.position.set(...p); camera.lookAt(...tg); },
    advance(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt); },
    tick(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) step(dt); renderer.render(scene, camera); },
    kits, backend: 'webgl',
  };
  eng.heroView();
  return eng;
}
