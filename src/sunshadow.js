// The sun's shadows beyond the sharp ones round the cherry tree (main.js): a second shadow map over the whole valley
// (the hills, the woods, the village, the temple, the bridge), and the clouds' shadows drifting over the land. The sun
// moves slowly, so the map is redrawn only when the sun has moved; its casters are on layer 3. Every lit material
// multiplies the sun by `sunShadow` (tsl.js R170LightingModel), and the hand-made sun terms (backlit grass and
// blossom, petals, water glints) follow.
import * as THREE from 'three/webgpu';
import { Fn, If, float, vec2, vec4, uniform, nodeObject, normalWorld, positionWorld, renderGroup, max, clamp, sin } from 'three/tsl';
import { sstep } from './tsl.js'; // (used only when the node is built, after tsl.js has loaded)

export const FAR_LAYER = 3;
// the valley's box: everything the camera can come near, and the hills round it
const BOX = new THREE.Box3(new THREE.Vector3(-480, -12, -640), new THREE.Vector3(480, 260, 330));

// (only its depth is read: the colour target it must have is one byte per texel: 192 MB less than RGBA at 8192)
const rt = new THREE.RenderTarget(1, 1, { depthBuffer: true, format: THREE.RedFormat });
rt.depthTexture = new THREE.DepthTexture(1, 1);
rt.depthTexture.compareFunction = THREE.LessEqualCompare;
rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.LinearFilter;
rt.texture.name = rt.depthTexture.name = 'FarShadow';

// (shared by every material: one buffer per render, not one per object)
const uMat = uniform(new THREE.Matrix4()).setGroup(renderGroup); // world -> (u, v, depth) in the map
// A depth-map lookup at uv as given, flipped here on WebGL (three's own texture node does it through a uniform it
// updates for every object that samples the map, every frame: ~5% of the CPU's frame here)
class MapLookup extends THREE.TextureNode {
  setupUV(builder, uv) { return builder.isFlipY() ? vec2(uv.x, float(1.0).sub(uv.y)) : uv; }
}
const uTexel = uniform(new THREE.Vector2(1, 1)).setGroup(renderGroup); // one texel: in uv, and in metres (normal offset)
const uOn = uniform(0).setGroup(renderGroup);
// the clouds: their drift (the sky's cloud offset, sky.js) and cover (0..1), and the sun's direction
export const CLOUDS = {
  uPos: uniform(new THREE.Vector2()).setGroup(renderGroup),
  uCover: uniform(0.35).setGroup(renderGroup),
  uSun: uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup),
};

// 1 in sunlight, 0 in the valley's shadow: one bilinear compare (a 2x2 texel filter; at its scale, a fraction of a
// metre, that is soft enough). The receiver is pushed out along its normal by a texel and a half, and the depth back a
// little, so surfaces that are casters too (the terrain, the buildings) do not shadow themselves.
const farShadow = Fn(([pos, nrm]) => {
  const s = float(1.0).toVar();
  If(uOn.greaterThan(0.0), () => {
    const p = uMat.mul(vec4(pos.add(nrm.mul(uTexel.y.mul(1.5))), 1.0)).toVar();
    const uv = vec2(p.x, float(1.0).sub(p.y)).toVar();
    const inside = uv.x.greaterThan(0.0).and(uv.x.lessThan(1.0)).and(uv.y.greaterThan(0.0)).and(uv.y.lessThan(1.0)).and(p.z.lessThan(1.0));
    If(inside, () => { s.assign(nodeObject(new MapLookup(rt.depthTexture, uv)).compare(p.z.sub(0.0004))); });
  });
  return s;
});

// The clouds' shadows: a cloud layer CLOUD_H up, a pattern drifting with the sky's clouds, thresholded
// by the cover as the sky's are; where the sun's ray through the point meets it, 70% of the sun is held back. Under
// a full overcast the sun is already dim and even (weather.js), so the patches fade out there.
const CLOUD_H = 900;
const cloudShadow = Fn(([pos]) => {
  const s = float(1.0).toVar();
  const k = sstep(0.15, 0.3, CLOUDS.uCover).mul(sstep(0.95, 0.8, CLOUDS.uCover)).toVar();
  If(k.greaterThan(0.0), () => {
    const L = CLOUDS.uSun;
    const q = pos.xz.add(L.xz.mul(float(CLOUD_H).sub(pos.y).div(max(L.y, 0.12))));
    const c = q.div(150.0).add(CLOUDS.uPos.mul(3.2)).toVar();
    // (interfering waves, not noise: hashed noise in every lit material cost ~1 s of pipeline compilation at start-up)
    const w = c.add(vec2(sin(c.y.mul(0.83).add(1.7)), sin(c.x.mul(0.71).sub(0.4))).mul(0.9));
    const n = sin(w.x.mul(1.37)).mul(sin(w.y.mul(1.13).add(0.6))).mul(0.35).add(sin(w.x.mul(0.53).add(w.y.mul(0.61)).add(2.1)).mul(0.15)).add(0.5);
    const t = float(0.66).sub(CLOUDS.uCover.sub(0.35).mul(0.5));
    s.assign(float(1.0).sub(sstep(t.sub(0.08), t.add(0.1), n).mul(clamp(k, 0.0, 1.0)).mul(0.7)));
  });
  return s;
});

