import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { noBundledTranscoder, serviceWorker } from './vite.plugins.mjs';

// `vite build` emits dist/index.html with all JS and CSS inlined — one self-contained file — and copies public/ beside
// it. __BENCH__ is false here, so the page leaves out what only the benches use (bench/build.mjs sets it true).
export default defineConfig({
  define: { __BENCH__: 'false' },
  plugins: [noBundledTranscoder(), serviceWorker(), viteSingleFile()],
});
