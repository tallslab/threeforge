# Memory and load with threeforge

The ledger's memory section estimates what the scene holds on the GPU (textures, geometries, render targets), counts
what the renderer still holds that the scene no longer references, and reports how many chunks a `Streamer` keeps
resident. Three modules act on it: `createLoader`, `ResourceTracker`, `Streamer`.

## What a resource costs

A texture costs `width × height × bytes per texel`, ×4/3 with mipmaps, ×6 for a cube; a compressed (KTX2) texture
costs the sum of its mip levels, typically a quarter to an eighth of the uncompressed size. A geometry costs its
attribute and index buffers. three r186 keeps a GPU copy of every geometry and texture it has rendered until
`dispose()` is called, and `renderer.info.memory` counts them (its byte fields are never updated, so threeforge
keeps its own estimates, labelled `estimated: true`). Budgets per tier: textures 512 / 192 / 96 MB, geometry
256 / 96 / 48 MB (desktop / phone-mid / phone-low).

## createLoader and `threeforge decoders`

```ts
import { createLoader, disposeLoader } from 'threeforge';
const loader = await createLoader(renderer, { decoders: '/_decoders/' });   // GLTFLoader with Draco, KTX2, meshopt
const gltf = await loader.loadAsync('/models/town.glb');
disposeLoader(loader);                                                        // ends the decoder workers
```

```bash
npx threeforge decoders public/_decoders
```

copies three's Draco decoder and Basis transcoder (from the installed three) into `public/_decoders/{draco,basis}`;
`decoders` can also be `{ draco, basis }` paths, and `draco`, `ktx2`, `meshopt` can be switched off. KTX2 formats
are detected on the renderer after `renderer.init()`, so KTX2 textures transcode to what the device supports
(ASTC on phones, BC on desktops). `threeforge optimize --textures webp` and `--compress meshopt` produce content
this loader reads.

## ResourceTracker and the leak check

```ts
import { ResourceTracker } from 'threeforge';
const tracker = new ResourceTracker({ registry });   // registry-owned materials are never disposed
tracker.track(gltf.scene);                            // the geometries, materials and textures below it
tracker.release(gltf.scene);                          // detaches it and disposes what no other tracked owner holds
```

`release` is reference-counted across owners: a texture shared by two loaded characters survives the first
release. `collectResources(root)` returns the sets; `unreferencedResources(renderer.info.memory, scene)` counts
the geometries and textures the renderer holds that nothing in the scene reaches.

The ledger reports that count as `memory.unreferenced` and warns with `unreferenced-resources` at eight or more.
The count is renderer counts minus reachable resources minus what three allocates for itself (one geometry, two
frame-buffer textures, two textures per shadow map, measured on both backends). Reachable includes material
textures, a BatchedMesh's matrix, indirect and colour textures, a skeleton's bone texture, the scene background and
environment, and textures a node material lists in `material.userData.forgeTextures` (AnimatedInstances lists its
animation texture; do the same for your own TSL materials). three uploads a texture only when it renders, so a
scene whose reachable textures never rendered reads low, never high: the count is exact once everything reachable
has been on screen. It is recounted with the graph statistics (at most every 60 frames);
`ledger.measureMemory()` recounts now.

## Streamer

```ts
import { Streamer } from 'threeforge';
const world = new World(scene, { chunkSize: 250, originals: 'detach' });
world.compile();
const streamer = new Streamer({ world, camera, radius: camera.far, margin: 1 });
// every frame, or from a RenderScheduler camera watcher:
streamer.update();
```

The index is `world.chunks()` (batches, instanced groups and baked meshes per cell) plus every static mesh that is a
direct child of the scene and was not compiled (terrain tiles, singletons), placed by the cell of its position;
`streamer.assign(object, cell)` overrides, `userData.forgeStream = false` opts out. Cells are keyed by x and z.

A chunk is resident while the distance from the camera to its box is at most `radius` (default `camera.far`,
so with a fog that reaches the far plane nothing visible ever pops: the streamed frame is pixel-identical to the
unstreamed one), and unloads past `radius + margin × chunkSize` (hysteresis, default one cell; the first update
places strictly). Unloading removes the chunk's objects from the scene and disposes the geometries and textures
no resident chunk shares (a BatchedMesh's matrix textures too, without `BatchedMesh.dispose()`, which would
destroy them); materials stay, the registry owns them. Loading adds the objects back and three re-uploads on the
next render: expect one frame of upload work per chunk that comes back. The CPU copies stay in the JS heap; nothing
is re-fetched. `stats()` gives `{ chunks, resident, loads, unloads }`, `onChange` the events, `dispose()` makes
everything resident again. `ledger.attachStreamer(streamer)` fills `memory.chunks`.

## Reading the section

| number | means | act with |
|---|---|---|
| `textures.bytes` above budget (`texture-bytes`) | too many uncompressed texels resident | KTX2 through `createLoader`, `threeforge optimize --textures`, stream chunks |
| `geometries.bytes` above budget (`geometry-bytes`) | too much geometry resident | `threeforge optimize --compress meshopt`, LODs, stream chunks |
| `unreferenced` ≥ 8 (`unreferenced-resources`) | removed without `dispose()` | `ResourceTracker.release`, a `Streamer` |
| `chunks.resident` close to `chunks.total` | the radius covers the world | a smaller `far` with fog, smaller chunks |

The zen benchmark (`pnpm bench`, scene `zen`): 50 000 objects on 64 ground tiles with a 512² texture each
(85 MB of textures with mipmaps), fog to 600 m. The optimized variant compiles in 250 m chunks and streams them:
32 of 64 chunks resident at the start camera, textures 85 MB → 43 MB, and the frame is identical to naive.
