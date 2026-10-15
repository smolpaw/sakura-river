// The build's own plugins (vite.config.js; bench/build.mjs takes noBundledTranscoder).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// three's KTX2Loader finds its own copy of the Basis transcoder by `new URL(…, import.meta.url)`, which the build would
// inline in the page (~0.75 MB); photos.js points it at public/basis/ (tools/textures.mjs) instead.
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

// The files from public/ by their content hashes, for the page (__SR_ASSETS__: assets.js versions their URLs) and the
// service worker (src/sw.js, written into dist/ as sw.js with the hashes and the build's version filled in).
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
export function serviceWorker() {
  const assets = {};
  return {
    name: 'service-worker',
    apply: 'build',
    config(config) {
      const pub = path.resolve(config.publicDir || 'public');
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
        const f = path.join(dir, d.name);
        if (d.isDirectory()) walk(f);
        else assets[path.relative(pub, f).split(path.sep).join('/')] = hash(fs.readFileSync(f));
      });
      walk(pub);
      return { define: { __SR_ASSETS__: JSON.stringify(assets) } };
    },
    writeBundle(options) {
      const page = fs.readFileSync(path.join(options.dir, 'index.html'));
      const sw = fs.readFileSync(path.resolve('src/sw.js'), 'utf8')
        .replace("'__SR_VERSION__'", JSON.stringify(hash(Buffer.concat([page, Buffer.from(JSON.stringify(assets))]))))
        .replace('__SR_ASSETS__', JSON.stringify(assets));
      fs.writeFileSync(path.join(options.dir, 'sw.js'), sw);
    },
  };
}
