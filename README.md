# Sakura River

A full-screen, interactive 3D scene built with Three.js. It shows a cherry tree beside a river that flows from a snow-capped, Fuji-style mountain, with a vermilion bridge, a stone lantern and a pagoda. Everything is generated in code: terrain, tree, grass, rocks, water, sky and petals. No image assets are used.

## Build

    npm install
    npm run build

This writes:
- `dist/sakura.js`, the bundled engine, which exposes `window.SakuraRiver.create(canvas, options)`.
- `dist/sakura-river.html`, the finished page: one self-contained file you can open directly in a browser.

`npm run build:engine` rebuilds only the engine bundle.

## Layout

- `src/main.js`: renderer, scene assembly, camera and controls, post-processing chain, adaptive quality, and the public API.
- `src/world.js`: height field, river path, terrain mesh, river ribbon and water-depth map.
- `src/tree.js`: procedural cherry tree growth, bark and blossom textures.
- `src/vegetation.js`: instanced grass (split into tiles for frustum culling), wildflowers, rocks and distant forest.
- `src/props.js`: Fuji-style volcano, stone lantern, arched bridge and pagoda.
- `src/water.js`: river shader and planar reflections.
- `src/sky.js`: sky dome, clouds and time-of-day palette.
- `src/petals.js`: simulated falling petals, fallen-petal carpet and pollen motes.
- `src/post.js`: light shafts pass and final grade (sharpening, local contrast, vignette).
- `src/shaders.js`: shared uniforms, wind and height-fog GLSL, material patching.
- `src/noise.js`: seeded RNG, simplex noise and fbm.
- `page/template.html`: the page UI (title, control bar, buttons). The build inlines the engine at `/*__ENGINE__*/`.

## Engine API

    const scene = SakuraRiver.create(canvas, { quality, onStats, onCinematicChange });
    scene.set('wind' | 'petals' | 'river' | 'time' | 'fog' | 'bloom', value0to1);
    scene.setCinematic(true | false);
    scene.setAutoOrbit(true | false);
    scene.resetCamera();
    scene.dispose();

`quality` is optional ('high', 'medium' or 'low'). When it's left out, the quality level is picked from the device.
