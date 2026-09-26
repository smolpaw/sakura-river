# Sakura River

Procedural Three.js scene (cherry tree, river, Fuji-style mountain). See README.md for commands, file layout and the engine API.

## Working here

- The owner cares about results, not about knowing the code. The GitHub issue workflow from the global instructions does not apply to this project. Any language or stack is fine when measurements show it helps.
- Active work: `docs/performance-plan.md`. Its Status section is the progress log.

## Conventions

- Everything is generated in code — no image, model or texture assets. Keep it that way unless asked.
- `three` is pinned to an exact version; the shader patching in `src/shaders.js` (`patch`) string-replaces three's built-in `#include <…>` chunks, so a three upgrade can silently break materials. Check visually after any bump.
- `src/ui.js` is page wiring only; scene logic belongs in the engine modules behind `create()`.

## Verifying changes

- Run `pnpm dev` and look at the scene in a browser. There are no automated tests.
- The engine handle (`window.SakuraRiver.create`'s return value) has debug hooks for headless checks: `setView(pos, target)`, `cineView(u)`, `tick(n, dt)`, `simulate(sec)`, `info()`; `create(canvas, { manual: true })` disables the RAF loop.

## Publishing

- The live page is the claude.ai artifact https://claude.ai/artifact/UmQeKrrzEj1KMDrSshWq6z. Update it in place by publishing `dist/index.html` (after `pnpm build`) with that URL. Publishing without the URL creates a new artifact.
