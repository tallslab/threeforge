# What we learned about three r186 (and how threeforge works around it)

These are the three r186 behaviours threeforge depends on or works around, recorded while building it against
`three/webgpu` and its WebGL2 fallback. Each item names the threeforge mechanism that answers it; section numbers
refer to [docs/threeforge.md](threeforge.md), which stays the reference for those mechanisms. The list was section 13
of that file until 0.9.0 and is kept here unchanged so that a three upgrade can be checked against it item by item.

- `renderer.compileAsync()` queues `renderObject()` work and builds it after `material.side` is restored and the render
  context is null: transparent double-sided and transmissive materials compile as single-pass DoubleSide and
  transmission binds a viewport texture no frame writes. `needsUpdate` cannot fix the cached render objects;
  `material.dispose()` can. threeforge's warm-up renders a scissored real frame instead (`docs/upstream-compileAsync.md`).
- Shadow maps and the transmission backdrop re-render once per node frame id, which advances only on animation-frame
  ticks: measurements must come from a frame after a real tick (`frameAsync()` everywhere).
- On WebGPU a batch whose index rows change after a pass recorded its draw (a reflection or shadow map rendered from
  inside that pass re-culls it) draws that pass with the new rows, and on WebGL the receiver that triggered a shadow
  map draws the shadow camera's list: batches and compacted instanced meshes keep the enclosing rows as a stable
  prefix (section 7). An instance matrix buffer above the uniform-buffer limit is one `InstancedInterleavedBuffer`
  per mesh, synced once per frame per render object (`nodes/accessors/Instance.js`), and `Geometries.updateAttribute`
  checks it at most once per `info.render.calls`, which a nested render advances and nothing restores: a mesh a
  nested pass reaches first is compacted for the main camera before that pass draws it.
- `renderer.compileAsync()` calls the scene's `onBeforeRender` but never its `onAfterRender`: `warmup({ mode: 'async' })`
  resets the pass tracker afterwards so the warm-up frame counts as an outermost render.
- Transmissive materials cannot be batched (thickness scales with the object matrix); reflectors fill their target
  one frame late; `KTX2Loader` needs `detectSupport(renderer)` after `await renderer.init()` (`detectSupportAsync` is
  deprecated since r181); `RenderObject.getDrawParameters()` returns null for
  a zero-instance InstancedMesh (no draw, no count); `ShaderMaterial` does not render on `WebGPURenderer`.
- `KTX2Loader`'s last resort cannot be drawn. When the device reports no block format it transcodes to RGBA32 and
  still returns a `CompressedTexture` with `format: RGBAFormat`; WebGL2 refuses its upload (`compressedTexSubImage2D:
  invalid format`) and the WebGPU path has no block size for it (`WebGPUTextureUtils._getBlockData`, a TypeError on
  `width`). So `isCompressedTexture` does not mean compressed on the GPU, and the fallback is not a rendering path:
  `createLoader` rejects a model with KTX2 textures on a device with no block format (measured on the UASTC fixture
  before that: `RGBAFormat`, seven levels, 21 844 B a 64 px map, what a PNG costs). WebGPU adapters have BC, or ETC2
  and ASTC, so it takes a WebGL2 device with no compressed-texture extension to get there. Look again when three is
  upgraded: if the fallback uploads, the refusal can go.
- A missing Basis transcoder file never reaches the app through three, whichever of `basis_transcoder.js` and
  `basis_transcoder.wasm` it is: on a 404 `GLTFLoader.loadTextureImage` catches and returns null, so `loadAsync`
  resolves with the maps missing, and where unknown paths get an HTML page (Vite's default) the transcoder worker never
  starts and the load never settles (`WorkerPool` has no error listener). `createLoader` asks for both files by HEAD
  at the first KTX2 texture and fails the models that have KTX2 textures, and only those.
- A missing Draco decoder file (`draco_wasm_wrapper.js` or `draco_decoder.wasm`) rejects the model on a 404, with
  the URL and nothing about what to do, and never settles where the answer is an HTML page: `DRACOLoader`'s
  worker has an `onmessage` and no `onerror`, so a script or a binary that is really a page fails in it unheard.
  `createLoader` asks for both files by HEAD at the first Draco
  data to decode and fails that model with the file and the `threeforge decoders` command. meshopt has no such file:
  its decoder is a module with the WebAssembly inside, bundled with the app.
- Half-float render targets read back as raw 16-bit halves on both backends, and WebGPU returns rows padded to 256
  bytes: the overdraw target uses 32-texel row multiples and decodes halves.
- three's experimental `SceneOptimizer` batches everything including skinned meshes and disposes shared geometry; it
  was measured as the spike baseline (`docs/spike-scene-optimizer.md`) and not used.
- After `onBeforeRender`, `_renderObjectDirect` refreshes geometry attributes, nodes and bindings only when
  `needsRefresh()` says the render object is new this frame; a second render object of the same object (a
  reflection pass) gets a shared refresh without attribute uploads. Attributes written in a hook for a nested
  pass are therefore what the main pass draws: sprite batches fill their instance attributes once per frame, for
  the main camera, and nested passes reuse that list (the lake's raindrops stayed within the sprite e2e's bound,
  under 0.5 % of pixels changed at a per-channel tolerance of 24, only after this).

