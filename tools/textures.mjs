// Builds public/textures/ from the photographed texture sets credited in README.md (Textures), and src/textures.json:
// per set its size in metres (as Poly Haven gives it) and its average colour (linear), which the shaders divide by to
// lay a photo over a surface's own colour as detail (materials.js); for the surface kinds' sets also their layer in
// the kinds' texture arrays and their height / width.
//   node tools/textures.mjs              fetch, encode, and copy the transcoder
//   node tools/textures.mjs --transcoder only copy three's Basis transcoder into public/basis/ (after a three upgrade)
// Sources (Poly Haven, CC0) are downloaded once into tools/.texture-cache/ and encoded as KTX2 with Basis Universal
// supercompression, which three's KTX2Loader transcodes to a format the GPU samples compressed (photos.js): the colour
// maps as ETC1S (BasisLZ; BC7 on desktop GPUs, ETC2 on mobile ones), the normal maps as UASTC with Zstandard (BC7 or
// ASTC). In ETC1S the normal maps' 4x4 blocks showed as steps in the shading of the close-up stone; the colour maps
// show no blocks in ETC1S. The encoder is KTX-Software's `ktx` (Linux x86-64 release, fetched into the cache and
// checked against its hash). The surface kinds' sets (ARRAY) are packed into one array texture per map
// (kinds_diff.ktx2, kinds_nor.ktx2), every layer at ARRAY_SIZE square. docs/performance.md (Photographed textures) has
// the sizes and what was tried.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'tools', '.texture-cache');
const OUT = path.join(ROOT, 'public', 'textures');
const BASIS = path.join(ROOT, 'public', 'basis');
// name -> resolution, or per map (diff, nor): what is seen from a metre or two gets 2k colour, the rest 1k. Every normal
// map is 1k: in UASTC a 2k one is ~5 MB against ~1.3 MB (docs/performance.md, Photographed textures).
const NEAR = { diff: '2k', nor: '1k' };
const SETS = {
  sakura_bark: NEAR, lichen_rock: NEAR, stony_dirt_path: NEAR,
  thatch_roof_angled: '1k', weathered_planks: '1k', grey_plaster_02: '1k', grey_roof_tiles: '1k', japanese_stone_wall: '1k', rock_surface: '1k', japanese_cedar_bark: '1k',
  gravel_ground_01: '1k', forrest_ground_01: '1k', brown_mud_02: '1k',
};
// the surface kinds' sets (materials.js PHOTO_KIND), in their layers' order; each squeezed to ARRAY_SIZE square (a
// taller one, the woods' bark, is stretched back by its aspect in the shader)
const ARRAY = ['thatch_roof_angled', 'weathered_planks', 'grey_plaster_02', 'japanese_stone_wall', 'grey_roof_tiles', 'rock_surface', 'japanese_cedar_bark', 'gravel_ground_01'];
const ARRAY_SIZE = 1024;
// colour: ETC1S at its highest quality level (its blocks cap the quality, the level costs only size); normals: UASTC
// without rate-distortion optimisation (at a lambda of 3-4 it saved 15-20% and brought back ETC1S's error)
const CODEC = {
  diff: ['--format', 'R8G8B8_SRGB', '--assign-tf', 'srgb', '--encode', 'basis-lz', '--clevel', '4', '--qlevel', '255'],
  nor: ['--format', 'R8G8B8_UNORM', '--assign-tf', 'linear', '--encode', 'uastc', '--uastc-quality', '2', '--zstd', '20'],
};
const KTX = {
  version: '4.4.2',
  sha256: 'a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245',
};

// three's Basis transcoder, served beside the page (photos.js points KTX2Loader at basis/)
function copyTranscoder() {
  const src = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
  fs.mkdirSync(BASIS, { recursive: true });
  for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) fs.copyFileSync(path.join(src, f), path.join(BASIS, f));
  console.log(path.relative(ROOT, BASIS), 'from three', JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'three', 'package.json'))).version);
}
copyTranscoder();
if (process.argv.includes('--transcoder')) process.exit(0);

