// Loads the photographed texture sets (tools/textures.mjs, public/textures/, src/textures.json) for materials.js
// setPhotoTextures. They are KTX2 files with Basis Universal data (colour ETC1S, normals UASTC), which three's
// KTX2Loader transcodes in its workers to a format the GPU samples compressed (basis/, three's transcoder, served
// beside the page): BC7 on desktop GPUs, ETC2 (colour) and ASTC (normals) on mobile and Apple ones. The pictures stay
// compressed in GPU memory, and nothing is decoded or mipmapped on the main thread. The surface kinds' sets (those with
// a `layer`) come as the layers of two array textures (kinds_diff, kinds_nor), the others as single ones.
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const url = (n) => new URL(`textures/${n}.ktx2`, document.baseURI).href;

// On desktop Linux, Mesa's drivers offer ETC2 and ASTC on GPUs without them and decompress such textures in the driver
// (three's KTX2Loader avoids them there for WebGLRenderer only): where BC is offered too, the transcoder sticks to BC.
function formats(loader) {
  const c = loader.workerConfig;
  const linux = /Linux/.test(navigator.platform) && !/Android/.test(navigator.userAgent);
  if (linux && (c.bptcSupported || c.dxtSupported)) Object.assign(c, { etc1Supported: false, etc2Supported: false, astcSupported: false });
}

// -> { sets: { <name>: { diff, nor, size, mean } (the kinds' sets: size, mean, layer, aspect) }, layers: { names,
// diff, nor, aspect } }, or null when any fails to load (the surfaces keep their procedural look; so in a page opened
// as a file)
export function loadPhotos(renderer, meta) {
  let loader;
  try {
    loader = new KTX2Loader().setTranscoderPath(new URL('basis/', document.baseURI).href).detectSupport(renderer);
    formats(loader);
  } catch (e) {
    console.warn('photographed textures not loaded:', e && e.message);
    return Promise.resolve(null);
  }
  const load = (n) => loader.loadAsync(url(n));
  const kinds = Object.keys(meta).filter((n) => meta[n].layer !== undefined).sort((a, b) => meta[a].layer - meta[b].layer);
  const sets = Promise.all(Object.entries(meta).filter(([n]) => !kinds.includes(n)).map(([n, m]) =>
    Promise.all([load(`${n}_diff`), load(`${n}_nor`)]).then(([diff, nor]) => [n, { ...m, diff, nor }])));
  const layers = Promise.all([load('kinds_diff'), load('kinds_nor')])
    .then(([diff, nor]) => ({ names: kinds, diff, nor, aspect: kinds.map((n) => meta[n].aspect) }));
  return Promise.all([sets, layers])
    .then(([s, layers]) => (performance.mark('sr:photos'), { sets: { ...Object.fromEntries(s), ...Object.fromEntries(kinds.map((n) => [n, meta[n]])) }, layers }))
    .catch((e) => { console.warn('photographed textures not loaded:', e && e.message); return null; })
    .finally(() => loader.dispose());
}
