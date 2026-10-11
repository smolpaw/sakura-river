// Loads the photographed texture sets (tools/textures.mjs, public/textures/, src/textures.json) for materials.js
// setPhotoTextures, decoding every picture off the main thread: decoded where three uploads it, a picture holds the
// main thread ~25 ms a megapixel (docs/performance.md). The surface kinds' sets (materials.js PHOTO_KIND) come packed
// as texture array layers by photo-worker.js, the others as single textures.
import * as THREE from 'three/webgpu';
import PhotoWorker from './photo-worker.js?worker&inline';

const url = (n) => new URL(`textures/${n}.webp`, document.baseURI).href;

// -> { sets: { <name>: { diff, nor, size, mean } }, layers: { names, width, height, diff, nor, aspect } }, or null
// when any fails to load (the surfaces keep their procedural look)
export function loadPhotos(meta, kindSets) {
  const bitmaps = new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const single = (n) => bitmaps.loadAsync(url(n)).then((b) => {
    const t = new THREE.Texture(b);
    t.flipY = false; // (flipped as decoded: an ImageBitmap uploads as it is)
    t.needsUpdate = true;
    return t;
  });
  const sets = Promise.all(Object.entries(meta).filter(([n]) => !kindSets.includes(n)).map(([n, m]) =>
    Promise.all([single(`${n}_diff`), single(`${n}_nor`)]).then(([diff, nor]) => [n, { ...m, diff, nor }])));
  const layers = new Promise((resolve, reject) => {
    const w = new PhotoWorker();
    w.onmessage = ({ data }) => { w.terminate(); data.error ? reject(new Error(data.error)) : resolve({ names: kindSets, ...data }); };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'photo worker failed')); };
    w.postMessage({ urls: kindSets.map((n) => [url(`${n}_diff`), url(`${n}_nor`)]) });
  });
  return Promise.all([sets, layers])
    .then(([s, layers]) => ({ sets: { ...Object.fromEntries(s), ...Object.fromEntries(kindSets.map((n) => [n, meta[n]])) }, layers }))
    .catch((e) => { console.warn('photographed textures not loaded:', e && e.message); return null; });
}
