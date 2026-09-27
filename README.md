# Sakura River

A full-screen, interactive 3D scene built with Three.js. It shows a cherry tree beside a river that flows from a snow-capped, Fuji-style mountain, with a vermilion bridge, a stone lantern, a pagoda and koi in the river. From dusk into the night, string lights in the tree come on. Everything is generated in code: terrain, tree, grass, rocks, water, sky and petals. No image assets are used.

Live: https://smolpaw.github.io/sakura-river/ (deployed by GitHub Actions on every push to `main`).

## Develop

    pnpm install
    pnpm dev       # Vite dev server with live reload at http://localhost:5173
    pnpm build     # dist/index.html: one self-contained file (all JS and CSS inlined)
    pnpm preview   # serve the production build

`dist/index.html` opens directly in a browser; it is the deliverable.

## Layout

- `index.html`: page markup (title, control bar, buttons, loading veil).
- `src/ui.js`: wires the page controls to the engine.
- `src/style.css`: page styles.
- `src/main.js`: engine entry point: renderer, scene assembly, camera and controls, post-processing chain, adaptive quality, and the public API.
- `src/world.js`: height field, river path, terrain mesh, river ribbon, water-depth map and the finer map of rocks in the water.
- `src/tree.js`: procedural cherry tree (Somei Yoshino form), single-flower blossoms, string-light positions and their baked glow, bark and flower textures.
- `src/vegetation.js`: instanced grass (split into tiles for frustum culling), wildflowers, rocks and distant forest.
- `src/props.js`: Fuji-style volcano, stone lantern, arched bridge and pagoda.
- `src/water.js`: river shader and planar reflections.
- `src/koi.js`: koi swimming under the river surface.
- `src/sky.js`: sky dome, clouds and time-of-day palette.
- `src/petals.js`: simulated falling petals and the fallen-petal carpet.
- `src/fx.js`: petal, pollen-mote and string-light materials.
- `src/post.js`: light shafts pass and final grade (sharpening, local contrast, vignette).
- `src/tsl.js`: shared uniforms, noise, wind, height fog and the lit material (TSL: compiles to WGSL and GLSL).
- `src/materials.js`: the scene's lit materials.
- `src/quality.js`: adaptive quality controller.
- `src/gen/`: worker pool that runs the procedural generation jobs during loading.
- `src/noise.js`: seeded RNG, simplex noise and fbm.

## Engine API

    import { create } from './src/main.js';   // also exposed as window.SakuraRiver.create
    const scene = create(canvas, { quality, onStats, onCinematicChange });
    scene.set('wind' | 'petals' | 'river' | 'time' | 'fog' | 'bloom', value0to1);
    scene.setCinematic(true | false);
    scene.setAutoOrbit(true | false);
    scene.resetCamera();
    scene.dispose();

`quality` is optional ('high', 'medium' or 'low'). When it's left out, the quality level is picked from the device.
