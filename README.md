# digimaxstlsplitter

Split a large STL / 3MF / GLB into printable, **guaranteed-watertight** tiles for a given printer bed.
Runs entirely in the browser — nothing is uploaded. **Live: https://digimaxstlsplitter.pages.dev**

## Why another splitter

We had a Ø998 mm terrain model that passed every mesh check, yet the printer kept reporting *open edges*.
The cause was the splitter: it capped each cut by re-triangulating the open loop, and those caps were broken.
Every clean file we sent came back broken — the splitter was the bug.

This tool cuts with [Manifold](https://github.com/elalish/manifold) booleans, so cut faces are closed by
construction, and then **does not trust the engine**: every tile is audited independently (every edge
shared by exactly two triangles, one shell), the tile sizes are checked against the bed, and the tile
volumes must sum to the source volume. Download is blocked unless everything passes.

## Features

- Input: binary/ASCII STL, 3MF (unit-aware), GLB (metres Y-up → mm Z-up, `KHR_mesh_quantization` handled)
- Pre-flight audit of the input; refuses to cut an open mesh (cutting an open mesh only makes more open edges)
- Welds vertices, drops zero-area triangles, puts the base on z=0
- Auto grid from bed size + margin, or a manual N × M grid
- Optional dowel holes on the cut faces, placed only where both sides are solid
- Output: per-tile STL + 3MF in a zip, with a README layout map and the audit table
- Also re-exports the cleaned source as one closed STL / 3MF

## Limits

- WASM memory: a few million triangles is fine; beyond that use the engine from Node (see `test/`)
- Grid cuts only (no pie sectors yet — PRs welcome)
- Hollowing / shelling is not done here; do it in your slicer

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # node --test; cuts a synthetic terrain disc and round-trips the writers
npm run build    # static site in dist/
```

The engine (`src/engine.js`, `src/mesh.js`, `src/parsers.js`, `src/export.js`) has no DOM dependency and
runs in Node:

```js
import Module from 'manifold-3d';
import { parseSTL } from './src/parsers.js';
import { tile } from './src/engine.js';
const wasm = await Module(); wasm.setup();
const mesh = parseSTL(fs.readFileSync('model.stl').buffer);
const r = tile(wasm, mesh, { bed: [220, 220, 250], margin: 10 });
```

## Licence

MIT. Built by [Divergent Inc](https://github.com/divergentinc2021) after one too many broken tile sets.
