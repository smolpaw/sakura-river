import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// three's KTX2Loader finds its own copy of the Basis transcoder by `new URL(…, import.meta.url)`, which the build would
// inline in the page (~0.75 MB); photos.js points it at public/basis/ (tools/textures.mjs) instead. Also used by
// bench/build.mjs.
export const noBundledTranscoder = () => ({
  name: 'no-bundled-transcoder',
  enforce: 'pre',
  transform(code, id) {
    if (!/[\\/]KTX2Loader\.js$/.test(id)) return null;
    const re = /new URL\( '\.\.\/libs\/basis\/basis_transcoder\.(?:wasm|js)', import\.meta\.url \)\.toString\(\)/g;
    if ((code.match(re) || []).length !== 2) throw new Error('KTX2Loader.js: the bundled transcoder\'s URLs are no longer where vite.config.js looks for them');
    return { code: code.replace(re, "''"), map: null };
  },
});

// `vite build` emits dist/index.html with all JS and CSS inlined — one self-contained file for the artifact.
export default defineConfig({
  plugins: [noBundledTranscoder(), viteSingleFile()],
});
