// Builds public/textures/ from the photographed texture sets credited in README.md (Textures), and src/textures.json:
// per set its size in metres (as Poly Haven gives it) and its average colour (linear), which the shaders divide by to
// lay a photo over a surface's own colour as detail (materials.js).
//   node tools/textures.mjs
// Sources (Poly Haven, CC0) are downloaded once into tools/.texture-cache/ and re-encoded as WebP. The normal maps at
// quality 92 looked the same in the scene as at 80 and cost 0.8 MB more each.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'tools', '.texture-cache');
const OUT = path.join(ROOT, 'public', 'textures');
// name -> resolution (what is seen from a metre or two gets 2k, the rest 1k)
const SETS = {
  sakura_bark: '2k', lichen_rock: '2k', stony_dirt_path: '2k',
  thatch_roof_angled: '1k', weathered_planks: '1k', grey_plaster_02: '1k', grey_roof_tiles: '1k', japanese_stone_wall: '1k', rock_surface: '1k', japanese_cedar_bark: '1k',
  ganges_river_pebbles: '1k', gravel_ground_01: '1k', forrest_ground_01: '1k', brown_mud_02: '1k',
};
const QUALITY = { diff: 82, nor_gl: 80 };

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const meta = {};
for (const [name, res] of Object.entries(SETS)) {
  const info = await (await fetch(`https://api.polyhaven.com/info/${name}`)).json();
  for (const [map, q] of Object.entries(QUALITY)) {
    const file = `${name}_${map}_${res}.jpg`, src = path.join(CACHE, file);
    if (!fs.existsSync(src)) {
      const url = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${res}/${name}/${file}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      fs.writeFileSync(src, Buffer.from(await r.arrayBuffer()));
    }
    const dst = path.join(OUT, `${name}_${map === 'nor_gl' ? 'nor' : map}.webp`);
    execFileSync('magick', [src, '-quality', String(q), '-define', 'webp:method=6', dst]);
    console.log(path.relative(ROOT, dst), Math.round(fs.statSync(dst).size / 1024), 'KB');
    if (map === 'diff') {
      // the average of the linear colour (the shader's), not the linear of the average sRGB
      const px = execFileSync('magick', [src, '-resize', '64x64!', '-depth', '8', 'rgb:-']);
      const sum = [0, 0, 0];
      for (let i = 0; i < px.length; i += 3) for (let k = 0; k < 3; k++) sum[k] += lin(px[i + k] / 255);
      meta[name] = { size: +(info.dimensions[0] / 1000).toFixed(3), mean: sum.map((s) => +(s / (px.length / 3)).toFixed(4)) };
    }
  }
}
fs.writeFileSync(path.join(ROOT, 'src', 'textures.json'), JSON.stringify(meta, null, 2) + '\n');
