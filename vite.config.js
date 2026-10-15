import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { noBundledTranscoder, serviceWorker } from './vite.plugins.mjs';

// `vite build` emits dist/index.html with all JS and CSS inlined — one self-contained file for the artifact — and
// copies public/ beside it.
export default defineConfig({
  plugins: [noBundledTranscoder(), serviceWorker(), viteSingleFile()],
});
