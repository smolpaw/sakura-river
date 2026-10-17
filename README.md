# Sakura River

[![A cherry tree in bloom by a river, a red drum bridge, a pagoda and a snow-capped mountain](docs/screenshot.jpg)](https://smolpaw.github.io/sakura-river/)

A Japanese river valley in spring that runs in your browser. A cherry tree blooms by the river below a snow-capped mountain. Around it are a farming village on stone terraces, rice paddies, a temple on a knoll and wooded hills. Deer, herons, ducks and fireflies come and go with the hour, and villagers go about their day.

**[Open the scene](https://smolpaw.github.io/sakura-river/)**

- Pick any time of day and one of seven weathers, from spring haze to a thunderstorm.
- Walk the valley in first person, or sit back for a cinematic flight.
- Almost everything is generated in code with Three.js. The models are built by Blender scripts.
- Uses WebGPU where the browser has it, and WebGL2 elsewhere.

## Controls

| | |
|---|---|
| Look around | drag |
| Zoom | scroll or pinch |
| Pan | right-drag |
| Walk mode | W A S D or the arrow keys, mouse to look, Shift to hurry; on touch, the left thumb walks and the right one looks |
| Hide the interface | H |

The panel sets the weather, the time and the sound. The link button copies the current view.

## Running it locally

    pnpm install
    pnpm dev

See [docs/development.md](docs/development.md) for the build, the asset scripts, the file layout and the engine API.

## Credits

The music is by [PeriTune](https://peritune.com) (CC BY 4.0). The nature sounds are field recordings from BigSoundBank, Freesound, radio aporee and xeno-canto. The boulder scans and the photographed textures come from [Poly Haven](https://polyhaven.com) (CC0). The fonts are Shippori Mincho and Zen Kaku Gothic New (SIL OFL 1.1). [CREDITS.md](CREDITS.md) lists every asset with its author and licence.
