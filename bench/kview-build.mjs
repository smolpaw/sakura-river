import { build } from 'vite';
import path from 'node:path';
const ROOT = '/home/smol/code-files/sakura-river';
await build({ root: ROOT, configFile: false, logLevel: 'warn', build: { outDir: path.join(ROOT, 'bench/builds/kview'), emptyOutDir: true, target: 'es2022', minify: false, reportCompressedSize: false,
  lib: { entry: path.join(ROOT, 'bench/kview.js'), formats: ['es'], fileName: () => 'engine.js' }, rolldownOptions: { output: { codeSplitting: false } } } });
console.log('built');