// KTX-Software's release, downloaded and unpacked into a directory of its own
async function ktxTool() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('tools/textures.mjs fetches the Linux x86-64 build of KTX-Software');
  const name = `KTX-Software-${KTX.version}-Linux-x86_64`, dir = path.join(CACHE, name), bin = path.join(dir, name, 'bin', 'ktx');
  if (!fs.existsSync(bin)) {
    const url = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX.version}/${name}.tar.bz2`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const sum = crypto.createHash('sha256').update(buf).digest('hex');
    if (sum !== KTX.sha256) throw new Error(`${url}: sha256 ${sum}, expected ${KTX.sha256}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const tar = path.join(dir, `${name}.tar.bz2`);
    fs.writeFileSync(tar, buf);
    execFileSync('tar', ['-xjf', tar, '-C', dir]);
    fs.rmSync(tar);
  }
  return (args) => execFileSync(bin, args, { env: { ...process.env, LD_LIBRARY_PATH: path.join(dir, name, 'lib') }, stdio: ['ignore', 'pipe', 'inherit'] });
}

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const ktx = await ktxTool();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-textures-'));
// a source as the PNG the encoder reads: rows flipped (three samples a compressed texture's first row at v = 0, where
// it puts an image's bottom row), no colour profile (the encoder rejects Poly Haven's), at `size` square if given
const png = (src, size) => {
  const dst = path.join(tmp, path.basename(src, '.jpg') + '.png');
  execFileSync('magick', [src, '-strip', '-flip', ...(size ? ['-resize', `${size}x${size}!`] : []), '-depth', '8', '-type', 'TrueColor', `PNG24:${dst}`]);
  return dst;
};
// colour maps are sRGB, normal maps linear; mip levels down to 1x1, filtered across the tile's edges (the sets repeat)
const encode = (inputs, map, dst) => {
  ktx(['create', ...CODEC[map], '--generate-mipmap', '--mipmap-wrap', 'wrap', ...(inputs.length > 1 ? ['--layers', String(inputs.length)] : []), ...inputs, dst]);
  console.log(path.relative(ROOT, dst), Math.round(fs.statSync(dst).size / 1024), 'KB');
};

const meta = {}, layers = { diff: [], nor: [] };
try {
  for (const [name, sizes] of Object.entries(SETS)) {
    const info = await (await fetch(`https://api.polyhaven.com/info/${name}`)).json();
    for (const map of ['diff', 'nor_gl']) {
      const m = map === 'nor_gl' ? 'nor' : map, res = typeof sizes === 'string' ? sizes : sizes[m];
      const file = `${name}_${map}_${res}.jpg`, src = path.join(CACHE, file);
      if (!fs.existsSync(src)) {
        const url = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${res}/${name}/${file}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        fs.writeFileSync(src, Buffer.from(await r.arrayBuffer()));
      }
      if (ARRAY.includes(name)) layers[m][ARRAY.indexOf(name)] = png(src, ARRAY_SIZE);
      else encode([png(src)], m, path.join(OUT, `${name}_${m}.ktx2`));
      if (map === 'diff') {
        // the average of the linear colour (the shader's), not the linear of the average sRGB
        const px = execFileSync('magick', [src, '-resize', '64x64!', '-depth', '8', 'rgb:-']);
        const sum = [0, 0, 0];
        for (let i = 0; i < px.length; i += 3) for (let k = 0; k < 3; k++) sum[k] += lin(px[i + k] / 255);
        meta[name] = { size: +(info.dimensions[0] / 1000).toFixed(3), mean: sum.map((s) => +(s / (px.length / 3)).toFixed(4)) };
        if (ARRAY.includes(name)) {
          const [w, h] = execFileSync('magick', ['identify', '-format', '%w %h', src], { encoding: 'utf8' }).split(' ').map(Number);
          Object.assign(meta[name], { layer: ARRAY.indexOf(name), aspect: h / w });
        }
      }
    }
  }
  for (const m of ['diff', 'nor']) encode(layers[m], m, path.join(OUT, `kinds_${m}.ktx2`));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
fs.writeFileSync(path.join(ROOT, 'src', 'textures.json'), JSON.stringify(meta, null, 2) + '\n');