// The sun's shadow at a point (pushed out along `nrm` against self-shadowing), for a material that looks it up
// elsewhere than its own surface (the woods' impostors, impostors.js: their flat cards stand inside their trees)
export const sunShadowAt = (pos, nrm) => farShadow(pos, nrm).mul(cloudShadow(pos));
// One node shared by every material, so a material that uses it twice (the lighting and its own sun terms) samples
// it once.
export const sunShadow = sunShadowAt(positionWorld, normalWorld);

const bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export function makeFarShadow(renderer, size) {
  rt.setSize(size, size);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2);
  cam.layers.set(FAR_LAYER);
  const mat = new THREE.NodeMaterial();
  mat.colorNode = vec4(0, 0, 0, 1);
  mat.isShadowPassMaterial = true; // the renderer keeps each object's own positionNode and alpha cut-out
  mat.fog = false;
  mat.blending = THREE.NoBlending;
  const last = new THREE.Vector3(0, -1, 0), corner = new THREE.Vector3();
  const lightBox = new THREE.Box3();
  let wait = 0;
  uOn.value = renderer.shadowMap.enabled ? 1 : 0;
  // without comparison sampling (Android WebGPU in compatibility mode, main.js turns shadows off there) a depth texture
  // that keeps its compare function is declared for comparison and sampled without, which compatibility mode rejects:
  // every lit material's pipeline would fail. The lookup is never taken there (uOn is 0), it only has to compile.
  if (renderer.backend.compatibilityMode && !renderer.hasCompatibility(THREE.Compatibility.TEXTURE_COMPARE)) {
    rt.depthTexture.compareFunction = null;
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
  }

  function render(scene, toSun) {
    // the light's frame looking down the sun's rays, fitted round the valley's box
    cam.position.copy(BOX.getCenter(corner)).addScaledVector(toSun, 2000);
    cam.up.set(0, 1, 0);
    if (Math.abs(toSun.y) > 0.999) cam.up.set(0, 0, 1);
    cam.lookAt(BOX.getCenter(corner));
    cam.updateMatrixWorld();
    lightBox.makeEmpty();
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? BOX.max.x : BOX.min.x, i & 2 ? BOX.max.y : BOX.min.y, i & 4 ? BOX.max.z : BOX.min.z).applyMatrix4(cam.matrixWorldInverse);
      lightBox.expandByPoint(corner);
    }
    cam.left = lightBox.min.x; cam.right = lightBox.max.x; cam.bottom = lightBox.min.y; cam.top = lightBox.max.y;
    // anything between the sun and the box casts into it (hills beyond its edge at a low sun)
    cam.near = Math.max(1, -lightBox.max.z - 1500); cam.far = -lightBox.min.z + 5;
    cam.coordinateSystem = renderer.coordinateSystem;
    cam.updateProjectionMatrix();
    const m = uMat.value.copy(bias);
    if (cam.coordinateSystem === THREE.WebGPUCoordinateSystem) { m.elements[10] = 1; m.elements[14] = 0; }
    m.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    uTexel.value.set(1 / size, Math.max(cam.right - cam.left, cam.top - cam.bottom) / size);

    const prevTarget = renderer.getRenderTarget(), prevOverride = scene.overrideMaterial;
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    scene.overrideMaterial = mat;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    scene.overrideMaterial = prevOverride;
  }

  return {
    // toSun: towards the sun. Redrawn once the sun has moved by more than ~0.04 degrees (only a time-lapse moves it),
    // at most every `every` frames; `force` redraws now. A redraw costs ~1.5 ms of GPU time at 4096 (RTX 2060), so
    // not every frame. Not drawn with the sun down, except on the warm-up (`warm`): a page opened at night would
    // otherwise build every caster's pipeline for it in one frame as the first time-lapse brings the sun up (a
    // visible freeze); the map drawn from below the ground is never seen, as the sun is dark until it is redrawn.
    update(scene, toSun, { every = 8, force = false, warm = false } = {}) {
      wait--;
      if (!uOn.value || (toSun.y < -0.05 && !warm)) return false;
      if (!force && (wait > 0 || last.dot(toSun) > 0.9999998)) return false;
      last.copy(toSun);
      wait = every;
      render(scene, toSun);
      return true;
    },
  };
}