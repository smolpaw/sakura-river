import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build` emits dist/index.html with all JS and CSS inlined — one self-contained file for the artifact.
export default defineConfig({
  plugins: [viteSingleFile()],
});
