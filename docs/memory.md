# Memory and load with threeforge

The ledger's memory section estimates what the scene holds on the GPU (textures, geometries, render targets), counts
what the renderer still holds that the scene no longer references, and reports how many chunks a `Streamer` keeps
resident. Three modules act on it: `createLoader`, `ResourceTracker`, `Streamer`.

## What a resource costs

A texture costs `width × height × bytes per texel` (channels from its format, bytes per channel from its type: an
R8 texture is a quarter of RGBA8), ×1.333 with generated mipmaps, ×6 for a cube, × the layers of a 3D or array
texture. A texture in a GPU block format costs the sum of its mip levels: a quarter of RGBA8 for ASTC 4x4, BC7, BC3
and ETC2 with alpha (16 bytes a 4 x 4 block), an eighth for ETC2 and BC1 (8 bytes).

The file format is not the GPU format. WebP, AVIF, JPEG and PNG all decode to the same RGBA8, so re-encoding one as
another makes the download smaller and leaves resident bytes where they were; at unchanged dimensions only a GPU block
format lowers them, and smaller dimensions lower them whatever the encoding. `.ktx2` is a container: a Basis payload
(ETC1S or UASTC) is transcoded on the device to the best block format it has (three r186 ranks ETC2, ETC1, BC7, BC3/BC1
for ETC1S and ASTC, BC7, ETC2 for UASTC). A device with none of them is not a slower path but an unsupported one:
KTX2Loader falls back to RGBA8 at full cost inside a `CompressedTexture`, three r186 can upload that on neither backend,
and the maps would draw black. `createLoader` therefore rejects a model with KTX2 textures on such a device, with an
error that says so, and loads models without them as usual: keep a PNG, JPEG or WebP variant for those. WebGPU adapters
have BC, or ETC2 and ASTC, so in practice this is a WebGL2 device with no compressed-texture extension. Read
`texture.format` on what was loaded, or the ledger's bytes, before counting on a saving. Measured on the 64 x 64
fixtures of `test/fixtures/ktx2` (four maps, WebGL2 on SwiftShader and WebGPU on Apple Metal alike): PNG 6.6 KB to
download and 87.4 KB resident, ETC1S 8.7 KB and 13.7 KB (ETC2), UASTC 12.5 KB and 22.0 KB (ASTC 4x4). A geometry costs
its
attribute and index buffers. three r186 keeps a GPU copy of every geometry and texture it has rendered until
`dispose()` is called, and `renderer.info.memory` counts them with byte sizes of its own
(a compressed texture counts 1 byte), which the ledger reports as `memory.measured` beside its estimates
(`estimated: true`). Budgets per tier: textures 512 / 192 / 96 MB, geometry
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
(which one is three's ranking above). `threeforge optimize --textures webp` and `--compress meshopt` produce content
this loader reads. The decoders are fetched when a file needs them, so an app that loads no KTX2 or Draco content needs
none. A model with KTX2 textures whose transcoder is incomplete (`basis_transcoder.js` or `basis_transcoder.wasm`
answered with a 404, or with a dev server's page) fails with an error naming that file and `threeforge decoders`, where
three alone would deliver the model without its maps or never settle; other models keep loading through the same
loader.

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
The count is renderer counts minus reachable resources minus what three allocates for itself (one geometry, the
frame-buffer targets' textures, two textures per shadow map three has built and two more per non-point VSM map, the overdraw
count target once the ledger has measured overdraw, and three's 16 × 16 `DFG_LUT` lookup texture, which three creates
once a Standard or Physical material is lit and the ledger counts through `renderer.info` while attached; measured on
both backends). It also allows what three r186 holds for its own node features, identified from its source: the
plane geometries and textures of PMREMNode's own `PMREMGenerator` (an equirect or cube `environment`, `background` or
`envMap`), the background sphere, one morph texture per morphed geometry, the textures of a render target a render
drew into until that target is disposed (post-processing and bloom targets, CubeMapNode's cube, a mirror), and the
frame-buffer targets three actually holds. A LUT three created before `ledger.attach()` is not seen and reads as one unreferenced texture; a
shadow map built but not rendered yet is allowed textures three has not created yet, so the count reads low until it
renders. Reachable includes material
textures, a BatchedMesh's matrix, indirect and colour textures, a skeleton's bone texture, the scene background and
environment, and textures a node material lists in `material.userData.forgeTextures` (AnimatedInstances lists its
animation texture; do the same for your own TSL materials). three uploads a texture only when it renders, so a
scene whose reachable textures never rendered reads low, never high: the count is exact once everything reachable
has been on screen. It is recounted with the graph statistics (at most every 60 frames);
`ledger.measureMemory()` recounts now.

### Limits of the count

three's `DFGLUT.js` keeps its lookup texture in a module variable it does not export. It *is* reachable through
private internals (`DFGLUT.shaderNode.jsFunc`), but the ledger matches `info.createTexture` / `destroyTexture`
against three's own name for it instead, because relying on those internals is fragile across revisions. Each limit
below is bounded:

- Resources three created before `ledger.attach()` are not seen: PMREM planes and textures and a target drawn once
  (CubeMapNode's cube) read as unreferenced. Attach the ledger before the first render.
- A render target drawn once and then abandoned without `dispose()` is allowed like a live one, so that leak is missed;
  an app's own undisposed `PMREMGenerator` is indistinguishable from PMREMNode's and is allowed too.
- Transmission's and refraction's viewport textures (`ViewportTextureNode`, `ViewportSharedTextureNode`,
  `ViewportDepthTextureNode`) and XR targets are not allowed, so they still count as unreferenced and can raise a
  false `unreferenced-resources`.
- Frame-buffer targets are read from three's private `renderer._frameBufferTargets` (pinned by a canary unit test); a
  renderer without it gets a fixed allowance of a colour and a depth texture.

- An app `DataTexture` named exactly `DFG_LUT`, uploaded while the ledger is attached, is counted as three's and
  hides at most one texture.
- After `renderer.dispose()`, which zeroes `info.memory` without calling `destroyTexture`, the LUT count stays stale
  until `detach()`, hiding at most one texture.
- Right after a `renderer.shadowMap.type` change, the VSM allowance can be off by 2 until the next render.
- Detach two ledgers attached to one renderer in **reverse attach order**. The second `attach()` wraps the wrappers
  the first installed, for `info` and `render` alike, so detaching first-in-first-out restores a stale wrapper.
- Tiled shadows (three's `TileShadowNode` addon) keep their tile lights outside the scene, so the reachable-resource
  walk never sees those lights' array maps: such a scene over-reports `memory.unreferenced.textures`.
- Array shadow maps under-report `memory.renderTargets.bytes` by their layer count, for the map and its VSM blur
  targets alike (both are sized from width and height alone). No scene in the repo uses one.

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
so with a fog that reaches the far plane nothing visible ever pops: `test/e2e/streaming.spec.ts` holds the streamed
start frame to under 0.5 % of pixels changed against the unstreamed one, at a per-channel tolerance of 24), and unloads past `radius + margin × chunkSize` (hysteresis, default one cell; the first update
places strictly). Unloading removes the chunk's objects from the scene and disposes the geometries and textures
no resident chunk shares (a BatchedMesh's matrix textures too, without `BatchedMesh.dispose()`, which would
destroy them); materials stay, the registry owns them. An interleaved geometry, which is what GLTFLoader builds for
a bufferView with a byteStride, is freed too and comes back with new attribute objects over the same array, because
three r186 cannot upload the old ones a second time (`disposeGeometry`); only one whose buffer a resident chunk
still reads waits for that chunk to leave. Loading adds the objects back and three re-uploads on the next render: expect one frame of upload work per chunk that comes back. The CPU copies stay in the JS heap; nothing
is re-fetched. `stats()` gives `{ chunks, resident, loads, unloads }`, `onChange` the events, `dispose()` makes
everything resident again and then releases the chunks and the object index, so a disposed Streamer holds none of the
World's objects, `stats()` reports `chunks: 0, resident: 0` and a later `update()` does nothing.
`ledger.attachStreamer(streamer)` fills `memory.chunks`.

## Reading the section

| number | means | act with |
|---|---|---|
| `textures.bytes` above budget (`texture-bytes`) | too many texels resident for their GPU format | smaller textures (`threeforge optimize --texture-size`), KTX2 that transcodes to a block format through `createLoader`, stream chunks; not WebP or AVIF, which only shrink the download |
| `geometries.bytes` above budget (`geometry-bytes`) | too much geometry resident | `threeforge optimize --compress meshopt`, LODs, stream chunks |
| `unreferenced` ≥ 8 (`unreferenced-resources`) | removed without `dispose()` | `ResourceTracker.release`, a `Streamer` |
| `chunks.resident` close to `chunks.total` | the radius covers the world | a smaller `far` with fog, smaller chunks |

The zen benchmark (`pnpm bench`, scene `zen`): 50 000 objects on 64 ground tiles with a 512² texture each
(85 MB of textures with mipmaps), fog to 600 m. The optimized variant compiles in 250 m chunks and streams them:
32 of 64 chunks resident at the start camera, textures 85 MB → 43 MB. The streaming e2e (5,000 objects) holds the
start frame to under 0.5 % of pixels changed against naive at a per-channel tolerance of 24.
